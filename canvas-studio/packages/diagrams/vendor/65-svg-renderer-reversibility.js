/**
 * SVG «Карта обратимости» — боль ошибки × цена отката; список справа.
 */
function generateReversibilitySVG(layoutData, themeColors) {
    const {
        title, nodes, links, listItems, linkNotes, listX, listY, listW,
        width, height, padL, padT, plotW, plotH
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
    const grid = isDark ? '#334155' : '#cbd5e1';
    const panel = isDark ? '#1e293b' : '#ffffff';
    const teal = isDark ? '#2dd4bf' : '#0d9488';
    const amber = isDark ? '#fbbf24' : '#d97706';
    const coral = isDark ? '#fb7185' : '#e11d48';
    const violet = isDark ? '#c4b5fd' : '#7c3aed';
    const linkCol = isDark ? '#64748b' : '#94a3b8';

    const zoneColor = {
        plateau: teal,
        ridge: amber,
        canyon: coral,
        trap: violet
    };

    function el(name, attrs) {
        const n = document.createElementNS(svgNS, name);
        Object.keys(attrs || {}).forEach((k) => n.setAttribute(k, String(attrs[k])));
        return n;
    }

    const defs = el('defs', {});
    const hatch = el('pattern', {
        id: 'rev-hatch', width: 7, height: 7, patternUnits: 'userSpaceOnUse',
        patternTransform: 'rotate(40)'
    });
    hatch.appendChild(el('line', {
        x1: 0, y1: 0, x2: 0, y2: 7,
        stroke: coral, 'stroke-width': 1.2, opacity: isDark ? 0.28 : 0.2
    }));
    defs.appendChild(hatch);

    const marker = el('marker', {
        id: 'rev-arrow', markerWidth: 7, markerHeight: 7,
        refX: 5, refY: 2.5, orient: 'auto', markerUnits: 'strokeWidth'
    });
    marker.appendChild(el('path', { d: 'M0,0 L5,2.5 L0,5 Z', fill: linkCol }));
    defs.appendChild(marker);
    svg.appendChild(defs);

    svg.appendChild(el('rect', { x: 0, y: 0, width, height, fill: bg }));

    // Мягкий градиент риска (низ-лево → верх-право)
    const riskGrad = el('linearGradient', {
        id: 'rev-risk', x1: '0%', y1: '100%', x2: '100%', y2: '0%'
    });
    riskGrad.appendChild(el('stop', { offset: '0%', 'stop-color': teal, 'stop-opacity': isDark ? 0.1 : 0.08 }));
    riskGrad.appendChild(el('stop', { offset: '55%', 'stop-color': amber, 'stop-opacity': isDark ? 0.06 : 0.05 }));
    riskGrad.appendChild(el('stop', { offset: '100%', 'stop-color': coral, 'stop-opacity': isDark ? 0.16 : 0.12 }));
    defs.appendChild(riskGrad);

    svg.appendChild(el('rect', {
        x: padL, y: padT, width: plotW, height: plotH,
        fill: 'url(#rev-risk)', rx: 10
    }));

    const qx = padL + plotW * 0.5;
    const qy = padT + plotH * 0.5;
    // Ущелье — только верх-право, мягкая штриховка
    svg.appendChild(el('rect', {
        x: qx, y: padT, width: plotW * 0.5, height: plotH * 0.5,
        fill: 'url(#rev-hatch)', rx: 0
    }));
    // Ловушка — лёгкий оттенок низ-право
    svg.appendChild(el('rect', {
        x: qx, y: qy, width: plotW * 0.5, height: plotH * 0.5,
        fill: violet, opacity: isDark ? 0.07 : 0.05
    }));

    // Линии 50/50 — «порог внимания»
    svg.appendChild(el('line', {
        x1: qx, y1: padT, x2: qx, y2: padT + plotH,
        stroke: grid, 'stroke-width': 1.2, 'stroke-dasharray': '4 6', opacity: 0.55
    }));
    svg.appendChild(el('line', {
        x1: padL, y1: qy, x2: padL + plotW, y2: qy,
        stroke: grid, 'stroke-width': 1.2, 'stroke-dasharray': '4 6', opacity: 0.55
    }));

    for (let i = 0; i <= 4; i++) {
        const v = i * 25;
        const gx = padL + (plotW * i) / 4;
        const gy = padT + plotH - (plotH * i) / 4;
        svg.appendChild(el('line', {
            x1: gx, y1: padT, x2: gx, y2: padT + plotH,
            stroke: grid, 'stroke-width': 1, opacity: 0.28
        }));
        svg.appendChild(el('line', {
            x1: padL, y1: gy, x2: padL + plotW, y2: gy,
            stroke: grid, 'stroke-width': 1, opacity: 0.28
        }));
        const tx = el('text', {
            x: gx, y: padT + plotH + 16,
            fill: muted, 'font-size': 10, 'text-anchor': 'middle'
        });
        tx.textContent = String(v);
        svg.appendChild(tx);
        const ty = el('text', {
            x: padL - 8, y: gy + 3,
            fill: muted, 'font-size': 10, 'text-anchor': 'end'
        });
        ty.textContent = String(v);
        svg.appendChild(ty);
    }

    svg.appendChild(el('rect', {
        x: padL, y: padT, width: plotW, height: plotH,
        fill: 'none', stroke: grid, 'stroke-width': 1.4, rx: 10
    }));

    const titleEl = el('text', {
        x: 20, y: 26, fill: ink, 'font-size': 16, 'font-weight': 700
    });
    titleEl.textContent = title || 'Карта обратимости';
    svg.appendChild(titleEl);
    const sub = el('text', {
        x: 20, y: 46, fill: muted, 'font-size': 11
    });
    sub.textContent = 'Выше — больнее ошибиться. Правее — дороже развернуть назад. Номера → список справа.';
    svg.appendChild(sub);

    function zonePill(text, x, y, color, anchor) {
        const tw = 12 + text.length * 6.4;
        const px = anchor === 'end' ? x - tw : x;
        svg.appendChild(el('rect', {
            x: px, y: y - 12, width: tw, height: 18, rx: 9,
            fill: isDark ? '#0f172a' : '#ffffff',
            stroke: color, 'stroke-width': 1, opacity: 0.92
        }));
        const t = el('text', {
            x: anchor === 'end' ? x - 8 : x + 8, y: y,
            fill: color, 'font-size': 10, 'font-weight': 700,
            'text-anchor': anchor === 'end' ? 'end' : 'start'
        });
        t.textContent = text;
        svg.appendChild(t);
    }
    // Четыре угла четвертей (одинаковый отступ)
    const zPad = 12;
    zonePill('Хребет', padL + zPad, padT + zPad + 12, amber, 'start');       // верх-лево
    zonePill('Ущелье', padL + plotW - zPad, padT + zPad + 12, coral, 'end'); // верх-право
    zonePill('Плато', padL + zPad, padT + plotH - zPad, teal, 'start');      // низ-лево
    zonePill('Ловушка', padL + plotW - zPad, padT + plotH - zPad, violet, 'end'); // низ-право

    const xAxis = el('text', {
        x: padL + plotW / 2, y: height - 14,
        fill: muted, 'font-size': 11, 'font-weight': 700, 'text-anchor': 'middle'
    });
    xAxis.textContent = 'Цена отката (развернуть назад) →';
    svg.appendChild(xAxis);
    const yAxis = el('text', {
        x: 18, y: padT + plotH / 2,
        fill: muted, 'font-size': 11, 'font-weight': 700,
        'text-anchor': 'middle',
        transform: `rotate(-90 18 ${padT + plotH / 2})`
    });
    yAxis.textContent = 'Боль ошибки (если промах) →';
    svg.appendChild(yAxis);

    // Связи: обрезаем у края круга, метку ×N только если есть свободное место
    (links || []).forEach((lnk) => {
        const x1 = lnk.from.x;
        const y1 = lnk.from.y;
        const x2 = lnk.to.x;
        const y2 = lnk.to.y;
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2 + (lnk.bend || -40);
        // старт/финиш чуть снаружи радиуса
        function edge(ax, ay, bx, by, r) {
            const dx = bx - ax;
            const dy = by - ay;
            const d = Math.hypot(dx, dy) || 1;
            return { x: ax + (dx / d) * (r + 2), y: ay + (dy / d) * (r + 2) };
        }
        // приближение: от центра к контрольной точке
        const s = edge(x1, y1, mx, my, lnk.from.r);
        const e = edge(x2, y2, mx, my, lnk.to.r);
        svg.appendChild(el('path', {
            d: `M ${s.x} ${s.y} Q ${mx} ${my} ${e.x} ${e.y}`,
            fill: 'none',
            stroke: linkCol,
            'stroke-width': 1.35,
            'stroke-dasharray': '5 4',
            'marker-end': 'url(#rev-arrow)',
            opacity: 0.5
        }));
        if (lnk.showChip) {
            const chip = '×' + (Number.isInteger(lnk.factor) ? lnk.factor : lnk.factor);
            const cw = 20 + String(chip).length * 5;
            const cx = lnk.chipX;
            const cy = lnk.chipY;
            svg.appendChild(el('rect', {
                x: cx - cw / 2, y: cy - 8, width: cw, height: 15, rx: 7,
                fill: panel, stroke: grid, 'stroke-width': 1, opacity: 0.96
            }));
            const lab = el('text', {
                x: cx, y: cy + 3,
                fill: muted, 'font-size': 9, 'font-weight': 700, 'text-anchor': 'middle'
            });
            lab.textContent = chip;
            svg.appendChild(lab);
        }
    });

    (nodes || []).forEach((n) => {
        const fill = zoneColor[n.zone] || (themeColors && themeColors[0]) || teal;
        // мягкая «тень»
        svg.appendChild(el('circle', {
            cx: n.x + 0.8, cy: n.y + 1.2, r: n.r + 1,
            fill: isDark ? '#000' : '#94a3b8', opacity: isDark ? 0.25 : 0.18
        }));
        const nodeRing = el('circle', {
            cx: n.x, cy: n.y, r: n.r + 2,
            fill: isDark ? '#0f172a' : '#ffffff',
            stroke: fill, 'stroke-width': 2.2,
            'stroke-dasharray': n.confidence === 'fact' ? 'none' : '3 2'
        });
        if (typeof setDiagramSourceLine === 'function') {
            setDiagramSourceLine(nodeRing, n.line || n.sourceLine);
        }
        svg.appendChild(nodeRing);
        svg.appendChild(el('circle', {
            cx: n.x, cy: n.y, r: n.r - 1,
            fill: fill, opacity: n.confidence === 'fact' ? 0.92 : 0.35
        }));
        const num = el('text', {
            x: n.x, y: n.y + 4,
            fill: n.confidence === 'fact' ? '#fff' : ink,
            'font-size': 11, 'font-weight': 800, 'text-anchor': 'middle'
        });
        num.textContent = String(n.num);
        svg.appendChild(num);
    });

    const linkBlockH = (typeof layoutData.linkBlockH === 'number')
        ? layoutData.linkBlockH
        : (20 + Math.max(0, (linkNotes || []).length) * 16);
    const listBodyH = (typeof layoutData.listBodyH === 'number')
        ? layoutData.listBodyH
        : ((listItems || []).length * 36);
    const listH = 44 + listBodyH + linkBlockH;
    svg.appendChild(el('rect', {
        x: listX, y: listY, width: listW, height: listH,
        rx: 12, fill: panel, stroke: grid, 'stroke-width': 1.2
    }));
    svg.appendChild(el('rect', {
        x: listX, y: listY, width: listW, height: 32,
        rx: 12, fill: isDark ? '#0f172a' : '#f1f5f9', opacity: 0.9
    }));
    svg.appendChild(el('rect', {
        x: listX, y: listY + 16, width: listW, height: 16,
        fill: isDark ? '#0f172a' : '#f1f5f9', opacity: 0.9
    }));
    const listTitle = el('text', {
        x: listX + 14, y: listY + 21,
        fill: ink, 'font-size': 12, 'font-weight': 700
    });
    listTitle.textContent = 'Решения';
    svg.appendChild(listTitle);

    const nameMaxW = listW - 52;
    let yCursor = listY + 44;
    (listItems || []).forEach((it) => {
        const nameLines = it.nameLines || (typeof wrapTextLines === 'function'
            ? wrapTextLines(it.name, nameMaxW, 11)
            : [it.name]);
        const rowH = it.rowH || Math.max(36, 8 + nameLines.length * 14 + 18);
        const c = zoneColor[it.zone] || teal;
        const badgeY = yCursor + Math.min(rowH - 12, 10 + nameLines.length * 7);
        svg.appendChild(el('circle', {
            cx: listX + 18, cy: badgeY, r: 9, fill: c, opacity: 0.9
        }));
        const n = el('text', {
            x: listX + 18, y: badgeY + 4,
            fill: '#fff', 'font-size': 10, 'font-weight': 800, 'text-anchor': 'middle'
        });
        n.textContent = String(it.num);
        svg.appendChild(n);

        const nameH = (typeof appendSvgTextBlock === 'function')
            ? appendSvgTextBlock(svgNS, svg, {
                x: listX + 34, y: yCursor + 12,
                lines: nameLines, fill: ink, fontSize: 11, fontWeight: '600', lineHeight: 14,
                dataLabel: it.name
            })
            : (() => {
                const t = el('text', { x: listX + 34, y: yCursor + 12, fill: ink, 'font-size': 11, 'font-weight': 600 });
                t.textContent = it.name;
                t.setAttribute('data-label', it.name);
                svg.appendChild(t);
                return 14;
            })();

        const meta = el('text', {
            x: listX + 34, y: yCursor + 8 + nameH + 4,
            fill: muted, 'font-size': 10
        });
        const conf = it.confidence === 'fact' ? 'факт' : 'гипотеза';
        meta.textContent = 'боль ' + Math.round(it.impact) + ' · откат ' + Math.round(it.irreversibility) + ' · ' + conf;
        svg.appendChild(meta);
        yCursor += rowH;
    });

    // Блок связей внизу списка — сюда уехали ×N
    if (linkNotes && linkNotes.length) {
        const baseY = yCursor + 4;
        const sep = el('text', {
            x: listX + 14, y: baseY + 4,
            fill: muted, 'font-size': 10, 'font-weight': 700
        });
        sep.textContent = 'Усиливают необратимость';
        svg.appendChild(sep);
        let linkY = baseY + 20;
        linkNotes.forEach((ln) => {
            const fac = Number.isInteger(ln.factor) ? String(ln.factor) : String(ln.factor);
            const fallback = ln.fromNum + ' → ' + ln.toNum + ': откат ×' + fac
                + (ln.fromName && ln.toName ? ' (' + ln.fromName + ' → ' + ln.toName + ')' : '');
            const lines = ln.lines || (typeof wrapTextLines === 'function'
                ? wrapTextLines(fallback, nameMaxW, 10)
                : [fallback]);
            if (typeof appendSvgTextBlock === 'function') {
                const h = appendSvgTextBlock(svgNS, svg, {
                    x: listX + 14, y: linkY,
                    lines, fill: muted, fontSize: 10, fontWeight: '500', lineHeight: 13
                });
                linkY += Math.max(16, h);
            } else {
                const t = el('text', { x: listX + 14, y: linkY, fill: muted, 'font-size': 10 });
                t.textContent = fallback;
                svg.appendChild(t);
                linkY += 16;
            }
        });
    }

    const legY = listY + listH + 14;
    if (legY + 36 < height) {
        const zones = [
            ['Плато', teal],
            ['Хребет', amber],
            ['Ущелье', coral],
            ['Ловушка', violet]
        ];
        zones.forEach((z, i) => {
            const x = listX + (i % 2) * 140;
            const y = legY + Math.floor(i / 2) * 16;
            svg.appendChild(el('circle', { cx: x + 5, cy: y, r: 4, fill: z[1] }));
            const t = el('text', { x: x + 14, y: y + 3, fill: muted, 'font-size': 10 });
            t.textContent = z[0];
            svg.appendChild(t);
        });
    }

    return {
        svg,
        width,
        height,
        svgString: new XMLSerializer().serializeToString(svg)
    };
}
