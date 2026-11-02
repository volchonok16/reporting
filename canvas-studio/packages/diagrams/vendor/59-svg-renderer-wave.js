/**
 * Рендерер волнообразной (Sankey) диаграммы.
 * Ленты — залитые Bezier-полосы (не толстый stroke), узлы с подписью сбоку.
 */
function generateWaveSVG(layoutData, themeColors) {
    const { nodes, links, width, height, title } = layoutData;
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    svg.style.fontFamily = (typeof getUiFontFamily === "function" ? getUiFontFamily() : "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif");
    svg.style.fontSize = "13px";

    const isDark = document.body.classList.contains('dark');
    const theme = themeColors || [];
    const defaultColor = isDark ? '#60a5fa' : '#3b82f6';
    const labelColor = isDark ? '#e5e7eb' : '#1f2937';
    const valueColor = isDark ? '#f8fafc' : '#111827';

    const defs = document.createElementNS(svgNS, "defs");
    svg.appendChild(defs);

    if (title) {
        const titleEl = document.createElementNS(svgNS, "text");
        titleEl.setAttribute("x", width / 2);
        titleEl.setAttribute("y", 32);
        titleEl.setAttribute("fill", labelColor);
        titleEl.setAttribute("text-anchor", "middle");
        titleEl.setAttribute("font-weight", "700");
        titleEl.setAttribute("font-size", "16px");
        titleEl.textContent = title;
        svg.appendChild(titleEl);
    }

    const linkGroup = document.createElementNS(svgNS, "g");
    const nodeGroup = document.createElementNS(svgNS, "g");
    const labelGroup = document.createElementNS(svgNS, "g");
    const bandLabels = [];
    const middleLabels = [];
    const haloColor = typeof readCssColor === 'function'
        ? readCssColor('--diagram-bg', isDark ? '#161618' : '#f8fafc')
        : (isDark ? '#161618' : '#f8fafc');
    svg.appendChild(linkGroup);
    svg.appendChild(nodeGroup);
    svg.appendChild(labelGroup);

    const nodeColorMap = new Map();
    nodes.forEach((node, i) => {
        nodeColorMap.set(node.name, theme.length > 0 ? theme[i % theme.length] : defaultColor);
    });

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

    // Ленты: залитый путь из двух кубических кривых (верх + низ)
    links.forEach((link, idx) => {
        const sourceColor = nodeColorMap.get(link.source) || defaultColor;
        const targetColor = nodeColorMap.get(link.target) || defaultColor;
        const x0 = link.x1;
        const x1 = link.x2;
        const y0 = link.y1;
        const y1 = link.y2;
        const t0 = Math.max(2, link.thickness || 10) / 2;
        const t1 = Math.max(2, link.targetThickness != null ? link.targetThickness : link.thickness || 10) / 2;
        const dx = x1 - x0;
        const c1 = x0 + dx * 0.42;
        const c2 = x1 - dx * 0.42;

        const d = [
            `M ${x0} ${y0 - t0}`,
            `C ${c1} ${y0 - t0}, ${c2} ${y1 - t1}, ${x1} ${y1 - t1}`,
            `L ${x1} ${y1 + t1}`,
            `C ${c2} ${y1 + t1}, ${c1} ${y0 + t0}, ${x0} ${y0 + t0}`,
            'Z'
        ].join(' ');

        const gradId = `wave-grad-${idx}`;
        const grad = document.createElementNS(svgNS, "linearGradient");
        grad.setAttribute("id", gradId);
        grad.setAttribute("x1", String(x0));
        grad.setAttribute("y1", "0");
        grad.setAttribute("x2", String(x1));
        grad.setAttribute("y2", "0");
        grad.setAttribute("gradientUnits", "userSpaceOnUse");
        const s1 = document.createElementNS(svgNS, "stop");
        s1.setAttribute("offset", "0%");
        s1.setAttribute("stop-color", softHex(sourceColor, isDark ? '#0f172a' : '#ffffff', 0.08));
        s1.setAttribute("stop-opacity", "0.72");
        const s2 = document.createElementNS(svgNS, "stop");
        s2.setAttribute("offset", "100%");
        s2.setAttribute("stop-color", softHex(targetColor, isDark ? '#0f172a' : '#ffffff', 0.08));
        s2.setAttribute("stop-opacity", "0.72");
        grad.appendChild(s1);
        grad.appendChild(s2);
        defs.appendChild(grad);

        const path = document.createElementNS(svgNS, "path");
        path.setAttribute("d", d);
        path.setAttribute("fill", `url(#${gradId})`);
        path.setAttribute("stroke", "none");
        if (typeof setDiagramSourceLine === 'function') {
            setDiagramSourceLine(path, link.line || link.sourceLine);
        }
        linkGroup.appendChild(path);

        // Значение по центру ленты
        const midX = (x0 + x1) / 2;
        const midY = (y0 + y1) / 2;
        const text = document.createElementNS(svgNS, "text");
        text.setAttribute("x", midX);
        text.setAttribute("y", midY + 4);
        text.setAttribute("fill", valueColor);
        text.setAttribute("text-anchor", "middle");
        text.setAttribute("font-size", "12px");
        text.setAttribute("font-weight", "600");
        text.setAttribute("opacity", "0.85");
        text.textContent = link.value;
        labelGroup.appendChild(text);
        bandLabels.push({ el: text, x: midX, y: midY + 4, w: String(link.value).length * 7.5 + 4 });
    });

    // Узлы + подписи сбоку (не внутри узкой полоски)
    const layerXs = [...new Set(nodes.map((n) => n.x))].sort((a, b) => a - b);
    const firstX = layerXs[0];
    const lastX = layerXs[layerXs.length - 1];

    nodes.forEach(node => {
        const color = nodeColorMap.get(node.name) || defaultColor;
        const rect = document.createElementNS(svgNS, "rect");
        rect.setAttribute("x", node.x);
        rect.setAttribute("y", node.y);
        rect.setAttribute("width", node.width);
        rect.setAttribute("height", node.height);
        rect.setAttribute("fill", color);
        rect.setAttribute("rx", "3");
        if (typeof setDiagramSourceLine === 'function') {
            setDiagramSourceLine(rect, node.sourceLine || node.line);
        }
        nodeGroup.appendChild(rect);

        const onLeft = node.x <= firstX + 1;
        const onRight = node.x >= lastX - 1;
        const text = document.createElementNS(svgNS, "text");
        text.setAttribute("y", node.y + node.height / 2 + 4);
        text.setAttribute("fill", labelColor);
        text.setAttribute("font-size", "13px");
        text.setAttribute("font-weight", "600");
        if (onLeft) {
            text.setAttribute("x", node.x - 10);
            text.setAttribute("text-anchor", "end");
        } else if (onRight) {
            text.setAttribute("x", node.x + node.width + 10);
            text.setAttribute("text-anchor", "start");
        } else {
            // Simmetrika: beside the node over a halo of the background (above it, centred, it sat on
            // the bands and on the node above), kept a line apart from its column's neighbours.
            text.setAttribute("x", node.x + node.width + 6);
            text.setAttribute("text-anchor", "start");
            text.setAttribute("stroke", haloColor);
            text.setAttribute("stroke-width", "3");
            text.setAttribute("stroke-linejoin", "round");
            text.setAttribute("paint-order", "stroke");
            middleLabels.push({ el: text, col: node.x, y: node.y + node.height / 2 + 4, name: node.name });
        }
        text.textContent = node.name;
        text.setAttribute('data-label', node.name);
        labelGroup.appendChild(text);
    });

    const columns = new Map();
    middleLabels.forEach((l) => {
        if (!columns.has(l.col)) columns.set(l.col, []);
        columns.get(l.col).push(l);
    });
    columns.forEach((list) => {
        list.sort((a, b) => a.y - b.y);
        for (let i = 1; i < list.length; i++) list[i].y = Math.max(list[i].y, list[i - 1].y + 16);
        list.forEach((l) => l.el.setAttribute("y", l.y));
    });
    // A band's value under a label goes (the node's name is what is read there).
    const ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
    if (ctx) ctx.font = '600 13px ' + (typeof getUiFontFamily === 'function' ? getUiFontFamily() : 'system-ui');
    middleLabels.forEach((l) => {
        const x0 = Number(l.el.getAttribute("x"));
        const x1 = x0 + (ctx ? ctx.measureText(l.name).width : l.name.length * 8) + 4;
        bandLabels.forEach((v) => {
            if (v.x + v.w / 2 > x0 && v.x - v.w / 2 < x1 && Math.abs(v.y - l.y) < 14) v.el.remove();
        });
    });

    return { svg, width, height, svgString: new XMLSerializer().serializeToString(svg) };
}
