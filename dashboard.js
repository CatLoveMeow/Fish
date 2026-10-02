(() => {
    'use strict';

    const KEY = 'mujfish_dashboard_enabled';
    const MAX_CONCURRENT_DETAILS = 2;
    const MAX_DETAIL_FAILURES = 3;     // stop looking up attendance after this many failures
    const DAY_DEBOUNCE_MS = 250;
    const REQUEST_TIMEOUT_MS = 15000;
    const MAX_REMOUNTS = 3;
    const MIN_ATTENDANCE = 75;         // red below this, amber within 5 points above it

    // Not the dashboard (or already injected): do nothing at all
    if (!document.getElementById('kt_ViewEvent')) return;
    if (document.getElementById('mf-bar')) return;

    const api = (typeof chrome !== 'undefined' && chrome.storage) ? chrome
        : (typeof browser !== 'undefined' && browser.storage) ? browser : null;
    const storage = api ? api.storage.local : null;
    if (!storage) return;

    // ---------- Styles (one place, no inline CSS scattered around) ----------
    const CSS = `
    .mf-hidden{display:none!important}

    /* toggle bar: same spot in both views, so nothing jumps around */
    #mf-bar{display:flex;justify-content:flex-end;align-items:center;margin:0 0 10px;padding:4px 0}
    .mf-switch{display:inline-flex;align-items:center;gap:8px;margin:0;cursor:pointer;
        font-size:12px;font-weight:600;color:#475569;user-select:none}
    .mf-switch input{position:absolute;opacity:0;pointer-events:none}
    .mf-track{position:relative;width:30px;height:16px;border-radius:8px;background:#cbd5e1;transition:background .2s}
    .mf-track::after{content:'';position:absolute;top:2px;left:2px;width:12px;height:12px;
        border-radius:50%;background:#fff;transition:transform .2s}
    .mf-switch input:checked + .mf-track{background:#22c55e}
    .mf-switch input:checked + .mf-track::after{transform:translateX(14px)}
    .mf-switch input:focus-visible + .mf-track{outline:2px solid #5d78ff;outline-offset:2px}
    .mf-switch input:disabled + .mf-track{opacity:.5}

    /* timetable */
    #mujfish-timetable{display:flex;flex-direction:column;gap:14px}
    .mf-head{display:flex;justify-content:space-between;align-items:center;
        border-bottom:2px solid #ebedf2;padding-bottom:10px}
    .mf-head h6{margin:0;font-weight:600;color:#464457;font-size:1rem}
    .mf-nav{display:flex;align-items:center;gap:4px;background:#f3f6f9;padding:3px 6px;border-radius:6px}
    .mf-nav button{background:none;border:0;cursor:pointer;color:#555;font-size:1.2em;
        line-height:1;padding:2px 8px;border-radius:4px}
    .mf-nav button:hover{background:#e4e8ee}
    .mf-date{min-width:84px;text-align:center;font-size:.85em;font-weight:700;color:#333}
    .mf-today{font-size:.75em!important;font-weight:600;color:#5d78ff!important}
    .mf-list{display:flex;flex-direction:column;gap:10px}
    .mf-card{--c:#6c6c6c;border-left:4px solid var(--c);padding:10px 12px;background:#f8f9fa;
        border-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,.05);min-height:42px}
    .mf-time{font-size:.75em;color:#7a8190;margin-bottom:2px;font-variant-numeric:tabular-nums}
    .mf-title{font-weight:500;font-size:.9em;margin-bottom:6px;color:#333;line-height:1.3}
    .mf-status{font-size:.85em}

    /* summary */
    #mujfish-summary-container{margin-bottom:25px}
    #mujfish-summary-body{overflow-x:auto}
    .mf-table thead tr{background:#f3f6f9}
    .mf-c{text-align:center}
    .mf-pill{display:inline-block;min-width:52px;padding:2px 8px;border-radius:10px;
        font-weight:700;font-size:.9em;text-align:center}
    .mf-ok{background:#e6f6ec;color:#166534}
    .mf-warn{background:#fff4d6;color:#92600a}
    .mf-bad{background:#fde8e8;color:#b42318}
    .mf-low-att-banner{padding:8px 14px;margin-bottom:10px;border-radius:6px;
        background:#fde8e8;border:1px solid #fca5a5;color:#b42318;font-size:13px;font-weight:500}
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
        const h = () => {
            if (document.hidden) return;
            document.removeEventListener('visibilitychange', h);
            fn();
        };
        document.addEventListener('visibilitychange', h);
    }

    // el(tag, className, text)
    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    function icon(cls) {
        return el('i', 'la ' + cls);
    }

    function notice(kind, msg) {
        return el('div', 'alert alert-' + kind, msg);
    }

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

    // Small concurrency cap. One bad lookup no longer kills the rest;
    // only give up after several failures (server is clearly struggling).
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

    // ---------- Page anchors ----------
    function getColumns() {
        const ev = document.getElementById('kt_ViewEvent');
        const col9 = ev && (ev.closest('.col-md-9') || ev.closest('.col-lg-9'));
        return { ev, col9, leftCol: col9 ? col9.previousElementSibling : null };
    }

    // ---------- Toggle ----------
    // Lives in a slim bar right above the two columns. Same position in
    // Enhanced and Classic view. (The old code grabbed the FIRST
    // .kt-subheader__toolbar, which is the empty one inside the header menu.)
    function addToggle(enabled) {
        if (document.getElementById('mf-bar')) return;
        const { ev, col9 } = getColumns();
        const row = col9 && col9.parentElement;
        const anchor = row || (ev && ev.parentElement);
        if (!anchor || !anchor.parentElement) return;

        const bar = el('div');
        bar.id = 'mf-bar';

        const label = el('label', 'mf-switch');
        label.title = 'Switch between the enhanced dashboard and the original portal view';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = 'mujfish-toggle';
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

    // ---------- Class status ----------
    function classify(raw) {
        let c = String(raw || '').replace('!important', '').trim().toLowerCase();
        if (!/^#[0-9a-f]{3,8}$/.test(c)) c = '#6c6c6c'; // never trust server colours blindly
        switch (c) {
            case '#3d9400':
                return { color: c, bold: true, icon: 'la-check-circle', label: 'Attendance Marked', detail: true };
            case '#820c0c':
                return { color: c, bold: true, icon: 'la-exclamation-circle', label: 'Rescheduled', detail: false };
            case '#800000':
                return { color: c, bold: true, icon: 'la-times-circle', label: 'Cancelled', detail: false };
            case '#6c6c6c':
            case '#808080':
                return { color: '#6c6c6c', bold: false, icon: 'la-clock-o', label: 'Pending / Not Marked', detail: false };
            default:
                return { color: c, bold: true, icon: 'la-info-circle', label: 'Scheduled Event', detail: true };
        }
    }

    function setStatus(statusEl, s) {
        statusEl.textContent = '';
        statusEl.appendChild(icon(s.icon));
        statusEl.appendChild(document.createTextNode(' ' + s.label));
        statusEl.style.color = s.color;
        statusEl.style.fontWeight = s.bold ? '500' : 'normal';
    }

    function applyAttendance(card, statusEl, type) {
        statusEl.textContent = '';
        statusEl.appendChild(icon('la-user'));
        statusEl.appendChild(document.createTextNode(' '));
        statusEl.appendChild(el('strong', null, type));
        const t = type.toLowerCase();
        const tint = t.includes('absent') ? '#e53935'
            : t.includes('not considered') ? '#2196f3' : null;
        if (tint) {
            statusEl.style.color = tint;
            card.style.setProperty('--c', tint);
        }
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
        if (dateLabel) dateLabel.textContent = today ? 'Today' : displayDate(viewDate);
        if (todayBtn) todayBtn.hidden = today;
    }

    function showError(container, msg, retry) {
        container.textContent = '';
        const box = notice('danger', msg + ' ');
        const b = el('button', 'btn btn-sm btn-outline-danger ml-2', 'Retry');
        b.type = 'button';
        b.addEventListener('click', retry);
        box.appendChild(b);
        container.appendChild(box);
    }

    function renderClasses(container, list, signal) {
        container.textContent = '';
        if (!list.length) {
            container.appendChild(notice('secondary', 'No classes scheduled for this date.'));
            return [];
        }
        const wrap = el('div', 'mf-list');
        const jobs = [];

        list.forEach((item) => {
            const s = classify(item.eventColorCode);
            const card = el('div', 'mf-card');
            card.style.setProperty('--c', s.color);

            const time = timeRange(item);
            if (time) card.appendChild(el('div', 'mf-time', time));
            card.appendChild(el('div', 'mf-title', item.Description || item.title || ''));

            const status = el('div', 'mf-status');
            setStatus(status, s);
            card.appendChild(status);
            wrap.appendChild(card);

            const eventId = item.EntryNo || item.id;
            if (!eventId || !s.detail) return; // nothing to look up for pending/cancelled/rescheduled

            if (attCache.has(eventId)) {
                applyAttendance(card, status, attCache.get(eventId));
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
            });
        });

        container.appendChild(wrap);
        return jobs;
    }

    function loadClasses() {
        const container = document.getElementById('mujfish-classes-container');
        if (!container) return;

        if (abortCtl) abortCtl.abort();
        const ctl = abortCtl = new AbortController();

        container.textContent = '';
        container.appendChild(notice('info', 'Loading classes...'));

        postForm('/Student/Academic/GetStudentCalenderEventList', {
            Year: '', Month: '', Type: 'agendaDay', Dated: apiDate(viewDate), PreNext: '3'
        }, ctl.signal)
            .then((data) => {
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
            container.textContent = '';
            container.appendChild(notice('info', 'Loading classes...'));
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
        head.appendChild(el('h6', null, 'Timetable'));

        const nav = el('div', 'mf-nav');
        todayBtn = navBtn('Today', 'Jump to today', () => goTo(new Date()));
        todayBtn.classList.add('mf-today');
        dateLabel = el('span', 'mf-date');
        nav.appendChild(todayBtn);
        nav.appendChild(navBtn('‹', 'Previous day', () => shiftDay(-1)));
        nav.appendChild(dateLabel);
        nav.appendChild(navBtn('›', 'Next day', () => shiftDay(1)));
        head.appendChild(nav);
        root.appendChild(head);

        const container = el('div');
        container.id = 'mujfish-classes-container';
        root.appendChild(container);

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
    function td(content, center) {
        const e = el('td', center ? 'mf-c' : '');
        if (content instanceof Node) e.appendChild(content);
        else e.textContent = content;
        return e;
    }

    function pctPill(value) {
        const n = parseFloat(value);
        const cls = isNaN(n) ? '' : n < MIN_ATTENDANCE ? 'mf-bad' : n < MIN_ATTENDANCE + 5 ? 'mf-warn' : 'mf-ok';
        return el('span', 'mf-pill ' + cls, value != null && value !== '' ? String(value) : '–');
    }

    function renderSummary(body, data) {
        body.textContent = '';
        const ok = data && data.IsSuccessfull === true && Array.isArray(data.AttendanceSummaryList);
        const kind = ok ? data.ErrorMessage : null;

        if (!ok || (kind !== 'UPCOMING' && kind !== 'CLOSED')) {
            body.appendChild(notice('secondary', data && data.ErrorMessage === 'OPEN'
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

        const tbody = document.createElement('tbody');
        rows.forEach((it, i) => {
            const r = document.createElement('tr');
            r.appendChild(td(i + 1, true));
            r.appendChild(td(it.CourseID ?? '', false));
            if (full) {
                r.appendChild(td(it.Present ?? 0, true));
                r.appendChild(td(it.Absent ?? 0, true));
                r.appendChild(td(it.Total ?? 0, true));
                r.appendChild(td(pctPill(it.Percentage), true));
            } else {
                r.appendChild(td(it.Status ?? '', false));
            }
            tbody.appendChild(r);
        });
        table.appendChild(tbody);
        if (full) {
            const below75 = rows.filter((it) => !isNaN(parseFloat(it.Percentage)) && parseFloat(it.Percentage) < 75);
            if (below75.length) {
                const banner = document.createElement('div');
                banner.className = 'mf-low-att-banner';
                banner.innerHTML = '<strong>\u26a0 ' + below75.length + ' course' + (below75.length > 1 ? 's' : '') + ' below 75%</strong> \u2014 attend urgently to avoid debarment risk.';
                body.appendChild(banner); // banner first
            }
        }
        body.appendChild(table);  // table after banner
        return true;

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
        box.appendChild(el('h6', null, 'Attendance Summary'));
        box.appendChild(document.createElement('hr'));
        const body = el('div');
        body.id = 'mujfish-summary-body';
        box.appendChild(body);

        const anchor = findEventsHeader(col9) || ev.parentElement;
        if (!anchor || !anchor.parentElement) return null;
        anchor.parentElement.insertBefore(box, anchor);

        body.appendChild(notice('info', 'Loading attendance...'));
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
        body.textContent = '';
        body.appendChild(notice('info', 'Loading attendance...'));

        postForm('/Student/Academic/GetAttendanceSummaryList', { StudentCode: '' })
            .then((data) => {
                if (!body.isConnected) return;
                if (renderSummary(body, data)) hidePortalEvents();
            })
            .catch(() => {
                if (!body.isConnected) return;
                showError(body, 'Error loading attendance.', loadSummary);
            });
    }

    // ---------- Lifecycle ----------
    function init() {
        try {
            const leftCol = mountTimetable();
            loadSummary();

            // If something removes our column, put it back a few times, then give up
            if (leftCol) {
                let remounts = 0;
                const obs = new MutationObserver(() => {
                    if (leftCol.querySelector('#mujfish-timetable')) return;
                    if (++remounts > MAX_REMOUNTS) { obs.disconnect(); return; }
                    idle(() => { try { mountTimetable(); } catch (e) { } });
                });
                obs.observe(leftCol, { childList: true }); // direct children only, not subtree
            }
        } catch (e) {
            // never let an error reach the page
        }
    }

    try {
        storage.get({ [KEY]: true }, (data) => {
            try {
                if (api.runtime && api.runtime.lastError) return;
                const enabled = !data || data[KEY] !== false;
                idle(() => {
                    injectStyles();
                    addToggle(enabled);
                    if (enabled) whenVisible(init);
                });
            } catch (e) { }
        });
    } catch (e) { }
})();