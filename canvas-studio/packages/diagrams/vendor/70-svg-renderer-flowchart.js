/**
 * SVG блок-схемы (Mermaid / Lucidchart–style).
 * Цвет узла — по типу формы из палитры; мягкая заливка + тень, чтобы не «кричало».
 */
function generateFlowchartSVG(layoutData, themeColors) {
    const nodes = layoutData.nodes || [];
    const edges = layoutData.edges || [];
    const width = layoutData.width || 400;
    const height = layoutData.height || 300;
    const title = layoutData.title || 'Блок-схема';
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', title);
    svg.style.fontFamily = (typeof getUiFontFamily === 'function')
        ? getUiFontFamily()
        : 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif';

    const isDark = document.body.classList.contains('dark');
    const bg = typeof readCssColor === 'function'
        ? readCssColor('--diagram-bg', isDark ? '#161618' : '#f8fafc')
        : (isDark ? '#161618' : '#f8fafc');
    const ink = isDark ? '#e2e8f0' : '#0f172a';
    const palette = (themeColors && themeColors.length)
        ? themeColors.slice()
        : ['#3b82f6', '#06b6d4', '#8b5cf6', '#10b981', '#f59e0b'];
    while (palette.length < 5) palette.push(palette[palette.length - 1] || '#3b82f6');

    function soften(hex, towardWhite) {
        if (typeof mixHex !== 'function') return hex;
        const t = isDark ? 0.22 : (towardWhite != null ? towardWhite : 0.42);
        return mixHex(hex, isDark ? '#0f172a' : '#ffffff', t);
    }
    function strokeOf(hex) {
        if (typeof mixHex !== 'function') return isDark ? '#64748b' : '#94a3b8';
        return mixHex(hex, isDark ? '#0f172a' : '#1e293b', isDark ? 0.35 : 0.28);
    }

    /* Тип блока → слот палитры; заливка приглушена */
    const shapeFill = {
        rect: soften(palette[0], 0.38),
        round: soften(palette[1], 0.4),
        stadium: soften(palette[1], 0.36),
        diamond: soften(palette[2], 0.36),
        circle: soften(palette[3], 0.4),
        parallelogram: soften(palette[4] || palette[0], 0.4),
        subroutine: soften(palette[0], 0.34),
        cylinder: soften(palette[3], 0.36),
        document: soften(palette[4] || palette[1], 0.42)
    };
    const shapeStroke = {
        rect: strokeOf(palette[0]),
        round: strokeOf(palette[1]),
        stadium: strokeOf(palette[1]),
        diamond: strokeOf(palette[2]),
        circle: strokeOf(palette[3]),
        parallelogram: strokeOf(palette[4] || palette[0]),
        subroutine: strokeOf(palette[0]),
        cylinder: strokeOf(palette[3]),
        document: strokeOf(palette[4] || palette[1])
    };
    const edgeCol = isDark ? '#94a3b8' : '#64748b';

    function el(name, attrs) {
        const n = document.createElementNS(svgNS, name);
        Object.keys(attrs || {}).forEach((k) => n.setAttribute(k, String(attrs[k])));
        return n;
    }

    function roundedOrthoPath(points, radius) {
        if (!points || points.length < 2) return '';
        if (points.length === 2) {
            return 'M' + points[0].x + ',' + points[0].y
                + 'L' + points[1].x + ',' + points[1].y;
        }
        const r0 = Math.max(0, radius || 0);
        let d = 'M' + points[0].x + ',' + points[0].y;
        for (let i = 1; i < points.length - 1; i++) {
            const prev = points[i - 1];
            const cur = points[i];
            const next = points[i + 1];
            const d1 = Math.hypot(cur.x - prev.x, cur.y - prev.y);
            const d2 = Math.hypot(next.x - cur.x, next.y - cur.y);
            const r = Math.min(r0, d1 / 2, d2 / 2);
            if (r < 0.5) {
                d += 'L' + cur.x + ',' + cur.y;
                continue;
            }
            const before = {
                x: cur.x - ((cur.x - prev.x) / d1) * r,
                y: cur.y - ((cur.y - prev.y) / d1) * r
            };
            const after = {
                x: cur.x + ((next.x - cur.x) / d2) * r,
                y: cur.y + ((next.y - cur.y) / d2) * r
            };
            d += 'L' + before.x + ',' + before.y
                + 'Q' + cur.x + ',' + cur.y + ' ' + after.x + ',' + after.y;
        }
        const last = points[points.length - 1];
        d += 'L' + last.x + ',' + last.y;
        return d;
    }

    function appendNodeLabel(g, n, fill) {
        const lines = n.lines || [n.label];
        const cx = n.x + n.width / 2;
        const cy = n.y + n.height / 2;
        const fs = 13;
        const lh = fs * 1.3;
        const optical = fs * 0.35;
        const text = el('text', {
            x: cx,
            fill,
            'font-size': fs,
            'font-weight': 600,
            'text-anchor': 'middle'
        });
        text.setAttribute('data-label', n.label || '');
        if (n.id) text.setAttribute('data-node-id', String(n.id));
        if (typeof setDiagramSourceLine === 'function') {
            setDiagramSourceLine(text, n.line || n.sourceLine);
        }
        if (lines.length === 1) {
            text.setAttribute('y', cy + optical);
            text.textContent = lines[0];
        } else {
            const startY = cy - ((lines.length - 1) * lh) / 2 + optical;
            lines.forEach((line, i) => {
                const tspan = document.createElementNS(svgNS, 'tspan');
                tspan.setAttribute('x', cx);
                tspan.setAttribute('y', startY + i * lh);
                tspan.textContent = line;
                text.appendChild(tspan);
            });
        }
        g.appendChild(text);
    }

    svg.setAttribute('overflow', 'visible');
    svg.appendChild(el('rect', { x: 0, y: 0, width: width, height: height, fill: bg }));

    const titleEl = el('text', {
        x: width / 2, y: 28, fill: ink, 'font-size': 16, 'font-weight': 700, 'text-anchor': 'middle'
    });
    titleEl.textContent = title;
    svg.appendChild(titleEl);

    const defs = el('defs', {});
    // Мягкая тень узлов (как у Lucidchart / draw.io)
    const shadow = el('filter', {
        id: 'fc-shadow',
        x: '-20%', y: '-20%', width: '140%', height: '140%'
    });
    shadow.appendChild(el('feDropShadow', {
        dx: '0',
        dy: isDark ? '2' : '1.5',
        stdDeviation: isDark ? '2.2' : '2',
        'flood-color': isDark ? '#000000' : '#0f172a',
        'flood-opacity': isDark ? '0.45' : '0.12'
    }));
    defs.appendChild(shadow);
    svg.appendChild(defs);

    // Рёбра под узлами (линии не «протыкают» блоки); наконечники — отдельным слоем сверху
    const edgesLayer = el('g', { class: 'fc-edges' });
    const nodesLayer = el('g', { class: 'fc-nodes' });
    const arrowsLayer = el('g', { class: 'fc-arrows' });
    svg.appendChild(edgesLayer);
    svg.appendChild(nodesLayer);
    svg.appendChild(arrowsLayer);

    function appendArrowHead(from, to, lineRef) {
        if (!from || !to) return;
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const tip = to;
        const back = 10;
        const half = 3.4;
        const bx = tip.x - ux * back;
        const by = tip.y - uy * back;
        const px = -uy * half;
        const py = ux * half;
        const head = el('path', {
            d: 'M' + tip.x + ',' + tip.y
                + ' L' + (bx + px) + ',' + (by + py)
                + ' L' + (bx - px) + ',' + (by - py)
                + ' Z',
            fill: edgeCol,
            stroke: 'none'
        });
        if (typeof setDiagramSourceLine === 'function') {
            setDiagramSourceLine(head, lineRef);
        }
        arrowsLayer.appendChild(head);
    }

    edges.forEach((e) => {
        let d;
        if (e.points && e.points.length >= 2) {
            d = roundedOrthoPath(e.points, e.cornerR != null ? e.cornerR : 12);
        } else {
            d = 'M' + e.x1 + ',' + e.y1
                + ' C' + e.cx1 + ',' + e.cy1 + ' ' + e.cx2 + ',' + e.cy2 + ' ' + e.x2 + ',' + e.y2;
        }
        const path = el('path', {
            d,
            fill: 'none',
            stroke: edgeCol,
            'stroke-width': 1.5,
            'stroke-linejoin': 'round',
            'stroke-linecap': 'round',
            opacity: 0.92
        });
        if (typeof setDiagramSourceLine === 'function') {
            setDiagramSourceLine(path, e.line || e.sourceLine);
        }
        edgesLayer.appendChild(path);

        const pts = e.points && e.points.length ? e.points : [
            { x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }
        ];
        if (pts.length >= 2) {
            appendArrowHead(pts[pts.length - 2], pts[pts.length - 1], e.line || e.sourceLine);
        }

        let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
        pts.forEach((p) => {
            minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
        });
        const hitPad = 12;
        const hit = el('rect', {
            x: minX - hitPad, y: minY - hitPad,
            width: Math.max(20, maxX - minX + hitPad * 2),
            height: Math.max(20, maxY - minY + hitPad * 2),
            fill: 'transparent', stroke: 'none'
        });
        if (typeof setDiagramSourceLine === 'function') {
            setDiagramSourceLine(hit, e.line || e.sourceLine);
        }
        edgesLayer.appendChild(hit);

        if (e.label) {
            const label = String(e.label);
            const lines = (e.labelLines && e.labelLines.length)
                ? e.labelLines
                : [label];
            const lineH = 13;
            const approxW = e.labelW || Math.min(200, Math.max(36, label.length * 6.8 + 16));
            const approxH = e.labelH || (lines.length * lineH + 8);
            const lx = e.lx != null ? e.lx : (e.x1 + e.x2) / 2;
            const ly = e.ly != null ? e.ly : (e.y1 + e.y2) / 2 - 6;
            const bgFill = isDark ? '#0f172a' : '#ffffff';
            const bgStroke = isDark ? '#334155' : '#e2e8f0';
            const labelBg = el('rect', {
                x: lx - approxW / 2,
                y: ly - approxH / 2,
                width: approxW,
                height: approxH,
                rx: 6,
                fill: bgFill,
                stroke: bgStroke,
                'stroke-width': 1,
                opacity: 0.98
            });
            if (typeof setDiagramSourceLine === 'function') {
                setDiagramSourceLine(labelBg, e.line || e.sourceLine);
            }
            // Подписи поверх узлов, чтобы «да/нет» читались
            arrowsLayer.appendChild(labelBg);
            const optical = 11 * 0.35;
            const startY = ly - ((lines.length - 1) * lineH) / 2 + optical;
            lines.forEach((line, i) => {
                const t = el('text', {
                    x: lx,
                    y: startY + i * lineH,
                    fill: ink,
                    'font-size': 11,
                    'font-weight': 600,
                    'text-anchor': 'middle'
                });
                t.textContent = line;
                if (i === 0) t.setAttribute('data-label', label);
                if (typeof setDiagramSourceLine === 'function') {
                    setDiagramSourceLine(t, e.line || e.sourceLine);
                }
                arrowsLayer.appendChild(t);
            });
        }
    });

    nodes.forEach((n) => {
        const fill = shapeFill[n.shape] || shapeFill.rect;
        const stroke = shapeStroke[n.shape] || shapeStroke.rect;
        const g = el('g', {
            class: 'fc-node',
            filter: 'url(#fc-shadow)'
        });
        if (n.id) g.setAttribute('data-node-id', String(n.id));
        if (typeof setDiagramSourceLine === 'function') setDiagramSourceLine(g, n.line || n.sourceLine);
        const x = n.x;
        const y = n.y;
        const w = n.width;
        const h = n.height;
        const shape = n.shape || 'rect';

        if (shape === 'diamond') {
            const cx = x + w / 2;
            const cy = y + h / 2;
            const hw = w / 2;
            const hh = h / 2;
            g.appendChild(el('polygon', {
                points: [
                    cx + ',' + (cy - hh),
                    (cx + hw) + ',' + cy,
                    cx + ',' + (cy + hh),
                    (cx - hw) + ',' + cy
                ].join(' '),
                fill, stroke, 'stroke-width': 1.35
            }));
        } else if (shape === 'circle') {
            g.appendChild(el('ellipse', {
                cx: x + w / 2, cy: y + h / 2,
                rx: w / 2, ry: h / 2,
                fill, stroke, 'stroke-width': 1.35
            }));
        } else if (shape === 'parallelogram') {
            const skew = Math.min(26, Math.max(14, w * 0.16));
            g.appendChild(el('polygon', {
                points: [
                    (x + skew) + ',' + y,
                    (x + w) + ',' + y,
                    (x + w - skew) + ',' + (y + h),
                    x + ',' + (y + h)
                ].join(' '),
                fill, stroke, 'stroke-width': 1.35
            }));
        } else if (shape === 'cylinder') {
            const ry = Math.min(14, Math.max(8, h * 0.16));
            const cx = x + w / 2;
            g.appendChild(el('path', {
                d: [
                    'M' + x + ',' + (y + ry),
                    'L' + x + ',' + (y + h - ry),
                    'A' + (w / 2) + ',' + ry + ' 0 0 0 ' + (x + w) + ',' + (y + h - ry),
                    'L' + (x + w) + ',' + (y + ry),
                    'A' + (w / 2) + ',' + ry + ' 0 0 0 ' + x + ',' + (y + ry),
                    'Z'
                ].join(' '),
                fill, stroke, 'stroke-width': 1.35
            }));
            g.appendChild(el('ellipse', {
                cx: cx, cy: y + ry,
                rx: w / 2, ry: ry,
                fill, stroke, 'stroke-width': 1.35
            }));
        } else if (shape === 'document') {
            const wave = Math.min(12, h * 0.22);
            const mid = x + w / 2;
            g.appendChild(el('path', {
                d: [
                    'M' + x + ',' + y,
                    'L' + (x + w) + ',' + y,
                    'L' + (x + w) + ',' + (y + h - wave),
                    'Q' + (mid + w * 0.2) + ',' + (y + h + wave * 0.35) + ' ' + mid + ',' + (y + h - wave * 0.15),
                    'Q' + (mid - w * 0.2) + ',' + (y + h - wave * 0.9) + ' ' + x + ',' + (y + h - wave),
                    'Z'
                ].join(' '),
                fill, stroke, 'stroke-width': 1.35
            }));
        } else if (shape === 'subroutine') {
            // Predefined process (ISO 5807): прямоугольник + две вертикальные полосы у краёв
            const inset = Math.min(14, Math.max(10, w * 0.08));
            const barW = Math.max(2.2, Math.min(3.2, inset * 0.26));
            g.appendChild(el('rect', {
                x: x, y: y, width: w, height: h,
                rx: 6, ry: 6,
                fill, stroke, 'stroke-width': 1.4
            }));
            g.appendChild(el('rect', {
                x: x + inset, y: y + 3, width: barW, height: Math.max(4, h - 6),
                rx: 0.8, fill: stroke, stroke: 'none', opacity: 0.88
            }));
            g.appendChild(el('rect', {
                x: x + w - inset - barW, y: y + 3, width: barW, height: Math.max(4, h - 6),
                rx: 0.8, fill: stroke, stroke: 'none', opacity: 0.88
            }));
        } else {
            // rect / round / stadium
            let rx = 10;
            if (shape === 'stadium') rx = h / 2;
            else if (shape === 'round') rx = Math.min(22, h / 2);
            g.appendChild(el('rect', {
                x: x, y: y, width: w, height: h,
                rx: rx, ry: rx,
                fill, stroke, 'stroke-width': 1.35
            }));
        }

        const txtColor = (typeof getContrastColor === 'function')
            ? getContrastColor(fill)
            : '#fff';
        appendNodeLabel(g, n, txtColor);
        if (typeof appendDiagramNodeMeta === 'function' && (n.assignee || n.deadlineLabel || n.initials)) {
            appendDiagramNodeMeta(svgNS, g, {
                x: n.x, y: n.y, width: n.width, height: n.height
            }, n, { avatarR: 16, deadlineFontSize: 12, deadlineH: 20 });
        }
        nodesLayer.appendChild(g);
    });

    return { svg, width, height, svgString: new XMLSerializer().serializeToString(svg) };
}
