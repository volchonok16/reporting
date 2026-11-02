/**
 * SVG «Дорожки»: роль × фаза, в ячейках — названия задач и список ролей.
 */
function generateLanesSVG(layoutData, themeColors) {
    const {
        title, phases, lanes, roles, width, height, pad, labelW, headerH, titleH
    } = layoutData || {};
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Дорожки');
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
    const headerFill = isDark ? '#0f172a' : '#f8fafc';
    const laneFill = isDark ? '#0f172a' : '#f1f5f9';
    const cardFill = isDark ? '#1e293b' : '#ffffff';

    function el(name, attrs) {
        const n = document.createElementNS(svgNS, name);
        Object.keys(attrs || {}).forEach((k) => n.setAttribute(k, String(attrs[k])));
        return n;
    }
    function roleColor(name) {
        return typeof rolloutRoleColor === 'function'
            ? rolloutRoleColor(name, isDark, themeColors, roles)
            : ((themeColors && themeColors[0]) || muted);
    }

    svg.appendChild(el('rect', { x: 0, y: 0, width, height, fill: bg }));

    const titleEl = el('text', {
        x: pad, y: 24, fill: ink, 'font-size': 16, 'font-weight': 700
    });
    titleEl.textContent = title || 'Дорожки';
    svg.appendChild(titleEl);
    const sub = el('text', {
        x: pad, y: 42, fill: muted, 'font-size': 11
    });
    sub.textContent = 'Строка — роль, колонка — фаза. В ячейке — название задачи и все ответственные.';
    svg.appendChild(sub);

    (phases || []).forEach((p) => {
        svg.appendChild(el('rect', {
            x: p.x, y: p.y, width: p.width, height: headerH,
            fill: headerFill, stroke: border, 'stroke-width': 1
        }));
        (p.nameLines || [p.name]).forEach((ln, li) => {
            const t = el('text', {
                x: p.x + p.width / 2,
                y: p.y + 18 + li * 12,
                fill: ink,
                'font-size': 11,
                'font-weight': 700,
                'text-anchor': 'middle'
            });
            t.textContent = ln;
            svg.appendChild(t);
        });
    });

    // угол «Роль»
    svg.appendChild(el('rect', {
        x: pad, y: titleH, width: labelW, height: headerH,
        fill: headerFill, stroke: border, 'stroke-width': 1
    }));
    const corner = el('text', {
        x: pad + 10, y: titleH + 20, fill: muted, 'font-size': 11, 'font-weight': 700
    });
    corner.textContent = 'Роль';
    svg.appendChild(corner);

    (lanes || []).forEach((lane) => {
        const gLane = el('g', {});
        gLane.appendChild(el('rect', {
            x: pad, y: lane.y, width: width - pad * 2, height: lane.rowH,
            fill: laneFill, stroke: border, 'stroke-width': 1
        }));

        const rc = roleColor(lane.role.label);
        gLane.appendChild(el('circle', {
            cx: pad + 14, cy: lane.y + lane.rowH / 2, r: 5, fill: rc
        }));
        const lab = el('text', {
            x: pad + 26,
            y: lane.y + lane.rowH / 2 + 4,
            fill: ink,
            'font-size': 11,
            'font-weight': 700
        });
        lab.textContent = lane.role.label;
        gLane.appendChild(lab);

        (lane.cells || []).forEach((cell) => {
            gLane.appendChild(el('line', {
                x1: cell.x, y1: cell.y, x2: cell.x, y2: cell.y + cell.h,
                stroke: border, 'stroke-width': 1
            }));
            (cell.cards || []).forEach((card) => {
                const g = el('g', {});
                if (typeof setDiagramSourceLine === 'function') setDiagramSourceLine(g, card.line);
                g.appendChild(el('rect', {
                    x: card.x, y: card.y, width: card.w, height: card.h,
                    rx: 6, fill: cardFill, stroke: border, 'stroke-width': 1
                }));
                const stripeW = 3;
                const rolesList = card.roles && card.roles.length ? card.roles : [];
                if (rolesList.length) {
                    const segH = card.h / rolesList.length;
                    rolesList.forEach((name, i) => {
                        g.appendChild(el('rect', {
                            x: card.x, y: card.y + i * segH,
                            width: stripeW, height: segH + 0.5,
                            fill: roleColor(name)
                        }));
                    });
                }
                let ty = card.y + 13;
                (card.nameLines || []).forEach((ln) => {
                    const t = el('text', {
                        x: card.x + 8, y: ty, fill: ink, 'font-size': 10, 'font-weight': 600
                    });
                    t.textContent = ln;
                    g.appendChild(t);
                    ty += 12;
                });
                (card.roleLines || []).forEach((ln) => {
                    const t = el('text', {
                        x: card.x + 8, y: ty + 1, fill: muted, 'font-size': 9, 'font-weight': 600
                    });
                    t.textContent = ln;
                    g.appendChild(t);
                    ty += 11;
                });
                gLane.appendChild(g);
            });
        });
        svg.appendChild(gLane);
    });

    return { svg, width, height };
}
