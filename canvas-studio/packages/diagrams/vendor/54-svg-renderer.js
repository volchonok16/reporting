/** Прямоугольник узла mindmap — плоская заливка, без градиента/тени */
function appendMindmapNodeRect(svgNS, parent, opts) {
    const { x, y, width, height, color, done, doneStyle } = opts;
    const soft = typeof isSoftDiagramStyle === 'function' && isSoftDiagramStyle();
    const rect = document.createElementNS(svgNS, 'rect');
    rect.setAttribute('x', x);
    rect.setAttribute('y', y);
    rect.setAttribute('width', width);
    rect.setAttribute('height', height);
    rect.setAttribute('rx', soft ? 18 : 8);
    if (done && doneStyle) {
        rect.setAttribute('fill', doneStyle.fill);
        rect.setAttribute('stroke', doneStyle.stroke);
        rect.setAttribute('stroke-width', doneStyle.strokeWidth);
    } else if (soft) {
        const fill = typeof softMixFill === 'function' ? softMixFill(color) : color;
        const stroke = typeof softMixStroke === 'function' ? softMixStroke(color) : color;
        rect.setAttribute('fill', fill);
        rect.setAttribute('stroke', stroke);
        rect.setAttribute('stroke-width', '0.85');
        rect.setAttribute('fill-opacity', '0.98');
    } else {
        rect.setAttribute('fill', color);
        rect.setAttribute(
            'stroke',
            typeof mixHex === 'function' ? mixHex(color, '#000000', 0.18) : color
        );
        rect.setAttribute('stroke-width', '1.75');
    }
    parent.appendChild(rect);
    return rect;
}

