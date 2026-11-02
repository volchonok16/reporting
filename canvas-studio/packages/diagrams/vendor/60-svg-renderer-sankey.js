/**
 * Рендерер классического Sankey («Потоки»).
 * Ленты — цвет источника, полупрозрачные; узлы — вертикальные бруски с итогами.
 */
function generateSankeySVG(layoutData, themeColors) {
    const { nodes, links, width, height, title, columnLabels } = layoutData;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.style.fontFamily = (typeof getUiFontFamily === 'function' ? getUiFontFamily() : 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif');
    svg.style.fontSize = '13px';

    const isDark = document.body.classList.contains('dark');
    const theme = themeColors || [];
    const defaultColor = isDark ? '#60a5fa' : '#3b82f6';
    const labelColor = isDark ? '#e5e7eb' : '#1f2937';
    const mutedColor = isDark ? '#94a3b8' : '#64748b';
    const valueOnLink = isDark ? '#f8fafc' : '#0f172a';

    function softHex(hex, mixWith, t) {
        const parse = (h) => {
            const s = String(h || '').replace('#', '');
            if (s.length !== 6) return [59, 130, 246];
            return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
        };
        const a = parse(hex);
        const b = parse(mixWith);
        const m = (i) => Math.round(a[i] * (1 - t) + b[i] * t);
        return `#${[m(0), m(1), m(2)].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
    }

    function fmt(n) {
        return (Math.round(n * 100) / 100).toLocaleString('ru-RU');
    }

    const defs = document.createElementNS(svgNS, 'defs');
    svg.appendChild(defs);

    if (title) {
        const titleEl = document.createElementNS(svgNS, 'text');
        titleEl.setAttribute('x', width / 2);
        titleEl.setAttribute('y', 30);
        titleEl.setAttribute('fill', labelColor);
        titleEl.setAttribute('text-anchor', 'middle');
        titleEl.setAttribute('font-weight', '700');
        titleEl.setAttribute('font-size', '16px');
        titleEl.textContent = title;
        svg.appendChild(titleEl);
    }

    (columnLabels || []).forEach((col) => {
        const t = document.createElementNS(svgNS, 'text');
        t.setAttribute('x', col.x);
        t.setAttribute('y', col.y);
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('fill', labelColor);
        t.setAttribute('font-size', '15px');
        t.setAttribute('font-weight', '700');
        t.setAttribute('letter-spacing', '0.02em');
        t.textContent = col.text;
        svg.appendChild(t);
    });

    const linkGroup = document.createElementNS(svgNS, 'g');
    const nodeGroup = document.createElementNS(svgNS, 'g');
    const labelGroup = document.createElementNS(svgNS, 'g');
    const linkLabels = [];
    svg.appendChild(linkGroup);
    svg.appendChild(nodeGroup);
    svg.appendChild(labelGroup);

    // Цвет узла: по порядку появления слева направо / сверху вниз
    const nodeColorMap = new Map();
    const sortedForColor = [...nodes].sort((a, b) => (a.x - b.x) || (a.y - b.y));
    sortedForColor.forEach((node, i) => {
        nodeColorMap.set(node.name, theme.length ? theme[i % theme.length] : defaultColor);
    });

    // Ленты: цвет источника, полупрозрачность (классический Sankey)
    links.forEach((link, idx) => {
        const sourceColor = nodeColorMap.get(link.source) || defaultColor;
        const x0 = link.x1;
        const x1 = link.x2;
        const y0 = link.y1;
        const y1 = link.y2;
        const t0 = Math.max(2, link.thickness || 10) / 2;
        const t1 = Math.max(2, link.targetThickness != null ? link.targetThickness : link.thickness || 10) / 2;
        const dx = x1 - x0;
        const c1 = x0 + dx * 0.45;
        const c2 = x1 - dx * 0.45;

        const d = [
            `M ${x0} ${y0 - t0}`,
            `C ${c1} ${y0 - t0}, ${c2} ${y1 - t1}, ${x1} ${y1 - t1}`,
            `L ${x1} ${y1 + t1}`,
            `C ${c2} ${y1 + t1}, ${c1} ${y0 + t0}, ${x0} ${y0 + t0}`,
            'Z'
        ].join(' ');

        const path = document.createElementNS(svgNS, 'path');
        path.setAttribute('d', d);
        path.setAttribute('fill', softHex(sourceColor, isDark ? '#0f172a' : '#ffffff', 0.12));
        path.setAttribute('fill-opacity', isDark ? '0.55' : '0.48');
        path.setAttribute('stroke', 'none');
        if (typeof setDiagramSourceLine === 'function') {
            setDiagramSourceLine(path, link.line || link.sourceLine);
        }
        linkGroup.appendChild(path);

        // Подпись потока — только на достаточно толстых лентах
        const band = Math.min(t0, t1) * 2;
        if (band >= 18) {
            const midX = (x0 + x1) / 2;
            const midY = (y0 + y1) / 2;
            const text = document.createElementNS(svgNS, 'text');
            text.setAttribute('x', midX);
            text.setAttribute('y', midY + 4);
            text.setAttribute('fill', valueOnLink);
            text.setAttribute('text-anchor', 'middle');
            text.setAttribute('font-size', '11px');
            text.setAttribute('font-weight', '700');
            text.setAttribute('opacity', '0.9');
            text.textContent = fmt(link.value);
            labelGroup.appendChild(text);
            linkLabels.push({ el: text, x: midX, y: midY + 4, w: String(text.textContent).length * 7 + 4 });
        }
    });

    const layerXs = [...new Set(nodes.map((n) => n.x))].sort((a, b) => a - b);
    const firstX = layerXs[0];
    const lastX = layerXs[layerXs.length - 1];

    const haloColor = typeof readCssColor === 'function'
        ? readCssColor('--diagram-bg', isDark ? '#161618' : '#f8fafc')
        : (isDark ? '#161618' : '#f8fafc');
    const middleLabels = [];
    nodes.forEach((node) => {
        const color = nodeColorMap.get(node.name) || defaultColor;
        const rect = document.createElementNS(svgNS, 'rect');
        rect.setAttribute('x', node.x);
        rect.setAttribute('y', node.y);
        rect.setAttribute('width', node.width);
        rect.setAttribute('height', node.height);
        rect.setAttribute('fill', color);
        rect.setAttribute('rx', '2');
        rect.setAttribute('stroke', isDark ? '#0b1220' : '#ffffff');
        rect.setAttribute('stroke-width', '1');
        if (typeof setDiagramSourceLine === 'function') {
            setDiagramSourceLine(rect, node.sourceLine || node.line);
        }
        nodeGroup.appendChild(rect);

        const onLeft = node.x <= firstX + 1;
        const onRight = node.x >= lastX - 1;
        const nameEl = document.createElementNS(svgNS, 'text');
        nameEl.setAttribute('fill', labelColor);
        nameEl.setAttribute('font-size', '13px');
        nameEl.setAttribute('font-weight', '700');
        const flowEl = document.createElementNS(svgNS, 'text');
        flowEl.setAttribute('fill', mutedColor);
        flowEl.setAttribute('font-size', '11px');
        flowEl.setAttribute('font-weight', '600');
        flowEl.textContent = fmt(node.flow);

        if (onLeft) {
            nameEl.setAttribute('x', node.x - 10);
            nameEl.setAttribute('y', node.y + node.height / 2 - 2);
            nameEl.setAttribute('text-anchor', 'end');
            flowEl.setAttribute('x', node.x - 10);
            flowEl.setAttribute('y', node.y + node.height / 2 + 14);
            flowEl.setAttribute('text-anchor', 'end');
        } else if (onRight) {
            nameEl.setAttribute('x', node.x + node.width + 10);
            nameEl.setAttribute('y', node.y + node.height / 2 - 2);
            nameEl.setAttribute('text-anchor', 'start');
            flowEl.setAttribute('x', node.x + node.width + 10);
            flowEl.setAttribute('y', node.y + node.height / 2 + 14);
            flowEl.setAttribute('text-anchor', 'start');
        } else {
            // Simmetrika: a middle node is labelled beside it, name and value on one line, over a halo
            // of the background — above it, centred, labels of a dense column ran into each other.
            nameEl.setAttribute('x', node.x + node.width + 6);
            nameEl.setAttribute('y', node.y + node.height / 2 + 4);
            nameEl.setAttribute('text-anchor', 'start');
            nameEl.setAttribute('font-size', '12px');
            nameEl.setAttribute('stroke', haloColor);
            nameEl.setAttribute('stroke-width', '3');
            nameEl.setAttribute('stroke-linejoin', 'round');
            nameEl.setAttribute('paint-order', 'stroke');
            nameEl.textContent = node.name + ' ';
            const value = document.createElementNS(svgNS, 'tspan');
            value.setAttribute('fill', mutedColor);
            value.setAttribute('font-weight', '600');
            value.setAttribute('font-size', '11px');
            value.textContent = fmt(node.flow);
            nameEl.appendChild(value);
            nameEl.setAttribute('data-label', node.name);
            labelGroup.appendChild(nameEl);
            middleLabels.push({ el: nameEl, x: node.x, y: node.y + node.height / 2 + 4 });
            return;
        }
        nameEl.textContent = node.name;
        nameEl.setAttribute('data-label', node.name);
        labelGroup.appendChild(nameEl);
        labelGroup.appendChild(flowEl);
    });

    // Labels of one middle column kept a line apart, nearest to their nodes.
    const columns = new Map();
    middleLabels.forEach((l) => {
        if (!columns.has(l.x)) columns.set(l.x, []);
        columns.get(l.x).push(l);
    });
    columns.forEach((list) => {
        list.sort((a, b) => a.y - b.y);
        const LINE = 15;
        for (let i = 1; i < list.length; i++) list[i].y = Math.max(list[i].y, list[i - 1].y + LINE);
        list.forEach((l) => l.el.setAttribute('y', l.y));
    });

    // A value on a band under a node's label goes: the label already says it.
    const measure = (() => {
        if (typeof document === 'undefined') return (t) => t.length * 7;
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.font = '700 12px ' + (typeof getUiFontFamily === 'function' ? getUiFontFamily() : 'system-ui');
        return (t) => ctx.measureText(t).width;
    })();
    middleLabels.forEach((l) => {
        const x0 = Number(l.el.getAttribute('x'));
        const x1 = x0 + measure(l.el.textContent) + 4;
        const y = l.y;
        linkLabels.forEach((v) => {
            if (v.x + v.w / 2 > x0 && v.x - v.w / 2 < x1 && Math.abs(v.y - y) < 13) v.el.remove();
        });
    });

    return { svg, width, height, svgString: new XMLSerializer().serializeToString(svg) };
}
