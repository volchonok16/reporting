function generateBPMNSVG(layoutData, themeColors) {
    const { lanes, pools, elements, flows, width, height, taskWidth, taskHeight, eventRadius, gatewaySize, processName } = layoutData;
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    svg.style.fontFamily = (typeof getUiFontFamily === "function" ? getUiFontFamily() : "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif");
    svg.style.fontSize = "14px";

    const isDark = document.body.classList.contains('dark');
    const theme = themeColors || [];
    const primaryColor = theme.length > 0 ? theme[0] : (isDark ? '#60a5fa' : '#3b82f6');
    const textColor = isDark ? '#e0e0e0' : '#1f2937';
    const laneBaseFill = typeof readCssColor === 'function'
        ? readCssColor('--diagram-bg', isDark ? '#161618' : '#f8fafc')
        : (isDark ? '#161618' : '#f8fafc');
    const elementFill = typeof readCssColor === 'function'
        ? readCssColor('--panel-bg', isDark ? '#1c1c1e' : '#ffffff')
        : (isDark ? '#334155' : '#ffffff');
    // Обводка фигур и стрелки = цвет дорожки-источника
    let elementStroke = primaryColor;

    const laneColorByName = new Map();
    lanes.forEach(({ lane }, idx) => {
        const c = theme.length > 0 ? theme[idx % theme.length] : primaryColor;
        laneColorByName.set(lane.name, c);
    });
    function softLaneFill(hex) {
        if (typeof mixHex !== 'function') return laneBaseFill;
        return mixHex(hex, laneBaseFill, isDark ? 0.86 : 0.90);
    }
    function softLaneHeader(hex) {
        if (typeof mixHex !== 'function') return laneBaseFill;
        return mixHex(hex, laneBaseFill, isDark ? 0.72 : 0.78);
    }
    function colorForLane(name) {
        return (name && laneColorByName.get(name)) || primaryColor;
    }

    const bgGroup = document.createElementNS(svgNS, "g");
    const poolGroup = document.createElementNS(svgNS, "g");
    const laneGroup = document.createElementNS(svgNS, "g");
    const flowGroup = document.createElementNS(svgNS, "g");
    const elementGroup = document.createElementNS(svgNS, "g");
    const labelGroup = document.createElementNS(svgNS, "g");
    svg.appendChild(bgGroup);
    svg.appendChild(poolGroup);
    svg.appendChild(laneGroup);
    svg.appendChild(flowGroup);
    svg.appendChild(elementGroup);
    svg.appendChild(labelGroup);

    if (processName) {
        const titleEl = document.createElementNS(svgNS, "text");
        titleEl.setAttribute("x", width / 2);
        titleEl.setAttribute("y", 36);
        titleEl.setAttribute("fill", textColor);
        titleEl.setAttribute("text-anchor", "middle");
        titleEl.setAttribute("font-weight", "700");
        titleEl.setAttribute("font-size", "16px");
        titleEl.textContent = processName;
        labelGroup.appendChild(titleEl);
    }

    const defs = document.createElementNS(svgNS, "defs");
    const arrowMarkers = new Map();
    function arrowMarkerId(color) {
        const key = String(color || primaryColor);
        if (arrowMarkers.has(key)) return arrowMarkers.get(key);
        const id = 'bpmn-arrow-' + key.replace(/[^a-fA-F0-9]/g, '');
        const marker = document.createElementNS(svgNS, "marker");
        marker.setAttribute("id", id);
        marker.setAttribute("markerWidth", "10");
        marker.setAttribute("markerHeight", "10");
        marker.setAttribute("refX", "9");
        marker.setAttribute("refY", "3");
        marker.setAttribute("orient", "auto");
        const arrowPath = document.createElementNS(svgNS, "path");
        arrowPath.setAttribute("d", "M0,0 L0,6 L9,3 z");
        arrowPath.setAttribute("fill", key);
        marker.appendChild(arrowPath);
        defs.appendChild(marker);
        arrowMarkers.set(key, id);
        return id;
    }
    // заранее — по одной стрелке на дорожку
    laneColorByName.forEach((c) => arrowMarkerId(c));
    arrowMarkerId(primaryColor);
    svg.appendChild(defs);

    // Пулы
    (pools || []).forEach((pool) => {
        if (!pool || !pool.name) return;
        const rect = document.createElementNS(svgNS, "rect");
        rect.setAttribute("x", pool.x != null ? pool.x : 8);
        rect.setAttribute("y", pool.y);
        rect.setAttribute("width", width - 16);
        rect.setAttribute("height", pool.height);
        rect.setAttribute("fill", "none");
        rect.setAttribute("stroke", primaryColor);
        rect.setAttribute("stroke-width", "2");
        rect.setAttribute("stroke-opacity", "0.55");
        rect.setAttribute("rx", "10");
        poolGroup.appendChild(rect);

        const labelBg = document.createElementNS(svgNS, "rect");
        labelBg.setAttribute("x", (pool.x != null ? pool.x : 8) + 10);
        labelBg.setAttribute("y", pool.y + 4);
        labelBg.setAttribute("width", Math.min(220, pool.name.length * 8 + 24));
        labelBg.setAttribute("height", 22);
        labelBg.setAttribute("rx", "4");
        labelBg.setAttribute("fill", softLaneHeader(primaryColor));
        poolGroup.appendChild(labelBg);

        const text = document.createElementNS(svgNS, "text");
        text.setAttribute("x", (pool.x != null ? pool.x : 8) + 18);
        text.setAttribute("y", pool.y + 19);
        text.setAttribute("fill", textColor);
        text.setAttribute("font-weight", "700");
        text.setAttribute("font-size", "12px");
        text.textContent = pool.name;
        poolGroup.appendChild(text);
    });

    lanes.forEach(({ lane, y, height }) => {
        const laneColor = laneColorByName.get(lane.name) || primaryColor;
        const rect = document.createElementNS(svgNS, "rect");
        rect.setAttribute("x", 20);
        rect.setAttribute("y", y);
        rect.setAttribute("width", width - 40);
        rect.setAttribute("height", height);
        rect.setAttribute("fill", softLaneFill(laneColor));
        rect.setAttribute("stroke", laneColor);
        rect.setAttribute("stroke-width", "1.5");
        rect.setAttribute("stroke-opacity", "0.45");
        rect.setAttribute("rx", "8");
        laneGroup.appendChild(rect);

        // Шапка дорожки — чуть насыщеннее фона (согласовано с titleBand в layout)
        const headerH = Math.min(32, height);
        const header = document.createElementNS(svgNS, "rect");
        header.setAttribute("x", 20);
        header.setAttribute("y", y);
        header.setAttribute("width", width - 40);
        header.setAttribute("height", headerH);
        header.setAttribute("fill", softLaneHeader(laneColor));
        header.setAttribute("rx", "8");
        laneGroup.appendChild(header);
        // Срезать скругление снизу шапки
        const headerClip = document.createElementNS(svgNS, "rect");
        headerClip.setAttribute("x", 20);
        headerClip.setAttribute("y", y + headerH - 8);
        headerClip.setAttribute("width", width - 40);
        headerClip.setAttribute("height", 8);
        headerClip.setAttribute("fill", softLaneHeader(laneColor));
        laneGroup.appendChild(headerClip);

        const strip = document.createElementNS(svgNS, "rect");
        strip.setAttribute("x", 20);
        strip.setAttribute("y", y);
        strip.setAttribute("width", 8);
        strip.setAttribute("height", height);
        strip.setAttribute("fill", laneColor);
        strip.setAttribute("opacity", "0.85");
        strip.setAttribute("rx", "3");
        laneGroup.appendChild(strip);

        const text = document.createElementNS(svgNS, "text");
        text.setAttribute("x", 38);
        text.setAttribute("y", y + 19);
        text.setAttribute("fill", textColor);
        text.setAttribute("font-weight", "700");
        text.setAttribute("font-size", "13px");
        text.textContent = lane.name;
        laneGroup.appendChild(text);
    });

    flows.forEach(flow => {
        const flowColor = colorForLane(flow.fromLane);
        const path = document.createElementNS(svgNS, "polyline");
        let points;
        if (flow.route === 'above' && flow.arcY != null) {
            points = `${flow.fromX},${flow.fromY} ${flow.fromX},${flow.arcY} ${flow.toX},${flow.arcY} ${flow.toX},${flow.toY}`;
        } else if (flow.route === 'around' && flow.busX != null) {
            const yL = flow.yLeave != null ? flow.yLeave : (flow.fromY + flow.toY) / 2;
            const yE = flow.yEnter != null ? flow.yEnter : yL;
            points = `${flow.fromX},${flow.fromY} ${flow.fromX},${yL} ${flow.busX},${yL} ${flow.busX},${yE} ${flow.toX},${yE} ${flow.toX},${flow.toY}`;
        } else if (flow.route === 'ortho' && flow.midX != null) {
            points = `${flow.fromX},${flow.fromY} ${flow.midX},${flow.fromY} ${flow.midX},${flow.toY} ${flow.toX},${flow.toY}`;
        } else if (flow.route === 'cross' || flow.route === 'message') {
            const midY = flow.midY != null ? flow.midY : (flow.fromY + flow.toY) / 2;
            points = `${flow.fromX},${flow.fromY} ${flow.fromX},${midY} ${flow.toX},${midY} ${flow.toX},${flow.toY}`;
        } else {
            // forward и прочие — прямая (не ломать из‑за type===message)
            points = `${flow.fromX},${flow.fromY} ${flow.toX},${flow.toY}`;
        }
        path.setAttribute("points", points);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", flowColor);
        path.setAttribute("stroke-width", "2");
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");
        path.setAttribute("opacity", "0.92");
        if (flow.type === 'conditional') {
            path.setAttribute("stroke-dasharray", "6,4");
        } else if (flow.type === 'message') {
            path.setAttribute("stroke-dasharray", "2,2");
        } else if (flow.type === 'association') {
            path.setAttribute("stroke-dasharray", "1,3");
        }
        path.setAttribute("marker-end", `url(#${arrowMarkerId(flowColor)})`);
        if (typeof setDiagramSourceLine === 'function') {
            setDiagramSourceLine(path, flow.line || flow.sourceLine);
        }
        flowGroup.appendChild(path);

        // Маркер default (=>) — диагональ на ПЕРВОМ сегменте реальной ломаной
        // (раньше считали по прямой from→to и черта «висела» рядом со шлюзом)
        if (flow.type === 'default') {
            let segX1 = flow.fromX, segY1 = flow.fromY, segX2 = flow.toX, segY2 = flow.toY;
            if (flow.route === 'above' && flow.arcY != null) {
                segX2 = flow.fromX;
                segY2 = flow.arcY;
            } else if (flow.route === 'around' && flow.yLeave != null) {
                segX2 = flow.fromX;
                segY2 = flow.yLeave;
            } else if (flow.fromLane !== flow.toLane) {
                segX2 = flow.fromX;
                segY2 = flow.midY != null ? flow.midY : (flow.fromY + flow.toY) / 2;
            }
            const dx = segX2 - segX1;
            const dy = segY2 - segY1;
            const len = Math.hypot(dx, dy) || 1;
            const ux = dx / len;
            const uy = dy / len;
            const px = -uy;
            const py = ux;
            const along = Math.min(16, len * 0.35);
            const mx = segX1 + ux * along;
            const my = segY1 + uy * along;
            const slash = document.createElementNS(svgNS, "line");
            slash.setAttribute("x1", mx - px * 6);
            slash.setAttribute("y1", my - py * 6);
            slash.setAttribute("x2", mx + px * 6);
            slash.setAttribute("y2", my + py * 6);
            slash.setAttribute("stroke", flowColor);
            slash.setAttribute("stroke-width", "2.5");
            slash.setAttribute("stroke-linecap", "round");
            flowGroup.appendChild(slash);
        }
        if (flow.label) {
            const text = document.createElementNS(svgNS, "text");
            const lx = flow.labelX != null ? flow.labelX : (flow.fromX + flow.toX) / 2;
            const ly = flow.labelY != null ? flow.labelY : (flow.fromY + flow.toY) / 2 - 8;
            text.setAttribute("x", lx);
            text.setAttribute("y", ly);
            text.setAttribute("text-anchor", "middle");
            text.setAttribute("fill", textColor);
            text.setAttribute("font-size", "11px");
            text.setAttribute("font-weight", "600");
            // Без прямоугольной заливки — только лёгкий контур, чтобы читалось поверх линии
            text.setAttribute("paint-order", "stroke fill");
            text.setAttribute("stroke", typeof readCssColor === 'function'
                ? readCssColor('--diagram-bg', isDark ? '#161618' : '#ffffff')
                : (isDark ? '#161618' : '#ffffff'));
            text.setAttribute("stroke-width", "3.5");
            text.setAttribute("stroke-linejoin", "round");
            text.textContent = flow.label;
            if (typeof setDiagramSourceLine === 'function') {
                setDiagramSourceLine(text, flow.line || flow.sourceLine);
            }
            flowGroup.appendChild(text);
        }
    });

    function drawTaskIcon(x, y, taskType) {
        let iconChar = '';
        switch (taskType) {
            case 'сервисная': iconChar = '⚙️'; break;
            case 'ручная': iconChar = '✋'; break;
            case 'сценарий': iconChar = '📜'; break;
            case 'отправка сообщения': iconChar = '✉️'; break;
            case 'получение сообщения': iconChar = '📥'; break;
            case 'бизнес-правило': iconChar = '📊'; break;
            case 'таймер': iconChar = '⏱️'; break;
            case 'подпроцесс': iconChar = '📦'; break;
            default: return;
        }
        const icon = document.createElementNS(svgNS, "text");
        icon.setAttribute("x", x + 8);
        icon.setAttribute("y", y + 16);
        icon.setAttribute("fill", elementStroke);
        icon.setAttribute("font-size", "14px");
        icon.textContent = iconChar;
        elementGroup.appendChild(icon);
    }

    function drawAttachedNote(el) {
        if (!el.note) return;
        const padX = 12;
        const fontSize = 10;
        const lineH = 13;
        const maxW = Math.max(110, Math.min(168, (el.width || 130) + 24));
        const lines = (typeof wrapTextLines === 'function')
            ? wrapTextLines(el.note, maxW - padX, fontSize)
            : [el.note];
        const noteW = maxW;
        const noteH = 8 + lines.length * lineH;
        // Под фигурой — не смещаем задачу и не ломаем горизонтальные стрелки
        const nx = el.x + (el.width || 0) / 2 - noteW / 2;
        const ny = el.y + (el.height || 0) + 10;

        const link = document.createElementNS(svgNS, "line");
        link.setAttribute("x1", el.x + (el.width || 0) / 2);
        link.setAttribute("y1", el.y + (el.height || 0));
        link.setAttribute("x2", nx + noteW / 2);
        link.setAttribute("y2", ny);
        link.setAttribute("stroke", isDark ? '#a8a29e' : '#ca8a04');
        link.setAttribute("stroke-width", "1.1");
        link.setAttribute("stroke-dasharray", "3,4");
        elementGroup.appendChild(link);

        const rect = document.createElementNS(svgNS, "rect");
        rect.setAttribute("x", nx);
        rect.setAttribute("y", ny);
        rect.setAttribute("width", noteW);
        rect.setAttribute("height", noteH);
        rect.setAttribute("fill", isDark ? '#422006' : '#fef9c3');
        rect.setAttribute("stroke", isDark ? '#a8a29e' : '#ca8a04');
        rect.setAttribute("stroke-width", "1");
        rect.setAttribute("rx", "4");
        elementGroup.appendChild(rect);

        const text = document.createElementNS(svgNS, "text");
        text.setAttribute("x", nx + 6);
        text.setAttribute("y", ny + fontSize + 2);
        text.setAttribute("fill", isDark ? '#fef3c7' : '#1f2937');
        text.setAttribute("font-size", fontSize + "px");
        lines.forEach((line, idx) => {
            const tspan = document.createElementNS(svgNS, "tspan");
            tspan.setAttribute("x", nx + 6);
            tspan.setAttribute("dy", idx === 0 ? "0" : String(lineH));
            tspan.textContent = line;
            text.appendChild(tspan);
        });
        elementGroup.appendChild(text);
    }

    function drawEventSymbol(x, y, eventType, eventSubType) {
        const cx = x + eventRadius;
        const cy = y + eventRadius;
        if (eventSubType === 'таймер') {
            const clock = document.createElementNS(svgNS, "circle");
            clock.setAttribute("cx", cx);
            clock.setAttribute("cy", cy);
            clock.setAttribute("r", 8);
            clock.setAttribute("fill", "none");
            clock.setAttribute("stroke", elementStroke);
            clock.setAttribute("stroke-width", "1.5");
            elementGroup.appendChild(clock);
            const hand = document.createElementNS(svgNS, "line");
            hand.setAttribute("x1", cx);
            hand.setAttribute("y1", cy);
            hand.setAttribute("x2", cx);
            hand.setAttribute("y2", cy - 6);
            hand.setAttribute("stroke", elementStroke);
            hand.setAttribute("stroke-width", "1.5");
            elementGroup.appendChild(hand);
        } else if (eventSubType === 'сообщение') {
            const envelope = document.createElementNS(svgNS, "path");
            envelope.setAttribute("d", `M${cx-6},${cy-3} L${cx},${cy+1} L${cx+6},${cy-3} M${cx-6},${cy-3} L${cx-6},${cy+4} L${cx+6},${cy+4} L${cx+6},${cy-3}`);
            envelope.setAttribute("fill", "none");
            envelope.setAttribute("stroke", elementStroke);
            envelope.setAttribute("stroke-width", "1.5");
            elementGroup.appendChild(envelope);
        } else if (eventSubType === 'ошибка') {
            const lightning = document.createElementNS(svgNS, "text");
            lightning.setAttribute("x", cx - 5);
            lightning.setAttribute("y", cy + 6);
            lightning.setAttribute("fill", elementStroke);
            lightning.setAttribute("font-size", "16px");
            lightning.setAttribute("font-weight", "bold");
            lightning.textContent = '⚡';
            elementGroup.appendChild(lightning);
        } else if (eventSubType === 'эскалация') {
            const arrow = document.createElementNS(svgNS, "text");
            arrow.setAttribute("x", cx - 4);
            arrow.setAttribute("y", cy + 6);
            arrow.setAttribute("fill", elementStroke);
            arrow.setAttribute("font-size", "14px");
            arrow.textContent = '↑';
            elementGroup.appendChild(arrow);
        } else if (eventSubType === 'отмена') {
            const cross = document.createElementNS(svgNS, "text");
            cross.setAttribute("x", cx - 4);
            cross.setAttribute("y", cy + 6);
            cross.setAttribute("fill", elementStroke);
            cross.setAttribute("font-weight", "bold");
            cross.setAttribute("font-size", "14px");
            cross.textContent = '×';
            elementGroup.appendChild(cross);
        } else if (eventSubType === 'компенсация') {
            const rewind = document.createElementNS(svgNS, "text");
            rewind.setAttribute("x", cx - 6);
            rewind.setAttribute("y", cy + 6);
            rewind.setAttribute("fill", elementStroke);
            rewind.setAttribute("font-size", "14px");
            rewind.textContent = '⟲';
            elementGroup.appendChild(rewind);
        } else if (eventSubType === 'сигнал') {
            const triangle = document.createElementNS(svgNS, "polygon");
            triangle.setAttribute("points", `${cx},${cy-6} ${cx-5},${cy+4} ${cx+5},${cy+4}`);
            triangle.setAttribute("fill", "none");
            triangle.setAttribute("stroke", elementStroke);
            triangle.setAttribute("stroke-width", "1.5");
            elementGroup.appendChild(triangle);
        } else if (eventSubType === 'множественный') {
            const pentagon = document.createElementNS(svgNS, "polygon");
            const points = [];
            for (let i = 0; i < 5; i++) {
                const angle = (i * 72 - 90) * Math.PI / 180;
                points.push(`${cx + 6 * Math.cos(angle)},${cy + 6 * Math.sin(angle)}`);
            }
            pentagon.setAttribute("points", points.join(' '));
            pentagon.setAttribute("fill", "none");
            pentagon.setAttribute("stroke", elementStroke);
            pentagon.setAttribute("stroke-width", "1.5");
            elementGroup.appendChild(pentagon);
        }
    }

    elements.forEach(el => {
        const x = el.x;
        const y = el.y;
        const w = el.width;
        const h = el.height;
        elementStroke = (el.lane && laneColorByName.get(el.lane)) || primaryColor;

        if (el.type === 'task') {
            const rect = document.createElementNS(svgNS, "rect");
            rect.setAttribute("x", x);
            rect.setAttribute("y", y);
            rect.setAttribute("width", w);
            rect.setAttribute("height", h);
            rect.setAttribute("fill", elementFill);
            rect.setAttribute("stroke", elementStroke);
            rect.setAttribute("stroke-width", (el.isSubprocess || el.taskType === 'подпроцесс') ? "2.5" : "2");
            rect.setAttribute("rx", "6");
            if (typeof setDiagramSourceLine === 'function') {
                setDiagramSourceLine(rect, el.sourceLine || el.line);
            }
            elementGroup.appendChild(rect);

            if (el.isSubprocess || el.taskType === 'подпроцесс') {
                // толстая рамка + маркер [+]
                const inner = document.createElementNS(svgNS, "rect");
                inner.setAttribute("x", x + 4);
                inner.setAttribute("y", y + 4);
                inner.setAttribute("width", w - 8);
                inner.setAttribute("height", h - 8);
                inner.setAttribute("fill", "none");
                inner.setAttribute("stroke", elementStroke);
                inner.setAttribute("stroke-width", "1");
                inner.setAttribute("stroke-opacity", "0.45");
                inner.setAttribute("rx", "4");
                elementGroup.appendChild(inner);
                const plus = document.createElementNS(svgNS, "text");
                plus.setAttribute("x", x + w / 2);
                plus.setAttribute("y", y + h - 8);
                plus.setAttribute("fill", elementStroke);
                plus.setAttribute("text-anchor", "middle");
                plus.setAttribute("font-size", "14px");
                plus.setAttribute("font-weight", "700");
                plus.textContent = '+';
                elementGroup.appendChild(plus);
            }

            // Иконка только если тип != пользовательская и не подпроцесс (у него +)
            if (el.taskType && el.taskType !== 'пользовательская' && el.taskType !== 'подпроцесс' && !el.isSubprocess) {
                drawTaskIcon(x, y, el.taskType);
            }

            const hasMarker = el.marker === 'цикл' || el.marker === 'параллель' || el.isSubprocess || el.taskType === 'подпроцесс';
            const fontSize = el._nested ? 10 : 12;
            const lineH = el._nested ? 12 : 14;
            const maxTextW = Math.max(40, w - 16);
            let taskLines = (typeof wrapTextLines === 'function')
                ? wrapTextLines(el.name, maxTextW, fontSize)
                : [el.name];
            const maxLines = (el.isSubprocess || el.taskType === 'подпроцесс') ? 1 : (hasMarker ? 3 : 4);
            if (taskLines.length > maxLines) taskLines = taskLines.slice(0, maxLines);
            const blockH = taskLines.length * lineH;
            const textY = (el.isSubprocess || el.taskType === 'подпроцесс')
                ? y + 16
                : y + (h - (hasMarker ? 12 : 0) - blockH) / 2 + fontSize * 0.85;

            const text = document.createElementNS(svgNS, "text");
            text.setAttribute("x", x + w / 2);
            text.setAttribute("y", textY);
            text.setAttribute("fill", textColor);
            text.setAttribute("text-anchor", "middle");
            text.setAttribute("font-size", fontSize + "px");
            text.setAttribute("data-label", el.name || '');
            taskLines.forEach((line, idx) => {
                const tspan = document.createElementNS(svgNS, "tspan");
                tspan.setAttribute("x", x + w / 2);
                tspan.setAttribute("dy", idx === 0 ? "0" : String(lineH));
                tspan.textContent = line;
                text.appendChild(tspan);
            });
            elementGroup.appendChild(text);

            // Маркер цикла / параллельного экземпляра
            if (el.marker === 'цикл' || el.marker === 'параллель') {
                const mx = x + w / 2;
                const my = y + h - 10;
                if (el.marker === 'цикл') {
                    const loop = document.createElementNS(svgNS, "text");
                    loop.setAttribute("x", mx);
                    loop.setAttribute("y", my + 4);
                    loop.setAttribute("fill", elementStroke);
                    loop.setAttribute("text-anchor", "middle");
                    loop.setAttribute("font-size", "12px");
                    loop.textContent = '↺';
                    elementGroup.appendChild(loop);
                } else {
                    // три вертикальные черты — multi-instance
                    for (let i = -1; i <= 1; i++) {
                        const tick = document.createElementNS(svgNS, "line");
                        tick.setAttribute("x1", mx + i * 4);
                        tick.setAttribute("y1", my - 4);
                        tick.setAttribute("x2", mx + i * 4);
                        tick.setAttribute("y2", my + 4);
                        tick.setAttribute("stroke", elementStroke);
                        tick.setAttribute("stroke-width", "1.5");
                        elementGroup.appendChild(tick);
                    }
                }
            }

            if (el.note) drawAttachedNote(el);
        } else if (el.type === 'event') {
            const circle = document.createElementNS(svgNS, "circle");
            circle.setAttribute("cx", x + eventRadius);
            circle.setAttribute("cy", y + eventRadius);
            circle.setAttribute("r", eventRadius);
            circle.setAttribute("fill", elementFill);
            circle.setAttribute("stroke", elementStroke);
            circle.setAttribute("stroke-width", "2");
            if (typeof setDiagramSourceLine === 'function') {
                setDiagramSourceLine(circle, el.sourceLine || el.line);
            }
            elementGroup.appendChild(circle);

            if (el.boundary) {
                const outer = document.createElementNS(svgNS, "circle");
                outer.setAttribute("cx", x + eventRadius);
                outer.setAttribute("cy", y + eventRadius);
                outer.setAttribute("r", eventRadius + 3);
                outer.setAttribute("fill", "none");
                outer.setAttribute("stroke", elementStroke);
                outer.setAttribute("stroke-width", "1.5");
                outer.setAttribute("stroke-dasharray", "3,2");
                elementGroup.appendChild(outer);
            }

            if (el.eventType === 'начало') {
                drawEventSymbol(x, y, el.eventType, el.eventSubType);
            } else if (el.eventType === 'промежуточное' || el.boundary) {
                const inner = document.createElementNS(svgNS, "circle");
                inner.setAttribute("cx", x + eventRadius);
                inner.setAttribute("cy", y + eventRadius);
                inner.setAttribute("r", eventRadius / 2);
                inner.setAttribute("fill", "none");
                inner.setAttribute("stroke", elementStroke);
                inner.setAttribute("stroke-width", "1.5");
                elementGroup.appendChild(inner);
                drawEventSymbol(x, y, el.eventType, el.eventSubType);
            } else if (el.eventType === 'завершение') {
                const inner = document.createElementNS(svgNS, "circle");
                inner.setAttribute("cx", x + eventRadius);
                inner.setAttribute("cy", y + eventRadius);
                inner.setAttribute("r", eventRadius / 3);
                inner.setAttribute("fill", elementStroke);
                elementGroup.appendChild(inner);
                drawEventSymbol(x, y, el.eventType, el.eventSubType);
            }

            if (!el.boundary) {
                const text = document.createElementNS(svgNS, "text");
                text.setAttribute("x", x + eventRadius);
                text.setAttribute("y", y + h + 16);
                text.setAttribute("fill", textColor);
                text.setAttribute("text-anchor", "middle");
                text.setAttribute("font-size", "11px");
                text.textContent = el.name;
                text.setAttribute("data-label", el.name || '');
                elementGroup.appendChild(text);
            }
            if (el.note) drawAttachedNote(el);
        } else if (el.type === 'data' || el.type === 'datastore') {
            if (el.type === 'data') {
                // документ со «загнутым» углом
                const fold = 12;
                const d = `M${x},${y} L${x + w - fold},${y} L${x + w},${y + fold} L${x + w},${y + h} L${x},${y + h} Z`;
                const path = document.createElementNS(svgNS, "path");
                path.setAttribute("d", d);
                path.setAttribute("fill", elementFill);
                path.setAttribute("stroke", elementStroke);
                path.setAttribute("stroke-width", "2");
                if (typeof setDiagramSourceLine === 'function') {
                    setDiagramSourceLine(path, el.sourceLine || el.line);
                }
                elementGroup.appendChild(path);
                const foldLine = document.createElementNS(svgNS, "polyline");
                foldLine.setAttribute("points", `${x + w - fold},${y} ${x + w - fold},${y + fold} ${x + w},${y + fold}`);
                foldLine.setAttribute("fill", "none");
                foldLine.setAttribute("stroke", elementStroke);
                foldLine.setAttribute("stroke-width", "1.5");
                elementGroup.appendChild(foldLine);
            } else {
                // цилиндр — хранилище
                const ry = 10;
                const body = document.createElementNS(svgNS, "rect");
                body.setAttribute("x", x);
                body.setAttribute("y", y + ry);
                body.setAttribute("width", w);
                body.setAttribute("height", h - ry * 2);
                body.setAttribute("fill", elementFill);
                body.setAttribute("stroke", elementStroke);
                body.setAttribute("stroke-width", "2");
                if (typeof setDiagramSourceLine === 'function') {
                    setDiagramSourceLine(body, el.sourceLine || el.line);
                }
                elementGroup.appendChild(body);
                const top = document.createElementNS(svgNS, "ellipse");
                top.setAttribute("cx", x + w / 2);
                top.setAttribute("cy", y + ry);
                top.setAttribute("rx", w / 2);
                top.setAttribute("ry", ry);
                top.setAttribute("fill", elementFill);
                top.setAttribute("stroke", elementStroke);
                top.setAttribute("stroke-width", "2");
                elementGroup.appendChild(top);
                const bot = document.createElementNS(svgNS, "ellipse");
                bot.setAttribute("cx", x + w / 2);
                bot.setAttribute("cy", y + h - ry);
                bot.setAttribute("rx", w / 2);
                bot.setAttribute("ry", ry);
                bot.setAttribute("fill", elementFill);
                bot.setAttribute("stroke", elementStroke);
                bot.setAttribute("stroke-width", "2");
                elementGroup.appendChild(bot);
            }
            const text = document.createElementNS(svgNS, "text");
            text.setAttribute("x", x + w / 2);
            text.setAttribute("y", y + h + 14);
            text.setAttribute("fill", textColor);
            text.setAttribute("text-anchor", "middle");
            text.setAttribute("font-size", "11px");
            text.textContent = el.name;
            text.setAttribute("data-label", el.name || '');
            elementGroup.appendChild(text);
            if (el.note) drawAttachedNote(el);
        } else if (el.type === 'gateway') {
            const diamond = document.createElementNS(svgNS, "polygon");
            const cx = x + w / 2;
            const cy = y + h / 2;
            const points = `${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}`;
            diamond.setAttribute("points", points);
            diamond.setAttribute("fill", elementFill);
            diamond.setAttribute("stroke", elementStroke);
            diamond.setAttribute("stroke-width", "2");
            if (typeof setDiagramSourceLine === 'function') {
                setDiagramSourceLine(diamond, el.sourceLine || el.line);
            }
            elementGroup.appendChild(diamond);

            if (el.gatewayType === 'исключающий') {
                const xMark = document.createElementNS(svgNS, "text");
                xMark.setAttribute("x", cx);
                xMark.setAttribute("y", cy + 5);
                xMark.setAttribute("fill", elementStroke);
                xMark.setAttribute("text-anchor", "middle");
                xMark.setAttribute("font-weight", "bold");
                xMark.setAttribute("font-size", "16px");
                xMark.textContent = '×';
                elementGroup.appendChild(xMark);
            } else if (el.gatewayType === 'параллельный') {
                const plus = document.createElementNS(svgNS, "text");
                plus.setAttribute("x", cx);
                plus.setAttribute("y", cy + 5);
                plus.setAttribute("fill", elementStroke);
                plus.setAttribute("text-anchor", "middle");
                plus.setAttribute("font-weight", "bold");
                plus.setAttribute("font-size", "16px");
                plus.textContent = '+';
                elementGroup.appendChild(plus);
            } else if (el.gatewayType === 'включающий') {
                const circle = document.createElementNS(svgNS, "circle");
                circle.setAttribute("cx", cx);
                circle.setAttribute("cy", cy);
                circle.setAttribute("r", 7);
                circle.setAttribute("fill", "none");
                circle.setAttribute("stroke", elementStroke);
                circle.setAttribute("stroke-width", "1.5");
                elementGroup.appendChild(circle);
            } else if (el.gatewayType === 'комплексный') {
                const star = document.createElementNS(svgNS, "text");
                star.setAttribute("x", cx - 6);
                star.setAttribute("y", cy + 6);
                star.setAttribute("fill", elementStroke);
                star.setAttribute("font-weight", "bold");
                star.setAttribute("font-size", "14px");
                star.textContent = '⍟';
                elementGroup.appendChild(star);
            }

            const text = document.createElementNS(svgNS, "text");
            // Подпись НАД ромбом — не перекрывает выход вниз и вправо
            text.setAttribute("x", cx);
            text.setAttribute("fill", textColor);
            text.setAttribute("text-anchor", "middle");
            text.setAttribute("font-size", "11px");
            const gwLines = (typeof wrapTextLines === 'function')
                ? wrapTextLines(el.name, Math.max(90, w + 48), 11)
                : [el.name];
            const lines = gwLines.slice(0, 2);
            text.setAttribute("y", y - 6 - Math.max(0, lines.length - 1) * 12);
            text.setAttribute("data-label", el.name || '');
            lines.forEach((line, idx) => {
                const tspan = document.createElementNS(svgNS, "tspan");
                tspan.setAttribute("x", cx);
                tspan.setAttribute("dy", idx === 0 ? "0" : "12");
                tspan.textContent = line;
                text.appendChild(tspan);
            });
            elementGroup.appendChild(text);
            if (el.note) drawAttachedNote(el);
        } else if (el.type === 'annotation') {
            const rect = document.createElementNS(svgNS, "rect");
            rect.setAttribute("x", x);
            rect.setAttribute("y", y);
            rect.setAttribute("width", w);
            rect.setAttribute("height", h);
            rect.setAttribute("fill", isDark ? '#422006' : '#fef9c3');
            rect.setAttribute("stroke", isDark ? '#a8a29e' : '#eab308');
            rect.setAttribute("stroke-width", "1");
            rect.setAttribute("rx", "4");
            if (typeof setDiagramSourceLine === 'function') {
                setDiagramSourceLine(rect, el.sourceLine || el.line);
            }
            elementGroup.appendChild(rect);

            const fontSize = 11;
            const lineHeightPx = fontSize * 1.3;
            const lines = el._wrapLines || wrapTextLines(el.name, w - 16, fontSize);
            const blockH = lines.length * lineHeightPx;
            const textX = x + 8;
            const textY = y + (h - blockH) / 2 + fontSize;

            const text = document.createElementNS(svgNS, "text");
            text.setAttribute("x", textX);
            text.setAttribute("y", textY);
            text.setAttribute("fill", isDark ? '#fef3c7' : '#1f2937');
            text.setAttribute("font-size", fontSize + "px");
            lines.forEach((line, idx) => {
                const tspan = document.createElementNS(svgNS, "tspan");
                tspan.setAttribute("x", textX);
                tspan.setAttribute("dy", idx === 0 ? "0" : String(lineHeightPx));
                tspan.textContent = line;
                text.appendChild(tspan);
            });
            elementGroup.appendChild(text);
        }
    });

    return { svg, width, height, svgString: new XMLSerializer().serializeToString(svg) };
}