(function () {
    const LOG_PREFIX = "[SLCM Attendance Highlighter]";
    const ABSENT_BG = "#e74c3c";
    const ABSENT_BORDER = "#c0392b";
    const NOT_CONSIDERED_BG = "#2196f3";
    const NOT_CONSIDERED_BORDER = "#1976d2";

    let currentProcessId = 0;
    const attendanceCache = {};

    function getEventId(e) {
        return e.EntryNo || e.id || e.Id || e.EventID || e.eventID;
    }

    function applyAttendance(evtId, attendanceType, markNeedsRerender) {
        if (attendanceType === "Absent") {
            if (typeof window.jQuery("#calendar").fullCalendar === "function") {
                const clientEvents = window.jQuery("#calendar").fullCalendar("clientEvents", evtId);
                if (clientEvents && clientEvents.length > 0) {
                    clientEvents[0].backgroundColor = ABSENT_BG;
                    clientEvents[0].borderColor = ABSENT_BORDER;
                    clientEvents[0].title = clientEvents[0].title.replace("🔴 ABSENT\n", "");
                    if (markNeedsRerender) markNeedsRerender();
                }
            }
        } else if (attendanceType === "Not Considered") {
            if (typeof window.jQuery("#calendar").fullCalendar === "function") {
                const clientEvents = window.jQuery("#calendar").fullCalendar("clientEvents", evtId);
                if (clientEvents && clientEvents.length > 0) {
                    clientEvents[0].backgroundColor = NOT_CONSIDERED_BG;
                    clientEvents[0].borderColor = NOT_CONSIDERED_BORDER;
                    if (markNeedsRerender) markNeedsRerender();
                }
            }
        }
    }

    function processEvents(events) {
        currentProcessId++;
        let thisProcessId = currentProcessId;

        console.log(LOG_PREFIX, "Total events received:", events.length);

        const eventsToProcess = events.filter((e) => getEventId(e) != null);
        console.log(LOG_PREFIX, "Events to check this pass:", eventsToProcess.length);

        let loadingIndicator = window.jQuery('#slcm-loading-indicator');
        if (eventsToProcess.length > 0) {
            if (!loadingIndicator.length) {
                loadingIndicator = window.jQuery('<div id="slcm-loading-indicator" style="position: fixed; bottom: 20px; right: 20px; background: #34495e; color: white; padding: 10px 15px; border-radius: 5px; z-index: 9999; box-shadow: 0 4px 6px rgba(0,0,0,0.3); font-family: sans-serif; font-size: 14px; transition: opacity 0.3s;"></div>');
                window.jQuery('body').append(loadingIndicator);
            }
            loadingIndicator.text(`Syncing Attendance... (0/${eventsToProcess.length})`).css({ opacity: '1', background: '#34495e' });
        }

        let index = 0;
        let needsRerender = false;
        
        function markRerender() {
            needsRerender = true;
        }

        function next() {
            if (thisProcessId !== currentProcessId) {
                console.log(LOG_PREFIX, "Aborting outdated loop");
                return;
            }

            if (index >= eventsToProcess.length) {
                if (needsRerender && typeof window.jQuery !== "undefined" &&
                    typeof window.jQuery("#calendar").fullCalendar === "function") {
                    window.jQuery("#calendar").fullCalendar("rerenderEvents");
                    console.log(LOG_PREFIX, "Rerendered calendar");
                }

                if (eventsToProcess.length > 0 && loadingIndicator.length) {
                    loadingIndicator.text('Attendance Synced!').css('background', '#27ae60');
                    setTimeout(() => {
                        if (thisProcessId === currentProcessId) {
                            loadingIndicator.css('opacity', '0');
                        }
                    }, 2000);
                }
                return;
            }

            if (loadingIndicator.length) {
                loadingIndicator.text(`Syncing Attendance... (${index}/${eventsToProcess.length})`);
            }

            const evt = eventsToProcess[index];
            const evtId = getEventId(evt);
            index++;

            if (attendanceCache[evtId] !== undefined) {
                applyAttendance(evtId, attendanceCache[evtId], markRerender);
                setTimeout(next, 0);
                return;
            }

            window.jQuery.ajax({
                type: "POST",
                url: "/Student/Academic/GetEventDetailStudent",
                dataType: "json",
                data: { EventID: evtId },
                success: function (response) {
                    if (thisProcessId !== currentProcessId) return;

                    const attendanceType =
                        (response && response.AttendanceType) ||
                        (response && response.data && response.data.AttendanceType) ||
                        (response && response.Result && response.Result.AttendanceType);

                    let parsedType = attendanceType ? attendanceType.trim() : "";
                    attendanceCache[evtId] = parsedType;
                    
                    applyAttendance(evtId, parsedType, markRerender);
                },
                complete: function () {
                    setTimeout(next, 10);
                },
            });
        }
        next();
    }

    function hookAjax() {
        if (typeof window.jQuery === "undefined") {
            console.warn(LOG_PREFIX, "jQuery not found yet, retrying...");
            setTimeout(hookAjax, 500);
            return;
        }

        window.jQuery(document).ajaxSuccess(function (event, xhr, settings) {
            if (settings.url && settings.url.includes("GetStudentCalenderEventList")) {
                try {
                    const events = JSON.parse(xhr.responseText);
                    processEvents(events);
                } catch (e) {
                    console.error(LOG_PREFIX, "Error parsing events", e);
                }
            }
        });

        console.log(LOG_PREFIX, "Hooked into ajaxSuccess, waiting for calendar load...");

        setTimeout(() => {
            const $ = window.jQuery;
            if ($("#calendar").length && typeof $("#calendar").fullCalendar === "function") {
                if ($('#st-custom-legends').length === 0) {
                    const legendHtml = `
                        <span id="st-custom-legends" style="display: inline-flex; align-items: center; gap: 20px; font-family: sans-serif; font-size: 14px; margin-left: 20px;">
                            <span style="display: inline-flex; align-items: center; gap: 5px;">
                                <span style="display: inline-block; width: 15px; height: 15px; background-color: #e74c3c; border: 1px solid #c0392b; border-radius: 3px;"></span>
                                <span>Signifies the class is marked as Absent</span>
                            </span>
                            <span style="display: inline-flex; align-items: center; gap: 5px;">
                                <span style="display: inline-block; width: 15px; height: 15px; background-color: #2196f3; border: 1px solid #1976d2; border-radius: 3px;"></span>
                                <span>Signifies the class is Not Considered</span>
                            </span>
                        </span>
                    `;
                    
                    const rescheduleText = $('*:contains("Signifies the class reschedule is marked")').filter(function() {
                        return $(this).children().length === 0;
                    }).last();

                    if (rescheduleText.length) {
                        rescheduleText.after(legendHtml);
                    } else {
                        $('#calendar').before(legendHtml);
                    }
                }

                const clientEvents = $("#calendar").fullCalendar("clientEvents");
                if (clientEvents && clientEvents.length > 0) {
                    console.log(LOG_PREFIX, "Found pre-loaded events, processing...");
                    processEvents(clientEvents);
                }
            }
        }, 1500);
    }

    hookAjax();
})();