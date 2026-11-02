/**
 * SVG «Лента фаз»: секции фаз, строки задач с ролями.
 */
function generateRibbonSVG(layoutData, themeColors) {
    const {
        title, phases, roles, width, height, pad, legendH
    } = layoutData || {};
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Лента фаз');
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
    const rail = isDark ? '#475569' : '#cbd5e1';

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
    titleEl.textContent = title || 'Лента фаз';
    svg.appendChild(titleEl);
    const sub = el('text', {
        x: pad, y: 42, fill: muted, 'font-size': 11
    });
    sub.textContent = 'Фазы сверху вниз. У каждой задачи — название и все ответственные.';
    svg.appendChild(sub);

    (phases || []).forEach((phase, pi) => {
        const gSec = el('g', {});
        if (typeof setDiagramSourceLine === 'function') setDiagramSourceLine(gSec, phase.line);

        // номер + заголовок фазы
        gSec.appendChild(el('circle', {
            cx: phase.x + 10, cy: phase.y + 14, r: 9,
            fill: panel, stroke: border, 'stroke-width': 1.2
        }));
        const num = el('text', {
            x: phase.x + 10, y: phase.y + 18,
            fill: ink, 'font-size': 11, 'font-weight': 700, 'text-anchor': 'middle'
        });
        num.textContent = String(pi + 1);
        gSec.appendChild(num);

        const ph = el('text', {
            x: phase.x + 28, y: phase.y + 18,
            fill: ink, 'font-size': 13, 'font-weight': 700
        });
        ph.textContent = phase.name;
        gSec.appendChild(ph);

        const count = el('text', {
            x: phase.x + phase.w - 4, y: phase.y + 18,
            fill: muted, 'font-size': 11, 'text-anchor': 'end'
        });
        count.textContent = (phase.tasks || []).length + ' задач';
        gSec.appendChild(count);

        // вертикальная линия секции
        const firstY = phase.tasks && phase.tasks[0] ? phase.tasks[0].y : phase.y + phase.headerH;
        const last = phase.tasks && phase.tasks.length
            ? phase.tasks[phase.tasks.length - 1]
            : null;
        const lastY = last ? last.y + last.h : firstY;
        gSec.appendChild(el('line', {
            x1: phase.x + 10, y1: phase.y + 26,
            x2: phase.x + 10, y2: lastY,
            stroke: rail, 'stroke-width': 2
        }));

        (phase.tasks || []).forEach((card) => {
            const g = el('g', {});
            if (typeof setDiagramSourceLine === 'function') setDiagramSourceLine(g, card.line);
            g.appendChild(el('rect', {
                x: card.x, y: card.y, width: card.w, height: card.h,
                rx: 8, fill: panel, stroke: border, 'stroke-width': 1
            }));

            const rolesList = card.roles && card.roles.length ? card.roles : [];
            // точки ролей слева
            rolesList.forEach((name, i) => {
                g.appendChild(el('circle', {
                    cx: card.x + 14,
                    cy: card.y + 16 + i * 11,
                    r: 4,
                    fill: roleColor(name)
                }));
            });
            const textX = card.x + 28;
            let ty = card.y + 16;
            (card.nameLines || []).forEach((ln) => {
                const t = el('text', {
                    x: textX, y: ty, fill: ink, 'font-size': 12, 'font-weight': 600
                });
                t.textContent = ln;
                g.appendChild(t);
                ty += 14;
            });
            (card.roleLines || []).forEach((ln) => {
                const t = el('text', {
                    x: textX, y: ty + 1, fill: muted, 'font-size': 10, 'font-weight': 600
                });
                t.textContent = ln;
                g.appendChild(t);
                ty += 12;
            });
            gSec.appendChild(g);
        });

        svg.appendChild(gSec);
    });

    if (roles && roles.length && legendH) {
        const ly = height - pad - legendH + 12;
        const lab = el('text', {
            x: pad, y: ly, fill: muted, 'font-size': 12, 'font-weight': 700
        });
        lab.textContent = 'Роли';
        svg.appendChild(lab);
        const colW = Math.max(120, (width - pad * 2) / Math.min(5, roles.length));
        roles.forEach((r, i) => {
            const col = i % 5;
            const row = Math.floor(i / 5);
            const x = pad + col * colW;
            const y = ly + 18 + row * 22;
            svg.appendChild(el('circle', {
                cx: x + 5, cy: y - 4, r: 5, fill: roleColor(r.label)
            }));
            const t = el('text', {
                x: x + 16, y, fill: ink, 'font-size': 12, 'font-weight': 600
            });
            t.textContent = r.label;
            svg.appendChild(t);
        });
    }

    return { svg, width, height };
}
