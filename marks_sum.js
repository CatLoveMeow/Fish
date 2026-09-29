
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
    const ddlSemester = document.getElementById('ddlSemester');
    const currentSem = ddlSemester ? ddlSemester.value : '';

    storage.get('subjectGrades', (data) => {
        let gradeMap = data.subjectGrades || {};
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

            // Store course code in a data attribute so we can update it later after fetch
            if (courseCode) {
                row.setAttribute('data-course-code', courseCode);
            }

            const tdTotal = row.insertCell(-1);
            tdTotal.innerText = hasValues ? rowSum.toFixed(2) : '-';
            tdTotal.style.textAlign = 'center';
            tdTotal.style.fontWeight = '600';
            tdTotal.style.color = '#343a40';

            const tdGrade = row.insertCell(-1);
            tdGrade.classList.add('st-grade-cell');
            tdGrade.innerText = grade || 'Loading...';
            tdGrade.style.textAlign = 'center';
            tdGrade.style.fontWeight = '600';
            tdGrade.style.color = '#343a40';
        });

        // Background fetch for the current semester's grades (run at most once per session per semester)
        const sessionFetchKey = `mujfish_grades_fetched_${currentSem}`;
        if (currentSem && !sessionStorage.getItem(sessionFetchKey)) {
            sessionStorage.setItem(sessionFetchKey, 'true');
            const formData = new URLSearchParams();
            formData.append("Enrollment", "");
            formData.append("Semester", currentSem);

            fetch('/Student/Academic/GetGradesForFaculty', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest'
                },
                body: formData.toString()
            })
            .then(res => res.json())
            .then(gradeData => {
                if (gradeData && gradeData.IsSuccessfull && gradeData.InternalMarksList) {
                    let hasNewGrades = false;
                    gradeData.InternalMarksList.forEach(item => {
                        if (item.CourseCode && item.Grade && item.AcademicSession !== "Total") {
                            gradeMap[item.CourseCode] = item.Grade;
                            hasNewGrades = true;
                            
                            // Update the DOM dynamically
                            const matchingRow = document.querySelector(`tr[data-course-code="${item.CourseCode}"]`);
                            if (matchingRow) {
                                const gradeCell = matchingRow.querySelector('.st-grade-cell');
                                if (gradeCell) {
                                    gradeCell.innerText = item.Grade;
                                }
                            }
                        }
                    });

                    // Save back to storage so it's instantly available next time
                    if (hasNewGrades) {
                        storage.set({ subjectGrades: gradeMap });
                        
                        // Handle missing grades
                        document.querySelectorAll('.st-grade-cell').forEach(cell => {
                            if (cell.innerText === 'Loading...') cell.innerText = '-';
                        });
                    }
                }
            })
            .catch(err => {
                console.error("MUJFISH: Failed to fetch grades in background", err);
                document.querySelectorAll('.st-grade-cell').forEach(cell => {
                    if (cell.innerText === 'Loading...') cell.innerText = '-';
                });
            });
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
