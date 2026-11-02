/**
 * Компоновка диаграммы Ганта с защитой от NaN.
 * Rollup по разделу, baseline, масштаб, критический путь.
 */
function layoutGantt(data, options = {}) {
    const { title, startDate, sections, scaleMode } = data;
    const {
        rowHeight = 30,
        sectionHeaderHeight = 26,
        headerHeight = 40,
        leftMargin = 200,
        rightMargin = 40,
        topMargin = 90,
        bottomMargin = 40,
        dayWidth = 30,
        barHeight = 20,
        barRadius = 4,
        sectionGap = 8,
        maxChartWidth = 1200,
        minDayWidth = 8,
        maxTotalDays = 730,
        commentLineHeight = 14,
        maxCommentLines = 3,
        commentPadding = 2,
        showRollup = true
    } = options;

    let start = typeof startOfDay === 'function' ? startOfDay(startDate) : new Date(startDate);
    if (!start || isNaN(start.getTime())) {
        start = typeof startOfToday === 'function' ? startOfToday() : new Date();
        start.setHours(0, 0, 0, 0);
    }

    let minDate = new Date(start.getTime());
    let maxDate = new Date(start.getTime());
    let hasValidDates = false;

    function consider(d) {
        if (!d || isNaN(d.getTime())) return;
        if (d.getTime() < minDate.getTime()) minDate = new Date(d);
        if (d.getTime() > maxDate.getTime()) maxDate = new Date(d);
        hasValidDates = true;
    }

    sections.forEach(section => {
        section.tasks.forEach(task => {
            consider(task.computedStart);
            consider(task.computedEnd);
            consider(task.baselineStart);
            consider(task.baselineEnd);
        });
    });

    if (!hasValidDates) {
        minDate = new Date(start);
        maxDate = new Date(start);
        maxDate.setDate(maxDate.getDate() + 30);
    }

    minDate = typeof startOfDay === 'function' ? startOfDay(minDate) : minDate;
    maxDate = typeof startOfDay === 'function' ? startOfDay(maxDate) : maxDate;
    if (minDate) minDate.setDate(minDate.getDate() - 2);
    if (maxDate) maxDate.setDate(maxDate.getDate() + 2);

    let totalDays = typeof diffCalendarDays === 'function'
        ? diffCalendarDays(minDate, maxDate) + 1
        : Math.ceil((maxDate - minDate) / (1000 * 60 * 60 * 24)) + 1;
    if (!isFinite(totalDays) || totalDays < 1) {
        totalDays = 30;
        maxDate = new Date(minDate);
        maxDate.setDate(maxDate.getDate() + totalDays - 1);
    }
    if (totalDays > maxTotalDays) {
        totalDays = maxTotalDays;
        maxDate = new Date(minDate);
        maxDate.setDate(maxDate.getDate() + totalDays - 1);
    }

    let effectiveDayWidth = dayWidth;
    let chartWidth = totalDays * effectiveDayWidth;
    if (chartWidth > maxChartWidth) {
        effectiveDayWidth = Math.max(minDayWidth, maxChartWidth / totalDays);
        chartWidth = totalDays * effectiveDayWidth;
    }

    const taskPositions = [];
    let y = topMargin + headerHeight;
    let contentHeight = 0;

    function xForDate(d) {
        if (!d || isNaN(d.getTime())) return leftMargin;
        const diffStart = typeof diffCalendarDays === 'function'
            ? diffCalendarDays(minDate, d)
            : Math.round((d.getTime() - minDate.getTime()) / (1000 * 60 * 60 * 24));
        return leftMargin + Math.max(0, diffStart) * effectiveDayWidth;
    }

    sections.forEach(section => {
        let secMin = null;
        let secMax = null;
        section.tasks.forEach((task) => {
            if (task.computedStart && (!secMin || task.computedStart < secMin)) secMin = task.computedStart;
            if (task.computedEnd && (!secMax || task.computedEnd > secMax)) secMax = task.computedEnd;
        });

        const rollupX = secMin ? xForDate(secMin) : leftMargin;
        const rollupW = (secMin && secMax)
            ? Math.max(4, xForDate(secMax) + effectiveDayWidth - rollupX)
            : 0;

        taskPositions.push({
            isSectionHeader: true,
            name: section.name,
            sectionName: section.name,
            rowY: y,
            rowHeight: sectionHeaderHeight,
            x: leftMargin,
            y: y,
            width: 0,
            height: 0,
            isRollup: showRollup && rollupW > 0,
            rollupX,
            rollupWidth: rollupW
        });
        y += sectionHeaderHeight;
        contentHeight += sectionHeaderHeight;

        section.tasks.forEach(task => {
            let extraHeight = 0;
            let commentLines = 0;
            if (task.comment) {
                commentLines = Math.min(Math.ceil(task.comment.length / 40), maxCommentLines);
                extraHeight = commentLines * commentLineHeight + commentPadding;
            }
            if (task.assignee) {
                extraHeight += 12;
            }
            const currentRowHeight = rowHeight + extraHeight;

            let startOffset = 0;
            let duration = 1;
            const startTime = task.computedStart && isFinite(task.computedStart.getTime()) ? task.computedStart.getTime() : NaN;
            const endTime = task.computedEnd && isFinite(task.computedEnd.getTime()) ? task.computedEnd.getTime() : NaN;

            if (isFinite(startTime) && isFinite(endTime)) {
                const diffStart = typeof diffCalendarDays === 'function'
                    ? diffCalendarDays(minDate, task.computedStart)
                    : (startTime - minDate.getTime()) / (1000 * 60 * 60 * 24);
                const diffEnd = typeof diffCalendarDays === 'function'
                    ? diffCalendarDays(task.computedStart, task.computedEnd)
                    : (endTime - startTime) / (1000 * 60 * 60 * 24);
                startOffset = Math.max(0, Math.round(diffStart));
                duration = Math.max(1, Math.round(diffEnd) + 1);
                if (task.isMilestone) duration = 0;
                if (startOffset < 0) startOffset = 0;
            }

            if (!isFinite(startOffset)) startOffset = 0;
            if (!isFinite(duration)) duration = 1;

            const x = leftMargin + startOffset * effectiveDayWidth;
            const width = task.isMilestone ? 0 : Math.max(duration * effectiveDayWidth, 2);

            let baselineX = null;
            let baselineWidth = null;
            if (task.baselineStart && task.baselineEnd) {
                baselineX = xForDate(task.baselineStart);
                const bx2 = xForDate(task.baselineEnd) + (task.isMilestone ? 0 : effectiveDayWidth);
                baselineWidth = Math.max(2, bx2 - baselineX);
            }

            taskPositions.push({
                ...task,
                isSectionHeader: false,
                isMilestone: !!task.isMilestone,
                progress: (typeof task.progress === 'number') ? task.progress : null,
                isCritical: !!task.isCritical,
                assignee: task.assignee || null,
                x: x,
                y: y,
                width: width,
                height: barHeight,
                rowY: y,
                rowHeight: currentRowHeight,
                sectionName: section.name,
                duration: duration,
                originalDuration: task.duration,
                startDate: task.computedStart || minDate,
                endDate: task.computedEnd || maxDate,
                comment: task.comment || null,
                extraHeight: extraHeight,
                commentLines: commentLines,
                baselineX,
                baselineWidth
            });
            y += currentRowHeight;
            contentHeight += currentRowHeight;
        });
        y += sectionGap;
        contentHeight += sectionGap;
    });

    const totalChartHeight = contentHeight + headerHeight + bottomMargin;

    let scaleStep = 1;
    let scaleLabelFormat = 'day';
    const mode = (scaleMode || 'auto').toLowerCase();
    if (mode === 'day') {
        scaleStep = 1;
        scaleLabelFormat = 'day';
    } else if (mode === 'week') {
        scaleStep = 7;
        scaleLabelFormat = 'week';
    } else if (mode === 'month') {
        scaleStep = 30;
        scaleLabelFormat = 'month';
    } else if (totalDays <= 14) {
        scaleStep = 1;
        scaleLabelFormat = 'day';
    } else if (totalDays <= 60) {
        scaleStep = 7;
        scaleLabelFormat = 'week';
    } else {
        scaleStep = 30;
        scaleLabelFormat = 'month';
    }

    return {
        title,
        startDate: minDate,
        chartOriginDate: new Date(minDate.getTime()),
        endDate: maxDate,
        totalDays,
        dayWidth: effectiveDayWidth,
        leftMargin,
        topMargin,
        bottomMargin,
        rightMargin,
        rowHeight,
        headerHeight,
        barHeight,
        barRadius,
        chartWidth,
        chartHeight: totalChartHeight,
        sections,
        tasks: taskPositions,
        sectionGap,
        commentLineHeight,
        commentPadding,
        scaleStep,
        scaleLabelFormat
    };
}
