(() => {
    'use strict';

    // Reuse shared extension constants when common.js is available; retain safe fallbacks.
    const MF = typeof window !== 'undefined' ? window.MujFish : null;
    const C = MF && MF.CONSTANTS ? MF.CONSTANTS : {};
    const ATT = C.ATTENDANCE || {};
    const KEYS = C.STORAGE_KEYS || {};
    const KEY = KEYS.DASHBOARD_ENABLED || 'mujfish_dashboard_enabled';
    const TARGET_KEY = KEYS.CUSTOM_TARGET || 'st_customTarget'; // configured on Attendance page
    const DEFAULT_TARGET = Number.isFinite(ATT.DEFAULT_TARGET) ? ATT.DEFAULT_TARGET : 75;
    const MIN_TARGET = Number.isFinite(ATT.MIN_TARGET) ? ATT.MIN_TARGET : 1;
    const MAX_TARGET = Number.isFinite(ATT.MAX_TARGET) ? ATT.MAX_TARGET : 99;
    const ROUND_UP_MARGIN = Number.isFinite(ATT.ROUND_UP_MARGIN) ? ATT.ROUND_UP_MARGIN : 1;
    const MAX_CONCURRENT_DETAILS = 2;
    const MAX_DETAIL_FAILURES = 3;   // stop looking up attendance after this many failures
    const DAY_DEBOUNCE_MS = 250;
    const REQUEST_TIMEOUT_MS = 15000;
    const MAX_REMOUNTS = 3;

    // Not the dashboard (or already injected): do nothing at all
    if (!document.getElementById('kt_ViewEvent')) return;
    if (document.getElementById('mf-bar')) return;

    const api = (typeof chrome !== 'undefined' && chrome.storage) ? chrome
        : (typeof browser !== 'undefined' && browser.storage) ? browser : null;
    const storage = api ? api.storage.local : null;
    if (!storage) return;

    let target = DEFAULT_TARGET;
    let visibilityHandler = null;
    let targetChangeListener = null;
    let remountObs = null;
    let summaryAbortCtl = null;

    // ---------- Styles ----------
    const CSS = `
    :root{
      --mf-ink:#172033;--mf-muted:#667085;--mf-line:#e5eaf1;--mf-soft:#f6f8fb;
      --mf-card:#fff;--mf-accent:#356ae6;--mf-accent-soft:#edf3ff;
      --mf-green:#16835d;--mf-green-bg:#eaf8f1;--mf-amber:#9a6700;--mf-amber-bg:#fff6df;
      --mf-red:#b42336;--mf-red-bg:#fff0f1;--mf-radius:10px;
      --mf-shadow:0 2px 8px rgba(16,24,40,.035),0 1px 2px rgba(16,24,40,.025);
    }
    .mf-hidden{display:none!important}
    #mf-bar{display:flex;justify-content:flex-end;align-items:center;margin:0 0 14px;padding:3px 0}
    .mf-switch{display:inline-flex;align-items:center;gap:9px;margin:0;cursor:pointer;font-size:12px;font-weight:650;color:var(--mf-muted);user-select:none}
    .mf-switch input{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden}
    .mf-track{position:relative;width:34px;height:19px;border-radius:999px;background:#cbd3df;transition:background .18s ease;flex:none}
    .mf-track::after{content:'';position:absolute;top:3px;left:3px;width:13px;height:13px;border-radius:50%;background:#fff;box-shadow:0 1px 2px #0002;transition:transform .18s ease}
    .mf-switch input:checked + .mf-track{background:var(--mf-accent)}
    .mf-switch input:checked + .mf-track::after{transform:translateX(15px)}
    .mf-switch input:focus-visible + .mf-track{outline:3px solid #356ae64d;outline-offset:3px}
    .mf-switch input:disabled + .mf-track{opacity:.5}

    #mujfish-timetable{display:flex;flex-direction:column;gap:16px;color:var(--mf-ink);font-family:inherit}
    .mf-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:0 0 13px;border-bottom:1px solid var(--mf-line)}
    .mf-head-title{display:inline-flex;align-items:center;gap:8px;font-size:16px;font-weight:750;letter-spacing:-.025em;color:var(--mf-ink);text-decoration:none;cursor:pointer;transition:color .16s ease}
    .mf-head-title:hover{color:var(--mf-accent);text-decoration:none}
    .mf-head-title i{font-size:12px;color:#98a2b3;transition:transform .16s ease,color .16s ease}
    .mf-head-title:hover i{transform:translate(2px,-2px);color:var(--mf-accent)}
    .mf-nav{display:inline-flex;align-items:center;gap:4px;background:var(--mf-soft);border:1px solid var(--mf-line);padding:4px;border-radius:11px}
    .mf-nav button{min-width:30px;min-height:29px;background:transparent;border:0;cursor:pointer;color:#475467;font-size:13px;line-height:1;padding:5px 9px;border-radius:7px;font-weight:650;transition:background .16s ease,color .16s ease,box-shadow .16s ease}
    .mf-nav button:hover{background:#fff;color:var(--mf-ink);box-shadow:0 1px 3px #10182812}
    .mf-nav button:focus-visible,.mf-retry-btn:focus-visible{outline:3px solid #356ae64d;outline-offset:2px}
    .mf-date{min-width:88px;text-align:center;font-size:12px;font-weight:700;color:var(--mf-ink);padding:0 5px;font-variant-numeric:tabular-nums}
    .mf-today{font-size:11px!important;color:var(--mf-accent)!important;background:#fff!important;box-shadow:0 1px 3px #10182812!important}
    .mf-list{display:flex;flex-direction:column;gap:10px}
    .mf-card{position:relative;background:var(--mf-card);border:1px solid var(--mf-line);border-left:3px solid var(--c,#b8c2d2);border-radius:var(--mf-radius);padding:14px 15px;box-shadow:none;transition:border-color .16s ease,background .16s ease}
    .mf-card:hover{background:#fcfdff;border-color:#d2dbe8}
    .mf-live{border-color:#b8cef9;box-shadow:0 0 0 3px #356ae610,0 4px 14px #10182808}
    .mf-card-head{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px}
    .mf-time{display:flex;align-items:center;flex-wrap:wrap;font-size:11.5px;font-weight:650;color:var(--mf-muted);font-variant-numeric:tabular-nums;letter-spacing:.005em}
    .mf-now{margin-left:8px;padding:3px 7px;border-radius:5px;background:var(--mf-accent-soft);color:var(--mf-accent);font-size:9px;font-weight:800;letter-spacing:.07em}
    .mf-title{font-weight:720;font-size:13.5px;color:var(--mf-ink);line-height:1.45;letter-spacing:-.01em;margin-bottom:8px;overflow-wrap:anywhere}
    .mf-meta-row{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
    .mf-chip{display:inline-flex;align-items:center;max-width:100%;background:var(--mf-soft);border:1px solid #e8edf4;border-radius:7px;padding:4px 8px;font-size:10.5px;font-weight:600;color:#596579;line-height:1.35}
    .mf-chip[hidden]{display:none!important}
    .mf-attendance-hint{font-variant-numeric:tabular-nums;font-weight:600;border-radius:7px;padding:4px 8px;font-size:10.5px;background:var(--mf-soft);border:1px solid #e8edf4;color:#596579}
    .mf-hint-val{font-weight:700}
    .mf-hint-ok{color:#596579}
    .mf-hint-warn{color:#b45309}
    .mf-hint-bad{color:#dc2626}
    .mf-status-badge{display:inline-flex;align-items:center;white-space:nowrap;padding:4px 8px;border-radius:7px;font-size:10px;font-weight:700;line-height:1.2;letter-spacing:.005em;background:#f2f4f7;color:#596579;border:1px solid #e4e7ec}
    .mf-status-present{background:var(--mf-green-bg);color:var(--mf-green);border-color:#c8ead8}
    .mf-status-absent{background:var(--mf-red-bg);color:var(--mf-red);border-color:#f4cbd0}
    .mf-status-warn{background:var(--mf-amber-bg);color:var(--mf-amber);border-color:#f1dfad}
    .mf-status-not-considered{background:#eaf3ff;color:#245db5;border-color:#c8dcff}

    #mujfish-summary-container{min-width:0;max-width:100%;margin:0 0 24px;padding:0;background:transparent;border:0;box-shadow:none;color:var(--mf-ink)}
    #mujfish-summary-container>.mf-head-title{margin-bottom:12px;font-size:15px;font-weight:750}
    #mujfish-summary-container>hr{display:none}
    #mujfish-summary-body{max-width:100%;overflow-x:auto;border:1px solid #cbd5e1;border-radius:6px;background:#fff;overscroll-behavior-x:contain}
    .mf-table{width:100%;min-width:560px;margin:0!important;border:0!important;border-collapse:separate!important;border-spacing:0!important;font-size:12px;color:#344054}
    .mf-table thead tr{background:#f1f5f9}
    .mf-table thead th{padding:10px 12px!important;border:0!important;border-bottom:2px solid #cbd5e1!important;border-right:1px solid #e2e8f0!important;color:#475569;font-size:10.5px;font-weight:750;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}
    .mf-table thead th:last-child{border-right:0!important}
    .mf-table tbody td{padding:10px 12px!important;border:0!important;border-bottom:1px solid #e2e8f0!important;border-right:1px solid #edf2f7!important;vertical-align:middle!important}
    .mf-table tbody td:last-child{border-right:0!important}
    .mf-table tbody tr:last-child td{border-bottom:0!important}
    .mf-table tbody tr:nth-child(odd) td{background:#fff!important}
    .mf-table tbody tr:nth-child(even) td{background:#f4f7fb!important}
    .mf-table tbody tr:hover td{background:#eef3fa!important}
    .mf-table tbody td:first-child{width:54px;font-weight:600;color:#64748b}
    .mf-table tbody td:nth-child(2){font-weight:600;color:#1e293b;min-width:170px;overflow-wrap:anywhere}
    .mf-c{text-align:center;white-space:nowrap;font-variant-numeric:tabular-nums}
    .mf-pill{display:inline-flex;align-items:center;justify-content:center;min-width:48px;padding:3.5px 9px;border-radius:999px;font-weight:750;font-size:11px;text-align:center;font-variant-numeric:tabular-nums}
    .mf-ok{background:var(--mf-green-bg);color:var(--mf-green);border:1px solid #b7e4cb}
    .mf-warn{background:var(--mf-amber-bg);color:var(--mf-amber);border:1px solid #eed69b}
    .mf-bad{background:var(--mf-red-bg);color:var(--mf-red);border:1px solid #f1bcc2}
    .mf-low-att-banner{display:flex;align-items:center;gap:6px;padding:12px 14px;margin:0 0 12px;border-radius:10px;background:#fff7e8;border:1px solid #f3dfb5;color:#875b08;font-size:12px;font-weight:550;line-height:1.5}
    .mf-low-att-banner strong{font-weight:750}
    .mf-low-att-banner a{color:#704b00;font-weight:700;text-decoration:underline;text-underline-offset:2px}

    .mf-notice{padding:22px 16px;border-radius:12px;background:var(--mf-soft);border:1px dashed #d9e0ea;color:var(--mf-muted);font-size:12px;font-weight:550;text-align:center;line-height:1.5}
    .mf-error{display:flex;align-items:center;justify-content:space-between;gap:12px;background:#fff;border:1px solid #f1cbd0;border-radius:12px;padding:14px 15px;box-shadow:var(--mf-shadow)}
    .mf-error-msg{font-weight:600;font-size:12px;color:#7a2633;line-height:1.5}
    .mf-retry-btn{background:#fff;border:1px solid #d0d7e2;color:#344054;font-size:11px;font-weight:700;padding:7px 12px;border-radius:8px;cursor:pointer;transition:background .16s ease,border-color .16s ease,box-shadow .16s ease}
    .mf-retry-btn:hover{background:#f8fafc;border-color:#aeb9c9;box-shadow:0 2px 4px #1018280a}
    @media(max-width:600px){
      .mf-head{align-items:flex-start;flex-direction:column}
      .mf-nav{align-self:stretch;justify-content:space-between}
      .mf-date{flex:1}
      #mujfish-summary-container{padding:13px;border-radius:12px}
      .mf-card{padding:13px;border-radius:11px}
      .mf-table thead th,.mf-table tbody td{padding:9px 10px!important}
      .mf-low-att-banner{align-items:flex-start;flex-wrap:wrap}
    }

    /* Keep the timetable compact, nicely stacked, and prevent portal grid overflow. */
    #mujfish-timetable, #mujfish-timetable *{box-sizing:border-box}
    #mujfish-timetable{width:100%;min-width:0;max-width:100%;gap:12px}
    #mujfish-timetable .mf-head{display:flex;flex-direction:column;align-items:stretch;gap:9px;padding-bottom:11px;min-width:0}
    #mujfish-timetable .mf-title-row{display:flex;align-items:center;justify-content:space-between;width:100%;min-width:0}
    #mujfish-timetable .mf-head-title{font-size:15px;white-space:nowrap}
    #mujfish-timetable .mf-today-btn{font-size:11px;font-weight:700;color:var(--mf-accent);background:#fff;border:1px solid #d0d7e2;border-radius:6px;padding:3px 9px;cursor:pointer;line-height:1.2;box-shadow:0 1px 2px rgba(16,24,40,0.05);transition:background .16s ease,border-color .16s ease,color .16s ease}
    #mujfish-timetable .mf-today-btn:hover{background:var(--mf-soft);border-color:#b8cef9}
    #mujfish-timetable .mf-today-btn[hidden]{display:none!important}
    #mujfish-timetable .mf-nav{display:flex;align-items:center;justify-content:space-between;width:100%;max-width:100%;min-width:0;box-sizing:border-box;gap:2px;padding:3px 4px}
    #mujfish-timetable .mf-nav button{flex-shrink:0}
    #mujfish-timetable .mf-date{flex:1;min-width:0;text-align:center;font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 4px;user-select:none}
    #mujfish-classes-container{width:100%;min-width:0}
    #mujfish-classes-container.mf-scrollable{overflow-y:auto;overscroll-behavior-y:contain;padding-right:4px;scrollbar-width:thin;scrollbar-color:#cbd5e1 transparent;box-shadow:inset 0 -10px 10px -8px rgba(16,24,40,.09)}
    #mujfish-classes-container.mf-scrollable::-webkit-scrollbar{width:5px}
    #mujfish-classes-container.mf-scrollable::-webkit-scrollbar-track{background:transparent}
    #mujfish-classes-container.mf-scrollable::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:10px}
    #mujfish-classes-container.mf-scrollable::-webkit-scrollbar-thumb:hover{background:#94a3b8}
    .mf-scroll-hint{display:none;align-items:center;justify-content:center;gap:4px;margin:8px auto 0;padding:3px 12px;font-size:11px;font-weight:650;color:#64748b;background:var(--mf-soft);border:1px dashed #d0d7e2;border-radius:20px;cursor:pointer;user-select:none;transition:all .18s ease;letter-spacing:-.01em;width:fit-content}
    .mf-scroll-hint:hover{color:var(--mf-accent);border-color:#b8cef9;background:#f5f8ff}
    #mujfish-classes-container .mf-list{gap:8px;width:100%;min-width:0}
    #mujfish-classes-container .mf-card{min-width:0;padding:11px 12px;border-radius:10px;border-left-width:3px}
    #mujfish-classes-container .mf-card-head{align-items:flex-start;gap:8px;margin-bottom:6px}
    #mujfish-classes-container .mf-time{font-size:11px;line-height:1.45}
    #mujfish-classes-container .mf-status-badge{max-width:58%;white-space:normal;text-align:center;font-size:10px;padding:3px 6px}
    #mujfish-classes-container .mf-title{font-size:12.5px;line-height:1.35;margin-bottom:6px;overflow-wrap:anywhere;word-break:normal}
    #mujfish-classes-container .mf-meta-row{gap:4px;margin-top:5px;align-items:center}
    #mujfish-classes-container .mf-chip{font-size:9.5px;padding:3px 6px;line-height:1.25}
    #mujfish-classes-container .mf-attendance-hint{font-weight:650}
    #mujfish-summary-container{margin-bottom:18px}
    @media(max-width:600px){
      #mujfish-classes-container .mf-card{padding:11px}
      #mujfish-classes-container .mf-status-badge{max-width:52%}
    }
    @media(prefers-reduced-motion:reduce){.mf-card,.mf-head-title,.mf-nav button,.mf-retry-btn,.mf-track,.mf-track::after{transition:none!important}.mf-card:hover{transform:none!important}}
    `;

    function injectStyles() {
        if (document.getElementById('mf-styles')) return;
        const s = document.createElement('style');
        s.id = 'mf-styles';
        s.textContent = CSS;
        (document.head || document.documentElement).appendChild(s);
    }

    // ---------- Small helpers ----------
    const hasRIC = typeof requestIdleCallback === 'function';
    const idle = (fn) => hasRIC ? requestIdleCallback(fn, { timeout: 3000 }) : setTimeout(fn, 300);

    function whenVisible(fn) {
        if (!document.hidden) return fn();
        visibilityHandler = () => {
            if (document.hidden) return;
            document.removeEventListener('visibilitychange', visibilityHandler);
            visibilityHandler = null;
            fn();
        };
        document.addEventListener('visibilitychange', visibilityHandler);
    }

    // el(tag, className, text)
    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    const icon = (cls) => el('i', 'la ' + cls);
    const notice = (msg) => {
        const node = el('div', 'mf-notice', msg);
        node.setAttribute('role', 'status');
        node.setAttribute('aria-live', 'polite');
        return node;
    };

    const pad = (n) => String(n).padStart(2, '0');
    // Same shape as the portal's own calendar (moment 'L' => MM/DD/YYYY)
    const apiDate = (d) => `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
    const displayDate = (d) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const sameDay = (a, b) => a.toDateString() === b.toDateString();
    const fmtTime = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

    // Handles ISO strings AND ASP.NET "/Date(1700000000000)/" values
    function parseDate(v) {
        if (v == null || v === '') return NaN;
        const m = /\/Date\((-?\d+)/.exec(String(v));
        return m ? Number(m[1]) : Date.parse(v);
    }
    function startTs(item) {
        const v = parseDate(item && item.StartDate);
        return isNaN(v) ? Infinity : v;
    }
    function byStart(a, b) {
        const x = startTs(a), y = startTs(b);
        return x === y ? 0 : (x < y ? -1 : 1);
    }
    function timeRange(item) {
        const s = parseDate(item.StartDate), e = parseDate(item.EndDate);
        if (isNaN(s)) return '';
        return isNaN(e) ? fmtTime(s) : `${fmtTime(s)} – ${fmtTime(e)}`;
    }

    // POST form data, parse JSON safely, time out, honour an external abort signal
    function postForm(url, params, signal) {
        const ctl = new AbortController();
        const onAbort = () => ctl.abort();
        if (signal) {
            if (signal.aborted) ctl.abort();
            else signal.addEventListener('abort', onAbort, { once: true });
        }
        const t = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);

        return fetch(url, {
            method: 'POST',
            body: new URLSearchParams(params),
            credentials: 'same-origin',
            signal: ctl.signal
        })
            .then((res) => {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.text();
            })
            .then((txt) => JSON.parse(txt)) // login/error HTML pages throw here
            .finally(() => {
                clearTimeout(t);
                if (signal) signal.removeEventListener('abort', onAbort);
            });
    }

    // Small concurrency cap. Only give up after several failures.
    async function runLimited(jobs, limit, signal) {
        let i = 0, fails = 0;
        const worker = async () => {
            while (fails < MAX_DETAIL_FAILURES && !signal.aborted && i < jobs.length) {
                const job = jobs[i++];
                try { await job(); } catch (e) { fails++; }
            }
        };
        await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
    }

    // ---------- Attendance math (same as attendance.js) ----------
    function classesNeeded(p, n, T) {
        if (MF && MF.MATH && typeof MF.MATH.classesNeeded === 'function') {
            return MF.MATH.classesNeeded(p, n, T, ROUND_UP_MARGIN);
        }
        if (!Number.isFinite(p) || !Number.isFinite(n) || n <= 0) return 0;
        const t = T - ROUND_UP_MARGIN;
        const num = t * n - 100 * p;
        if (num < 0) return 0;
        return Math.floor(num / (100 - t)) + 1;
    }

    function clampTarget(v) {
        const n = parseInt(v, 10);
        if (isNaN(n)) return DEFAULT_TARGET;
        return Math.min(MAX_TARGET, Math.max(MIN_TARGET, n));
    }

    // If a fixed-height portal container is cutting the page short, let it grow.
    // Only touches ancestors whose content is actually overflowing.
    function freeHeight(node) {
        try {
            for (let p = node.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
                if (getComputedStyle(p).overflowY === 'visible' && p.scrollHeight > p.clientHeight + 2) {
                    p.style.setProperty('height', 'auto', 'important');
                    p.style.setProperty('max-height', 'none', 'important');
                }
            }
        } catch (e) { }
    }

    // ---------- Page anchors ----------
    function getColumns() {
        const ev = document.getElementById('kt_ViewEvent');
        const col9 = ev && (ev.closest('.col-md-9') || ev.closest('.col-lg-9'));
        return { ev, col9, leftCol: col9 ? col9.previousElementSibling : null };
    }

    // ---------- Toggle ----------
    function addToggle(enabled) {
        if (document.getElementById('mf-bar')) return;
        const { ev, col9 } = getColumns();
        const row = col9 && col9.parentElement;
        const anchor = row || (ev && ev.parentElement);
        if (!anchor || !anchor.parentElement) return;

        const bar = el('div');
        bar.id = 'mf-bar';

        const label = el('label', 'mf-switch');
        label.title = 'Switch between MUJ FISH and the original portal view';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = 'mujfish-toggle';
        input.setAttribute('aria-label', 'Enable enhanced dashboard view');
        input.checked = enabled;
        input.addEventListener('change', () => {
            input.disabled = true;
            try {
                storage.set({ [KEY]: input.checked }, () => {
                    if (api.runtime && api.runtime.lastError) {
                        input.checked = !input.checked;
                        input.disabled = false;
                        return;
                    }
                    location.reload();
                });
            } catch (e) {
                input.checked = !input.checked; // extension context invalidated
                input.disabled = false;
            }
        });
        label.appendChild(input);
        label.appendChild(el('span', 'mf-track'));
        label.appendChild(document.createTextNode('Enhanced view'));
        bar.appendChild(label);

        anchor.parentElement.insertBefore(bar, anchor);
    }

    // ---------- Class status & parsing ----------
    function classify(raw) {
        let c = String(raw || '').replace('!important', '').trim().toLowerCase();
        if (!/^#[0-9a-f]{3,8}$/.test(c)) c = '#64748b'; // never trust server colours blindly
        switch (c) {
            case '#3d9400':
                return { color: '#10b981', badgeClass: 'mf-status-present', label: 'Present', detail: true };
            case '#820c0c':
                return { color: '#f59e0b', badgeClass: 'mf-status-warn', label: 'Rescheduled', detail: false };
            case '#800000':
                return { color: '#f43f5e', badgeClass: 'mf-status-absent', label: 'Cancelled', detail: false };
            case '#6c6c6c':
            case '#808080':
                return { color: '#94a3b8', badgeClass: '', label: 'Pending / Not Marked', detail: false };
            default:
                return { color: '#6366f1', badgeClass: '', label: 'Scheduled Event', detail: true };
        }
    }

    function setStatus(statusEl, s) {
        statusEl.className = 'mf-status-badge' + (s.badgeClass ? ' ' + s.badgeClass : '');
        statusEl.textContent = s.label;
    }

    function applyAttendance(card, statusEl, type) {
        const t = String(type || '').toLowerCase();
        statusEl.textContent = '';
        if (t.includes('absent')) {
            statusEl.className = 'mf-status-badge mf-status-absent';
            statusEl.textContent = 'Absent';
            card.style.setProperty('--c', '#f43f5e');
        } else if (t.includes('not considered')) {
            statusEl.className = 'mf-status-badge mf-status-not-considered';
            statusEl.textContent = type;
            card.style.setProperty('--c', '#0ea5e9');
        } else if (t.includes('present')) {
            statusEl.className = 'mf-status-badge mf-status-present';
            statusEl.textContent = 'Present';
            card.style.setProperty('--c', '#10b981');
        } else {
            statusEl.className = 'mf-status-badge';
            statusEl.textContent = type;
        }
    }

    function parseEventDescription(raw) {
        const text = String(raw || '').trim();
        let room = '';
        let sec = '';
        let sem = '';

        const roomMatch = text.match(/Room\s*(?:No\.?|Number)?\s*:\s*([^,]+)/i);
        if (roomMatch) room = roomMatch[1].trim();

        const secMatch = text.match(/Section\s*:\s*([^,]+)/i);
        if (secMatch) sec = secMatch[1].trim();

        const semMatch = text.match(/Semester\s*:\s*([^,]+)/i);
        if (semMatch) sem = semMatch[1].trim();

        const splitIdx = text.search(/,\s*(?:Room\s*(?:No\.?|Number)?|Section|Semester)\s*:/i);
        const title = splitIdx !== -1 ? text.slice(0, splitIdx).trim() : text;

        return { title: title || raw || 'Class', room, sec, sem };
    }

    // ---------- Course lookup (links timetable classes to the summary numbers) ----------
    let courses = [];     // { code, key, p, n } from the attendance summary
    let skipChips = [];   // eligible class forecast chips for the currently displayed day

    // Summary names look like "CSE3141 : PREDICTIVE ANALYTICS".
    // Timetable titles look like "BTECH-005 PREDICTIVE ANALYTICS" (a program code, not the course code),
    // so we compare the course NAME and ignore the leading code.
    const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const summaryName = (s) => {
        s = String(s || '');
        const i = s.indexOf(':');
        return norm(i === -1 ? s : s.slice(i + 1));
    };
    const className = (s) => norm(String(s || '').replace(/^\s*[A-Za-z]+[-\s]?\d+\s+/, ''));
    const courseCode = (s) => {
        const m = /[A-Z]{2,5}\d{3,5}[A-Z]?/.exec(norm(String(s || '').split(':')[0]));
        return m ? m[0] : '';
    };

    function indexCourses(data) {
        courses = [];
        if (!data || !Array.isArray(data.AttendanceSummaryList)) return;
        data.AttendanceSummaryList.forEach((it) => {
            const p = parseInt(it.Present, 10);
            const n = parseInt(it.Total, 10);
            if (isNaN(p) || isNaN(n) || n <= 0) return;
            const id = String(it.CourseID ?? '');
            courses.push({ code: courseCode(id), name: summaryName(id), p, n });
        });
    }

    function findCourse(title) {
        // 1) the class text contains a real course code
        const all = norm(title);
        const byCode = courses.find((x) => x.code && all.includes(x.code));
        if (byCode) return byCode;
        // 2) same course name (exact first, so "X" and "X LAB" never get mixed up)
        const k = className(title);
        if (k.length < 4) return null;
        const exact = courses.find((x) => x.name === k);
        if (exact) return exact;
        // 3) partial name match, only if it points to exactly one course
        const part = courses.filter((x) => x.name && (x.name.includes(k) || k.includes(x.name)));
        return part.length === 1 ? part[0] : null;
    }

    // Show simple missed-class projections for today and tomorrow.
    // Within the displayed day, repeated sessions of the same subject stack cumulatively.
    function fillChips() {
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
        const viewing = new Date(viewDate); viewing.setHours(0, 0, 0, 0);
        const allowedDate = viewing.getTime() === today.getTime() || viewing.getTime() === tomorrow.getTime();
        const missedByCourse = new Map();

        skipChips.forEach((s) => {
            if (!s.chip.isConnected) return;
            s.chip.hidden = true;
            if (!allowedDate || s.done) return;
            const c = findCourse(s.title);
            if (!c || c.n < 0) return;

            // Course code is the most reliable key; fall back to normalized course name.
            const key = c.code || c.name || norm(s.title);
            const missed = (missedByCourse.get(key) || 0) + 1;
            missedByCourse.set(key, missed);
            const projected = c.p / (c.n + missed) * 100;
            const needed = classesNeeded(c.p, c.n + missed, target);
            const hintCls = needed > 0 ? 'mf-hint-bad' : projected < target + 5 ? 'mf-hint-warn' : 'mf-hint-ok';

            s.chip.className = 'mf-chip mf-attendance-hint';
            s.chip.innerHTML = `Skip: <span class="mf-hint-val ${hintCls}">${projected.toFixed(1)}%</span>`;
            s.chip.title = `Projected attendance if you skip this and ${missed - 1} earlier eligible ${missed === 2 ? 'class' : 'classes'} of this subject: ${projected.toFixed(1)}%. Target: ${target}%. Forecast only; SLCM records are unchanged.`;
            s.chip.setAttribute('aria-label', `Projected attendance if skipped: ${projected.toFixed(1)} percent.`);
            s.chip.hidden = false;
        });
        adjustClassesScroll();
    }

    // ---------- Timetable ----------
    let viewDate = new Date();
    let abortCtl = null;
    let navTimer = null;
    let dateLabel = null;
    let todayBtn = null;
    const attCache = new Map(); // in-memory only: F5 always refetches

    function updateDateUI() {
        const today = sameDay(viewDate, new Date());
        if (dateLabel) {
            dateLabel.textContent = today ? 'Today' : displayDate(viewDate);
            dateLabel.title = today ? '' : 'Click to jump to today';
            dateLabel.style.cursor = today ? 'default' : 'pointer';
        }
        if (todayBtn) todayBtn.hidden = today;
    }

    function showError(container, msg, retry) {
        container.textContent = '';
        const box = el('div', 'mf-error');
        box.setAttribute('role', 'alert');
        box.setAttribute('aria-live', 'assertive');
        box.appendChild(el('span', 'mf-error-msg', msg));
        if (typeof retry === 'function') {
            const b = el('button', 'mf-retry-btn', 'Retry');
            b.type = 'button';
            b.addEventListener('click', retry);
            box.appendChild(b);
        }
        container.appendChild(box);
    }

    function adjustClassesScroll(wrap) {
        const container = document.getElementById('mujfish-classes-container');
        const hint = document.getElementById('mf-classes-scroll-hint');
        if (!container) return;
        const listWrap = wrap || container.querySelector('.mf-list');
        if (!listWrap) {
            container.classList.remove('mf-scrollable');
            container.style.maxHeight = '';
            if (hint) hint.style.display = 'none';
            return;
        }
        const cards = listWrap.querySelectorAll('.mf-card');
        if (cards.length > 4) {
            container.classList.add('mf-scrollable');
            const remaining = cards.length - 4;
            if (hint) {
                hint.textContent = `↓ ${remaining} more class${remaining > 1 ? 'es' : ''}`;
                hint.style.display = 'inline-flex';
                hint.style.opacity = '1';
                hint.style.pointerEvents = 'auto';
                hint.title = 'Click to scroll down';
                hint.onclick = () => {
                    container.scrollBy({ top: 130, behavior: 'smooth' });
                };
            }
            requestAnimationFrame(() => {
                const c0 = cards[0];
                const c3 = cards[3];
                if (c0 && c3 && c0.isConnected && c3.isConnected) {
                    // Fit 4 full cards plus ~36px of the 5th card peeking as an intuitive visual cue
                    const h = (c3.offsetTop + c3.offsetHeight) - c0.offsetTop + 36;
                    if (h > 0) {
                        container.style.maxHeight = h + 'px';
                        return;
                    }
                }
                container.style.maxHeight = '460px';
            });
        } else {
            container.classList.remove('mf-scrollable');
            container.style.maxHeight = '';
            if (hint) hint.style.display = 'none';
        }
    }

    function renderClasses(container, list, signal) {
        container.textContent = '';
        container.scrollTop = 0;
        skipChips = [];
        const hint = document.getElementById('mf-classes-scroll-hint');
        if (!list.length) {
            container.classList.remove('mf-scrollable');
            container.style.maxHeight = '';
            if (hint) hint.style.display = 'none';
            container.appendChild(notice('No classes scheduled for this date.'));
            return [];
        }
        const wrap = el('div', 'mf-list');
        const jobs = [];
        const now = Date.now();

        list.forEach((item) => {
            const s = classify(item.eventColorCode);
            const card = el('div', 'mf-card');
            card.style.setProperty('--c', s.color);

            // Card head: time on left, status badge on right
            const head = el('div', 'mf-card-head');
            const time = el('div', 'mf-time', timeRange(item) || '–');

            // Highlight the class that is running right now
            const st = parseDate(item.StartDate), en = parseDate(item.EndDate);
            if (!isNaN(st) && !isNaN(en) && now >= st && now < en) {
                card.classList.add('mf-live');
                time.appendChild(el('span', 'mf-now', 'NOW'));
            }
            head.appendChild(time);

            const status = el('div');
            setStatus(status, s);
            head.appendChild(status);
            card.appendChild(head);

            // Clean parsed title
            const parsed = parseEventDescription(item.Description || item.title || '');
            card.appendChild(el('div', 'mf-title', parsed.title));

            // Metadata chips row (Room, Section, skip hint)
            let meta = null;
            if (parsed.room || parsed.sec) {
                meta = el('div', 'mf-meta-row');
                if (parsed.room) meta.appendChild(el('span', 'mf-chip', parsed.room));
                if (parsed.sec) meta.appendChild(el('span', 'mf-chip', 'Sec ' + parsed.sec));
            }

            // Forecast the first eligible class per subject. On today's timetable,
            // a past class still marked Pending / Not Marked remains eligible too.
            let skip = null;
            const upcoming = !isNaN(st) && st > now;
            const viewingToday = sameDay(viewDate, new Date());
            const tomorrow = new Date(); tomorrow.setHours(0, 0, 0, 0); tomorrow.setDate(tomorrow.getDate() + 1);
            const viewingTomorrow = sameDay(viewDate, tomorrow);
            const unmarkedToday = viewingToday && s.label === 'Pending / Not Marked';
            if ((viewingToday || viewingTomorrow) && (upcoming || unmarkedToday) &&
                (s.label === 'Pending / Not Marked' || s.label === 'Scheduled Event')) {
                if (!meta) meta = el('div', 'mf-meta-row');
                const chip = el('span', 'mf-chip');
                chip.hidden = true;
                meta.appendChild(chip);
                skip = { chip, title: parsed.title, done: false };
                skipChips.push(skip);
            }
            if (meta) card.appendChild(meta);

            wrap.appendChild(card);

            const eventId = item.EntryNo || item.id;
            if (!eventId || !s.detail) return; // nothing to look up for pending/cancelled/rescheduled

            if (attCache.has(eventId)) {
                applyAttendance(card, status, attCache.get(eventId));
                if (skip) skip.done = true;
                return;
            }
            jobs.push(async () => {
                const d = await postForm('/Student/Academic/GetEventDetailStudent',
                    { EventID: String(eventId) }, signal);
                if (signal.aborted || !card.isConnected) return;
                const type = d && typeof d.AttendanceType === 'string' ? d.AttendanceType.trim() : '';
                if (!type) return;
                attCache.set(eventId, type);
                applyAttendance(card, status, type);
                if (skip) { skip.done = true; fillChips(); }
            });
        });

        container.appendChild(wrap);
        fillChips();
        adjustClassesScroll(wrap);
        return jobs;
    }

    function loadClasses() {
        const container = document.getElementById('mujfish-classes-container');
        if (!container) return;

        if (abortCtl) abortCtl.abort();
        const ctl = abortCtl = new AbortController();

        container.textContent = '';
        container.appendChild(notice('Loading classes...'));

        postForm('/Student/Academic/GetStudentCalenderEventList', {
            Year: '', Month: '', Type: 'agendaDay', Dated: apiDate(viewDate), PreNext: '3'
        }, ctl.signal)
            .then(async (data) => {
                if (ctl.signal.aborted || !container.isConnected) return;
                const list = Array.isArray(data)
                    ? data.filter((x) => x && typeof x === 'object').sort(byStart)
                    : [];
                const jobs = renderClasses(container, list, ctl.signal);
                return runLimited(jobs, MAX_CONCURRENT_DETAILS, ctl.signal);
            })
            .catch(() => {
                if (ctl.signal.aborted || !container.isConnected) return;
                showError(container, 'Error loading classes.', loadClasses);
            });
    }

    function goTo(date) {
        viewDate = date;
        updateDateUI();

        // Cancel in-flight work right away so stale results can't land on the new date
        if (abortCtl) abortCtl.abort();
        const container = document.getElementById('mujfish-classes-container');
        if (container) {
            container.classList.remove('mf-scrollable');
            container.style.maxHeight = '';
            container.scrollTop = 0;
            container.textContent = '';
            const hint = document.getElementById('mf-classes-scroll-hint');
            if (hint) hint.style.display = 'none';
            container.appendChild(notice('Loading classes...'));
        }
        clearTimeout(navTimer);
        navTimer = setTimeout(loadClasses, DAY_DEBOUNCE_MS);
    }

    function shiftDay(delta) {
        const d = new Date(viewDate);
        d.setDate(d.getDate() + delta);
        goTo(d);
    }

    function navBtn(text, label, onClick) {
        const b = el('button', null, text);
        b.type = 'button';
        b.setAttribute('aria-label', label);
        b.addEventListener('click', onClick);
        return b;
    }

    function buildTimetable() {
        const root = el('div');
        root.id = 'mujfish-timetable';

        const head = el('div', 'mf-head');

        const titleRow = el('div', 'mf-title-row');
        const titleLink = el('a', 'mf-head-title', 'Timetable');
        titleLink.href = '/Student/Academic/ViewTimeTableForStudent';
        titleLink.appendChild(icon('la-external-link'));
        titleRow.appendChild(titleLink);

        todayBtn = navBtn('Today', 'Jump to today', () => goTo(new Date()));
        todayBtn.classList.add('mf-today-btn');
        titleRow.appendChild(todayBtn);
        head.appendChild(titleRow);

        const nav = el('div', 'mf-nav');
        dateLabel = el('span', 'mf-date');
        dateLabel.addEventListener('click', () => {
            if (!sameDay(viewDate, new Date())) goTo(new Date());
        });
        nav.appendChild(navBtn('‹', 'Previous day', () => shiftDay(-1)));
        nav.appendChild(dateLabel);
        nav.appendChild(navBtn('›', 'Next day', () => shiftDay(1)));
        head.appendChild(nav);
        root.appendChild(head);

        const container = el('div');
        container.id = 'mujfish-classes-container';
        container.addEventListener('scroll', () => {
            const hint = document.getElementById('mf-classes-scroll-hint');
            if (!hint || hint.style.display === 'none') return;
            const nearBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 20;
            hint.style.opacity = nearBottom ? '0' : '1';
            hint.style.pointerEvents = nearBottom ? 'none' : 'auto';
        }, { passive: true });
        root.appendChild(container);

        const hint = el('div', 'mf-scroll-hint');
        hint.id = 'mf-classes-scroll-hint';
        root.appendChild(hint);

        updateDateUI();
        return root;
    }

    // Hide (never remove) the portal's own left column content, then append ours
    function mountTimetable() {
        const { leftCol } = getColumns();
        if (!leftCol) return null;
        if (!leftCol.querySelector('#mujfish-timetable')) {
            Array.from(leftCol.children).forEach((ch) => ch.classList.add('mf-hidden'));
            leftCol.appendChild(buildTimetable());
            loadClasses();
        }
        return leftCol;
    }

    // ---------- Summary ----------
    let summaryBody = null;
    let summaryData = null;

    function td(content, center) {
        const e = el('td', center ? 'mf-c' : '');
        if (content instanceof Node) e.appendChild(content);
        else e.textContent = content;
        return e;
    }

    // Red when below target, amber when within 5 points, green otherwise
    function pctPill(it) {
        const value = it.Percentage;
        const pct = parseFloat(value);
        const p = parseInt(it.Present, 10);
        const n = parseInt(it.Total, 10);
        let cls = '';
        if (!isNaN(p) && !isNaN(n) && n > 0) {
            cls = classesNeeded(p, n, target) > 0 ? 'mf-bad' : pct < target + 5 ? 'mf-warn' : 'mf-ok';
        } else if (!isNaN(pct)) {
            cls = pct < target ? 'mf-bad' : pct < target + 5 ? 'mf-warn' : 'mf-ok';
        }
        return el('span', 'mf-pill ' + cls, value != null && value !== '' ? String(value) : '–');
    }

    function renderSummary(body, data) {
        body.textContent = '';
        const ok = data && data.IsSuccessfull === true && Array.isArray(data.AttendanceSummaryList);
        const kind = ok ? data.ErrorMessage : null;

        if (!ok || (kind !== 'UPCOMING' && kind !== 'CLOSED')) {
            body.appendChild(notice(data && data.ErrorMessage === 'OPEN'
                ? 'The attendance summary is closed for now.'
                : 'No attendance data available.'));
            return false;
        }

        const full = kind === 'UPCOMING';
        const rows = data.AttendanceSummaryList.slice();
        if (full) rows.sort((a, b) => (parseFloat(b.Percentage) || 0) - (parseFloat(a.Percentage) || 0));

        const table = el('table', 'table table-striped table-bordered table-hover mf-table');

        const tr = document.createElement('tr');
        const heads = full
            ? [['S. No.', 1], ['Course Name', 0], ['Present', 1], ['Absent', 1], ['Total', 1], ['%', 1]]
            : [['S. No.', 1], ['Course Name', 0], ['Status', 0]];
        heads.forEach(([t, c]) => tr.appendChild(el('th', c ? 'mf-c' : '', t)));
        const thead = document.createElement('thead');
        thead.appendChild(tr);
        table.appendChild(thead);

        let below = 0;
        const tbody = document.createElement('tbody');
        rows.forEach((it, i) => {
            const r = document.createElement('tr');
            r.appendChild(td(i + 1, true));
            r.appendChild(td(it.CourseID ?? '', false));
            if (full) {
                const p = parseInt(it.Present, 10);
                const n = parseInt(it.Total, 10);
                if (!isNaN(p) && !isNaN(n) && n > 0 && classesNeeded(p, n, target) > 0) below++;
                r.appendChild(td(it.Present ?? 0, true));
                r.appendChild(td(it.Absent ?? 0, true));
                r.appendChild(td(it.Total ?? 0, true));
                r.appendChild(td(pctPill(it), true));
            } else {
                r.appendChild(td(it.Status ?? '', false));
            }
            tbody.appendChild(r);
        });
        table.appendChild(tbody);

        if (full && below) {
            const banner = el('div', 'mf-low-att-banner');
            banner.appendChild(el('strong', null, `${below} course${below > 1 ? 's need' : ' needs'} attention`));
            banner.appendChild(document.createTextNode(` (target ${target}%).`));
            banner.appendChild(document.createTextNode(' \u2014 open the '));
            const link = el('a', null, 'Attendance page');
            link.href = '/Student/Academic/AttendanceSummaryForStudent';
            banner.appendChild(link);
            banner.appendChild(document.createTextNode(' to see how many classes to attend.'));
            body.appendChild(banner);
        }
        body.appendChild(table);
        return true;
    }

    // Re-draw from the data we already have (no new request)
    function rerenderSummary() {
        if (summaryBody && summaryBody.isConnected && summaryData) renderSummary(summaryBody, summaryData);
        fillChips();
    }

    function findEventsHeader(col9) {
        return Array.from((col9 || document).querySelectorAll('h6'))
            .find((h) => h.textContent.includes('List of Events'));
    }

    function mountSummary() {
        const { ev, col9 } = getColumns();
        if (!ev) return null;

        let box = document.getElementById('mujfish-summary-container');
        if (box) return box.querySelector('#mujfish-summary-body');

        box = el('div');
        box.id = 'mujfish-summary-container';
        const titleLink = el('a', 'mf-head-title', 'Attendance Summary');
        titleLink.href = '/Student/Academic/AttendanceSummaryForStudent';
        titleLink.appendChild(icon('la-external-link'));
        box.appendChild(titleLink);
        box.appendChild(document.createElement('hr'));
        const body = el('div');
        body.id = 'mujfish-summary-body';
        box.appendChild(body);

        const anchor = findEventsHeader(col9) || ev.parentElement;
        if (!anchor || !anchor.parentElement) return null;
        anchor.parentElement.insertBefore(box, anchor);

        body.appendChild(notice('Loading attendance...'));
        return body;
    }

    // Hide the portal's (empty) events list only after our summary rendered successfully
    function hidePortalEvents() {
        const { ev, col9 } = getColumns();
        const header = findEventsHeader(col9);
        if (header) {
            header.classList.add('mf-hidden');
            const next = header.nextElementSibling;
            if (next && next.tagName === 'HR') next.classList.add('mf-hidden');
        }
        if (ev && ev.parentElement) ev.parentElement.classList.add('mf-hidden');
    }

    function loadSummary() {
        const body = mountSummary();
        if (!body) return;
        summaryBody = body;

        // A retry or reinitialization supersedes the previous request.
        if (summaryAbortCtl) summaryAbortCtl.abort();
        const ctl = summaryAbortCtl = new AbortController();

        body.textContent = '';
        body.appendChild(notice('Loading attendance...'));

        postForm('/Student/Academic/GetAttendanceSummaryList', { StudentCode: '' }, ctl.signal)
            .then((data) => {
                if (ctl.signal.aborted || !body.isConnected) return;
                summaryData = data;
                if (data && Array.isArray(data.AttendanceSummaryList)) {
                    try {
                        const rawList = data.AttendanceSummaryList.map((it) => it && it.CourseID).filter(Boolean);
                        sessionStorage.setItem('mujfish_att_courses', JSON.stringify(rawList));
                    } catch (_) { }
                }
                if (renderSummary(body, data)) {
                    hidePortalEvents();
                    if (data.ErrorMessage === 'UPCOMING') indexCourses(data);
                    fillChips();
                    requestAnimationFrame(() => freeHeight(body));
                }
            })
            .catch(() => {
                if (ctl.signal.aborted || !body.isConnected) return;
                showError(body, 'Error loading attendance.', loadSummary);
            });
    }

    // Keep the target in sync when it is changed on the Attendance page.
    function watchTarget() {
        try {
            if (!api || !api.storage || !api.storage.onChanged) return;
            if (targetChangeListener) api.storage.onChanged.removeListener(targetChangeListener);
            targetChangeListener = (changes, area) => {
                try {
                    if (area !== 'local' || !changes[TARGET_KEY]) return;
                    const v = clampTarget(changes[TARGET_KEY].newValue);
                    if (v === target) return;
                    target = v;
                    rerenderSummary();
                } catch (e) { }
            };
            api.storage.onChanged.addListener(targetChangeListener);
        } catch (e) { }
    }

    // ---------- Lifecycle ----------
    function init() {
        try {
            const leftCol = mountTimetable();
            loadSummary();
            watchTarget();

            // Re-mount if the portal removes our widget; watch direct children only.
            if (leftCol) {
                if (remountObs) remountObs.disconnect();
                let remounts = 0;
                remountObs = new MutationObserver(() => {
                    if (leftCol.querySelector('#mujfish-timetable')) return;
                    if (++remounts > MAX_REMOUNTS) {
                        if (remountObs) remountObs.disconnect();
                        remountObs = null;
                        return;
                    }
                    idle(() => { try { mountTimetable(); } catch (e) { } });
                });
                remountObs.observe(leftCol, { childList: true });
            }
        } catch (e) {
            // Never let an extension error interfere with the portal.
        }
    }

    window.addEventListener('pagehide', () => {
        if (abortCtl) abortCtl.abort();
        if (summaryAbortCtl) summaryAbortCtl.abort();
        if (navTimer) {
            clearTimeout(navTimer);
            navTimer = null;
        }
        if (remountObs) {
            remountObs.disconnect();
            remountObs = null;
        }
        if (targetChangeListener && api && api.storage && api.storage.onChanged) {
            try { api.storage.onChanged.removeListener(targetChangeListener); } catch (e) { }
            targetChangeListener = null;
        }
        if (visibilityHandler) {
            document.removeEventListener('visibilitychange', visibilityHandler);
            visibilityHandler = null;
        }
    }, { once: true });

    try {
        storage.get({ [KEY]: true, [TARGET_KEY]: DEFAULT_TARGET }, (data) => {
            try {
                if (api.runtime && api.runtime.lastError) return;
                const enabled = !data || data[KEY] !== false;
                target = clampTarget(data && data[TARGET_KEY]);
                idle(() => {
                    injectStyles();
                    addToggle(enabled);
                    if (enabled) whenVisible(init);
                });
            } catch (e) { }
        });
    } catch (e) { }
})();