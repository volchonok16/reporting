// Классическая интеллект-карта (SimpleMind-стиль): плавные ветки, капсулы, цветные рукава

const CLASSIC_ROOT_FILL = '#2F5BA7';
const CLASSIC_ROOT_STROKE = '#1e40af';

function appendClassicPill(svgNS, parent, opts) {
    const { x, y, width, height, fill, stroke, strokeWidth, done, doneStyle } = opts;
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
        const f = typeof softMixFill === 'function' ? softMixFill(fill) : fill;
        const s = typeof softMixStroke === 'function' ? softMixStroke(stroke || fill) : stroke;
        rect.setAttribute('fill', f);
        rect.setAttribute('stroke', s);
        rect.setAttribute('stroke-width', String(Math.min(Number(strokeWidth) || 1.2, 0.9)));
        rect.setAttribute('fill-opacity', '0.98');
    } else {
        rect.setAttribute('fill', fill);
        rect.setAttribute('stroke', stroke);
        rect.setAttribute('stroke-width', String(strokeWidth || 2));
    }
    parent.appendChild(rect);
    return rect;
}

function classicNodeStyle(node) {
    const isDark = typeof document !== 'undefined' && document.body && document.body.classList.contains('dark');
    const soft = typeof isSoftDiagramStyle === 'function' && isSoftDiagramStyle();
    const done = !!node.done;
    const doneStyle = done ? getDoneNodeStyle(node.color) : null;

    if (node.level === 0) {
        return {
            fill: soft ? '#a78bfa' : CLASSIC_ROOT_FILL,
            stroke: soft ? '#8b5cf6' : CLASSIC_ROOT_STROKE,
            text: getContrastColor(soft ? '#a78bfa' : CLASSIC_ROOT_FILL),
            strokeWidth: soft ? 1.4 : 2.5,
            done,
            doneStyle
        };
    }
    if (node.level === 1) {
        if (doneStyle) {
            return { fill: doneStyle.fill, stroke: doneStyle.stroke, text: doneStyle.text, strokeWidth: doneStyle.strokeWidth, done, doneStyle };
        }
        return {
            fill: soft && typeof softMixFill === 'function' ? softMixFill(node.color) : node.color,
            stroke: soft
                ? (typeof softMixStroke === 'function' ? softMixStroke(node.color) : node.color)
                : (typeof mixHex === 'function' ? mixHex(node.color, '#000000', 0.14) : node.color),
            text: getContrastColor(soft && typeof softMixFill === 'function' ? softMixFill(node.color) : node.color),
            strokeWidth: soft ? 1.2 : 2.25,
            done,
            doneStyle: null
        };
    }
    const panel = typeof readCssColor === 'function'
        ? readCssColor('--panel-bg', isDark ? '#1e293b' : '#ffffff')
        : (isDark ? '#1e293b' : '#ffffff');
    if (doneStyle) {
        return { fill: doneStyle.fill, stroke: doneStyle.stroke, text: doneStyle.text, strokeWidth: doneStyle.strokeWidth, done, doneStyle };
    }
    return {
        fill: panel,
        stroke: node.color,
        text: isDark ? '#e2e8f0' : '#1e293b',
        strokeWidth: 2.5,
        done,
        doneStyle: null
    };
}

function edgeAnchor(node, towardX, towardY) {
    const noteEx = typeof diagramNodeNoteExtra === 'function' ? diagramNodeNoteExtra(node) : 0;
    const cx = node.x;
    const cy = typeof diagramNodeCenteredVisualCY === 'function'
        ? diagramNodeCenteredVisualCY(node)
        : (node.y - noteEx / 2);
    const dx = towardX - cx;
    const dy = towardY - cy;
    const dist = Math.hypot(dx, dy) || 1;
    const pad = 2;
    return {
        x: cx + (dx / dist) * (node.width / 2 - pad),
        y: cy + (dy / dist) * (node.height / 2 + (dy > 0 ? noteEx : 0) - pad)
    };
}

function classicCurvePath(x1, y1, x2, y2, side) {
    const bend = Math.max(48, Math.abs(x2 - x1) * 0.52);
    const sign = side === 'left' ? -1 : 1;
    const c1x = x1 + sign * bend;
    const c1y = y1;
    const c2x = x2 - sign * bend * 0.42;
    const c2y = y2;
    return `M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`;
}

