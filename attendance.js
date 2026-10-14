(() => {
    'use strict';

    const STORAGE_KEY = 'st_customTarget';
    const DEFAULT_TARGET = 75;
    const MIN_TARGET = 1;
    const MAX_TARGET = 99;
    const ROUND_UP_MARGIN = 1;       // portal rounds % up: target T is met when % > T-1
    const MAX_RUNS_PER_WINDOW = 30;  // runaway guard
    const WINDOW_MS = 3000;
    const COOLDOWN_MS = 5000;        // pause (not permanent shutdown) when the guard trips
    const SAVE_DEBOUNCE_MS = 400;

    const api = (typeof chrome !== 'undefined' && chrome.storage) ? chrome
        : (typeof browser !== 'undefined' && browser.storage) ? browser : null;
    const storage = api ? api.storage.local : null;

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
    try { cleanMode = localStorage.getItem('st_cleanMode') !== '0'; } catch(e) {}

    // ---------- Styles (one place, no inline CSS) ----------
    const CSS = `
    #st-bar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;
        margin:0 0 10px;padding:8px 12px;background:#f3f6f9;border-radius:6px;font-size:13px;
        user-select:none;-webkit-user-select:none}
    #st-bar[hidden],#st-attendance-toggle-container[hidden]{display:none!important}
    .st-target{display:inline-flex;align-items:center;gap:6px;margin:0;font-weight:600;color:#464457}
    .st-target input{width:46px;padding:2px;text-align:center;font-size:14px;font-weight:700;color:#5d78ff;
        border:none;border-bottom:2px dashed #cbd5e1;border-radius:0;background:transparent;transition:border-color .15s,color .15s}
    .st-target input:hover{border-color:#94a3b8;color:#464457}
    .st-target input:focus{outline:none;border-bottom:2px solid #5d78ff;color:#5d78ff}
    #st-summary{color:#64748b;transition:color .2s}
    #st-summary.st-all-ok{color:#166534}
    th.st-th{text-align:center;background:#f3f6f9}
    td.st-td{text-align:center;font-weight:500;font-variant-numeric:tabular-nums;color:#475569}
    td.st-td[data-s="need"]{color:#b42318}
    td.st-td[data-s="ok"]{color:#166534}
    td.st-td[data-s="na"]{color:#cbd5e1;font-weight:400}
    .st-toggle-switch{appearance:none;-webkit-appearance:none;width:36px;height:20px;background:#e2e8f0;border-radius:20px;position:relative;cursor:pointer;outline:none;transition:background 0.3s,box-shadow 0.3s;margin:0;flex-shrink:0;box-shadow:inset 0 1px 2px rgba(0,0,0,0.05)}
    .st-toggle-switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;background:#fff;border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,0.2);transition:transform 0.3s cubic-bezier(0.4,0,0.2,1)}
    .st-toggle-switch:checked{background:#10b981}
    .st-toggle-switch:checked::after{transform:translateX(16px)}
    .st-toggle-switch:focus-visible{box-shadow:0 0 0 2px rgba(16,185,129,0.3)}
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
    function classesNeeded(p, n, T) {
        const t = T - ROUND_UP_MARGIN;
        const num = t * n - 100 * p;
        if (num < 0) return 0;
        return Math.floor(num / (100 - t)) + 1;
    }

    function safeSkips(p, n, T) {
        const t = T - ROUND_UP_MARGIN;
        const s = 100 * p - t * n;
        if (s <= 0) return 0;
        if (t <= 0) return Infinity;
        return Math.floor((s - 1) / t);
    }

    // ---------- Helpers ----------
    function clampTarget(v) {
        const n = parseInt(v, 10);
        if (isNaN(n)) return DEFAULT_TARGET;
        return Math.min(MAX_TARGET, Math.max(MIN_TARGET, n));
    }

    function setText(el, s) {
        s = String(s);
        if (el.textContent !== s) el.textContent = s; // skip no-op writes
    }

    function setCell(cell, text, state) {
        setText(cell, text);
        if (cell.dataset.s !== state) cell.dataset.s = state;
    }

    // Debounced: typing "85" no longer writes storage twice
    function saveTarget(val) {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            try { if (storage) storage.set({ [STORAGE_KEY]: val }); } catch (e) { }
        }, SAVE_DEBOUNCE_MS);
    }

    // Non-blocking: the script never waits for storage
    function loadTarget() {
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
    function buildBar() {
        const b = document.createElement('div');
        b.id = 'st-bar';

        const label = document.createElement('label');
        label.className = 'st-target';
        label.appendChild(document.createTextNode('Target attendance'));

        const input = document.createElement('input');
        input.type = 'number';
        input.id = 'st-custom-target';
        input.value = customTarget;
        input.min = String(MIN_TARGET);
        input.max = String(MAX_TARGET);
        input.step = '1';
        input.inputMode = 'numeric';

        input.addEventListener('keydown', (e) => {
            if (['.', '-', '+', 'e', 'E'].includes(e.key)) e.preventDefault();
            if (e.key === 'Enter') input.blur();
        });
        input.addEventListener('input', () => {
            const val = parseInt(input.value, 10);
            // Only apply complete, valid numbers; blur fixes anything else
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

        const editIcon = document.createElement('span');
        editIcon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>`;
        editIcon.style.cssText = 'color:#94a3b8; cursor:text; margin-left:2px; transition:color 0.15s;';
        editIcon.onclick = () => input.focus();

        input.addEventListener('mouseenter', () => { editIcon.style.color = '#64748b'; });
        input.addEventListener('mouseleave', () => { editIcon.style.color = '#94a3b8'; });
        input.addEventListener('focus', () => { editIcon.style.color = '#5d78ff'; });
        input.addEventListener('blur', () => { editIcon.style.color = '#94a3b8'; });

        label.appendChild(input);
        label.appendChild(document.createTextNode('%'));
        label.appendChild(editIcon);

        summaryEl = document.createElement('span');
        summaryEl.id = 'st-summary';

        b.appendChild(label);
        b.appendChild(summaryEl);
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
        label.style.cssText = 'display:inline-flex;align-items:center;gap:8px;cursor:pointer;margin:0;user-select:none;-webkit-user-select:none;';
        label.title = 'Toggle extra columns (Status, Type, Section, Batch)';

        const btn = document.createElement('input');
        btn.type = 'checkbox';
        btn.className = 'st-toggle-switch';
        btn.checked = cleanMode;
        btn.title = 'Toggle extra columns (Status, Type, Section, Batch)';
        btn.setAttribute('aria-label', 'Toggle extra columns (Status, Type, Section, Batch)');
        btn.onchange = () => {
            cleanMode = btn.checked;
            try { localStorage.setItem('st_cleanMode', cleanMode ? '1' : '0'); } catch (e) {}
            schedule();
        };

        const span = document.createElement('span');
        span.textContent = 'Clean View';
        span.style.cssText = 'font-size:12px;font-weight:600;color:#64748b;line-height:1;';

        label.append(btn, span);
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
        headRow.appendChild(makeTh('st-classes-needed', 'Classes Needed',
            'Consecutive classes you must attend to reach your target'));
        headRow.appendChild(makeTh('st-absences-custom', 'Safe Skips',
            'Classes you can miss and still stay at or above your target'));
    }

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
            const p = parseInt(row.cells[present].textContent.trim(), 10);
            const n = parseInt(row.cells[total].textContent.trim(), 10);

            if (isNaN(p) || isNaN(n) || n <= 0) {
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
            table = document.getElementById('kt_ViewTable');
            if (!table) return;  // not our page, or the portal failed to render: do nothing
            injectStyles();
            observe();
            schedule();
            loadTarget();
        } catch (e) { }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();