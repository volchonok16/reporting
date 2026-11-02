/**
 * Генерация SVG для диаграммы последовательностей (адаптивные цвета групп, плашки, привязка комментариев).
 */
function generateSequenceSVG(layoutData, themeColors) {
    const { participants, items, width, height, activationHeight, title } = layoutData;
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    svg.style.fontFamily = (typeof getUiFontFamily === "function" ? getUiFontFamily() : "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif");
    svg.style.fontSize = "14px";

    const isDark = document.body.classList.contains('dark');
    const primaryTextColor = isDark ? '#e0e0e0' : '#1f2937';
    const secondaryTextColor = isDark ? '#aaa' : '#6b7280';
    const dividerColor = isDark ? '#4b5563' : '#cbd5e1';
    const lifelineColor = isDark ? '#4b5563' : '#cbd5e1';
    const participantTextColor = isDark ? '#f3f4f6' : '#111827';
    const noteLinkColor = isDark ? '#a8a29e' : '#a8a29e';
    const noteFill = isDark ? '#422006' : '#fef9c3';
    const noteStroke = isDark ? '#a8a29e' : '#eab308';
    const noteText = isDark ? '#fef3c7' : '#1f2937';
    const panelFill = typeof readCssColor === 'function'
        ? readCssColor('--panel-bg', isDark ? '#1c1c1e' : '#ffffff')
        : (isDark ? '#1c1c1e' : '#ffffff');
    const diagramBg = typeof readCssColor === 'function'
        ? readCssColor('--diagram-bg', isDark ? '#161618' : '#f8fafc')
        : (isDark ? '#161618' : '#f8fafc');

    const groupStyleKeys = {
        'начало ветки': 'ветка',
        'начало цикла': 'цикл',
        'начало параллельных действий': 'параллельные действия',
        'начало опционально': 'опционально'
    };

    // Рамки групп: спокойнее палитра + мягкий пунктир (длиннее пробел, тоньше штрих)
    const groupColors = {
        ветка: {
            stroke: isDark ? '#94a3b8' : '#94a3b8',
            dasharray: '5,7',
            strokeWidth: '1.5',
            badgeFill: isDark ? '#334155' : '#f1f5f9',
            badgeText: isDark ? '#e2e8f0' : '#334155'
        },
        цикл: {
            stroke: isDark ? '#7dd3fc' : '#38bdf8',
            dasharray: 'none',
            strokeWidth: '1.75',
            badgeFill: isDark ? '#0c4a6e' : '#e0f2fe',
            badgeText: isDark ? '#bae6fd' : '#075985'
        },
        'параллельные действия': {
            stroke: isDark ? '#fbbf24' : '#d97706',
            dasharray: '6,6',
            strokeWidth: '1.5',
            badgeFill: isDark ? '#78350f' : '#fffbeb',
            badgeText: isDark ? '#fde68a' : '#92400e'
        },
        опционально: {
            stroke: isDark ? '#6ee7b7' : '#34d399',
            dasharray: '4,6',
            strokeWidth: '1.5',
            badgeFill: isDark ? '#064e3b' : '#ecfdf5',
            badgeText: isDark ? '#a7f3d0' : '#065f46'
        }
    };

    const defs = document.createElementNS(svgNS, "defs");
    participants.forEach(p => {
        const marker = document.createElementNS(svgNS, "marker");
        marker.setAttribute("id", `arrow-${p.name.replace(/\s/g, '')}`);
        marker.setAttribute("markerWidth", "10");
        marker.setAttribute("markerHeight", "10");
        marker.setAttribute("refX", "9");
        marker.setAttribute("refY", "3");
        marker.setAttribute("orient", "auto");
        const arrowPath = document.createElementNS(svgNS, "path");
        arrowPath.setAttribute("d", "M0,0 L0,6 L9,3 z");
        arrowPath.setAttribute("fill", p.color);
        marker.appendChild(arrowPath);
        defs.appendChild(marker);
    });
    svg.appendChild(defs);

    const linesGroup = document.createElementNS(svgNS, "g");
    const bgGroup = document.createElementNS(svgNS, "g");
    const activationsGroup = document.createElementNS(svgNS, "g");
    const messagesGroup = document.createElementNS(svgNS, "g");
    const notesGroup = document.createElementNS(svgNS, "g");
    const labelsGroup = document.createElementNS(svgNS, "g");
    svg.appendChild(linesGroup);
    svg.appendChild(bgGroup);
    svg.appendChild(activationsGroup);
    svg.appendChild(messagesGroup);
    svg.appendChild(notesGroup);
    svg.appendChild(labelsGroup);

    if (title) {
        const titleEl = document.createElementNS(svgNS, "text");
        titleEl.setAttribute("x", width / 2);
        titleEl.setAttribute("y", 28);
        titleEl.setAttribute("fill", primaryTextColor);
        titleEl.setAttribute("text-anchor", "middle");
        titleEl.setAttribute("font-weight", "700");
        titleEl.setAttribute("font-size", "16px");
        titleEl.textContent = title;
        labelsGroup.appendChild(titleEl);
    }

    participants.forEach(p => {
        const label = p.alias || p.name;
        const boxH = 30;
        const boxW = Math.max(72, Math.min(168, String(label).length * 7.4 + 28));
        const boxX = p.x - boxW / 2;
        const boxY = p.y - boxH;
        const srcLine = p.sourceLine || p.line;

        const g = document.createElementNS(svgNS, "g");
        if (typeof setDiagramSourceLine === 'function') setDiagramSourceLine(g, srcLine);

        const head = document.createElementNS(svgNS, "rect");
        head.setAttribute("x", boxX);
        head.setAttribute("y", boxY);
        head.setAttribute("width", boxW);
        head.setAttribute("height", boxH);
        head.setAttribute("rx", "7");
        head.setAttribute("fill", panelFill);
        head.setAttribute("stroke", p.color || lifelineColor);
        head.setAttribute("stroke-width", "1.75");
        g.appendChild(head);

        const line = document.createElementNS(svgNS, "line");
        line.setAttribute("x1", p.x);
        line.setAttribute("y1", p.y);
        line.setAttribute("x2", p.x);
        line.setAttribute("y2", height - 40);
        // Lifeline нейтральный — цвет участника только на стрелках/активациях
        line.setAttribute("stroke", lifelineColor);
        line.setAttribute("stroke-width", "1.25");
        line.setAttribute("stroke-dasharray", "4,5");
        line.setAttribute("pointer-events", "none");
        linesGroup.appendChild(line);

        const text = document.createElementNS(svgNS, "text");
        text.setAttribute("x", p.x);
        text.setAttribute("y", boxY + boxH / 2 + 1);
        text.setAttribute("fill", participantTextColor);
        text.setAttribute("text-anchor", "middle");
        text.setAttribute("dominant-baseline", "central");
        text.setAttribute("font-weight", "600");
        text.setAttribute("font-size", "13px");
        text.textContent = label;
        text.setAttribute('data-label', label);
        g.appendChild(text);
        labelsGroup.appendChild(g);
    });

    function tagMessageHit(el, item, x1, y1, x2, y2) {
        const src = item.line || item.sourceLine;
        if (typeof setDiagramSourceLine === 'function') setDiagramSourceLine(el, src);
        messagesGroup.appendChild(el);
        // Невидимый хит-бокс вокруг стрелки/подписи — ПКМ по тексту, не только по штриху
        const pad = 14;
        const minX = Math.min(x1, x2) - pad;
        const maxX = Math.max(x1, x2) + pad;
        const minY = Math.min(y1, y2) - pad;
        const maxY = Math.max(y1, y2) + pad;
        const hit = document.createElementNS(svgNS, "rect");
        hit.setAttribute("x", minX);
        hit.setAttribute("y", minY);
        hit.setAttribute("width", Math.max(24, maxX - minX));
        hit.setAttribute("height", Math.max(24, maxY - minY));
        hit.setAttribute("fill", "transparent");
        hit.setAttribute("stroke", "none");
        if (typeof setDiagramSourceLine === 'function') setDiagramSourceLine(hit, src);
        messagesGroup.appendChild(hit);
    }

    function renderItems(itemList) {
        for (const [index, item] of itemList.entries()) {
            if (item.type === 'message') {
                const fromP = participants.find(p => p.name === item.from);
                const toP = participants.find(p => p.name === item.to);
                if (!fromP || !toP) continue;
                // Координаты lifeline — у участника (не у устаревшего item.x1 после сдвига полей)
                const x1 = fromP.x;
                const x2 = toP.x;

                if (item.isSelf) {
                    const cx = x1;
                    const yStart = item.y - 4;
                    const yEnd = item.y + 12;
                    const dx = 90;

                    const activation = document.createElementNS(svgNS, "rect");
                    activation.setAttribute("x", cx - 4);
                    activation.setAttribute("y", yStart);
                    activation.setAttribute("width", 8);
                    activation.setAttribute("height", yEnd - yStart);
                    activation.setAttribute("fill", fromP.color);
                    activation.setAttribute("opacity", "0.35");
                    activationsGroup.appendChild(activation);

                    const path = document.createElementNS(svgNS, "path");
                    path.setAttribute("d", `M${cx},${yStart} C${cx+dx},${yStart-10} ${cx+dx},${yEnd+10} ${cx},${yEnd}`);
                    path.setAttribute("stroke", fromP.color);
                    path.setAttribute("stroke-width", "1.75");
                    path.setAttribute("fill", "none");
                    if (item.arrowType === '-->') path.setAttribute("stroke-dasharray", "5,6");
                    path.setAttribute("marker-end", `url(#arrow-${fromP.name.replace(/\s/g, '')})`);
                    tagMessageHit(path, item, cx, yStart, cx + dx, yEnd);

                    let displayText = item.text;
                    if (item.number) displayText = `${item.number}: ${displayText}`;
                    const text = document.createElementNS(svgNS, "text");
                    text.setAttribute("x", cx + dx/2);
                    text.setAttribute("y", yStart + (yEnd - yStart)/2 + 4);
                    text.setAttribute("fill", primaryTextColor);
                    text.setAttribute("text-anchor", "middle");
                    text.setAttribute("font-size", "12px");
                    text.setAttribute("paint-order", "stroke");
                    text.setAttribute("stroke", diagramBg);
                    text.setAttribute("stroke-width", "3.5");
                    text.textContent = displayText;
                    if (typeof setDiagramSourceLine === 'function') {
                        setDiagramSourceLine(text, item.line || item.sourceLine);
                    }
                    messagesGroup.appendChild(text);
                } else {
                    const activation = document.createElementNS(svgNS, "rect");
                    activation.setAttribute("x", x1 - 4);
                    activation.setAttribute("y", item.activationY);
                    activation.setAttribute("width", 8);
                    activation.setAttribute("height", item.height);
                    activation.setAttribute("fill", fromP.color);
                    activation.setAttribute("opacity", "0.35");
                    activationsGroup.appendChild(activation);

                    const line = document.createElementNS(svgNS, "line");
                    line.setAttribute("x1", x1);
                    line.setAttribute("y1", item.y);
                    line.setAttribute("x2", x2 + (x2 > x1 ? -10 : 10));
                    line.setAttribute("y2", item.y);
                    line.setAttribute("stroke", fromP.color);
                    line.setAttribute("stroke-width", "1.75");
                    line.setAttribute("stroke-linecap", "round");
                    if (item.arrowType === '-->') line.setAttribute("stroke-dasharray", "5,6");
                    line.setAttribute("marker-end", `url(#arrow-${fromP.name.replace(/\s/g, '')})`);
                    tagMessageHit(line, item, x1, item.y, x2, item.y);

                    let displayText = item.text;
                    if (item.number) displayText = `${item.number}: ${displayText}`;
                    const text = document.createElementNS(svgNS, "text");
                    const midX = (x1 + x2) / 2;
                    text.setAttribute("x", midX);
                    text.setAttribute("y", item.y - 6);
                    text.setAttribute("fill", primaryTextColor);
                    text.setAttribute("text-anchor", "middle");
                    text.setAttribute("font-size", "12px");
                    text.setAttribute("paint-order", "stroke");
                    text.setAttribute("stroke", diagramBg);
                    text.setAttribute("stroke-width", "3.5");
                    text.textContent = displayText;
                    if (typeof setDiagramSourceLine === 'function') {
                        setDiagramSourceLine(text, item.line || item.sourceLine);
                    }
                    messagesGroup.appendChild(text);
                }
            } else if (item.type === 'group_start') {
                if (item.x !== undefined && item.width !== undefined && item.boxH !== undefined) {
                    const rect = document.createElementNS(svgNS, "rect");
                    rect.setAttribute("x", item.x);
                    rect.setAttribute("y", item.boxY);
                    rect.setAttribute("width", item.width);
                    rect.setAttribute("height", item.boxH);
                    rect.setAttribute("fill", "transparent");
                    rect.setAttribute("rx", "10");
                    rect.setAttribute("pointer-events", "all");
                    if (typeof setDiagramSourceLine === 'function') {
                        setDiagramSourceLine(rect, item.line || item.sourceLine);
                    }

                    const mappedKey = groupStyleKeys[item.group] || item.group;
                    const style = groupColors[mappedKey];
                    if (style) {
                        rect.setAttribute("stroke", style.stroke);
                        rect.setAttribute("stroke-width", style.strokeWidth || "1.5");
                        if (style.dasharray && style.dasharray !== 'none') {
                            rect.setAttribute("stroke-dasharray", style.dasharray);
                        }

                        if (mappedKey === 'цикл') {
                            const innerRect = document.createElementNS(svgNS, "rect");
                            innerRect.setAttribute("x", item.x + 4);
                            innerRect.setAttribute("y", item.boxY + 4);
                            innerRect.setAttribute("width", item.width - 8);
                            innerRect.setAttribute("height", item.boxH - 8);
                            innerRect.setAttribute("fill", "none");
                            innerRect.setAttribute("stroke", style.stroke);
                            innerRect.setAttribute("stroke-width", "1");
                            innerRect.setAttribute("stroke-opacity", "0.45");
                            innerRect.setAttribute("rx", "8");
                            bgGroup.appendChild(innerRect);
                        }

                        const badgeX = item.x + 10;
                        const badgeY = item.boxY + 6;
                        const badgeHeight = 20;
                        let icon = '';
                        if (mappedKey === 'цикл') icon = '🔁 ';
                        else if (mappedKey === 'параллельные действия') icon = '⚡ ';
                        const groupShortNames = {
                            'начало ветки': 'выбор',
                            'начало цикла': 'цикл',
                            'начало параллельных действий': 'параллельно',
                            'начало опционально': 'если'
                        };
                        const shortName = groupShortNames[item.group] || mappedKey;
                        // С подписью из текста — только она; без подписи — короткое имя блока (не «Начало цикла»)
                        const labelText = icon + (item.label || shortName);
                        const textWidth = Math.max(labelText.length * 8 + 16, 48);

                        const badge = document.createElementNS(svgNS, "rect");
                        badge.setAttribute("x", badgeX);
                        badge.setAttribute("y", badgeY);
                        badge.setAttribute("width", textWidth);
                        badge.setAttribute("height", badgeHeight);
                        badge.setAttribute("rx", "4");
                        badge.setAttribute("fill", style.badgeFill);
                        badge.setAttribute("stroke", style.stroke);
                        badge.setAttribute("stroke-width", "1.5");
                        bgGroup.appendChild(badge);

                        const badgeLabel = document.createElementNS(svgNS, "text");
                        badgeLabel.setAttribute("x", badgeX + 8);
                        badgeLabel.setAttribute("y", badgeY + 14);
                        badgeLabel.setAttribute("fill", style.badgeText);
                        badgeLabel.setAttribute("font-size", "11px");
                        badgeLabel.setAttribute("font-weight", "bold");
                        badgeLabel.textContent = labelText;
                        bgGroup.appendChild(badgeLabel);
                    }

                    bgGroup.appendChild(rect);
                }
                if (item.items) renderItems(item.items);
            } else if (item.type === 'comment_start') {
                const boxRect = document.createElementNS(svgNS, "rect");
                boxRect.setAttribute("x", item.x);
                boxRect.setAttribute("y", item.boxY);
                boxRect.setAttribute("width", item.width);
                boxRect.setAttribute("height", item.boxH);
                boxRect.setAttribute("fill", noteFill);
                boxRect.setAttribute("stroke", noteStroke);
                boxRect.setAttribute("stroke-width", "1.5");
                boxRect.setAttribute("rx", "6");
                if (typeof setDiagramSourceLine === 'function') {
                    setDiagramSourceLine(boxRect, item.line || item.sourceLine);
                }
                notesGroup.appendChild(boxRect);

                const commentText = document.createElementNS(svgNS, "text");
                commentText.setAttribute("x", item.x + 8);
                commentText.setAttribute("y", item.boxY + 20);
                commentText.setAttribute("fill", noteText);
                commentText.setAttribute("font-size", "12px");
                if (typeof setDiagramSourceLine === 'function') {
                    setDiagramSourceLine(commentText, item.line || item.sourceLine);
                }
                const words = item.label.split(' ');
                let line = '';
                let tspans = [];
                words.forEach(word => {
                    if ((line + word).length > 20) {
                        tspans.push(line.trim());
                        line = word + ' ';
                    } else {
                        line += word + ' ';
                    }
                });
                if (line) tspans.push(line.trim());
                tspans.forEach((txt, idx) => {
                    const tspan = document.createElementNS(svgNS, "tspan");
                    tspan.setAttribute("x", item.x + 8);
                    if (idx > 0) tspan.setAttribute("dy", "1.2em");
                    tspan.textContent = txt;
                    commentText.appendChild(tspan);
                });
                notesGroup.appendChild(commentText);

                const targetPos = participants.find(p => p.name === item.target);
                if (targetPos) {
                    const connectX = targetPos.x;
                    const connectY = item.boxY + item.boxH / 2;
                    const lineToDiagram = document.createElementNS(svgNS, "line");
                    lineToDiagram.setAttribute("x1", item.side === 'left' ? item.x + item.width : item.x);
                    lineToDiagram.setAttribute("y1", connectY);
                    lineToDiagram.setAttribute("x2", connectX);
                    lineToDiagram.setAttribute("y2", connectY);
                    lineToDiagram.setAttribute("stroke", noteLinkColor);
                    lineToDiagram.setAttribute("stroke-width", "1.25");
                    lineToDiagram.setAttribute("stroke-dasharray", "4,6");
                    notesGroup.appendChild(lineToDiagram);
                }

                if (item.items) renderItems(item.items);
            } else if (item.type === 'divider') {
                const leftX = Math.min(...participants.map(p => p.x)) - 30;
                const rightX = Math.max(...participants.map(p => p.x)) + 30;
                const line = document.createElementNS(svgNS, "line");
                line.setAttribute("x1", leftX);
                line.setAttribute("y1", item.y);
                line.setAttribute("x2", rightX);
                line.setAttribute("y2", item.y);
                line.setAttribute("stroke", dividerColor);
                line.setAttribute("stroke-width", "1");
                line.setAttribute("stroke-dasharray", "3,7");
                bgGroup.appendChild(line);

                const label = document.createElementNS(svgNS, "text");
                label.setAttribute("x", leftX + 10);
                label.setAttribute("y", item.y - 5);
                label.setAttribute("fill", secondaryTextColor);
                label.setAttribute("font-size", "12px");
                label.textContent = item.label;
                if (typeof setDiagramSourceLine === 'function') {
                    setDiagramSourceLine(line, item.line || item.sourceLine);
                    setDiagramSourceLine(label, item.line || item.sourceLine);
                }
                bgGroup.appendChild(label);
            } else if (item.type === 'deactivate' || item.type === 'activate' || item.type === 'create') {
                const targetName = item.target;
                const p = participants.find(pp =>
                    pp.name === targetName ||
                    pp.alias === targetName ||
                    (pp.alias && pp.alias.toLowerCase() === String(targetName).toLowerCase()) ||
                    pp.name.toLowerCase() === String(targetName).toLowerCase()
                );
                if (p) {
                    const src = item.line || item.sourceLine;
                    if (item.type === 'deactivate') {
                        const s = 7;
                        const cross1 = document.createElementNS(svgNS, "line");
                        cross1.setAttribute("x1", p.x - s);
                        cross1.setAttribute("y1", item.y - s);
                        cross1.setAttribute("x2", p.x + s);
                        cross1.setAttribute("y2", item.y + s);
                        cross1.setAttribute("stroke", p.color);
                        cross1.setAttribute("stroke-width", "2.5");
                        if (typeof setDiagramSourceLine === 'function') setDiagramSourceLine(cross1, src);
                        messagesGroup.appendChild(cross1);
                        const cross2 = document.createElementNS(svgNS, "line");
                        cross2.setAttribute("x1", p.x + s);
                        cross2.setAttribute("y1", item.y - s);
                        cross2.setAttribute("x2", p.x - s);
                        cross2.setAttribute("y2", item.y + s);
                        cross2.setAttribute("stroke", p.color);
                        cross2.setAttribute("stroke-width", "2.5");
                        if (typeof setDiagramSourceLine === 'function') setDiagramSourceLine(cross2, src);
                        messagesGroup.appendChild(cross2);
                        const hit = document.createElementNS(svgNS, "rect");
                        hit.setAttribute("x", p.x - 16);
                        hit.setAttribute("y", item.y - 16);
                        hit.setAttribute("width", 32);
                        hit.setAttribute("height", 32);
                        hit.setAttribute("fill", "transparent");
                        if (typeof setDiagramSourceLine === 'function') setDiagramSourceLine(hit, src);
                        messagesGroup.appendChild(hit);
                    } else if (item.type === 'activate') {
                        // Simmetrika: the bar runs down through the participant's next messages in this
                        // block (it was a stub at the command, above the message it belongs to).
                        let startY = item.y - 8;
                        let endY = item.y + 10;
                        let first = true;
                        for (const next of itemList.slice(index + 1)) {
                            if (next.type === 'deactivate' && (next.target === p.name || next.target === p.alias)) break;
                            if (next.type === 'message' && (next.from === p.name || next.to === p.name)) {
                                if (first) startY = next.y - 10;
                                first = false;
                                endY = next.y + 10;
                            }
                        }
                        const bar = document.createElementNS(svgNS, "rect");
                        bar.setAttribute("x", p.x - 5);
                        bar.setAttribute("y", startY);
                        bar.setAttribute("width", 10);
                        bar.setAttribute("height", endY - startY);
                        bar.setAttribute("fill", p.color);
                        bar.setAttribute("opacity", "0.75");
                        if (typeof setDiagramSourceLine === 'function') setDiagramSourceLine(bar, src);
                        activationsGroup.appendChild(bar);
                    } else if (item.type === 'create') {
                        // As wide as its text (a fixed 56 px let «создать» out of the frame).
                        const label = '«создать»';
                        const boxW = Math.max(56, Math.ceil((typeof wrapTextLines === 'function' && wrapTextLines._canvas
                            ? (() => { const c = wrapTextLines._canvas.getContext('2d'); c.font = '11px ' + (typeof getUiFontFamily === 'function' ? getUiFontFamily() : 'system-ui'); return c.measureText(label).width; })()
                            : label.length * 6.2) + 18));
                        const box = document.createElementNS(svgNS, "rect");
                        box.setAttribute("x", p.x - boxW / 2);
                        box.setAttribute("y", item.y - 12);
                        box.setAttribute("width", boxW);
                        box.setAttribute("height", 22);
                        box.setAttribute("rx", "4");
                        box.setAttribute("fill", isDark ? '#1c1c1e' : '#fff');
                        box.setAttribute("stroke", p.color);
                        box.setAttribute("stroke-width", "2");
                        if (typeof setDiagramSourceLine === 'function') setDiagramSourceLine(box, src);
                        messagesGroup.appendChild(box);
                        const t = document.createElementNS(svgNS, "text");
                        t.setAttribute("x", p.x);
                        t.setAttribute("y", item.y + 3);
                        t.setAttribute("text-anchor", "middle");
                        t.setAttribute("font-size", "11px");
                        t.setAttribute("fill", primaryTextColor);
                        t.textContent = label;
                        if (typeof setDiagramSourceLine === 'function') setDiagramSourceLine(t, src);
                        messagesGroup.appendChild(t);
                    }
                }
            }
        }
    }

    renderItems(items);
    return { svg, width, height, svgString: new XMLSerializer().serializeToString(svg) };
}