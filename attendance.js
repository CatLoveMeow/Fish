let customTarget = 75;
const storage = (typeof browser !== 'undefined' && browser.storage) ? browser.storage.local : chrome.storage.local;

function calculateAttendance() {
    const table = document.getElementById('kt_ViewTable');
    if (!table) return;

    const rows = table.rows;
    let tablearr = arraygen(table);

    // Inject headers if not present
    if (!document.getElementById('st-classes-needed')) {
        let headerRow = rows[0];

        let cnTh = document.createElement('th');
        cnTh.id = 'st-classes-needed';
        cnTh.style.textAlign = 'center';
        cnTh.style.backgroundColor = '#f3f6f9';
        headerRow.appendChild(cnTh);

        let acTh = document.createElement('th');
        acTh.id = 'st-absences-custom';
        acTh.style.textAlign = 'center';
        acTh.style.backgroundColor = '#f3f6f9';
        acTh.innerText = 'Classes you can safely skip';
        acTh.appendChild(document.createElement('br'));
        acTh.appendChild(document.createTextNode('('));
        
        let inputEl = document.createElement('input');
        inputEl.type = 'number';
        inputEl.id = 'st-custom-target';
        inputEl.value = Math.round(customTarget);
        inputEl.min = '1';
        inputEl.max = '99';
        inputEl.style.width = '50px';
        inputEl.style.textAlign = 'center';
        inputEl.style.fontSize = '12px';
        inputEl.style.padding = '2px';
        inputEl.style.border = '1px solid #ccc';
        inputEl.style.borderRadius = '3px';
        
        // Prevent typing decimals, negative signs, or exponent 'e'
        inputEl.addEventListener('keydown', function(e) {
            if (e.key === '.' || e.key === '-' || e.key === 'e' || e.key === '+') {
                e.preventDefault();
            }
        });
        
        acTh.appendChild(inputEl);
        
        acTh.appendChild(document.createTextNode('%)'));
        headerRow.appendChild(acTh);

        document.getElementById('st-custom-target').addEventListener('input', function (e) {
            // Strip any non-digit characters (in case of copy-paste)
            e.target.value = e.target.value.replace(/[^0-9]/g, '');
            
            let val = parseInt(e.target.value, 10);
            if (!isNaN(val)) {
                if (val > 99) {
                    val = 99;
                    e.target.value = 99;
                } else if (val < 1) {
                    val = 1;
                    e.target.value = 1;
                }
                customTarget = val;
                storage.set({ 'st_customTarget': val });
                updateTableData();
            }
        });

        // Add data cells
        for (let i = 1; i < rows.length; i++) {
            let row = rows[i];

            let cnTd = row.insertCell(-1);
            cnTd.className = 'st-cn-td';
            cnTd.style.textAlign = 'center';

            let acTd = row.insertCell(-1);
            acTd.className = 'st-ac-td';
            acTd.style.textAlign = 'center';
        }
    }

    function updateTableData() {
        let cnTh = document.getElementById('st-classes-needed');
        if (cnTh) {
            cnTh.innerText = 'Classes Required';
            cnTh.appendChild(document.createElement('br'));
            cnTh.appendChild(document.createTextNode(`(for ${customTarget}% attendance)`));
        }

        for (let i = 1; i < rows.length; i++) {
            if (!tablearr[i] || tablearr[i].length < 9) continue;
            let present = parseInt(tablearr[i][6]) || 0;
            let absent = parseInt(tablearr[i][7]) || 0;
            let total = parseInt(tablearr[i][8]) || 0;

            let classesNeeded = Math.ceil(Math.max(0, getClassesNeededCustom(present, total, customTarget)));

            let absencesCustom = Math.floor(Math.max(0, getAbsencesCustom(present, total, customTarget)));

            let row = rows[i];
            
            let cnTd = row.querySelector('.st-cn-td');
            if (cnTd) cnTd.innerText = classesNeeded;
            
            let acTd = row.querySelector('.st-ac-td');
            if (acTd) acTd.innerText = absencesCustom;
        }
    }

    updateTableData();
}

storage.get('st_customTarget', (data) => {
    if (data.st_customTarget) {
        customTarget = data.st_customTarget;
    }
    
    let attendanceInterval = setInterval(() => {
        if (document.getElementById('kt_ViewTable')) {
            clearInterval(attendanceInterval);
            calculateAttendance();
        }
    }, 500);

    // Fallback just in case
    setTimeout(calculateAttendance, 2000);
});

function arraygen(table) {
    if (table) {
        const tableData = [];
        const rows = table.rows;
        for (let i = 0; i < rows.length; i++) {
            const rowData = [];
            const cells = rows[i].cells;
            for (let j = 0; j < cells.length; j++) {
                rowData.push(cells[j].textContent.trim());
            }
            tableData.push(rowData);
        }
        return tableData;
    }
}

function getClassesNeededCustom(present, total, targetPercentage) {
    // The OG site takes Math.ceil() of the percentage, so e.g. 74.01% becomes 75%.
    // To match this, our effective target is slightly above targetPercentage - 1.
    const effectiveTarget = targetPercentage - 0.9999;
    return (effectiveTarget * total - 100 * present) / (100 - effectiveTarget);
}

function getAbsencesCustom(present, total, targetPercentage) {
    const effectiveTarget = targetPercentage - 0.9999;
    return (100 * present - effectiveTarget * total) / effectiveTarget;
}
