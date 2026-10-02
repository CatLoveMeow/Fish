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
    const KEYS = ['subjectGrades', 'courseCredits', 'predictedGrades', 'predEnabled', 'noGrades'];
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
    const mem = { grades: {}, credits: {}, predicted: {}, predEnabled: false, noGrades: {} };
    let ready = false;
    let stopped = false;
    let lastSem = '';
    let renderTimes = [];
    const settled = new Set();
    const inFlight = new Set();
    const lastFail = {};
    const fails = {};
    const lastOk = {};                     // in-memory fallback if sessionStorage is blocked

    sGet(KEYS).then((d) => {
        if (d) {
            mem.grades = d.subjectGrades || {};
            mem.credits = d.courseCredits || {};
            mem.predicted = d.predictedGrades || {};
            mem.predEnabled = !!d.predEnabled;
            mem.noGrades = d.noGrades || {};
        }
        ready = true;
        run();
    });

    // Merge (never replace) grades saved by the Grades-page parser.
    try {
        ext.storage.onChanged.addListener((ch, area) => {
            if (area === 'local' && ch.subjectGrades && ch.subjectGrades.newValue &&
                typeof ch.subjectGrades.newValue === 'object') {
                Object.assign(mem.grades, ch.subjectGrades.newValue);
            }
        });
    } catch (_) { /* ignore */ }

    // ---------- helpers (textContent, not innerText: no forced layout) ----------
    const getTable = () => document.getElementById('kt_ViewTable');

    const dataRows = (t) =>
        Array.from(t.rows).slice(1).filter((r) =>
            r.id !== 'st-pred-gpa-row' &&
            !r.classList.contains('grand-total-row') &&
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
      .st-grade-input { display:none; }
      .st-pred-mode-on .st-grade-input { display:inline-block; }
      .st-pred-mode-on .st-grade-text.st-missing { display:none; }
      
      .st-input-wrap { display:inline-flex; align-items:center; position:relative; }
      .st-spinners { display:flex; flex-direction:column; margin-left:4px; opacity:0; transition:opacity .15s; }
      .st-input-wrap:hover .st-spinners, .st-seamless-input:focus + .st-spinners { opacity:1; }
      .st-spinners button { background:none; border:none; padding:0; margin:0; font-size:9px; color:#adb5bd; cursor:pointer; line-height:1; border-radius:2px; height:10px; }
      .st-spinners button:hover { color:#495057; }
      .st-spinners button:focus-visible { outline:2px solid #80bdff; outline-offset:1px; }

      #st-predict-toggle-container .st-add-subj-btn, #st-predict-toggle-container .st-reset {
        height:auto; min-width:0; line-height:1.4; white-space:nowrap; box-shadow:none; text-transform:none; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:600; cursor:pointer; outline:none; transition:background .2s; margin-left:12px; display:none; vertical-align:middle;
      }
      .st-pred-mode-on #st-predict-toggle-container .st-add-subj-btn, .st-pred-mode-on #st-predict-toggle-container .st-reset { display:inline-flex; align-items:center; }
      
      #st-predict-toggle-container .st-add-subj-btn { color:#16a34a; border:1px solid #bbf7d0; background:#f0fdf4; }
      #st-predict-toggle-container .st-add-subj-btn:hover { background:#dcfce7; }
      
      #st-predict-toggle-container .st-reset { color:#64748b; border:1px solid #cbd5e1; background:#f8fafc; }
      #st-predict-toggle-container .st-reset:hover { background:#f1f5f9; }
      
      .st-custom-del { color:#dc2626; border:1px solid #fecaca; background:#fef2f2; cursor:pointer; font-size:11px; font-weight:600; margin-left:8px; padding:2px 6px; border-radius:4px; display:none; line-height:1.2; text-decoration:none; transition:background .2s; }
      .st-custom-del:hover { background:#fee2e2; color:#b91c1c; text-decoration:none; }
      .st-pred-mode-on .st-custom-del { display:inline-block; }

      #st-predict-toggle-container { margin-bottom:10px; display:flex; align-items:center; justify-content:flex-end; flex-wrap:wrap; gap:4px; }
      #st-predict-toggle-container label { cursor:pointer; font-weight:600; font-size:13px; color:#495057;
        user-select:none; margin:0; }
      #st-pred-gpa-row { display:none; }
      .st-pred-mode-on #st-pred-gpa-row { display:table-row; }
      #st-pred-gpa-row td { text-align:right; padding:12px 20px; font-weight:600; font-size:14px;
        color:#3f4254; border-top:1px solid #ebedf3; background:#f3f6f9; }
      #st-pred-gpa-val { color:#181c32; font-weight:800; font-size:16px; margin-left:10px; font-variant-numeric:tabular-nums; }
      #st-pred-gpa-sub { color:#7e8299; font-weight:500; font-size:12px; }

      @media (prefers-reduced-motion: reduce) { .st-seamless-input { transition:none; } }
      @media print {
        #st-predict-toggle-container, #st-pred-gpa-row,
        .st-credits-col, .st-grade-input { display:none !important; }
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
        wrap.className = 'st-input-wrap';

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
            td.append('Predicted Semester GPA: ');
            const val = document.createElement('span');
            val.id = 'st-pred-gpa-val';
            val.setAttribute('aria-live', 'polite');
            const sub = document.createElement('span');
            sub.id = 'st-pred-gpa-sub';
            td.append(val, sub);
            row.appendChild(td);
            (table.tBodies[0] || table).appendChild(row);
        }
        document.getElementById('st-pred-gpa-val').textContent = credits > 0 ? (points / credits).toFixed(2) : '-';
        document.getElementById('st-pred-gpa-sub').textContent =
            credits > 0 ? ' \u00B7 ' + credits + (credits === 1 ? ' credit' : ' credits') : '';
    }

    function syncToggle(table, predictor) {
        let box = document.getElementById('st-predict-toggle-container');

        if (!predictor) {
            if (box) {
                if (box._closePanelFn) document.removeEventListener('click', box._closePanelFn);
                box.remove();
            }
            document.body.classList.remove('st-pred-mode-on');
            return;
        }

        document.body.classList.toggle('st-pred-mode-on', mem.predEnabled);

        if (box) {   // survives across Find clicks: just refresh its state
            box.querySelector('input').checked = mem.predEnabled;
            const showExtras = mem.predEnabled ? '' : 'none';
            box.querySelector('.st-reset').style.display = showExtras;
            box.querySelector('.st-add-subj-btn').style.display = showExtras;
            return;
        }

        box = document.createElement('div');
        box.id = 'st-predict-toggle-container';

        const label = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.style.marginRight = '8px';
        cb.checked = mem.predEnabled;
        label.append(cb, 'Enable GPA Predictor');

        const reset = document.createElement('button');
        reset.type = 'button';
        reset.textContent = 'Reset predictions';
        reset.className = 'st-reset';

        const addSubj = document.createElement('button');
        addSubj.type = 'button';
        addSubj.textContent = '+ Subject';
        addSubj.className = 'st-add-subj-btn';

        cb.addEventListener('change', () => {
            mem.predEnabled = cb.checked;
            sSet({ predEnabled: cb.checked });
            document.body.classList.toggle('st-pred-mode-on', cb.checked);
            const t = getTable();
            if (t) updateGPA(t);
        });

        // Resolves the CURRENT table on click (the box outlives individual tables).
        reset.addEventListener('click', () => {
            const t = getTable();
            if (!t) return;
            const codes = [];
            dataRows(t).forEach((r) => {
                const c = codeOf(r);
                if (c && c in mem.predicted) { delete mem.predicted[c]; codes.push(c); }
            });
            if (codes.length) patch('predictedGrades', {}, codes);
            render(t, 'predictor', t.dataset.stSem || '');
        });

        addSubj.addEventListener('click', () => {
            const t = getTable();
            if (!t) return;
            if (dataRows(t).length >= 10) { alert('Maximum 10 subjects allowed for prediction.'); return; }

            const tbody = t.tBodies[0] || t;
            const row = document.createElement('tr');
            const code = 'CUS_' + Math.random().toString(36).substr(2, 5).toUpperCase();
            row.dataset.stCode = code;

            const nativeCols = t.rows[0].cells.length - t.querySelectorAll('.st-injected-total, .st-injected-credits, .st-injected-grade').length;
            for (let i = 0; i < nativeCols; i++) {
                const td = row.insertCell(-1);
                td.style.cssText = 'padding:10px; border-bottom:1px solid #ebedf3; text-align:center; vertical-align:middle;';
            }
            row.cells[0].textContent = '*';

            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = 'Custom Subject';
            input.className = 'st-seamless-input st-custom-name';
            input.style.width = '120px';
            input.style.textAlign = 'left';
            row.cells[1].style.textAlign = 'left';
            row.cells[1].appendChild(input);

            const del = document.createElement('span');
            del.className = 'st-custom-del';
            del.textContent = '\u2716';
            del.title = 'Remove Subject';
            del.onclick = () => {
                if (code in mem.predicted) { delete mem.predicted[code]; patch('predictedGrades', {}, [code]); }
                if (code in mem.credits) { delete mem.credits[code]; patch('courseCredits', {}, [code]); }
                row.remove();
                updateGPA(t);
            };
            row.cells[1].appendChild(del);

            const gpaRow = document.getElementById('st-pred-gpa-row');
            if (gpaRow) tbody.insertBefore(row, gpaRow);
            else tbody.appendChild(row);

            render(t, 'predictor', t.dataset.stSem || '');
        });

        const infoWrapper = document.createElement('div');
        infoWrapper.style.cssText = 'position: relative; display: inline-block; margin-left: 8px; vertical-align: middle; text-align: left;';

        const infoBtn = document.createElement('button');
        infoBtn.type = 'button';
        infoBtn.innerHTML = '&#9432;';
        infoBtn.className = 'btn btn-sm btn-link';
        infoBtn.style.cssText = 'padding: 0; text-decoration: none; font-size: 16px; outline: none; box-shadow: none; color: #a1a5b7; border: none; background: transparent; cursor: pointer; transition: color 0.2s;';
        infoBtn.title = 'Predictor Guide';

        const infoPanel = document.createElement('div');
        infoPanel.style.cssText = 'position:absolute;right:0;top:calc(100% + 8px);z-index:100;width:240px;visibility:hidden;pointer-events:none;background:#ffffff;border:1px solid #e4e6ef;border-radius:6px;padding:12px;font-size:12px;color:#5e6278;box-shadow:0 4px 12px rgba(0,0,0,0.1);opacity:0;transform:translateY(-4px);transition:opacity 0.2s,transform 0.2s;cursor:default;';
        infoPanel.innerHTML = `
            <div style="font-weight: 600; color: #3f4254; margin-bottom: 4px; font-size: 13px;">Predictor Guide</div>
            <div style="line-height: 1.5;">Enable the predictor to experiment with your scores. You can edit existing grades or add new subjects to see your potential GPA.</div>
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
        box._closePanelFn = closePanel;
        document.addEventListener('click', closePanel);

        infoWrapper.append(infoBtn, infoPanel);
        box.append(label, reset, addSubj, infoWrapper);
        table.parentNode.insertBefore(box, table);
    }

    // ---------- render (synchronous, idempotent) ----------
    function teardown(table) {
        table.querySelectorAll(INJECTED).forEach((el) => el.remove());
        const g = document.getElementById('st-pred-gpa-row');
        if (g) g.remove();
    }

    function render(table, mode, sem) {
        teardown(table);

        const head = table.rows[0];
        const items = dataRows(table).map((row) => ({ row, code: codeOf(row) }));
        if (!items.length) return;

        const predictor = mode === 'predictor';
        table.dataset.stMode = mode;
        table.dataset.stSem = sem;

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
        } catch (e) { console.debug('MUJFISH refresh failed', e); }
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
        } catch (e) {
            console.debug('MUJFISH render failed', e);
            try { teardown(table); } catch (_) { /* ignore */ }   // leave SLCM's own table untouched
            return;
        }
        idle(() => revalidate(sem));                     // background only, off the critical path
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
        const sel = ['.st-credits-col', '.st-grade-input'];
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

    attach();
    window.addEventListener('pagehide', () => { stopped = true; try { obs.disconnect(); } catch (_) { /* ignore */ } });
})();