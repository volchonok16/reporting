/**
 * Раскладка пути пользователя: колонки = этапы.
 */
function layoutJourney(data) {
    if (!data || !data.stages || !data.stages.length) {
        return { stages: [], width: 0, height: 0, title: '', rows: [] };
    }

    const fontFam = (typeof getUiFontFamily === 'function')
        ? getUiFontFamily()
        : 'system-ui, sans-serif';
    const colW = 196;
    const gap = 18;
    const pad = 28;
    const titleH = 56; // место под заголовок + легенду настроения
    const headerH = 44;
    const emotionH = 72; // подпись «Настроение» + кружки + подпись N/5 отдельной строкой
    const rowGap = 10;

    const rows = [
        { key: 'touch', label: 'Касание' },
        { key: 'thought', label: 'Мысль' },
        { key: 'pain', label: 'Боль' }
    ];

    function wrap(text, maxW, fs) {
        return (typeof wrapTextLines === 'function')
            ? wrapTextLines(String(text || ''), maxW, fs, fontFam)
            : [String(text || '')];
    }

    const stages = data.stages.map((s, index) => {
        const nameLines = wrap(s.name, colW - 20, 12).slice(0, 2);
        const touchLines = wrap(s.touch || '—', colW - 20, 11).slice(0, 4);
        const thoughtLines = wrap(s.thought || '—', colW - 20, 11).slice(0, 4);
        const painLines = wrap(s.pain || '—', colW - 20, 11).slice(0, 4);
        return {
            index,
            name: s.name,
            nameLines,
            touch: s.touch || '',
            thought: s.thought || '',
            pain: s.pain || '',
            emotion: s.emotion,
            line: s.line,
            touchLines,
            thoughtLines,
            painLines,
            x: pad + index * (colW + gap),
            width: colW
        };
    });

    function rowHeight(key) {
        let max = 40;
        stages.forEach((s) => {
            const lines = key === 'touch' ? s.touchLines
                : (key === 'thought' ? s.thoughtLines : s.painLines);
            const h = 28 + lines.length * 14;
            if (h > max) max = h;
        });
        return max;
    }

    const rowHs = {
        touch: rowHeight('touch'),
        thought: rowHeight('thought'),
        pain: rowHeight('pain')
    };

    let y = titleH + pad + headerH + emotionH + 12;
    const rowY = {};
    rows.forEach((r) => {
        rowY[r.key] = y;
        y += rowHs[r.key] + rowGap;
    });

    stages.forEach((s) => {
        s.headerY = titleH + pad;
        s.emotionY = titleH + pad + headerH;
        s.rowY = rowY;
        s.rowH = rowHs;
    });

    const width = pad * 2 + stages.length * colW + Math.max(0, stages.length - 1) * gap;
    const height = y + pad;

    return {
        title: data.title || '',
        stages,
        rows,
        rowY,
        rowHs,
        width: Math.max(360, width),
        height: Math.max(280, height),
        pad,
        titleH,
        headerH,
        emotionH,
        colW
    };
}
