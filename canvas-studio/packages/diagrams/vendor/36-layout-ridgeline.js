/**
 * Компоновка хребтов данных.
 */
function layoutRidgeline(data, options = {}) {
    if (!data || !data.groups || !data.groups.length) {
        return { groups: [], width: 0, height: 0, title: '' };
    }
    const width = options.width || 760;
    const padL = 140;
    const padR = 36;
    const padT = 56;
    const padB = 56;
    const rowH = 78;
    const height = padT + data.groups.length * rowH + padB;

    let xMin = Infinity;
    let xMax = -Infinity;
    data.groups.forEach((g) => {
        g.values.forEach((v) => {
            xMin = Math.min(xMin, v);
            xMax = Math.max(xMax, v);
        });
    });
    if (!(xMax > xMin)) {
        xMin -= 1;
        xMax += 1;
    }
    const span = xMax - xMin;
    xMin -= span * 0.05;
    xMax += span * 0.05;

    return {
        title: data.title || 'Хребты данных',
        axisLabel: data.axisLabel || 'Значение',
        groups: data.groups,
        width,
        height,
        padL,
        padR,
        padT,
        padB,
        rowH,
        xMin,
        xMax,
        plotW: width - padL - padR
    };
}
