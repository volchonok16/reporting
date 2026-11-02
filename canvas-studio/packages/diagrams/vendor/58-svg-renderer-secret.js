/**
 * Рендерер Kanban-доски (assignee внизу справа, dueDate внизу слева,
 * контрастные даты и участники). Добавлено отображение описания с переносом длинных строк.
 */
function generateSecretSVG(layoutData, themeColors) {
    const {
        columns, tasks, width, height, title,
        tagHeight, tagHorizontalGap, footerHeight
    } = layoutData;

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Kanban-доска");
    svg.style.fontFamily = (typeof getUiFontFamily === "function" ? getUiFontFamily() : "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif");
    svg.style.fontSize = "14px";

    const isDark = document.body.classList.contains('dark');
    const theme = themeColors || [];
    const primaryColor = theme.length > 0 ? theme[0] : (isDark ? '#60a5fa' : '#3b82f6');
    const textColor = isDark ? '#e0e0e0' : '#1f2937';
    const secondaryColor = isDark ? '#cbd5e1' : '#374151';
    const descriptionColor = isDark ? '#94a3b8' : '#6b7280';
    const columnFill = typeof readCssColor === 'function'
        ? readCssColor('--diagram-bg', isDark ? '#161618' : '#f8fafc')
        : (isDark ? '#161618' : '#f8fafc');
    const columnStroke = typeof readCssColor === 'function'
        ? readCssColor('--border', isDark ? '#3a3a3c' : '#cbd5e1')
        : (isDark ? '#475569' : '#cbd5e1');
    const taskFill = typeof readCssColor === 'function'
        ? readCssColor('--panel-bg', isDark ? '#1c1c1e' : '#ffffff')
        : (isDark ? '#334155' : '#ffffff');
    const taskStroke = columnStroke;

    const bgGroup = document.createElementNS(svgNS, "g");
    const columnGroup = document.createElementNS(svgNS, "g");
    const taskGroup = document.createElementNS(svgNS, "g");
    svg.appendChild(bgGroup);
    svg.appendChild(columnGroup);
    svg.appendChild(taskGroup);

    const columnColors = {};
    columns.forEach((col, i) => {
        columnColors[col.name] = theme.length > 0 ? theme[i % theme.length] : primaryColor;
    });

    if (title) {
        const titleEl = document.createElementNS(svgNS, "text");
        titleEl.setAttribute("x", width / 2);
        titleEl.setAttribute("y", 36);
        titleEl.setAttribute("fill", textColor);
        titleEl.setAttribute("text-anchor", "middle");
        titleEl.setAttribute("font-weight", "700");
        titleEl.setAttribute("font-size", "16px");
        titleEl.textContent = title;
        svg.appendChild(titleEl);
    }

    // Колонки
    columns.forEach(col => {
        const colColor = columnColors[col.name];
        const rect = document.createElementNS(svgNS, "rect");
        rect.setAttribute("x", col.x);
        rect.setAttribute("y", col.y);
        rect.setAttribute("width", col.width);
        rect.setAttribute("height", col.height);
        rect.setAttribute("fill", columnFill);
        rect.setAttribute("stroke", columnStroke);
        rect.setAttribute("stroke-width", "2");
        rect.setAttribute("rx", "10");
        columnGroup.appendChild(rect);

        const header = document.createElementNS(svgNS, "rect");
        header.setAttribute("x", col.x);
        header.setAttribute("y", col.y);
        header.setAttribute("width", col.width);
        header.setAttribute("height", 36);
        header.setAttribute("fill", colColor);
        header.setAttribute("rx", "10");
        columnGroup.appendChild(header);

        const title = document.createElementNS(svgNS, "text");
        title.setAttribute("x", col.x + 12);
        title.setAttribute("y", col.y + 24);
        title.setAttribute("fill", getContrastColor(colColor));
        title.setAttribute("text-anchor", "start");
        title.setAttribute("font-weight", "bold");
        title.setAttribute("font-size", "14px");
        title.textContent = col.name;
        columnGroup.appendChild(title);

        if (col.wipLimit != null) {
            const wip = document.createElementNS(svgNS, "text");
            wip.setAttribute("x", col.x + col.width - 12);
            wip.setAttribute("y", col.y + 24);
            wip.setAttribute("fill", col.wipExceeded ? '#fecaca' : getContrastColor(colColor));
            wip.setAttribute("text-anchor", "end");
            wip.setAttribute("font-weight", "700");
            wip.setAttribute("font-size", "12px");
            wip.textContent = `${col.wipCount || 0}/${col.wipLimit}`;
            columnGroup.appendChild(wip);
            if (col.wipExceeded) {
                rect.setAttribute("stroke", "#ef4444");
                rect.setAttribute("stroke-width", "2.5");
                rect.setAttribute("fill", isDark ? '#3f1d1d' : '#fef2f2');
                // Полоска сверху колонки — лимит виден без чтения цифр
                const warn = document.createElementNS(svgNS, "rect");
                warn.setAttribute("x", col.x);
                warn.setAttribute("y", col.y + 36);
                warn.setAttribute("width", col.width);
                warn.setAttribute("height", 4);
                warn.setAttribute("fill", "#ef4444");
                columnGroup.appendChild(warn);
            }
        }
    });

    // Задачи
    tasks.forEach(task => {
        const rect = document.createElementNS(svgNS, "rect");
        rect.setAttribute("x", task.x);
        rect.setAttribute("y", task.y);
        rect.setAttribute("width", task.width);
        rect.setAttribute("height", task.height);
        rect.setAttribute("fill", taskFill);
        rect.setAttribute("stroke", taskStroke);
        rect.setAttribute("stroke-width", "1.5");
        rect.setAttribute("rx", "6");
        if (task.href) {
            rect.setAttribute("data-pdf-href", task.href);
        }
        if (typeof setDiagramSourceLine === 'function') {
            setDiagramSourceLine(rect, task.sourceLine || task._line || task.line);
        }
        taskGroup.appendChild(rect);

        // Название задачи — с переносом по ширине карточки
        const padding = task.taskPadding || 12;
        const titleFontSize = task.titleFontSize || 13;
        const titleLineHeight = task.titleLineHeight || 18;
        const titleLines = task.titleLines && task.titleLines.length
            ? task.titleLines
            : [task.name || ''];
        titleLines.forEach((line, i) => {
            const titleText = document.createElementNS(svgNS, "text");
            titleText.setAttribute("x", task.x + padding);
            titleText.setAttribute("y", task.y + 22 + i * titleLineHeight);
            titleText.setAttribute("fill", textColor);
            titleText.setAttribute("font-weight", "600");
            titleText.setAttribute("font-size", `${titleFontSize}px`);
            titleText.setAttribute("data-label", task.name || line);
            if (task.cardId) titleText.setAttribute("data-node-id", String(task.cardId));
            if (task.href) {
                titleText.setAttribute("data-pdf-href", task.href);
                titleText.setAttribute("text-decoration", "underline");
                titleText.style.textDecoration = "underline";
            }
            titleText.textContent = line;
            taskGroup.appendChild(titleText);
        });

        let infoY = task.y + 22 + titleLines.length * titleLineHeight + 10;

        // Приоритет (ширина согласована с layout → titleMaxWidth)
        if (task.priority !== 'обычная') {
            const priorityColors = {
                срочно: '#ef4444',
                важно: '#f59e0b',
                средне: '#14b8a6',
                'не срочно': '#94a3b8'
            };
            const prioLabel = task.priority;
            const badgeW = task.prioBadgeW
                || Math.max(50, String(prioLabel).length * 6.5 + 14);
            const badgeRightPad = 10;
            const badge = document.createElementNS(svgNS, "rect");
            badge.setAttribute("x", task.x + task.width - badgeW - badgeRightPad);
            badge.setAttribute("y", task.y + 10);
            badge.setAttribute("width", badgeW);
            badge.setAttribute("height", 18);
            badge.setAttribute("fill", priorityColors[task.priority] || '#6b7280');
            badge.setAttribute("rx", "4");
            taskGroup.appendChild(badge);

            const priorityText = document.createElementNS(svgNS, "text");
            priorityText.setAttribute("x", task.x + task.width - badgeW / 2 - badgeRightPad);
            priorityText.setAttribute("y", task.y + 23);
            priorityText.setAttribute("fill", "#ffffff");
            priorityText.setAttribute("text-anchor", "middle");
            priorityText.setAttribute("font-size", "10px");
            priorityText.setAttribute("font-weight", "bold");
            priorityText.textContent = task.priority;
            taskGroup.appendChild(priorityText);
        }

        // Теги
        const maxTagWidth = task.contentWidth || (task.width - 2 * padding);
        if (task.tags && task.tags.length > 0) {
            const tagStartX = task.x + padding;
            let tagX = tagStartX;
            let tagY = infoY;

            task.tags.forEach(tag => {
                const tagColor = tag.color || primaryColor;
                const tagWidth = tag.text.length * 7 + 16;

                if (tagX + tagWidth > tagStartX + maxTagWidth && tagX > tagStartX) {
                    tagX = tagStartX;
                    tagY += tagHeight;
                }

                const tagBadge = document.createElementNS(svgNS, "rect");
                tagBadge.setAttribute("x", tagX);
                tagBadge.setAttribute("y", tagY);
                tagBadge.setAttribute("width", tagWidth);
                tagBadge.setAttribute("height", 16);
                tagBadge.setAttribute("fill", tagColor);
                tagBadge.setAttribute("rx", "4");
                taskGroup.appendChild(tagBadge);

                const tagText = document.createElementNS(svgNS, "text");
                tagText.setAttribute("x", tagX + tagWidth / 2);
                tagText.setAttribute("y", tagY + 12);
                tagText.setAttribute("fill", getContrastColor(tagColor));
                tagText.setAttribute("text-anchor", "middle");
                tagText.setAttribute("font-size", "10px");
                tagText.textContent = tag.text;
                taskGroup.appendChild(tagText);

                tagX += tagWidth + tagHorizontalGap;
            });

            infoY = tagY + tagHeight + 4;
        }

        // Описание с переносом длинных строк и отступами
        if (task.descriptionLines && task.descriptionLines.length > 0) {
            // вычисляем максимальное число символов в строке исходя из доступной ширины и размера шрифта
            const fontSize = task.descriptionFontSize || 12;
            const availableWidth = task.contentWidth || (task.width - 2 * padding);
            // примерно 0.6 * fontSize на символ (для шрифта sans-serif)
            const maxChars = Math.floor(availableWidth / (fontSize * 0.6));
            const descY = infoY + 4;
            let lineIndex = 0;
            task.descriptionLines.forEach(line => {
                let remaining = line;
                while (remaining.length > 0) {
                    let chunk = remaining.substring(0, maxChars);
                    if (remaining.length > maxChars) {
                        const lastSpace = chunk.lastIndexOf(' ');
                        if (lastSpace > 0) {
                            chunk = chunk.substring(0, lastSpace);
                        }
                    }
                    const descText = document.createElementNS(svgNS, "text");
                    descText.setAttribute("x", task.x + padding);
                    descText.setAttribute("y", descY + lineIndex * task.descriptionLineHeight + 12);
                    descText.setAttribute("fill", descriptionColor);
                    descText.setAttribute("font-size", `${fontSize}px`);
                    descText.setAttribute("font-weight", "normal");
                    descText.textContent = chunk;
                    taskGroup.appendChild(descText);
                    lineIndex++;
                    remaining = remaining.substring(chunk.length).trim();
                }
            });
            infoY += lineIndex * task.descriptionLineHeight + 8;
        }

        // Нижняя полоса: dueDate слева, assignee справа (при просрочке — две строки, имя остаётся справа)
        const twoLine = !!(task._footerTwoLine || (task.assignee && task.dueDate && task.overdue));
        const footerY = task.y + task.height - (twoLine ? 10 : 14);
        if (task.dueDate) {
            const dateText = document.createElementNS(svgNS, "text");
            dateText.setAttribute("x", task.x + padding);
            dateText.setAttribute("y", twoLine ? (task.y + task.height - 24) : footerY);
            dateText.setAttribute("text-anchor", "start");
            dateText.setAttribute("fill", task.overdue ? '#ef4444' : secondaryColor);
            dateText.setAttribute("font-size", "11px");
            dateText.setAttribute("font-weight", task.overdue ? "700" : "500");
            const dueLabel = task.overdue ? ('⚠ ' + task.dueDate) : task.dueDate;
            dateText.textContent = dueLabel;
            taskGroup.appendChild(dateText);
        }
        if (task.assignee) {
            if (typeof appendAssigneeAvatar === 'function') {
                const initials = task.initials
                    || (typeof diagramAssigneeInitials === 'function'
                        ? diagramAssigneeInitials(task.assignee)
                        : String(task.assignee).slice(0, 2).toUpperCase());
                appendAssigneeAvatar(svgNS, taskGroup, task.x + task.width - padding - 2, footerY - 2, {
                    initials,
                    assignee: task.assignee,
                    r: 16,
                    title: '@' + task.assignee
                });
            } else {
                const assigneeText = document.createElementNS(svgNS, "text");
                assigneeText.setAttribute("x", task.x + task.width - padding);
                assigneeText.setAttribute("y", footerY);
                assigneeText.setAttribute("text-anchor", "end");
                assigneeText.setAttribute("fill", secondaryColor);
                assigneeText.setAttribute("font-size", "11px");
                assigneeText.setAttribute("font-weight", "500");
                const name = String(task.assignee || '');
                const maxName = twoLine ? 22 : 14;
                assigneeText.textContent = '👤 ' + (name.length > maxName ? name.slice(0, maxName - 1) + '…' : name);
                taskGroup.appendChild(assigneeText);
            }
        }
    });

    return { svg, width, height, svgString: new XMLSerializer().serializeToString(svg) };
}