/**
 * Раскладка тепловой карты: сетка клеток + оси + легенда.
 */
function layoutHeatmap(data, options) {
    options = options || {};
    if (!data || !data.matrix || !data.matrix.length) {
        return { cells: [], width: 0, height: 0, title: '', colLabels: [], rowLabels: [], min: 0, max: 1 };
    }

    const colLabels = (data.colLabels || []).slice();
    const rowLabels = (data.rowLabels || []).slice();
    const matrix = data.matrix;
    const cols = Math.max(colLabels.length, ...matrix.map((r) => r.length), 1);
    const rows = matrix.length;

    let min = data.min;
    let max = data.max;
    if (min == null || max == null || !Number.isFinite(min) || !Number.isFinite(max)) {
        min = Infinity;
        max = -Infinity;
        matrix.forEach((row) => {
            row.forEach((v) => {
                if (v == null || !Number.isFinite(v)) return;
                if (v < min) min = v;
                if (v > max) max = v;
            });
        });
        if (!Number.isFinite(min)) { min = 0; max = 1; }
        if (min === max) max = min + 1;
    }

    const pad = options.pad != null ? options.pad : 28;
    const titleH = data.title ? 44 : 16;
    const legendW = 56;
    const gap = 3;

    // Estimate label widths
    function textW(s, fs) {
        return Math.min(220, Math.max(24, String(s || '').length * (fs * 0.58)));
    }
    const rowLabelW = Math.max(
        48,
        ...rowLabels.map((l) => textW(l, 12))
    );
    const colLabelH = 52;

    const availW = options.width || Math.min(1100, Math.max(420, 56 * cols + rowLabelW + legendW + pad * 2));
    const gridW = Math.max(120, availW - pad * 2 - rowLabelW - legendW - 12);
    const cellW = Math.max(28, Math.floor((gridW - gap * Math.max(0, cols - 1)) / cols));
    const cellH = Math.max(28, Math.min(56, cellW));

    const gridH = rows * cellH + gap * Math.max(0, rows - 1);
    const originX = pad + rowLabelW + 8;
    const originY = titleH + pad + colLabelH;

    const cells = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const v = matrix[r] && matrix[r][c] != null ? matrix[r][c] : null;
            const t = v == null ? null : (v - min) / (max - min);
            cells.push({
                r,
                c,
                value: v,
                t: t == null ? null : Math.max(0, Math.min(1, t)),
                x: originX + c * (cellW + gap),
                y: originY + r * (cellH + gap),
                width: cellW,
                height: cellH,
                rowLabel: rowLabels[r] || '',
                colLabel: colLabels[c] || ''
            });
        }
    }

    const width = originX + cols * cellW + gap * Math.max(0, cols - 1) + legendW + pad;
    const height = originY + gridH + pad + 8;

    return {
        title: data.title || '',
        colLabels,
        rowLabels,
        cells,
        min,
        max,
        cellW,
        cellH,
        originX,
        originY,
        rowLabelW,
        legendX: originX + cols * cellW + gap * Math.max(0, cols - 1) + 16,
        legendY: originY,
        legendH: Math.max(80, gridH),
        width: Math.max(320, width),
        height: Math.max(220, height)
    };
}
