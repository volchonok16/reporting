function generateGanttSVG(layoutData, themeColors) {
    const {
        title,
        startDate,
        chartOriginDate,
        totalDays,
        dayWidth,
        leftMargin,
        topMargin,
        bottomMargin,
        rightMargin,
        rowHeight,
        headerHeight,
        barHeight,
        barRadius,
        chartWidth,
        chartHeight,
        tasks,
        sections,
        commentLineHeight,
        commentPadding,
        scaleStep,
        scaleLabelFormat
    } = layoutData;

    // Защита от некорректных значений
    const safeTotalDays = (isFinite(totalDays) && totalDays > 0) ? totalDays : 1;
    const safeDayWidth = (isFinite(dayWidth) && dayWidth > 0) ? dayWidth : 25;
    const safeHeaderHeight = (isFinite(headerHeight) && headerHeight > 0) ? headerHeight : 40;
    const safeChartHeight = (isFinite(chartHeight) && chartHeight > 0) ? chartHeight : 200;
    const safeChartWidth = (isFinite(chartWidth) && chartWidth > 20) ? chartWidth : 200;
    const safeTopMargin = (isFinite(topMargin) && topMargin > 0) ? topMargin : 90;
    const safeBottomMargin = (isFinite(bottomMargin) && bottomMargin > 0) ? bottomMargin : 40;
    const safeLeftMargin = (isFinite(leftMargin) && leftMargin > 0) ? leftMargin : 180;
    const safeRightMargin = (isFinite(rightMargin) && rightMargin > 0) ? rightMargin : 40;
    const safeRowHeight = (isFinite(rowHeight) && rowHeight > 0) ? rowHeight : 30;
    const safeBarHeight = (isFinite(barHeight) && barHeight > 0) ? barHeight : 20;
    const safeBarRadius = (isFinite(barRadius) && barRadius > 0) ? barRadius : 4;
    const safeCommentLineHeight = (isFinite(commentLineHeight) && commentLineHeight > 0) ? commentLineHeight : 14;
    const safeScaleStep = (isFinite(scaleStep) && scaleStep > 0) ? scaleStep : 1;

    const adjustedTopMargin = Math.max(safeTopMargin, 90);
    const totalWidth = safeChartWidth + safeLeftMargin + safeRightMargin;
    const totalHeight = safeChartHeight + adjustedTopMargin + safeBottomMargin;

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${totalWidth} ${totalHeight}`);
    svg.setAttribute("width", totalWidth);
    svg.setAttribute("height", totalHeight);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", title || "Диаграмма Ганта");
    svg.style.fontFamily = (typeof getUiFontFamily === "function" ? getUiFontFamily() : "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif");
    svg.style.fontSize = "12px";

    const isDark = document.body.classList.contains('dark');
    const theme = themeColors || [];
    const primaryColor = theme.length > 0 ? theme[0] : (isDark ? '#60a5fa' : '#3b82f6');
    const textColor = typeof readCssColor === 'function'
        ? readCssColor('--text', isDark ? '#f5f5f7' : '#0f172a')
        : (isDark ? '#f8fafc' : '#1f2937');
    const gridColor = typeof readCssColor === 'function'
        ? readCssColor('--secondary-text', isDark ? '#a1a1a6' : '#64748b')
        : (isDark ? '#94a3b8' : '#64748b');
    // Фон SVG = фон области диаграммы на сайте (не белый/slate)
    const bgColor = typeof readCssColor === 'function'
        ? readCssColor('--diagram-bg', isDark ? '#161618' : '#f8fafc')
        : (isDark ? '#161618' : '#f8fafc');
    const panelColor = typeof readCssColor === 'function'
        ? readCssColor('--panel-bg', isDark ? '#1c1c1e' : '#ffffff')
        : (isDark ? '#1c1c1e' : '#ffffff');
    const sectionHeaderFill = isDark ? 'rgba(0,0,0,0.28)' : 'rgba(15,23,42,0.06)';
    const rowFill = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(15,23,42,0.028)';
    const drawBarRadius = Math.min(safeBarRadius, 4);

    const sectionColors = {};
    sections.forEach((section, index) => {
        sectionColors[section.name] = theme.length > 0 ? theme[index % theme.length] : primaryColor;
    });

    function softSectionFill(hex) {
        if (typeof mixHex !== 'function') return sectionHeaderFill;
        return mixHex(hex, bgColor, isDark ? 0.90 : 0.93);
    }
    function softRowTint(hex) {
        if (typeof mixHex !== 'function') return rowFill;
        return mixHex(hex, bgColor, isDark ? 0.95 : 0.96);
    }
    // ---- ФОН ----
    const bgRect = document.createElementNS(svgNS, "rect");
    bgRect.setAttribute("width", "100%");
    bgRect.setAttribute("height", "100%");
    bgRect.setAttribute("fill", bgColor);
    svg.appendChild(bgRect);

    // ---- ЗАГОЛОВОК ----
    const titleText = document.createElementNS(svgNS, "text");
    titleText.setAttribute("x", safeLeftMargin);
    titleText.setAttribute("y", adjustedTopMargin - 20);
    titleText.setAttribute("fill", textColor);
    titleText.setAttribute("font-size", "18px");
    titleText.setAttribute("font-weight", "bold");
    titleText.textContent = title || 'Диаграмма Ганта';
    svg.appendChild(titleText);

    // ---- ФОН СТРОК / ЗАГОЛОВКИ РАЗДЕЛОВ ----
    const rowsGroup = document.createElementNS(svgNS, "g");
    svg.appendChild(rowsGroup);

    tasks.forEach(task => {
        if (typeof task.rowY !== 'number' || !isFinite(task.rowY)) return;

        if (task.isSectionHeader) {
            const secColor = sectionColors[task.name] || primaryColor;
            const hdrH = task.rowHeight || 26;

            // Спокойная полоса на всю ширину — без яркой цветной линии через чарт
            const hdr = document.createElementNS(svgNS, "rect");
            hdr.setAttribute("x", 0);
            hdr.setAttribute("y", task.rowY);
            hdr.setAttribute("width", totalWidth);
            hdr.setAttribute("height", hdrH);
            hdr.setAttribute("fill", softSectionFill(secColor));
            rowsGroup.appendChild(hdr);

            // Цветной акцент между названием и чартом (не поверх текста)
            const accent = document.createElementNS(svgNS, "rect");
            accent.setAttribute("x", safeLeftMargin - 6);
            accent.setAttribute("y", task.rowY + 5);
            accent.setAttribute("width", 3);
            accent.setAttribute("height", Math.max(8, hdrH - 10));
            accent.setAttribute("rx", "1.5");
            accent.setAttribute("fill", secColor);
            accent.setAttribute("opacity", "0.85");
            rowsGroup.appendChild(accent);

            // Summary / rollup фазы
            if (task.isRollup && task.rollupWidth > 0) {
                const roll = document.createElementNS(svgNS, "rect");
                roll.setAttribute("x", task.rollupX);
                roll.setAttribute("y", task.rowY + 7);
                roll.setAttribute("width", task.rollupWidth);
                roll.setAttribute("height", Math.max(6, hdrH - 14));
                roll.setAttribute("rx", "2");
                roll.setAttribute("fill", secColor);
                roll.setAttribute("opacity", "0.35");
                rowsGroup.appendChild(roll);
            }

            const rule = document.createElementNS(svgNS, "line");
            rule.setAttribute("x1", 0);
            rule.setAttribute("y1", task.rowY + hdrH - 0.5);
            rule.setAttribute("x2", totalWidth);
            rule.setAttribute("y2", task.rowY + hdrH - 0.5);
            rule.setAttribute("stroke", gridColor);
            rule.setAttribute("stroke-width", "1");
            rule.setAttribute("opacity", "0.28");
            rowsGroup.appendChild(rule);

            const hdrText = document.createElementNS(svgNS, "text");
            hdrText.setAttribute("x", safeLeftMargin - 12);
            hdrText.setAttribute("y", task.rowY + hdrH / 2 + 4);
            hdrText.setAttribute("fill", textColor);
            hdrText.setAttribute("text-anchor", "end");
            hdrText.setAttribute("font-size", "12px");
            hdrText.setAttribute("font-weight", "700");
            hdrText.textContent = task.name;
            rowsGroup.appendChild(hdrText);
            return;
        }
        // Дорожки задач без заливки — хватает цвета названия и полосы.
    });

    // ---- ЗАДАЧИ ----
    const taskGroup = document.createElementNS(svgNS, "g");
    svg.appendChild(taskGroup);

    tasks.forEach(task => {
        if (task.isSectionHeader) return;
        if (typeof task.x !== 'number' || !isFinite(task.x) ||
            typeof task.rowY !== 'number' || !isFinite(task.rowY)) {
            return;
        }

        const color = sectionColors[task.sectionName] || primaryColor;
        const taskRowHeight = task.rowHeight || safeRowHeight;
        const barY = task.rowY + (taskRowHeight - safeBarHeight) / 2;

        // Название задачи — цвет раздела (как полоса)
        const nameText = document.createElementNS(svgNS, "text");
        nameText.setAttribute("x", safeLeftMargin - 10);
        nameText.setAttribute("y", task.rowY + taskRowHeight / 2 + (task.assignee ? -2 : 4));
        // The section's colour, darkened until it reads on the panel (pastel names were faint).
        nameText.setAttribute("fill", readableTextColor(color, bgColor));
        nameText.setAttribute("text-anchor", "end");
        nameText.setAttribute("font-size", "12px");
        nameText.setAttribute("font-weight", "600");
        nameText.textContent = task.name;
        nameText.setAttribute('data-label', task.name);
        if (typeof setDiagramSourceLine === 'function') {
            setDiagramSourceLine(nameText, task.sourceLine || task.line);
        }
        taskGroup.appendChild(nameText);

        if (task.assignee) {
            const who = document.createElementNS(svgNS, "text");
            who.setAttribute("x", safeLeftMargin - 10);
            who.setAttribute("y", task.rowY + taskRowHeight / 2 + 12);
            who.setAttribute("fill", readableTextColor(color, bgColor));
            who.setAttribute("text-anchor", "end");
            who.setAttribute("font-size", "10px");
            who.setAttribute("opacity", "0.75");
            who.textContent = '@' + task.assignee;
            taskGroup.appendChild(who);
        }

        if (task.isMilestone) {
            // Веха — короткая вертикальная риска (не ромб)
            const cx = task.x;
            const cy = task.rowY + taskRowHeight / 2;
            const tick = document.createElementNS(svgNS, "rect");
            tick.setAttribute("x", cx - 2);
            tick.setAttribute("y", cy - 9);
            tick.setAttribute("width", 4);
            tick.setAttribute("height", 18);
            tick.setAttribute("rx", "2");
            tick.setAttribute("fill", color);
            if (typeof setDiagramSourceLine === 'function') {
                setDiagramSourceLine(tick, task.sourceLine || task.line);
            }
            taskGroup.appendChild(tick);
        } else {
            const barW = Math.max(task.width || 0, 4);
            const progress = (typeof task.progress === 'number') ? task.progress : null;

            if (progress != null) {
                const bar = document.createElementNS(svgNS, "rect");
                bar.setAttribute("x", task.x);
                bar.setAttribute("y", barY);
                bar.setAttribute("width", barW);
                bar.setAttribute("height", safeBarHeight);
                bar.setAttribute("fill", color);
                bar.setAttribute("opacity", "0.22");
                bar.setAttribute("rx", drawBarRadius);
                bar.setAttribute("ry", drawBarRadius);
                bar.setAttribute("stroke", panelColor);
                bar.setAttribute("stroke-width", "1");
                if (typeof setDiagramSourceLine === 'function') {
                    setDiagramSourceLine(bar, task.sourceLine || task.line);
                }
                taskGroup.appendChild(bar);

                if (progress > 0) {
                    const fillW = Math.max(2, barW * (progress / 100));
                    const barFill = document.createElementNS(svgNS, "rect");
                    barFill.setAttribute("x", task.x);
                    barFill.setAttribute("y", barY);
                    barFill.setAttribute("width", fillW);
                    barFill.setAttribute("height", safeBarHeight);
                    barFill.setAttribute("fill", color);
                    barFill.setAttribute("rx", drawBarRadius);
                    barFill.setAttribute("ry", drawBarRadius);
                    taskGroup.appendChild(barFill);
                }
            } else {
                const bar = document.createElementNS(svgNS, "rect");
                bar.setAttribute("x", task.x);
                bar.setAttribute("y", barY);
                bar.setAttribute("width", barW);
                bar.setAttribute("height", safeBarHeight);
                bar.setAttribute("fill", color);
                bar.setAttribute("rx", drawBarRadius);
                bar.setAttribute("ry", drawBarRadius);
                bar.setAttribute("stroke", typeof mixHex === 'function' ? mixHex(color, '#000000', 0.22) : panelColor);
                bar.setAttribute("stroke-width", "1");
                if (typeof setDiagramSourceLine === 'function') {
                    setDiagramSourceLine(bar, task.sourceLine || task.line);
                }
                taskGroup.appendChild(bar);
            }

            const displayDuration = task.originalDuration || task.duration;
            if (displayDuration !== undefined && displayDuration !== null) {
                const label = progress != null
                    ? `${displayDuration}д · ${progress}%`
                    : `${displayDuration}д`;
                const durText = document.createElementNS(svgNS, "text");
                if (barW >= 36) {
                    durText.setAttribute("x", task.x + barW / 2);
                    durText.setAttribute("y", task.rowY + taskRowHeight / 2);
                    durText.setAttribute("dominant-baseline", "central");
                    durText.setAttribute("text-anchor", "middle");
                    durText.setAttribute("fill", getContrastColor(color));
                    durText.setAttribute("font-weight", "bold");
                } else {
                    durText.setAttribute("x", task.x + barW + 4);
                    durText.setAttribute("y", task.rowY + taskRowHeight / 2);
                    durText.setAttribute("dominant-baseline", "central");
                    durText.setAttribute("fill", readableTextColor(color, bgColor));
                }
                durText.setAttribute("font-size", "10px");
                durText.textContent = label;
                taskGroup.appendChild(durText);
            }
        }

        // Комментарий
        if (task.comment) {
            const barBottom = barY + safeBarHeight;
            const commentY = barBottom + 2;
            const maxCommentWidth = Math.min(280, safeChartWidth - 20);
            const words = task.comment.split(' ');
            let lines = [];
            let currentLine = '';
            const approxCharWidth = 6;

            words.forEach(word => {
                const testLine = currentLine ? currentLine + ' ' + word : word;
                if (testLine.length * approxCharWidth > maxCommentWidth) {
                    if (currentLine) lines.push(currentLine);
                    currentLine = word;
                } else {
                    currentLine = testLine;
                }
            });
            if (currentLine) lines.push(currentLine);

            const maxLines = 3;
            if (lines.length > maxLines) {
                lines = lines.slice(0, maxLines);
                lines[lines.length - 1] = lines[lines.length - 1] + '…';
            }

            lines.forEach((line, idx) => {
                const text = document.createElementNS(svgNS, "text");
                text.setAttribute("x", task.x);
                text.setAttribute("y", commentY + idx * safeCommentLineHeight + 10);
                text.setAttribute("fill", gridColor);
                text.setAttribute("font-size", "10px");
                text.setAttribute("font-style", "italic");
                if (idx === 0) {
                    text.textContent = '📌 ' + line;
                } else {
                    text.setAttribute("x", task.x + 14);
                    text.textContent = line;
                }
                taskGroup.appendChild(text);
            });
        }
    });

    // ---- ВЕРТИКАЛЬНЫЙ РАЗДЕЛИТЕЛЬ ----
    const divider = document.createElementNS(svgNS, "line");
    divider.setAttribute("x1", safeLeftMargin);
    divider.setAttribute("y1", adjustedTopMargin);
    divider.setAttribute("x2", safeLeftMargin);
    divider.setAttribute("y2", adjustedTopMargin + safeHeaderHeight + safeChartHeight - safeHeaderHeight);
    divider.setAttribute("stroke", gridColor);
    divider.setAttribute("stroke-width", "2");
    divider.setAttribute("opacity", "0.6");
    taskGroup.appendChild(divider);

    // ---- ВРЕМЕННАЯ ШКАЛА ----
    const scaleGroup = document.createElementNS(svgNS, "g");
    svg.appendChild(scaleGroup);

    const scaleY = adjustedTopMargin + safeHeaderHeight - 18;
    const scaleBg = document.createElementNS(svgNS, "rect");
    scaleBg.setAttribute("x", safeLeftMargin);
    scaleBg.setAttribute("y", scaleY - 20);
    scaleBg.setAttribute("width", safeChartWidth);
    scaleBg.setAttribute("height", 30);
    scaleBg.setAttribute("fill", bgColor);
    scaleBg.setAttribute("opacity", "0.92");
    scaleGroup.appendChild(scaleBg);

    const scaleLine = document.createElementNS(svgNS, "line");
    scaleLine.setAttribute("x1", safeLeftMargin);
    scaleLine.setAttribute("y1", scaleY);
    scaleLine.setAttribute("x2", safeLeftMargin + safeChartWidth);
    scaleLine.setAttribute("y2", scaleY);
    scaleLine.setAttribute("stroke", gridColor);
    scaleLine.setAttribute("stroke-width", "1.5");
    scaleLine.setAttribute("opacity", "0.6");
    scaleGroup.appendChild(scaleLine);

    const monthNames = ['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
    const step = Math.max(1, Math.min(safeScaleStep, safeTotalDays));
    const chartOrigin = typeof startOfDay === 'function'
        ? startOfDay(chartOriginDate || startDate)
        : new Date(chartOriginDate || startDate);

    function xForChartDayOffset(dayOffset) {
        return safeLeftMargin + dayOffset * safeDayWidth;
    }

    for (let i = 0; i < safeTotalDays; i += step) {
        const date = typeof addCalendarDays === 'function'
            ? addCalendarDays(chartOrigin, i)
            : (() => { const d = new Date(chartOrigin); d.setDate(d.getDate() + i); return d; })();
        if (!date) continue;
        const x = xForChartDayOffset(i);
        if (x > safeLeftMargin + safeChartWidth) break;

        const line = document.createElementNS(svgNS, "line");
        line.setAttribute("x1", x);
        line.setAttribute("y1", scaleY);
        line.setAttribute("x2", x);
        line.setAttribute("y2", adjustedTopMargin + safeHeaderHeight + safeChartHeight - safeHeaderHeight);
        line.setAttribute("stroke", gridColor);
        line.setAttribute("stroke-width", "1.5");
        line.setAttribute("opacity", "0.4");
        scaleGroup.appendChild(line);

        let label = '';
        if (scaleLabelFormat === 'day') {
            label = date.getDate().toString();
        } else if (scaleLabelFormat === 'week') {
            const weekStart = new Date(date);
            weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1);
            label = weekStart.getDate() + '/' + (weekStart.getMonth() + 1);
        } else {
            label = monthNames[date.getMonth()] + ' ' + date.getFullYear();
        }

        const text = document.createElementNS(svgNS, "text");
        text.setAttribute("x", x);
        text.setAttribute("y", scaleY + 14);
        text.setAttribute("fill", textColor);
        text.setAttribute("text-anchor", "middle");
        text.setAttribute("font-size", "11px");
        text.setAttribute("font-weight", "500");
        text.textContent = label;
        scaleGroup.appendChild(text);
    }

    // ---- МАРКЕР «СЕГОДНЯ» (поверх сетки и полос) ----
    try {
        const today = typeof startOfToday === 'function' ? startOfToday() : startOfDay(new Date());
        if (chartOrigin && today && !isNaN(chartOrigin.getTime()) && !isNaN(today.getTime()) && safeTotalDays > 0) {
            const dayOffset = typeof diffCalendarDays === 'function'
                ? diffCalendarDays(chartOrigin, today)
                : 0;
            if (dayOffset >= 0 && dayOffset < safeTotalDays) {
                const tx = xForChartDayOffset(dayOffset);
                const y1 = adjustedTopMargin - 8;
                const y2 = adjustedTopMargin + safeChartHeight;
                const todayGroup = document.createElementNS(svgNS, 'g');
                todayGroup.setAttribute('pointer-events', 'none');

                const halo = document.createElementNS(svgNS, 'line');
                halo.setAttribute('x1', tx);
                halo.setAttribute('x2', tx);
                halo.setAttribute('y1', y1);
                halo.setAttribute('y2', y2);
                halo.setAttribute('stroke', bgColor);
                halo.setAttribute('stroke-width', '5');
                halo.setAttribute('opacity', '0.9');
                todayGroup.appendChild(halo);

                const todayLine = document.createElementNS(svgNS, 'line');
                todayLine.setAttribute('x1', tx);
                todayLine.setAttribute('x2', tx);
                todayLine.setAttribute('y1', y1);
                todayLine.setAttribute('y2', y2);
                todayLine.setAttribute('stroke', '#ef4444');
                todayLine.setAttribute('stroke-width', '2');
                todayLine.setAttribute('stroke-dasharray', '4 3');
                todayLine.setAttribute('opacity', '0.95');
                todayGroup.appendChild(todayLine);

                const todayLabel = document.createElementNS(svgNS, 'text');
                todayLabel.setAttribute('x', tx + 5);
                todayLabel.setAttribute('y', adjustedTopMargin - 10);
                todayLabel.setAttribute('fill', '#ef4444');
                todayLabel.setAttribute('font-size', '10px');
                todayLabel.setAttribute('font-weight', '700');
                todayLabel.setAttribute(
                    'font-family',
                    (typeof getUiFontFamily === 'function')
                        ? getUiFontFamily()
                        : 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
                );
                todayLabel.setAttribute('paint-order', 'stroke');
                todayLabel.setAttribute('stroke', bgColor);
                todayLabel.setAttribute('stroke-width', '3');
                todayLabel.textContent = 'Сегодня';
                todayGroup.appendChild(todayLabel);

                svg.appendChild(todayGroup);
            }
        }
    } catch (_) { /* ignore */ }

    return { svg, width: totalWidth, height: totalHeight };
}
