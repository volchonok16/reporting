/**
 * SVG диаграммы состояний.
 * Рёбра: cubic для forward/same, ортогональный path для back.
 * Подписи рисуются поверх блоков.
 */
function generateStateSVG(layoutData, themeColors) {
    const nodes = layoutData.nodes || [];
    const edges = layoutData.edges || [];
    const width = layoutData.width || 400;
    const height = layoutData.height || 300;
    const title = layoutData.title || 'Состояния';
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
    const muted = isDark ? '#94a3b8' : '#64748b';
    const panel = isDark ? '#1e293b' : '#ffffff';
    const palette = (themeColors && themeColors.length)
        ? themeColors
        : ['#3b82f6', '#06b6d4', '#8b5cf6', '#10b981', '#f59e0b'];
    const edgeCol = isDark ? '#94a3b8' : '#64748b';

    function el(name, attrs) {
        const n = document.createElementNS(svgNS, name);
        Object.keys(attrs || {}).forEach((k) => n.setAttribute(k, String(attrs[k])));
        return n;
    }

    svg.appendChild(el('rect', { x: 0, y: 0, width: width, height: height, fill: bg }));

    const titleEl = el('text', {
        x: width / 2, y: 26, fill: ink, 'font-size': 16, 'font-weight': 700, 'text-anchor': 'middle'
    });
    titleEl.textContent = title;
    svg.appendChild(titleEl);

    const sub = el('text', {
        x: width / 2, y: 44, fill: muted, 'font-size': 11, 'text-anchor': 'middle'
    });
    sub.textContent = layoutData.orientation === 'tb'
        ? 'Статусы сверху вниз · сбоку — возвраты назад'
        : 'Статусы слева направо · снизу — возвраты назад';
    svg.appendChild(sub);

    const defs = el('defs', {});
    const marker = el('marker', {
        id: 'state-arrow',
        markerWidth: 10,
        markerHeight: 10,
        refX: 8,
        refY: 3,
        orient: 'auto',
        markerUnits: 'strokeWidth'
    });
    marker.appendChild(el('path', { d: 'M0,0 L8,3 L0,6 Z', fill: edgeCol }));
    defs.appendChild(marker);
    svg.appendChild(defs);

    function edgePath(e) {
        if (e.points && e.points.length >= 2) {
            return e.points.map((p, i) => (i ? 'L' : 'M') + p.x + ',' + p.y).join(' ');
        }
        if (e.route === 'back' || e.orth) {
            return 'M' + e.x1 + ',' + e.y1
                + ' L' + e.cx1 + ',' + e.cy1
                + ' L' + e.cx2 + ',' + e.cy2
                + ' L' + e.x2 + ',' + e.y2;
        }
        return 'M' + e.x1 + ',' + e.y1
            + ' C' + e.cx1 + ',' + e.cy1 + ' ' + e.cx2 + ',' + e.cy2 + ' ' + e.x2 + ',' + e.y2;
    }

    edges.forEach((e) => {
        const path = el('path', {
            d: edgePath(e),
            fill: 'none',
            stroke: edgeCol,
            'stroke-width': e.route === 'back' ? 1.4 : 1.75,
            'stroke-dasharray': e.route === 'back' ? '5,4' : 'none',
            'marker-end': 'url(#state-arrow)'
        });
        if (typeof setDiagramSourceLine === 'function') setDiagramSourceLine(path, e.line || e.sourceLine);
        svg.appendChild(path);

        const hit = el('path', {
            d: edgePath(e),
            fill: 'none',
            stroke: 'transparent',
            'stroke-width': 14
        });
        if (typeof setDiagramSourceLine === 'function') setDiagramSourceLine(hit, e.line || e.sourceLine);
        svg.appendChild(hit);
    });

    let colorIdx = 0;
    nodes.forEach((n) => {
        const g = el('g', {});
        if (typeof setDiagramSourceLine === 'function') setDiagramSourceLine(g, n.line || n.sourceLine);

        if (n.kind === 'initial') {
            g.appendChild(el('circle', {
                cx: n.cx, cy: n.cy, r: 9,
                fill: ink, stroke: 'none'
            }));
        } else if (n.kind === 'final') {
            g.appendChild(el('circle', {
                cx: n.cx, cy: n.cy, r: 11,
                fill: 'none', stroke: ink, 'stroke-width': 2
            }));
            g.appendChild(el('circle', {
                cx: n.cx, cy: n.cy, r: 6,
                fill: ink, stroke: 'none'
            }));
        } else {
            const fill = palette[colorIdx++ % palette.length];
            g.appendChild(el('rect', {
                x: n.x, y: n.y, width: n.width, height: n.height, rx: 14,
                fill: panel, stroke: fill, 'stroke-width': 2
            }));
            const lines = n.lines || [n.label];
            const startY = n.cy - ((lines.length - 1) * 15) / 2;
            lines.forEach((line, i) => {
                const t = el('text', {
                    x: n.cx, y: startY + i * 15,
                    fill: ink, 'font-size': 13, 'font-weight': 600,
                    'text-anchor': 'middle', 'dominant-baseline': 'middle'
                });
                t.textContent = line;
                g.appendChild(t);
            });
        }
        svg.appendChild(g);
    });

    edges.forEach((e) => {
        if (!e.label) return;
        const label = String(e.label);
        const approxW = Math.min(150, Math.max(28, label.length * 6.2 + 12));
        const lx = e.lx != null ? e.lx : (e.x1 + e.x2) / 2;
        const ly = e.ly != null ? e.ly : (e.y1 + e.y2) / 2;
        const bgR = el('rect', {
            x: lx - approxW / 2, y: ly - 10, width: approxW, height: 18, rx: 4,
            fill: isDark ? '#0f172a' : '#ffffff',
            stroke: isDark ? '#334155' : '#e2e8f0',
            'stroke-width': 1
        });
        if (typeof setDiagramSourceLine === 'function') setDiagramSourceLine(bgR, e.line || e.sourceLine);
        svg.appendChild(bgR);
        const t = el('text', {
            x: lx, y: ly + 3, fill: muted, 'font-size': 11, 'font-weight': 600,
            'text-anchor': 'middle'
        });
        t.textContent = label.length > 22 ? label.slice(0, 20) + '…' : label;
        if (typeof setDiagramSourceLine === 'function') setDiagramSourceLine(t, e.line || e.sourceLine);
        svg.appendChild(t);
    });

    return { svg, width, height, svgString: new XMLSerializer().serializeToString(svg) };
}
