(() => {
    'use strict';

    const MF = typeof window !== 'undefined' ? window.MujFish : null;
    const ATT_CONST = (MF && MF.CONSTANTS && MF.CONSTANTS.ATTENDANCE) || {
        DEFAULT_TARGET: 75,
        MIN_TARGET: 1,
        MAX_TARGET: 99,
        ROUND_UP_MARGIN: 1
    };
    const STORAGE_KEY = (MF && MF.CONSTANTS && MF.CONSTANTS.STORAGE_KEYS.CUSTOM_TARGET) || 'st_customTarget';
    const DEFAULT_TARGET = ATT_CONST.DEFAULT_TARGET;
    const MIN_TARGET = ATT_CONST.MIN_TARGET;
    const MAX_TARGET = ATT_CONST.MAX_TARGET;
    const ROUND_UP_MARGIN = ATT_CONST.ROUND_UP_MARGIN;
    const MAX_RUNS_PER_WINDOW = 30;  // runaway guard
    const WINDOW_MS = 3000;
    const COOLDOWN_MS = 5000;        // pause (not permanent shutdown) when the guard trips
    const SAVE_DEBOUNCE_MS = 400;

    const api = (typeof chrome !== 'undefined' && chrome.storage) ? chrome
        : (typeof browser !== 'undefined' && browser.storage) ? browser : null;
    const storage = (MF && MF.storage) ? MF.storage : (api ? api.storage.local : null);

    let customTarget = DEFAULT_TARGET;
    let userEdited = false;
    let table = null;
    let bar = null;
    let inputEl = null;
    let summaryEl = null;
    let pending = false;
    let runLog = [];
    let saveTimer = null;
    let cleanMode = true;
    try { cleanMode = localStorage.getItem('st_cleanMode') !== '0'; } catch (e) { }

    // ---------- Styles (one place, no inline CSS) ----------
    const CSS = `
    #st-bar{position:relative;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;
        margin:0 0 14px;padding:10px 14px;background:var(--mf-soft,#f8fafc);border:1px solid var(--mf-line,#e2e8f0);
        border-radius:var(--mf-radius,10px);box-shadow:var(--mf-shadow,0 1px 3px rgba(16,24,40,.04));font-size:13px;
        user-select:none;-webkit-user-select:none}
    #st-bar[hidden],#st-attendance-toggle-container[hidden]{display:none!important}
    .st-left{display:inline-flex;align-items:center;gap:10px;position:relative}
    .st-target{display:inline-flex;align-items:center;gap:8px;margin:0;font-weight:600;color:#334155}
    .st-target label{margin:0;cursor:pointer}
    .st-stepper{display:inline-flex;align-items:center;background:#fff;border:1.5px solid #cbd5e1;
        border-radius:50px;padding:2px 3px 2px 10px;box-shadow:0 1px 2px rgba(0,0,0,.04);transition:border-color .15s}
    .st-stepper:focus-within{border-color:#356ae6}
    .st-stepper input{width:22px;padding:0;border:none;background:transparent;text-align:right;
        font-size:14px;font-weight:700;color:#1e293b;-moz-appearance:textfield;appearance:textfield}
    .st-stepper input:focus{outline:none}
    .st-stepper input::-webkit-outer-spin-button,
    .st-stepper input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
    .st-pct{padding-right:6px;font-size:14px;font-weight:700;color:#64748b;cursor:text}
    .st-stepper-btns{display:flex;flex-direction:column;width:20px;height:26px;background:#356ae6;
        border-radius:14px;overflow:hidden;flex-shrink:0}
    .st-step{all:unset;display:flex;align-items:center;justify-content:center;height:50%;cursor:pointer;
        color:#fff;transition:background-color .15s,transform .1s}
    .st-step:hover{background:#2856c4}
    .st-step:active{background:#1f4299;transform:scale(0.92)}
    .st-step:focus-visible{outline:none;background:#2856c4}
    .st-arrow-up{width:0;height:0;border-left:3.5px solid transparent;border-right:3.5px solid transparent;border-bottom:4px solid #fff;display:block}
    .st-arrow-down{width:0;height:0;border-left:3.5px solid transparent;border-right:3.5px solid transparent;border-top:4px solid #fff;display:block}

    /* Info button & Popover */
    .st-info{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;
        border-radius:50%;background:#e2e8f0;color:#475569;border:none;font-size:11px;font-weight:700;
        cursor:pointer;line-height:1;padding:0;transition:all .15s;font-style:italic;font-family:serif}
    .st-info:hover{background:#cbd5e1;color:#1e293b}
    .st-info:focus-visible{outline:2px solid #356ae6;outline-offset:2px}
    .st-pop{display:none;position:absolute;top:calc(100% + 8px);left:14px;z-index:9999;
        background:#ffffff;border:1px solid #cbd5e1;border-radius:8px;padding:12px 14px;
        box-shadow:0 10px 25px -5px rgba(0,0,0,.1),0 8px 10px -6px rgba(0,0,0,.1);
        min-width:240px;max-width:320px;font-size:12px;color:#334155;line-height:1.45}
    .st-pop.open{display:block}
    .st-pop p{margin:0 0 8px}
    .st-pop p:last-child{margin:0}
    .st-pop b{color:#0f172a;display:inline-block;margin-bottom:2px}


    #st-summary{color:#64748b;font-weight:400;transition:color .2s}
    #st-summary.st-all-ok{color:#166534;font-weight:400}
    th.st-th{text-align:center;background:#f3f6f9}
    td.st-td{text-align:center;font-weight:400;font-variant-numeric:tabular-nums;color:#475569}
    td.st-td[data-s="need"]{color:#b42318;font-weight:400}
    td.st-td[data-s="ok"]{color:#166534;font-weight:400}
    td.st-td[data-s="na"]{color:#cbd5e1;font-weight:400}
    .st-switch{font-size:11px;position:relative;display:inline-flex;align-items:center;gap:8px;cursor:pointer}
    .st-switch input{position:absolute;opacity:0;width:0;height:0;pointer-events:none}
    .st-slider{position:relative;display:inline-block;width:3.2em;height:1.8em;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:50px;overflow:hidden;box-sizing:border-box;box-shadow:inset 0 1px 2px rgba(0,0,0,0.06);transition:all 0.35s cubic-bezier(0.215,0.61,0.355,1);flex-shrink:0}
    .st-slider::before{position:absolute;content:"";height:1.25em;width:1.25em;right:0.22em;bottom:0.18em;transform:translateX(160%);background-color:#10b981;border-radius:inherit;box-shadow:0 1px 3px rgba(0,0,0,0.15);transition:transform 0.35s cubic-bezier(0.215,0.61,0.355,1)}
    .st-slider::after{position:absolute;content:"";height:1.25em;width:1.25em;left:0.22em;bottom:0.18em;transform:translateX(0);background-color:#94a3b8;border-radius:inherit;box-shadow:0 1px 3px rgba(0,0,0,0.15);transition:transform 0.35s cubic-bezier(0.215,0.61,0.355,1)}
    .st-switch input:checked + .st-slider{background:#ecfdf5;border-color:#a7f3d0}
    .st-switch input:checked + .st-slider::before{transform:translateX(0)}
    .st-switch input:checked + .st-slider::after{transform:translateX(-160%)}
    .st-switch input:focus-visible + .st-slider{box-shadow:0 0 0 2px rgba(16,185,129,0.35)}
    @media print{#st-bar,#st-attendance-toggle-container{display:none!important}}
    `;

    function injectStyles() {
        if (document.getElementById('st-styles')) return;
        const s = document.createElement('style');
        s.id = 'st-styles';
        s.textContent = CSS;
        (document.head || document.documentElement).appendChild(s);
    }

    // ---------- Idle scheduling ----------
    const hasRIC = typeof requestIdleCallback === 'function';
    const later = (fn) => hasRIC ? requestIdleCallback(fn, { timeout: 1500 }) : setTimeout(fn, 150);

    // ---------- Math (exact integers) ----------
    /**
     * Calculates consecutive classes needed to reach target percentage.
     * @param {number} p Classes attended (present)
     * @param {number} n Total classes conducted
     * @param {number} T Target percentage (e.g. 75)
     * @returns {number}
     */
    const classesNeeded = (MF && MF.MATH && MF.MATH.classesNeeded) || function (p, n, T) {
        const t = T - ROUND_UP_MARGIN;
        const num = t * n - 100 * p;
        if (num < 0) return 0;
        return Math.floor(num / (100 - t)) + 1;
    };

    /**
     * Calculates how many upcoming classes can be safely skipped.
     * @param {number} p Classes attended (present)
     * @param {number} n Total classes conducted
     * @param {number} T Target percentage (e.g. 75)
     * @returns {number}
     */
    const safeSkips = (MF && MF.MATH && MF.MATH.safeSkips) || function (p, n, T) {
        const t = T - ROUND_UP_MARGIN;
        const s = 100 * p - t * n;
        if (s <= 0) return 0;
        if (t <= 0) return Infinity;
        return Math.floor((s - 1) / t);
    };

    const INT_REGEX = /^\d+$/;

    // ---------- Helpers ----------
    /**
     * Clamps user input target percentage within valid bounds [1..99].
     * @param {*} v Raw input value
     * @returns {number} Clamped target percentage integer
     */
    function clampTarget(v) {
        const s = String(v != null ? v : '').trim();
        if (!INT_REGEX.test(s)) return DEFAULT_TARGET;
        const n = parseInt(s, 10);
        return Math.min(MAX_TARGET, Math.max(MIN_TARGET, n));
    }

    /**
     * Efficiently writes textContent only when the value changes (avoids layout thrashing).
     * @param {HTMLElement} el
     * @param {*} s
     */
    function setText(el, s) {
        s = String(s);
        if (el.textContent !== s) el.textContent = s; // skip no-op writes
    }

    /**
     * Sets cell textContent and styling state attribute.
     * @param {HTMLTableCellElement} cell
     * @param {string} text
     * @param {string} state 'need' | 'ok' | 'na'
     */
    function setCell(cell, text, state) {
        setText(cell, text);
        if (cell.dataset.s !== state) cell.dataset.s = state;
    }

    /**
     * Debounced save of custom target to storage.
     * @param {number} val
     */
    function saveTarget(val) {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            if (MF && MF.storage && MF.storage.isAvailable()) {
                MF.storage.set(STORAGE_KEY, val);
            } else if (storage) {
                try { storage.set({ [STORAGE_KEY]: val }); } catch (e) { }
            }
        }, SAVE_DEBOUNCE_MS);
    }

    // Non-blocking: the script never waits for storage
    function loadTarget() {
        if (MF && MF.storage && MF.storage.isAvailable()) {
            MF.storage.get(STORAGE_KEY, DEFAULT_TARGET).then((val) => {
                if (userEdited) return;
                const v = clampTarget(val);
                if (v !== customTarget) {
                    customTarget = v;
                    if (inputEl && inputEl.isConnected) inputEl.value = v;
                    schedule();
                }
            }).catch(() => { });
            return;
        }
        if (!storage) return;
        try {
            storage.get(STORAGE_KEY, (data) => {
                try {
                    if (userEdited) return;
                    if (api.runtime && api.runtime.lastError) return;
                    if (data && data[STORAGE_KEY] != null) {
                        const v = clampTarget(data[STORAGE_KEY]);
                        if (v !== customTarget) {
                            customTarget = v;
                            if (inputEl && inputEl.isConnected) inputEl.value = v;
                            schedule();
                        }
                    }
                } catch (e) { }
            });
        } catch (e) { }
    }

    function getColumns(tbl) {
        const headRow = (tbl.tHead && tbl.tHead.rows[0]) || tbl.rows[0];
        if (!headRow) return null;
        const idx = {};
        const hideCols = [];
        const toHide = ['status', 'type', 'section', 'batch'];

        for (let i = 0; i < headRow.cells.length; i++) {
            const c = headRow.cells[i];
            if (c.id === 'st-classes-needed' || c.id === 'st-absences-custom') continue;
            const t = c.textContent.trim().toLowerCase();
            if (t === 'present') idx.present = i;
            else if (t === 'total') idx.total = i;
            else if (toHide.includes(t)) hideCols.push(i);
        }
        if (idx.present === undefined || idx.total === undefined) return null;
        return { headRow, idx, hideCols };
    }

    function dropOurCells(row) {
        row.querySelectorAll('.st-cn-td, .st-ac-td').forEach((el) => el.remove());
    }

    // Remove only OUR table elements; the portal's cells are never touched
    function removeOurs(tbl) {
        tbl.querySelectorAll('#st-classes-needed, #st-absences-custom, .st-cn-td, .st-ac-td')
            .forEach((el) => el.remove());
    }

    // ---------- Target bar (lives above the table, outside the portal's DOM) ----------
    function buildInfo() {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'st-info';
        btn.textContent = 'i';
        btn.setAttribute('aria-label', 'What do Can Skip and Must Attend mean?');
        btn.setAttribute('aria-expanded', 'false');

        const pop = document.createElement('div');
        pop.className = 'st-pop';
        pop.setAttribute('role', 'note');
        pop.innerHTML =
            '<p><b>Can Skip</b><br>How many classes you can miss and still stay at your goal.</p>' +
            '<p><b>Must Attend</b><br>How many classes in a row you need to attend to reach your goal.</p>';

        const setOpen = (o) => {
            pop.classList.toggle('open', o);
            btn.setAttribute('aria-expanded', String(o));
        };
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            setOpen(!pop.classList.contains('open'));
        });
        document.addEventListener('click', (e) => { if (!pop.contains(e.target)) setOpen(false); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });

        return { btn, pop };
    }


    function buildBar() {
        const b = document.createElement('div');
        b.id = 'st-bar';

        const left = document.createElement('div');
        left.className = 'st-left';

        const label = document.createElement('div');
        label.className = 'st-target';

        const labelText = document.createElement('label');
        labelText.htmlFor = 'st-custom-target';
        labelText.textContent = 'Attendance goal';
        label.appendChild(labelText);

        const input = document.createElement('input');
        input.type = 'text';
        input.id = 'st-custom-target';
        input.value = customTarget;
        input.inputMode = 'numeric';
        input.maxLength = 2;
        input.autocomplete = 'off';

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') input.blur();
        });
        input.addEventListener('input', () => {
            // digits only, also covers paste
            const clean = input.value.replace(/\D/g, '').slice(0, 2);
            if (input.value !== clean) input.value = clean;
            const val = parseInt(clean, 10);
            if (!isNaN(val) && val >= MIN_TARGET && val <= MAX_TARGET) {
                userEdited = true;
                customTarget = val;
                saveTarget(val);
                schedule();
            }
        });
        input.addEventListener('blur', () => {
            userEdited = true;
            customTarget = clampTarget(input.value || customTarget);
            input.value = customTarget;
            saveTarget(customTarget);
            schedule();
        });

        const step = (d) => {
            const current = parseInt(input.value, 10) || customTarget;
            const next = clampTarget(current + d);
            if (next === customTarget && input.value === String(next)) return;
            customTarget = next;
            input.value = customTarget;
            userEdited = true;
            saveTarget(customTarget);
            schedule();
        };

        const mkStep = (d, name, isUp) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'st-step';
            b.setAttribute('aria-label', name);
            const arrow = document.createElement('span');
            arrow.className = isUp ? 'st-arrow-up' : 'st-arrow-down';
            b.appendChild(arrow);

            let holdTimer = null;
            let repeatInterval = null;

            const stopHold = () => {
                if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
                if (repeatInterval) { clearInterval(repeatInterval); repeatInterval = null; }
                window.removeEventListener('mouseup', stopHold);
                window.removeEventListener('touchend', stopHold);
            };

            const startHold = (e) => {
                if (e.button !== undefined && e.button !== 0) return;
                stopHold();
                step(d);
                window.addEventListener('mouseup', stopHold);
                window.addEventListener('touchend', stopHold);
                holdTimer = setTimeout(() => {
                    repeatInterval = setInterval(() => step(d), 70);
                }, 320);
            };

            b.addEventListener('mousedown', startHold);
            b.addEventListener('touchstart', startHold, { passive: true });
            b.addEventListener('mouseleave', stopHold);
            b.addEventListener('touchcancel', stopHold);

            b.addEventListener('keydown', (e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                    e.preventDefault();
                    if (!holdTimer && !repeatInterval) startHold(e);
                }
            });
            b.addEventListener('keyup', (e) => {
                if (e.key === ' ' || e.key === 'Enter') stopHold();
            });

            // Prevent default click from triggering an extra redundant step
            b.addEventListener('click', (e) => e.preventDefault());

            return b;
        };

        const pct = document.createElement('span');
        pct.addEventListener('click', () => input.focus());
        pct.className = 'st-pct';
        pct.textContent = '%';

        const btns = document.createElement('div');
        btns.className = 'st-stepper-btns';
        btns.append(
            mkStep(1, 'Increase target', true),
            mkStep(-1, 'Decrease target', false)
        );

        const group = document.createElement('div');
        group.className = 'st-stepper';
        group.append(input, pct, btns);
        label.append(group);


        const info = buildInfo();
        left.append(label, info.btn);

        summaryEl = document.createElement('span');
        summaryEl.id = 'st-summary';

        b.append(left, summaryEl, info.pop);
        inputEl = input;
        return b;
    }

    let toggleContainer = null;
    let toggleBtn = null;

    function buildToggle() {
        const box = document.createElement('div');
        box.id = 'st-attendance-toggle-container';
        box.style.cssText = 'display:inline-flex;align-items:center;';

        const label = document.createElement('label');
        label.className = 'st-switch';
        label.title = 'Toggle extra columns (Status, Type, Section, Batch)';

        const btn = document.createElement('input');
        btn.type = 'checkbox';
        btn.checked = cleanMode;
        btn.title = 'Toggle extra columns (Status, Type, Section, Batch)';
        btn.setAttribute('aria-label', 'Toggle extra columns (Status, Type, Section, Batch)');
        btn.onchange = () => {
            cleanMode = btn.checked;
            try { localStorage.setItem('st_cleanMode', cleanMode ? '1' : '0'); } catch (e) { }
            schedule();
        };

        const slider = document.createElement('span');
        slider.className = 'st-slider';

        const span = document.createElement('span');
        span.textContent = 'Clean View';
        span.style.cssText = 'font-size:12px;font-weight:600;color:#64748b;line-height:1;user-select:none;';

        label.append(btn, slider, span);
        box.appendChild(label);
        toggleBtn = btn;
        return box;
    }

    function mountToggle() {
        if (!table) return;
        if (!toggleContainer) toggleContainer = buildToggle();
        if (toggleBtn) toggleBtn.checked = cleanMode;
        toggleContainer.hidden = false;

        if (toggleContainer.isConnected) return;

        const host = table.closest('.dataTables_wrapper, .table-responsive') || table;
        const portlet = table.closest('.kt-portlet, .card, .portlet, .box') || (host.parentNode && host.parentNode.closest('.kt-portlet, .card, .portlet, .box'));
        const head = (portlet && portlet.querySelector('.kt-portlet__head, .card-header, .portlet-title, .box-header')) ||
            (host.parentNode && host.parentNode.previousElementSibling);

        if (head) {
            let toolbar = head.querySelector('.kt-portlet__head-toolbar, .card-toolbar, .actions');
            if (!toolbar) {
                toolbar = document.createElement('div');
                toolbar.className = 'kt-portlet__head-toolbar';
                toolbar.style.cssText = 'display:flex;align-items:center;margin-left:auto;';
                head.style.display = 'flex';
                head.style.alignItems = 'center';
                head.style.justifyContent = 'space-between';
                head.appendChild(toolbar);
            }
            toolbar.appendChild(toggleContainer);
        } else if (bar && bar.isConnected) {
            // Safe fallback: keep inside bar if no header exists
            toggleContainer.style.marginLeft = '16px';
            bar.appendChild(toggleContainer);
        } else if (host.parentNode) {
            host.parentNode.insertBefore(toggleContainer, host);
        }
    }

    function mountBar() {
        if (bar && bar.isConnected) return;
        if (!bar) bar = buildBar();
        const host = table.closest('.dataTables_wrapper, .table-responsive') || table;
        if (host.parentNode) host.parentNode.insertBefore(bar, host);
    }

    // ---------- Table injection ----------
    function makeTh(id, text, tip) {
        const th = document.createElement('th');
        th.id = id;
        th.className = 'st-th';
        th.title = tip;
        th.textContent = text;
        return th;
    }

    function injectHeaders(headRow) {
        headRow.appendChild(makeTh('st-classes-needed', 'Must Attend',
            'Consecutive classes to attend to reach your target'));
        headRow.appendChild(makeTh('st-absences-custom', 'Can Skip',
            'Classes you can miss and still meet your target'));
    }

    /**
     * Ensures custom columns (Classes Needed and Safe Skips) exist in a table row.
     * @param {HTMLTableRowElement} row
     * @returns {{ cn: HTMLTableCellElement, ac: HTMLTableCellElement }}
     */
    function ensureCells(row) {
        let cn = row.querySelector('.st-cn-td');
        let ac = row.querySelector('.st-ac-td');
        if (!cn) { cn = row.insertCell(-1); cn.className = 'st-td st-cn-td'; }
        if (!ac) { ac = row.insertCell(-1); ac.className = 'st-td st-ac-td'; }
        return { cn, ac };
    }

    function update(tbl, cols) {
        const { present, total } = cols.idx;
        const minCols = Math.max(present, total); // minimum column index required in a data row
        let below = 0, counted = 0;

        // Hide columns in the header
        cols.hideCols.forEach(i => {
            if (cols.headRow.cells[i]) cols.headRow.cells[i].style.display = cleanMode ? 'none' : '';
        });

        const rows = tbl.rows;
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (row === cols.headRow || row.querySelector('th')) continue;

            // Hide columns in data rows
            cols.hideCols.forEach(colIdx => {
                if (row.cells[colIdx]) row.cells[colIdx].style.display = cleanMode ? 'none' : '';
            });

            // "No data" / colspan rows: leave the portal's row alone
            if (row.cells.length <= minCols || row.querySelector('td[colspan], td.dataTables_empty')) {
                dropOurCells(row);
                continue;
            }

            const { cn, ac } = ensureCells(row);
            const pText = row.cells[present] ? row.cells[present].textContent.trim() : '';
            const nText = row.cells[total] ? row.cells[total].textContent.trim() : '';
            const p = INT_REGEX.test(pText) ? parseInt(pText, 10) : NaN;
            const n = INT_REGEX.test(nText) ? parseInt(nText, 10) : NaN;

            if (isNaN(p) || isNaN(n) || n <= 0 || p > n) {
                setCell(cn, '–', 'na');
                setCell(ac, '–', 'na');
                continue;
            }

            counted++;
            const needed = classesNeeded(p, n, customTarget);
            const skips = safeSkips(p, n, customTarget);
            if (needed > 0) below++;

            setCell(cn, needed === 0 ? '–' : needed, needed === 0 ? 'ok' : 'need');
            setCell(ac, skips === Infinity ? '∞' : skips, skips > 0 ? 'ok' : 'na');
        }

        try {
            const courseNames = [];
            for (let i = 0; i < rows.length; i++) {
                const r = rows[i];
                if (r === cols.headRow || r.querySelector('th') || r.cells.length <= minCols) continue;
                const txt = r.cells[1] ? r.cells[1].textContent.trim() : '';
                if (txt && !courseNames.includes(txt)) courseNames.push(txt);
            }
            if (courseNames.length) sessionStorage.setItem('mujfish_att_courses', JSON.stringify(courseNames));
        } catch (_) { }

        if (summaryEl) {
            const allOk = counted > 0 && below === 0;
            summaryEl.classList.toggle('st-all-ok', allOk);
            setText(summaryEl, counted === 0 ? ''
                : allOk ? `All courses at or above ${customTarget}%`
                    : `${below} of ${counted} course${counted === 1 ? '' : 's'} below ${customTarget}%`);
        }
    }

    // ---------- Lifecycle ----------
    const observer = new MutationObserver(schedule);
    // Watches for the portal table being inserted or replaced. The callback ignores
    // ordinary edits inside the same table, so it won't duplicate the table observer.
    const discoveryObserver = new MutationObserver(() => {
        const current = document.getElementById('kt_ViewTable');
        if (current && current !== table) {
            table = current;
            schedule();
        } else if (!current && table && !table.isConnected) {
            table = null;
        }
    });

    function observe() {
        if (table && table.isConnected) {
            observer.observe(table, { childList: true, subtree: true });
        }
    }

    // True if we're re-running suspiciously often
    function runawayGuard() {
        const now = Date.now();
        runLog = runLog.filter((t) => now - t < WINDOW_MS);
        runLog.push(now);
        return runLog.length > MAX_RUNS_PER_WINDOW;
    }

    // Many mutations -> one pending idle run
    function schedule() {
        if (pending) return;
        pending = true;
        later(run);
    }

    function run() {
        pending = false;
        if (runawayGuard()) {
            // Pause briefly instead of dying for good, then pick up again
            observer.disconnect();
            setTimeout(() => { runLog = []; observe(); schedule(); }, COOLDOWN_MS);
            return;
        }

        observer.disconnect(); // our own edits must not retrigger us
        try {
            if (!table || !table.isConnected) table = document.getElementById('kt_ViewTable');
            if (!table) return;
            const cols = getColumns(table);
            if (!cols) {         // error/open/closed layout: leave the portal alone
                removeOurs(table);
                if (bar) bar.hidden = true;
                if (toggleContainer) toggleContainer.hidden = true;
                return;
            }
            mountBar();
            mountToggle();
            bar.hidden = false;
            if (toggleContainer) toggleContainer.hidden = false;
            if (!table.querySelector('#st-classes-needed')) injectHeaders(cols.headRow);
            update(table, cols);
        } catch (e) {
            // never let an error escape
        } finally {
            observe();
        }
    }

    function start() {
        try {
            // SLCM can render the attendance table after DOMContentLoaded. Keep a light
            // document-level watcher active so late loads and table replacements recover.
            if (document.documentElement) {
                discoveryObserver.observe(document.documentElement, { childList: true, subtree: true });
            }
            table = document.getElementById('kt_ViewTable');
            if (!table) return;
            injectStyles();
            observe();
            schedule();
            loadTarget();
        } catch (e) { }
    }

    window.addEventListener('pagehide', () => {
        try { observer.disconnect(); } catch (_) { }
        try { discoveryObserver.disconnect(); } catch (_) { }
        try { clearTimeout(saveTimer); } catch (_) { }
    }, { once: true });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();