function generateClassicSVG(root, options) {
    options = options && typeof options === 'object' ? options : {};
    computeSizes(root);
    root.width = Math.min(300, root.width + 28);
    root.height = root.height + 12;
    root.layoutHeight = root.height + (root.noteHeight || 0);

    computeWeights(root);
    const gaps = typeof getClassicLayoutGaps === 'function'
        ? getClassicLayoutGaps(options.spacingScale)
        : { gapX: 190, gapY: 28 };
    layoutClassic(root, gaps.gapX, gaps.gapY);
    resolveOverlapsClassic(root);
    if (typeof prepareTreeManualLayout === 'function') {
        prepareTreeManualLayout(root, typeof getLayoutOverrides === 'function' ? getLayoutOverrides() : null);
    }

    const bounds = getBounds(root, 90, { centered: true });
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `${bounds.minX} ${bounds.minY} ${width} ${height}`);
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Классическая интеллект-карта');
    svg.style.fontFamily = (typeof getUiFontFamily === 'function'
        ? getUiFontFamily()
        : 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif');
    svg.style.fontSize = '16px';

    const linesGroup = document.createElementNS(svgNS, 'g');
    const nodesGroup = document.createElementNS(svgNS, 'g');
    const notesGroup = document.createElementNS(svgNS, 'g');
    svg.appendChild(linesGroup);
    svg.appendChild(nodesGroup);
    svg.appendChild(notesGroup);

    function drawLines(node) {
        for (const child of node.children) {
            const side = child.side || (child.x >= node.x ? 'right' : 'left');
            const towardChildY = typeof diagramNodeCenteredVisualCY === 'function'
                ? diagramNodeCenteredVisualCY(child)
                : child.y;
            const towardParentY = typeof diagramNodeCenteredVisualCY === 'function'
                ? diagramNodeCenteredVisualCY(node)
                : node.y;
            const p1 = edgeAnchor(node, child.x, towardChildY);
            const p2 = edgeAnchor(child, node.x, towardParentY);
            const path = document.createElementNS(svgNS, 'path');
            path.setAttribute('d', classicCurvePath(p1.x, p1.y, p2.x, p2.y, side));
            path.setAttribute('fill', 'none');
            path.setAttribute('stroke', child.color);
            path.setAttribute('stroke-width', Math.max(3.5, 16 - child.level * 3.2).toFixed(1));
            path.setAttribute('stroke-linecap', 'round');
            path.setAttribute('opacity', '0.9');
            path.setAttribute('pointer-events', 'none');
            linesGroup.appendChild(path);

            if (child.level === 1) {
                const dot = document.createElementNS(svgNS, 'circle');
                dot.setAttribute('cx', String(p1.x));
                dot.setAttribute('cy', String(p1.y));
                dot.setAttribute('r', '4.5');
                dot.setAttribute('fill', child.color);
                dot.setAttribute('opacity', '0.95');
                dot.setAttribute('pointer-events', 'none');
                linesGroup.appendChild(dot);
            }

            drawLines(child);
        }
    }
    drawLines(root);

    function drawNodes(node) {
        const left = node.x - node.width / 2;
        const top = typeof diagramNodeCenteredBoxTop === 'function'
            ? diagramNodeCenteredBoxTop(node)
            : (node.y - node.height / 2);
        const cy = top + node.height / 2;
        const style = classicNodeStyle(node);
        const nodeId = node.id || node.text;

        const g = document.createElementNS(svgNS, 'g');
        g.setAttribute('class', 'mm-node');
        g.setAttribute('data-node-id', String(nodeId));
        nodesGroup.appendChild(g);

        const rect = appendClassicPill(svgNS, g, {
            x: left,
            y: top,
            width: node.width,
            height: node.height,
            fill: style.fill,
            stroke: style.stroke,
            strokeWidth: style.strokeWidth,
            done: style.done,
            doneStyle: style.doneStyle
        });
        if (node.href) rect.setAttribute('data-pdf-href', node.href);
        if (typeof setDiagramSourceLine === 'function') setDiagramSourceLine(rect, node.sourceLine);

        appendWrappedSvgText(svgNS, g, {
            x: node.x,
            y: cy + 1,
            lines: node.lines || [node.text],
            fill: style.text,
            fontSize: node.level === 0 ? 20 : (node.level === 1 ? 17 : 16),
            fontWeight: node.level === 0 ? '700' : (node.level === 1 ? '650' : '600'),
            lineHeight: node.level === 0 ? 25 : 21,
            underline: !!node.href,
            dataLabel: node.text,
            dataNodeId: nodeId,
            dataSourceLine: node.sourceLine || null,
            href: node.href || null
        });

        if (style.done) {
            const r = node.level === 0 ? 10 : 8;
            appendDoneCheckmark(svgNS, g, left + node.width - 2, top + 2, r);
        }
        if (typeof appendDiagramNodeMeta === 'function') {
            appendDiagramNodeMeta(svgNS, g, {
                x: left, y: top, width: node.width, height: node.height
            }, node, {
                avatarR: node.level === 0 ? 20 : 17,
                deadlineFontSize: 12,
                deadlineH: 20
            });
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
