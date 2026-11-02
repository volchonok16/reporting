/**
 * SVG тепловой карты: клетки по шкале холод→тепло, оси, легенда.
 */
function generateHeatmapSVG(layoutData, themeColors) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const {
        title, colLabels, rowLabels, cells, min, max,
        originX, originY, cellW, cellH, rowLabelW,
        legendX, legendY, legendH, width, height
    } = layoutData || {};

    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', title || 'Тепловая карта');
    svg.style.fontFamily = (typeof getUiFontFamily === 'function')
        ? getUiFontFamily()
        : 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif';

    const isDark = document.body.classList.contains('dark');
    const bg = typeof readCssColor === 'function'
        ? readCssColor('--diagram-bg', isDark ? '#161618' : '#f8fafc')
        : (isDark ? '#161618' : '#f8fafc');
    const textColor = typeof readCssColor === 'function'
        ? readCssColor('--text', isDark ? '#f5f5f7' : '#0f172a')
        : (isDark ? '#f5f5f7' : '#0f172a');
    const muted = typeof readCssColor === 'function'
        ? readCssColor('--secondary-text', isDark ? '#a1a1a6' : '#64748b')
        : (isDark ? '#a1a1a6' : '#64748b');
    const emptyFill = isDark ? '#27272a' : '#e4e4e7';

    function hexToRgb(hex) {
        const h = String(hex || '').replace('#', '');
        if (h.length !== 6) return { r: 0, g: 0, b: 0 };
        return {
            r: parseInt(h.slice(0, 2), 16),
            g: parseInt(h.slice(2, 4), 16),
            b: parseInt(h.slice(4, 6), 16)
        };
    }
    function rgbToHex(r, g, b) {
        const c = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
        return '#' + c(r) + c(g) + c(b);
    }
    function lerp(a, b, t) { return a + (b - a) * t; }
    function mix(a, b, t) {
        const A = hexToRgb(a);
        const B = hexToRgb(b);
        return rgbToHex(lerp(A.r, B.r, t), lerp(A.g, B.g, t), lerp(A.b, B.b, t));
    }

    // Классическая тепловая шкала: зелёный → жёлтый → красный (как в Excel / risk heatmaps).
    // Категориальные палитры UI-тем для теплокарты не подходят — всегда используем эту.
    const stops = ['#15803d', '#22c55e', '#eab308', '#f97316', '#dc2626'];
    void themeColors;

    function heatColor(t) {
        if (t == null || !Number.isFinite(t)) return emptyFill;
        const n = Math.max(0, Math.min(1, t));
        const seg = (stops.length - 1);
        const x = n * seg;
        const i = Math.min(seg - 1, Math.floor(x));
        const f = x - i;
        return mix(stops[i], stops[i + 1], f);
    }

    function contrastText(hex) {
        const { r, g, b } = hexToRgb(hex);
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        return lum > 0.62 ? '#0f172a' : '#f8fafc';
    }

    function fmt(v) {
        if (v == null || !Number.isFinite(v)) return '—';
        if (Math.abs(v) >= 100 || Number.isInteger(v)) return String(Math.round(v));
        return (Math.round(v * 10) / 10).toString();
    }

    const bgRect = document.createElementNS(svgNS, 'rect');
    bgRect.setAttribute('x', '0');
    bgRect.setAttribute('y', '0');
    bgRect.setAttribute('width', String(width));
    bgRect.setAttribute('height', String(height));
    bgRect.setAttribute('fill', bg);
    svg.appendChild(bgRect);

    if (title) {
        const t = document.createElementNS(svgNS, 'text');
        t.setAttribute('x', '20');
        t.setAttribute('y', '28');
        t.setAttribute('fill', textColor);
        t.setAttribute('font-size', '15');
        t.setAttribute('font-weight', '650');
        t.textContent = title;
        svg.appendChild(t);
    }

    // Column labels
    (colLabels || []).forEach((lab, c) => {
        const x = originX + c * (cellW + 3) + cellW / 2;
        const y = originY - 10;
        const el = document.createElementNS(svgNS, 'text');
        el.setAttribute('x', String(x));
        el.setAttribute('y', String(y));
        el.setAttribute('text-anchor', 'middle');
        el.setAttribute('fill', muted);
        el.setAttribute('font-size', '11');
        el.setAttribute('font-weight', '600');
        const s = String(lab || '');
        el.textContent = s.length > 14 ? (s.slice(0, 12) + '…') : s;
        // rotate if many cols
        if ((colLabels || []).length > 8 || s.length > 6) {
            el.setAttribute('transform', 'rotate(-35 ' + x + ' ' + y + ')');
            el.setAttribute('text-anchor', 'end');
        }
        svg.appendChild(el);
    });

    // Row labels
    (rowLabels || []).forEach((lab, r) => {
        const el = document.createElementNS(svgNS, 'text');
        el.setAttribute('x', String(originX - 10));
        el.setAttribute('y', String(originY + r * (cellH + 3) + cellH / 2 + 4));
        el.setAttribute('text-anchor', 'end');
        el.setAttribute('fill', muted);
        el.setAttribute('font-size', '12');
        el.setAttribute('font-weight', '600');
        const s = String(lab || '');
        el.textContent = s.length > 22 ? (s.slice(0, 20) + '…') : s;
        svg.appendChild(el);
    });

    const cellsG = document.createElementNS(svgNS, 'g');
    svg.appendChild(cellsG);

    (cells || []).forEach((cell) => {
        const fill = heatColor(cell.t);
        const rect = document.createElementNS(svgNS, 'rect');
        rect.setAttribute('x', String(cell.x));
        rect.setAttribute('y', String(cell.y));
        rect.setAttribute('width', String(cell.width));
        rect.setAttribute('height', String(cell.height));
        rect.setAttribute('rx', '4');
        rect.setAttribute('fill', fill);
        const tip = document.createElementNS(svgNS, 'title');
        tip.textContent = (cell.rowLabel || '') + ' · ' + (cell.colLabel || '') + ': ' + fmt(cell.value);
        rect.appendChild(tip);
        cellsG.appendChild(rect);

        if (cell.width >= 36 && cell.height >= 26 && cell.value != null) {
            const val = document.createElementNS(svgNS, 'text');
            val.setAttribute('x', String(cell.x + cell.width / 2));
            val.setAttribute('y', String(cell.y + cell.height / 2 + 4));
            val.setAttribute('text-anchor', 'middle');
            val.setAttribute('fill', contrastText(fill));
            val.setAttribute('font-size', cell.width < 48 ? '10' : '12');
            val.setAttribute('font-weight', '650');
            val.textContent = fmt(cell.value);
            cellsG.appendChild(val);
        }
    });

    // Legend
    const lgX = legendX;
    const lgY = legendY;
    const lgH = legendH || 120;
    const lgW = 14;
    const defs = document.createElementNS(svgNS, 'defs');
    const grad = document.createElementNS(svgNS, 'linearGradient');
    const gid = 'hmGrad' + Math.floor(Math.random() * 1e6);
    grad.setAttribute('id', gid);
    grad.setAttribute('x1', '0');
    grad.setAttribute('y1', '1');
    grad.setAttribute('x2', '0');
    grad.setAttribute('y2', '0');
    stops.forEach((hex, i) => {
        const stop = document.createElementNS(svgNS, 'stop');
        stop.setAttribute('offset', String((i / (stops.length - 1)) * 100) + '%');
        stop.setAttribute('stop-color', hex);
        grad.appendChild(stop);
    });
    defs.appendChild(grad);
    svg.appendChild(defs);

    const lgRect = document.createElementNS(svgNS, 'rect');
    lgRect.setAttribute('x', String(lgX));
    lgRect.setAttribute('y', String(lgY));
    lgRect.setAttribute('width', String(lgW));
    lgRect.setAttribute('height', String(lgH));
    lgRect.setAttribute('rx', '3');
    lgRect.setAttribute('fill', 'url(#' + gid + ')');
    svg.appendChild(lgRect);

    const maxLab = document.createElementNS(svgNS, 'text');
    maxLab.setAttribute('x', String(lgX + lgW + 6));
    maxLab.setAttribute('y', String(lgY + 10));
    maxLab.setAttribute('fill', muted);
    maxLab.setAttribute('font-size', '11');
    maxLab.textContent = fmt(max);
    svg.appendChild(maxLab);

    const minLab = document.createElementNS(svgNS, 'text');
    minLab.setAttribute('x', String(lgX + lgW + 6));
    minLab.setAttribute('y', String(lgY + lgH));
    minLab.setAttribute('fill', muted);
    minLab.setAttribute('font-size', '11');
    minLab.textContent = fmt(min);
    svg.appendChild(minLab);

    void rowLabelW;
    return { svg, width, height };
}
