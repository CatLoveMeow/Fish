function initCGPAPredictor() {
    // We want to run only when the table is loaded.
    let table = document.querySelector('table');
    if (!table) return;

    // To prevent multiple injections
    if (document.getElementById('muj-cgpa-predictor-container')) return;

    let cgpaIndex = -1;
    let creditsIndex = -1;
    let dataRow = null;

    let rows = Array.from(table.rows);

    // 1. Find indices in the header row(s)
    for (let r = 0; r < rows.length; r++) {
        let cells = Array.from(rows[r].cells);
        for (let c = 0; c < cells.length; c++) {
            let text = cells[c].innerText.trim();
            if (text === 'CGPA') cgpaIndex = c;
            if (text === 'Total Credits') creditsIndex = c;
        }
        if (cgpaIndex !== -1 && creditsIndex !== -1) {
            break; // found the columns
        }
    }

    if (cgpaIndex === -1 || creditsIndex === -1) return;

    // 2. Find the data row
    for (let r = 0; r < rows.length; r++) {
        let cellCGPA = rows[r].cells[cgpaIndex];
        let cellCredits = rows[r].cells[creditsIndex];
        if (cellCGPA && cellCredits) {
            let cgpaVal = parseFloat(cellCGPA.innerText.trim());
            let credVal = parseFloat(cellCredits.innerText.trim());
            if (!isNaN(cgpaVal) && !isNaN(credVal) && cgpaVal > 0 && credVal > 0) {
                dataRow = rows[r];
                break;
            }
        }
    }

    if (!dataRow) return;

    let currentCGPA = parseFloat(dataRow.cells[cgpaIndex].innerText.trim());
    let currentCredits = parseFloat(dataRow.cells[creditsIndex].innerText.trim());

    // 3. Extract Semester GPAs
    let semesterGPAs = [];
    for (let i = 5; i < dataRow.cells.length; i += 2) {
        if (!dataRow.cells[i]) break;
        let text = dataRow.cells[i].innerText.trim();
        if (text && text !== '-') {
            let gpa = parseFloat(text);
            if (!isNaN(gpa)) {
                semesterGPAs.push(gpa);
            }
        }
    }



    // 4. Setup Interactive State
    let chartData = [...semesterGPAs];
    const hypotheticalIndexStart = chartData.length;
    let isChartVisible = false;
    
    // Add exactly 1 hypothetical semester by default, if under cap
    let lastKnownGPA = chartData.length > 0 ? chartData[chartData.length - 1] : currentCGPA;
    if (chartData.length < 6) {
        chartData.push(lastKnownGPA);
    }
    
    let draggingIndex = -1;
    let globalMinGPA = 0;
    let globalMaxGPA = 10;
    
    function updateScales() {
        globalMinGPA = Math.max(0, Math.min(...chartData) - 1.5);
    }
    updateScales();
    
    const width = 600;
    const height = 150;
    const padding = 25;

    // Create Predictor UI
    const container = document.createElement('div');
    container.id = 'muj-cgpa-predictor-container';
    container.className = 'no-print hidden-print d-print-none exclude-from-export';

    container.style.cssText = `
        position: relative;
        margin: 20px 0;
        padding: 15px 20px;
        background-color: #fcfcfc;
        border: 1px solid #e0e0e0;
        border-left: 4px solid #17a2b8;
        border-radius: 8px;
        box-shadow: 0 4px 6px rgba(0,0,0,0.05);
        display: flex;
        flex-direction: column;
        gap: 10px;
        font-family: inherit;
        transition: all 0.3s ease;
    `;

    const styleEl = document.createElement('style');
    styleEl.innerHTML = '@media print { #muj-cgpa-predictor-container, .no-print, .hidden-print, .d-print-none { display: none !important; } }';
    document.head.appendChild(styleEl);

    // Notice we change Expected SGPA input to map to the immediate next semester
    container.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 20px; flex-wrap: wrap; width: 100%;">
            <div style="display: flex; align-items: center; gap: 8px;">
                <strong style="color: #2c3e50; font-size: 16px;">CGPA Predictor</strong>
                <button type="button" id="muj-toggle-chart" style="margin-left: 8px; padding: 4px 10px; background: transparent; color: #64748b; border: 1px solid #cbd5e1; border-radius: 4px; font-size: 12px; font-weight: 600; cursor: pointer; outline: none; transition: all 0.2s; display: flex; align-items: center; gap: 6px;">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>
                    Interactive Chart
                </button>
            </div>
            <div style="display: flex; gap: 10px; align-items: center;">
                <label style="font-size: 14px; margin: 0; color: #555;">Next SGPA:</label>
                <input type="number" id="muj-expected-gpa" step="0.01" min="0" max="10" placeholder="e.g. 9.0" value="${lastKnownGPA.toFixed(2)}" style="padding: 6px 10px; width: 90px; border: 1px solid #cbd5e1; border-radius: 6px; outline: none; font-size: 14px; transition: border-color 0.2s;">
            </div>
            <div style="display: flex; gap: 10px; align-items: center;">
                <label style="font-size: 14px; margin: 0; color: #555;">Credits / Sem:</label>
                <input type="number" id="muj-expected-credits" step="1" min="1" max="30" placeholder="e.g. 24" style="padding: 6px 10px; width: 90px; border: 1px solid #cbd5e1; border-radius: 6px; outline: none; font-size: 14px; transition: border-color 0.2s;">
            </div>
            <div style="font-size: 16px; font-weight: 600; color: #64748b; margin-left: auto;">
                New CGPA: <span id="muj-predicted-cgpa" style="font-size: 18px; color: #334155; padding-left: 5px;">--</span>
            </div>
        </div>
        
        <div id="muj-chart-container" style="width: 100%; overflow: hidden; max-height: 0; opacity: 0; transition: max-height 0.4s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.4s ease;">
            <div style="border-top: 1px solid #e2e8f0; padding-top: 15px; margin-top: 15px; display: flex; flex-direction: column; align-items: center; position: relative;">
                
                <div style="position: absolute; top: 15px; right: 0; display: flex; gap: 5px;">
                    <button type="button" id="muj-rem-sem" style="padding: 2px 8px; font-size: 11px; background: #fef2f2; color: #ef4444; border: 1px solid #fecaca; border-radius: 4px; cursor: pointer; outline: none; transition: opacity 0.2s;">- Sem</button>
                    <button type="button" id="muj-add-sem" style="padding: 2px 8px; font-size: 11px; background: #f0fdf4; color: #22c55e; border: 1px solid #bbf7d0; border-radius: 4px; cursor: pointer; outline: none; transition: opacity 0.2s;">+ Sem</button>
                </div>

                <strong style="color: #475569; font-size: 14px; margin-bottom: 2px;">Drag dashed points to simulate future semesters</strong>
                <span style="font-size: 11px; color: #94a3b8; margin-bottom: 15px; text-align: center;">* Note: Assumes the inputted credits for all future semesters. Actual CGPA may vary slightly if credits differ per semester.</span>
                <svg id="muj-gpa-svg" viewBox="0 0 ${width} ${height}" style="width: 100%; max-width: 600px; height: auto; overflow: visible; touch-action: none;">
                </svg>
            </div>
        </div>
    `;

    // Insert before dvDetail
    let dvDetail = document.getElementById('dvDetail');
    if (dvDetail) {
        dvDetail.parentNode.insertBefore(container, dvDetail);
    } else {
        table.parentNode.insertBefore(container, table);
    }

    const svgEl = container.querySelector('#muj-gpa-svg');
    const inputGpa = container.querySelector('#muj-expected-gpa');
    const inputCredits = container.querySelector('#muj-expected-credits');

    // Chart Renderer
    function renderChart() {
        if (chartData.length < 2) return;
        
        const scaleX = (index) => padding + (index * (width - 2 * padding) / (chartData.length - 1));
        const scaleY = (val) => height - padding - ((val - globalMinGPA) / (globalMaxGPA - globalMinGPA) * (height - 2 * padding));
        
        // Build smooth curve path
        let pathData = `M ${scaleX(0)} ${scaleY(chartData[0])}`;
        for (let i = 1; i < chartData.length; i++) {
            let prevX = scaleX(i - 1);
            let prevY = scaleY(chartData[i - 1]);
            let currX = scaleX(i);
            let currY = scaleY(chartData[i]);
            let cpX = prevX + (currX - prevX) / 2;
            pathData += ` C ${cpX} ${prevY}, ${cpX} ${currY}, ${currX} ${currY}`;
        }
        
        let fillPathData = pathData + ` L ${scaleX(chartData.length - 1)} ${height - padding + 10} L ${scaleX(0)} ${height - padding + 10} Z`;
        
        let pointsHtml = '';
        let labelsHtml = '';
        for (let i = 0; i < chartData.length; i++) {
            let x = scaleX(i);
            let y = scaleY(chartData[i]);
            labelsHtml += `<text x="${x}" y="${height - 5}" font-size="12" fill="#64748b" text-anchor="middle" style="user-select:none;">S${i+1}</text>`;
            
            if (i >= hypotheticalIndexStart) {
                // Interactive / Draggable point
                pointsHtml += `<circle cx="${x}" cy="${y}" r="8" fill="#f8fafc" stroke="#3b82f6" stroke-width="2.5" stroke-dasharray="3" style="cursor:ns-resize;" class="gpa-point drag-point" data-index="${i}"></circle>`;
                labelsHtml += `<text x="${x}" y="${y - 14}" font-size="11" fill="#3b82f6" font-weight="bold" text-anchor="middle" style="pointer-events:none; user-select:none;">${chartData[i].toFixed(2)}</text>`;
            } else {
                // Past point
                pointsHtml += `<circle cx="${x}" cy="${y}" r="5" fill="#fff" stroke="#0ea5e9" stroke-width="2" class="gpa-point"></circle>`;
            }
        }
        
        svgEl.innerHTML = `
            <defs>
                <linearGradient id="gpaGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#0ea5e9" stop-opacity="0.3"/>
                    <stop offset="100%" stop-color="#0ea5e9" stop-opacity="0.0"/>
                </linearGradient>
            </defs>
            <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="#e2e8f0" stroke-width="1"/>
            <line x1="${padding}" y1="${padding}" x2="${width - padding}" y2="${padding}" stroke="#e2e8f0" stroke-width="1" stroke-dasharray="4,4"/>
            <path d="${fillPathData}" fill="url(#gpaGradient)" />
            <path d="${pathData}" fill="none" stroke="#0ea5e9" stroke-width="3" stroke-linecap="round"/>
            ${labelsHtml}
            ${pointsHtml}
        `;
    }

    renderChart();

    // Calculation logic
    function calculate() {
        let expCredits = parseFloat(inputCredits.value);
        let resultEl = document.getElementById('muj-predicted-cgpa');

        if (isNaN(expCredits) || expCredits <= 0) {
            resultEl.innerText = '--';
            resultEl.style.color = '#334155';
            return;
        }

        let totalPoints = currentCGPA * currentCredits;
        let totalCreds = currentCredits;

        // Sum across hypothetical semesters
        if (isChartVisible) {
            // Use all future semesters plotted on the chart
            for (let i = hypotheticalIndexStart; i < chartData.length; i++) {
                totalPoints += chartData[i] * expCredits;
                totalCreds += expCredits;
            }
        } else {
            // Only use the immediate next semester synced with the input box
            if (hypotheticalIndexStart < chartData.length) {
                totalPoints += chartData[hypotheticalIndexStart] * expCredits;
                totalCreds += expCredits;
            }
        }

        let predicted = totalPoints / totalCreds;
        resultEl.innerText = predicted.toFixed(2);

        if (predicted > currentCGPA) {
            resultEl.style.color = '#10b981'; // Green
        } else if (predicted < currentCGPA) {
            resultEl.style.color = '#ef4444'; // Red
        } else {
            resultEl.style.color = '#3b82f6'; // Blue
        }
    }

    // Drag Logic
    svgEl.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('drag-point')) {
            e.preventDefault();
            draggingIndex = parseInt(e.target.getAttribute('data-index'));
        }
    });

    window.addEventListener('mousemove', (e) => {
        if (draggingIndex !== -1) {
            let svgRect = svgEl.getBoundingClientRect();
            // Map mouse Y to SVG viewBox Y
            let y = (e.clientY - svgRect.top) * (height / svgRect.height);
            
            // Reverse scaleY
            let val = globalMinGPA + ((height - padding - y) / (height - 2 * padding)) * (globalMaxGPA - globalMinGPA);
            
            if (val > 10) val = 10;
            if (val < 0) val = 0;
            
            chartData[draggingIndex] = val;
            
            // Sync with input box if dragging the first hypothetical sem
            if (draggingIndex === hypotheticalIndexStart) {
                inputGpa.value = val.toFixed(2);
            }
            
            renderChart();
            calculate();
        }
    });

    window.addEventListener('mouseup', () => {
        draggingIndex = -1;
    });

    // Inputs logic
    inputGpa.addEventListener('keydown', function (e) {
        if (['-', '+', 'e', 'E'].includes(e.key)) e.preventDefault();
    });
    inputCredits.addEventListener('keydown', function (e) {
        if (['-', '+', 'e', 'E', '.'].includes(e.key)) e.preventDefault();
    });

    inputGpa.addEventListener('input', function (e) {
        let val = parseFloat(e.target.value);
        if (val > 10) val = 10;
        else if (val < 0) val = 0;
        
        if (!isNaN(val) && hypotheticalIndexStart < chartData.length) {
            chartData[hypotheticalIndexStart] = val;
            updateScales();
            renderChart();
        }
        calculate();
    });

    inputCredits.addEventListener('input', function(e) {
        let val = parseFloat(e.target.value);
        if (val > 30) e.target.value = 30;
        calculate();
    });

    // Toggle logic
    const toggleBtn = container.querySelector('#muj-toggle-chart');
    const chartContainer = container.querySelector('#muj-chart-container');
    
    toggleBtn.addEventListener('click', (e) => {
        e.preventDefault();
        isChartVisible = !isChartVisible;
        if (isChartVisible) {
            chartContainer.style.maxHeight = '300px';
            chartContainer.style.opacity = '1';
            toggleBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg> Close Chart`;
            toggleBtn.style.background = '#f8fafc';
            toggleBtn.style.color = '#475569';
            toggleBtn.style.borderColor = '#cbd5e1';
        } else {
            chartContainer.style.maxHeight = '0';
            chartContainer.style.opacity = '0';
            toggleBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg> Interactive Chart`;
            toggleBtn.style.background = 'transparent';
            toggleBtn.style.color = '#64748b';
            toggleBtn.style.borderColor = '#cbd5e1';
        }
        calculate(); // Recalculate based on visibility
    });

    const btnAddSem = container.querySelector('#muj-add-sem');
    const btnRemSem = container.querySelector('#muj-rem-sem');
    
    function updateBtnState() {
        if (!btnAddSem || !btnRemSem) return;
        btnAddSem.disabled = chartData.length >= 6;
        btnAddSem.style.opacity = btnAddSem.disabled ? '0.5' : '1';
        btnAddSem.style.cursor = btnAddSem.disabled ? 'not-allowed' : 'pointer';
        
        btnRemSem.disabled = chartData.length <= hypotheticalIndexStart + 1;
        btnRemSem.style.opacity = btnRemSem.disabled ? '0.5' : '1';
        btnRemSem.style.cursor = btnRemSem.disabled ? 'not-allowed' : 'pointer';
    }
    
    if (btnAddSem && btnRemSem) {
        updateBtnState();
        btnAddSem.addEventListener('click', (e) => {
            e.preventDefault();
            if (chartData.length < 6) {
                chartData.push(chartData[chartData.length - 1]);
                updateBtnState();
                updateScales();
                renderChart();
                calculate();
            }
        });
        
        btnRemSem.addEventListener('click', (e) => {
            e.preventDefault();
            if (chartData.length > hypotheticalIndexStart + 1) {
                chartData.pop();
                updateBtnState();
                updateScales();
                renderChart();
                calculate();
            }
        });
    }

    calculate(); // Initial calculation
}

const observer = new MutationObserver(() => {
    // Highly optimized check: O(1) DOM lookup instead of O(N) querySelector on every single mutation.
    if (!document.getElementById('muj-cgpa-predictor-container')) {
        initCGPAPredictor();
    }
});

observer.observe(document.body, { childList: true, subtree: true });
setTimeout(initCGPAPredictor, 500);
