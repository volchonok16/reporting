/**
 * Компоновка водопада — столбцы + мостики; поддержка нескольких серий (план/факт).
 */
function layoutWaterfall(data, options = {}) {
    if (!data) {
        return { steps: [], seriesLayouts: [], width: 0, height: 0, title: '' };
    }

    const seriesList = (data.series && data.series.length)
        ? data.series
        : (data.steps && data.steps.length ? [{ name: 'основной', steps: data.steps }] : []);

    if (!seriesList.length) {
        return { steps: [], seriesLayouts: [], width: 0, height: 0, title: '' };
    }

    const width = options.width || 920;
    const padL = 64;
    const padR = 28;
    const padT = data.title ? 64 : 40;
    const seriesGap = 36;
    const gap = 14;
    const valueBand = 36;

    let globalMin = 0;
    let globalMax = 0;
    seriesList.forEach((ser) => {
        (ser.steps || []).forEach((s) => {
            globalMin = Math.min(globalMin, s.base, s.top);
            globalMax = Math.max(globalMax, s.base, s.top);
        });
    });
    if (globalMin === globalMax) globalMax = globalMin + 1;
    const span = globalMax - globalMin;

    const maxN = Math.max(...seriesList.map((s) => (s.steps || []).length), 1);
    const innerW = Math.max(120, width - padL - padR);
    const barW = Math.min(88, Math.max(22, (innerW - gap * (maxN - 1)) / maxN));
    const tiltLabels = barW < 42 || maxN >= 10;
    const nameBand = tiltLabels ? 78 : 72;
    const plotH = options.plotH || Math.max(140, Math.min(280, 420 / Math.max(1, seriesList.length)));

    const yAtLocal = (v, top) => top + ((globalMax - v) / span) * plotH;

    let cursorY = padT;
    const seriesLayouts = [];

    seriesList.forEach((ser, si) => {
        const stepsRaw = ser.steps || [];
        const headerH = seriesList.length > 1 ? 22 : 0;
        const top = cursorY + headerH;
        const zeroY = yAtLocal(0, top);

        const steps = stepsRaw.map((s, i) => {
            const x = padL + i * (barW + gap);
            const y1 = yAtLocal(Math.max(s.base, s.top), top);
            const y2 = yAtLocal(Math.min(s.base, s.top), top);
            const h = Math.max(2, y2 - y1);
            return {
                ...s,
                x,
                y: y1,
                width: barW,
                height: h,
                labelX: x + barW / 2,
                zeroY,
                connectorY: yAtLocal(s.top, top),
                tiltLabels
            };
        });

        const connectors = [];
        for (let i = 0; i < steps.length - 1; i++) {
            const a = steps[i];
            const b = steps[i + 1];
            connectors.push({
                x1: a.x + a.width,
                x2: b.x,
                y: a.connectorY
            });
        }

        const chartLeft = steps.length ? steps[0].x : padL;
        const chartRight = steps.length
            ? steps[steps.length - 1].x + steps[steps.length - 1].width
            : padL + innerW;

        // метки оси
        const ticks = [];
        const nice = [];
        nice.push(0);
        if (globalMin < 0) nice.push(globalMin);
        if (globalMax > 0) nice.push(globalMax);
        const mid = (globalMin + globalMax) / 2;
        if (Math.abs(mid) > 1e-6 && nice.every((t) => Math.abs(t - mid) > span * 0.15)) {
            nice.push(mid);
        }
        nice.sort((a, b) => b - a);
        nice.forEach((v) => {
            ticks.push({ value: v, y: yAtLocal(v, top) });
        });

        seriesLayouts.push({
            name: ser.name,
            steps,
            connectors,
            zeroY,
            plotTop: top,
            plotBottom: top + plotH,
            chartLeft,
            chartRight,
            ticks,
            headerY: cursorY + (headerH ? 14 : 0)
        });

        cursorY = top + plotH + nameBand + valueBand + (si < seriesList.length - 1 ? seriesGap : 16);
    });

    const height = Math.max(options.height || 0, cursorY + 24);
    const first = seriesLayouts[0];

    return {
        title: data.title || 'Водопад',
        units: data.units || '',
        showPct: data.showPct !== false,
        seriesLayouts,
        steps: first ? first.steps : [],
        connectors: first ? first.connectors : [],
        width,
        height,
        zeroY: first ? first.zeroY : 0,
        padT,
        padL,
        plotBottom: first ? first.plotBottom : padT + plotH,
        chartLeft: first ? first.chartLeft : padL,
        chartRight: first ? first.chartRight : width - padR,
        tiltLabels,
        globalMin,
        globalMax
    };
}
