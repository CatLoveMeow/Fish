// MUJ FISH - CGPA Predictor (optimized)
(() => {
    'use strict';
    if (window.__mujCgpaPredictor) return; // never double-inject
    window.__mujCgpaPredictor = true;

    const ID = 'muj-cgpa-predictor-container';
    const MAX_SEMS = 6, MAX_GPA = 10, MAX_CREDITS = 30;
    const W = 600, H = 160, PL = 34, PR = 20, PT = 24, PB = 26;

    const ICON_CHART = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>';
    const ICON_UP = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>';

    const CSS = `
#${ID}{box-sizing:border-box;margin:20px 0;padding:16px 20px;background:#fcfcfd;border:1px solid #e5e7eb;border-left:4px solid #17a2b8;border-radius:10px;box-shadow:0 2px 8px rgba(15,23,42,.05);display:flex;flex-direction:column;gap:12px;font-family:inherit;user-select:none;-webkit-user-select:none}
#${ID} *{box-sizing:border-box}
#${ID} .muj-row{display:flex;align-items:center;justify-content:space-between;gap:12px 20px;flex-wrap:wrap;width:100%}
#${ID} .muj-field{display:flex;align-items:center;gap:8px;margin:0;font-size:14px;font-weight:400;color:#555}
#${ID} .muj-title{color:#2c3e50;font-size:16px}
#${ID} .muj-input{padding:6px 10px;width:90px;border:1px solid #cbd5e1;border-radius:6px;outline:none;font-size:14px;background:#fff;transition:border-color .2s,box-shadow .2s;user-select:auto;-webkit-user-select:auto}
#${ID} .muj-input:focus{border-color:#17a2b8;box-shadow:0 0 0 3px rgba(23,162,184,.15)}
#${ID} .muj-input.muj-need{border-color:#f87171;box-shadow:0 0 0 3px rgba(248,113,113,.18)}
#${ID} .muj-btn{height:auto;min-width:0;line-height:1.4;white-space:nowrap;box-shadow:none;text-transform:none;padding:4px 10px;background:transparent;color:#64748b;border:1px solid #cbd5e1;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;outline:none;display:inline-flex;align-items:center;gap:6px;transition:background .2s,opacity .2s}
#${ID} .muj-btn svg{width:14px;height:14px;flex:none}
#${ID} .muj-btn:hover:not(:disabled){background:#f1f5f9}
#${ID} .muj-btn:focus-visible{box-shadow:0 0 0 3px rgba(23,162,184,.25)}
#${ID} .muj-btn:disabled{opacity:.45;cursor:default;pointer-events:none}
#${ID} .muj-add{color:#16a34a;border-color:#bbf7d0;background:#f0fdf4;padding:2px 8px;font-size:11px}
#${ID} .muj-rem{color:#dc2626;border-color:#fecaca;background:#fef2f2;padding:2px 8px;font-size:11px}
#${ID} .muj-result{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:16px;font-weight:600;color:#64748b}
#${ID} .muj-new{font-size:18px;color:#334155;transition:color .2s}
#${ID} .muj-delta{font-size:13px}
#${ID} .muj-sems{font-size:12px;font-weight:400;color:#94a3b8}
#${ID} .muj-chart{width:100%;overflow:hidden;max-height:0;opacity:0;transition:max-height .35s ease,opacity .35s ease}
#${ID} .muj-chart-inner{border-top:1px solid #e2e8f0;padding-top:14px;display:flex;flex-direction:column;align-items:center}
#${ID} .muj-svg{display:block;width:100%;max-width:600px;height:auto;overflow:visible;touch-action:none;user-select:none;-webkit-user-select:none}
@media print{#${ID}{display:none!important}}`;

    function injectStyles() {
        if (document.getElementById('muj-cgpa-style')) return;
        const s = document.createElement('style');
        s.id = 'muj-cgpa-style';
        s.textContent = CSS;
        document.head.appendChild(s);
    }

    const findTable = () => document.getElementById('kt_ViewTable') || document.querySelector('table');
    const toNum = (cell) => (cell ? parseFloat(cell.textContent.trim()) : NaN); // textContent: no forced layout

    // ---------- Read the native table ----------
    function readData(table) {
        let cgpaIdx = -1, credIdx = -1;
        for (const row of table.rows) {
            for (let c = 0; c < row.cells.length; c++) {
                const t = row.cells[c].textContent.trim();
                if (t === 'CGPA') cgpaIdx = c;
                else if (t === 'Total Credits') credIdx = c;
            }
            if (cgpaIdx !== -1 && credIdx !== -1) break;
        }
        if (cgpaIdx === -1 || credIdx === -1) return null;

        const start = Math.max(cgpaIdx, credIdx) + 1;
        for (const row of table.rows) {
            if (row.querySelector('th')) continue;
            const cgpa = toNum(row.cells[cgpaIdx]);
            const credits = toNum(row.cells[credIdx]);
            if (Number.isNaN(cgpa) || Number.isNaN(credits) || credits <= 0) continue;

            const gpas = [];
            let lastCredits = NaN;
            for (let i = start; i < row.cells.length; i += 2) {
                const g = toNum(row.cells[i]);
                if (!Number.isNaN(g) && g >= 0) { // skips "-" and NaN but allows 0.00
                    gpas.push(g);
                    lastCredits = toNum(row.cells[i + 1]);
                }
            }
            return { cgpa, credits, gpas, lastCredits, sig: [cgpa, credits, gpas.join(',')].join('|') };
        }
        return null;
    }

    // ---------- Build the predictor ----------
    function build(d) {
        if (d.gpas.length >= MAX_SEMS) return null; // nothing left to predict

        const chart = [...d.gpas];
        const hyp = chart.length; // index of first hypothetical semester
        chart.push(Math.round(((hyp ? chart[hyp - 1] : d.cgpa)) * 100) / 100);

        const hintCredits = d.lastCredits >= 1 && d.lastCredits <= MAX_CREDITS ? d.lastCredits : NaN;
        let gpaEmpty = false, interacted = false, open = false;
        let dragging = -1, rect = null, raf = 0, pendingY = 0, flashed = false, minGPA = 0;

        const box = document.createElement('div');
        box.id = ID;
        box.className = 'no-print hidden-print d-print-none exclude-from-export';
        box.innerHTML = `
            <div class="muj-row">
                <div class="muj-field">
                    <strong class="muj-title">CGPA Predictor</strong>
                    <button type="button" class="muj-btn muj-toggle" aria-expanded="false">${ICON_CHART}<span>Interactive Chart</span></button>
                </div>
                <label class="muj-field">Next SGPA:
                    <input type="number" class="muj-input muj-gpa" inputmode="decimal" step="0.01" min="0" max="${MAX_GPA}" placeholder="e.g. 9.0" aria-label="Expected SGPA for next semester">
                </label>
                <label class="muj-field">Credits / Sem:
                    <input type="number" class="muj-input muj-credits" inputmode="numeric" step="1" min="1" max="${MAX_CREDITS}" placeholder="e.g. 22" aria-label="Credits per future semester">
                </label>
                <div class="muj-result">
                    <span>New CGPA:</span><span class="muj-new">--</span>
                    <span class="muj-delta"></span><span class="muj-sems"></span>
                </div>
            </div>
            <div class="muj-chart" inert>
                <div class="muj-chart-inner" style="position:relative;">
                    <div style="position:absolute; right:0; top:14px; display:flex; gap:8px;">
                        <button type="button" class="muj-btn muj-rem" aria-label="Remove a semester">- Sem</button>
                        <button type="button" class="muj-btn muj-add" aria-label="Add a semester">+ Sem</button>
                    </div>
                    <div style="text-align:center; margin-bottom:12px; width:100%">
                        <strong style="display:block; color:#475569; font-size:14px; margin-bottom:2px;">Drag the dashed points to simulate future semesters</strong>
                        <span style="display:block; font-size:11px; color:#94a3b8; margin-bottom:8px;">Assumes the same credits for every future semester, so the real CGPA may differ slightly.</span>
                    </div>
                    <svg class="muj-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="GPA by semester"></svg>
                </div>
            </div>`;

        const $ = (s) => box.querySelector(s);
        const gpaIn = $('.muj-gpa'), credIn = $('.muj-credits'), svg = $('.muj-svg');
        const newEl = $('.muj-new'), deltaEl = $('.muj-delta'), semsEl = $('.muj-sems');
        const chartBox = $('.muj-chart'), toggle = $('.muj-toggle');
        const addBtn = $('.muj-add'), remBtn = $('.muj-rem');
        gpaIn.value = chart[hyp].toFixed(2);



        const validCredits = () => {
            const v = parseFloat(credIn.value);
            return v >= 1 && v <= MAX_CREDITS ? v : NaN;
        };

        function updateScale() {
            minGPA = Math.max(0, Math.floor(Math.min(...chart) - 1.5));
        }
        updateScale();

        // ---------- Chart ----------
        const X = (i) => PL + (i * (W - PL - PR)) / Math.max(1, chart.length - 1);
        const Y = (v) => H - PB - ((v - minGPA) / (MAX_GPA - minGPA)) * (H - PT - PB);

        function seg(a, b) {
            let p = `M ${X(a)} ${Y(chart[a])}`;
            for (let i = a + 1; i <= b; i++) {
                const m = (X(i - 1) + X(i)) / 2;
                p += ` C ${m} ${Y(chart[i - 1])}, ${m} ${Y(chart[i])}, ${X(i)} ${Y(chart[i])}`;
            }
            return p;
        }

        function render() {
            if (!open && dragging < 0) return; // don't draw what nobody can see
            const n = chart.length, last = n - 1;
            const fill = `${seg(0, last)} L ${X(last)} ${H - PB} L ${X(0)} ${H - PB} Z`;
            const from = Math.max(hyp - 1, 0);
            let pts = '', lbl = '';
            for (let i = 0; i < n; i++) {
                const x = X(i), y = Y(chart[i]);
                lbl += `<text x="${x}" y="${H - 6}" font-size="12" fill="#64748b" text-anchor="middle">S${i + 1}</text>`;
                if (i >= hyp) {
                    const ty = y < PT - 2 ? y + 24 : y - 14;
                    pts += `<circle cx="${x}" cy="${y}" r="8" fill="#f8fafc" stroke="#3b82f6" stroke-width="2.5" stroke-dasharray="3" style="pointer-events:none"/>
                            <circle class="muj-drag" data-index="${i}" cx="${x}" cy="${y}" r="20" fill="transparent" style="cursor:ns-resize"/>`;
                    lbl += `<text x="${x}" y="${ty}" font-size="11" fill="#3b82f6" font-weight="bold" text-anchor="middle" style="pointer-events:none">${chart[i].toFixed(2)}</text>`;
                } else {
                    pts += `<circle cx="${x}" cy="${y}" r="5" fill="#fff" stroke="#0ea5e9" stroke-width="2"/>`;
                }
            }
            svg.innerHTML = `
                <defs><linearGradient id="muj-grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#0ea5e9" stop-opacity="0.28"/><stop offset="100%" stop-color="#0ea5e9" stop-opacity="0"/>
                </linearGradient></defs>
                <line x1="${PL}" y1="${H - PB}" x2="${W - PR}" y2="${H - PB}" stroke="#e2e8f0"/>
                <line x1="${PL}" y1="${PT}" x2="${W - PR}" y2="${PT}" stroke="#e2e8f0" stroke-dasharray="4,4"/>
                <text x="${PL - 6}" y="${PT + 4}" font-size="10" fill="#94a3b8" text-anchor="end">${MAX_GPA}</text>
                <text x="${PL - 6}" y="${H - PB + 4}" font-size="10" fill="#94a3b8" text-anchor="end">${minGPA}</text>
                <path d="${fill}" fill="url(#muj-grad)"/>
                ${hyp >= 2 ? `<path d="${seg(0, hyp - 1)}" fill="none" stroke="#0ea5e9" stroke-width="3" stroke-linecap="round"/>` : ''}
                <path d="${seg(from, last)}" fill="none" stroke="#0ea5e9" stroke-width="3" stroke-linecap="round" stroke-dasharray="${hyp >= 1 ? '6,5' : '0'}" opacity="${hyp >= 1 ? 0.75 : 1}"/>
                ${lbl}${pts}`;
        }

        // ---------- Math ----------
        function calculate() {
            const cr = validCredits();
            const future = open ? chart.slice(hyp) : (gpaEmpty || chart.length <= hyp ? [] : [chart[hyp]]);
            const needCredits = Number.isNaN(cr) && interacted;
            credIn.classList.toggle('muj-need', needCredits);

            if (Number.isNaN(cr) || gpaEmpty || !future.length) {
                newEl.textContent = '--';
                newEl.style.color = '#334155';
                deltaEl.textContent = semsEl.textContent = '';
                return;
            }
            let pts = d.cgpa * d.credits, creds = d.credits;
            for (const g of future) { pts += g * cr; creds += cr; }
            const pred = Math.round((pts / creds) * 100) / 100;
            const diff = Math.round((pred - d.cgpa) * 100) / 100;

            newEl.textContent = pred.toFixed(2);
            const color = diff > 0 ? '#10b981' : diff < 0 ? '#ef4444' : '#3b82f6';
            newEl.style.color = color;
            deltaEl.style.color = color;
            deltaEl.textContent = diff === 0 ? '' : `${diff > 0 ? '+' : ''}${diff.toFixed(2)}`;
            semsEl.textContent = `after ${future.length} sem${future.length > 1 ? 's' : ''}`;
        }

        function flash() {
            if (credIn.animate) credIn.animate(
                [{ transform: 'translateX(0)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }],
                { duration: 280 });
        }

        function updateBtns() {
            addBtn.disabled = chart.length >= MAX_SEMS;
            remBtn.disabled = chart.length <= hyp;
        }

        // ---------- Dragging (pointer events: mouse + touch + pen, no global listeners) ----------
        function applyDrag() {
            raf = 0;
            if (dragging < 0 || !rect || !rect.height) return;
            const y = (pendingY - rect.top) * (H / rect.height);
            let v = minGPA + ((H - PB - y) / (H - PT - PB)) * (MAX_GPA - minGPA);
            v = Math.round(Math.min(MAX_GPA, Math.max(minGPA, v)) * 100) / 100;
            chart[dragging] = v;
            if (dragging === hyp) { gpaIn.value = v.toFixed(2); gpaEmpty = false; }
            if (Number.isNaN(validCredits()) && !flashed) { flashed = true; flash(); }
            render();
            calculate();
        }
        function endDrag() {
            if (dragging < 0) return;
            dragging = -1;
            if (raf) { cancelAnimationFrame(raf); raf = 0; }
            updateScale(); render(); calculate();
        }
        svg.addEventListener('pointerdown', (e) => {
            const t = e.target;
            if (!t.classList || !t.classList.contains('muj-drag')) return;
            e.preventDefault();
            dragging = +t.getAttribute('data-index');
            rect = svg.getBoundingClientRect();
            pendingY = e.clientY;
            flashed = false;
            interacted = true;
            try { svg.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
            calculate(); // shows the credits hint right away if missing
        });
        svg.addEventListener('pointermove', (e) => {
            if (dragging < 0) return;
            pendingY = e.clientY;
            if (!raf) raf = requestAnimationFrame(applyDrag);
        });
        ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => svg.addEventListener(ev, endDrag));

        // ---------- Inputs ----------
        gpaIn.addEventListener('keydown', (e) => { if (['-', '+', 'e', 'E'].includes(e.key)) e.preventDefault(); });
        credIn.addEventListener('keydown', (e) => { if (['-', '+', 'e', 'E', '.'].includes(e.key)) e.preventDefault(); });

        gpaIn.addEventListener('input', () => {
            interacted = true;
            if (gpaIn.value === '') { gpaEmpty = true; calculate(); return; }
            let v = parseFloat(gpaIn.value);
            if (Number.isNaN(v)) { calculate(); return; }
            if (v > MAX_GPA) { v = MAX_GPA; gpaIn.value = String(MAX_GPA); }
            if (v < 0) { v = 0; gpaIn.value = '0'; }
            gpaEmpty = false;
            chart[hyp] = v;
            updateScale(); render(); calculate();
        });
        credIn.addEventListener('input', () => {
            if (parseFloat(credIn.value) > MAX_CREDITS) credIn.value = String(MAX_CREDITS);
            calculate();
        });

        toggle.addEventListener('click', (e) => {
            e.preventDefault();
            open = !open;
            chartBox.style.maxHeight = open ? '480px' : '0';
            chartBox.style.opacity = open ? '1' : '0';
            chartBox.inert = !open;
            toggle.setAttribute('aria-expanded', String(open));
            toggle.innerHTML = open ? `${ICON_UP}<span>Close Chart</span>` : `${ICON_CHART}<span>Interactive Chart</span>`;
            updateBtns();
            calculate();
            render();
        });
        addBtn.addEventListener('click', () => {
            if (chart.length >= MAX_SEMS) return;
            chart.push(chart[chart.length - 1]);
            updateBtns(); updateScale(); render(); calculate();
        });
        remBtn.addEventListener('click', () => {
            if (chart.length <= hyp) return;
            chart.pop();
            updateBtns(); updateScale(); render(); calculate();
        });

        updateBtns();
        calculate();

        return box;
    }

    // ---------- Sync with the page ----------
    let currentSig = '';
    function sync() {
        const table = findTable();
        const existing = document.getElementById(ID);
        const data = table ? readData(table) : null;

        if (!data) { // table emptied / no valid row
            if (existing) existing.remove();
            currentSig = '';
            return;
        }
        if (existing && data.sig === currentSig) return; // nothing changed

        if (existing) existing.remove();
        currentSig = data.sig;
        const box = build(data);
        if (!box) {
            // All predictable semesters already completed — show a brief note instead of silence
            injectStyles();
            const note = document.createElement('div');
            note.id = ID;
            note.className = 'no-print hidden-print d-print-none exclude-from-export';
            note.style.cssText = 'margin:16px 0;padding:10px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;color:#64748b;text-align:center;';
            note.textContent = 'CGPA Predictor: All recorded semesters are complete — nothing left to simulate.';
            const dv = document.getElementById('dvDetail');
            if (dv && dv.parentNode) dv.parentNode.insertBefore(note, dv);
            else table.parentNode.insertBefore(note, table);
            return;
        }
        injectStyles();
        const dv = document.getElementById('dvDetail');
        if (dv && dv.parentNode) dv.parentNode.insertBefore(box, dv);
        else table.parentNode.insertBefore(box, table);
    }

    // Debounced + idle: never competes with SLCM's own rendering
    let timer = 0;
    function schedule() {
        if (timer) return;
        timer = setTimeout(() => {
            timer = 0;
            if (window.requestIdleCallback) requestIdleCallback(sync, { timeout: 800 });
            else sync();
        }, 120);
    }

    function start() {
        const table = findTable();
        if (!table) return false;
        // Watch ONLY the table (our UI lives outside it, so we never trigger ourselves)
        new MutationObserver(schedule).observe(table, { childList: true, subtree: true, characterData: true });
        schedule();
        return true;
    }

    function boot() {
        if (start()) return;
        // Table not in DOM yet: wait cheaply, then stop observing the whole body
        const bo = new MutationObserver(() => { if (start()) bo.disconnect(); });
        bo.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
})();