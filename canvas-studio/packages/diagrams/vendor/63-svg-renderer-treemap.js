/**
 * Рендерер Treemap («Плитка») — спокойные вложенные прямоугольники.
 */
function generateTreemapSVG(layoutData, themeColors) {
    const { nodes, width, height, rootName, rootValue } = layoutData;
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", rootName || "Диаграмма «Плитка»");
    svg.style.fontFamily = (typeof getUiFontFamily === "function"
        ? getUiFontFamily()
        : "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif");
    svg.style.fontSize = "13px";

    const isDark = document.body.classList.contains('dark');
    const theme = themeColors || [];
    const defaultColor = isDark ? '#64748b' : '#64748b';
    const bg = typeof readCssColor === 'function'
        ? readCssColor('--diagram-bg', isDark ? '#161618' : '#f8fafc')
        : (isDark ? '#161618' : '#f8fafc');
    const panel = typeof readCssColor === 'function'
        ? readCssColor('--panel-bg', isDark ? '#1c1c1e' : '#ffffff')
        : (isDark ? '#1c1c1e' : '#ffffff');
    const border = typeof readCssColor === 'function'
        ? readCssColor('--border', isDark ? '#3a3a3c' : '#e2e8f0')
        : (isDark ? '#3a3a3c' : '#e2e8f0');
    const textColor = typeof readCssColor === 'function'
        ? readCssColor('--text', isDark ? '#f5f5f7' : '#0f172a')
        : (isDark ? '#f5f5f7' : '#0f172a');
    const muted = typeof readCssColor === 'function'
        ? readCssColor('--secondary-text', isDark ? '#a1a1a6' : '#64748b')
        : (isDark ? '#a1a1a6' : '#64748b');
    /** Агрегирующие полосы — единый серый, без палитры (иначе рябит). */
    const headerFill = isDark ? '#3f3f46' : '#e4e4e7';

    function soft(hex, other, t) {
        return (typeof mixHex === 'function') ? mixHex(hex, other, t) : hex;
    }
    /** Приглушённый цвет клетки: тема сильно смешана с панелью */
    function tileColor(hex) {
        return soft(hex || defaultColor, panel, isDark ? 0.62 : 0.72);
    }

    const bgRect = document.createElementNS(svgNS, "rect");
    bgRect.setAttribute("x", "0");
    bgRect.setAttribute("y", "0");
    bgRect.setAttribute("width", String(width));
    bgRect.setAttribute("height", String(height));
    bgRect.setAttribute("fill", bg);
    svg.appendChild(bgRect);

    if (rootName) {
        const title = document.createElementNS(svgNS, "text");
        title.setAttribute("x", "16");
        title.setAttribute("y", "22");
        title.setAttribute("fill", textColor);
        title.setAttribute("font-size", "14px");
        title.setAttribute("font-weight", "600");
        title.textContent = rootName;
        svg.appendChild(title);

        if (rootValue != null && isFinite(rootValue)) {
            const valEl = document.createElementNS(svgNS, "text");
            valEl.setAttribute("x", "16");
            valEl.setAttribute("y", "22");
            valEl.setAttribute("dx", String(Math.min(280, 12 + String(rootName).length * 7.6)));
            valEl.setAttribute("fill", muted);
            valEl.setAttribute("font-size", "13px");
            valEl.setAttribute("font-weight", "500");
            valEl.textContent = '· ' + formatTreemapValue(rootValue);
            svg.appendChild(valEl);
        }
    }

    let leafIndex = 0;
    const tilesGroup = document.createElementNS(svgNS, "g");
    const labelsGroup = document.createElementNS(svgNS, "g");
    svg.appendChild(tilesGroup);
    svg.appendChild(labelsGroup);

    nodes.forEach((node) => {
        if (!(node.width > 1) || !(node.height > 1)) return;

        const themeHex = theme.length
            ? theme[leafIndex % theme.length]
            : defaultColor;
        if (!node.isHeader) leafIndex++;

        const fill = node.isHeader ? headerFill : tileColor(themeHex);

        const rect = document.createElementNS(svgNS, "rect");
        rect.setAttribute("x", node.x);
        rect.setAttribute("y", node.y);
        rect.setAttribute("width", node.width);
        rect.setAttribute("height", node.height);
        rect.setAttribute("rx", node.isHeader ? "3" : "4");
        rect.setAttribute("fill", fill);
        rect.setAttribute("stroke", border);
        rect.setAttribute("stroke-width", node.isHeader ? "1" : "1.25");
        if (typeof setDiagramSourceLine === 'function') {
            setDiagramSourceLine(rect, node.sourceLine || node.line);
        }
        tilesGroup.appendChild(rect);

        const minForLabel = node.isHeader ? 28 : 36;
        if (node.width < minForLabel || node.height < (node.isHeader ? 12 : 28)) return;

        const labelColor = node.isHeader
            ? muted
            : ((typeof getContrastColor === 'function') ? getContrastColor(fill) : textColor);

        if (node.isHeader) {
            let hdr = String(node.name || '');
            if (node.value != null && Number(node.value) > 0 && node.width >= 72) {
                hdr += ' · ' + formatTreemapValue(node.value);
                if (rootValue > 0 && node.width >= 110) {
                    const pct = Math.round((Number(node.value) / Number(rootValue)) * 1000) / 10;
                    hdr += ' · ' + pct + '%';
                }
            }
            const label = document.createElementNS(svgNS, "text");
            label.setAttribute("x", node.x + 10);
            label.setAttribute("y", node.y + Math.min(node.height - 4, 15));
            label.setAttribute("text-anchor", "start");
            label.setAttribute("fill", labelColor);
            label.setAttribute("font-weight", "600");
            label.setAttribute("font-size", "11px");
            label.setAttribute("data-label", node.name || '');
            label.textContent = truncateTreemapLabel(hdr, node.width - 14, 11);
            labelsGroup.appendChild(label);
            return;
        }

        const fontSize = node.width > 110 ? 12 : 11;
        const lineH = fontSize + 3;
        const valueLineH = 14;
        const padY = 6;
        const showValue = node.height >= 42 && node.width >= 52;
        const availH = node.height - padY * 2 - (showValue ? valueLineH + 4 : 0);
        const maxNameLines = Math.max(1, Math.floor(availH / lineH));
        const nameLines = fitTreemapWrappedLabel(
            node.name,
            node.width - 12,
            maxNameLines,
            fontSize
        );

        const blockH = nameLines.length * lineH + (showValue ? valueLineH + 4 : 0);
        let ty = node.y + (node.height - blockH) / 2 + fontSize;

        nameLines.forEach((line) => {
            const label = document.createElementNS(svgNS, "text");
            label.setAttribute("x", node.x + node.width / 2);
            label.setAttribute("y", ty);
            label.setAttribute("text-anchor", "middle");
            label.setAttribute("fill", labelColor);
            label.setAttribute("font-weight", "600");
            label.setAttribute("font-size", fontSize + "px");
            label.setAttribute("data-label", node.name || '');
            label.textContent = line;
            labelsGroup.appendChild(label);
            ty += lineH;
        });

        if (showValue) {
            ty += 4;
            const val = document.createElementNS(svgNS, "text");
            val.setAttribute("x", node.x + node.width / 2);
            val.setAttribute("y", ty);
            val.setAttribute("text-anchor", "middle");
            val.setAttribute("fill", labelColor);
            val.setAttribute("font-size", "11px");
            val.setAttribute("font-weight", "500");
            val.setAttribute("opacity", "0.78");
            let txt = formatTreemapValue(node.value);
            if (rootValue > 0 && node.height >= 56) {
                const pct = Math.round((Number(node.value) / Number(rootValue)) * 1000) / 10;
                txt += ' · ' + pct + '%';
            }
            val.textContent = txt;
            labelsGroup.appendChild(val);
        }
    });

    return {
        svg,
        width,
        height,
        svgString: new XMLSerializer().serializeToString(svg)
    };
}

function formatTreemapValue(v) {
    const n = Number(v);
    if (!isFinite(n)) return '';
    if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
    return (Math.round(n * 100) / 100).toLocaleString('ru-RU');
}

function truncateTreemapLabel(text, maxPx, fontSize) {
    const s = String(text || '');
    const approx = fontSize * 0.62;
    const maxChars = Math.max(3, Math.floor(maxPx / approx));
    if (s.length <= maxChars) return s;
    return s.slice(0, Math.max(1, maxChars - 1)) + '…';
}

/** Перенос по словам, если высота позволяет; иначе обрезка последней строки. */
function fitTreemapWrappedLabel(text, maxPx, maxLines, fontSize) {
    const s = String(text || '').trim();
    if (!s) return [''];
    const linesCap = Math.max(1, maxLines | 0);
    if (typeof wrapTextLines === 'function') {
        const wrapped = wrapTextLines(s, Math.max(24, maxPx), fontSize);
        if (wrapped.length <= linesCap) return wrapped;
        const kept = wrapped.slice(0, linesCap);
        kept[linesCap - 1] = truncateTreemapLabel(kept[linesCap - 1], maxPx, fontSize);
        return kept;
    }
    return [truncateTreemapLabel(s, maxPx, fontSize)];
}
