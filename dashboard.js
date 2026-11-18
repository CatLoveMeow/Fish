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
    const hasDashboardLayout = Boolean(
        document.querySelector('.col-md-9, .col-lg-9') &&
        document.querySelector('.col-md-3, .col-lg-3')
    );
    if (!hasDashboardLayout && !document.getElementById('kt_ViewEvent')) return;
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

    #mujfish-timetable{display:flex;flex-direction:column;gap:16px;color:var(--mf-ink);font-family:inherit;margin-top:12px;margin-bottom:24px}
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
    #mujfish-summary-container{margin-top:12px;margin-bottom:24px}

    /* Exam Schedule Widget (Left Column) */
    #mujfish-exam-schedule{margin-top:12px;margin-bottom:24px;width:100%;min-width:0}
    #mujfish-exam-schedule .mf-head{display:flex;flex-direction:column;align-items:stretch;gap:8px;padding-bottom:10px;width:100%;min-width:0;border-bottom:1px solid var(--mf-line)}
    #mujfish-exam-cards-container{display:flex;flex-direction:column;gap:8px;max-height:430px;overflow-y:auto;overscroll-behavior-y:contain;padding-right:4px;scrollbar-width:thin;scrollbar-color:#cbd5e1 transparent}
    #mujfish-exam-cards-container::-webkit-scrollbar{width:5px}
    #mujfish-exam-cards-container::-webkit-scrollbar-track{background:transparent}
    #mujfish-exam-cards-container::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:10px}
    #mujfish-exam-cards-container::-webkit-scrollbar-thumb:hover{background:#94a3b8}
    #mujfish-exam-cards-container .mf-card{min-width:0;padding:11px 12px;border-radius:10px;background:#fff;border:1px solid var(--mf-line);border-left:3px solid var(--c);box-shadow:var(--mf-shadow);transition:transform .15s ease,box-shadow .15s ease;box-sizing:border-box}
    #mujfish-exam-cards-container .mf-card:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.08)}
    #mujfish-exam-cards-container .mf-card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px}
    #mujfish-exam-cards-container .mf-time{font-size:11px;font-weight:600;color:var(--mf-muted);line-height:1.45}
    #mujfish-exam-cards-container .mf-status-badge{font-size:10px;padding:2px 7px;border-radius:999px;white-space:nowrap}
    #mujfish-exam-cards-container .mf-title{font-size:12.5px;font-weight:700;color:var(--mf-ink);line-height:1.35;margin-bottom:6px}
    #mujfish-exam-cards-container .mf-meta-row{display:flex;gap:4px;margin-top:5px;align-items:center;flex-wrap:wrap}
    #mujfish-exam-cards-container .mf-chip{font-size:9.5px;font-weight:650;padding:2px 6px;border-radius:4px;background:var(--mf-soft);color:var(--mf-muted);border:1px solid var(--mf-line)}
    .mf-summary-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
    .mf-summary-tabs{display:inline-flex;background:#f1f5f9;border-radius:8px;padding:3px;gap:3px}
    .mf-tab-btn{border:none;background:transparent;padding:5px 12px;border-radius:6px;font-size:12px;font-weight:600;color:#64748b;cursor:pointer;transition:all .15s ease}
    .mf-tab-btn:hover{color:#1e293b}
    .mf-tab-btn.active{background:#ffffff;color:#0f172a;box-shadow:0 1px 3px rgba(0,0,0,.08)}
    .mf-summary-actions{display:inline-flex;align-items:center;gap:8px}
    .mf-summary-head-left{display:inline-flex;align-items:center;gap:8px}
    .mf-notice-jump-link{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:6px;background:#f8fafc;border:1px solid #cbd5e1;font-size:11px;font-weight:600;color:#0f172a;text-decoration:none;cursor:pointer;transition:all .15s ease}
    .mf-notice-jump-link:hover{background:#f1f5f9;border-color:#94a3b8;color:#0284c7}
    .mf-sync-btn{background:transparent;border:1px solid #cbd5e1;color:#64748b;font-size:14px;border-radius:6px;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;transition:all .18s ease;line-height:1}
    .mf-sync-btn:hover{color:#0f172a;border-color:#94a3b8;background:#f1f5f9}
    .mf-sync-icon{display:inline-block;line-height:1}
    .mf-spinning{animation:mf-spin .65s linear infinite;display:inline-block}
    @keyframes mf-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
    .mf-marks-dashboard-footer{display:flex;justify-content:space-between;align-items:center;margin-top:12px;padding:10px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:12px;box-sizing:border-box}
    .mf-marks-cgpa-col{display:inline-flex;align-items:center;gap:6px;color:#334155}
    .mf-marks-cgpa-col strong{font-weight:800;color:#0f172a;font-size:13px}
    .mf-cgpa-val{display:inline-block;cursor:pointer;transition:filter .25s ease,opacity .25s ease;user-select:none;padding:0 2px;border-radius:4px}
    .mf-cgpa-blurred{filter:blur(5.5px);opacity:0.55}
    .mf-cgpa-blurred:hover{filter:blur(3.5px);opacity:0.8}
    .mf-footer-sync-btn{background:transparent;border:none;color:#3b82f6;font-size:11px;font-weight:600;cursor:pointer;padding:1px 5px;border-radius:4px;transition:all .15s ease;display:inline-flex;align-items:center;gap:4px;text-decoration:none}
    .mf-footer-sync-btn:hover:not(:disabled){background:#e0f2fe;color:#0284c7}
    .mf-footer-sync-btn:disabled{opacity:0.45;cursor:default}
    .mf-marks-sem-col{color:#64748b}
    .mf-marks-pred-link{color:#3b82f6;font-weight:600;text-decoration:none}
    .mf-marks-pred-link:hover{text-decoration:underline}

    /* Official exam table row highlight */
    tr.mf-next-exam > td{background:#f5f8ff!important}
    tr.mf-next-exam > td:first-child{box-shadow:inset 3px 0 0 var(--mf-accent)}

    .mf-slim-notice{padding:10px 12px;border:1px dashed var(--mf-line);border-radius:8px;font-size:11.5px;font-weight:600;color:var(--mf-muted);text-align:center;background:var(--mf-soft)}

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
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest'
            },
            signal: ctl.signal
        })
            .then((res) => {
                if (res.redirected && res.url && res.url.includes('/Account/Login')) {
                    const err = new Error('SESSION_EXPIRED');
                    err.isSessionExpired = true;
                    throw err;
                }
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.text();
            })
            .then((txt) => {
                if (txt.includes('/Account/Login') || (txt.includes('<html') && txt.includes('Login'))) {
                    const err = new Error('SESSION_EXPIRED');
                    err.isSessionExpired = true;
                    throw err;
                }
                return JSON.parse(txt);
            })
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
    // Confined strictly to the dashboard column hierarchy so ancestors above it are untouched.
    function freeHeight(node) {
        try {
            const col = node ? node.closest('.col-md-9, .col-lg-9') : null;
            if (!col) return;
            for (let p = node.parentElement; p; p = p.parentElement) {
                if (getComputedStyle(p).overflowY === 'visible' && p.scrollHeight > p.clientHeight + 2) {
                    p.style.setProperty('height', 'auto', 'important');
                    p.style.setProperty('max-height', 'none', 'important');
                }
                if (p === col) break;
            }
        } catch (e) { }
    }

    // ---------- Page anchors & Placement Engine ----------
    function getColumns() {
        const col9 = document.querySelector('.col-md-9, .col-lg-9');
        const leftCol = col9 ? col9.previousElementSibling : document.querySelector('.col-md-3, .col-lg-3');
        const ev = document.getElementById('kt_ViewEvent');
        return { ev, col9, leftCol };
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

    function safeSkipCount(p, n, T) {
        const v = (MF && MF.MATH && MF.MATH.safeSkips) ? MF.MATH.safeSkips(p, n, T, ROUND_UP_MARGIN) : 0;
        return Number.isFinite(v) ? v : 0;
    }

    // ---------- Course lookup (links timetable classes to the summary numbers) ----------
    let courses = [];     // { code, key, p, n } from the attendance summary
    let skipChips = [];   // eligible class forecast chips for the currently displayed day
    let todayClassesList = null; // cached today's timetable events to carry forward into tomorrow

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

        // When viewing tomorrow, carry forward today's still-eligible unmarked classes
        if (viewing.getTime() === tomorrow.getTime() && Array.isArray(todayClassesList)) {
            todayClassesList.forEach((it) => {
                const s = classify(it.eventColorCode);
                const eligible = s.label === 'Pending / Not Marked' || s.label === 'Scheduled Event';
                if (!eligible || attCache.has(it.EntryNo || it.id)) return;
                const c = findCourse(parseEventDescription(it.Description || '').title);
                if (c) {
                    const k = c.code || c.name || norm(c.name);
                    missedByCourse.set(k, (missedByCourse.get(k) || 0) + 1);
                }
            });
        }

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

            const safe = safeSkipCount(c.p, c.n, target);
            const safeMsg = safe > 0 ? ` (Can safely skip ${safe} ${safe === 1 ? 'class' : 'classes'})` : '';

            s.chip.className = 'mf-chip mf-attendance-hint';
            s.chip.innerHTML = `Skip: <span class="mf-hint-val ${hintCls}">${projected.toFixed(1)}%</span>`;
            s.chip.title = `Projected attendance if you skip this and ${missed - 1} earlier eligible ${missed === 2 ? 'class' : 'classes'} of this subject: ${projected.toFixed(1)}%. Target: ${target}%.${safeMsg} Forecast only; SLCM records are unchanged.`;
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
            container.appendChild(el('div', 'mf-slim-notice', 'No classes scheduled for today'));
            syncBaselineAlignment();
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
        syncBaselineAlignment();
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
                if (sameDay(viewDate, new Date())) {
                    todayClassesList = list;
                } else if (!todayClassesList) {
                    // Seed today's classes in background so tomorrow's forecast can carry forward
                    postForm('/Student/Academic/GetStudentCalenderEventList', {
                        Year: '', Month: '', Type: 'agendaDay', Dated: apiDate(new Date()), PreNext: '3'
                    }, ctl.signal).then((todayData) => {
                        if (Array.isArray(todayData)) {
                            todayClassesList = todayData.filter((x) => x && typeof x === 'object').sort(byStart);
                            fillChips();
                        }
                    }).catch(() => { });
                }
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

    function mountTimetable() {
        const { leftCol } = getColumns();
        if (!leftCol) return null;
        let box = leftCol.querySelector('#mujfish-timetable');
        if (!box) {
            box = buildTimetable();
            leftCol.insertBefore(box, leftCol.firstChild);
            loadClasses();
        } else if (leftCol.firstChild !== box) {
            leftCol.insertBefore(box, leftCol.firstChild);
        }
        syncBaselineAlignment();
        return leftCol;
    }

    // ---------- Exam Mode, Next Exam Strip & Glance Bar ----------
    function findExamTable(col9) {
        if (!col9) return null;
        const tables = Array.from(col9.querySelectorAll('table'));
        for (const tbl of tables) {
            const headers = Array.from(tbl.querySelectorAll('th'));
            if (!headers.length) continue;
            let dIdx = -1, cIdx = -1, tIdx = -1, rIdx = -1, cdIdx = -1, sIdx = -1, stIdx = -1;
            headers.forEach((th, idx) => {
                const txt = (th.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
                if (/\bdate\b/.test(txt)) dIdx = idx;
                else if (/\b(course\s*name|subject)\b/.test(txt)) cIdx = idx;
                else if (/\bcourse\s*code\b/.test(txt)) cdIdx = idx;
                else if (/\btime\b/.test(txt)) tIdx = idx;
                else if (/\b(room|venue)\b/.test(txt)) rIdx = idx;
                else if (/\bseat\b/.test(txt)) sIdx = idx;
                else if (/\bstatus\b/.test(txt)) stIdx = idx;
            });
            if (dIdx !== -1 && cIdx !== -1) {
                return { tbl, dIdx, cIdx, tIdx, rIdx, cdIdx, sIdx, stIdx };
            }
        }
        return null;
    }

    function isExamMode(col9) {
        return Boolean(findExamTable(col9));
    }

    function parseAllExams(col9) {
        const found = findExamTable(col9);
        if (!found) return [];

        const { tbl: examTable, dIdx: dateIdx, cIdx: courseIdx, tIdx: timeIdx, rIdx: roomIdx, cdIdx: codeIdx, sIdx: seatIdx, stIdx: statusIdx } = found;

        const MONTH_MAP = {
            jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
            jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
        };
        const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

        const rows = Array.from(examTable.querySelectorAll('tbody tr:not(.dataTables_empty)'));
        if (!rows.length) return [];

        const now = Date.now();
        const candidateExams = [];
        let hasAttention = statusIdx === -1;

        rows.forEach((r) => {
            if (!r.cells[dateIdx] || !r.cells[courseIdx]) return;
            const dateText = (r.cells[dateIdx].textContent || '').replace(/\s+/g, ' ').trim();
            const courseText = (r.cells[courseIdx].textContent || '').replace(/\s+/g, ' ').trim();
            const courseCode = codeIdx !== -1 && r.cells[codeIdx]
                ? (r.cells[codeIdx].textContent || '').replace(/\s+/g, ' ').trim() : '';
            const timeText = timeIdx !== -1 && r.cells[timeIdx]
                ? (r.cells[timeIdx].textContent || '').replace(/\s+/g, ' ').trim() : '';
            const roomText = roomIdx !== -1 && r.cells[roomIdx]
                ? (r.cells[roomIdx].textContent || '').replace(/\s+/g, ' ').trim() : '';

            // Seat text spacing fix: "Seat 65 · Row 5, Col 7"
            let seatText = '';
            if (seatIdx !== -1 && r.cells[seatIdx]) {
                const cell = r.cells[seatIdx];
                const textPieces = [];
                cell.childNodes.forEach((node) => {
                    const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
                    if (t) textPieces.push(t);
                });
                if (textPieces.length > 1) {
                    seatText = textPieces.join(' · ');
                } else {
                    const raw = (cell.textContent || '').replace(/\s+/g, ' ').trim();
                    seatText = raw.replace(/^(\d+)\s*(?:Row|r)\b/i, '$1 · Row');
                }
            }

            // Status check: flag attention if any row is not "Scheduled"
            if (statusIdx !== -1 && r.cells[statusIdx]) {
                const sText = (r.cells[statusIdx].textContent || '').replace(/\s+/g, ' ').trim();
                if (sText && !/^\s*scheduled\s*$/i.test(sText)) {
                    hasAttention = true;
                }
            }

            const dm = dateText.match(/\b(\d{1,2})[\s\-]+([A-Za-z]{3})[\s\-]+(\d{4})\b/);
            if (!dm) return;

            const day = parseInt(dm[1], 10);
            const monthName = dm[2].toLowerCase();
            const year = parseInt(dm[3], 10);
            if (!Object.prototype.hasOwnProperty.call(MONTH_MAP, monthName)) return;
            const month = MONTH_MAP[monthName];

            let endTimeMs = new Date(year, month, day, 23, 59, 59, 999).getTime();
            let startTimeMs = new Date(year, month, day, 0, 0, 0, 0).getTime();

            const tm = timeText.match(/(\d{1,2}):(\d{2})(?:\s*[-–—~to]+\s*(\d{1,2}):(\d{2}))?\s*(AM|PM)?/i);
            if (tm) {
                const sH = parseInt(tm[1], 10);
                const sM = parseInt(tm[2], 10);
                const eH = tm[3] ? parseInt(tm[3], 10) : sH;
                const eM = tm[4] ? parseInt(tm[4], 10) : sM;
                const ampm = (tm[5] || '').toUpperCase();

                let adjEH = eH;
                if (ampm === 'PM' && adjEH < 12) adjEH += 12;
                if (ampm === 'AM' && adjEH === 12) adjEH = 0;

                let adjSH = sH;
                if (ampm === 'PM' && adjSH < 12 && tm[3]) adjSH += 12;
                if (ampm === 'AM' && adjSH === 12) adjSH = 0;

                const parsedEnd = new Date(year, month, day, adjEH, eM, 0, 0).getTime();
                if (!isNaN(parsedEnd)) endTimeMs = parsedEnd;
                const parsedStart = new Date(year, month, day, adjSH, sM, 0, 0).getTime();
                if (!isNaN(parsedStart)) startTimeMs = parsedStart;

                // Fix: 09:30–12:30 PM (start becomes 21:30 which is after end)
                if (startTimeMs > endTimeMs) {
                    startTimeMs -= 12 * 3600 * 1000;
                }
            }

            const isPast = endTimeMs < now;
            const dateObj = new Date(year, month, day);
            const weekday = DAY_NAMES[dateObj.getDay()];

            candidateExams.push({
                row: r,
                course: courseText,
                courseCode,
                day,
                monthName: dm[2],
                year,
                dateObj,
                weekday,
                startTimeMs,
                endTimeMs,
                timeText,
                roomText,
                seatText,
                isPast
            });
        });

        rows.forEach((r) => r.classList.remove('mf-next-exam'));
        if (!candidateExams.length) return [];

        candidateExams.sort((a, b) => a.startTimeMs - b.startTimeMs);
        candidateExams.hasAttention = hasAttention;
        candidateExams.examTable = examTable;

        const firstUpcoming = candidateExams.find((e) => !e.isPast);
        if (firstUpcoming) {
            firstUpcoming.isNext = true;
            firstUpcoming.row.classList.add('mf-next-exam');

            const todayMid = new Date(); todayMid.setHours(0, 0, 0, 0);
            const examMid = new Date(firstUpcoming.dateObj); examMid.setHours(0, 0, 0, 0);
            const diffDays = Math.round((examMid - todayMid) / (24 * 60 * 60 * 1000));

            if (diffDays <= 0) {
                firstUpcoming.relText = 'Today';
                firstUpcoming.isSoon = true;
            } else if (diffDays === 1) {
                firstUpcoming.relText = 'Tomorrow';
                firstUpcoming.isSoon = true;
            } else {
                firstUpcoming.relText = `in ${diffDays} days`;
                firstUpcoming.isSoon = false;
            }
        }

        return candidateExams;
    }

    function scrollToOfficialExamTable(col9, examTable) {
        let tbl = examTable;
        if (!tbl) {
            const found = findExamTable(col9);
            tbl = found ? found.tbl : null;
        }
        if (!tbl) {
            const tables = Array.from((col9 || document).querySelectorAll('table'));
            tbl = tables.find((t) => !t.closest('#mujfish-summary-container, #mujfish-timetable, #mujfish-exam-schedule'));
        }
        if (!tbl) return;

        // Find the "Student Examination Schedule" heading or closest section wrapper directly associated with this table
        let target = null;
        let prev = tbl.previousElementSibling;
        while (prev) {
            if (/examination\s*schedule|seating\s*plan/i.test(prev.textContent || '')) {
                target = prev;
                break;
            }
            prev = prev.previousElementSibling;
        }

        if (!target) {
            let p = tbl.parentElement;
            while (p && p !== col9 && p !== document.body) {
                const h = Array.from(p.querySelectorAll('h1, h2, h3, h4, h5, h6, strong, b, .portlet-title, .card-title')).find((el) => {
                    if (el.contains(tbl)) return false;
                    return /examination\s*schedule|seating\s*plan/i.test(el.textContent || '');
                });
                if (h) {
                    target = h;
                    break;
                }
                p = p.parentElement;
            }
        }

        if (!target) target = tbl;
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function buildExamScheduleWidget(col9) {
        const root = el('div');
        root.id = 'mujfish-exam-schedule';

        const head = el('div', 'mf-head');
        const titleRow = el('div', 'mf-title-row');
        titleRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;width:100%;margin-bottom:8px;';

        const title = el('span', 'mf-head-title', 'Exam Schedule');
        title.style.cursor = 'default';

        const officialLink = el('a', 'mf-official-link');
        officialLink.innerHTML = '<span>View official table</span> <span style="font-size:10px;">&darr;</span>';
        officialLink.style.cssText = 'font-size:11px;font-weight:600;color:#0f172a;background:#f8fafc;border:1px solid #cbd5e1;padding:3px 9px;border-radius:6px;text-decoration:none;cursor:pointer;display:inline-flex;align-items:center;gap:4px;transition:all .15s ease;box-shadow:0 1px 2px rgba(0,0,0,0.04);white-space:nowrap;flex-shrink:0;';
        officialLink.title = 'Scroll down to the official university examination table';
        officialLink.onclick = (e) => {
            e.preventDefault();
            scrollToOfficialExamTable(col9);
        };
        officialLink.onmouseenter = () => { officialLink.style.background = '#f1f5f9'; officialLink.style.borderColor = '#94a3b8'; officialLink.style.color = '#0284c7'; };
        officialLink.onmouseleave = () => { officialLink.style.background = '#f8fafc'; officialLink.style.borderColor = '#cbd5e1'; officialLink.style.color = '#0f172a'; };

        titleRow.append(title, officialLink);
        head.appendChild(titleRow);

        const alertBanner = el('div', 'mf-exam-alert-banner');
        alertBanner.id = 'mf-exam-alert-banner';
        alertBanner.style.display = 'none';
        head.appendChild(alertBanner);

        root.appendChild(head);

        const container = el('div');
        container.id = 'mujfish-exam-cards-container';
        root.appendChild(container);

        renderExamCards(container, col9);
        return root;
    }

    function renderExamCards(container, col9) {
        container.textContent = '';
        const exams = parseAllExams(col9);

        const banner = document.getElementById('mf-exam-alert-banner');
        const officialLink = document.querySelector('#mujfish-exam-schedule .mf-official-link');
        if (banner) {
            if (exams && exams.hasAttention) {
                if (officialLink) officialLink.style.display = 'none';
                banner.textContent = '';
                banner.style.cssText = 'display:flex;align-items:center;gap:6px;padding:8px 10px;margin-top:2px;border-radius:7px;background:var(--mf-amber-bg);border:1px solid #eed69b;color:var(--mf-amber);font-size:11px;font-weight:650;line-height:1.35;cursor:pointer;width:100%;box-sizing:border-box;';
                banner.innerHTML = '<span>&#9888;</span><span>Some exams need attention &mdash; check official table below &darr;</span>';
                banner.onclick = () => {
                    scrollToOfficialExamTable(col9, exams && exams.examTable);
                };
            } else {
                banner.style.display = 'none';
                if (officialLink) officialLink.style.display = 'inline-flex';
            }
        }

        if (!exams || !exams.length) {
            const fallback = el('div', 'mf-slim-notice');
            fallback.style.cssText = 'padding:14px;cursor:pointer;text-align:center;color:var(--mf-accent);font-weight:650;';
            fallback.innerHTML = 'Exam schedule below &darr;';
            fallback.onclick = () => {
                scrollToOfficialExamTable(col9);
            };
            container.appendChild(fallback);
            syncBaselineAlignment();
            return;
        }

        exams.forEach((ex) => {
            const card = el('div', 'mf-card mf-exam-card' + (ex.isNext ? ' mf-exam-card-next' : ''));
            card.style.setProperty('--c', ex.isNext ? 'var(--mf-accent)' : '#94a3b8');
            card.style.cursor = 'pointer';
            card.title = 'Click to scroll to seating row';

            const cardHead = el('div', 'mf-card-head');
            const timeWrap = el('div', 'mf-time');
            timeWrap.textContent = `${ex.weekday} ${ex.day} ${ex.monthName} · ${ex.timeText || ''}`;
            cardHead.appendChild(timeWrap);

            if (ex.isNext) {
                const badge = el('span', 'mf-status-badge' + (ex.isSoon ? ' mf-rel-soon' : ''), ex.relText || 'Next Exam');
                badge.style.background = 'var(--mf-amber-bg)';
                badge.style.color = 'var(--mf-amber)';
                badge.style.fontWeight = '700';
                cardHead.appendChild(badge);
            } else if (ex.isPast) {
                const badge = el('span', 'mf-status-badge', 'Completed');
                badge.style.background = '#f1f5f9';
                badge.style.color = '#94a3b8';
                cardHead.appendChild(badge);
            }
            card.appendChild(cardHead);

            const titleEl = el('div', 'mf-title', ex.course);
            card.appendChild(titleEl);

            const metaRow = el('div', 'mf-meta-row');
            if (ex.roomText) {
                metaRow.appendChild(el('span', 'mf-chip', 'Room ' + ex.roomText));
            }
            if (ex.seatText) {
                metaRow.appendChild(el('span', 'mf-chip', 'Seat ' + ex.seatText));
            }
            if (ex.courseCode) {
                metaRow.appendChild(el('span', 'mf-chip', ex.courseCode));
            }
            card.appendChild(metaRow);

            card.onclick = () => {
                if (ex.row) ex.row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            };

            container.appendChild(card);
        });

        requestAnimationFrame(() => {
            const nextCard = container.querySelector('.mf-exam-card-next');
            if (nextCard) {
                const targetScroll = Math.max(0, nextCard.offsetTop - container.offsetTop - 6);
                container.scrollTo({ top: targetScroll, behavior: 'smooth' });
            } else {
                container.scrollTop = 0;
            }
        });
        syncBaselineAlignment();
    }

    function mountExamSchedule(col9) {
        const { leftCol } = getColumns();
        if (!leftCol) return null;
        let box = leftCol.querySelector('#mujfish-exam-schedule');
        if (!box) {
            box = buildExamScheduleWidget(col9);
            leftCol.insertBefore(box, leftCol.firstChild);
        } else {
            const container = box.querySelector('#mujfish-exam-cards-container');
            if (container) renderExamCards(container, col9);
            if (leftCol.firstChild !== box) {
                leftCol.insertBefore(box, leftCol.firstChild);
            }
        }
        syncBaselineAlignment();
        return leftCol;
    }

    let examObs = null;
    function setupExamObserver(col9) {
        if (!col9) return;
        if (examObs) examObs.disconnect();

        examObs = new MutationObserver((mutations) => {
            const hasExternal = mutations.some((m) => {
                const t = m.target;
                if (!t) return false;
                if (t.closest && t.closest('#mujfish-summary-container')) return false;
                if (t.id && (t.id.startsWith('mujfish-') || t.id === 'mf-bar')) return false;
                return true;
            });
            if (hasExternal) {
                mountExamSchedule(col9);
                updateNoticeLink();
                syncBaselineAlignment();
            }
        });

        examObs.observe(col9, { childList: true, subtree: true });
        setTimeout(() => {
            if (examObs) {
                examObs.disconnect();
                examObs = null;
            }
        }, 3500);
    }

    let resizeHandler = null;
    let baselineResizeObs = null;

    function setupBaselineObserver() {
        if (typeof ResizeObserver !== 'function') return;
        if (!baselineResizeObs) {
            baselineResizeObs = new ResizeObserver(() => {
                syncBaselineAlignment();
            });
        }
        const leftBox = document.getElementById('mujfish-exam-schedule') || document.getElementById('mujfish-timetable');
        const rightBox = document.getElementById('mujfish-summary-container');
        if (leftBox) baselineResizeObs.observe(leftBox);
        if (rightBox) baselineResizeObs.observe(rightBox);
    }

    function setupResizeListener() {
        if (resizeHandler) return;
        let resizeTimer = null;
        resizeHandler = () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(syncBaselineAlignment, 100);
        };
        window.addEventListener('resize', resizeHandler);
    }

    function syncBaselineAlignment() {
        setupResizeListener();
        setupBaselineObserver();
        requestAnimationFrame(() => {
            const { col9, leftCol } = getColumns();
            const leftBox = document.getElementById('mujfish-exam-schedule') || document.getElementById('mujfish-timetable');
            const rightBox = document.getElementById('mujfish-summary-container');
            if (!leftBox || !rightBox) return;

            // Keep observing both boxes if they exist
            if (baselineResizeObs) {
                baselineResizeObs.observe(leftBox);
                baselineResizeObs.observe(rightBox);
            }

            const BASE_GAP = 24;

            // On mobile / narrow screens (stacked single column < 768px), keep natural spacing
            if (window.innerWidth < 768) {
                leftBox.style.marginBottom = BASE_GAP + 'px';
                rightBox.style.marginBottom = BASE_GAP + 'px';
                return;
            }

            // Check if there is actual native content below our left widget
            const hasNativeLeft = leftCol && Array.from(leftCol.children).some((el) => {
                if (!el || el === leftBox || el.nodeType !== 1) return false;
                if (el.id && el.id.startsWith('mujfish-')) return false;
                if (el.className && /(?:^|\s)mf-/.test(el.className)) return false;
                if (!el.offsetHeight && !el.offsetWidth) return false;
                return (el.textContent || '').trim().length > 0;
            });

            // Check if there is actual native content below our right widget
            const hasNativeRight = col9 && Array.from(col9.children).some((el) => {
                if (!el || el === rightBox || el.nodeType !== 1) return false;
                if (el.id && el.id.startsWith('mujfish-')) return false;
                if (el.className && /(?:^|\s)mf-/.test(el.className)) return false;
                if (!el.offsetHeight && !el.offsetWidth) return false;
                return (el.textContent || '').trim().length > 0;
            });

            // If only one side has content below, or neither does, use default gap (no phantom whitespace)
            if (!hasNativeLeft || !hasNativeRight) {
                leftBox.style.marginBottom = BASE_GAP + 'px';
                rightBox.style.marginBottom = BASE_GAP + 'px';
                return;
            }

            // Both sides have content below -> balance visual bottom edges so both lower panels start at the exact same pixel line
            const leftRect = leftBox.getBoundingClientRect();
            const rightRect = rightBox.getBoundingClientRect();

            const leftBottom = leftRect.bottom;
            const rightBottom = rightRect.bottom;

            if (leftBottom > rightBottom + 2) {
                const diff = Math.round(leftBottom - rightBottom);
                rightBox.style.marginBottom = (BASE_GAP + diff) + 'px';
                leftBox.style.marginBottom = BASE_GAP + 'px';
            } else if (rightBottom > leftBottom + 2) {
                const diff = Math.round(rightBottom - leftBottom);
                leftBox.style.marginBottom = (BASE_GAP + diff) + 'px';
                rightBox.style.marginBottom = BASE_GAP + 'px';
            } else {
                leftBox.style.marginBottom = BASE_GAP + 'px';
                rightBox.style.marginBottom = BASE_GAP + 'px';
            }
        });
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

    let activeSummaryTab = 'attendance';
    let userSelectedTab = false;
    let marksData = null;
    let marksAbortCtl = null;
    let lastManualSyncTime = 0;
    const MANUAL_SYNC_COOLDOWN_MS = 60 * 1000;

    function renderSummary(body, data) {
        body.textContent = '';
        const ok = data && data.IsSuccessfull === true && Array.isArray(data.AttendanceSummaryList);
        const kind = ok ? data.ErrorMessage : null;

        // Auto-switch to marks if attendance is CLOSED ("Approved" / end of sem) and user hasn't explicitly chosen
        if (kind === 'CLOSED' && !userSelectedTab && activeSummaryTab !== 'marks') {
            switchSummaryTab('marks');
            return true;
        }

        if (activeSummaryTab === 'marks') {
            loadMarks();
            return true;
        }

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
        syncBaselineAlignment();
        return true;
    }

    // Re-draw from the data we already have (no new request)
    function rerenderSummary() {
        if (activeSummaryTab === 'marks') {
            loadMarks();
        } else {
            if (summaryBody && summaryBody.isConnected && summaryData) renderSummary(summaryBody, summaryData);
        }
        fillChips();
    }

    function switchSummaryTab(tab) {
        activeSummaryTab = tab;
        const btnAtt = document.getElementById('mf-tab-att');
        const btnMarks = document.getElementById('mf-tab-marks');
        const link = document.getElementById('mf-summary-link');
        const linkText = link && link.querySelector('.mf-head-title-text');

        if (btnAtt) btnAtt.classList.toggle('active', tab === 'attendance');
        if (btnMarks) btnMarks.classList.toggle('active', tab === 'marks');

        if (link && linkText) {
            link.hidden = false;
            if (tab === 'marks') {
                link.href = '/Student/Academic/InternalMarkForStudent';
                linkText.textContent = 'Internal Marks ';
            } else {
                link.href = '/Student/Academic/AttendanceSummaryForStudent';
                linkText.textContent = 'Attendance ';
            }
        }

        if (tab === 'marks') {
            loadMarks();
        } else {
            rerenderSummary();
        }
        syncBaselineAlignment();
    }

    const ROMAN_MAP = {
        '1': 'I', '2': 'II', '3': 'III', '4': 'IV', '5': 'V',
        '6': 'VI', '7': 'VII', '8': 'VIII', '9': 'IX', '10': 'X',
        'I': 'I', 'II': 'II', 'III': 'III', 'IV': 'IV', 'V': 'V',
        'VI': 'VI', 'VII': 'VII', 'VIII': 'VIII', 'IX': 'IX', 'X': 'X'
    };

    function normSem(s) {
        if (!s) return '';
        if (MF && typeof MF.normSem === 'function') return MF.normSem(s);
        const clean = String(s).replace(/semester/i, '').trim().toUpperCase();
        return ROMAN_MAP[clean] || clean;
    }

    async function detectCurrentSemester() {
        if (typeof MujFish !== 'undefined' && MujFish.detectCurrentSemester) {
            return await MujFish.detectCurrentSemester();
        }
        const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;
        try {
            const cached = await new Promise((res) => storage.get(['muj_current_semester', 'muj_sem_checked_at', 'muj_internal_marks_cache'], res));
            const isFresh = cached && cached.muj_sem_checked_at && (Date.now() - cached.muj_sem_checked_at < FOURTEEN_DAYS);
            if (isFresh && cached.muj_current_semester) return cached.muj_current_semester;
            if (isFresh && cached.muj_internal_marks_cache && cached.muj_internal_marks_cache.sem) {
                const s = cached.muj_internal_marks_cache.sem.replace(/semester/i, '').trim();
                if (s) return s;
            }
        } catch (_) { }

        try {
            const res = await fetch('/Employee/EmployeeDirectory/IndexStudent', { credentials: 'same-origin' });
            if (res.ok) {
                const html = await res.text();
                const m = html.match(/id=["']txtSemester["'][^>]*value=["']([^"']+)["']/i) ||
                    html.match(/name=["']Semester["'][^>]*value=["']([^"']+)["']/i) ||
                    html.match(/value=["']([^"']+)["'][^>]*id=["']txtSemester["']/i);
                if (m && m[1]) {
                    const v = normSem(m[1].trim());
                    if (v) {
                        try { storage.set({ muj_current_semester: v, muj_sem_checked_at: Date.now() }); } catch (_) { }
                        return v;
                    }
                }
            }
        } catch (_) { }

        return null;
    }

    function renderSemesterPicker(body, isManual = false, currentSem = null, prevData = null) {
        body.textContent = '';
        const wrap = el('div', 'mf-sem-picker-wrap');
        wrap.style.cssText = 'text-align:center;padding:22px 16px;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:10px;margin:8px 0;';

        const titleText = isManual ? 'Select Semester' : 'Unable to auto-detect current semester';
        const title = el('div', '', titleText);
        title.style.cssText = 'font-weight:700;font-size:13px;color:#1e293b;margin-bottom:4px;';

        const subText = isManual ? 'Choose a semester to view internal marks:' : 'Select your semester to load internal marks:';
        const sub = el('div', '', subText);
        sub.style.cssText = 'font-size:12px;color:#64748b;margin-bottom:14px;';

        const pills = el('div', 'mf-sem-pills');
        pills.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:center;gap:6px;max-width:380px;margin:0 auto;';

        const sems = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];
        const normCurrent = normSem(currentSem);

        sems.forEach((s) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'mf-sem-pill-btn';
            btn.textContent = s;
            const isSelected = normCurrent && normCurrent === s;
            if (isSelected) {
                btn.style.cssText = 'border:1px solid #0f172a;background:#0f172a;color:#ffffff;font-weight:700;font-size:12px;padding:5px 12px;border-radius:6px;cursor:pointer;transition:all .15s ease;box-shadow:0 1px 2px rgba(0,0,0,0.08);';
                btn.title = `Currently viewing Semester ${s}`;
            } else {
                btn.style.cssText = 'border:1px solid #cbd5e1;background:#ffffff;color:#1e293b;font-weight:600;font-size:12px;padding:5px 12px;border-radius:6px;cursor:pointer;transition:all .15s ease;';
                btn.onmouseenter = () => { btn.style.borderColor = '#94a3b8'; btn.style.background = '#f8fafc'; };
                btn.onmouseleave = () => { btn.style.borderColor = '#cbd5e1'; btn.style.background = '#ffffff'; };
            }
            btn.onclick = async () => {
                btn.disabled = true;
                btn.textContent = '...';
                if (!isManual) {
                    try {
                        await new Promise((res) => storage.set({
                            muj_current_semester: s,
                            muj_sem_checked_at: Date.now()
                        }, res));
                    } catch (_) { }
                }
                marksData = null;
                body.textContent = '';
                body.appendChild(notice(`Loading Semester ${s} marks...`));
                await loadMarks(false, s);
            };
            pills.appendChild(btn);
        });

        wrap.append(title, sub, pills);

        if (isManual && prevData && prevData.rows && prevData.rows.length) {
            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.style.cssText = 'background:none;border:none;margin-top:14px;font-size:11.5px;color:#64748b;cursor:pointer;text-decoration:none;padding:2px 6px;transition:color .15s ease;display:inline-block;';
            cancelBtn.onmouseenter = () => { cancelBtn.style.color = '#0f172a'; };
            cancelBtn.onmouseleave = () => { cancelBtn.style.color = '#64748b'; };
            cancelBtn.onclick = () => {
                renderMarks(body, prevData);
            };
            wrap.appendChild(cancelBtn);
        }

        body.appendChild(wrap);
    }

    function renderEmptyMarksState(body, sem) {
        body.appendChild(notice(sem ? `No internal marks recorded for Semester ${sem} yet.` : 'No internal marks recorded for this semester yet.'));
    }

    function renderMarks(body, data) {
        body.textContent = '';
        if (!data || !data.rows || !data.rows.length) {
            renderEmptyMarksState(body, data && data.sem);
            renderMarksFooter(body, data);
            return;
        }

        const table = el('table', 'table table-striped table-bordered table-hover mf-table');
        const thead = document.createElement('thead');
        const trHead = document.createElement('tr');
        trHead.appendChild(el('th', 'mf-c', 'S. No.'));
        trHead.appendChild(el('th', '', 'Course Name'));

        const activeCols = [];
        data.headers.forEach((h, idx) => {
            const hasData = data.rows.some((r) => r.values && r.values[idx] && r.values[idx] !== '-' && r.values[idx] !== '');
            if (hasData || /total/i.test(h)) {
                activeCols.push({ title: h, idx });
                trHead.appendChild(el('th', 'mf-c', h));
            }
        });
        thead.appendChild(trHead);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        data.rows.forEach((r, i) => {
            const tr = document.createElement('tr');
            tr.appendChild(td(r.sNo || (i + 1), true));
            tr.appendChild(td(r.name || '', false));
            activeCols.forEach((col) => {
                const val = (r.values && r.values[col.idx]) ?? '-';
                const cell = td(val, true);
                if (/total/i.test(col.title) && val !== '-') {
                    cell.style.fontWeight = '700';
                    cell.style.color = '#0f172a';
                }
                tr.appendChild(cell);
            });
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        body.appendChild(table);

        renderMarksFooter(body, data);
        syncBaselineAlignment();
    }

    function fmtAge(ts) {
        if (!ts) return '';
        const diff = Math.floor((Date.now() - ts) / 1000);
        if (diff < 60) return 'Updated just now';
        if (diff < 3600) return `Updated ${Math.floor(diff / 60)}m ago`;
        if (diff < 86400) return `Updated ${Math.floor(diff / 3600)}h ago`;
        return `Updated ${Math.floor(diff / 86400)}d ago`;
    }

    async function syncCGPABaseline() {
        if (MF && typeof MF.syncBaseline === 'function') {
            return await MF.syncBaseline();
        }
        try {
            const res = await fetch('/Student/Academic/GetCGPAGPAForFaculty', {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest'
                },
                body: new URLSearchParams({ Enrollment: '', AcademicYear: '', ProgramCode: '' })
            });
            if (res.redirected && res.url && res.url.includes('/Account/Login')) {
                const err = new Error('SESSION_EXPIRED');
                err.isSessionExpired = true;
                throw err;
            }
            if (!res.ok) return null;
            const txt = await res.text();
            if (txt.includes('/Account/Login') || (txt.includes('<html') && txt.includes('Login'))) {
                const err = new Error('SESSION_EXPIRED');
                err.isSessionExpired = true;
                throw err;
            }
            const d = JSON.parse(txt);
            const it = d && d.IsSuccessfull === true && Array.isArray(d.InternalMarksList) ? d.InternalMarksList[0] : null;
            if (!it) return null;

            const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : NaN; };
            const cgpa = num(it.CGPA), credits = num(it.TotalCredits);
            if (!(cgpa >= 0 && cgpa <= 10) || !(credits > 0)) return null;

            let points = 0, sems = 0;
            const semGpas = {};
            ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'].forEach((r) => {
                const g = num(it['GPASemester' + r]), c = num(it['CreditsSemester' + r]);
                if (g > 0 && c > 0) {
                    sems++;
                    points += g * c;
                    semGpas[r] = { gpa: g, credits: c };
                }
            });
            if (points <= 0 || Math.abs(points / credits - cgpa) > 0.1) points = cgpa * credits;

            const b = { cgpa, credits, points, semsCompleted: sems, semGpas, lastSynced: Date.now() };
            try { storage.set({ muj_academic_baseline: b }); } catch (_) { }
            return b;
        } catch (_) { }
        return null;
    }

    function renderMarksFooter(body, data) {
        const footer = el('div', 'mf-marks-dashboard-footer');
        const left = el('div', 'mf-marks-cgpa-col');
        left.innerHTML = '<span style="color:#64748b;">Loading baseline...</span>';

        const updateLeft = (baseline) => {
            left.textContent = '';
            const targetSem = normSem(data && data.sem);
            const semGpas = baseline && baseline.semGpas;
            const semInfo = targetSem && semGpas && semGpas[targetSem];

            const isFinalized = Boolean(semInfo && typeof semInfo.gpa === 'number' && semInfo.gpa > 0);

            if (isFinalized) {
                const gpaVal = semInfo.gpa;
                const credsVal = semInfo.credits;
                const credsText = (!Number.isNaN(credsVal) && credsVal > 0) ? ` <span style="color:#64748b;font-size:11px;">(${credsVal} cr)</span>` : '';
                const gpaWrap = document.createElement('span');
                gpaWrap.innerHTML = `Semester ${targetSem} GPA: <strong>${gpaVal.toFixed(2)}</strong>${credsText}`;
                left.appendChild(gpaWrap);
                return; // Completed past semester: marks and GPA are permanently sealed, no sync button needed
            }

            const notReleasedSpan = document.createElement('span');
            notReleasedSpan.style.cssText = 'color:#64748b;font-size:12px;';
            notReleasedSpan.textContent = 'GPA not released';
            left.appendChild(notReleasedSpan);

            if (data && data.lastUpdated) {
                const sep = document.createElement('span');
                sep.style.cssText = 'color:#cbd5e1;margin:0 2px;';
                sep.textContent = '\u00B7';

                const timeSpan = document.createElement('span');
                timeSpan.style.cssText = 'color:#94a3b8;font-size:11px;font-weight:normal;';
                timeSpan.textContent = fmtAge(data.lastUpdated);

                left.append(sep, timeSpan);
            }

            const sep2 = document.createElement('span');
            sep2.style.cssText = 'color:#cbd5e1;margin:0 2px;';
            sep2.textContent = '\u00B7';

            const syncBtn = document.createElement('button');
            syncBtn.type = 'button';
            syncBtn.className = 'mf-footer-sync-btn';
            syncBtn.setAttribute('aria-label', 'Refresh marks and CGPA now');

            let cooldownTimer = null;
            const updateCooldown = () => {
                const now = Date.now();
                const lastSync = Math.max(
                    lastManualSyncTime,
                    (data && typeof data.lastUpdated === 'number') ? data.lastUpdated : 0
                );
                const elapsed = now - lastSync;
                if (elapsed < MANUAL_SYNC_COOLDOWN_MS) {
                    const remainingSec = Math.max(1, Math.ceil((MANUAL_SYNC_COOLDOWN_MS - elapsed) / 1000));
                    syncBtn.disabled = true;
                    syncBtn.title = `Please wait ${remainingSec}s before syncing again`;
                    syncBtn.innerHTML = '<span class="mf-sync-icon">&#8635;</span> Sync';

                    clearTimeout(cooldownTimer);
                    cooldownTimer = setTimeout(() => {
                        if (!syncBtn.isConnected) return;
                        updateCooldown();
                    }, 1000);
                } else {
                    clearTimeout(cooldownTimer);
                    syncBtn.disabled = false;
                    syncBtn.title = 'Refresh marks and CGPA now';
                    syncBtn.innerHTML = '<span class="mf-sync-icon">&#8635;</span> Sync';
                }
            };

            syncBtn.addEventListener('mouseenter', () => {
                const lastSync = Math.max(
                    lastManualSyncTime,
                    (data && typeof data.lastUpdated === 'number') ? data.lastUpdated : 0
                );
                const elapsed = Date.now() - lastSync;
                if (elapsed < MANUAL_SYNC_COOLDOWN_MS) {
                    const remainingSec = Math.max(1, Math.ceil((MANUAL_SYNC_COOLDOWN_MS - elapsed) / 1000));
                    syncBtn.title = `Please wait ${remainingSec}s before syncing again`;
                }
            });

            let sessionExpiredTimer = null;
            const showSessionExpired = () => {
                syncBtn.disabled = true;
                syncBtn.title = 'Session expired. Please log in again to sync.';
                syncBtn.style.color = '#ef4444';
                syncBtn.innerHTML = '<span style="font-size:11px;">⚠️ Session Expired</span>';
                clearTimeout(cooldownTimer);
                clearTimeout(sessionExpiredTimer);
                sessionExpiredTimer = setTimeout(() => {
                    if (!syncBtn.isConnected) return;
                    syncBtn.style.color = '';
                    updateCooldown();
                }, 3500);
            };

            syncBtn.onclick = (e) => {
                e.preventDefault();
                const lastSync = Math.max(
                    lastManualSyncTime,
                    (data && typeof data.lastUpdated === 'number') ? data.lastUpdated : 0
                );
                if (Date.now() - lastSync < MANUAL_SYNC_COOLDOWN_MS) return;

                syncBtn.disabled = true;
                syncBtn.title = 'Syncing marks and CGPA...';
                syncBtn.innerHTML = '<span class="mf-sync-icon mf-spinning">&#8635;</span> Syncing...';

                Promise.allSettled([
                    loadMarks(true),
                    syncCGPABaseline()
                ]).then((results) => {
                    const isExp = results.some((r) => r.status === 'rejected' && r.reason && r.reason.isSessionExpired);
                    if (isExp) {
                        showSessionExpired();
                        return;
                    }
                    lastManualSyncTime = Date.now();
                    const newBase = results[1] && results[1].status === 'fulfilled' ? results[1].value : null;
                    if (newBase) updateLeft(newBase);
                    else updateCooldown();
                }).catch((err) => {
                    if (err && err.isSessionExpired) {
                        showSessionExpired();
                        return;
                    }
                    lastManualSyncTime = Date.now();
                    updateCooldown();
                });
            };

            updateCooldown();
            left.append(sep2, syncBtn);
        };

        try {
            storage.get(['muj_academic_baseline'], async (d) => {
                let baseline = d && d.muj_academic_baseline;
                const cgpaVal = baseline ? (typeof baseline.cgpa === 'number' ? baseline.cgpa : parseFloat(baseline.cgpa)) : NaN;
                if (Number.isNaN(cgpaVal) || cgpaVal <= 0 || !baseline.semGpas) {
                    baseline = await syncCGPABaseline();
                }
                updateLeft(baseline);
            });
        } catch (_) {
            updateLeft(null);
        }

        const right = el('div', 'mf-marks-sem-col');
        const semBtn = document.createElement('a');
        semBtn.className = 'mf-marks-pred-link';
        const setSem = (s) => {
            if (!s) {
                semBtn.href = '/Student/Academic/InternalMarkForStudent';
                semBtn.textContent = 'Open Internal Marks \u2192';
                semBtn.title = 'Open Internal Marks page';
                return;
            }
            semBtn.href = `/Student/Academic/InternalMarkForStudent#sem=${s}`;
            semBtn.textContent = `Semester ${s} \u2192`;
            semBtn.title = `Open Semester ${s} Internal Marks directly`;
        };
        const initialSem = normSem(data && data.sem);
        if (initialSem) {
            setSem(initialSem);
        } else {
            detectCurrentSemester().then((c) => {
                const s = normSem(c);
                if (s) setSem(s);
            }).catch(() => { });
        }

        const changeLink = document.createElement('button');
        changeLink.type = 'button';
        changeLink.textContent = 'change';
        changeLink.title = 'Switch semester view';
        changeLink.style.cssText = 'background:none;border:none;padding:0;margin:0;font-size:11px;color:#94a3b8;cursor:pointer;text-decoration:none;line-height:1;transition:color .15s ease;';
        changeLink.onmouseenter = () => { changeLink.style.color = '#2563eb'; };
        changeLink.onmouseleave = () => { changeLink.style.color = '#94a3b8'; };
        changeLink.onclick = (e) => {
            e.preventDefault();
            renderSemesterPicker(body, true, initialSem, data);
        };

        const sep = document.createElement('span');
        sep.style.cssText = 'color:#cbd5e1;margin:0 5px;';
        sep.textContent = '\u00B7';

        right.append(changeLink, sep, semBtn);

        footer.append(left, right);
        body.appendChild(footer);
    }

    async function fetchMarksDirect(sem, signal) {
        const d = await postForm('/Student/Academic/GetInternalMarkForFaculty', {
            Enrollment: '',
            Semester: sem
        }, signal);

        if (!d || d.IsSuccessfull !== true || !Array.isArray(d.InternalMarksList)) {
            throw new Error('Bad payload or empty list');
        }

        const clean = (v) => (v == null || v === '' || v === 'null') ? '-' : String(v).trim();
        const rows = d.InternalMarksList.map((it, i) => {
            const vals = [it.MTE1, it.MTE2, it.CWS, it.RESESSION, it.PRS].map(clean);
            let total = 0;
            let hasAny = false;
            vals.forEach((v) => {
                const n = parseFloat(v);
                if (!isNaN(n)) { total += n; hasAny = true; }
            });
            vals.push(hasAny ? total.toFixed(2).replace(/\.00$/, '') : '-');
            return {
                sNo: String(i + 1),
                name: it.CourseID || it.CourseCode || `Course ${i + 1}`,
                values: vals
            };
        });

        return {
            sem,
            headers: ['MTE 1', 'MTE 2', 'CWS', 'RE-SESSION', 'PRS', 'Total'],
            rows,
            lastUpdated: Date.now()
        };
    }

    async function fetchMarksFromPage(semVal, signal) {
        const getRes = await fetch('/Student/Academic/InternalMarkForStudent', {
            credentials: 'same-origin',
            signal
        });
        if (getRes.redirected && getRes.url && getRes.url.includes('/Account/Login')) {
            const err = new Error('SESSION_EXPIRED');
            err.isSessionExpired = true;
            throw err;
        }
        if (!getRes.ok) throw new Error('HTTP ' + getRes.status);
        const html = await getRes.text();
        if (html.includes('/Account/Login') && (html.includes('<html') || html.includes('Login'))) {
            const err = new Error('SESSION_EXPIRED');
            err.isSessionExpired = true;
            throw err;
        }
        const parser = new DOMParser();
        let doc = parser.parseFromString(html, 'text/html');

        let table = doc.getElementById('kt_ViewTable');
        const ddl = doc.getElementById('ddlSemester');

        if ((!table || !table.rows || table.rows.length < 2) && ddl) {
            const targetRoman = (ROMAN_MAP[semVal.toUpperCase()] || semVal).toUpperCase();
            let actualVal = semVal;
            for (let i = 1; i < ddl.options.length; i++) {
                const opt = ddl.options[i];
                const txt = opt.text.trim().toUpperCase();
                const val = opt.value.trim().toUpperCase();
                if (txt === targetRoman || val === targetRoman || (ROMAN_MAP[val] && ROMAN_MAP[val] === targetRoman)) {
                    actualVal = opt.value;
                    break;
                }
            }

            const postRes = await fetch('/Student/Academic/InternalMarkForStudent', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    Semester: actualVal,
                    ddlSemester: actualVal,
                    btnSearch: 'Find'
                }).toString(),
                signal
            });
            if (postRes.ok) {
                const postHtml = await postRes.text();
                doc = parser.parseFromString(postHtml, 'text/html');
                table = doc.getElementById('kt_ViewTable');
            }
        }

        if (!table || !table.rows || table.rows.length < 2) {
            throw new Error('No internal marks table returned from page');
        }

        const head = table.rows[0];
        const rawHeaders = Array.from(head.cells).map((c) => c.textContent.trim());
        const headers = rawHeaders.slice(2).filter((h) => !/^(Credits|Grade)$/i.test(h));

        const rows = [];
        for (let i = 1; i < table.rows.length; i++) {
            const r = table.rows[i];
            if (r.cells.length < 3 || r.classList.contains('grand-total-row')) continue;
            const sNo = r.cells[0] ? r.cells[0].textContent.trim() : '';
            const name = r.cells[1] ? r.cells[1].textContent.trim() : '';
            const values = [];
            for (let j = 2; j < r.cells.length; j++) {
                values.push(r.cells[j] ? r.cells[j].textContent.trim() : '-');
            }
            rows.push({ sNo, name, values });
        }

        if (!rows.length) throw new Error('No rows in table');

        return {
            sem: semVal,
            headers,
            rows,
            lastUpdated: Date.now()
        };
    }

    function loadMarks(force = false, targetSem = null) {
        if (!summaryBody || !summaryBody.isConnected) return Promise.resolve();
        if (activeSummaryTab !== 'marks') return Promise.resolve();

        const reqSem = targetSem ? normSem(targetSem) : null;
        if (!force && !reqSem && marksData && marksData.rows && marksData.rows.length) {
            renderMarks(summaryBody, marksData);
            return Promise.resolve();
        }
        if (!force && reqSem && marksData && normSem(marksData.sem) === reqSem && marksData.rows && marksData.rows.length) {
            renderMarks(summaryBody, marksData);
            return Promise.resolve();
        }

        if (!force && (!marksData || !marksData.rows || (reqSem && normSem(marksData.sem) !== reqSem))) {
            summaryBody.textContent = '';
            summaryBody.appendChild(notice(reqSem ? `Loading Semester ${reqSem} marks...` : 'Loading internal marks...'));
        }

        return new Promise(async (resolve, reject) => {
            if (MF && typeof MF.ensureStudentSession === 'function') {
                const sess = await MF.ensureStudentSession();
                if (sess && sess.changed) {
                    marksData = null;
                    lastManualSyncTime = 0;
                }
            }

            storage.get(['muj_internal_marks_cache', 'muj_marks_cache', 'muj_current_semester'], async (cached) => {
                let currentSem = reqSem || (cached && cached.muj_current_semester);
                if (!currentSem && typeof detectCurrentSemester === 'function') {
                    currentSem = await detectCurrentSemester();
                }
                const cleanSem = currentSem ? (ROMAN_MAP[currentSem.toUpperCase()] || currentSem).toUpperCase() : null;

                let bestCached = null;
                if (cleanSem && cached && cached.muj_marks_cache && cached.muj_marks_cache[cleanSem]) {
                    bestCached = cached.muj_marks_cache[cleanSem];
                } else if (cached && cached.muj_internal_marks_cache) {
                    const intSem = (ROMAN_MAP[String(cached.muj_internal_marks_cache.sem || '').toUpperCase()] || '').toUpperCase();
                    if (!cleanSem || !intSem || intSem === cleanSem) {
                        bestCached = cached.muj_internal_marks_cache;
                    }
                }

                if (!force && bestCached && bestCached.rows && bestCached.rows.length) {
                    marksData = bestCached;
                    if (activeSummaryTab === 'marks') {
                        renderMarks(summaryBody, marksData);
                    }
                    resolve();
                    return;
                }

                if (marksAbortCtl) marksAbortCtl.abort();
                const ctl = marksAbortCtl = new AbortController();

                try {
                    const currentSem = cleanSem || (typeof detectCurrentSemester === 'function' ? await detectCurrentSemester() : null);
                    const targetRoman = currentSem ? (ROMAN_MAP[currentSem.toUpperCase()] || currentSem).toUpperCase() : null;
                    if (!targetRoman) {
                        if (!marksData && activeSummaryTab === 'marks') {
                            renderSemesterPicker(summaryBody, false);
                        }
                        resolve();
                        return;
                    }
                    let result = null;

                    // 1) Try calling the direct JSON endpoint with Roman numeral
                    try {
                        result = await fetchMarksDirect(targetRoman, ctl.signal);
                    } catch (_) {
                        // 2) Fallback to integer (e.g. '5') if Roman failed
                        const semNum = Object.keys(ROMAN_MAP).find((k) => ROMAN_MAP[k] === targetRoman && /^\d+$/.test(k));
                        if (semNum) {
                            try { result = await fetchMarksDirect(semNum, ctl.signal); } catch (_) { }
                        }
                    }

                    // 3) Fallback to page POST if direct API didn't return rows
                    if (!result || !result.rows || !result.rows.length) {
                        try {
                            result = await fetchMarksFromPage(targetRoman, ctl.signal);
                        } catch (_) { }
                    }

                    if (ctl.signal.aborted || !summaryBody.isConnected) { resolve(); return; }

                    if (result && result.rows && result.rows.length) {
                        marksData = result;
                        const cacheBySem = (cached && cached.muj_marks_cache) || {};
                        cacheBySem[targetRoman] = result;
                        try {
                            storage.set({
                                muj_internal_marks_cache: result,
                                muj_marks_cache: cacheBySem
                            });
                        } catch (_) { }
                        if (activeSummaryTab === 'marks') {
                            renderMarks(summaryBody, marksData);
                        }
                    } else if (!marksData && activeSummaryTab === 'marks') {
                        summaryBody.textContent = '';
                        renderEmptyMarksState(summaryBody, targetRoman);
                        renderMarksFooter(summaryBody, { sem: targetRoman, lastUpdated: Date.now() });
                    }
                    resolve();
                } catch (err) {
                    if (ctl.signal.aborted || !summaryBody.isConnected) { resolve(); return; }
                    if (err && err.isSessionExpired) {
                        reject(err);
                        return;
                    }
                    if (!marksData && activeSummaryTab === 'marks') {
                        summaryBody.textContent = '';
                        renderEmptyMarksState(summaryBody, targetRoman);
                        renderMarksFooter(summaryBody, { sem: targetRoman, lastUpdated: Date.now() });
                    }
                    resolve();
                }
            });
        });
    }

    function findEventsHeader(col9) {
        return Array.from((col9 || document).querySelectorAll('h6'))
            .find((h) => h.textContent.includes('List of Events'));
    }

    function findNativeNotice(col9) {
        if (!col9) return null;
        const examTbl = findExamTable(col9);
        const examTblEl = examTbl ? examTbl.tbl : null;
        const ev = document.getElementById('kt_ViewEvent');
        const evHeader = findEventsHeader(col9);

        // 1) Any alert/warning/notice container anywhere in col9 (outside extension UI)
        const alerts = Array.from(col9.querySelectorAll('.alert, [class*="alert-"], .kt-alert, .notice, [class*="notice"], .warning')).filter((el) => {
            if (el.closest && el.closest('#mujfish-summary-container, #mujfish-timetable, #mujfish-exam-schedule, #mf-bar')) return false;
            if (/class\s*coordinator/i.test(el.textContent || '')) return false;
            return (el.textContent || '').trim().length > 0;
        });
        if (alerts.length) return alerts[0];

        // 2) Any other non-extension child of col9 that is not the exam table, events list, or class coordinator info
        const children = Array.from(col9.children);
        for (const child of children) {
            if (!child || child.nodeType !== 1) continue;
            if (child.id === 'mujfish-summary-container' || child.id === 'mf-bar') continue;
            if (child.className && /(?:^|\s)mf-/.test(child.className)) continue;
            if (examTblEl && (child === examTblEl || child.contains(examTblEl))) continue;
            if (ev && (child === ev || child.contains(ev))) continue;
            if (evHeader && (child === evHeader || child.contains(evHeader))) continue;
            if (!child.offsetHeight && !child.offsetWidth) continue;
            const txt = (child.textContent || '').trim();
            if (!txt.length) continue;
            if (/class\s*coordinator/i.test(txt)) continue;
            return child;
        }
        return null;
    }

    function updateNoticeLink() {
        const { col9 } = getColumns();
        const container = document.getElementById('mujfish-summary-container');
        if (!container || !col9) return;
        const leftWrap = container.querySelector('.mf-summary-head-left');
        if (!leftWrap) return;

        const noticeEl = findNativeNotice(col9);
        let existingLink = container.querySelector('.mf-notice-jump-link');

        if (noticeEl) {
            if (!existingLink) {
                existingLink = el('a', 'mf-notice-jump-link');
                existingLink.title = 'Scroll to official portal notice';
                existingLink.innerHTML = '<span>Official notice below</span> <span style="font-size:10px;">&darr;</span>';
                existingLink.onclick = (e) => {
                    e.preventDefault();
                    noticeEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
                };
                leftWrap.appendChild(existingLink);
            }
        } else if (existingLink) {
            existingLink.remove();
        }
    }

    let noticeObs = null;
    function setupNoticeObserver(col9) {
        if (!col9) return;
        if (noticeObs) noticeObs.disconnect();
        noticeObs = new MutationObserver((mutations) => {
            const hasExternal = mutations.some((m) => {
                const t = m.target;
                if (!t) return false;
                if (t.closest && t.closest('#mujfish-summary-container')) return false;
                if (t.id && (t.id.startsWith('mujfish-') || t.id === 'mf-bar')) return false;
                return true;
            });
            if (hasExternal) {
                updateNoticeLink();
                syncBaselineAlignment();
            }
        });
        noticeObs.observe(col9, { childList: true, subtree: true });
    }

    function mountSummary() {
        const { col9 } = getColumns();
        if (!col9) return null;

        let box = document.getElementById('mujfish-summary-container');
        if (box) {
            updateNoticeLink();
            return box.querySelector('#mujfish-summary-body');
        }

        box = el('div');
        box.id = 'mujfish-summary-container';

        const head = el('div', 'mf-summary-head');
        const leftWrap = el('div', 'mf-summary-head-left');

        const tabsWrap = el('div', 'mf-summary-tabs');

        const tabAtt = el('button', 'mf-tab-btn active', 'Attendance');
        tabAtt.type = 'button';
        tabAtt.id = 'mf-tab-att';
        tabAtt.setAttribute('aria-label', 'Show Attendance Summary');

        const tabMarks = el('button', 'mf-tab-btn', 'Internal Marks');
        tabMarks.type = 'button';
        tabMarks.id = 'mf-tab-marks';
        tabMarks.setAttribute('aria-label', 'Show Current Semester Internal Marks');

        tabsWrap.append(tabAtt, tabMarks);
        leftWrap.appendChild(tabsWrap);

        const actionsWrap = el('div', 'mf-summary-actions');

        const titleLink = el('a', 'mf-head-title', '');
        titleLink.id = 'mf-summary-link';
        titleLink.href = '/Student/Academic/AttendanceSummaryForStudent';
        titleLink.onclick = () => {
            try { sessionStorage.removeItem('muj_auto_open_sem'); } catch (_) { }
        };
        const linkText = el('span', 'mf-head-title-text', 'Attendance ');
        titleLink.append(linkText, icon('la-external-link'));

        actionsWrap.append(titleLink);
        head.append(leftWrap, actionsWrap);
        box.appendChild(head);
        box.appendChild(document.createElement('hr'));

        const body = el('div');
        body.id = 'mujfish-summary-body';
        box.appendChild(body);

        tabAtt.addEventListener('click', () => {
            userSelectedTab = true;
            switchSummaryTab('attendance');
        });

        tabMarks.addEventListener('click', () => {
            userSelectedTab = true;
            switchSummaryTab('marks');
        });

        col9.insertBefore(box, col9.firstChild);

        updateNoticeLink();
        setupNoticeObserver(col9);

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
        if (ev && ev.querySelectorAll && ev.querySelectorAll('tr').length <= 1) ev.classList.add('mf-hidden');
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

    let ratchetObs = null;
    function setupRatchetObserver(col9, leftCol) {
        if (!col9 && !leftCol) return;
        if (ratchetObs) ratchetObs.disconnect();

        ratchetObs = new MutationObserver((mutations) => {
            const hasExternal = mutations.some((m) => {
                const t = m.target;
                if (!t) return false;
                if (t.id && (t.id.startsWith('mujfish-') || t.id === 'mf-bar' || t.id === 'mf-next-exam')) return false;
                if (t.className && /(?:^|\s)mf-/.test(t.className)) return false;
                return true;
            });
            if (!hasExternal) return;

            if (col9) {
                const s = col9.querySelector('#mujfish-summary-container');
                if (s && col9.firstChild !== s) col9.insertBefore(s, col9.firstChild);
            }
            if (leftCol) {
                const tt = leftCol.querySelector('#mujfish-timetable');
                if (tt && leftCol.firstChild !== tt) leftCol.insertBefore(tt, leftCol.firstChild);
            }
            syncBaselineAlignment();
        });

        const cfg = { childList: true, subtree: true };
        if (col9) ratchetObs.observe(col9, cfg);
        if (leftCol) ratchetObs.observe(leftCol, cfg);

        // Disconnect after 3.5s once late portal AJAX settles
        setTimeout(() => {
            if (ratchetObs) {
                ratchetObs.disconnect();
                ratchetObs = null;
            }
        }, 3500);
    }

    // ---------- Lifecycle ----------
    async function init() {
        try {
            if (MF && typeof MF.ensureStudentSession === 'function') {
                const sess = await MF.ensureStudentSession();
                if (sess && sess.changed) {
                    marksData = null;
                    lastManualSyncTime = 0;
                }
            }
            const { col9, leftCol } = getColumns();
            const examMode = isExamMode(col9);

            if (examMode) {
                // Clear any legacy collapse state
                try {
                    sessionStorage.removeItem('mujfish_summary_collapsed');
                    sessionStorage.removeItem('mujfish_exams_collapsed');
                } catch (_) { }

                // 1) Left column: Scrollable Exam Schedule Cards at top of leftCol
                mountExamSchedule(col9);
                setupExamObserver(col9);

                // 2) Right column: Attendance & Internal Marks at top of col9
                loadSummary();
                watchTarget();
            } else {
                // Classic Mode (normal semester): Timetable on left, Attendance/Marks on right
                mountTimetable();
                loadSummary();
                watchTarget();
                setupRatchetObserver(col9, leftCol);

                // Re-mount if the portal removes our widgets; watch direct children only.
                if (remountObs) remountObs.disconnect();
                let remounts = 0;
                remountObs = new MutationObserver(() => {
                    let needed = false;
                    if (leftCol && !leftCol.querySelector('#mujfish-timetable')) {
                        needed = true;
                        idle(() => { try { mountTimetable(); } catch (e) { } });
                    }
                    if (col9 && !col9.querySelector('#mujfish-summary-container')) {
                        needed = true;
                        idle(() => { try { mountSummary(); } catch (e) { } });
                    }
                    if (needed && ++remounts > MAX_REMOUNTS) {
                        if (remountObs) remountObs.disconnect();
                        remountObs = null;
                    }
                });
                if (leftCol) remountObs.observe(leftCol, { childList: true });
                if (col9) remountObs.observe(col9, { childList: true });
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
        if (examObs) {
            examObs.disconnect();
            examObs = null;
        }
        if (ratchetObs) {
            ratchetObs.disconnect();
            ratchetObs = null;
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
        if (resizeHandler) {
            window.removeEventListener('resize', resizeHandler);
            resizeHandler = null;
        }
        if (baselineResizeObs) {
            baselineResizeObs.disconnect();
            baselineResizeObs = null;
        }
        if (noticeObs) {
            noticeObs.disconnect();
            noticeObs = null;
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