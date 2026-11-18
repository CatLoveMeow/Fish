/**
 * MUJ FISH - Common Constants & Storage Wrapper
 * Shared across content scripts in the extension context.
 */
(() => {
    'use strict';
    if (typeof window !== 'undefined' && window.__mujfishCommonLoaded) return;
    if (typeof window !== 'undefined') window.__mujfishCommonLoaded = true;

    const CONSTANTS = Object.freeze({
        ATTENDANCE: Object.freeze({
            DEFAULT_TARGET: 75,
            MIN_TARGET: 1,
            MAX_TARGET: 99,
            ROUND_UP_MARGIN: 1
        }),
        ACADEMICS: Object.freeze({
            MAX_SEMS: 6,
            MAX_GPA: 10,
            MAX_CREDITS: 30
        }),
        REGEX: Object.freeze({
            INT: /^\d+$/,
            NUM: /^\d+(\.\d+)?$/,
            SEMESTER: /Semester\s*[:\-]?\s*(VIII|VII|VI|IV|IX|III|II|X|V|I|\d{1,2})\b/
        }),
        STORAGE_KEYS: Object.freeze({
            CUSTOM_TARGET: 'st_customTarget',
            DASHBOARD_ENABLED: 'mujfish_dashboard_enabled',
            SUBJECT_GRADES: 'subjectGrades',
            PRED_ENABLED: 'predEnabled',
            PREDICTED_GRADES: 'predictedGrades',
            COURSE_CREDITS: 'courseCredits',
            CLEAN_MODE: 'st_cleanMode',
            PREDICTOR_CREDITS: 'muj_predictor_credits',
            FEEDBACK_CONFIG: 'mujfish_fb_config',
            ACADEMIC_BASELINE: 'muj_academic_baseline',
            INTERNAL_MARKS_CACHE: 'muj_internal_marks_cache',
            MARKS_CACHE: 'muj_marks_cache',
            CURRENT_SEMESTER: 'muj_current_semester',
            SEM_CHECKED_AT: 'muj_sem_checked_at',
            PLANNED_SKIPS: 'muj_planned_skips',
            ACTIVE_STUDENT_ID: 'muj_active_student_id'
        })
    });

    const api = (typeof chrome !== 'undefined' && chrome.storage) ? chrome
        : (typeof browser !== 'undefined' && browser.storage) ? browser : null;

    const storage = {
        /** True only when the extension storage API is usable. */
        isAvailable() {
            return !!(api && api.storage && api.storage.local &&
                typeof api.storage.local.get === 'function' &&
                typeof api.storage.local.set === 'function' &&
                typeof api.storage.local.remove === 'function');
        },

        /**
         * Read a key with a safe fallback. Supports callback-based Chrome APIs
         * and Promise-based browser APIs without making callers depend on either.
         */
        async get(key, fallback = null) {
            if (typeof key !== 'string' || !key || !this.isAvailable()) return fallback;
            try {
                const result = await new Promise((resolve) => {
                    let settled = false;
                    const finish = (value) => {
                        if (settled) return;
                        settled = true;
                        resolve(value);
                    };
                    const callback = (data) => {
                        const lastError = api.runtime && api.runtime.lastError;
                        finish(lastError ? fallback : (data && data[key] !== undefined ? data[key] : fallback));
                    };
                    const returned = api.storage.local.get(key, callback);
                    // Firefox's browser.* API returns a Promise; Chrome's chrome.* API
                    // generally resolves through the callback.
                    if (returned && typeof returned.then === 'function') {
                        returned.then((data) => finish(data && data[key] !== undefined ? data[key] : fallback))
                            .catch(() => finish(fallback));
                    }
                });
                return result;
            } catch (_) {
                return fallback;
            }
        },

        /** Write one key/value pair or an object of values. */
        async set(key, value) {
            if (!this.isAvailable()) return false;
            let payload;
            if (typeof key === 'string' && key) payload = { [key]: value };
            else if (key && typeof key === 'object' && !Array.isArray(key)) payload = key;
            else return false;
            try {
                return await new Promise((resolve) => {
                    let settled = false;
                    const finish = (ok) => {
                        if (settled) return;
                        settled = true;
                        resolve(ok);
                    };
                    const returned = api.storage.local.set(payload, () => {
                        finish(!(api.runtime && api.runtime.lastError));
                    });
                    if (returned && typeof returned.then === 'function') {
                        returned.then(() => finish(true)).catch(() => finish(false));
                    }
                });
            } catch (_) {
                return false;
            }
        },

        /** Remove one or more keys. */
        async remove(key) {
            if (!this.isAvailable()) return false;
            if (!(typeof key === 'string' && key) &&
                !(Array.isArray(key) && key.length && key.every((item) => typeof item === 'string' && item))) {
                return false;
            }
            try {
                return await new Promise((resolve) => {
                    let settled = false;
                    const finish = (ok) => {
                        if (settled) return;
                        settled = true;
                        resolve(ok);
                    };
                    const returned = api.storage.local.remove(key, () => {
                        finish(!(api.runtime && api.runtime.lastError));
                    });
                    if (returned && typeof returned.then === 'function') {
                        returned.then(() => finish(true)).catch(() => finish(false));
                    }
                });
            } catch (_) {
                return false;
            }
        }
    };

    const MATH = Object.freeze({
        /**
         * Minimum consecutive classes to attend to exceed target - roundUpMargin.
         * Invalid counts return 0; invalid targets use the default target.
         */
        classesNeeded(present, total, target = 75, roundUpMargin = 1) {
            if (!Number.isFinite(present) || !Number.isFinite(total) ||
                !Number.isInteger(present) || !Number.isInteger(total) ||
                present < 0 || total <= 0 || present > total) return 0;
            if (!Number.isFinite(target) || target < 1 || target > 99) target = 75;
            if (!Number.isFinite(roundUpMargin) || roundUpMargin < 0 || roundUpMargin >= target) roundUpMargin = 1;
            const threshold = target - roundUpMargin;
            const numerator = threshold * total - 100 * present;
            if (numerator < 0) return 0;
            const denominator = 100 - threshold;
            if (denominator <= 0) return 0;
            return Math.max(0, Math.floor(numerator / denominator) + 1);
        },

        /**
         * Maximum consecutive classes that can be skipped while remaining above
         * target - roundUpMargin. Returns 0 for invalid attendance data.
         */
        safeSkips(present, total, target = 75, roundUpMargin = 1) {
            if (!Number.isFinite(present) || !Number.isFinite(total) ||
                !Number.isInteger(present) || !Number.isInteger(total) ||
                present < 0 || total <= 0 || present > total) return 0;
            if (!Number.isFinite(target) || target < 1 || target > 99) target = 75;
            if (!Number.isFinite(roundUpMargin) || roundUpMargin < 0 || roundUpMargin >= target) roundUpMargin = 1;
            const threshold = target - roundUpMargin;
            const surplus = 100 * present - threshold * total;
            if (surplus <= 0) return 0;
            if (threshold <= 0) return Infinity;
            return Math.max(0, Math.floor((surplus - 1) / threshold));
        },

        /** Weighted CGPA prediction for future semesters. */
        predictCgpa(currentCgpa, currentCredits, futureGpas = [], creditsPerSem = 0, currentPoints = null) {
            if (!Number.isFinite(currentCgpa) || currentCgpa < 0 || currentCgpa > 10 ||
                !Number.isFinite(currentCredits) || currentCredits <= 0) return null;
            if (!Array.isArray(futureGpas)) return null;
            if (futureGpas.length === 0) {
                return { newCgpa: currentCgpa, delta: 0, totalCredits: currentCredits };
            }
            if (!Number.isFinite(creditsPerSem) || creditsPerSem <= 0 ||
                futureGpas.some((gpa) => !Number.isFinite(gpa) || gpa < 0 || gpa > 10)) return null;

            const totalCredits = currentCredits + futureGpas.length * creditsPerSem;
            const pts = (Number.isFinite(currentPoints) && currentPoints > 0)
                ? currentPoints
                : currentCgpa * currentCredits;
            const totalPoints = pts + futureGpas.reduce((sum, gpa) => sum + gpa * creditsPerSem, 0);
            const newCgpa = Math.round((totalPoints / totalCredits) * 100) / 100;
            return {
                newCgpa,
                delta: Math.round((newCgpa - currentCgpa) * 100) / 100,
                totalCredits
            };
        }
    });

    const ROMAN_MAP = Object.freeze({
        '1': 'I', '2': 'II', '3': 'III', '4': 'IV', '5': 'V',
        '6': 'VI', '7': 'VII', '8': 'VIII', '9': 'IX', '10': 'X',
        'I': 'I', 'II': 'II', 'III': 'III', 'IV': 'IV', 'V': 'V',
        'VI': 'VI', 'VII': 'VII', 'VIII': 'VIII', 'IX': 'IX', 'X': 'X'
    });

    const SEM_INT_MAP = Object.freeze({
        'I': 1, 'II': 2, 'III': 3, 'IV': 4, 'V': 5,
        'VI': 6, 'VII': 7, 'VIII': 8, 'IX': 9, 'X': 10,
        '1': 1, '2': 2, '3': 3, '4': 4, '5': 5,
        '6': 6, '7': 7, '8': 8, '9': 9, '10': 10
    });

    function normSem(s) {
        if (!s) return '';
        const clean = String(s).replace(/semester/i, '').trim().toUpperCase();
        return ROMAN_MAP[clean] || '';
    }

    async function detectCurrentSemester() {
        const K = CONSTANTS.STORAGE_KEYS;
        const saved = normSem(await storage.get(K.CURRENT_SEMESTER));
        const checkedAt = await storage.get(K.SEM_CHECKED_AT);
        const SEM_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days

        if (saved && typeof checkedAt === 'number' && (Date.now() - checkedAt < SEM_TTL_MS)) {
            return saved;
        }

        try {
            const res = await fetch('/Employee/EmployeeDirectory/IndexStudent', { credentials: 'same-origin' });
            if (res.ok) {
                const html = await res.text();
                const m = html.match(/id=["']txtSemester["'][^>]*value=["']([^"']+)["']/i) ||
                          html.match(/name=["']Semester["'][^>]*value=["']([^"']+)["']/i) ||
                          html.match(/value=["']([^"']+)["'][^>]*id=["']txtSemester["']/i) ||
                          html.match(/Semester\s*[:\-]?\s*(VIII|VII|VI|IV|IX|III|II|X|V|I|\d{1,2})\b/i);
                const v = m && normSem(m[1]);
                if (v) {
                    await storage.set({
                        [K.CURRENT_SEMESTER]: v,
                        [K.SEM_CHECKED_AT]: Date.now()
                    });
                    return v;
                }
            }
        } catch (_) { }

        // Secondary fallback: calculate current semester from completed semesters in baseline
        try {
            const base = await storage.get(K.ACADEMIC_BASELINE);
            if (base && typeof base.semsCompleted === 'number' && base.semsCompleted >= 0) {
                const SEM_ORDER = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
                const calculated = SEM_ORDER[base.semsCompleted];
                if (calculated) {
                    await storage.set({
                        [K.CURRENT_SEMESTER]: calculated,
                        [K.SEM_CHECKED_AT]: Date.now()
                    });
                    return calculated;
                }
            }
        } catch (_) { }

        return saved || null;
    }

    function parseBaselineFromDoc(doc) {
        if (!doc) return null;
        const table = doc.getElementById('kt_ViewTable') || doc.querySelector('table');
        if (!table) return null;
        let cgpaIdx = -1, credIdx = -1;
        for (const row of table.rows) {
            for (let c = 0; c < row.cells.length; c++) {
                const t = row.cells[c].textContent.trim();
                if (/^CGPA$/i.test(t)) cgpaIdx = c;
                else if (/^Total\s*Credits$/i.test(t)) credIdx = c;
            }
            if (cgpaIdx !== -1 && credIdx !== -1) break;
        }
        if (cgpaIdx === -1 || credIdx === -1) return null;
        const num = (cell) => {
            if (!cell) return NaN;
            const s = cell.textContent.trim().replace(/[^\d.]/g, '');
            const n = parseFloat(s);
            return Number.isFinite(n) ? n : NaN;
        };
        const start = Math.max(cgpaIdx, credIdx) + 1;
        for (const row of table.rows) {
            const cgpa = num(row.cells[cgpaIdx]), credits = num(row.cells[credIdx]);
            if (Number.isNaN(cgpa) || Number.isNaN(credits) || !(cgpa >= 0 && cgpa <= 10) || !(credits > 0)) continue;
            let points = 0, sems = 0;
            for (let i = start; i < row.cells.length; i += 2) {
                const g = num(row.cells[i]), c = num(row.cells[i + 1]);
                if (!Number.isNaN(g) && g >= 0 && g <= 10) {
                    sems++;
                    if (!Number.isNaN(c) && c > 0) points += g * c;
                }
            }
            if (points <= 0 || Math.abs(points / credits - cgpa) > 0.1) points = cgpa * credits;
            return { cgpa, credits, points, semsCompleted: sems, lastSynced: Date.now() };
        }
        return null;
    }

    async function syncBaseline() {
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
            if (!res.ok) return null;
            const d = await res.json();
            const it = d && d.IsSuccessfull === true && Array.isArray(d.InternalMarksList) ? d.InternalMarksList[0] : null;
            if (!it) return null;

            const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : NaN; };
            const cgpa = num(it.CGPA), credits = num(it.TotalCredits);
            if (!(cgpa >= 0 && cgpa <= 10) || !(credits > 0)) return null;

            let points = 0, sems = 0;
            const semGpas = {};
            ['I','II','III','IV','V','VI','VII','VIII','IX','X'].forEach((r) => {
                const g = num(it['GPASemester' + r]), c = num(it['CreditsSemester' + r]);
                if (g > 0 && c > 0) {
                    sems++;
                    points += g * c;
                    semGpas[r] = { gpa: g, credits: c };
                }
            });
            if (points <= 0 || Math.abs(points / credits - cgpa) > 0.1) points = cgpa * credits;

            const b = { cgpa, credits, points, semsCompleted: sems, semGpas, lastSynced: Date.now() };
            await storage.set(CONSTANTS.STORAGE_KEYS.ACADEMIC_BASELINE, b);
            return b;
        } catch (_) { return null; }
    }

    function detectStudentId(doc = (typeof document !== 'undefined' ? document : null)) {
        if (!doc) return null;

        // 1. Primary: Specific topbar user profile container (e.g. .kt-header__topbar-username)
        try {
            const userEl = doc.querySelector('.kt-header__topbar-username');
            if (userEl) {
                const txt = userEl.innerText || userEl.textContent || '';
                const m = txt.match(/\b(\d{8,11})\s*::/);
                if (m && m[1]) return m[1].trim();
            }
            const topbar = doc.querySelector('.kt-header__topbar, #kt_header_topbar');
            if (topbar) {
                const m = topbar.textContent.match(/\b(\d{8,11})\s*::\s*([A-Za-z\s.]+)/) ||
                          topbar.textContent.match(/\b(\d{8,11})\b/);
                if (m && m[1]) return m[1].trim();
            }
        } catch (_) { }

        // 2. Secondary: Broad body scan for "1234567890 :: STUDENT NAME"
        try {
            const bodyText = doc.body ? (doc.body.innerText || doc.body.textContent || '') : '';
            const pillMatch = bodyText.match(/\b(\d{8,11})\s*::\s*([A-Za-z\s.]+)/);
            if (pillMatch && pillMatch[1]) {
                return pillMatch[1].trim(); // Registration Number (e.g. 1234567890)
            }
        } catch (_) { }

        // 3. Fallback: Labeled Registration / Enrollment Number only (never plain phone numbers)
        try {
            const bodyText = doc.body ? (doc.body.innerText || doc.body.textContent || '') : '';
            const regMatch = bodyText.match(/(?:Registration|Enrollment|Regn?|Roll)\s*(?:No\.?|Number|#)?\s*[:\-]?\s*(\d{8,11})/i);
            if (regMatch && regMatch[1]) return regMatch[1].trim();
        } catch (_) { }

        return null;
    }

    const STUDENT_CACHE_KEYS = Object.freeze([
        'muj_internal_marks_cache',
        'muj_marks_cache',
        'muj_academic_baseline',
        'muj_attendance_cache',
        'muj_current_semester',
        'muj_sem_checked_at',
        'subjectGrades',
        'predictedGrades',
        'courseCredits',
        'muj_planned_skips',
        'noGrades',
        'customSubjects'
    ]);

    const PURGE_PREFIXES = Object.freeze([
        'customRows_',
        'courseCredits_',
        'predictedGrades_'
    ]);

    let inFlightSessionPromise = null;

    async function ensureStudentSession(doc = (typeof document !== 'undefined' ? document : null)) {
        if (inFlightSessionPromise) return inFlightSessionPromise;

        inFlightSessionPromise = (async () => {
            if (doc && !doc.querySelector('.kt-header__topbar, #kt_header_topbar, .kt-header__topbar-username')) {
                return { changed: false, current: null };
            }

            let currentId = detectStudentId(doc);
            if (!currentId) {
                try {
                    const res = await fetch('/Employee/EmployeeDirectory/IndexStudent', { credentials: 'same-origin' });
                    if (res.ok) {
                        const html = await res.text();
                        const pillMatch = html.match(/\b(\d{8,11})\s*::\s*([A-Za-z\s.]+)/);
                        if (pillMatch && pillMatch[1]) currentId = pillMatch[1].trim();
                        else {
                            const regMatch = html.match(/(?:Registration|Enrollment|Regn?|Roll)\s*(?:No\.?|Number|#)?\s*[:\-]?\s*(\d{8,11})/i);
                            if (regMatch && regMatch[1]) currentId = regMatch[1].trim();
                        }
                    }
                } catch (_) { }
            }

            if (!currentId) return { changed: false, current: null };

            try {
                const stored = await storage.get(CONSTANTS.STORAGE_KEYS.ACTIVE_STUDENT_ID);
                const isRegNum = (v) => typeof v === 'string' && /^\d{8,11}$/.test(v.trim());

                if (stored && isRegNum(stored) && isRegNum(currentId) && stored.trim() !== currentId.trim()) {
                    // Different registration number detected! Purge old student's academic cache
                    if (api && api.storage && api.storage.local) {
                        const all = await new Promise((res) => {
                            try {
                                api.storage.local.get(null, (d) => res(d || {}));
                            } catch (_) {
                                res({});
                            }
                        });

                        const keysToRemove = [];
                        const staticSet = new Set(STUDENT_CACHE_KEYS);
                        for (const k of Object.keys(all)) {
                            // User settings carry over across logins and must NEVER be wiped:
                            // - st_customTarget (attendance target percentage)
                            // - mujfish_dashboard_enabled (enhanced view toggle)
                            // - ACTIVE_STUDENT_ID (updated immediately below)
                            if (k === 'st_customTarget' || k === 'mujfish_dashboard_enabled' || k === CONSTANTS.STORAGE_KEYS.ACTIVE_STUDENT_ID) {
                                continue;
                            }
                            if (staticSet.has(k) || PURGE_PREFIXES.some((p) => k.startsWith(p))) {
                                keysToRemove.push(k);
                            }
                        }

                        if (keysToRemove.length) {
                            await storage.remove(keysToRemove);
                        }
                    }

                    // Purge transient sessionStorage keys
                    try {
                        if (typeof sessionStorage !== 'undefined') {
                            const toRemove = [];
                            for (let i = 0; i < sessionStorage.length; i++) {
                                const k = sessionStorage.key(i);
                                if (k && (k.startsWith('muj') || k.startsWith('st-'))) {
                                    toRemove.push(k);
                                }
                            }
                            toRemove.forEach((k) => sessionStorage.removeItem(k));
                        }
                    } catch (_) { }

                    // Purge feedback assistant queue and configs from localStorage
                    try {
                        if (typeof localStorage !== 'undefined') {
                            ['mujfish_fb_batch', 'mujfish_fb_config', 'mujfish_fb_single'].forEach((k) => localStorage.removeItem(k));
                        }
                    } catch (_) { }

                    await storage.set(CONSTANTS.STORAGE_KEYS.ACTIVE_STUDENT_ID, currentId);
                    return { changed: true, previous: stored, current: currentId };
                } else if (!stored || stored !== currentId) {
                    // Same student or migrating to clean registration number
                    await storage.set(CONSTANTS.STORAGE_KEYS.ACTIVE_STUDENT_ID, currentId);
                }
            } catch (_) { }

            return { changed: false, current: currentId };
        })().finally(() => {
            inFlightSessionPromise = null;
        });

        return inFlightSessionPromise;
    }

    const MujFish = {
        CONSTANTS,
        storage,
        MATH,
        ROMAN_MAP,
        SEM_INT_MAP,
        normSem,
        detectCurrentSemester,
        detectStudentId,
        ensureStudentSession,
        parseBaselineFromDoc,
        syncBaseline,
        STUDENT_CACHE_KEYS
    };

    if (typeof window !== 'undefined') {
        window.MujFish = MujFish;
        try {
            ensureStudentSession().catch(() => {});
        } catch (_) { }
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = MujFish;
    }
})();
