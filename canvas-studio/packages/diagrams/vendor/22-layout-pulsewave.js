function layoutPulsewave(data, options = {}) {
    const title = (data && data.title) || '';
    const slices = Array.isArray(data && data.slices) ? data.slices : [];
    const series = Array.isArray(data && data.series) ? data.series : [];
    const {
        startX = 220,
        startY = title ? 120 : 88,
        nodeWidth = 22,
        sliceGap = 170,
        rowGap = 64,
        // Широкий диапазон высот: ±15–20% видно глазом
        minNodeHeight = 18,
        maxNodeHeight = 160,
        sideLabelPad = 190,
        rightSummaryPad = 108
    } = options;

    if (!series.length || slices.length < 2) {
        return { title, slices: [], series: [], nodes: [], links: [], width: 0, height: 0 };
    }

    /**
     * Толщина внутри ряда: min ряда → minH, max ряда → maxH.
     * Так динамика читается независимо от абсолютных величин (NPS vs выручка).
     */
    function scaleInRow(v, rowMin, rowMax) {
        const span = Math.max(rowMax - rowMin, rowMax * 0.12, 1e-6);
        const t = (v - rowMin) / span;
        const eased = Math.pow(Math.max(0, Math.min(1, t)), 0.8);
        return minNodeHeight + eased * (maxNodeHeight - minNodeHeight);
    }

    const nodes = [];
    const links = [];
    const sliceLabels = [];
    let y = startY;
    let maxBottom = startY;

    const estimateLeftLabel = (name) => Math.ceil(String(name || '').length * 8.2) + 24;
    const leftNeed = Math.max(sideLabelPad, ...series.map((row) => estimateLeftLabel(row.name)));
    const shiftX = Math.max(0, leftNeed - startX);

    slices.forEach((slice, index) => {
        sliceLabels.push({
            text: slice,
            x: startX + shiftX + index * (nodeWidth + sliceGap) + nodeWidth / 2,
            y: title ? 70 : 38
        });
    });

    series.forEach((row) => {
        const rowMin = Math.min.apply(null, row.values);
        const rowMax = Math.max.apply(null, row.values);
        const rowHeights = row.values.map((v) => scaleInRow(v, rowMin, rowMax));
        const rowPeak = Math.max.apply(null, rowHeights);
        const rowTop = y;
        const rowCenter = rowTop + rowPeak / 2;
        const rowNodes = [];

        row.values.forEach((value, index) => {
            const height = rowHeights[index];
            const x = startX + shiftX + index * (nodeWidth + sliceGap);
            const nodeY = rowCenter - height / 2;
            const node = {
                id: row.name + '\0' + index,
                seriesName: row.name,
                slice: slices[index] || ('Срез ' + (index + 1)),
                value,
                x,
                y: nodeY,
                width: nodeWidth,
                height,
                centerY: rowCenter,
                rowTop,
                line: row.line || null,
                sourceLine: row.line || null
            };
            rowNodes.push(node);
            nodes.push(node);
        });

        for (let i = 0; i < rowNodes.length - 1; i++) {
            const source = rowNodes[i];
            const target = rowNodes[i + 1];
            links.push({
                source: source.id,
                target: target.id,
                seriesName: row.name,
                fromSlice: source.slice,
                toSlice: target.slice,
                fromValue: source.value,
                toValue: target.value,
                x1: source.x + source.width,
                y1: source.centerY,
                x2: target.x,
                y2: target.centerY,
                thickness: source.height,
                targetThickness: target.height,
                line: row.line || null,
                sourceLine: row.line || null
            });
        }

        y += rowPeak + rowGap;
        maxBottom = Math.max(maxBottom, rowTop + rowPeak);
    });

    const chartRight = startX + shiftX + (slices.length - 1) * (nodeWidth + sliceGap) + nodeWidth;
    const totalWidth = chartRight + rightSummaryPad + 24;
    const totalHeight = maxBottom + startY * 0.85;

    return {
        title,
        slices,
        series,
        nodes,
        links,
        sliceLabels,
        width: totalWidth,
        height: totalHeight,
        nodeWidth
    };
}