// Генерация SVG для радиальной диаграммы
function generateRadialSVG(root, options) {
    options = options && typeof options === 'object' ? options : {};
    computeSizes(root);
    computeWeights(root);
    const radius = typeof getRadialLayoutRadius === 'function'
        ? getRadialLayoutRadius(options.spacingScale)
        : 200;
    layoutRadial(root, 0, 2 * Math.PI, 0, radius);
    resolveOverlapsRadial(root);
    if (typeof prepareTreeManualLayout === 'function') {
        prepareTreeManualLayout(root, typeof getLayoutOverrides === 'function' ? getLayoutOverrides() : null);
    }
    const bounds = getBounds(root, 80, { centered: true });
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS,"svg");
    svg.setAttribute("viewBox", `${bounds.minX} ${bounds.minY} ${width} ${height}`);
    svg.setAttribute("width",width); svg.setAttribute("height",height);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Радиальная диаграмма");
    svg.style.fontFamily = (typeof getUiFontFamily === "function" ? getUiFontFamily() : "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif");
    svg.style.fontSize="16px";
    const linesGroup = document.createElementNS(svgNS,"g"); svg.appendChild(linesGroup);
    const nodesGroup = document.createElementNS(svgNS,"g"); svg.appendChild(nodesGroup);
    const notesGroup = document.createElementNS(svgNS,"g"); svg.appendChild(notesGroup);
    const EDGE_OFFSET = 1;

    function halfExtent(n, towardX, towardY) {
        const noteEx = typeof diagramNodeNoteExtra === 'function' ? diagramNodeNoteExtra(n) : 0;
        const cx = n.x;
        const cy = typeof diagramNodeCenteredVisualCY === 'function'
            ? diagramNodeCenteredVisualCY(n)
            : (n.y - noteEx / 2);
        const dx = towardX - cx;
        const dy = towardY - cy;
        const dist = Math.hypot(dx, dy) || 1;
        const halfW = n.width / 2 - EDGE_OFFSET;
        // вниз — до низа слота (под подписью), вверх/вбок — до края блока
        const halfH = n.height / 2 + (dy > 0 ? noteEx : 0) - EDGE_OFFSET;
        return {
            x: cx + (dx / dist) * halfW,
            y: cy + (dy / dist) * halfH
        };
    }

    function drawLines(node){
        for (const child of node.children){
            const towardChildY = typeof diagramNodeCenteredVisualCY === 'function'
                ? diagramNodeCenteredVisualCY(child)
                : child.y;
            const towardParentY = typeof diagramNodeCenteredVisualCY === 'function'
                ? diagramNodeCenteredVisualCY(node)
                : node.y;
            const p1 = halfExtent(node, child.x, towardChildY);
            const p2 = halfExtent(child, node.x, towardParentY);
            const line = document.createElementNS(svgNS,"line");
            line.setAttribute("x1", p1.x); line.setAttribute("y1", p1.y);
            line.setAttribute("x2", p2.x); line.setAttribute("y2", p2.y);
            line.setAttribute("stroke", child.color);
            const soft = typeof isSoftDiagramStyle === 'function' && isSoftDiagramStyle();
            const sw = soft
                ? Math.max(1.4, 8 - child.level * 1.6)
                : Math.max(3.5, 17 - child.level * 4.8);
            line.setAttribute("stroke-width", sw.toFixed(1));
            line.setAttribute("stroke-linecap", "round");
            // Simmetrika: 0.22 left the soft branches nearly invisible on a light canvas.
            line.setAttribute("opacity", soft ? "0.55" : "0.88");
            line.setAttribute("pointer-events", "none");
            if (soft) {
                const stroke = typeof softMixStroke === 'function' ? softMixStroke(child.color) : child.color;
                line.setAttribute("stroke", stroke);
            }
            linesGroup.appendChild(line);
            drawLines(child);
        }
    }
    drawLines(root);

    function drawNodes(node){
        const left = node.x - node.width / 2;
        const top = typeof diagramNodeCenteredBoxTop === 'function'
            ? diagramNodeCenteredBoxTop(node)
            : (node.y - node.height / 2);
        const cy = top + node.height / 2;
        const done = !!node.done;
        const doneStyle = done ? getDoneNodeStyle(node.color) : null;
        const nodeId = node.id || node.text;

        const g = document.createElementNS(svgNS, 'g');
        g.setAttribute('class', 'mm-node');
        g.setAttribute('data-node-id', String(nodeId));
        nodesGroup.appendChild(g);

        const rect = appendMindmapNodeRect(svgNS, g, {
            x: left, y: top, width: node.width, height: node.height,
            color: node.color, done, doneStyle
        });
        if (node.href) {
            rect.setAttribute('data-pdf-href', node.href);
        }
        if (typeof setDiagramSourceLine === 'function') setDiagramSourceLine(rect, node.sourceLine);

        // Against the fill as drawn (the soft style lightens it).
        const txtColor = done ? doneStyle.text : getContrastColor(rect.getAttribute('fill') || node.color);
        appendWrappedSvgText(svgNS, g, {
            x: node.x,
            y: cy + 1,
            lines: node.lines || [node.text],
            fill: txtColor,
            fontSize: node.level === 0 ? 19 : 17,
            fontWeight: node.level === 0 ? '700' : '600',
            lineHeight: node.level === 0 ? 24 : 21,
            underline: !!node.href,
            dataLabel: node.text,
            dataNodeId: nodeId,
            dataSourceLine: node.sourceLine || null,
            href: node.href || null
        });

        if (done) {
            const r = node.level === 0 ? 10 : 8;
            appendDoneCheckmark(svgNS, g, left + node.width - 2, top + 2, r);
        }
        if (typeof appendDiagramNodeMeta === 'function') {
            appendDiagramNodeMeta(svgNS, g, {
                x: left, y: top, width: node.width, height: node.height
            }, node, { avatarR: node.level === 0 ? 20 : 17, deadlineFontSize: 12, deadlineH: 20 });
        }
        if (typeof appendDiagramNodeNote === 'function' && node.note) {
            const noteTop = typeof diagramNodeNoteTopY === 'function'
                ? diagramNodeNoteTopY(top + node.height, node)
                : (top + node.height + 8);
            appendDiagramNodeNote(svgNS, g, node.x, noteTop, node);
        }

        for (const child of node.children) drawNodes(child);
    }
    drawNodes(root);
    return { svg, width, height, svgString: new XMLSerializer().serializeToString(svg) };
}

