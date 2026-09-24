const storage = (typeof browser !== 'undefined' && browser.storage) ? browser.storage.local : chrome.storage.local;

storage.get({ 'mujfish_dashboard_enabled': true }, function(data) {
    let isEnabled = data.mujfish_dashboard_enabled;
    
    // Inject Toggle Button
    let toggleBtn = document.createElement('button');
    toggleBtn.innerHTML = isEnabled ? '<i class="la la-toggle-on"></i> Enhanced View' : '<i class="la la-toggle-off"></i> Classic View';
    toggleBtn.style.cssText = `
        position: fixed;
        bottom: 20px;
        left: 20px;
        z-index: 9999;
        background: ${isEnabled ? '#f0fdf4' : '#f8fafc'};
        color: ${isEnabled ? '#166534' : '#475569'};
        border: 1px solid ${isEnabled ? '#bbf7d0' : '#cbd5e1'};
        padding: 6px 12px;
        border-radius: 4px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        transition: all 0.2s ease;
        display: flex;
        align-items: center;
        gap: 6px;
    `;
    toggleBtn.onclick = function() {
        storage.set({ 'mujfish_dashboard_enabled': !isEnabled }, function() {
            window.location.reload();
        });
    };
    
    // Ensure body exists before appending
    let appendInterval = setInterval(() => {
        if (document.body) {
            document.body.appendChild(toggleBtn);
            clearInterval(appendInterval);
        }
    }, 100);

    if (!isEnabled) {
        return; // Stop execution here to leave default dashboard intact
    }

let currentViewDate = new Date();

function formatDateForAPI(dateObj) {
    if (typeof moment !== 'undefined') {
        return moment(dateObj).format('L');
    }
    return dateObj.toLocaleDateString('en-US'); // Fallback
}

function formatDateForDisplay(dateObj) {
    return dateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

let currentFetchId = 0;

function fetchClassesForDate(dateObj) {
    let dateParam = formatDateForAPI(dateObj);
    let targetContainer = document.getElementById('mujfish-classes-container');
    
    if (targetContainer) {
        targetContainer.innerHTML = '<div class="alert alert-info" style="padding: 10px; font-size: 0.9em;">Loading classes...</div>';
    }

    currentFetchId++;
    let thisFetchId = currentFetchId;

    fetch('/Student/Academic/GetStudentCalenderEventList', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `Year=&Month=&Type=agendaDay&Dated=${encodeURIComponent(dateParam)}&PreNext=3`
    })
    .then(response => response.json())
    .then(calendarData => {
        if (thisFetchId !== currentFetchId) return;

        let todayHtml = `<div class="alert alert-secondary" style="padding: 10px; font-size: 0.9em;">No classes scheduled for this date.</div>`;
        if (calendarData && calendarData.length > 0) {
            
            // Sort classes chronologically
            calendarData.sort((a, b) => {
                let dateA = new Date(a.StartDate || 0);
                let dateB = new Date(b.StartDate || 0);
                return dateA - dateB;
            });

            todayHtml = `<div style="display: flex; flex-direction: column; gap: 10px;">`;
            calendarData.forEach(item => {
                let color = (item.eventColorCode || '#6c6c6c').toLowerCase().trim();
                let safeColor = color.replace('!important', '').trim(); // Remove !important for inline styles
                let title = item.Description || item.title || '';
                
                let statusIcon = '<i class="la la-clock-o"></i> Pending / Not Marked';
                let statusColor = 'color: #6c6c6c;';
                
                if (color.includes('#3d9400')) {
                    statusIcon = '<i class="la la-check-circle"></i> Attendance Marked';
                    statusColor = 'color: #3d9400; font-weight: 500;';
                } else if (color.includes('#820c0c')) {
                    statusIcon = '<i class="la la-exclamation-circle"></i> Rescheduled';
                    statusColor = 'color: #820c0c; font-weight: 500;';
                } else if (color.includes('#800000')) {
                    statusIcon = '<i class="la la-times-circle"></i> Cancelled';
                    statusColor = 'color: #800000; font-weight: 500;';
                } else if (color.includes('#6c6c6c') || color.includes('#808080') || color.includes('grey') || color.includes('gray') || color === '') {
                    statusIcon = '<i class="la la-clock-o"></i> Pending / Not Marked';
                    statusColor = 'color: #6c6c6c;';
                    safeColor = '#6c6c6c';
                } else {
                    // Any other unrecognized color 
                    statusIcon = '<i class="la la-info-circle"></i> Scheduled Event';
                    statusColor = `color: ${safeColor}; font-weight: 500;`;
                }

                let eventId = item.EntryNo || item.id || '';

                todayHtml += `
                    <div id="class-card-${eventId}" style="border-left: 4px solid ${safeColor}; padding: 12px; background-color: #f8f9fa; border-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); margin-bottom: 2px;">
                        <div style="font-weight: 500; font-size: 0.9em; margin-bottom: 6px; color: #333; line-height: 1.3;">${title}</div>
                        <div style="font-size: 0.85em; ${statusColor}" id="class-status-${eventId}">
                            ${statusIcon}
                        </div>
                    </div>
                `;
            });
            todayHtml += `</div>`;
        }
        
        if (targetContainer) {
            targetContainer.innerHTML = todayHtml;
            
            // Automatically fetch the exact Present/Absent status for every class on the timetable!
            if (calendarData && calendarData.length > 0) {
                calendarData.forEach(item => {
                    let eventId = item.EntryNo || item.id || '';
                    if (eventId) {
                        fetch('/Student/Academic/GetEventDetailStudent', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                            body: 'EventID=' + eventId
                        })
                        .then(r => r.json())
                        .then(detail => {
                            if (thisFetchId !== currentFetchId) return; // Prevent overwriting if user changed days
                            
                            let statusEl = document.getElementById(`class-status-${eventId}`);
                            let cardEl = document.getElementById(`class-card-${eventId}`);
                            
                            if (statusEl && detail.AttendanceType) {
                                let attType = detail.AttendanceType.trim();
                                if (attType) {
                                    // Override the default "Attendance Marked" with the actual "Present" or "Absent" text
                                    statusEl.innerHTML = `<i class="la la-user"></i> <strong style="font-size: 1.05em;">${attType}</strong>`;
                                    
                                    // Make absent/not considered more prominent by changing the text color and border
                                    let typeLower = attType.toLowerCase();
                                    if (typeLower.includes('absent')) {
                                        statusEl.style.color = '#e53935';
                                        if (cardEl) cardEl.style.borderLeftColor = '#e53935';
                                    } else if (typeLower.includes('not considered')) {
                                        statusEl.style.color = '#2196f3';
                                        if (cardEl) cardEl.style.borderLeftColor = '#2196f3';
                                    }
                                }
                            }
                        }).catch(e => console.error("MUJFISH: Error fetching detail for", eventId, e));
                    }
                });
            }
        }
    })
    .catch(e => {
        if (thisFetchId !== currentFetchId) return;
        console.error("MUJFISH: Error fetching classes", e);
        if (targetContainer) {
            targetContainer.innerHTML = '<div class="alert alert-danger" style="padding: 10px; font-size: 0.9em;">Error loading classes.</div>';
        }
    });
}

function changeDate(days) {
    currentViewDate.setDate(currentViewDate.getDate() + days);
    let dateDisplay = document.getElementById('mujfish-date-display');
    if(dateDisplay) {
        dateDisplay.textContent = formatDateForDisplay(currentViewDate);
    }
    fetchClassesForDate(currentViewDate);
}

// 1. Initial Load of Attendance Summary
fetch('/Student/Academic/GetAttendanceSummaryList', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'StudentCode='
}).then(response => response.json())
.then(summaryData => {
    
    // Build Summary Table HTML
    let summaryHtml = `<div class="alert alert-secondary">No attendance data available.</div>`;
    if (summaryData && summaryData.IsSuccessfull && summaryData.AttendanceSummaryList) {
        summaryHtml = `
            <table class="table table-striped table-bordered table-hover">
                <thead>
                    <tr style="background-color: #f3f6f9;">
                        <th style="text-align: center;">S. No.</th>
                        <th>Course Name</th>
                        <th style="text-align: center;">Present</th>
                        <th style="text-align: center;">Absent</th>
                        <th style="text-align: center;">Total</th>
                        <th style="text-align: center;">%</th>
                    </tr>
                </thead>
                <tbody>`;
        
        let sno = 0;
        
        // Sort highest to lowest percentage
        summaryData.AttendanceSummaryList.sort((a, b) => {
            let pA = parseFloat(a.Percentage) || 0;
            let pB = parseFloat(b.Percentage) || 0;
            return pB - pA;
        });
        
        summaryData.AttendanceSummaryList.forEach(item => {
            sno++;
            summaryHtml += `
                <tr>
                    <td style="text-align: center;">${sno}</td>
                    <td>${item.CourseID || ''}</td>
                    <td style="text-align: center;">${item.Present || 0}</td>
                    <td style="text-align: center;">${item.Absent || 0}</td>
                    <td style="text-align: center;">${item.Total || 0}</td>
                    <td style="text-align: center; font-weight: bold;">${item.Percentage || 0}</td>
                </tr>
            `;
        });
        summaryHtml += `</tbody></table>`;
    }

    // 2. Build Mini Timetable Header HTML
    let leftColHtml = `
        <div style="display: flex; flex-direction: column; gap: 15px;">
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #ebedf2; padding-bottom: 10px;">
                <h6 style="margin: 0; font-weight: 600; color: #464457; font-size: 1rem;">Timetable</h6>
                <div style="display: flex; align-items: center; gap: 5px; background: #f3f6f9; padding: 4px 8px; border-radius: 4px;">
                    <button id="mujfish-prev-day" style="background: none; border: none; font-weight: bold; font-size: 1.1em; cursor: pointer; color: #555; padding: 0 5px;">&lt;</button>
                    <span id="mujfish-date-display" style="font-size: 0.85em; font-weight: bold; min-width: 75px; text-align: center; color: #333;">
                        ${formatDateForDisplay(currentViewDate)}
                    </span>
                    <button id="mujfish-next-day" style="background: none; border: none; font-weight: bold; font-size: 1.1em; cursor: pointer; color: #555; padding: 0 5px;">&gt;</button>
                </div>
            </div>
            <div id="mujfish-classes-container">
                <div class="alert alert-info" style="padding: 10px; font-size: 0.9em;">Loading classes...</div>
            </div>
        </div>
    `;

    // 3. Inject Left Column (Timetable) & Right Column (Summary)
    let eventTable = document.getElementById('kt_ViewEvent');
    if (eventTable) {
        // The list of events is inside a col-md-9 column.
        let colMd9 = eventTable.closest('.col-md-9') || eventTable.closest('.col-lg-9');
        
        if (colMd9 && colMd9.previousElementSibling) {
            
            // The column right before col-md-9 is exactly the col-md-3 containing Notifications!
            let leftCol = colMd9.previousElementSibling; 
            
            let enforceTimetable = setInterval(() => {
                if (!leftCol.querySelector('#mujfish-classes-container')) {
                    leftCol.innerHTML = leftColHtml;
                    
                    let btnPrev = document.getElementById('mujfish-prev-day');
                    let btnNext = document.getElementById('mujfish-next-day');
                    if(btnPrev) btnPrev.addEventListener('click', () => changeDate(-1));
                    if(btnNext) btnNext.addEventListener('click', () => changeDate(1));
                    
                    fetchClassesForDate(currentViewDate);
                }
            }, 500);
            setTimeout(() => clearInterval(enforceTimetable), 10000);
        }

        // 3B. Inject Attendance Summary above List of Events inside col-md-9
        if (!document.getElementById('mujfish-summary-container')) {
            let dashboardHtml = `
                <div id="mujfish-summary-container" style="margin-bottom: 25px;">
                    <h6>Attendance Summary</h6><hr/>
                    <div style="overflow-x: auto;">
                        ${summaryHtml}
                    </div>
                </div>
            `;
            let container = document.createElement('div');
            container.innerHTML = dashboardHtml;
            
            let searchScope = colMd9 ? colMd9 : document;
            let listEventsHeader = Array.from(searchScope.querySelectorAll('h6')).find(el => el.textContent.trim().includes('List of Events'));
            
            if (listEventsHeader) {
                listEventsHeader.parentElement.insertBefore(container, listEventsHeader);
                // Hide List of Events header and HR
                listEventsHeader.style.display = 'none';
                if (listEventsHeader.nextElementSibling && listEventsHeader.nextElementSibling.tagName === 'HR') {
                    listEventsHeader.nextElementSibling.style.display = 'none';
                }
            } else {
                let targetNode = eventTable.parentElement;
                if (targetNode.previousElementSibling && targetNode.previousElementSibling.tagName === 'HR') {
                    targetNode = targetNode.previousElementSibling;
                }
                if (targetNode.previousElementSibling && targetNode.previousElementSibling.tagName === 'H6') {
                    targetNode = targetNode.previousElementSibling;
                }
                targetNode.parentElement.insertBefore(container, targetNode);
            }
            
            // Hide the event table itself and its container wrapper
            if (eventTable) {
                eventTable.style.display = 'none';
                if (eventTable.parentElement) {
                    eventTable.parentElement.style.display = 'none';
                }
            }
        }
    }
})
.catch(e => console.error("MUJFISH: Error fetching data for dashboard:", e));
});
