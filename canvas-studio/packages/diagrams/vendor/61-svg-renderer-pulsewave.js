/**
 * Рендерер «Динамика волны».
 * Лента меняет толщину; дельты на сегментах и итог по ряду.
 */
function generatePulsewaveSVG(layoutData, themeColors) {
    const { nodes, links, width, height, title, sliceLabels } = layoutData;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.style.fontFamily = (typeof getUiFontFamily === 'function' ? getUiFontFamily() : 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif');
    svg.style.fontSize = '19px';

    const isDark = document.body.classList.contains('dark');
    const theme = themeColors || [];
    const defaultColor = isDark ? '#60a5fa' : '#3b82f6';
    const labelColor = isDark ? '#e5e7eb' : '#1f2937';
    const valueColor = isDark ? '#f8fafc' : '#111827';
    const helperColor = isDark ? '#94a3b8' : '#64748b';
    const guideColor = isDark ? '#1e293b' : '#e2e8f0';
    const upColor = isDark ? '#4ade80' : '#16a34a';
    const downColor = isDark ? '#f87171' : '#dc2626';

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

    function fmtNum(n) {
        const v = Math.round(n * 100) / 100;
        return String(v).replace('.', ',');
    }

    function fmtDelta(from, to) {
        const d = to - from;
        const pct = from !== 0 ? (d / from) * 100 : 0;
        const sign = d > 0 ? '+' : '';
        return { d, pct, text: sign + fmtNum(d), pctText: sign + fmtNum(Math.round(pct * 10) / 10) + '%' };
    }

    const defs = document.createElementNS(svgNS, 'defs');
    svg.appendChild(defs);

    if (title) {
        const titleEl = document.createElementNS(svgNS, 'text');
        titleEl.setAttribute('x', width / 2);
        titleEl.setAttribute('y', 40);
        titleEl.setAttribute('fill', labelColor);
        titleEl.setAttribute('text-anchor', 'middle');
        titleEl.setAttribute('font-weight', '700');
        titleEl.setAttribute('font-size', '24px');
        titleEl.textContent = title;
        svg.appendChild(titleEl);
    }

    const guides = document.createElementNS(svgNS, 'g');
    const linkGroup = document.createElementNS(svgNS, 'g');
    const nodeGroup = document.createElementNS(svgNS, 'g');
    const labelGroup = document.createElementNS(svgNS, 'g');
    svg.appendChild(guides);
    svg.appendChild(linkGroup);
    svg.appendChild(nodeGroup);
    svg.appendChild(labelGroup);

    const colorBySeries = new Map();
    nodes.forEach((node) => {
        if (!colorBySeries.has(node.seriesName)) {
            const i = colorBySeries.size;
            colorBySeries.set(node.seriesName, theme.length ? theme[i % theme.length] : defaultColor);
        }
    });

    const slicesRendered = new Set();
    (sliceLabels || []).forEach((slice) => {
        if (slicesRendered.has(slice.text)) return;
        slicesRendered.add(slice.text);

        const guide = document.createElementNS(svgNS, 'line');
        guide.setAttribute('x1', slice.x);
        guide.setAttribute('x2', slice.x);
        guide.setAttribute('y1', slice.y + 16);
        guide.setAttribute('y2', height - 28);
        guide.setAttribute('stroke', guideColor);
        guide.setAttribute('stroke-width', '1');
        guide.setAttribute('stroke-dasharray', '4 6');
        guide.setAttribute('opacity', '0.9');
        guides.appendChild(guide);

        const text = document.createElementNS(svgNS, 'text');
        text.setAttribute('x', slice.x);
        text.setAttribute('y', slice.y);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('fill', helperColor);
        text.setAttribute('font-size', '18px');
        text.setAttribute('font-weight', '700');
        text.textContent = slice.text;
        labelGroup.appendChild(text);
    });

    links.forEach((link, idx) => {
        const color = colorBySeries.get(link.seriesName) || defaultColor;
        const x0 = link.x1;
        const x1 = link.x2;
        const y0 = link.y1;
        const y1 = link.y2;
        const t0 = Math.max(2, link.thickness || 10) / 2;
        const t1 = Math.max(2, link.targetThickness || 10) / 2;
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

        const gradId = `pulsewave-grad-${idx}`;
        const grad = document.createElementNS(svgNS, 'linearGradient');
        grad.setAttribute('id', gradId);
        grad.setAttribute('x1', String(x0));
        grad.setAttribute('y1', '0');
        grad.setAttribute('x2', String(x1));
        grad.setAttribute('y2', '0');
        grad.setAttribute('gradientUnits', 'userSpaceOnUse');
        const s1 = document.createElementNS(svgNS, 'stop');
        s1.setAttribute('offset', '0%');
        s1.setAttribute('stop-color', softHex(color, isDark ? '#0f172a' : '#ffffff', 0.08));
        s1.setAttribute('stop-opacity', '0.78');
        const s2 = document.createElementNS(svgNS, 'stop');
        s2.setAttribute('offset', '100%');
        s2.setAttribute('stop-color', softHex(color, isDark ? '#0f172a' : '#ffffff', 0.18));
        s2.setAttribute('stop-opacity', '0.9');
        grad.appendChild(s1);
        grad.appendChild(s2);
        defs.appendChild(grad);

        const path = document.createElementNS(svgNS, 'path');
        path.setAttribute('d', d);
        path.setAttribute('fill', `url(#${gradId})`);
        path.setAttribute('stroke', 'none');
        if (typeof setDiagramSourceLine === 'function') {
            setDiagramSourceLine(path, link.line || link.sourceLine);
        }
        linkGroup.appendChild(path);
    });

    const bySeries = new Map();
    nodes.forEach((node) => {
        if (!bySeries.has(node.seriesName)) bySeries.set(node.seriesName, []);
        bySeries.get(node.seriesName).push(node);
    });
    bySeries.forEach((rowNodes) => {
        rowNodes.sort((a, b) => a.x - b.x);
        const first = rowNodes[0];
        const last = rowNodes[rowNodes.length - 1];
        const total = fmtDelta(first.value, last.value);
        const totalColor = total.d >= 0 ? upColor : downColor;
        const arrow = total.d >= 0 ? '▲' : '▼';

        const summary = document.createElementNS(svgNS, 'text');
        summary.setAttribute('x', last.x + last.width + 14);
        summary.setAttribute('y', last.centerY + 2);
        summary.setAttribute('fill', totalColor);
        summary.setAttribute('font-size', '22px');
        summary.setAttribute('font-weight', '700');
        summary.textContent = `${arrow} ${total.pctText}`;
        labelGroup.appendChild(summary);

        const abs = document.createElementNS(svgNS, 'text');
        abs.setAttribute('x', last.x + last.width + 14);
        abs.setAttribute('y', last.centerY + 26);
        abs.setAttribute('fill', helperColor);
        abs.setAttribute('font-size', '18px');
        abs.setAttribute('font-weight', '600');
        abs.textContent = `(${total.text})`;
        labelGroup.appendChild(abs);
    });

    links.forEach((link) => {
        const delta = fmtDelta(link.fromValue, link.toValue);
        const deltaColor = delta.d >= 0 ? upColor : (delta.d < 0 ? downColor : helperColor);
        const midX = (link.x1 + link.x2) / 2;
        const band = Math.max(link.thickness || 0, link.targetThickness || 0);
        const midY = (link.y1 + link.y2) / 2 - band / 2 - 14;

        const pillW = 68;
        const pillH = 26;
        const pill = document.createElementNS(svgNS, 'rect');
        pill.setAttribute('x', midX - pillW / 2);
        pill.setAttribute('y', midY - pillH / 2);
        pill.setAttribute('width', pillW);
        pill.setAttribute('height', pillH);
        pill.setAttribute('rx', '13');
        pill.setAttribute('fill', isDark ? '#0b1220' : '#ffffff');
        pill.setAttribute('stroke', deltaColor);
        pill.setAttribute('stroke-width', '1');
        pill.setAttribute('opacity', '0.94');
        labelGroup.appendChild(pill);

        const dt = document.createElementNS(svgNS, 'text');
        dt.setAttribute('x', midX);
        dt.setAttribute('y', midY + 6);
        dt.setAttribute('text-anchor', 'middle');
        dt.setAttribute('fill', deltaColor);
        dt.setAttribute('font-size', '17px');
        dt.setAttribute('font-weight', '700');
        dt.textContent = delta.pctText;
        labelGroup.appendChild(dt);
    });

    nodes.forEach((node, index) => {
        const color = colorBySeries.get(node.seriesName) || defaultColor;
        const rowNodes = bySeries.get(node.seriesName) || [];
        const isMax = rowNodes.length && node.value === Math.max.apply(null, rowNodes.map((n) => n.value));
        const isMin = rowNodes.length > 1 && node.value === Math.min.apply(null, rowNodes.map((n) => n.value));

        const rect = document.createElementNS(svgNS, 'rect');
        rect.setAttribute('x', node.x);
        rect.setAttribute('y', node.y);
        rect.setAttribute('width', node.width);
        rect.setAttribute('height', node.height);
        rect.setAttribute('fill', color);
        rect.setAttribute('rx', '3');
        if (typeof setDiagramSourceLine === 'function') {
            setDiagramSourceLine(rect, node.sourceLine || node.line);
        }
        if (isMax) {
            rect.setAttribute('stroke', upColor);
            rect.setAttribute('stroke-width', '2');
        } else if (isMin) {
            rect.setAttribute('stroke', downColor);
            rect.setAttribute('stroke-width', '2');
            rect.setAttribute('stroke-dasharray', '3 2');
        }
        nodeGroup.appendChild(rect);

        const val = document.createElementNS(svgNS, 'text');
        val.setAttribute('x', node.x + node.width / 2);
        val.setAttribute('y', node.y - 12);
        val.setAttribute('text-anchor', 'middle');
        val.setAttribute('fill', valueColor);
        val.setAttribute('font-size', '18px');
        val.setAttribute('font-weight', '700');
        val.textContent = fmtNum(node.value);
        labelGroup.appendChild(val);

        if (index === 0 || nodes[index - 1].seriesName !== node.seriesName) {
            const label = document.createElementNS(svgNS, 'text');
            label.setAttribute('x', node.x - 14);
            label.setAttribute('y', node.centerY + 6);
            label.setAttribute('text-anchor', 'end');
            label.setAttribute('fill', labelColor);
            label.setAttribute('font-size', '19px');
            label.setAttribute('font-weight', '600');
            label.textContent = node.seriesName;
            label.setAttribute('data-label', node.seriesName);
            labelGroup.appendChild(label);
        }
    });

    return { svg, width, height, svgString: new XMLSerializer().serializeToString(svg) };
}
