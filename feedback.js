/**
 * MUJ FISH - Student Survey & Feedback Automation
 * Target URLs:
 *  - *://mujslcm.jaipur.manipal.edu/Student/Survey/FeedbackList*
 *  - *://mujslcm.jaipur.manipal.edu/Student/Survey/Feedback*
 * Runs in "world": "MAIN" to directly interact with portal form scripts & state.
 */
(() => {
    'use strict';

    if (window.__mujfishFeedbackLoaded) return;

    const PATH = window.location.pathname || '';
    const IS_LIST_PAGE = PATH.includes('/Student/Survey/FeedbackList');
    const IS_FORM_PAGE = PATH.includes('/Student/Survey/Feedback') && !IS_LIST_PAGE;
    if (!IS_LIST_PAGE && !IS_FORM_PAGE) return;
    window.__mujfishFeedbackLoaded = true;

    // ---------- Constants ----------
    const STORAGE_KEY_CONFIG = 'mujfish_fb_config';
    const STORAGE_KEY_BATCH = 'mujfish_fb_batch';
    const STORAGE_KEY_SINGLE = 'mujfish_fb_single';
    const SESSION_KEY_BATCH_ACTIVE = 'mujfish_fb_batch_active';
    const BATCH_TTL_MS = 5 * 60 * 1000;
    const SINGLE_TTL_MS = 60 * 1000;
    const MAX_REMARK = 250;          // portal limit
    const MAX_ATTEMPTS = 2;          // tries per course before the batch gives up on it
    const BATCH_DELAY_MS = 1500;     // pause between courses
    const FORM_SUBMIT_DELAY_MS = 1200;

    const MODES = [
        { id: 'mostly_yes', label: 'Mostly yes', dot: 'green', tip: 'Realistic high score (about 90% Yes, natural variation)' },
        { id: 'all_yes', label: 'All yes', dot: 'blue', tip: '100% Yes answers' },
        { id: 'random', label: 'Random mix', dot: 'purple', tip: 'Random mix of Yes and No' },
        { id: 'all_no', label: 'All no', dot: 'red', tip: '100% No answers' }
    ];
    const MODE_IDS = MODES.map((m) => m.id);

    // Curated polite remarks (all well under the portal's 250 character limit)
    const REMARKS_LIST = [
        "Excellent teaching methodology and clear explanations throughout the semester.",
        "Very approachable faculty, doubts were resolved promptly and clearly.",
        "Theory was complemented well with practical examples. Highly engaging lectures.",
        "Well organized lectures, punctual, and maintains a very conducive learning atmosphere.",
        "Great subject knowledge and passion for teaching. Kept the class interactive.",
        "Clear presentation of difficult concepts, making them simpler to understand.",
        "Fair evaluations, timely feedback on assignments, and comprehensive coverage of topics.",
        "Encouraged active participation and critical thinking. Great learning experience.",
        "Interactive sessions, prompt communication, and very supportive guidance.",
        "Lectures were well structured and aligned perfectly with course learning outcomes."
    ];
    const PRESET_INDEX = { excellent: 0, approachable: 1, practical: 2 };

    const REMARK_OPTIONS = [
        ['random', 'Use varied suggested remarks'],
        ['excellent', 'Clear explanations & thorough teaching'],
        ['approachable', 'Approachable faculty & quick doubt resolution'],
        ['practical', 'Practical examples & engaging discussions'],
        ['custom', 'Custom comment...'],
        ['blank', 'Leave blank']
    ];
    const REMARK_IDS = REMARK_OPTIONS.map((o) => o[0]);

    const DEFAULT_CONFIG = {
        enabled: true,
        mode: 'mostly_yes',
        remarkPreset: 'random',
        customRemark: 'Great teaching style and very supportive in doubts.',
        autoSubmit: false
    };

    // ---------- Helpers ----------
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    const storage = {
        get(key, fallback = null) {
            try {
                const val = localStorage.getItem(key);
                return val ? JSON.parse(val) : fallback;
            } catch (_) { return fallback; }
        },
        set(key, val) {
            try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (_) { return false; }
        },
        remove(key) {
            try { localStorage.removeItem(key); return true; } catch (_) { return false; }
        }
    };

    // Always returns a valid config, even if storage holds junk
    function getConfig() {
        const c = Object.assign({}, DEFAULT_CONFIG, storage.get(STORAGE_KEY_CONFIG, {}));
        if (typeof c.enabled !== 'boolean') c.enabled = true;
        if (!MODE_IDS.includes(c.mode)) c.mode = DEFAULT_CONFIG.mode;
        if (!REMARK_IDS.includes(c.remarkPreset)) c.remarkPreset = DEFAULT_CONFIG.remarkPreset;
        c.customRemark = String(c.customRemark == null ? '' : c.customRemark).slice(0, MAX_REMARK);
        c.autoSubmit = !!c.autoSubmit;
        return c;
    }

    function saveConfig(updates) {
        const next = Object.assign({}, getConfig(), updates);
        storage.set(STORAGE_KEY_CONFIG, next);
        return next;
    }

    // Active batch, or null.
    // Tied to this browser tab via sessionStorage so fresh tab/page opens NEVER resume stale batches.
    function getBatch() {
        try {
            if (sessionStorage.getItem(SESSION_KEY_BATCH_ACTIVE) !== '1') return null;
        } catch (_) { return null; }
        const b = storage.get(STORAGE_KEY_BATCH, null);
        if (!b || !b.active) {
            try { sessionStorage.removeItem(SESSION_KEY_BATCH_ACTIVE); } catch (_) { }
            storage.remove(STORAGE_KEY_BATCH);
            return null;
        }
        if (Date.now() - (b.lastActive || b.startedAt || 0) > BATCH_TTL_MS) {
            try { sessionStorage.removeItem(SESSION_KEY_BATCH_ACTIVE); } catch (_) { }
            storage.remove(STORAGE_KEY_BATCH);
            return null;
        }
        if (!b.attempts) b.attempts = {};
        return b;
    }

    function getRemarkText(preset, customText) {
        if (preset === 'blank') return '';
        if (preset === 'custom') return String(customText || '').trim().slice(0, MAX_REMARK);
        if (preset in PRESET_INDEX) return REMARKS_LIST[PRESET_INDEX[preset]];
        return REMARKS_LIST[Math.floor(Math.random() * REMARKS_LIST.length)];
    }

    function pillsHtml(id, active) {
        return `<div class="mf-pills" id="${id}" role="group" aria-label="Answer mode">` +
            MODES.map((m) =>
                `<button type="button" class="mf-pill-btn${m.id === active ? ' active' : ''}" data-mode="${m.id}" ` +
                `aria-pressed="${m.id === active}" title="${esc(m.tip)}">` +
                `<span class="mf-pill-dot mf-dot-${m.dot}"></span>${esc(m.label)}</button>`
            ).join('') + '</div>';
    }

    function markActivePill(root, mode) {
        root.querySelectorAll('[data-mode]').forEach((b) => {
            const on = b.dataset.mode === mode;
            b.classList.toggle('active', on);
            b.setAttribute('aria-pressed', String(on));
        });
    }

    // ---------- Styles ----------
    function injectStyles() {
        if (document.getElementById('mujfish-feedback-styles')) return;
        const style = document.createElement('style');
        style.id = 'mujfish-feedback-styles';
        style.textContent = `
        .mf-fb-card,.mf-form-toolbar{
            --mf-ink:#202938;--mf-muted:#697586;--mf-line:#e2e8f0;--mf-soft:#fbfcfd;--mf-radius:8px;
            background:var(--mf-soft);border:1px solid var(--mf-line);border-radius:var(--mf-radius);
            font-family:inherit;color:var(--mf-ink);box-sizing:border-box}
        .mf-fb-card{box-shadow:0 1px 3px rgba(16,24,40,.04);padding:12px 16px;margin:0 0 16px;position:relative}

        .mf-fb-header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;
            margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--mf-line)}
        .mf-fb-title{font-size:13px;font-weight:650;color:#1e293b;letter-spacing:-.01em;margin:0}
        .mf-fb-subtitle{display:block;font-size:12px;color:#64748b;margin-top:1px}
        .mf-fb-badge{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:5px;font-size:12px;font-weight:600}
        .mf-badge-pending{background:#fff7ed;color:#c2410c;border:1px solid #fed7aa}
        .mf-badge-success{background:#eef6f2;color:#32735e;border:1px solid #c8ded3}
        .mf-badge-running{background:#f0f4f7;color:#2856c4;border:1px solid #bfdbfe}
        .mf-status-dot{width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block}

        .mf-fb-controls{display:flex;flex-direction:column;gap:12px}
        .mf-fb-row{display:flex;align-items:center;flex-wrap:wrap;gap:12px;justify-content:space-between}
        .mf-fb-group{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
        .mf-fb-group-label{font-size:11px;font-weight:650;text-transform:uppercase;letter-spacing:.04em;color:#64748b}

        .mf-pills{display:inline-flex;align-items:center;background:#f5f7f9;border:1px solid #e3e8ee;
            border-radius:6px;padding:2px;gap:2px;flex-wrap:wrap}
        .mf-pill-btn{background:transparent;border:none;cursor:pointer;padding:5px 10px;font:550 12px/1.4 inherit;
            color:#64748b;border-radius:5px;display:inline-flex;align-items:center;gap:6px;user-select:none;white-space:nowrap}
        .mf-pill-btn:hover{color:#1e293b;background:rgba(255,255,255,.6)}
        .mf-pill-btn.active{background:#fff;color:#1e293b;font-weight:650;box-shadow:0 1px 2px rgba(16,24,40,.08)}
        .mf-pill-dot{width:6px;height:6px;border-radius:50%;opacity:.7}
        .mf-pill-btn.active .mf-pill-dot{opacity:1}
        .mf-dot-green{background:#16a34a}.mf-dot-blue{background:#355f7d}
        .mf-dot-purple{background:#8b5cf6}.mf-dot-red{background:#dc2626}

        .mf-select,.mf-input-text{padding:5px 10px;border-radius:6px;border:1px solid #cbd5e1;background:#fff;
            font:500 12px/1.4 inherit;color:#1e293b;outline:none}
        .mf-select{cursor:pointer;max-width:420px}
        .mf-input-text{flex:1;min-width:220px}
        .mf-select:focus,.mf-input-text:focus{border-color:#355f7d;box-shadow:0 0 0 2px rgba(53,95,125,.15)}

        .mf-btn-primary,.mf-btn-secondary,.mf-btn-danger,.mf-quick-fill-btn{
            border-radius:6px;padding:5px 13px;font:600 12px/1.4 inherit;cursor:pointer;
            display:inline-flex;align-items:center;gap:6px;user-select:none}
        .mf-btn-primary{background:#355f7d;color:#fff;border:1px solid #294c65;box-shadow:0 1px 2px rgba(0,0,0,.05)}
        .mf-btn-primary:hover{background:#294c65}
        .mf-btn-secondary{background:#fff;color:#475569;border:1px solid #cbd5e1}
        .mf-btn-secondary:hover{background:#f5f7f9;color:#1e293b;border-color:#94a3b8}
        .mf-btn-danger{color:#b42336;border:1px solid #fecaca;background:#fff0f1}
        .mf-btn-danger:hover{background:#fee2e2;color:#7a1a25;border-color:#fca5a5}
        .mf-quick-fill-btn{margin-left:8px;padding:3px 10px;color:#355f7d;background:transparent;border:1px solid #d6e0e7;font-weight:550}
        .mf-quick-fill-btn:hover{color:#294c65;background:#f0f4f7;border-color:#b8cbd8}
        .mf-fb-card button:disabled,.mf-form-toolbar button:disabled{opacity:.48;cursor:not-allowed}
        .mf-fb-card button:focus-visible,.mf-form-toolbar button:focus-visible,
        .mf-fb-card select:focus-visible,.mf-fb-card input:focus-visible{outline:2px solid #7b9db4;outline-offset:2px}

        .st-switch,.mf-switch{font-size:11px;position:relative;display:inline-flex;align-items:center;gap:8px;cursor:pointer}
        .st-switch input,.mf-switch input{position:absolute;opacity:0;width:0;height:0;pointer-events:none}
        .st-slider,.mf-slider{position:relative;display:inline-block;width:3.2em;height:1.8em;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:50px;overflow:hidden;box-sizing:border-box;box-shadow:inset 0 1px 2px rgba(0,0,0,0.06);transition:all 0.35s cubic-bezier(0.215,0.61,0.355,1);flex-shrink:0}
        .st-slider::before,.mf-slider::before{position:absolute;content:"";height:1.25em;width:1.25em;right:0.22em;bottom:0.18em;transform:translateX(160%);background-color:#10b981;border-radius:inherit;box-shadow:0 1px 3px rgba(0,0,0,0.15);transition:transform 0.35s cubic-bezier(0.215,0.61,0.355,1)}
        .st-slider::after,.mf-slider::after{position:absolute;content:"";height:1.25em;width:1.25em;left:0.22em;bottom:0.18em;transform:translateX(0);background-color:#94a3b8;border-radius:inherit;box-shadow:0 1px 3px rgba(0,0,0,0.15);transition:transform 0.35s cubic-bezier(0.215,0.61,0.355,1)}
        .st-switch input:checked + .st-slider,.mf-switch input:checked + .mf-slider{background:#ecfdf5;border-color:#a7f3d0}
        .st-switch input:checked + .st-slider::before,.mf-switch input:checked + .mf-slider::before{transform:translateX(0)}
        .st-switch input:checked + .st-slider::after,.mf-switch input:checked + .mf-slider::after{transform:translateX(-160%)}
        .st-switch input:focus-visible + .st-slider,.mf-switch input:focus-visible + .mf-slider{box-shadow:0 0 0 2px rgba(16,185,129,0.35)}

        .mf-batch-banner{background:#f0fdf4;color:#166534;border:1px solid #bbf7d0;border-radius:8px;padding:10px 14px;
            display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
        .mf-batch-info{display:flex;align-items:center;gap:10px}
        .mf-spinner{width:15px;height:15px;border:2px solid rgba(22,101,52,.25);border-top-color:#166534;
            border-radius:50%;animation:mfSpin .7s linear infinite}
        @keyframes mfSpin{to{transform:rotate(360deg)}}
        .mf-batch-text{font-size:12.5px;font-weight:600}
        .mf-batch-sub{font-size:11px;color:#15803d;margin-top:1px}

        .mf-form-toolbar{position:sticky;top:65px;z-index:1000;box-shadow:0 4px 12px rgba(15,23,42,.06);
            padding:10px 14px;margin:0 0 14px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
        .mf-form-head{font-size:13px;font-weight:650;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
        .mf-form-sub{font-size:11px;color:var(--mf-muted);margin-top:1px}
        .mf-form-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}

        #mf-fb-toast{position:fixed;bottom:24px;right:24px;max-width:min(420px,calc(100vw - 32px));padding:10px 18px;
            background:#fff;border:1px solid #e2e8f0;border-radius:50px;color:#1e293b;overflow-wrap:anywhere;
            font:600 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
            box-shadow:0 10px 25px -5px rgba(0,0,0,.1),0 8px 10px -6px rgba(0,0,0,.06);z-index:10000;
            opacity:0;transform:translateY(18px);pointer-events:none;transition:opacity .18s,transform .18s}
        #mf-fb-toast.show{opacity:1;transform:none}
        #mf-fb-toast.err{border-color:#fecaca;color:#991b1b}
        @media (prefers-reduced-motion:reduce){#mf-fb-toast{transition:none}.mf-spinner{animation:none}}
        [hidden]{display:none !important}

        @media (max-width:760px){
            .mf-fb-card{padding:12px}
            .mf-fb-row{align-items:flex-start}
            .mf-form-toolbar{top:8px}
            .mf-pills{width:100%}
            .mf-pill-btn{flex:1 1 auto;justify-content:center}
            .mf-input-text{min-width:100%}
        }`;
        (document.head || document.documentElement).appendChild(style);
    }

    // ---------- Toast ----------
    let toastTimer = null;
    function showToast(msg, opts) {
        const { error = false, duration = 3000 } = opts || {};
        let toast = document.getElementById('mf-fb-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'mf-fb-toast';
            toast.setAttribute('role', 'status');
            document.body.appendChild(toast);
        }
        toast.setAttribute('aria-live', error ? 'assertive' : 'polite');
        toast.classList.toggle('err', !!error);
        toast.textContent = String(msg == null ? '' : msg);
        // restart the transition even if a toast is already showing
        toast.classList.remove('show');
        void toast.offsetWidth;
        toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
    }

    // =========================================================================
    // PART 1: FEEDBACK LIST PAGE
    // =========================================================================
    function initFeedbackListPage() {
        injectStyles();

        const table = document.querySelector('table');
        if (!table) return;

        let container = null;
        let observer = null;
        let batchTimer = null;
        let refreshTimer = null;
        let lastKey = '';
        let pendingCount = 0;

        // One entry per row: the first link/button that looks like a pending survey
        function getPendingRows() {
            const items = [];
            document.querySelectorAll('table tbody tr').forEach((row, idx) => {
                if (row.querySelector('td[colspan]')) return; // "no data" row
                const candidates = row.querySelectorAll('a, button');
                for (const link of candidates) {
                    if (link.classList.contains('mf-quick-fill-btn')) continue;
                    const href = link.getAttribute('href') || '';
                    const text = (link.textContent || '').trim().toLowerCase();
                    const looksPending = text.includes('pending') ||
                        (href.includes('Student/Survey/Feedback') && !href.includes('FeedbackList') &&
                            !/\b(submitted|completed|view)\b/.test(text));
                    if (!looksPending) continue;

                    const cells = row.querySelectorAll('td');
                    const courseName = cells[2]?.textContent?.trim() || `Course ${idx + 1}`;
                    const facultyName = cells[3]?.textContent?.trim() || '';
                    items.push({
                        element: link,
                        key: `${link.href || href}|${courseName}`,
                        courseName,
                        facultyName,
                        row
                    });
                    break; // one survey per row
                }
            });
            return items;
        }

        function cardHtml(config, count, batch) {
            const badge = count > 0
                ? `<span class="mf-fb-badge mf-badge-pending"><span class="mf-status-dot"></span> ${count} Course${count > 1 ? 's' : ''} Pending</span>`
                : `<span class="mf-fb-badge mf-badge-success"><span class="mf-status-dot"></span> All Surveys Completed</span>`;

            const canBatch = count > 0 && !batch;
            const done = batch ? Math.max(0, (batch.total || count) - count) : 0;

            return `
            <div class="mf-fb-header">
                <div>
                    <h3 class="mf-fb-title">Feedback assistant</h3>
                    <span class="mf-fb-subtitle">Fill answers faster, then review before submitting</span>
                </div>
                <div>${badge}</div>
            </div>
            <div class="mf-fb-controls">
                <div class="mf-fb-row">
                    <div class="mf-fb-group">
                        <span class="mf-fb-group-label">Answer mode</span>
                        ${pillsHtml('mf-mode-pills', config.mode)}
                    </div>
                    <div class="mf-fb-group">
                        <span class="mf-fb-group-label">Remarks</span>
                        <select class="mf-select" id="mf-remark-select" aria-label="Remarks">
                            ${REMARK_OPTIONS.map(([v, l]) => `<option value="${v}"${config.remarkPreset === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}
                        </select>
                        <input type="text" class="mf-input-text" id="mf-custom-remark-input" maxlength="${MAX_REMARK}"
                               placeholder="Type custom remark..." aria-label="Custom remark"
                               value="${esc(config.customRemark)}"
                               style="display:${config.remarkPreset === 'custom' ? 'inline-block' : 'none'}" />
                    </div>
                </div>
                <div class="mf-fb-row">
                    <button type="button" class="mf-btn-primary" id="mf-btn-autofill-all" ${canBatch ? '' : 'disabled'}
                            title="${config.autoSubmit ? 'Auto-fill and submit all pending feedback' : 'Enable Submit automatically to auto-fill all courses'}">
                        Auto-fill all (${count})
                    </button>
                    <label class="st-switch" title="When enabled, forms submit without a review step">
                        <input type="checkbox" id="mf-toggle-autosubmit" ${config.autoSubmit ? 'checked' : ''} />
                        <span class="st-slider"></span>
                        <span style="font-size:12px;font-weight:600;color:#64748b;line-height:1;user-select:none;">Submit automatically</span>
                    </label>
                </div>
                ${batch && count > 0 ? `
                <div class="mf-batch-banner">
                    <div class="mf-batch-info">
                        <div class="mf-spinner"></div>
                        <div>
                            <div class="mf-batch-text">Batch auto-fill in progress (${done} of ${batch.total || count} submitted)</div>
                            <div class="mf-batch-sub">Next course in <span id="mf-countdown">1.5</span>s...</div>
                        </div>
                    </div>
                    <button type="button" class="mf-btn-danger" id="mf-btn-stop-batch">Stop</button>
                </div>` : ''}
            </div>`;
        }

        // Only rebuilds the card when something it shows has changed
        function renderCard(force) {
            const config = getConfig();
            if (container) container.hidden = !config.enabled;
            const batch = getBatch();
            const count = pendingCount;
            const key = `${config.enabled ? '1' : '0'}|${count}|${batch ? batch.total + ':' + count : 'x'}`;
            if (!force && key === lastKey && container.firstChild) return;
            lastKey = key;
            container.innerHTML = cardHtml(config, count, batch);
        }

        let toggleContainer = null;
        let toggleBtn = null;

        function buildToggle() {
            const box = document.createElement('div');
            box.id = 'st-feedback-toggle-container';
            box.style.cssText = 'display:inline-flex;align-items:center;';

            const label = document.createElement('label');
            label.className = 'st-switch';
            label.title = 'Toggle Feedback Assistant';

            const btn = document.createElement('input');
            btn.type = 'checkbox';
            btn.checked = getConfig().enabled;
            btn.title = 'Toggle Feedback Assistant';
            btn.setAttribute('aria-label', 'Toggle Feedback Assistant');
            btn.onchange = () => {
                const enabled = btn.checked;
                saveConfig({ enabled });
                if (!enabled && getBatch()) {
                    stopBatch();
                }
                showToast(enabled ? 'Feedback assistant turned ON' : 'Feedback assistant turned OFF');
                if (container) container.hidden = !enabled;
                injectQuickButtons(getPendingRows());
            };

            const slider = document.createElement('span');
            slider.className = 'st-slider';

            const span = document.createElement('span');
            span.textContent = 'Feedback Assistant';
            span.style.cssText = 'font-size:12px;font-weight:600;color:#64748b;line-height:1;user-select:none;';

            label.append(btn, slider, span);
            box.appendChild(label);
            toggleBtn = btn;
            return box;
        }

        function mountToggle() {
            if (!table) return;
            if (!toggleContainer) toggleContainer = buildToggle();
            if (toggleBtn) toggleBtn.checked = getConfig().enabled;
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
            } else if (container && container.parentNode) {
                container.parentNode.insertBefore(toggleContainer, container);
            } else if (table && table.parentNode) {
                table.parentNode.insertBefore(toggleContainer, table);
            }
        }

        function mountCard() {
            container = document.createElement('div');
            container.id = 'mujfish-feedback-list-card';
            container.className = 'mf-fb-card';
            container.hidden = !getConfig().enabled;
            const parent = table.closest('.kt-portlet__body') || table.parentElement;
            parent.insertBefore(container, parent.firstChild);

            // One set of delegated listeners (survives every re-render)
            container.addEventListener('click', (e) => {
                const modeBtn = e.target.closest('[data-mode]');
                if (modeBtn) {
                    saveConfig({ mode: modeBtn.dataset.mode });
                    markActivePill(container, modeBtn.dataset.mode);
                } else if (e.target.closest('#mf-btn-autofill-all')) {
                    startBatch();
                } else if (e.target.closest('#mf-btn-stop-batch')) {
                    stopBatch();
                }
            });
            container.addEventListener('change', (e) => {
                if (e.target.id === 'mf-remark-select') {
                    saveConfig({ remarkPreset: e.target.value });
                    const custom = container.querySelector('#mf-custom-remark-input');
                    if (custom) custom.style.display = e.target.value === 'custom' ? 'inline-block' : 'none';
                } else if (e.target.id === 'mf-toggle-autosubmit') {
                    saveConfig({ autoSubmit: e.target.checked });
                    renderCard(true);
                }
            });
            container.addEventListener('input', (e) => {
                if (e.target.id === 'mf-custom-remark-input') {
                    saveConfig({ customRemark: e.target.value.slice(0, MAX_REMARK) });
                }
            });
        }

        // ----- Quick fill buttons -----
        function injectQuickButtons(items) {
            const cfg = getConfig();
            if (!cfg.enabled) {
                table.querySelectorAll('.mf-quick-fill-btn').forEach((b) => b.remove());
                return;
            }
            items.forEach((item) => {
                if (item.row.querySelector('.mf-quick-fill-btn')) return;
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'mf-quick-fill-btn';
                btn.textContent = 'Quick fill';
                btn.title = `Auto-fill feedback for ${item.courseName}`;
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const cfg = getConfig();
                    storage.set(STORAGE_KEY_SINGLE, {
                        mode: cfg.mode,
                        remarkPreset: cfg.remarkPreset,
                        customRemark: cfg.customRemark,
                        autoSubmit: cfg.autoSubmit,
                        time: Date.now()
                    });
                    if (item.element.target && item.element.target !== '_self') {
                        item.element.target = '_self';
                    }
                    showToast(`Opening ${item.courseName}...`);
                    setTimeout(() => item.element.click(), 250);
                });
                item.element.after(btn);
            });
        }

        // ----- Batch flow -----
        function startBatch() {
            const items = getPendingRows();
            const cfg = getConfig();
            if (!items.length) { showToast('No pending surveys found'); return; }
            if (!cfg.autoSubmit) {
                showToast("Enable 'Submit automatically' to auto-fill all courses");
                const toggle = document.getElementById('mf-toggle-autosubmit');
                if (toggle) {
                    const label = toggle.closest('.st-switch') || toggle.closest('.mf-switch');
                    if (label) {
                        label.style.transition = 'transform 0.15s ease';
                        label.style.transform = 'scale(1.1)';
                        setTimeout(() => { label.style.transform = ''; }, 350);
                    }
                }
                return;
            }

            try { sessionStorage.setItem(SESSION_KEY_BATCH_ACTIVE, '1'); } catch (_) { }

            storage.set(STORAGE_KEY_BATCH, {
                active: true,
                mode: cfg.mode,
                remarkPreset: cfg.remarkPreset,
                customRemark: cfg.customRemark,
                autoSubmit: cfg.autoSubmit,
                total: items.length,
                attempts: {},
                startedAt: Date.now(),
                lastActive: Date.now()
            });
            showToast(`Starting auto-fill for ${items.length} course${items.length > 1 ? 's' : ''}...`);
            renderCard(true);
            continueBatch(400);
        }

        function stopBatch() {
            clearTimeout(batchTimer);
            try { sessionStorage.removeItem(SESSION_KEY_BATCH_ACTIVE); } catch (_) { }
            storage.remove(STORAGE_KEY_BATCH);
            showToast('Batch auto-fill stopped');
            renderCard(true);
        }

        function finishBatch() {
            clearTimeout(batchTimer);
            try { sessionStorage.removeItem(SESSION_KEY_BATCH_ACTIVE); } catch (_) { }
            storage.remove(STORAGE_KEY_BATCH);
            showToast('All feedback surveys completed', { duration: 5000 });
            renderCard(true);
        }

        function launchNext() {
            const batch = getBatch();
            if (!batch) return;
            const items = getPendingRows();
            if (!items.length) { finishBatch(); return; }

            // Skip courses that already failed MAX_ATTEMPTS times so the batch can't loop forever
            const next = items.find((it) => (batch.attempts[it.key] || 0) < MAX_ATTEMPTS);
            if (!next) {
                stopBatch();
                showToast(`Stopped: ${items.length} survey${items.length > 1 ? 's' : ''} could not be submitted. Please do ${items.length > 1 ? 'them' : 'it'} manually.`,
                    { error: true, duration: 7000 });
                return;
            }
            batch.attempts[next.key] = (batch.attempts[next.key] || 0) + 1;
            batch.lastActive = Date.now();
            storage.set(STORAGE_KEY_BATCH, batch);
            if (next.element.target && next.element.target !== '_self') {
                next.element.target = '_self';
            }
            next.element.click();
        }

        function continueBatch(delayMs) {
            clearTimeout(batchTimer);
            let remaining = delayMs;
            const tick = () => {
                if (!getBatch()) return; // stopped or expired
                const el = document.getElementById('mf-countdown');
                if (el) el.textContent = (remaining / 1000).toFixed(1);
                if (remaining <= 0) { launchNext(); return; }
                const step = Math.min(500, remaining);
                remaining -= step;
                batchTimer = setTimeout(tick, step);
            };
            tick();
        }

        // ----- Keep in sync if the portal redraws the table -----
        function observe() { observer.observe(table, { childList: true, subtree: true }); }

        function checkAndResumeBatch() {
            const batch = getBatch();
            if (!batch) return;
            const items = getPendingRows();
            pendingCount = items.length;
            if (pendingCount > 0) {
                continueBatch(BATCH_DELAY_MS);
            } else {
                // Check if table rows are actually rendered or if DataTables is still populating
                const rows = document.querySelectorAll('table tbody tr');
                const hasColspan = rows.length === 1 && rows[0].querySelector('td[colspan]');
                if (!rows.length || hasColspan) {
                    setTimeout(() => {
                        if (!getBatch()) return;
                        const retryItems = getPendingRows();
                        pendingCount = retryItems.length;
                        if (retryItems.length > 0) {
                            renderCard(true);
                            continueBatch(BATCH_DELAY_MS);
                        } else {
                            finishBatch();
                        }
                    }, 500);
                } else {
                    finishBatch();
                }
            }
        }

        function refresh() {
            refreshTimer = null;
            observer.disconnect(); // our own edits must not retrigger us
            try {
                const items = getPendingRows();
                pendingCount = items.length;
                mountToggle();
                renderCard(false);
                injectQuickButtons(items);
                // If a batch is in flight and courses are now visible, resume
                const b = getBatch();
                if (b && pendingCount > 0 && !batchTimer) {
                    continueBatch(BATCH_DELAY_MS);
                }
            } finally {
                observe();
            }
        }

        observer = new MutationObserver(() => {
            if (!refreshTimer) refreshTimer = setTimeout(refresh, 150);
        });

        // ----- Go -----
        mountToggle();
        mountCard();
        pendingCount = getPendingRows().length;
        renderCard(true);
        injectQuickButtons(getPendingRows());
        observe();

        // Resume active batch if one is in flight
        checkAndResumeBatch();
    }

    // =========================================================================
    // PART 2: FEEDBACK FORM PAGE
    // =========================================================================
    function initFeedbackFormPage() {
        injectStyles();

        const form = document.getElementById('kt-form') || document.querySelector('form[action*="Feedback"]');
        const submitBtn = document.getElementById('btnSubmit') || (form && form.querySelector('button[type="submit"], input[type="submit"], .btn-primary'));
        if (!form || !submitBtn || document.getElementById('mujfish-form-toolbar')) return;

        const config = getConfig();
        const batch = getBatch();
        const single = storage.get(STORAGE_KEY_SINGLE, null);
        const isBatch = !!batch;
        const isSingle = !!(single && (Date.now() - (single.time || 0) < SINGLE_TTL_MS));
        if (single) storage.remove(STORAGE_KEY_SINGLE); // one-shot, also clears stale ones

        if (!config.enabled && !isBatch && !isSingle) return;

        const src = isBatch ? batch : (isSingle ? single : config);
        const activeMode = MODE_IDS.includes(src.mode) ? src.mode : DEFAULT_CONFIG.mode;
        const shouldAutoSubmit = !!src.autoSubmit && (isBatch || isSingle);

        const courseName = document.getElementById('txtCourseDescription')?.value || 'Course';
        const facultyName = document.getElementById('txtFacultyName')?.value || '';

        // ----- Find the questions -----
        const labelOf = (r) => (r.nextElementSibling?.textContent || '').trim().toUpperCase();

        function getQuestionnaireInputs() {
            const byName = new Map();
            form.querySelectorAll('input[type="radio"]').forEach((radio) => {
                const name = radio.name || '';
                if (!name) return;
                if (!byName.has(name)) byName.set(name, []);
                byName.get(name).push(radio);
            });

            const groups = [];
            for (const [name, radios] of byName) {
                let yes = radios.find((r) => r.classList.contains('yescheck') || labelOf(r) === 'YES');
                let no = radios.find((r) => labelOf(r) === 'NO' || r.classList.contains('nocheck') || (radios.length === 2 && r !== yes));
                if (!yes && radios.length > 0) yes = radios[0];
                if (!no && radios.length > 1) no = radios[1];
                groups.push({ name, yes, no });
            }

            const selects = Array.from(form.querySelectorAll('select'))
                .filter((s) => Array.from(s.options).some((o) => o.value === 'Y' || o.value === 'N'));
            return { groups, selects };
        }

        // Unchecking first makes click() fire the portal's change handler exactly once
        function choose(radio) {
            if (!radio) return false;
            radio.checked = false;
            radio.click();
            if (!radio.checked) {
                radio.checked = true;
                radio.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return radio.checked;
        }

        function executeFill(mode, remarkPreset, customRemark) {
            const { groups, selects } = getQuestionnaireInputs();

            // "mostly yes": about 10% No answers, never more than 4
            const noIndices = new Set();
            if (mode === 'mostly_yes' && groups.length > 5) {
                const noCount = Math.max(1, Math.min(4, Math.round(groups.length * 0.1)));
                while (noIndices.size < noCount) noIndices.add(Math.floor(Math.random() * groups.length));
            }

            let answered = 0;
            let ansStr = '';

            groups.forEach((group, i) => {
                let pickYes = true;
                if (mode === 'all_no') pickYes = false;
                else if (mode === 'mostly_yes') pickYes = !noIndices.has(i);
                else if (mode === 'random') pickYes = Math.random() < 0.65;

                const target = pickYes ? group.yes : group.no;
                if (choose(target)) {
                    answered++;
                    if ((target === group.yes || target.classList.contains('yescheck')) && target.value) {
                        ansStr += target.value + '#true,';
                    }
                }
            });

            selects.forEach((sel) => {
                let choice = 'Y';
                if (mode === 'all_no') choice = 'N';
                else if (mode === 'random') choice = Math.random() < 0.8 ? 'Y' : 'N';

                sel.value = choice;
                sel.dispatchEvent(new Event('change', { bubbles: true }));

                const m = (sel.getAttribute('onchange') || '').match(/OnSelect\s*\(\s*['"]([^'"]+)['"]/);
                if (m && m[1]) ansStr += m[1] + '#' + choice + ',';
            });

            const remarks = document.getElementById('Remarks') || form.querySelector('textarea[name="Remarks"], textarea');
            if (remarks) {
                remarks.value = getRemarkText(remarkPreset, customRemark);
                remarks.dispatchEvent(new Event('input', { bubbles: true }));
                remarks.dispatchEvent(new Event('change', { bubbles: true }));
            }

            // Safety net: only if the portal's own handlers left its answer string empty
            try {
                const hiddenInput = document.getElementById('hdnAnsStr') || form.querySelector('input[name="hdnAnsStr"]');
                if (window.hdnAnsStr && typeof window.hdnAnsStr.val === 'function') {
                    if (!window.AnsStr || !window.AnsStr.length) {
                        window.AnsStr = ansStr;
                        window.hdnAnsStr.val(ansStr);
                    }
                } else if (hiddenInput && !hiddenInput.value && ansStr) {
                    hiddenInput.value = ansStr;
                }
            } catch (_) { }

            const hasInputs = groups.length > 0 || selects.length > 0;
            const allRadiosAnswered = groups.length === 0 || answered === groups.length;
            return { total: groups.length + selects.length, answered: answered + selects.length, selects: selects.length, ok: hasInputs && allRadiosAnswered };
        }

        // ----- Toolbar -----
        const toolbar = document.createElement('div');
        toolbar.id = 'mujfish-form-toolbar';
        toolbar.className = 'mf-form-toolbar';
        toolbar.innerHTML = `
            <div>
                <div class="mf-form-head">
                    <span>Feedback assistant</span>
                    <span class="mf-fb-badge mf-badge-running"><span class="mf-status-dot"></span><span id="mf-form-course"></span></span>
                </div>
                <div class="mf-form-sub" id="mf-form-status"></div>
            </div>
            <div class="mf-form-actions">
                ${pillsHtml('mf-form-mode-pills', activeMode)}
                <button type="button" class="mf-btn-secondary" id="mf-form-fill-btn">Fill form</button>
                <button type="button" class="mf-btn-primary" id="mf-form-submit-btn">Fill &amp; submit</button>
                <button type="button" class="mf-btn-danger" id="mf-form-cancel-btn" style="display:none">Cancel</button>
            </div>`;
        form.parentNode.insertBefore(toolbar, form);

        toolbar.querySelector('#mf-form-course').textContent = courseName + (facultyName ? ' \u2022 ' + facultyName : '');
        const statusEl = toolbar.querySelector('#mf-form-status');
        const cancelBtn = toolbar.querySelector('#mf-form-cancel-btn');
        const setStatus = (t) => { statusEl.textContent = t; };

        let countdown = null;
        let submitted = false;

        function stopCountdown() {
            if (countdown) { clearInterval(countdown); countdown = null; }
            if (cancelBtn) {
                cancelBtn.style.display = 'none';
                cancelBtn.hidden = true;
            }
        }

        function doSubmit() {
            if (submitted) return; // never click Submit twice
            submitted = true;
            stopCountdown();
            toolbar.querySelectorAll('button').forEach((b) => { b.disabled = true; });
            setStatus('Submitting...');
            showToast('Submitting feedback...');
            if (isBatch) {
                const b = getBatch();
                if (b) {
                    b.lastActive = Date.now();
                    storage.set(STORAGE_KEY_BATCH, b);
                }
            }
            if (shouldAutoSubmit) {
                // Auto-accept portal confirmation modal if present during auto-submit
                const origConfirm = window.confirm;
                window.confirm = () => true;
                try {
                    submitBtn.click();
                } finally {
                    setTimeout(() => { window.confirm = origConfirm; }, 1000);
                }
            } else {
                submitBtn.click();
            }
        }

        function cancelAuto(message) {
            stopCountdown();
            if (isBatch) {
                try { sessionStorage.removeItem(SESSION_KEY_BATCH_ACTIVE); } catch (_) { }
                storage.remove(STORAGE_KEY_BATCH);
            }
            if (message) { setStatus(message); showToast(message); }
        }

        function startCountdown() {
            let left = FORM_SUBMIT_DELAY_MS;
            if (cancelBtn) {
                cancelBtn.style.display = 'inline-flex';
                cancelBtn.hidden = false;
            }
            setStatus(`Auto-submitting in ${(left / 1000).toFixed(1)}s...`);
            countdown = setInterval(() => {
                left -= 100;
                if (left <= 0) { doSubmit(); return; }
                setStatus(`Auto-submitting in ${(left / 1000).toFixed(1)}s...`);
            }, 100);
        }

        // Toolbar events
        toolbar.addEventListener('click', (e) => {
            const modeBtn = e.target.closest('[data-mode]');
            if (modeBtn) {
                if (countdown) cancelAuto('Auto-submit stopped. Review and submit.');
                config.mode = modeBtn.dataset.mode;
                saveConfig({ mode: config.mode });
                markActivePill(toolbar, config.mode);
                executeFill(config.mode, config.remarkPreset, config.customRemark);
                showToast(`Updated to ${modeBtn.textContent.trim()}`);
            } else if (e.target.closest('#mf-form-fill-btn')) {
                if (countdown) cancelAuto('Auto-submit stopped. Review and submit.');
                const res = executeFill(config.mode, config.remarkPreset, config.customRemark);
                if (res.ok) showToast(`Filled ${res.total} questions and remarks`);
                else showToast(`Only ${res.answered} of ${res.total} questions could be answered`, { error: true });
            } else if (e.target.closest('#mf-form-submit-btn')) {
                if (countdown) stopCountdown();
                const res = executeFill(config.mode, config.remarkPreset, config.customRemark);
                if (!res.ok) {
                    showToast('Could not answer every question. Please check the form and submit manually.', { error: true, duration: 5000 });
                    return;
                }
                setTimeout(doSubmit, 400);
            } else if (e.target.closest('#mf-form-cancel-btn')) {
                cancelAuto('Auto-submit cancelled. Review and submit when ready.');
            }
        });

        // ----- Automatic run (Quick fill / batch) -----
        if (isBatch || isSingle) {
            const res = executeFill(activeMode, src.remarkPreset, src.customRemark);
            if (!res.ok) {
                // Never auto-submit a form we could not fully answer
                if (isBatch) {
                    try { sessionStorage.removeItem(SESSION_KEY_BATCH_ACTIVE); } catch (_) { }
                    storage.remove(STORAGE_KEY_BATCH);
                }
                setStatus('Could not answer every question. Please review and submit manually.');
                showToast(res.total === 0 ? "Couldn't find the questions on this page" : `Only ${res.answered} of ${res.total} questions could be answered`,
                    { error: true, duration: 6000 });
            } else if (shouldAutoSubmit) {
                startCountdown();
            } else {
                setStatus('Answers filled. Review and submit.');
                showToast(`Filled ${res.total} questions and remarks`);
            }
        } else {
            setStatus('Choose a pattern, fill the form, then review your answers');
        }
    }

    // ---------- Boot ----------
    function boot() {
        try {
            if (IS_LIST_PAGE) initFeedbackListPage();
            else initFeedbackFormPage();
        } catch (e) {
            // never break the portal
            try { console.warn('[MUJ FISH] feedback helper stopped:', e); } catch (_) { }
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();