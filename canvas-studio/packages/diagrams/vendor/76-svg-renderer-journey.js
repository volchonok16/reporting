/**
 * SVG пути пользователя.
 * Кружки = настроение 1…5 (1 плохо → 5 хорошо), явно подписано.
 */
function generateJourneySVG(layoutData, themeColors) {
    const stages = layoutData.stages || [];
    const width = layoutData.width || 400;
    const height = layoutData.height || 300;
    const title = layoutData.title || 'Путь пользователя';
    const rows = layoutData.rows || [];
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', title);

    const isDark = document.body.classList.contains('dark');
    const bg = typeof readCssColor === 'function'
        ? readCssColor('--diagram-bg', isDark ? '#161618' : '#f8fafc')
        : (isDark ? '#161618' : '#f8fafc');
    const ink = isDark ? '#e2e8f0' : '#0f172a';
    const muted = isDark ? '#94a3b8' : '#64748b';
    const panel = isDark ? '#1e293b' : '#ffffff';
    const palette = (themeColors && themeColors.length)
        ? themeColors
        : ['#3b82f6', '#06b6d4', '#8b5cf6', '#10b981', '#f59e0b'];
    const emotionColors = ['#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e'];
    const emotionWords = ['плохо', 'слабо', 'норм.', 'хорошо', 'отлично'];

    function el(name, attrs) {
        const n = document.createElementNS(svgNS, name);
        Object.keys(attrs || {}).forEach((k) => n.setAttribute(k, String(attrs[k])));
        return n;
    }

    svg.appendChild(el('rect', { x: 0, y: 0, width: width, height: height, fill: bg }));

    const titleEl = el('text', {
        x: width / 2, y: 26, fill: ink, 'font-size': 16, 'font-weight': 700, 'text-anchor': 'middle'
    });
    titleEl.textContent = title;
    svg.appendChild(titleEl);

    const legend = el('text', {
        x: width / 2, y: 44, fill: muted, 'font-size': 11, 'text-anchor': 'middle'
    });
    legend.textContent = 'Этапы слева направо · кружки = настроение 1 (плохо) → 5 (отлично)';
    svg.appendChild(legend);

    stages.forEach((s, i) => {
        const color = palette[i % palette.length];
        const g = el('g', {});
        if (typeof setDiagramSourceLine === 'function') setDiagramSourceLine(g, s.line);

        g.appendChild(el('rect', {
            x: s.x, y: s.headerY, width: s.width, height: layoutData.headerH - 6, rx: 10,
            fill: color, stroke: 'none'
        }));
        const nameLines = s.nameLines || [s.name];
        nameLines.forEach((line, li) => {
            const t = el('text', {
                x: s.x + s.width / 2,
                y: s.headerY + 18 + li * 14,
                fill: getContrastColor(color), 'font-size': 12, 'font-weight': 700, 'text-anchor': 'middle'
            });
            t.textContent = line;
            g.appendChild(t);
        });

        // Ряд «Настроение»
        const moodY = s.emotionY + 2;
        const moodLab = el('text', {
            x: s.x + 8, y: moodY + 12, fill: muted, 'font-size': 10, 'font-weight': 700
        });
        moodLab.textContent = 'Настроение';
        g.appendChild(moodLab);

        const ey = moodY + 26;
        const dotsStartX = s.x + 14;
        const dotsGap = 22;
        for (let e = 1; e <= 5; e++) {
            const on = s.emotion != null && e <= s.emotion;
            g.appendChild(el('circle', {
                cx: dotsStartX + (e - 1) * dotsGap,
                cy: ey,
                r: 5.5,
                fill: on ? emotionColors[e - 1] : (isDark ? '#334155' : '#e2e8f0'),
                stroke: 'none'
            }));
        }
        if (s.emotion != null) {
            const word = emotionWords[s.emotion - 1] || '';
            const et = el('text', {
                x: s.x + 8, y: ey + 20,
                fill: ink, 'font-size': 11, 'font-weight': 700, 'text-anchor': 'start'
            });
            et.textContent = s.emotion + '/5 · ' + word;
            g.appendChild(et);
        } else {
            const et = el('text', {
                x: s.x + 8, y: ey + 20,
                fill: muted, 'font-size': 11, 'text-anchor': 'start'
            });
            et.textContent = 'не задано';
            g.appendChild(et);
        }

        rows.forEach((row) => {
            const ry = s.rowY[row.key];
            const rh = s.rowH[row.key];
            g.appendChild(el('rect', {
                x: s.x, y: ry, width: s.width, height: rh, rx: 8,
                fill: panel,
                stroke: isDark ? '#334155' : '#e2e8f0',
                'stroke-width': 1
            }));
            const lab = el('text', {
                x: s.x + 10, y: ry + 16,
                fill: muted, 'font-size': 10, 'font-weight': 700
            });
            lab.textContent = row.label;
            g.appendChild(lab);

            const lines = row.key === 'touch' ? s.touchLines
                : (row.key === 'thought' ? s.thoughtLines : s.painLines);
            lines.forEach((line, li) => {
                const t = el('text', {
                    x: s.x + 10, y: ry + 34 + li * 14,
                    fill: ink, 'font-size': 11
                });
                t.textContent = line;
                g.appendChild(t);
            });
        });

        if (i < stages.length - 1) {
            const mid = s.headerY + (layoutData.headerH - 6) / 2;
            svg.appendChild(el('line', {
                x1: s.x + s.width + 2,
                y1: mid,
                x2: stages[i + 1].x - 4,
                y2: mid,
                stroke: muted,
                'stroke-width': 1.5,
                'stroke-dasharray': '3,4'
            }));
        }

        svg.appendChild(g);
    });

    return { svg, width, height, svgString: new XMLSerializer().serializeToString(svg) };
}