// Генерация SVG для иерархической диаграммы
// Генерация SVG для иерархической диаграммы (lr | tb)
function generateHorizontalSVG(root, direction = 'lr', options) {
    options = options && typeof options === 'object' ? options : {};
    const isVertical = direction === 'tb';
    computeSizes(root);
    const gaps = typeof getHorizontalLayoutGaps === 'function'
        ? getHorizontalLayoutGaps(options.spacingScale, direction)
        : null;
    if (isVertical) {
        if (gaps) {
            layoutVertical(root, gaps.originX, gaps.originY, gaps.phaseGapX, gaps.gapY, gaps.nestGapX);
        } else {
            layoutVertical(root, 60, 60, 44, 30, 18);
        }
        resolveOverlapsVertical(root);
    } else {
        if (gaps) {
            layoutHorizontal(root, gaps.originX, gaps.originY, gaps.gapX, gaps.gapY);
        } else {
            layoutHorizontal(root, 60, 60, 200, 40);
        }
        resolveOverlapsHorizontal(root);
    }
    if (typeof prepareTreeManualLayout === 'function') {
        prepareTreeManualLayout(root, typeof getLayoutOverrides === 'function' ? getLayoutOverrides() : null);
    }
    const bounds = getBounds(root);
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `${bounds.minX} ${bounds.minY} ${width} ${height}`);
    svg.setAttribute("width", width); svg.setAttribute("height", height);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Иерархическая диаграмма");
    svg.style.fontFamily = (typeof getUiFontFamily === "function" ? getUiFontFamily() : "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif");
    svg.style.fontSize = "16px";
    const linesGroup = document.createElementNS(svgNS, "g"); svg.appendChild(linesGroup);
    const nodesGroup = document.createElementNS(svgNS, "g"); svg.appendChild(nodesGroup);
    const notesGroup = document.createElementNS(svgNS, "g"); svg.appendChild(notesGroup);

    function nodeExitBottom(n) {
        return typeof diagramNodeBottomY === 'function'
            ? diagramNodeBottomY(n)
            : (n.y + (n.layoutHeight || n.height));
    }

    function addEdgeLine(x1, y1, x2, y2, color, strokeW) {
        const soft = typeof isSoftDiagramStyle === 'function' && isSoftDiagramStyle();
        const el = document.createElementNS(svgNS, "line");
        el.setAttribute("x1", x1); el.setAttribute("y1", y1);
        el.setAttribute("x2", x2); el.setAttribute("y2", y2);
        el.setAttribute("stroke", soft && typeof softMixStroke === 'function' ? softMixStroke(color) : color);
        el.setAttribute("stroke-width", soft ? Math.max(1.2, Number(strokeW) * 0.45).toFixed(1) : strokeW);
        el.setAttribute("stroke-linecap", "round");
        el.setAttribute("opacity", soft ? "0.42" : "0.88");
        el.setAttribute("pointer-events", "none");
        linesGroup.appendChild(el);
    }

    /**
     * Ортогональные рёбра: ствол/шина один раз цветом родителя,
     * рукава к детям — цветом ветки. Раньше каждый ребёнок рисовал
     * весь ствол своим цветом и последний затирал линии от корня.
     */
    function drawLines(node) {
        const kids = node.children;
        if (!kids.length) return;

        const strokeW = Math.max(2.75, 14.5 - kids[0].level * 3.8).toFixed(1);
        const busColor = node.color || kids[0].color;

        if (isVertical) {
            const parentCx = node.x + node.width / 2;
            // Ствол снизу зоны подписи, чтобы линии не шли поверх //
            const y1 = nodeExitBottom(node);
            const ySpread = Math.max(...kids.map((c) => c.y)) - Math.min(...kids.map((c) => c.y));
            const xSpread = Math.max(...kids.map((c) => c.x)) - Math.min(...kids.map((c) => c.x));
            const stacked = ySpread >= xSpread; // столбик внутри фазы; у корня фазы в ряд

            if (stacked) {
                // Вертикальная шина слева, рукава к детям
                const busX = Math.min(parentCx, ...kids.map((c) => c.x)) - 18;
                const firstMid = kids[0].y + kids[0].height / 2;
                const lastMid = kids[kids.length - 1].y + kids[kids.length - 1].height / 2;
                addEdgeLine(parentCx, y1, busX, y1 + 8, busColor, strokeW);
                addEdgeLine(busX, y1 + 8, busX, lastMid, busColor, strokeW);
                for (const child of kids) {
                    const cy = child.y + child.height / 2;
                    addEdgeLine(busX, cy, child.x, cy, child.color || busColor, strokeW);
                    drawLines(child);
                }
                // если первый ребёнок выше стыка — дотянуть шину вверх
                if (firstMid < y1 + 8) {
                    addEdgeLine(busX, firstMid, busX, y1 + 8, busColor, strokeW);
                }
            } else {
                // Фазы под корнем — горизонтальная шина
                const childXs = kids.map((c) => c.x + c.width / 2);
                const busY = (y1 + Math.min(...kids.map((c) => c.y))) / 2;
                addEdgeLine(parentCx, y1, parentCx, busY, busColor, strokeW);
                if (kids.length > 1) {
                    addEdgeLine(Math.min(...childXs), busY, Math.max(...childXs), busY, busColor, strokeW);
                } else if (Math.abs(childXs[0] - parentCx) > 0.5) {
                    addEdgeLine(parentCx, busY, childXs[0], busY, busColor, strokeW);
                }
                for (const child of kids) {
                    const x2 = child.x + child.width / 2;
                    addEdgeLine(x2, busY, x2, child.y, child.color || busColor, strokeW);
                    drawLines(child);
                }
            }
        } else {
            const x1 = node.x + node.width;
            const y1 = node.y + node.height / 2;
            const childYs = kids.map((c) => c.y + c.height / 2);
            const busX = (x1 + Math.min(...kids.map((c) => c.x))) / 2;

            addEdgeLine(x1, y1, busX, y1, busColor, strokeW);
            if (kids.length > 1) {
                addEdgeLine(busX, Math.min(...childYs), busX, Math.max(...childYs), busColor, strokeW);
            } else if (Math.abs(childYs[0] - y1) > 0.5) {
                addEdgeLine(busX, y1, busX, childYs[0], busColor, strokeW);
            }

            for (const child of kids) {
                const y2 = child.y + child.height / 2;
                addEdgeLine(busX, y2, child.x, y2, child.color || busColor, strokeW);
                drawLines(child);
            }
        }
    }
    drawLines(root);

    function drawNodes(node) {
        const done = !!node.done;
        const doneStyle = done ? getDoneNodeStyle(node.color) : null;
        const nodeId = node.id || node.text;

        const g = document.createElementNS(svgNS, 'g');
        g.setAttribute('class', 'mm-node');
        g.setAttribute('data-node-id', String(nodeId));
        nodesGroup.appendChild(g);

        const rect = appendMindmapNodeRect(svgNS, g, {
            x: node.x, y: node.y, width: node.width, height: node.height,
            color: node.color, done, doneStyle
        });
        if (node.href) {
            rect.setAttribute('data-pdf-href', node.href);
        }
        if (typeof setDiagramSourceLine === 'function') setDiagramSourceLine(rect, node.sourceLine);

        // Against the fill as drawn (the soft style lightens it).
        const txtColor = done ? doneStyle.text : getContrastColor(rect.getAttribute('fill') || node.color);
        appendWrappedSvgText(svgNS, g, {
            x: node.x + node.width / 2,
            y: node.y + node.height / 2 + 1,
            lines: node.lines || [node.text],
            fill: txtColor,
            fontSize: node.level === 0 ? 19 : 17,
            fontWeight: node.level === 0 ? '700' : '600',
            lineHeight: node.level === 0 ? 24 : 21,
            underline: !!node.href,
            dataLabel: node.text,
            dataNodeId: nodeId,
            dataSourceLine: node.sourceLine || null,
            href: node.href || null
        });

        if (done) {
            const r = node.level === 0 ? 10 : 8;
            appendDoneCheckmark(svgNS, g, node.x + node.width - 2, node.y + 2, r);
        }
        if (typeof appendDiagramNodeMeta === 'function') {
            appendDiagramNodeMeta(svgNS, g, {
                x: node.x, y: node.y, width: node.width, height: node.height
            }, node, { avatarR: node.level === 0 ? 20 : 17, deadlineFontSize: 12, deadlineH: 20 });
        }
        if (typeof appendDiagramNodeNote === 'function' && node.note) {
            const noteTop = typeof diagramNodeNoteTopY === 'function'
                ? diagramNodeNoteTopY(node.y + node.height, node)
                : (node.y + node.height + 8);
            appendDiagramNodeNote(
                svgNS, g,
                node.x + node.width / 2,
                noteTop,
                node
            );
        }

        for (const child of node.children) drawNodes(child);
    }
    drawNodes(root);
    return { svg, width, height, svgString: new XMLSerializer().serializeToString(svg) };
}