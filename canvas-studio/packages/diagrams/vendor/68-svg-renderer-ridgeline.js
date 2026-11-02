/**
 * SVG «Хребты данных» — KDE-гряды распределений.
 */
function generateRidgelineSVG(layoutData, themeColors) {
    const {
        title, axisLabel, groups, width, height,
        padL, padR, padT, padB, rowH, xMin, xMax, plotW
    } = layoutData;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.style.fontFamily = (typeof getUiFontFamily === 'function'
        ? getUiFontFamily()
        : 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif');

    const isDark = document.body.classList.contains('dark');
    const bg = typeof readCssColor === 'function'
        ? readCssColor('--diagram-bg', isDark ? '#161618' : '#f8fafc')
        : (isDark ? '#161618' : '#f8fafc');
    const ink = isDark ? '#e2e8f0' : '#0f172a';
    const muted = isDark ? '#94a3b8' : '#64748b';
    const grid = isDark ? '#334155' : '#e2e8f0';
    const theme = themeColors && themeColors.length
        ? themeColors
        : (isDark
            ? ['#fb7185', '#2dd4bf', '#fbbf24', '#c4b5fd', '#60a5fa']
            : ['#e11d48', '#0d9488', '#d97706', '#7c3aed', '#2563eb']);

    function el(name, attrs) {
        const n = document.createElementNS(svgNS, name);
        Object.keys(attrs || {}).forEach((k) => n.setAttribute(k, String(attrs[k])));
        return n;
    }

    function scaleX(v) {
        return padL + ((v - xMin) / (xMax - xMin)) * plotW;
    }

    function kde(x, vals, bw) {
        let s = 0;
        for (let i = 0; i < vals.length; i++) {
            const u = (x - vals[i]) / bw;
            s += Math.exp(-0.5 * u * u);
        }
        return s / (vals.length * bw * Math.sqrt(2 * Math.PI));
    }

    function median(vals) {
        const s = vals.slice().sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)];
    }
    function quantile(vals, q) {
        const s = vals.slice().sort((a, b) => a - b);
        return s[Math.min(s.length - 1, Math.floor(s.length * q))];
    }
    function fmt(v) {
        const n = Math.round(v * 10) / 10;
        return Number.isInteger(n) ? String(n) : n.toFixed(1);
    }

    svg.appendChild(el('rect', { x: 0, y: 0, width, height, fill: bg }));

    const titleEl = el('text', {
        x: width / 2, y: 26, fill: ink, 'font-size': 16, 'font-weight': 700, 'text-anchor': 'middle'
    });
    titleEl.textContent = title || 'Хребты данных';
    svg.appendChild(titleEl);
    const sub = el('text', {
        x: width / 2, y: 44, fill: muted, 'font-size': 11, 'text-anchor': 'middle'
    });
    sub.textContent = 'Узкий пик — консенсус; широкая гора — разброс; два горба — неоднородность.';
    svg.appendChild(sub);

    const ticks = 6;
    for (let i = 0; i <= ticks; i++) {
        const v = xMin + (i / ticks) * (xMax - xMin);
        const x = scaleX(v);
        svg.appendChild(el('line', {
            x1: x, y1: padT, x2: x, y2: height - padB,
            stroke: grid, 'stroke-width': 1, opacity: 0.7
        }));
        const tx = el('text', {
            x, y: height - padB + 18,
            fill: muted, 'font-size': 10, 'text-anchor': 'middle'
        });
        tx.textContent = (Math.round(v * 10) / 10).toString();
        svg.appendChild(tx);
    }
    const axis = el('text', {
        x: padL + plotW / 2, y: height - 12,
        fill: muted, 'font-size': 11, 'font-weight': 600, 'text-anchor': 'middle'
    });
    axis.textContent = (axisLabel || 'Значение') + '  ·  пунктир = медиана, точки = Q1/Q3';
    svg.appendChild(axis);

    const maxH = rowH * 0.62;
    const bw = Math.max(0.25, (xMax - xMin) / 18);

    (groups || []).forEach((g, gi) => {
        const color = theme[gi % theme.length];
        const yBase = padT + (gi + 0.72) * rowH;
        svg.appendChild(el('line', {
            x1: padL, y1: yBase, x2: width - padR, y2: yBase,
            stroke: grid, 'stroke-width': 1, opacity: 0.8
        }));

        const steps = 100;
        let peak = 0;
        const dens = [];
        for (let s = 0; s <= steps; s++) {
            const xv = xMin + (s / steps) * (xMax - xMin);
            const d = kde(xv, g.values, bw);
            dens.push({ xv, d });
            peak = Math.max(peak, d);
        }
        const scale = peak > 0 ? maxH / peak : 1;
        const pts = dens.map((p) => ({ x: scaleX(p.xv), y: yBase - p.d * scale }));

        let dPath = `M ${pts[0].x} ${yBase}`;
        pts.forEach((p) => { dPath += ` L ${p.x} ${p.y}`; });
        dPath += ` L ${pts[pts.length - 1].x} ${yBase} Z`;

        const gradId = 'ridge-g-' + gi;
        const defs = el('defs', {});
        const grad = el('linearGradient', {
            id: gradId, x1: '0%', y1: '100%', x2: '0%', y2: '0%'
        });
        grad.appendChild(el('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': 0.55 }));
        grad.appendChild(el('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0.12 }));
        defs.appendChild(grad);
        svg.appendChild(defs);

        const ridgeFill = el('path', { d: dPath, fill: 'url(#' + gradId + ')' });
        if (typeof setDiagramSourceLine === 'function') {
            setDiagramSourceLine(ridgeFill, g.line || g.sourceLine);
        }
        svg.appendChild(ridgeFill);
        const ridgeStroke = el('path', {
            d: pts.map((p, i) => (i === 0 ? 'M' : 'L') + ' ' + p.x + ' ' + p.y).join(' '),
            fill: 'none', stroke: color, 'stroke-width': 2.1
        });
        if (typeof setDiagramSourceLine === 'function') {
            setDiagramSourceLine(ridgeStroke, g.line || g.sourceLine);
        }
        svg.appendChild(ridgeStroke);

        const med = median(g.values);
        const q1 = quantile(g.values, 0.25);
        const q3 = quantile(g.values, 0.75);
        const mx = scaleX(med);
        svg.appendChild(el('line', {
            x1: mx, y1: yBase, x2: mx, y2: yBase - maxH * 0.85,
            stroke: isDark ? '#fff' : '#0f172a',
            'stroke-width': 1.4,
            'stroke-dasharray': '4 3',
            opacity: 0.7
        }));
        const medLab = el('text', {
            x: mx, y: yBase - maxH * 0.85 - 4,
            fill: ink, 'font-size': 10, 'font-weight': 700, 'text-anchor': 'middle'
        });
        medLab.textContent = fmt(med);
        svg.appendChild(medLab);

        [{ v: q1, label: 'Q1' }, { v: q3, label: 'Q3' }].forEach((item) => {
            const qx = scaleX(item.v);
            svg.appendChild(el('circle', {
                cx: qx, cy: yBase - 3, r: 3.4,
                fill: isDark ? '#fff' : '#0f172a', opacity: 0.8
            }));
            const ql = el('text', {
                x: qx, y: yBase + 14,
                fill: muted, 'font-size': 9, 'font-weight': 600, 'text-anchor': 'middle'
            });
            ql.textContent = fmt(item.v);
            svg.appendChild(ql);
        });

        const lab = el('text', {
            x: padL - 12, y: yBase + 4,
            fill: ink, 'font-size': 12, 'font-weight': 700, 'text-anchor': 'end'
        });
        lab.textContent = g.name;
        lab.setAttribute('data-label', g.name);
        svg.appendChild(lab);
    });

    return {
        svg,
        width,
        height,
        svgString: new XMLSerializer().serializeToString(svg)
    };
}
