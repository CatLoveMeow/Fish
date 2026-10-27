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
            NUM: /^\d+(\.\d+)?$/
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
            FEEDBACK_CONFIG: 'mujfish_fb_config'
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
        predictCgpa(currentCgpa, currentCredits, futureGpas = [], creditsPerSem = 0) {
            if (!Number.isFinite(currentCgpa) || currentCgpa < 0 || currentCgpa > 10 ||
                !Number.isFinite(currentCredits) || currentCredits <= 0) return null;
            if (!Array.isArray(futureGpas)) return null;
            if (futureGpas.length === 0) {
                return { newCgpa: currentCgpa, delta: 0, totalCredits: currentCredits };
            }
            if (!Number.isFinite(creditsPerSem) || creditsPerSem <= 0 ||
                futureGpas.some((gpa) => !Number.isFinite(gpa) || gpa < 0 || gpa > 10)) return null;

            const totalCredits = currentCredits + futureGpas.length * creditsPerSem;
            const totalPoints = currentCgpa * currentCredits +
                futureGpas.reduce((sum, gpa) => sum + gpa * creditsPerSem, 0);
            const newCgpa = Math.round((totalPoints / totalCredits) * 100) / 100;
            return {
                newCgpa,
                delta: Math.round((newCgpa - currentCgpa) * 100) / 100,
                totalCredits
            };
        }
    });

    const MujFish = {
        CONSTANTS,
        storage,
        MATH
    };

    if (typeof window !== 'undefined') {
        window.MujFish = MujFish;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = MujFish;
    }
})();
