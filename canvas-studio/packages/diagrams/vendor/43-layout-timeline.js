/**
 * Компоновка таймлайна.
 * direction: lr — горизонтальная ось; tb — вертикальная.
 * alternate: карточки по разные стороны оси.
 */
function layoutTimeline(data, options) {
    options = options || {};
    const tracksIn = (data && data.tracks && data.tracks.length)
        ? data.tracks
        : (data && data.sections && data.sections.length
            ? [{ title: data.title || '', sections: data.sections }]
            : []);
    if (!tracksIn.length) {
        return {
            tracks: [], sections: [], width: 0, height: 0, title: '',
            direction: 'lr', alternate: false
        };
    }

    const direction = (options.direction || data.direction || 'lr') === 'tb' ? 'tb' : 'lr';
    const alternate = !!(options.alternate != null ? options.alternate : data.alternate);

    const fontFam = (typeof getUiFontFamily === 'function')
        ? getUiFontFamily()
        : 'system-ui, sans-serif';
    const padL = 36;
    const padR = 36;
    const topTitleGap = 36;
    const rowGap = 48;
    const periodGap = 28;
    const cardMinW = 120;
    const cardMaxW = 180;
    const cardGapFromAxis = 14;

    function measure(str, size, weight) {
        const s = String(str || '');
        if (typeof document !== 'undefined') {
            const c = layoutTimeline._c || (layoutTimeline._c = document.createElement('canvas'));
            const ctx = c.getContext('2d');
            ctx.font = (weight || '600') + ' ' + size + 'px ' + fontFam;
            return ctx.measureText(s).width;
        }
        return s.length * size * 0.55;
    }

    function enrichPeriod(p) {
        const events = (p.events || []).map((ev) => {
            const lines = (typeof wrapTextLines === 'function')
                ? wrapTextLines(ev, cardMaxW - 16, 12, fontFam)
                : [ev];
            return { text: ev, lines };
        });
        const periodLines = (typeof wrapTextLines === 'function')
            ? wrapTextLines(p.period, cardMaxW - 16, 13, fontFam)
            : [p.period];
        const contentW = Math.max(
            measure(p.period, 13, '700'),
            ...events.flatMap((e) => e.lines.map((l) => measure(l, 12, '500'))),
            60
        );
        const width = Math.min(cardMaxW, Math.max(cardMinW, contentW + 20));
        const eventsH = events.reduce((h, e) => h + e.lines.length * 15 + 8, 0);
        return {
            period: p.period,
            periodLines,
            events,
            width,
            height: 28 + periodLines.length * 16 + eventsH,
            line: p.line
        };
    }

    function layoutOneTrackHorizontal(track, originY, alt) {
        const title = track.title || '';
        const titleBand = title ? 28 : 0;
        const padT = originY + titleBand;

        const sections = (track.sections || []).map((sec) => ({
            name: sec.name || '',
            periods: (sec.periods || []).map(enrichPeriod)
        }));

        let x = padL;
        let maxCardH = 0;
        let maxAbove = 0;
        const hasSectionLabels = sections.some((s) => s.name);
        const sectionBand = hasSectionLabels ? 28 : 0;
        const axisY = padT + sectionBand + 18;
        let globalIdx = 0;

        sections.forEach((sec) => {
            sec.x = x;
            sec.periods.forEach((p) => {
                const side = alt ? ((globalIdx % 2 === 0) ? 1 : -1) : 1;
                p.side = side;
                p.x = x;
                if (side > 0) {
                    p.y = axisY + cardGapFromAxis + 6;
                    maxCardH = Math.max(maxCardH, p.height);
                } else {
                    p.y = axisY - cardGapFromAxis - 6 - p.height;
                    maxAbove = Math.max(maxAbove, p.height);
                }
                x += p.width + periodGap;
                globalIdx += 1;
            });
            sec.width = sec.periods.length
                ? (sec.periods[sec.periods.length - 1].x + sec.periods[sec.periods.length - 1].width - sec.x)
                : 0;
        });

        let shift = 0;
        if (maxAbove > 0) {
            shift = maxAbove + cardGapFromAxis;
            sections.forEach((sec) => {
                sec.periods.forEach((p) => { p.y += shift; });
            });
        }
        const axisYFinal = axisY + shift;
        const width = Math.max(360, x - periodGap + padR);
        const bottomBelow = axisYFinal + cardGapFromAxis + 6 + maxCardH + 24;
        const bottom = Math.max(bottomBelow, originY + titleBand + sectionBand + 40);
        return {
            title,
            titleY: originY + 18,
            sections,
            axisY: axisYFinal,
            axisOrientation: 'lr',
            direction: 'lr',
            alternate: !!alt,
            width,
            height: bottom - originY,
            bottom,
            hasSectionLabels
        };
    }

    function layoutOneTrackVertical(track, originY, alt) {
        const title = track.title || '';
        const titleBand = title ? 32 : 0;
        const sections = (track.sections || []).map((sec) => ({
            name: sec.name || '',
            periods: (sec.periods || []).map(enrichPeriod)
        }));

        const hasSectionLabels = sections.some((s) => s.name);
        const axisX = alt ? 280 : 160;
        let y = originY + titleBand + 12;
        let globalIdx = 0;
        let maxRight = axisX;
        let minLeft = axisX;

        sections.forEach((sec) => {
            if (sec.name) {
                sec.labelY = y + 4;
                sec.axisX = axisX;
                y += 22;
            }
            sec.periods.forEach((p) => {
                const side = alt ? ((globalIdx % 2 === 0) ? 1 : -1) : 1;
                p.side = side;
                p.cy = y + p.height / 2;
                if (side > 0) {
                    p.x = axisX + cardGapFromAxis + 8;
                    p.y = y;
                    maxRight = Math.max(maxRight, p.x + p.width);
                } else {
                    p.x = axisX - cardGapFromAxis - 8 - p.width;
                    p.y = y;
                    minLeft = Math.min(minLeft, p.x);
                }
                y += p.height + periodGap;
                globalIdx += 1;
            });
        });

        let shiftX = 0;
        if (minLeft < padL) {
            shiftX = padL - minLeft;
        }
        const axisXFinal = axisX + shiftX;
        sections.forEach((sec) => {
            sec.axisX = axisXFinal;
            sec.periods.forEach((p) => { p.x += shiftX; });
        });

        const width = Math.max(360, maxRight + shiftX + padR);
        const bottom = y + 16;
        return {
            title,
            titleY: originY + 18,
            sections,
            axisX: axisXFinal,
            axisOrientation: 'tb',
            direction: 'tb',
            alternate: !!alt,
            width,
            height: bottom - originY,
            bottom,
            hasSectionLabels
        };
    }

    let y = topTitleGap;
    let maxW = 360;
    const tracks = [];
    tracksIn.forEach((tr, i) => {
        if (i > 0) y += rowGap;
        const trackDir = (tr.direction || direction) === 'tb' ? 'tb' : 'lr';
        const trackAlt = tr.alternate != null ? !!tr.alternate : alternate;
        const laid = trackDir === 'tb'
            ? layoutOneTrackVertical(tr, y, trackAlt)
            : layoutOneTrackHorizontal(tr, y, trackAlt);
        tracks.push(laid);
        maxW = Math.max(maxW, laid.width);
        y = laid.bottom;
    });

    const height = y + 16;
    const first = tracks[0];
    return {
        title: first.title || data.title || '',
        sections: first.sections,
        axisY: first.axisY,
        axisX: first.axisX,
        hasSectionLabels: first.hasSectionLabels,
        tracks,
        direction: first.direction || direction,
        alternate: !!first.alternate,
        width: Math.ceil(maxW),
        height: Math.ceil(height)
    };
}
