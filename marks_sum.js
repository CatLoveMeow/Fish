/* MUJ FISH - Internal Marks page: Total column, Grades, GPA predictor
 * Local-only. The only network call is ONE small background POST per semester
 * (at most every 5 min, with exponential backoff on failure). It never blocks
 * SLCM's own rendering, and every failure path leaves the native table untouched.
 */
(() => {
    'use strict';

    if (window.__mujfishMarksPage) return;   // guard against double injection
    window.__mujfishMarksPage = true;

    // ---------- extension API ----------
    const ext = typeof chrome !== 'undefined' ? chrome : null;   // Firefox exposes chrome.* too
    const store = ext && ext.storage && ext.storage.local;
    if (!store) return;

    const alive = () => { try { return !!ext.runtime.id; } catch (_) { return false; } };

    function showToast(msg, type = 'warn') {
        const isSuccess = type === 'success';
        const TOAST_ID = 'st-toast';
        let toast = document.getElementById(TOAST_ID);

        if (!toast) {
            toast = document.createElement('div');
            toast.id = TOAST_ID;
            toast.style.cssText = [
                'position:fixed',
                'bottom:24px',
                'right:24px',
                'border-radius:50px',
                'padding:10px 18px',
                'font-weight:600',
                'font-size:13px',
                'z-index:1030',
                'opacity:0',
                'pointer-events:none',
                'display:flex',
                'align-items:center',
                'gap:10px',
                'max-width:min(420px,calc(100vw - 32px))'
            ].join(';');

            const icon = document.createElement('span');
            icon.className = 'st-toast-icon';
            icon.setAttribute('aria-hidden', 'true');
            icon.style.cssText = [
                'display:flex',
                'align-items:center',
                'justify-content:center',
                'width:22px',
                'height:22px',
                'flex:0 0 22px',
                'border-radius:50%',
                'font-size:12px',
                'font-weight:bold'
            ].join(';');

            const message = document.createElement('span');
            message.className = 'st-toast-message';
            message.style.cssText = 'overflow-wrap:anywhere;';

            toast.append(icon, message);
            document.body.appendChild(toast);
        }

        toast.setAttribute('role', isSuccess ? 'status' : 'alert');
        toast.setAttribute('aria-live', isSuccess ? 'polite' : 'assertive');

        if (isSuccess) {
            toast.style.background = '#ffffff';
            toast.style.border = '1px solid #bbf7d0';
            toast.style.color = '#14532d';
            toast.style.boxShadow = '0 10px 25px -5px rgba(16,185,129,.18)';
            const icon = toast.querySelector('.st-toast-icon');
            if (icon) {
                icon.textContent = '\u2713'; // checkmark
                icon.style.background = '#dcfce7';
                icon.style.color = '#16a34a';
            }
        } else {
            toast.style.background = '#ffffff';
            toast.style.border = '1px solid #fecaca';
            toast.style.color = '#991b1b';
            toast.style.boxShadow = '0 10px 25px -5px rgba(220,38,38,.18)';
            const icon = toast.querySelector('.st-toast-icon');
            if (icon) {
                icon.textContent = '!';
                icon.style.background = '#fee2e2';
                icon.style.color = '#dc2626';
            }
        }

        // Cancel any previous hide operation before showing a newer message.
        if (toast._hideTimer) {
            clearTimeout(toast._hideTimer);
            toast._hideTimer = null;
        }
        if (toast._anim) {
            try { toast._anim.cancel(); } catch (_) { }
            toast._anim = null;
        }

        // Treat all messages as text. Never parse a message as HTML.
        const messageEl = toast.querySelector('.st-toast-message');
        if (messageEl) messageEl.textContent = String(msg == null ? '' : msg);

        let reduceMotion = false;
        try {
            reduceMotion = !!(
                window.matchMedia &&
                window.matchMedia('(prefers-reduced-motion: reduce)').matches
            );
        } catch (_) { }

        const canAnimate = !reduceMotion && typeof toast.animate === 'function';

        if (canAnimate) {
            toast._anim = toast.animate([
                { opacity: 0, transform: 'translateY(18px)' },
                { opacity: 1, transform: 'translateY(0)' }
            ], {
                duration: 180,
                easing: 'ease-out',
                fill: 'forwards'
            });
        } else {
            toast.style.opacity = '1';
            toast.style.transform = 'none';
        }

        toast._hideTimer = setTimeout(() => {
            if (!toast.isConnected) return;

            if (toast._anim) {
                try { toast._anim.cancel(); } catch (_) { }
                toast._anim = null;
            }

            if (canAnimate && typeof toast.animate === 'function') {
                toast._anim = toast.animate([
                    { opacity: 1, transform: 'translateY(0)' },
                    { opacity: 0, transform: 'translateY(10px)' }
                ], {
                    duration: 160,
                    easing: 'ease-in',
                    fill: 'forwards'
                });
            } else {
                toast.style.opacity = '0';
                toast.style.transform = 'none';
            }

            toast._hideTimer = null;
        }, 3500);
    }

    // Resolve null on ANY failure, so callers never mistake "failed" for "empty".
    const sGet = (keys) => new Promise((res) => {
        try { store.get(keys, (d) => res(ext.runtime.lastError ? null : (d || {}))); }
        catch (_) { res(null); }
    });
    const sSet = (obj) => new Promise((res) => {
        try { store.set(obj, () => res(!ext.runtime.lastError)); }
        catch (_) { res(false); }
    });

    // Read-modify-write per key, serialized. Never writes blind, never clobbers
    // data written by other tabs or by the Grades-page parser.
    let chain = Promise.resolve();
    function patch(key, setObj, delKeys) {
        chain = chain.then(async () => {
            if (!alive()) return;
            const d = await sGet(key);
            if (!d) return;                                   // read failed: don't write
            const cur = d[key] && typeof d[key] === 'object' ? d[key] : {};
            const next = Object.assign({}, cur, setObj);
            (delKeys || []).forEach((k) => { delete next[k]; });
            await sSet({ [key]: next });
        }).catch(() => { });
        return chain;
    }

    // ---------- constants ----------
    const KEYS = ['subjectGrades', 'courseCredits', 'predictedGrades', 'predEnabled', 'noGrades', 'customSubjects', 'muj_academic_baseline'];
    const POINTS = { 'A+': 10, 'A': 9, 'B': 8, 'C': 7, 'D': 6, 'E': 5, 'F': 0, 'S': 10 };
    const CREDIT_OPTS = ['-', '4', '3', '2', '1', '0'];
    const GRADE_OPTS = ['-', '10', '9', '8', '7', '6', '5', '4', '3', '2', '1', '0',
        'A+', 'A', 'B', 'C', 'D', 'E', 'F', 'S'];
    const INJECTED = '.st-injected-total, .st-injected-credits, .st-injected-grade, ' +
        '.st-total-cell, .st-credits-cell, .st-grade-cell';

    const FRESH_MS = 5 * 60 * 1000;        // don't re-ask the server for a semester more often than this
    const FETCH_TIMEOUT_MS = 20000;
    const BASE_BACKOFF_MS = 60 * 1000;     // 1m, 2m, 4m ... capped
    const MAX_BACKOFF_MS = 10 * 60 * 1000;

    // ---------- state (in-memory copy of storage => synchronous render, no blink) ----------
    const mem = { grades: {}, credits: {}, predicted: {}, predEnabled: false, noGrades: {}, customSubjects: {}, baseline: null };
    let ready = false;
    let stopped = false;
    let lastSem = '';
    let renderTimes = [];
    const settled = new Set();
    const inFlight = new Set();
    const lastFail = {};
    const fails = {};
    const lastOk = {};                     // in-memory fallback if sessionStorage is blocked

    (async () => {
        if (window.MujFish && typeof window.MujFish.ensureStudentSession === 'function') {
            try { await window.MujFish.ensureStudentSession(); } catch (_) { }
        }
        sGet(KEYS).then((d) => {
            if (d) {
                mem.grades = d.subjectGrades || {};
                mem.credits = d.courseCredits || {};
                mem.predicted = d.predictedGrades || {};
                mem.predEnabled = !!d.predEnabled;
                mem.noGrades = d.noGrades || {};
                mem.customSubjects = d.customSubjects || {};
                mem.baseline = d.muj_academic_baseline || null;
            }
            if (!mem.baseline) syncCGPABaseline();
            ready = true;
            run();
        });
    })();

    // Merge (never replace) grades saved by the Grades-page parser, and sync baseline changes.
    try {
        ext.storage.onChanged.addListener((ch, area) => {
            if (area === 'local') {
                if (ch.subjectGrades && ch.subjectGrades.newValue && typeof ch.subjectGrades.newValue === 'object') {
                    Object.assign(mem.grades, ch.subjectGrades.newValue);
                }
                if (ch.muj_academic_baseline) {
                    mem.baseline = ch.muj_academic_baseline.newValue || null;
                    const table = getTable();
                    if (table && mem.predEnabled) updateGPA(table);
                }
            }
        });
    } catch (_) { /* ignore */ }

    // ---------- helpers (textContent, not innerText: no forced layout) ----------
    const getTable = () => document.getElementById('kt_ViewTable');

    let isSyncingBaseline = false;
    async function syncCGPABaseline(force = false) {
        if (isSyncingBaseline) return;
        if (!force && mem.baseline && (Date.now() - (mem.baseline.lastSynced || 0) < 24 * 3600 * 1000)) {
            return;
        }
        if (window.MujFish && typeof window.MujFish.syncBaseline === 'function') {
            isSyncingBaseline = true;
            try {
                const b = await window.MujFish.syncBaseline();
                if (b) {
                    mem.baseline = b;
                    const t = getTable();
                    if (t && mem.predEnabled) updateGPA(t);
                }
            } finally {
                isSyncingBaseline = false;
            }
            return;
        }
    }

    const dataRows = (t) =>
        Array.from(t.rows).slice(1).filter((r) =>
            r.id !== 'st-pred-gpa-row' &&
            !r.classList.contains('grand-total-row') &&
            (!r.classList.contains('st-custom-row') || mem.predEnabled) &&
            r.cells.length >= 3 &&
            !(r.parentNode && r.parentNode.tagName === 'THEAD'));

    // Course name can itself contain brackets, e.g. "Physics (Lab) (PHY1101)".
    // Take the LAST bracket group, preferring one that contains a digit.
    function codeOf(row) {
        if (row.dataset.stCode) return row.dataset.stCode;
        const cell = row.cells[1];
        if (!cell) return null;
        const hits = cell.textContent.match(/\(([^()]+)\)/g);
        if (!hits) return null;
        let pick = hits[hits.length - 1];
        for (let i = hits.length - 1; i >= 0; i--) {
            if (/\d/.test(hits[i])) { pick = hits[i]; break; }
        }
        return pick.slice(1, -1).trim() || null;
    }

    const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

    function parseAttendanceCourse(rawId) {
        if (!rawId) return null;
        const str = String(rawId).trim();
        if (!str) return null;

        let code = '';
        let name = '';

        if (str.includes(':')) {
            const parts = str.split(':');
            code = parts[0].trim();
            name = parts.slice(1).join(':').trim();
        } else if (/\(([^()]+)\)/.test(str)) {
            const m = str.match(/\(([^()]+)\)/);
            code = m[1].trim();
            name = str.replace(/\(([^()]+)\)/, '').trim();
        } else if (str.includes(' - ')) {
            const parts = str.split(' - ');
            code = parts[0].trim();
            name = parts.slice(1).join(' - ').trim();
        } else {
            const m = str.match(/^([A-Za-z]{2,5}\d{3,5}[A-Za-z]?)\s+(.*)$/);
            if (m) {
                code = m[1].trim();
                name = m[2].trim();
            } else {
                code = str;
                name = str;
            }
        }

        const cleanMatch = code.match(/[A-Za-z0-9\-\/]+/);
        const cleanCode = (cleanMatch ? cleanMatch[0] : code).toUpperCase();
        if (!cleanCode) return null;

        return {
            raw: str,
            code: cleanCode,
            name: name || cleanCode,
            display: name && name.toUpperCase() !== cleanCode ? `${name} (${cleanCode})` : cleanCode
        };
    }

    let attCoursesCache = null;
    let attFetchPromise = null;

    function fetchAttendanceCourses() {
        if (attCoursesCache) return Promise.resolve(attCoursesCache);
        if (attFetchPromise) return attFetchPromise;

        try {
            const raw = sessionStorage.getItem('mujfish_att_courses');
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed) && parsed.length) {
                    const list = [];
                    const seen = new Set();
                    parsed.forEach((it) => {
                        const item = typeof it === 'string' ? parseAttendanceCourse(it) : it;
                        if (item && item.code && !seen.has(item.code)) {
                            seen.add(item.code);
                            list.push(item);
                        }
                    });
                    if (list.length) {
                        attCoursesCache = list;
                        return Promise.resolve(list);
                    }
                }
            }
        } catch (_) { }

        const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctl ? setTimeout(() => ctl.abort(), 10000) : 0;

        attFetchPromise = fetch('/Student/Academic/GetAttendanceSummaryList', {
            method: 'POST',
            credentials: 'same-origin',
            signal: ctl ? ctl.signal : undefined,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: new URLSearchParams({ StudentCode: '' }).toString()
        })
            .then((r) => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
            .then((d) => {
                if (!d || !d.IsSuccessfull || !Array.isArray(d.AttendanceSummaryList)) return [];
                const list = [];
                const seen = new Set();
                d.AttendanceSummaryList.forEach((it) => {
                    const parsed = parseAttendanceCourse(it && it.CourseID);
                    if (parsed && parsed.code && !seen.has(parsed.code)) {
                        seen.add(parsed.code);
                        list.push(parsed);
                    }
                });
                attCoursesCache = list;
                try { sessionStorage.setItem('mujfish_att_courses', JSON.stringify(list)); } catch (_) { }
                return list;
            })
            .catch(() => [])
            .finally(() => {
                clearTimeout(timer);
                attFetchPromise = null;
            });

        return attFetchPromise;
    }

    const isReal = (g) => g != null && String(g).trim() !== '' && String(g).trim() !== '-';

    const hasNativeGrade = (head) =>
        Array.from(head.cells).some((c) =>
            c.textContent.trim().toUpperCase() === 'GRADE' && !c.classList.contains('st-injected-grade'));

    const FKEY = 'mujfish_grades_fetched_';
    function verified(sem) {
        let t = 0;
        try { t = +sessionStorage.getItem(FKEY + sem) || 0; } catch (_) { t = lastOk[sem] || 0; }
        return t > 0 && (Date.now() - t) < FRESH_MS;
    }
    function markVerified(sem) {
        lastOk[sem] = Date.now();
        try { sessionStorage.setItem(FKEY + sem, String(Date.now())); } catch (_) { /* ignore */ }
    }

    // 'grades'    -> real grades known, show them
    // 'predictor' -> we know there are no grades yet, show predictor
    // 'pending'   -> unknown (first ever visit); neutral placeholder, never a wrong UI
    function computeMode(items, sem) {
        if (items.some((i) => i.code && isReal(mem.grades[i.code]))) return 'grades';
        if (!sem || mem.noGrades[sem] === true || settled.has(sem) || verified(sem)) return 'predictor';
        return 'pending';
    }

    function setGradeText(span, g) {
        const real = isReal(g);
        span.textContent = real ? String(g).trim() : '-';
        span.classList.toggle('st-f', real && String(g).trim().toUpperCase() === 'F');
    }

    const idle = (cb) =>
        'requestIdleCallback' in window ? requestIdleCallback(cb, { timeout: 3000 }) : setTimeout(cb, 200);

    // ---------- css ----------
    function ensureCss() {
        if (document.getElementById('st-predict-css')) return;
        const style = document.createElement('style');
        style.id = 'st-predict-css';
        style.textContent = `
      #kt_ViewTable .st-total-cell, #kt_ViewTable .st-credits-cell, #kt_ViewTable .st-grade-cell {
        text-align:center; font-weight:600; color:#343a40; font-variant-numeric:tabular-nums; vertical-align:middle; }
      #kt_ViewTable .st-total-cell { background:rgba(0,0,0,.03); }
      #kt_ViewTable .st-grade-text.st-f { color:#c0392b; }
      #kt_ViewTable .st-grade-text.st-pending { opacity:.45; }

      .st-seamless-input { border:1px solid transparent; border-bottom:1px dashed #ced4da; background:transparent;
        font-weight:600; color:#343a40; text-align:center; width:50px; padding:2px 0; outline:none;
        border-radius:4px; transition:border-color .15s, background-color .15s, box-shadow .15s; }
      .st-seamless-input:hover { border:1px solid #ced4da; background:#f8f9fa; }
      .st-seamless-input:focus { border:1px solid #80bdff; background:#fff; box-shadow:0 0 0 .2rem rgba(0,123,255,.25); }

      .st-credits-col { display:none; }
      .st-pred-mode-on .st-credits-col { display:table-cell; }
      .st-grade-input-wrap, .st-grade-cell .st-input-wrap { display:none; }
      .st-pred-mode-on .st-grade-input-wrap, .st-pred-mode-on .st-grade-cell .st-input-wrap { display:inline-flex; }
      .st-grade-input { display:none; }
      .st-pred-mode-on .st-grade-input { display:inline-block; }
      .st-pred-mode-on .st-grade-text.st-missing { display:none; }
      
      .st-input-wrap { display:inline-flex; align-items:center; position:relative; }
      .st-spinners { display:flex; flex-direction:column; margin-left:4px; opacity:0; transition:opacity .15s; }
      .st-input-wrap:hover .st-spinners, .st-seamless-input:focus + .st-spinners { opacity:1; }
      .st-spinners button { background:none; border:none; padding:0; margin:0; font-size:9px; color:#adb5bd; cursor:pointer; line-height:1; border-radius:2px; height:10px; }
      .st-spinners button:hover { color:#495057; }
      .st-spinners button:focus-visible { outline:2px solid #80bdff; outline-offset:1px; }

      #st-predict-toggle-container .st-add-subj-wrapper, #st-predict-toggle-container .st-reset {
        margin-left:8px; display:none; vertical-align:middle; position:relative;
      }
      .st-pred-mode-on #st-predict-toggle-container .st-add-subj-wrapper, .st-pred-mode-on #st-predict-toggle-container .st-reset { display:inline-flex; align-items:center; }
      
      #st-predict-toggle-container .st-add-subj-btn, #st-predict-toggle-container .st-reset {
        height:auto; min-width:0; line-height:1.4; white-space:nowrap; box-shadow:none; text-transform:none; padding:4px 10px; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer; outline:none; transition:background .2s, border-color .2s; font-family:inherit;
      }
      #st-predict-toggle-container .st-add-subj-btn {
        color:#16835d; border:1px solid #b7e4cb; background:#eaf8f1; display:inline-flex; align-items:center; gap:4px;
      }
      #st-predict-toggle-container .st-add-subj-btn:hover { background:#d5f3e4; }
      
      .st-add-subj-menu {
        position:absolute; right:0; top:calc(100% + 6px); z-index:1000; width:300px; max-width:min(340px, calc(100vw - 32px));
        background:#ffffff; border:1px solid #e2e8f0; border-radius:8px; padding:8px;
        box-shadow:0 10px 25px -5px rgba(0,0,0,0.12), 0 8px 10px -6px rgba(0,0,0,0.06);
        opacity:0; transform:translateY(-4px); transition:opacity 0.18s ease, transform 0.18s ease;
        visibility:hidden; pointer-events:none; font-size:12px; text-align:left;
      }
      .st-add-subj-menu.open { opacity:1; transform:translateY(0); visibility:visible; pointer-events:auto; }
      .st-add-menu-header { padding:4px 6px 6px; border-bottom:1px solid #f1f5f9; margin-bottom:4px; }
      .st-add-menu-title { font-size:11px; font-weight:700; color:#334155; text-transform:uppercase; letter-spacing:0.04em; display:flex; align-items:center; gap:6px; }
      .st-add-menu-sub { font-size:11px; color:#94a3b8; margin-top:2px; }
      .st-add-menu-list { max-height:220px; overflow-y:auto; display:flex; flex-direction:column; gap:2px; margin:4px 0; }
      .st-add-menu-item {
        display:flex; align-items:center; justify-content:space-between; padding:6px 8px; border-radius:6px;
        background:transparent; border:none; cursor:pointer; text-align:left; width:100%; color:#1e293b;
        font-size:12px; transition:background 0.15s; line-height:1.3;
      }
      .st-add-menu-item:hover { background:#f0fdf4; }
      .st-add-menu-code {
        font-size:10px; font-weight:700; background:#f1f5f9; color:#475569; padding:2px 5px;
        border-radius:4px; font-family:monospace; flex-shrink:0; border:1px solid #e2e8f0;
      }
      .st-add-menu-name { flex:1; margin:0 8px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:500; }
      .st-add-menu-plus { color:#16835d; font-weight:700; font-size:14px; flex-shrink:0; }
      .st-add-menu-divider { height:1px; background:#f1f5f9; margin:4px 0; }
      .st-add-menu-custom {
        display:flex; align-items:center; gap:6px; padding:6px 8px; border-radius:6px; color:#356ae6;
        font-weight:600; cursor:pointer; background:transparent; border:none; width:100%; text-align:left;
        font-size:12px; transition:background 0.15s;
      }
      .st-add-menu-custom:hover { background:#edf3ff; }
      
      #st-predict-toggle-container .st-reset { color:#64748b; border:1px solid #cbd5e1; background:#ffffff; }
      #st-predict-toggle-container .st-reset:hover { background:#f1f5f9; color:#1e293b; }
      
      .st-custom-del { color:#b42336; border:1px solid #fecaca; background:#fff0f1; cursor:pointer; font-size:10px; font-weight:700; margin-left:8px; padding:2px 6px; border-radius:4px; display:none; line-height:1.2; text-decoration:none; transition:background .15s, border-color .15s; vertical-align:middle; }
      .st-custom-del:hover { background:#fee2e2; color:#7a1a25; border-color:#fca5a5; text-decoration:none; }
      .st-pred-mode-on .st-custom-del { display:inline-block; }

      .st-custom-row { display:none; }
      .st-pred-mode-on .st-custom-row { display:table-row; }
      .st-custom-sno { color:#10b981!important; font-weight:700!important; font-size:14px!important; }
      .st-custom-name { border-bottom:1px solid transparent!important; }
      .st-custom-name:hover { border-bottom:1px dashed #cbd5e1!important; background:#f8fafc!important; }
      .st-custom-name:focus { border:1px solid #10b981!important; background:#fff!important; box-shadow:0 0 0 2px rgba(16,185,129,.15)!important; }

      #st-predict-toggle-container {
        display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px;
        margin:0 0 14px; padding:10px 14px; background:var(--mf-soft,#f8fafc);
        border:1px solid var(--mf-line,#e2e8f0); border-radius:var(--mf-radius,10px);
        box-shadow:var(--mf-shadow,0 1px 3px rgba(16,24,40,.04)); font-size:13px; box-sizing:border-box;
      }
      #st-predict-toggle-container label { cursor:pointer; font-weight:600; font-size:13px; color:#334155;
        user-select:none; margin:0; display:inline-flex; align-items:center; transition:color 0.2s; }
      #st-predict-toggle-container label:hover { color:#1e293b; }
      
      .st-switch { font-size:11px; position:relative; display:inline-flex; align-items:center; gap:8px; cursor:pointer; }
      .st-switch input { position:absolute; opacity:0; width:0; height:0; pointer-events:none; }
      .st-slider { position:relative; display:inline-block; width:3.2em; height:1.8em; background:#f1f5f9; border:1px solid #cbd5e1; border-radius:50px; overflow:hidden; box-sizing:border-box; box-shadow:inset 0 1px 2px rgba(0,0,0,0.06); transition:all 0.35s cubic-bezier(0.215,0.61,0.355,1); flex-shrink:0; }
      .st-slider::before { position:absolute; content:""; height:1.25em; width:1.25em; right:0.22em; bottom:0.18em; transform:translateX(160%); background-color:#10b981; border-radius:inherit; box-shadow:0 1px 3px rgba(0,0,0,0.15); transition:transform 0.35s cubic-bezier(0.215,0.61,0.355,1); }
      .st-slider::after { position:absolute; content:""; height:1.25em; width:1.25em; left:0.22em; bottom:0.18em; transform:translateX(0); background-color:#94a3b8; border-radius:inherit; box-shadow:0 1px 3px rgba(0,0,0,0.15); transition:transform 0.35s cubic-bezier(0.215,0.61,0.355,1); }
      .st-switch input:checked + .st-slider { background:#ecfdf5; border-color:#a7f3d0; }
      .st-switch input:checked + .st-slider::before { transform:translateX(0); }
      .st-switch input:checked + .st-slider::after { transform:translateX(-160%); }
      .st-switch input:focus-visible + .st-slider { box-shadow:0 0 0 2px rgba(16,185,129,0.35); }

      #st-pred-gpa-row { display:none; }
      .st-pred-mode-on #st-pred-gpa-row { display:table-row; }
      #st-pred-gpa-row td { padding:10px 18px; font-weight:600; font-size:13px;
        color:#172033; border-top:2px solid #cbd5e1!important; background:#f8fafc!important; }
      .st-pred-bar-wrap { display:flex; justify-content:space-between; align-items:center; width:100%; box-sizing:border-box; flex-wrap:wrap; gap:10px; }
      .st-pred-cgpa-col { display:inline-flex; align-items:center; position:relative; }
      .st-cgpa-display-wrap { display:inline-flex; align-items:center; gap:6px; font-size:13px; }
      .st-cgpa-val { color:#0f172a; font-weight:800; font-size:15px; font-variant-numeric:tabular-nums; }
      .st-cgpa-delta { display:inline-block; padding:1px 6px; border-radius:4px; font-size:11px; font-weight:700; font-variant-numeric:tabular-nums; line-height:1.3; }
      .st-delta-pos { background:#dcfce7; color:#15803d; }
      .st-delta-neg { background:#fee2e2; color:#b91c1c; }
      .st-delta-zero { background:#f1f5f9; color:#64748b; }
      .st-cgpa-sub { color:#64748b; font-weight:500; font-size:12px; }
      .st-cgpa-btn-icon { background:transparent; border:none; color:#94a3b8; font-size:12px; cursor:pointer; padding:2px 5px; border-radius:4px; display:inline-flex; align-items:center; transition:color 0.15s, background 0.15s; }
      .st-cgpa-btn-icon:hover { color:#1e293b; background:#e2e8f0; }
      .st-cgpa-set-pill { background:#f1f5f9; border:1px dashed #cbd5e1; color:#475569; border-radius:6px; padding:3px 8px; font-size:12px; font-weight:600; cursor:pointer; display:inline-flex; align-items:center; gap:4px; transition:border-color 0.15s, background 0.15s; }
      .st-cgpa-set-pill:hover { background:#e2e8f0; border-color:#94a3b8; color:#1e293b; }
      .st-cgpa-popover { position:absolute; left:0; bottom:calc(100% + 8px); z-index:100; width:260px; background:#ffffff; border:1px solid #cbd5e1; border-radius:8px; padding:12px; box-shadow:0 8px 24px rgba(0,0,0,0.12); text-align:left; cursor:default; }
      .st-pred-gpa-col { display:inline-flex; align-items:center; margin-left:auto; }
      #st-pred-gpa-val { color:#172033; font-weight:800; font-size:16px; margin-left:8px; font-variant-numeric:tabular-nums; }
      #st-pred-gpa-sub { color:#667085; font-weight:500; font-size:12px; }

      @media (prefers-reduced-motion: reduce) { .st-seamless-input { transition:none; } }
      @media print {
        #st-predict-toggle-container, #st-pred-gpa-row,
        .st-credits-col, .st-grade-input, .st-grade-input-wrap, .st-custom-row { display:none !important; }
        #kt_ViewTable[data-st-mode="predictor"] .st-injected-grade,
        #kt_ViewTable[data-st-mode="predictor"] .st-grade-cell,
        #kt_ViewTable[data-st-mode="pending"] .st-injected-grade,
        #kt_ViewTable[data-st-mode="pending"] .st-grade-cell { display:none !important; }
      }
    `;
        (document.head || document.documentElement).appendChild(style);
    }

    // ---------- DOM builders ----------
    function addTh(head, cls, text) {
        const th = document.createElement('th');
        th.className = cls;
        th.textContent = text;
        // Inherit the portal's own header look instead of hard-coding colours.
        const proto = head.cells[2] || head.cells[0];
        if (proto) { th.style.cssText = proto.style.cssText; th.style.width = ''; }
        th.style.textAlign = 'center';
        th.style.whiteSpace = 'nowrap';
        head.appendChild(th);
    }

    function addTd(row, cls) {
        const td = row.insertCell(-1);
        td.className = cls;
        return td;
    }

    function cycle(e, opts) {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        let i = opts.indexOf(e.target.value.toUpperCase());
        if (i === -1) i = 0;
        i = (i + (e.key === 'ArrowUp' ? -1 : 1) + opts.length) % opts.length;
        e.target.value = opts[i];
        e.target.dispatchEvent(new Event('change'));
    }

    function makeInput(cls, opts, initial, title, label, maxLen, normalize, onCommit) {
        const wrap = document.createElement('div');
        wrap.className = 'st-input-wrap ' + cls + '-wrap';

        const el = document.createElement('input');
        el.type = 'text';
        el.value = initial;
        el.title = title;
        el.maxLength = maxLen;
        el.autocomplete = 'off';
        el.spellcheck = false;
        el.setAttribute('aria-label', label);
        el.className = 'st-seamless-input ' + cls;

        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {            // Enter: commit and jump to the next row
                e.preventDefault();
                const list = Array.from(document.querySelectorAll('#kt_ViewTable .' + cls));
                const next = list[list.indexOf(el) + 1];
                if (next) next.focus(); else el.blur();
                return;
            }
            cycle(e, opts);
        });
        el.addEventListener('focus', () => {
            if (el.value === '-') el.value = ''; else el.select();
        });
        el.addEventListener('blur', () => {
            if (el.value === '') { el.value = '-'; el.dispatchEvent(new Event('change')); }
        });
        el.addEventListener('input', () => {
            const raw = el.value.trim().toUpperCase();
            const v = normalize(raw);
            if (opts.includes(v) || v === '-') {
                onCommit(v);
            }
        });
        el.addEventListener('change', () => {
            let v = normalize(el.value.trim().toUpperCase());
            if (!opts.includes(v)) v = '-';
            el.value = v;
            onCommit(v);
        });

        const spinners = document.createElement('div');
        spinners.className = 'st-spinners';
        const up = document.createElement('button');
        up.textContent = '\u25B2';
        up.type = 'button';
        up.tabIndex = -1;
        const dn = document.createElement('button');
        dn.textContent = '\u25BC';
        dn.type = 'button';
        dn.tabIndex = -1;

        up.onmousedown = (e) => { e.preventDefault(); cycle({ key: 'ArrowUp', target: el, preventDefault: () => { } }, opts); };
        dn.onmousedown = (e) => { e.preventDefault(); cycle({ key: 'ArrowDown', target: el, preventDefault: () => { } }, opts); };

        spinners.append(up, dn);
        wrap.append(el, spinners);

        return wrap;
    }

    // ---------- predictor ----------
    function updateGPA(table) {
        let credits = 0, points = 0;
        dataRows(table).forEach((row) => {
            const ci = row.querySelector('.st-credits-input');
            const c = ci ? parseInt(ci.value, 10) : NaN;
            if (isNaN(c)) return;

            const gi = row.querySelector('.st-grade-input');
            const txt = (gi ? gi.value : '').trim().toUpperCase();

            let p;
            if (Object.prototype.hasOwnProperty.call(POINTS, txt)) p = POINTS[txt];
            else if (/^\d+$/.test(txt) && +txt <= 10) p = +txt;
            else return;

            credits += c;
            points += p * c;
        });

        let row = document.getElementById('st-pred-gpa-row');
        if (!row) {
            row = document.createElement('tr');
            row.id = 'st-pred-gpa-row';
            const td = document.createElement('td');
            td.colSpan = (table.rows[0] && table.rows[0].cells.length) || 20;

            const wrap = document.createElement('div');
            wrap.className = 'st-pred-bar-wrap';

            // Left side: Projected CGPA
            const cgpaBox = document.createElement('div');
            cgpaBox.className = 'st-pred-cgpa-col';
            cgpaBox.id = 'st-pred-cgpa-col';

            // Right side: Semester GPA
            const gpaBox = document.createElement('div');
            gpaBox.className = 'st-pred-gpa-col';
            gpaBox.append('Calculated Semester GPA: ');
            const val = document.createElement('span');
            val.id = 'st-pred-gpa-val';
            val.setAttribute('aria-live', 'polite');
            const sub = document.createElement('span');
            sub.id = 'st-pred-gpa-sub';
            gpaBox.append(val, sub);

            wrap.append(cgpaBox, gpaBox);
            td.appendChild(wrap);
            row.appendChild(td);
            (table.tBodies[0] || table).appendChild(row);
        }

        const valEl = document.getElementById('st-pred-gpa-val');
        if (valEl) valEl.textContent = credits > 0 ? (points / credits).toFixed(2) : '-';
        const subEl = document.getElementById('st-pred-gpa-sub');
        if (subEl) subEl.textContent = credits > 0 ? ' \u00B7 ' + credits + (credits === 1 ? ' credit' : ' credits') : '';

        renderCGPACol(credits, points);
    }

    let cgpaPopover = null;
    function closeCGPAPopover() {
        if (!cgpaPopover) return;
        cgpaPopover.remove();
        cgpaPopover = null;
    }
    document.addEventListener('click', (e) => {
        if (cgpaPopover && !cgpaPopover.contains(e.target)) closeCGPAPopover();
    });

    function renderCGPACol(semCredits, semPoints) {
        const col = document.getElementById('st-pred-cgpa-col');
        if (!col) return;
        col.textContent = '';

        const baseline = mem.baseline;
        const baseWrap = document.createElement('div');
        baseWrap.className = 'st-cgpa-display-wrap';

        if (baseline && typeof baseline.cgpa === 'number' && typeof baseline.credits === 'number') {
            const baseCredits = baseline.credits;
            const basePoints = typeof baseline.points === 'number' ? baseline.points : (baseline.cgpa * baseCredits);

            const SEM_ORDER = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
            const ddl = document.getElementById('ddlSemester');
            const semVal = lastSem || (ddl && ddl.value) || '';
            const cleanSem = semVal.replace(/semester/i, '').trim().toUpperCase();
            const viewIdx = SEM_ORDER.indexOf(cleanSem) + 1;
            const semsCompleted = baseline.semsCompleted || 0;
            const alreadyInBaseline = semsCompleted > 0 && viewIdx > 0 && viewIdx <= semsCompleted;

            let newCgpa = baseline.cgpa;
            let delta = 0;
            let totalCredits = baseCredits;
            const isProjecting = semCredits > 0 && !alreadyInBaseline;

            if (isProjecting) {
                totalCredits = baseCredits + semCredits;
                newCgpa = (basePoints + semPoints) / totalCredits;
                newCgpa = Math.round(newCgpa * 100) / 100;
                delta = Math.round((newCgpa - baseline.cgpa) * 100) / 100;
            }

            const lbl = document.createElement('span');
            lbl.textContent = isProjecting ? 'Projected CGPA: ' : 'Current CGPA: ';
            lbl.style.color = '#475569';

            const val = document.createElement('span');
            val.className = 'st-cgpa-val';
            val.textContent = newCgpa.toFixed(2);

            baseWrap.append(lbl, val);

            if (isProjecting) {
                const deltaEl = document.createElement('span');
                const isPos = delta > 0;
                const isNeg = delta < 0;
                deltaEl.className = 'st-cgpa-delta ' + (isPos ? 'st-delta-pos' : isNeg ? 'st-delta-neg' : 'st-delta-zero');
                deltaEl.textContent = (isPos ? '+' : '') + delta.toFixed(2);
                baseWrap.appendChild(deltaEl);
            }

            const sub = document.createElement('span');
            sub.className = 'st-cgpa-sub';
            sub.textContent = ' \u00B7 ' + totalCredits + ' credits' + (alreadyInBaseline ? ` (Sem ${cleanSem} verified)` : '');
            baseWrap.appendChild(sub);

            const editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.className = 'st-cgpa-btn-icon';
            editBtn.innerHTML = '&#9998;';
            editBtn.title = 'Adjust baseline CGPA or sync';
            editBtn.setAttribute('aria-label', 'Adjust baseline CGPA');
            editBtn.onclick = (e) => {
                e.stopPropagation();
                toggleCGPAPopover(col);
            };
            baseWrap.appendChild(editBtn);
        } else {
            const setBtn = document.createElement('button');
            setBtn.type = 'button';
            setBtn.className = 'st-cgpa-set-pill';
            setBtn.innerHTML = 'Projected CGPA: <span style="text-decoration:underline;">Set Baseline</span> &#9998;';
            setBtn.title = 'Enter your current CGPA and completed credits to project CGPA';
            setBtn.onclick = (e) => {
                e.stopPropagation();
                toggleCGPAPopover(col);
            };
            baseWrap.appendChild(setBtn);
        }

        col.appendChild(baseWrap);
    }

    function toggleCGPAPopover(anchor) {
        if (cgpaPopover) {
            closeCGPAPopover();
            return;
        }

        const pop = document.createElement('div');
        pop.className = 'st-cgpa-popover';
        pop.onclick = (e) => e.stopPropagation();

        const currentCgpa = (mem.baseline && typeof mem.baseline.cgpa === 'number') ? mem.baseline.cgpa : '';
        const currentCredits = (mem.baseline && typeof mem.baseline.credits === 'number') ? mem.baseline.credits : '';

        pop.innerHTML = `
            <div style="font-weight:700;color:#0f172a;font-size:13px;margin-bottom:2px;">Cumulative Baseline</div>
            <div style="font-size:11px;color:#64748b;margin-bottom:10px;">Prior completed semesters baseline:</div>
            <div style="display:flex;gap:8px;margin-bottom:10px;">
                <label style="flex:1;font-size:11px;font-weight:600;color:#334155;">
                    Current CGPA
                    <input type="number" step="0.01" min="0" max="10" class="st-cgpa-in-cgpa" value="${currentCgpa}" placeholder="e.g. 8.50" style="width:100%;margin-top:4px;padding:5px 8px;font-size:12px;border:1px solid #cbd5e1;border-radius:6px;outline:none;box-sizing:border-box;" />
                </label>
                <label style="flex:1;font-size:11px;font-weight:600;color:#334155;">
                    Completed Credits
                    <input type="number" step="1" min="0" max="300" class="st-cgpa-in-cred" value="${currentCredits}" placeholder="e.g. 80" style="width:100%;margin-top:4px;padding:5px 8px;font-size:12px;border:1px solid #cbd5e1;border-radius:6px;outline:none;box-sizing:border-box;" />
                </label>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
                <button type="button" class="st-cgpa-btn-sync" style="background:#f1f5f9;border:1px solid #cbd5e1;color:#475569;border-radius:5px;padding:4px 8px;font-size:11px;font-weight:600;cursor:pointer;">&#8635; Sync</button>
                <div style="display:flex;gap:6px;">
                    <button type="button" class="st-cgpa-btn-cancel" style="background:transparent;border:none;color:#64748b;padding:4px 8px;font-size:11px;cursor:pointer;">Cancel</button>
                    <button type="button" class="st-cgpa-btn-save" style="background:#10b981;border:none;color:#ffffff;border-radius:5px;padding:4px 10px;font-size:11px;font-weight:600;cursor:pointer;">Save</button>
                </div>
            </div>
        `;

        pop.querySelector('.st-cgpa-btn-cancel').onclick = closeCGPAPopover;

        const cgpaIn = pop.querySelector('.st-cgpa-in-cgpa');
        const credIn = pop.querySelector('.st-cgpa-in-cred');
        const syncBtn = pop.querySelector('.st-cgpa-btn-sync');
        const saveBtn = pop.querySelector('.st-cgpa-btn-save');

        syncBtn.onclick = async () => {
            syncBtn.disabled = true;
            syncBtn.textContent = 'Syncing...';
            await syncCGPABaseline(true);
            if (mem.baseline) {
                cgpaIn.value = mem.baseline.cgpa;
                credIn.value = mem.baseline.credits;
            }
            syncBtn.disabled = false;
            syncBtn.innerHTML = '&#8635; Sync';
            showToast('Academic baseline synced', 'success');
        };

        saveBtn.onclick = () => {
            const c = parseFloat(cgpaIn.value);
            const cr = parseInt(credIn.value, 10);
            if (isNaN(c) || c < 0 || c > 10 || isNaN(cr) || cr < 0) {
                showToast('Please enter valid CGPA (0–10) and Credits (≥ 0).', 'warn');
                return;
            }
            const baseline = {
                cgpa: Math.round(c * 100) / 100,
                credits: cr,
                points: Math.round(c * cr * 100) / 100,
                semsCompleted: (mem.baseline && mem.baseline.semsCompleted) || 0,
                lastSynced: Date.now(),
                manual: true
            };
            mem.baseline = baseline;
            sSet({ muj_academic_baseline: baseline });
            closeCGPAPopover();
            const table = getTable();
            if (table && mem.predEnabled) updateGPA(table);
            showToast('Baseline saved', 'success');
        };

        anchor.style.position = 'relative';
        anchor.appendChild(pop);
        cgpaPopover = pop;
    }

    function removeCustomRows(t) {
        if (!t) return;
        t.querySelectorAll('.st-custom-row').forEach((r) => r.remove());
    }

    function createCustomRowDom(table, code, name, fromAttendance) {
        const tbody = table.tBodies[0] || table;
        const row = document.createElement('tr');
        row.className = 'st-custom-row';
        row.dataset.stCode = code;
        if (fromAttendance) row.dataset.stFromAttendance = '1';

        const nativeCols = table.rows[0].cells.length - table.querySelectorAll('.st-injected-total, .st-injected-credits, .st-injected-grade').length;
        for (let i = 0; i < nativeCols; i++) {
            const td = row.insertCell(-1);
            td.style.cssText = 'padding:10px; border-bottom:1px solid #ebedf3; text-align:center; vertical-align:middle; color:#a1a5b7; font-size:12px;';
            if (i >= 2) td.textContent = '–';
        }
        row.cells[0].textContent = '*';
        row.cells[0].className = 'st-custom-sno';

        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'Custom Subject';
        input.value = name || '';
        input.className = 'st-seamless-input st-custom-name';
        input.style.width = fromAttendance ? '220px' : '120px';
        input.style.textAlign = 'left';
        row.cells[1].style.textAlign = 'left';
        row.cells[1].appendChild(input);

        input.addEventListener('input', () => {
            const sem = table.dataset.stSem || '';
            if (sem && mem.customSubjects[sem]) {
                const entry = mem.customSubjects[sem].find((it) => it.code === code);
                if (entry) {
                    entry.name = input.value;
                    patch('customSubjects', { [sem]: mem.customSubjects[sem] });
                }
            }
        });

        const del = document.createElement('span');
        del.className = 'st-custom-del';
        del.textContent = '\u2716';
        del.title = 'Remove Subject';
        del.onclick = () => {
            if (code in mem.predicted) { delete mem.predicted[code]; patch('predictedGrades', {}, [code]); }
            if (code in mem.credits) { delete mem.credits[code]; patch('courseCredits', {}, [code]); }
            const sem = table.dataset.stSem || '';
            if (sem && mem.customSubjects[sem]) {
                mem.customSubjects[sem] = mem.customSubjects[sem].filter((it) => it.code !== code);
                patch('customSubjects', { [sem]: mem.customSubjects[sem] });
            }
            row.remove();
            updateGPA(table);
        };
        row.cells[1].appendChild(del);

        const gpaRow = document.getElementById('st-pred-gpa-row');
        if (gpaRow) tbody.insertBefore(row, gpaRow);
        else tbody.appendChild(row);

        return row;
    }

    function addCustomSubject(table, courseInfo) {
        if (!table) return;
        if (dataRows(table).length >= 10) {
            showToast('Maximum 10 subjects allowed for calculation.');
            return;
        }

        const sem = table.dataset.stSem || '';
        const code = courseInfo && courseInfo.code
            ? courseInfo.code
            : 'CUS_' + Math.random().toString(36).substr(2, 5).toUpperCase();
        const name = courseInfo ? (courseInfo.name || courseInfo.display || courseInfo.code) : '';
        const fromAttendance = !!(courseInfo && courseInfo.fromAttendance);

        if (sem) {
            mem.customSubjects[sem] = mem.customSubjects[sem] || [];
            if (!mem.customSubjects[sem].some((it) => it.code === code)) {
                mem.customSubjects[sem].push({ code, name, fromAttendance });
                patch('customSubjects', { [sem]: mem.customSubjects[sem] });
            }
        }

        createCustomRowDom(table, code, name, fromAttendance);
        render(table, 'predictor', sem);
    }

    function ensureCustomRows(table, sem) {
        if (!table || !mem.predEnabled) return;

        // 1. Collect all native course codes in the table
        const nativeCodes = new Set();
        Array.from(table.rows).slice(1).forEach((r) => {
            if (r.id !== 'st-pred-gpa-row' && !r.classList.contains('grand-total-row') && !r.classList.contains('st-custom-row') && r.cells.length >= 3) {
                const c = codeOf(r);
                if (c) nativeCodes.add(normCode(c));
                if (r.cells[1]) nativeCodes.add(normCode(r.cells[1].textContent));
            }
        });

        // 2. Remove any custom rows in DOM whose subject is now officially in the table (marks updated on SLCM!)
        table.querySelectorAll('tr.st-custom-row').forEach((r) => {
            const c = codeOf(r);
            if (c && nativeCodes.has(normCode(c))) {
                r.remove();
            }
        });

        // 3. Prune from mem.customSubjects[sem] if now officially present natively
        if (sem && mem.customSubjects[sem]) {
            const initialLen = mem.customSubjects[sem].length;
            mem.customSubjects[sem] = mem.customSubjects[sem].filter((it) => !it.code || !nativeCodes.has(normCode(it.code)));
            if (mem.customSubjects[sem].length !== initialLen) {
                patch('customSubjects', { [sem]: mem.customSubjects[sem] });
            }

            // 4. Restore custom rows into DOM if missing
            mem.customSubjects[sem].forEach((item) => {
                if (!item || !item.code) return;
                const existing = table.querySelector(`tr.st-custom-row[data-st-code="${item.code}"]`);
                if (!existing) {
                    createCustomRowDom(table, item.code, item.name, item.fromAttendance);
                }
            });
        }
    }

    function renderAddSubjMenu(missingCourses, table, menuEl, closeMenuFn) {
        menuEl.innerHTML = '';

        const header = document.createElement('div');
        header.className = 'st-add-menu-header';
        header.innerHTML = `
            <div class="st-add-menu-title">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                <span>From Attendance</span>
            </div>
            <div class="st-add-menu-sub">Enrolled subjects not in marks table yet</div>
        `;
        menuEl.appendChild(header);

        const list = document.createElement('div');
        list.className = 'st-add-menu-list';

        missingCourses.forEach((course) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'st-add-menu-item';
            btn.title = `Add ${course.display} to calculator`;

            const codeSpan = document.createElement('span');
            codeSpan.className = 'st-add-menu-code';
            codeSpan.textContent = course.code;

            const nameSpan = document.createElement('span');
            nameSpan.className = 'st-add-menu-name';
            nameSpan.textContent = course.name || course.display;

            const plusSpan = document.createElement('span');
            plusSpan.className = 'st-add-menu-plus';
            plusSpan.textContent = '+';

            btn.append(codeSpan, nameSpan, plusSpan);

            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                closeMenuFn();
                addCustomSubject(table, {
                    code: course.code,
                    name: course.display,
                    fromAttendance: true
                });
            });

            list.appendChild(btn);
        });

        menuEl.appendChild(list);

        const divider = document.createElement('div');
        divider.className = 'st-add-menu-divider';
        menuEl.appendChild(divider);

        const customBtn = document.createElement('button');
        customBtn.type = 'button';
        customBtn.className = 'st-add-menu-custom';
        customBtn.innerHTML = `
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            <span>Custom Subject (Type manually)</span>
        `;
        customBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeMenuFn();
            addCustomSubject(table, null);
        });
        menuEl.appendChild(customBtn);
    }

    function syncToggle(table, predictor) {
        let box = document.getElementById('st-predict-toggle-container');

        if (!predictor) {
            if (box) {
                if (box._closePanelFn) document.removeEventListener('click', box._closePanelFn);
                box.remove();
            }
            document.body.classList.remove('st-pred-mode-on');
            removeCustomRows(table);
            return;
        }

        if (!mem.predEnabled) {
            removeCustomRows(table);
        }

        document.body.classList.toggle('st-pred-mode-on', mem.predEnabled);

        if (box) {   // survives across Find clicks: just refresh its state
            box.querySelector('input').checked = mem.predEnabled;
            const showExtras = mem.predEnabled ? '' : 'none';
            const rBtn = box.querySelector('.st-reset');
            if (rBtn) rBtn.style.display = showExtras;
            const wrap = box.querySelector('.st-add-subj-wrapper');
            if (wrap) wrap.style.display = showExtras;
            return;
        }

        box = document.createElement('div');
        box.id = 'st-predict-toggle-container';

        const label = document.createElement('label');
        label.className = 'st-switch';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = mem.predEnabled;

        const slider = document.createElement('span');
        slider.className = 'st-slider';

        const textSpan = document.createElement('span');
        textSpan.textContent = 'Enable GPA Calculator';
        textSpan.style.lineHeight = '1';

        label.append(cb, slider, textSpan);

        const reset = document.createElement('button');
        reset.type = 'button';
        reset.textContent = 'Reset calculator';
        reset.className = 'st-reset';

        const addSubjWrapper = document.createElement('div');
        addSubjWrapper.className = 'st-add-subj-wrapper';

        const addSubj = document.createElement('button');
        addSubj.type = 'button';
        addSubj.className = 'st-add-subj-btn';
        addSubj.innerHTML = '<span>+ Subject</span><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-left:2px;"><path d="m6 9 6 6 6-6"/></svg>';

        const addSubjMenu = document.createElement('div');
        addSubjMenu.className = 'st-add-subj-menu';

        addSubjWrapper.append(addSubj, addSubjMenu);

        const showExtras = mem.predEnabled ? '' : 'none';
        reset.style.display = showExtras;
        addSubjWrapper.style.display = showExtras;

        cb.addEventListener('change', () => {
            mem.predEnabled = cb.checked;
            sSet({ predEnabled: cb.checked });
            document.body.classList.toggle('st-pred-mode-on', cb.checked);
            const extras = cb.checked ? '' : 'none';
            reset.style.display = extras;
            addSubjWrapper.style.display = extras;
            const t = getTable();
            if (!cb.checked && t) {
                removeCustomRows(t);
            }
            if (t) updateGPA(t);
        });

        // Resolves the CURRENT table on click (the box outlives individual tables).
        reset.addEventListener('click', () => {
            const t = getTable();
            if (!t) return;
            removeCustomRows(t);
            const codes = [];
            dataRows(t).forEach((r) => {
                const c = codeOf(r);
                if (c && c in mem.predicted) { delete mem.predicted[c]; codes.push(c); }
            });
            if (codes.length) patch('predictedGrades', {}, codes);
            const sem = t.dataset.stSem || '';
            if (sem && mem.customSubjects[sem]) {
                mem.customSubjects[sem] = [];
                patch('customSubjects', { [sem]: [] });
            }
            render(t, 'predictor', t.dataset.stSem || '');
        });

        let isMenuOpen = false;
        function closeMenu() {
            if (!isMenuOpen) return;
            isMenuOpen = false;
            addSubjMenu.classList.remove('open');
            setTimeout(() => {
                if (!isMenuOpen) {
                    addSubjMenu.style.visibility = 'hidden';
                    addSubjMenu.style.pointerEvents = 'none';
                }
            }, 180);
        }

        async function openMenu() {
            const t = getTable();
            if (!t) return;
            if (dataRows(t).length >= 10) {
                showToast('Maximum 10 subjects allowed for calculation.');
                return;
            }

            const attCourses = await fetchAttendanceCourses();

            const currentCodes = new Set();
            dataRows(t).forEach((r) => {
                const c = codeOf(r);
                if (c) currentCodes.add(normCode(c));
                if (r.cells[1]) currentCodes.add(normCode(r.cells[1].textContent));
            });

            const missing = (attCourses || []).filter((ac) => ac && ac.code && !currentCodes.has(normCode(ac.code)));

            if (!missing.length) {
                addCustomSubject(t, null);
                return;
            }

            renderAddSubjMenu(missing, t, addSubjMenu, closeMenu);
            isMenuOpen = true;
            addSubjMenu.style.visibility = 'visible';
            addSubjMenu.style.pointerEvents = 'auto';
            void addSubjMenu.offsetWidth;
            addSubjMenu.classList.add('open');
        }

        addSubj.addEventListener('click', (e) => {
            e.stopPropagation();
            if (isMenuOpen) closeMenu();
            else openMenu();
        });
        addSubjMenu.addEventListener('click', (e) => e.stopPropagation());

        const infoWrapper = document.createElement('div');
        infoWrapper.style.cssText = 'position: relative; display: flex; align-items: center; margin-left: 4px;';

        const infoBtn = document.createElement('button');
        infoBtn.type = 'button';
        infoBtn.innerHTML = '&#9432;';
        infoBtn.className = 'btn btn-sm btn-link';
        infoBtn.style.cssText = 'padding: 0; text-decoration: none; font-size: 16px; outline: none; box-shadow: none; color: #a1a5b7; border: none; background: transparent; cursor: pointer; transition: color 0.2s; display: flex; align-items: center;';
        infoBtn.title = 'Calculator Guide';

        const infoPanel = document.createElement('div');
        infoPanel.style.cssText = 'position:absolute;right:0;top:calc(100% + 8px);z-index:100;width:240px;visibility:hidden;pointer-events:none;background:#ffffff;border:1px solid #e4e6ef;border-radius:6px;padding:12px;font-size:12px;color:#5e6278;box-shadow:0 4px 12px rgba(0,0,0,0.1);opacity:0;transform:translateY(-4px);transition:opacity 0.2s,transform 0.2s;cursor:default;';
        infoPanel.innerHTML = `
            <div style="font-weight: 600; color: #3f4254; margin-bottom: 4px; font-size: 13px;">Calculator Guide</div>
            <div style="line-height: 1.5;">Enable the calculator to calculate your GPA. You can select grades or add new subjects to calculate your semester GPA.</div>
        `;

        let isPanelOpen = false;
        const closePanel = () => {
            if (!isPanelOpen) return;
            isPanelOpen = false;
            infoPanel.style.opacity = '0';
            infoPanel.style.transform = 'translateY(-4px)';
            infoBtn.style.color = '#a1a5b7';
            setTimeout(() => {
                if (!isPanelOpen) {
                    infoPanel.style.visibility = 'hidden';
                    infoPanel.style.pointerEvents = 'none';
                }
            }, 200);
        };

        infoBtn.onclick = (e) => {
            e.stopPropagation();
            if (!isPanelOpen) {
                closeMenu();
                isPanelOpen = true;
                infoPanel.style.visibility = 'visible';
                infoPanel.style.pointerEvents = 'auto';
                void infoPanel.offsetWidth; // Force reflow
                infoPanel.style.opacity = '1';
                infoPanel.style.transform = 'translateY(0)';
                infoBtn.style.color = '#3699ff';
            } else {
                closePanel();
            }
        };

        infoPanel.onclick = (e) => e.stopPropagation();

        const closeAllPanels = () => {
            closePanel();
            closeMenu();
            closeCGPAPopover();
        };
        box._closePanelFn = closeAllPanels;
        document.addEventListener('click', closeAllPanels);

        infoWrapper.append(infoBtn, infoPanel);

        const leftWrap = document.createElement('div');
        leftWrap.style.cssText = 'display:inline-flex;align-items:center;gap:10px;position:relative;';
        leftWrap.append(label, infoWrapper);

        const rightWrap = document.createElement('div');
        rightWrap.style.cssText = 'display:inline-flex;align-items:center;gap:8px;position:relative;';
        rightWrap.append(addSubjWrapper, reset);

        box.append(leftWrap, rightWrap);

        const host = table.closest('.dataTables_wrapper, .table-responsive') || table;
        if (host.parentNode) {
            host.parentNode.insertBefore(box, host);
        } else {
            table.parentNode.insertBefore(box, table);
        }
    }

    // ---------- render (synchronous, idempotent) ----------
    function teardown(table) {
        closeCGPAPopover();
        table.querySelectorAll(INJECTED).forEach((el) => el.remove());
        const g = document.getElementById('st-pred-gpa-row');
        if (g) g.remove();
    }

    function render(table, mode, sem) {
        teardown(table);

        const predictor = mode === 'predictor';
        table.dataset.stMode = mode;
        table.dataset.stSem = sem;

        if (!predictor) removeCustomRows(table);
        else ensureCustomRows(table, sem);

        const head = table.rows[0];
        const items = dataRows(table).map((row) => ({ row, code: codeOf(row) }));
        if (!items.length) return;

        const nativeCols = head.cells.length;
        const skip = Array.from(head.cells).map((c) =>
            ['TOTAL', 'GRADE', 'CREDITS'].includes(c.textContent.trim().toUpperCase()));

        syncToggle(table, predictor);

        addTh(head, 'st-injected-total', 'Total');
        if (predictor) addTh(head, 'st-injected-credits st-credits-col', 'Credits');
        addTh(head, 'st-injected-grade', 'Grade');

        items.forEach(({ row, code }) => {
            // Total
            let sum = 0, any = false;
            for (let j = 2; j < nativeCols; j++) {
                if (skip[j] || !row.cells[j]) continue;
                const v = parseFloat(row.cells[j].textContent.trim());
                if (!isNaN(v)) { sum += v; any = true; }
            }
            addTd(row, 'st-total-cell').textContent = any ? sum.toFixed(2) : '-';

            // Credits (predictor only)
            if (predictor) {
                const td = addTd(row, 'st-credits-cell st-credits-col');
                td.appendChild(makeInput(
                    'st-credits-input', CREDIT_OPTS,
                    (code && mem.credits[code]) || '-',
                    'Type credit or use Up/Down arrows',
                    'Credits for ' + (code || 'course'), 1,
                    (v) => (/^\d+$/.test(v) && +v > 4 ? '4' : v),
                    (v) => {
                        if (code) {
                            if (v === '-') { delete mem.credits[code]; patch('courseCredits', {}, [code]); }
                            else { mem.credits[code] = v; patch('courseCredits', { [code]: v }, []); }
                        }
                        updateGPA(getTable() || table);
                    }));
            }

            // Grade
            const gTd = addTd(row, 'st-grade-cell');
            const span = document.createElement('span');
            span.className = 'st-grade-text';
            gTd.appendChild(span);

            if (mode === 'grades') {
                setGradeText(span, code && mem.grades[code]);
            } else if (mode === 'pending') {
                span.classList.add('st-pending');
                span.textContent = '\u2026';
            } else {
                span.classList.add('st-missing');
                span.textContent = '-';
                gTd.appendChild(makeInput(
                    'st-grade-input', GRADE_OPTS,
                    (code && mem.predicted[code]) || '-',
                    'Type a grade or use Up/Down arrows',
                    'Predicted grade for ' + (code || 'course'), 2,
                    (v) => v,
                    (v) => {
                        if (code) {
                            if (v === '-') { delete mem.predicted[code]; patch('predictedGrades', {}, [code]); }
                            else { mem.predicted[code] = v; patch('predictedGrades', { [code]: v }, []); }
                        }
                        updateGPA(getTable() || table);
                    }));
            }
        });

        if (predictor) updateGPA(table);
    }

    // After a background check: patch in place if the mode is unchanged, rebuild only if it flipped.
    function refresh() {
        try {
            const table = getTable();
            if (!table || !table.rows[0] || !table.rows[0].querySelector('.st-injected-total')) return;
            const sem = table.dataset.stSem || '';
            const items = dataRows(table).map((row) => ({ row, code: codeOf(row) }));
            const mode = computeMode(items, sem);

            if (table.dataset.stMode !== mode) { render(table, mode, sem); return; }
            if (mode === 'grades') {
                items.forEach(({ row, code }) => {
                    const span = row.querySelector('.st-grade-text');
                    if (span) setGradeText(span, code && mem.grades[code]);
                });
            }
        } catch (_) { }
    }

    // ---------- background check (server is the source of truth; never blocks the UI) ----------
    function revalidate(sem) {
        if (stopped || !sem || inFlight.has(sem) || verified(sem) || !alive()) return;

        const n = fails[sem] || 0;                                   // exponential backoff after failures
        if (n && Date.now() - (lastFail[sem] || 0) < Math.min(BASE_BACKOFF_MS * Math.pow(2, n - 1), MAX_BACKOFF_MS)) return;

        inFlight.add(sem);
        const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctl ? setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS) : 0;
        const body = new URLSearchParams({ Enrollment: '', Semester: sem });

        fetch('/Student/Academic/GetGradesForFaculty', {
            method: 'POST',
            credentials: 'same-origin',
            signal: ctl ? ctl.signal : undefined,
            priority: 'low',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: body.toString()
        })
            .then((r) => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
            .then((d) => {
                if (!d || !d.IsSuccessfull || !Array.isArray(d.InternalMarksList)) throw new Error('bad payload');

                markVerified(sem);
                fails[sem] = 0;

                // A real grade always beats a blank duplicate row.
                const fresh = {};
                d.InternalMarksList.forEach((item) => {
                    const code = item && item.CourseCode != null ? String(item.CourseCode).trim() : '';
                    if (!code || item.AcademicSession === 'Total') return;
                    const g = String(item.Grade == null ? '' : item.Grade).trim();
                    if (isReal(g)) fresh[code] = g;
                    else if (!(code in fresh)) fresh[code] = '';
                });

                const setG = {}, delG = [], delP = [];
                let anyReal = false;
                Object.keys(fresh).forEach((code) => {
                    if (fresh[code]) {
                        anyReal = true;
                        setG[code] = fresh[code];
                        mem.grades[code] = fresh[code];
                        if (code in mem.predicted) { delete mem.predicted[code]; delP.push(code); } // real beats prediction
                    } else if (code in mem.grades) {
                        delete mem.grades[code];                                                    // withdrawn / corrected
                        delG.push(code);
                    }
                });
                mem.noGrades[sem] = !anyReal;

                patch('subjectGrades', setG, delG);
                if (delP.length) patch('predictedGrades', {}, delP);
                patch('noGrades', { [sem]: !anyReal }, []);
                settled.add(sem);
            })
            .catch(() => {
                fails[sem] = (fails[sem] || 0) + 1;
                lastFail[sem] = Date.now();
                settled.add(sem);
            })
            .finally(() => {
                clearTimeout(timer);
                inFlight.delete(sem);
                refresh();
            });
    }

    // ---------- main ----------
    function fuse() {   // circuit breaker: if something keeps re-rendering, get out of the way for good
        stopped = true;
        try { obs.disconnect(); } catch (_) { /* ignore */ }
        const t = getTable();
        if (t) { try { teardown(t); } catch (_) { /* ignore */ } }
    }

    function run() {
        if (stopped || !ready) return;
        const table = getTable();
        if (!table) return;
        const head = table.rows[0];
        if (!head) return;

        // SLCM already shows grades natively -> stay out of the way.
        if (hasNativeGrade(head)) {
            const box = document.getElementById('st-predict-toggle-container');
            if (box) box.remove();
            document.body.classList.remove('st-pred-mode-on');
            return;
        }

        if (head.querySelector('.st-injected-total')) return;   // already done for this table
        const items = dataRows(table).map((row) => ({ row, code: codeOf(row) }));
        if (!items.length) return;

        const now = Date.now();
        renderTimes = renderTimes.filter((t) => now - t < 3000);
        if (renderTimes.length >= 10) { fuse(); return; }
        renderTimes.push(now);

        const ddl = document.getElementById('ddlSemester');
        const sem = lastSem || (ddl ? ddl.value : '');

        try {
            render(table, computeMode(items, sem), sem);   // same frame as the table, from memory
        } catch (_) {
            try { teardown(table); } catch (_) { /* ignore */ }   // leave SLCM's own table untouched
            return;
        }
        idle(() => {
            revalidate(sem);
            fetchAttendanceCourses();
            cacheCurrentMarks(table, sem);
        });                     // background only, off the critical path
    }

    async function cacheCurrentMarks(table, sem) {
        if (!table || !sem) return;
        try {
            const head = table.rows[0];
            if (!head) return;

            const cleanSem = (ROMAN_MAP[sem.toUpperCase()] || sem).toUpperCase();
            if (!cleanSem) return;

            const idx = [], headers = [];
            Array.from(head.cells).forEach((c, i) => {
                if (i < 2 || /\bst-injected-/.test(c.className) ||
                    /^(Credits|Grade|Total)$/i.test(c.textContent.trim())) return;
                idx.push(i);
                headers.push(c.textContent.trim());
            });

            const rows = [];
            dataRows(table).forEach((r) => {
                if (r.classList.contains('st-custom-row')) return;
                const values = idx.map((i) => (r.cells[i] ? r.cells[i].textContent.trim() : '') || '-');
                let total = 0, any = false;
                values.forEach((v) => {
                    const n = parseFloat(v);
                    if (!isNaN(n)) { total += n; any = true; }
                });
                values.push(any ? total.toFixed(2).replace(/\.00$/, '') : '-');
                rows.push({
                    sNo: r.cells[0] ? r.cells[0].textContent.trim() : '',
                    name: r.cells[1] ? r.cells[1].textContent.trim() : '',
                    code: codeOf(r),
                    values
                });
            });

            if (!rows.length) return;
            headers.push('Total');

            const stored = await sGet(['muj_marks_cache', 'muj_current_semester']);
            if (!stored) return;
            const cacheBySem = stored.muj_marks_cache || {};
            const record = {
                sem: cleanSem,
                headers,
                rows,
                lastUpdated: Date.now()
            };
            cacheBySem[cleanSem] = record;
            const payload = { muj_marks_cache: cacheBySem };

            let currentSem = stored && stored.muj_current_semester;
            if (!currentSem && typeof detectCurrentSemester === 'function') {
                currentSem = await detectCurrentSemester();
                if (currentSem) payload.muj_current_semester = currentSem;
            }

            const currentRoman = currentSem ? (ROMAN_MAP[currentSem.toUpperCase()] || currentSem).toUpperCase() : null;
            const currentNum = currentRoman ? (SEM_INT_MAP[currentRoman] || 0) : 0;
            const viewedNum = SEM_INT_MAP[cleanSem] || 0;

            // If this is the current semester OR it's a higher semester with verified marks rows,
            // promote current semester and update the dashboard's active marks cache.
            const isHigherWithMarks = viewedNum > currentNum && rows.length > 0;
            if ((currentRoman && currentRoman === cleanSem) || isHigherWithMarks) {
                payload.muj_internal_marks_cache = record;
                if (isHigherWithMarks) {
                    payload.muj_current_semester = cleanSem;
                }
            }
            await sSet(payload);
        } catch (_) { }
    }

    // ---------- print: SLCM prints #dvDetail.innerHTML in a popup (no CSS), so strip our UI first ----------
    function stripForPrint() {
        const table = getTable();
        if (!table) return;
        const removed = [];
        const take = (el) => {
            if (el && el.parentNode) {
                removed.push({ el, parent: el.parentNode, next: el.nextSibling });
                el.parentNode.removeChild(el);
            }
        };

        take(document.getElementById('st-predict-toggle-container'));
        take(document.getElementById('st-pred-gpa-row'));
        const sel = ['.st-credits-col', '.st-grade-input', '.st-grade-input-wrap', '.st-custom-row'];
        if (table.dataset.stMode !== 'grades') sel.push('.st-injected-grade', '.st-grade-cell');
        table.querySelectorAll(sel.join(',')).forEach(take);

        // SLCM's handler reads innerHTML synchronously in this same event; restore right after.
        setTimeout(() => {
            for (let i = removed.length - 1; i >= 0; i--) {
                const r = removed[i];
                r.parent.insertBefore(r.el, r.next && r.next.parentNode === r.parent ? r.next : null);
            }
        }, 0);
    }

    // Passive capture listener: never blocks or alters SLCM's own click handling.
    document.addEventListener('click', (e) => {
        if (stopped) return;
        const t = e.target;
        if (!t || !t.closest) return;
        if (t.closest('#btnSearch')) {
            const ddl = document.getElementById('ddlSemester');
            lastSem = ddl ? ddl.value : '';
        } else if (t.closest('#btnPrint')) {
            try { stripForPrint(); } catch (_) { /* never break printing */ }
        }
    }, true);

    ensureCss();

    // ---------- observer: watch only the results container, not the whole document ----------
    // Callbacks run as microtasks, before the browser paints => no un-enhanced flash.
    let observed = null;
    const obs = new MutationObserver((muts) => {
        if (stopped) return;
        let added = false;
        for (const m of muts) { if (m.addedNodes.length) { added = true; break; } }
        if (!added) return;
        if (observed === document.documentElement && getTable()) attach();   // table appeared: narrow down
        run();                                                              // early-exits cheaply when done
    });

    function attach() {
        const t = getTable();
        const root = t ? (document.getElementById('dvDetail') || t.parentNode) : document.documentElement;
        if (!root || root === observed) return;
        obs.disconnect();
        obs.observe(root, { childList: true, subtree: true });
        observed = root;
    }

    const ROMAN_MAP = {
        '1': 'I', '2': 'II', '3': 'III', '4': 'IV', '5': 'V',
        '6': 'VI', '7': 'VII', '8': 'VIII', '9': 'IX', '10': 'X',
        'I': 'I', 'II': 'II', 'III': 'III', 'IV': 'IV', 'V': 'V',
        'VI': 'VI', 'VII': 'VII', 'VIII': 'VIII', 'IX': 'IX', 'X': 'X'
    };

    const SEM_INT_MAP = {
        'I': 1, 'II': 2, 'III': 3, 'IV': 4, 'V': 5,
        'VI': 6, 'VII': 7, 'VIII': 8, 'IX': 9, 'X': 10,
        '1': 1, '2': 2, '3': 3, '4': 4, '5': 5,
        '6': 6, '7': 7, '8': 8, '9': 9, '10': 10
    };

    async function detectCurrentSemester() {
        if (typeof MujFish !== 'undefined' && MujFish.detectCurrentSemester) {
            return await MujFish.detectCurrentSemester();
        }
        try {
            const d = await sGet(['muj_current_semester', 'muj_internal_marks_cache']);
            if (d && d.muj_current_semester) return d.muj_current_semester;
            if (d && d.muj_internal_marks_cache && d.muj_internal_marks_cache.sem) {
                const s = d.muj_internal_marks_cache.sem.replace(/semester/i, '').trim();
                if (s) return s;
            }
        } catch (_) { }

        try {
            const res = await fetch('/Employee/EmployeeDirectory/IndexStudent', { credentials: 'same-origin' });
            if (res.ok) {
                const html = await res.text();
                const m = html.match(/Semester\s*<\/label>\s*<input[^>]*value=["']([^"']+)["']/i) ||
                          html.match(/Semester[^<]*<\/[a-z]+>\s*<[a-z]+[^>]*>([^<]+)<\/[a-z]+>/i) ||
                          html.match(/Semester\s*[:\-]?\s*(VIII|VII|VI|IV|IX|III|II|X|V|I|\d{1,2})\b/);
                if (m && m[1]) {
                    const v = m[1].trim();
                    sSet({ muj_current_semester: v });
                    return v;
                }
            }
        } catch (_) { }

        return null;
    }

    async function autoSelectSemester() {
        if (stopped) return;
        let target = null;
        const hashMatch = /^#sem=([A-Za-z0-9]{1,4})$/i.exec(location.hash);
        if (hashMatch) {
            target = hashMatch[1].toUpperCase();
        } else {
            try {
                const s = sessionStorage.getItem('muj_auto_open_sem');
                if (s) {
                    target = s.toUpperCase();
                    sessionStorage.removeItem('muj_auto_open_sem');
                }
            } catch (_) { }
        }

        if (!target) return;

        const targetRoman = (ROMAN_MAP[target] || target).toUpperCase();
        const ddl = document.getElementById('ddlSemester');
        const btn = document.getElementById('btnSearch') || document.querySelector('button[type="submit"], input[type="submit"]');
        if (!ddl || !btn) return;

        for (let i = 1; i < ddl.options.length; i++) {
            const opt = ddl.options[i];
            const txt = opt.text.trim().toUpperCase();
            const val = opt.value.trim().toUpperCase();
            if (txt === targetRoman || val === targetRoman || val === target ||
                (ROMAN_MAP[val] && ROMAN_MAP[val] === targetRoman)) {
                if (ddl.selectedIndex !== i) {
                    ddl.selectedIndex = i;
                    ddl.dispatchEvent(new Event('change', { bubbles: true }));
                }
                try {
                    if (location.hash) {
                        history.replaceState(null, '', location.pathname + location.search);
                    }
                } catch (_) { }
                const table = getTable();
                if (!table || table.rows.length <= 1) {
                    btn.click();
                }
                return;
            }
        }
    }

    attach();
    idle(autoSelectSemester);
    window.addEventListener('pagehide', () => { stopped = true; try { obs.disconnect(); } catch (_) { /* ignore */ } });
})();