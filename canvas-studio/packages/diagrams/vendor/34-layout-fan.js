/**
 * Компоновка веера — запас сверху/снизу под заголовок и легенду.
 */
function layoutFan(data, options = {}) {
    if (!data || !data.axes || !data.axes.length || !data.series || !data.series.length) {
        return { axes: [], series: [], width: 0, height: 0, title: '' };
    }
    const width = options.width || 700;
    const height = options.height || 760;
    // Меньше полей — крупнее радар и место под подписи осей
    const padT = 78;
    const padB = 72;
    const padSide = 78;
    const labelGap = 48;
    const cx = width / 2;
    const cy = padT + (height - padT - padB) / 2;
    const maxR = Math.min(
        cx - padSide,
        (height - padT - padB) / 2 - labelGap
    );
    return {
        title: data.title || 'Веер значимости',
        axes: data.axes,
        series: data.series,
        width,
        height,
        cx,
        cy,
        maxR,
        padT,
        padB
    };
}
