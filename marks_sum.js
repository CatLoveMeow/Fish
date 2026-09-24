
function calculateMarks() {
    const table = document.getElementById('kt_ViewTable') || document.querySelector('.table') || document.querySelector('table');
    if (!table) return;

    const headerRow = table.rows[0];
    if (!headerRow) return;

    if (!headerRow.querySelector('.st-injected-total')) {
        const thTotal = document.createElement('th');
        thTotal.classList.add('st-injected-total');
        thTotal.innerText = 'Total';
        thTotal.style.fontWeight = 'bold';
        thTotal.style.textAlign = 'center';
        thTotal.style.padding = '10px';
        thTotal.style.backgroundColor = '#f3f6f9';
        headerRow.appendChild(thTotal);
    }

    if (!headerRow.querySelector('.st-injected-grade')) {
        const thGrade = document.createElement('th');
        thGrade.classList.add('st-injected-grade');
        thGrade.innerText = 'Grade';
        thGrade.style.fontWeight = 'bold';
        thGrade.style.textAlign = 'center';
        thGrade.style.padding = '10px';
        thGrade.style.backgroundColor = '#f3f6f9';
        headerRow.appendChild(thGrade);
    }

    const storage = (typeof browser !== 'undefined' && browser.storage) ? browser.storage.local : chrome.storage.local;

    storage.get('subjectGrades', (data) => {
        const gradeMap = data.subjectGrades || {};
        const rows = Array.from(table.rows).slice(1);

        rows.forEach(row => {
            if (row.classList.contains('grand-total-row') || row.classList.contains('st-processed')) return;
            row.classList.add('st-processed');

            const cells = row.cells;
            let rowSum = 0;
            let hasValues = false;

            // Calculate Marks Sum (Indices 2-7)
            for (let j = 2; j <= 7; j++) {
                if (cells[j]) {
                    const val = cells[j].innerText.trim();
                    if (val !== '-' && val !== '' && !isNaN(parseFloat(val))) {
                        rowSum += parseFloat(val);
                        hasValues = true;
                    }
                }
            }

            const subjectName = cells[1].innerText.trim();
            const match = subjectName.match(/\(([^)]+)\)/);
            const courseCode = match ? match[1] : null;
            const grade = courseCode ? gradeMap[courseCode] : null;

            const tdTotal = row.insertCell(-1);
            tdTotal.innerText = hasValues ? rowSum.toFixed(2) : '-';
            tdTotal.style.textAlign = 'center';
            tdTotal.style.fontWeight = '600';
            tdTotal.style.color = '#343a40';

            const tdGrade = row.insertCell(-1);
            tdGrade.innerText = grade || '-';
            tdGrade.style.textAlign = 'center';
            tdGrade.style.fontWeight = '600';
            tdGrade.style.color = '#343a40';
        });

        if (!document.getElementById('st-grades-guide')) {
            const guideDiv = document.createElement('div');
            guideDiv.id = 'st-grades-guide';
            guideDiv.style.marginTop = '15px';
            guideDiv.style.padding = '15px';
            guideDiv.style.backgroundColor = '#f8f9fa';
            guideDiv.style.borderLeft = '4px solid #17a2b8';
            guideDiv.style.borderRadius = '4px';
            guideDiv.style.color = '#343a40';
            guideDiv.style.fontSize = '14px';
            guideDiv.innerHTML = '<strong>Tip:</strong> Grades missing? Please visit the <strong>Grades page</strong> first so the extension can sync them.';
            
            if (table.parentNode) {
                table.parentNode.insertBefore(guideDiv, table.nextSibling);
            }
        }
    });
}

const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
            calculateMarks();
            break;
        }
    }
});

observer.observe(document.body, { childList: true, subtree: true });
setTimeout(calculateMarks, 2000);
