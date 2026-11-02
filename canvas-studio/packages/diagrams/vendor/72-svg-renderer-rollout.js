/**
 * SVG «Роллаут»: фазы на оси, карточки.
 * Цвет роли — только левая грань (палитра темы); подпись без заливки.
 * Несколько ролей — сегменты на грани + подблок со списком.
 */
function generateRolloutSVG(layoutData, themeColors) {
    const {
        title, phases, roles, width, height, pad, legendH
    } = layoutData || {};
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Роллаут');
    svg.style.fontFamily = (typeof getUiFontFamily === 'function'
        ? getUiFontFamily()
        : 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif');

    const isDark = document.body.classList.contains('dark');
    const bg = typeof readCssColor === 'function'
        ? readCssColor('--diagram-bg', isDark ? '#161618' : '#f8fafc')
        : (isDark ? '#161618' : '#f8fafc');
    const ink = isDark ? '#e2e8f0' : '#0f172a';
    const muted = isDark ? '#94a3b8' : '#64748b';
    const border = isDark ? '#334155' : '#e2e8f0';
    const panel = isDark ? '#1e293b' : '#ffffff';
    const cardFill = isDark ? '#0f172a' : '#ffffff';
    const subFill = isDark ? '#1e293b' : '#f8fafc';
    const headerFill = isDark ? '#0f172a' : '#f8fafc';
    const axis = isDark ? '#64748b' : '#94a3b8';
    const cardRx = 8;
    const stripeW = 4;

    function el(name, attrs) {
        const n = document.createElementNS(svgNS, name);
        Object.keys(attrs || {}).forEach((k) => n.setAttribute(k, String(attrs[k])));
        return n;
    }
    function roleColor(name) {
        return typeof rolloutRoleColor === 'function'
            ? rolloutRoleColor(name, isDark, themeColors, roles)
            : ((themeColors && themeColors[0]) || (isDark ? '#94a3b8' : '#64748b'));
    }

    function paintLeftStripe(parent, card, roleNames) {
        const list = (roleNames && roleNames.length) ? roleNames : [];
        if (!list.length) return;
        const clipId = 'ro-clip-' + String(card.x).replace(/\W/g, '') + '-'
            + String(card.y).replace(/\W/g, '') + '-' + Math.round(card.h);
        const defs = el('defs', {});
        const clip = el('clipPath', { id: clipId });
        clip.appendChild(el('rect', {
            x: card.x, y: card.y, width: card.w, height: card.h, rx: cardRx, ry: cardRx
        }));
        defs.appendChild(clip);
        parent.appendChild(defs);

        const g = el('g', { 'clip-path': 'url(#' + clipId + ')' });
        if (list.length === 1) {
            g.appendChild(el('rect', {
                x: card.x, y: card.y, width: stripeW, height: card.h,
                fill: roleColor(list[0])
            }));
        } else {
            const segH = card.h / list.length;
            list.forEach((name, i) => {
                g.appendChild(el('rect', {
                    x: card.x,
                    y: card.y + i * segH,
                    width: stripeW,
                    height: segH + 0.5,
                    fill: roleColor(name)
                }));
            });
        }
        parent.appendChild(g);
    }

    svg.appendChild(el('rect', { x: 0, y: 0, width, height, fill: bg }));

    const titleEl = el('text', {
        x: pad, y: 24, fill: ink, 'font-size': 16, 'font-weight': 700
    });
    titleEl.textContent = title || 'Роллаут';
    svg.appendChild(titleEl);
    const sub1 = el('text', {
        x: pad, y: 42, fill: muted, 'font-size': 11
    });
    sub1.textContent = 'Фазы слева направо. Цвет на левой грани карточки — роль (@…).';
    svg.appendChild(sub1);
    const sub2 = el('text', {
        x: pad, y: 56, fill: muted, 'font-size': 11
    });
    sub2.textContent = 'Несколько участников: сегменты грани сверху вниз — в порядке приоритета участия (как после @).';
    svg.appendChild(sub2);

    const cols = phases || [];
    if (cols.length > 1) {
        svg.appendChild(el('line', {
            x1: cols[0].axisX, y1: cols[0].axisY,
            x2: cols[cols.length - 1].axisX, y2: cols[cols.length - 1].axisY,
            stroke: axis, 'stroke-width': 2
        }));
    }

    cols.forEach((col, i) => {
        svg.appendChild(el('circle', {
            cx: col.axisX, cy: col.axisY, r: 4.5,
            fill: axis
        }));
        if (i < cols.length - 1) {
            const nx = cols[i + 1].axisX;
            svg.appendChild(el('polygon', {
                points: `${nx - 10},${col.axisY - 4} ${nx - 4},${col.axisY} ${nx - 10},${col.axisY + 4}`,
                fill: axis
            }));
        }

        svg.appendChild(el('rect', {
            x: col.x, y: col.y, width: col.width, height: col.height,
            rx: 10, fill: panel, stroke: border, 'stroke-width': 1.2
        }));

        svg.appendChild(el('rect', {
            x: col.x, y: col.y, width: col.width, height: 44,
            rx: 10, fill: headerFill
        }));
        svg.appendChild(el('rect', {
            x: col.x, y: col.y + 22, width: col.width, height: 22, fill: headerFill
        }));

        (col.nameLines || [col.name]).forEach((ln, li) => {
            const tx = el('text', {
                x: col.x + col.width / 2,
                y: col.y + 22 + li * 13,
                fill: ink,
                'font-size': 12,
                'font-weight': 700,
                'text-anchor': 'middle'
            });
            tx.textContent = ln;
            svg.appendChild(tx);
        });

        (col.cards || []).forEach((card) => {
            const roleNames = (card.roles && card.roles.length)
                ? card.roles
                : (card.lead ? [card.lead] : []);
            const g = el('g', {});
            if (typeof setDiagramSourceLine === 'function') setDiagramSourceLine(g, card.line);

            g.appendChild(el('rect', {
                x: card.x, y: card.y, width: card.w, height: card.h,
                rx: cardRx, ry: cardRx,
                fill: cardFill,
                stroke: border,
                'stroke-width': 1
            }));
            paintLeftStripe(g, card, roleNames);

            let ty = card.y + 16;
            (card.nameLines || []).forEach((ln) => {
                const t = el('text', {
                    x: card.x + 12, y: ty, fill: ink, 'font-size': 11, 'font-weight': 600
                });
                t.textContent = ln;
                g.appendChild(t);
                ty += 14;
            });

            if (card.ownerMode === 'single' && card.ownerLines && card.ownerLines.length) {
                ty += 4;
                card.ownerLines.forEach((ln) => {
                    const t = el('text', {
                        x: card.x + 12, y: ty, fill: muted, 'font-size': 9, 'font-weight': 600
                    });
                    t.textContent = ln;
                    g.appendChild(t);
                    ty += 12;
                });
            } else if (card.ownerMode === 'multi' && roleNames.length > 1) {
                ty += 4;
                const blockX = card.x + 10;
                const blockW = card.w - 18;
                const blockH = 6 + roleNames.length * 14;
                g.appendChild(el('rect', {
                    x: blockX,
                    y: ty - 11,
                    width: blockW,
                    height: blockH,
                    rx: 6,
                    fill: subFill,
                    stroke: border,
                    'stroke-width': 1
                }));
                roleNames.forEach((name) => {
                    const c = roleColor(name);
                    g.appendChild(el('circle', {
                        cx: blockX + 10,
                        cy: ty - 3,
                        r: 3.5,
                        fill: c
                    }));
                    const t = el('text', {
                        x: blockX + 18, y: ty, fill: ink, 'font-size': 9, 'font-weight': 600
                    });
                    t.textContent = name;
                    g.appendChild(t);
                    ty += 14;
                });
            }

            svg.appendChild(g);
        });
    });

    if (roles && roles.length && legendH) {
        const ly = height - pad - legendH + 14;
        const lab = el('text', {
            x: pad, y: ly, fill: muted, 'font-size': 12, 'font-weight': 700
        });
        lab.textContent = 'Роли';
        svg.appendChild(lab);
        const colW = Math.max(160, (width - pad * 2) / Math.min(4, roles.length));
        roles.forEach((r, i) => {
            const col = i % 4;
            const row = Math.floor(i / 4);
            const x = pad + col * colW;
            const y = ly + 20 + row * 26;
            const c = roleColor(r.label);
            svg.appendChild(el('circle', {
                cx: x + 6, cy: y - 4, r: 6, fill: c
            }));
            const t = el('text', {
                x: x + 18, y, fill: ink, 'font-size': 13, 'font-weight': 600
            });
            t.textContent = r.label;
            svg.appendChild(t);
        });
    }

    return { svg, width, height };
}
