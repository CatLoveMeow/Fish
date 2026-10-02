/* MUJ FISH - Grades Parser
 * Passive, local-only. No network requests. Never blocks the portal:
 * all work is debounced, runs on idle time, and stops itself on any trouble.
 */
(() => {
    'use strict';

    // Guard against double injection (SPA-style navigation / re-injection)
    if (window.__mujfishGradesParser) return;
    window.__mujfishGradesParser = true;

    const STORAGE_KEY = 'subjectGrades';
    const NOTE_ID = 'mujfish-grades-note';
    const STYLE_ID = 'mujfish-grades-style';
    const DEBOUNCE_MS = 500;
    const MAX_FAILURES = 3;

    // ---------- Extension API (Chrome + Firefox safe) ----------
    const usesPromiseApi = typeof browser !== 'undefined' && !!browser.storage;
    const api = usesPromiseApi ? browser : (typeof chrome !== 'undefined' ? chrome : null);
    const store = api && api.storage && api.storage.local;
    if (!store) return;

    // False after the extension is reloaded/updated ("context invalidated")
    const alive = () => {
        try { return !!(api.runtime && api.runtime.id); } catch (_) { return false; }
    };

    function call(method, arg) {
        try {
            if (usesPromiseApi) return Promise.resolve(store[method](arg));
            return new Promise((resolve, reject) => {
                store[method](arg, (v) => {
                    const err = chrome.runtime.lastError;
                    err ? reject(err) : resolve(v);
                });
            });
        } catch (e) {
            return Promise.reject(e);
        }
    }

    // ---------- State ----------
    let timer = 0;
    let running = false;
    let pending = false;
    let stopped = false;
    let failures = 0;
    let lastSig = '';
    let lastCount = 0;

    const idle = (cb) =>
        'requestIdleCallback' in window
            ? requestIdleCallback(cb, { timeout: 2000 })
            : setTimeout(cb, 50);

    // ---------- Parsing ----------
    // textContent (not innerText): innerText forces a layout reflow.
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

    // Known MUJ grade tokens. Single-letter allowlist avoids false positives like 'P','I','W','X'.
    const VALID_GRADES = new Set(['A+', 'A', 'B', 'C', 'D', 'E', 'F', 'S', 'W']);
    const isGrade = (g) => VALID_GRADES.has(g.toUpperCase().trim());
    const isCode = (c) => /^[A-Za-z0-9][A-Za-z0-9 \-\/&.]{1,24}$/.test(c);

    function readTable(table, isKnownTable) {
        if (!table.tBodies || !table.tBodies.length || table.rows.length < 2) return null;

        const headerRow = (table.tHead && table.tHead.rows[0]) || table.rows[0];
        const heads = Array.from(headerRow.cells).map((c) => clean(c.textContent).toLowerCase());

        let codeIdx = heads.findIndex((t) => /(course|subject)\s*code/.test(t));
        if (codeIdx < 0) codeIdx = heads.findIndex((t) => t === 'code');

        let gradeIdx = heads.findIndex((t) => t === 'grade');
        if (gradeIdx < 0) gradeIdx = heads.findIndex((t) => /grade/.test(t) && !/point|credit|scale/.test(t));

        // Fallback to the original fixed layout, but only for the known SLCM table
        if ((codeIdx < 0 || gradeIdx < 0) && isKnownTable && headerRow.cells.length >= 6) {
            codeIdx = 1;
            gradeIdx = 5;
        }
        if (codeIdx < 0 || gradeIdx < 0) return null;

        const need = Math.max(codeIdx, gradeIdx);
        const map = {};
        const gradeCells = [];

        for (const body of table.tBodies) {
            for (const row of body.rows) {
                const cells = row.cells;
                if (cells.length <= need) continue; // "No data available" / colspan rows
                const code = clean(cells[codeIdx].textContent);
                const grade = clean(cells[gradeIdx].textContent);
                if (!isCode(code) || !isGrade(grade)) continue; // never overwrite with junk like "-"
                map[code] = grade;
                gradeCells.push([cells[gradeIdx], grade]);
            }
        }

        const count = Object.keys(map).length;
        return count ? { map, gradeCells, table, count } : null;
    }

    function findGrades() {
        const known = document.getElementById('kt_ViewTable');
        if (known) {
            const r = readTable(known, true);
            if (r) return r;
        }
        // Pick the first table that actually *looks* like a grades table
        for (const t of document.getElementsByTagName('table')) {
            if (t === known) continue;
            const r = readTable(t, false);
            if (r) return r;
        }
        return null;
    }

    const signature = (map) =>
        Object.keys(map).sort().map((k) => k + '=' + map[k]).join('|');

    // ---------- Subtle UI ----------
    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const s = document.createElement('style');
        s.id = STYLE_ID;
        s.textContent = `
      .mujfish-grade{font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:.02em}
      .mujfish-grade-fail{color:#c0392b}
      #${NOTE_ID}{font:12px/1.4 Poppins,sans-serif;
        opacity:.75;margin:10px 2px 0;text-align:right;animation:mujfishFade .5s ease both}
      #${NOTE_ID}::before{content:"";display:inline-block;width:6px;height:6px;
        border-radius:50%;background:#2e9e6b;margin-right:6px;vertical-align:middle}
      @keyframes mujfishFade{from{opacity:0}to{opacity:.75}}
      @media (prefers-reduced-motion:reduce){#${NOTE_ID}{animation:none}}
    `;
        (document.head || document.documentElement).appendChild(s);
    }

    function decorate(found) {
        for (const [cell, grade] of found.gradeCells) {
            cell.classList.add('mujfish-grade');
            if (grade.toUpperCase() === 'F') cell.classList.add('mujfish-grade-fail');
        }
    }

    function ensureNote(found, count) {
        let note = document.getElementById(NOTE_ID);
        if (!note || !note.isConnected) {
            ensureStyle();
            note = document.createElement('div');
            note.id = NOTE_ID;
            note.title = 'Stored only in your browser. Nothing is sent anywhere.';
            const anchor = found.table.closest('.table-responsive') || found.table;
            anchor.insertAdjacentElement('afterend', note);
        }
        const text = count + (count === 1 ? ' grade' : ' grades') + ' saved locally \u00B7 MUJ FISH';
        if (note.textContent !== text) note.textContent = text;
    }

    // ---------- Main work ----------
    async function run() {
        if (stopped || running) return;
        if (document.hidden) { pending = true; return; } // don't work in background tabs
        if (!alive()) return shutdown();

        running = true;
        pending = false;
        try {
            const found = findGrades();
            if (!found) return;

            decorate(found);
            const sig = signature(found.map);

            if (sig === lastSig) { // nothing new: no storage reads/writes at all
                ensureNote(found, lastCount);
                return;
            }

            const data = await call('get', STORAGE_KEY);
            const existing =
                data && data[STORAGE_KEY] && typeof data[STORAGE_KEY] === 'object' ? data[STORAGE_KEY] : {};

            const merged = { ...existing };
            let changed = false;
            for (const k of Object.keys(found.map)) {
                if (merged[k] !== found.map[k]) { merged[k] = found.map[k]; changed = true; }
            }
            if (changed) await call('set', { [STORAGE_KEY]: merged });

            lastSig = sig;
            lastCount = found.count;
            failures = 0;
            ensureNote(found, found.count);
        } catch (_) {
            // Fail silently; give up after a few consecutive failures
            if (++failures >= MAX_FAILURES) shutdown();
        } finally {
            running = false;
        }
    }

    function schedule(delay = DEBOUNCE_MS) {
        if (stopped || timer) return;
        timer = setTimeout(() => {
            timer = 0;
            idle(run);
        }, delay);
    }

    function shutdown() {
        stopped = true;
        clearTimeout(timer);
        timer = 0;
        try { observer.disconnect(); } catch (_) { }
    }

    // ---------- Observer: O(1) work per mutation batch ----------
    const observer = new MutationObserver((mutations) => {
        if (stopped || timer) return; // already scheduled
        for (const m of mutations) {
            for (const n of m.addedNodes) {
                // Only element nodes, and ignore our own note to avoid feedback loops
                if (n.nodeType === 1 && n.id !== NOTE_ID) { schedule(); return; }
            }
        }
    });

    if (document.body) observer.observe(document.body, { childList: true, subtree: true });

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && pending) schedule(150);
    });
    window.addEventListener('pagehide', shutdown);

    schedule(300); // initial pass (replaces the old fixed 2s timeout)
})();