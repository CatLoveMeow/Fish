
function parseGrades() {
    const table = document.getElementById('kt_ViewTable') || document.querySelector('.table') || document.querySelector('table');
    if (!table) return;

    const rows = Array.from(table.rows).slice(1); // Skip header
    const gradeMap = {};

    rows.forEach(row => {
        const cells = row.cells;
        if (cells.length >= 6) {
            const courseCode = cells[1].innerText.trim();
            const grade = cells[5].innerText.trim();
            if (courseCode && grade) {
                gradeMap[courseCode] = grade;
            }
        }
    });

    if (Object.keys(gradeMap).length > 0) {
        const storage = (typeof browser !== 'undefined' && browser.storage) ? browser.storage.local : chrome.storage.local;
        storage.get('subjectGrades', (data) => {
            const existingGrades = data.subjectGrades || {};
            const mergedGrades = { ...existingGrades, ...gradeMap };
            storage.set({ 'subjectGrades': mergedGrades });
        });
    }
}

const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
            parseGrades();
            break;
        }
    }
});

observer.observe(document.body, { childList: true, subtree: true });
setTimeout(parseGrades, 2000);
