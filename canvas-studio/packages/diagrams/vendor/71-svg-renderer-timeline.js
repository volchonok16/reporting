/**
 * SVG таймлайна: горизонтальная или вертикальная ось; alternate — зигзаг.
 */
function generateTimelineSVG(layoutData, themeColors) {
    const tracks = (layoutData.tracks && layoutData.tracks.length)
        ? layoutData.tracks
        : [{
            title: layoutData.title || '',
            titleY: 28,
            sections: layoutData.sections || [],
            axisY: layoutData.axisY || 70,
            axisX: layoutData.axisX,
            axisOrientation: layoutData.direction === 'tb' ? 'tb' : 'lr',
            hasSectionLabels: layoutData.hasSectionLabels
        }];
    const width = layoutData.width || 400;
    const height = layoutData.height || 240;
    const ariaTitle = layoutData.title || (tracks[0] && tracks[0].title) || 'Таймлайн';
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', ariaTitle);
    svg.style.fontFamily = (typeof getUiFontFamily === 'function')
        ? getUiFontFamily()
        : 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif';

    const isDark = document.body.classList.contains('dark');
    const bg = typeof readCssColor === 'function'
        ? readCssColor('--diagram-bg', isDark ? '#161618' : '#f8fafc')
        : (isDark ? '#161618' : '#f8fafc');
    const ink = isDark ? '#e2e8f0' : '#0f172a';
    const muted = isDark ? '#94a3b8' : '#64748b';
    const axis = isDark ? '#475569' : '#cbd5e1';
    const palette = (themeColors && themeColors.length)
        ? themeColors
        : ['#3b82f6', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ec4899'];

    function el(name, attrs) {
        const n = document.createElementNS(svgNS, name);
        Object.keys(attrs || {}).forEach((k) => n.setAttribute(k, String(attrs[k])));
        return n;
    }

    svg.appendChild(el('rect', { x: 0, y: 0, width: width, height: height, fill: bg }));

    let colorIdx = 0;
    tracks.forEach((track) => {
        const sections = track.sections || [];
        const orient = track.axisOrientation || (layoutData.direction === 'tb' ? 'tb' : 'lr');

        if (track.title) {
            const titleEl = el('text', {
                x: width / 2,
                y: track.titleY != null ? track.titleY : 28,
                fill: ink,
                'font-size': tracks.length > 1 ? 15 : 16,
                'font-weight': 700,
                'text-anchor': 'middle'
            });
            titleEl.textContent = track.title;
            svg.appendChild(titleEl);
        }

        if (orient === 'tb') {
            const axisX = track.axisX != null ? track.axisX : 160;
            const periods = sections.flatMap((s) => s.periods || []);
            if (periods.length) {
                const y1 = periods[0].cy != null ? periods[0].cy : periods[0].y;
                const last = periods[periods.length - 1];
                const y2 = last.cy != null ? last.cy : (last.y + last.height / 2);
                svg.appendChild(el('line', {
                    x1: axisX, y1, x2: axisX, y2, stroke: axis, 'stroke-width': 3, 'stroke-linecap': 'round'
                }));
            }

            sections.forEach((sec) => {
                if (sec.name) {
                    const lab = el('text', {
                        x: axisX + 12,
                        y: sec.labelY != null ? sec.labelY : ((sec.periods[0] && sec.periods[0].y) || 40) - 8,
                        fill: muted,
                        'font-size': 12,
                        'font-weight': 700
                    });
                    lab.textContent = sec.name;
                    svg.appendChild(lab);
                }

                (sec.periods || []).forEach((p) => {
                    const fill = palette[colorIdx % palette.length];
                    colorIdx += 1;
                    const cy = p.cy != null ? p.cy : (p.y + p.height / 2);
                    const side = p.side != null ? p.side : 1;
                    const cxCard = p.x + p.width / 2;

                    svg.appendChild(el('circle', {
                        cx: axisX, cy, r: 6, fill, stroke: bg, 'stroke-width': 2
                    }));
                    const stubX = side > 0 ? (p.x - 2) : (p.x + p.width + 2);
                    svg.appendChild(el('line', {
                        x1: axisX + (side > 0 ? 6 : -6), y1: cy,
                        x2: stubX, y2: cy,
                        stroke: fill, 'stroke-width': 2
                    }));

                    const cardV = el('rect', {
                        x: p.x, y: p.y, width: p.width, height: p.height,
                        rx: 10, ry: 10,
                        fill: isDark ? '#1e293b' : '#ffffff',
                        stroke: fill,
                        'stroke-width': 1.75
                    });
                    if (typeof setDiagramSourceLine === 'function') {
                        setDiagramSourceLine(cardV, p.line || p.sourceLine);
                    }
                    svg.appendChild(cardV);

                    let ty = p.y + 18;
                    (p.periodLines || [p.period]).forEach((line) => {
                        const t = el('text', {
                            x: cxCard, y: ty, fill: ink, 'font-size': 13, 'font-weight': 700,
                            'text-anchor': 'middle'
                        });
                        t.textContent = line;
                        t.setAttribute('data-label', p.period);
                        svg.appendChild(t);
                        ty += 16;
                    });
                    ty += 4;
                    (p.events || []).forEach((ev) => {
                        (ev.lines || [ev.text]).forEach((line) => {
                            const t = el('text', {
                                x: cxCard, y: ty, fill: muted, 'font-size': 12, 'font-weight': 500,
                                'text-anchor': 'middle'
                            });
                            t.textContent = line;
                            t.setAttribute('data-label', ev.text || line);
                            svg.appendChild(t);
                            ty += 15;
                        });
                        ty += 6;
                    });
                });
            });
            return;
        }

        // —— горизонтальная ось ——
        const axisY = track.axisY || 70;
        const first = sections[0] && sections[0].periods[0];
        const lastSec = sections[sections.length - 1];
        const last = lastSec && lastSec.periods[lastSec.periods.length - 1];
        if (first && last) {
            const x1 = first.x + first.width / 2;
            const x2 = last.x + last.width / 2;
            svg.appendChild(el('line', {
                x1, y1: axisY, x2, y2: axisY, stroke: axis, 'stroke-width': 3, 'stroke-linecap': 'round'
            }));
        }

        sections.forEach((sec) => {
            if (sec.name) {
                const lab = el('text', {
                    x: sec.x,
                    y: axisY - 14,
                    fill: muted,
                    'font-size': 12,
                    'font-weight': 700
                });
                lab.textContent = sec.name;
                svg.appendChild(lab);
            }

            (sec.periods || []).forEach((p) => {
                const fill = palette[colorIdx % palette.length];
                colorIdx += 1;
                const cx = p.x + p.width / 2;
                const side = p.side != null ? p.side : 1; // 1 below, -1 above

                svg.appendChild(el('circle', {
                    cx, cy: axisY, r: 6, fill, stroke: bg, 'stroke-width': 2
                }));
                const stubY = side > 0 ? (p.y - 2) : (p.y + p.height + 2);
                svg.appendChild(el('line', {
                    x1: cx, y1: axisY + (side > 0 ? 6 : -6),
                    x2: cx, y2: stubY,
                    stroke: fill, 'stroke-width': 2
                }));

                const card = el('rect', {
                    x: p.x, y: p.y, width: p.width, height: p.height,
                    rx: 10, ry: 10,
                    fill: isDark ? '#1e293b' : '#ffffff',
                    stroke: fill,
                    'stroke-width': 1.75
                });
                if (typeof setDiagramSourceLine === 'function') {
                    setDiagramSourceLine(card, p.line || p.sourceLine);
                }
                svg.appendChild(card);

                let ty = p.y + 18;
                (p.periodLines || [p.period]).forEach((line) => {
                    const t = el('text', {
                        x: cx, y: ty, fill: ink, 'font-size': 13, 'font-weight': 700,
                        'text-anchor': 'middle'
                    });
                    t.textContent = line;
                    t.setAttribute('data-label', p.period);
                    svg.appendChild(t);
                    ty += 16;
                });

                ty += 4;
                (p.events || []).forEach((ev) => {
                    (ev.lines || [ev.text]).forEach((line) => {
                        const t = el('text', {
                            x: cx, y: ty, fill: muted, 'font-size': 12, 'font-weight': 500,
                            'text-anchor': 'middle'
                        });
                        t.textContent = line;
                        t.setAttribute('data-label', ev.text || line);
                        svg.appendChild(t);
                        ty += 15;
                    });
                    ty += 6;
                });
            });
        });
    });

    return { svg, width, height, svgString: new XMLSerializer().serializeToString(svg) };
}
