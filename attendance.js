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

    // ---------- Styles (one place, no inline CSS) ----------
    const CSS = `
    #st-bar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;
        margin:0 0 10px;padding:8px 12px;background:#f3f6f9;border-radius:6px;font-size:13px;
        user-select:none;-webkit-user-select:none}
    #st-bar[hidden]{display:none}
    .st-target{display:inline-flex;align-items:center;gap:6px;margin:0;font-weight:600;color:#464457}
    .st-target input{width:64px;padding:2px 4px;text-align:center;font-size:13px;
        border:1px solid #cbd5e1;border-radius:4px;background:#fff;transition:border-color .15s,box-shadow .15s}
    .st-target input:focus{outline:none;border-color:#5d78ff;box-shadow:0 0 0 2px rgba(93,120,255,.2)}
    #st-summary{color:#64748b;transition:color .2s}
    #st-summary.st-all-ok{color:#166534}
    th.st-th{text-align:center;background:#f3f6f9}
    td.st-td{text-align:center;font-weight:600;font-variant-numeric:tabular-nums}
    td.st-td[data-s="need"]{color:#b42318}
    td.st-td[data-s="ok"]{color:#166534}
    td.st-td[data-s="na"]{color:#94a3b8;font-weight:400}
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
        for (let i = 0; i < headRow.cells.length; i++) {
            const c = headRow.cells[i];
            if (c.id === 'st-classes-needed' || c.id === 'st-absences-custom') continue;
            const t = c.textContent.trim().toLowerCase();
            if (t === 'present') idx.present = i;
            else if (t === 'total') idx.total = i;
        }
        if (idx.present === undefined || idx.total === undefined) return null;
        return { headRow, idx };
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

        label.appendChild(input);
        label.appendChild(document.createTextNode('%'));

        summaryEl = document.createElement('span');
        summaryEl.id = 'st-summary';

        b.appendChild(label);
        b.appendChild(summaryEl);
        inputEl = input;
        return b;
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

        const rows = tbl.rows;
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (row === cols.headRow || row.querySelector('th')) continue;

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
                return;
            }
            mountBar();
            bar.hidden = false;
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