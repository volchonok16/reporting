/**
 * SVG контекста системы (C4 L1–light).
 * Ортогональные связи; узлы поверх стрелок; подписи в коридорах.
 */
function generateContextSVG(layoutData, themeColors) {
    const nodes = layoutData.nodes || [];
    const links = layoutData.links || [];
    const width = layoutData.width || 400;
    const height = layoutData.height || 300;
    const title = layoutData.title || 'Контекст системы';
    const subtitle = layoutData.subtitle || 'Кто пользуется системой и с чем она связана';
    const colLabels = layoutData.colLabels || {};
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
    const edgeCol = isDark ? '#94a3b8' : '#64748b';
    const primaryColor = palette[0] || '#3b82f6';

    function el(name, attrs) {
        const n = document.createElementNS(svgNS, name);
        Object.keys(attrs || {}).forEach((k) => n.setAttribute(k, String(attrs[k])));
        return n;
    }

    svg.appendChild(el('rect', { x: 0, y: 0, width: width, height: height, fill: bg }));

    const titleEl = el('text', {
        x: width / 2, y: 24, fill: ink, 'font-size': 16, 'font-weight': 700, 'text-anchor': 'middle'
    });
    titleEl.textContent = title;
    svg.appendChild(titleEl);

    const subEl = el('text', {
        x: width / 2, y: 42, fill: muted, 'font-size': 11, 'text-anchor': 'middle'
    });
    subEl.textContent = subtitle;
    svg.appendChild(subEl);

    ['left', 'center', 'right', 'services'].forEach((key) => {
        const lab = colLabels[key];
        if (!lab) return;
        const t = el('text', {
            x: lab.x, y: lab.y, fill: muted, 'font-size': 11, 'font-weight': 700,
            'text-anchor': 'middle', 'letter-spacing': '0.04em'
        });
        t.textContent = String(lab.text || '').toUpperCase();
        svg.appendChild(t);
    });

    const defs = el('defs', {});
    const marker = el('marker', {
        id: 'ctx-arrow',
        markerWidth: 10,
        markerHeight: 10,
        refX: 8,
        refY: 3,
        orient: 'auto'
    });
    marker.appendChild(el('path', { d: 'M0,0 L8,3 L0,6 Z', fill: edgeCol }));
    defs.appendChild(marker);
    svg.appendChild(defs);

    function pathD(l) {
        if (l.points && l.points.length >= 2) {
            return l.points.map((p, i) => (i ? 'L' : 'M') + p.x + ',' + p.y).join(' ');
        }
        return 'M' + l.x1 + ',' + l.y1 + ' L' + l.x2 + ',' + l.y2;
    }

    links.forEach((l) => {
        const path = el('path', {
            d: pathD(l),
            fill: 'none',
            stroke: edgeCol,
            'stroke-width': 1.55,
            'marker-end': 'url(#ctx-arrow)'
        });
        if (typeof setDiagramSourceLine === 'function') setDiagramSourceLine(path, l.line);
        svg.appendChild(path);
    });

    // Подписи поверх линий, до узлов
    links.forEach((l) => {
        if (!l.label) return;
        const label = String(l.label);
        const approxW = Math.min(140, Math.max(28, label.length * 6.0 + 12));
        const bgR = el('rect', {
            x: l.lx - approxW / 2, y: l.ly - 9, width: approxW, height: 18, rx: 4,
            fill: bg,
            stroke: isDark ? '#334155' : '#e2e8f0'
        });
        if (typeof setDiagramSourceLine === 'function') setDiagramSourceLine(bgR, l.line);
        svg.appendChild(bgR);
        const t = el('text', {
            x: l.lx, y: l.ly + 4, fill: muted, 'font-size': 11, 'font-weight': 600,
            'text-anchor': 'middle'
        });
        t.textContent = label.length > 24 ? label.slice(0, 22) + '…' : label;
        if (typeof setDiagramSourceLine === 'function') setDiagramSourceLine(t, l.line);
        svg.appendChild(t);
    });

    nodes.forEach((n, i) => {
        const g = el('g', {});
        if (typeof setDiagramSourceLine === 'function') setDiagramSourceLine(g, n.line);
        const color = n.kind === 'system' && !n._role
            ? primaryColor
            : palette[(i + 1) % palette.length];
        const isPrimary = n.kind === 'system' && !n._role;

        if (n.kind === 'person') {
            g.appendChild(el('rect', {
                x: n.x, y: n.y, width: n.width, height: n.height, rx: 12,
                fill: panel, stroke: color, 'stroke-width': 1.75
            }));
            g.appendChild(el('circle', {
                cx: n.x + 18, cy: n.y + 16, r: 6, fill: color, stroke: 'none'
            }));
            g.appendChild(el('path', {
                d: 'M' + (n.x + 10) + ',' + (n.y + 30)
                    + ' Q' + (n.x + 18) + ',' + (n.y + 22) + ' ' + (n.x + 26) + ',' + (n.y + 30),
                fill: 'none', stroke: color, 'stroke-width': 1.75, 'stroke-linecap': 'round'
            }));
            let ty = n.y + 20;
            (n.nameLines || [n.name]).forEach((line) => {
                const t = el('text', {
                    x: n.x + 34, y: ty, fill: ink, 'font-size': 12, 'font-weight': 700
                });
                t.textContent = line;
                g.appendChild(t);
                ty += 15;
            });
            (n.descLines || []).forEach((line) => {
                const t = el('text', {
                    x: n.x + 34, y: ty, fill: muted, 'font-size': 11
                });
                t.textContent = line;
                g.appendChild(t);
                ty += 13;
            });
        } else {
            g.appendChild(el('rect', {
                x: n.x, y: n.y, width: n.width, height: n.height,
                rx: isPrimary ? 14 : 10,
                fill: isPrimary ? color : panel,
                stroke: isPrimary ? 'none' : color,
                'stroke-width': isPrimary ? 0 : 1.75,
                'stroke-dasharray': n.kind === 'external' ? '5,4' : 'none'
            }));
            if (n.kind === 'external') {
                const tag = el('text', {
                    x: n.x + 10, y: n.y + 14, fill: muted, 'font-size': 9, 'font-weight': 700
                });
                tag.textContent = 'ВНЕШН.';
                g.appendChild(tag);
            } else if (n._role === 'service') {
                const tag = el('text', {
                    x: n.x + 10, y: n.y + 14, fill: muted, 'font-size': 9, 'font-weight': 700
                });
                tag.textContent = 'СЕРВИС';
                g.appendChild(tag);
            }
            const textFill = isPrimary ? '#ffffff' : ink;
            const mutedFill = isPrimary ? 'rgba(255,255,255,0.88)' : muted;
            let ty = n.y + ((n.kind === 'external' || n._role === 'service') ? 30 : 24);
            (n.nameLines || [n.name]).forEach((line) => {
                const t = el('text', {
                    x: n.cx, y: ty, fill: textFill, 'font-size': isPrimary ? 14 : 12,
                    'font-weight': 700, 'text-anchor': 'middle'
                });
                t.textContent = line;
                g.appendChild(t);
                ty += 16;
            });
            (n.descLines || []).forEach((line) => {
                const t = el('text', {
                    x: n.cx, y: ty, fill: mutedFill, 'font-size': 11, 'text-anchor': 'middle'
                });
                t.textContent = line;
                g.appendChild(t);
                ty += 13;
            });
        }
        svg.appendChild(g);
    });

    return { svg, width, height, svgString: new XMLSerializer().serializeToString(svg) };
}
