/**
 * SVG «Диаграмма перспектив» — заливка общих сущностей + боковая легенда.
 */
function generatePerspectiveSVG(layoutData) {
    const {
        title, columns, entities, width, height,
        listX, listY, listW, listH
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
    const border = isDark ? '#334155' : '#e2e8f0';
    const panel = isDark ? '#1e293b' : '#ffffff';
    const cardFill = isDark ? '#0f172a' : '#f8fafc';
    const entityPalette = isDark
        ? ['#7c3aed', '#0284c7', '#be185d', '#b45309', '#15803d', '#4338ca', '#0f766e']
        : ['#6d28d9', '#0369a1', '#9d174d', '#c2410c', '#15803d', '#3730a3', '#0f766e'];

    function el(name, attrs) {
        const n = document.createElementNS(svgNS, name);
        Object.keys(attrs || {}).forEach((k) => n.setAttribute(k, String(attrs[k])));
        return n;
    }
    function entityColor(id) {
        return entityPalette[((id || 1) - 1) % entityPalette.length];
    }
    function hexToRgb(hex) {
        const h = String(hex || '').replace('#', '');
        if (h.length !== 6) return { r: 100, g: 100, b: 100 };
        return {
            r: parseInt(h.slice(0, 2), 16),
            g: parseInt(h.slice(2, 4), 16),
            b: parseInt(h.slice(4, 6), 16)
        };
    }
    function fillTint(hex, alpha) {
        const { r, g, b } = hexToRgb(hex);
        return `rgba(${r},${g},${b},${alpha})`;
    }

    svg.appendChild(el('rect', { x: 0, y: 0, width, height, fill: bg }));

    const titleEl = el('text', {
        x: 20, y: 24, fill: ink, 'font-size': 16, 'font-weight': 700
    });
    titleEl.textContent = title || 'Диаграмма перспектив';
    svg.appendChild(titleEl);
    const sub = el('text', {
        x: 20, y: 44, fill: muted, 'font-size': 11
    });
    sub.textContent = 'Один мир — разные карты. Заливка + номер = одна сущность (список справа).';
    svg.appendChild(sub);

    (columns || []).forEach((col) => {
        svg.appendChild(el('rect', {
            x: col.x, y: col.y, width: col.width, height: col.height,
            rx: 12, fill: panel, stroke: border, 'stroke-width': 1.3
        }));
        const role = el('text', {
            x: col.x + col.width / 2, y: col.y + 30,
            fill: ink, 'font-size': 13, 'font-weight': 700, 'text-anchor': 'middle'
        });
        role.textContent = col.name;
        svg.appendChild(role);

        (col.items || []).forEach((it, idx) => {
            if (it.depth <= 0) return;
            const parent = (col.items || []).slice(0, idx).reverse().find((p) => p.depth === it.depth - 1);
            if (!parent) return;
            const trunkX = parent.x + 8;
            svg.appendChild(el('path', {
                d: `M ${trunkX} ${parent.y + parent.h} L ${trunkX} ${it.y + it.h / 2} L ${it.x} ${it.y + it.h / 2}`,
                fill: 'none', stroke: muted, 'stroke-width': 1.1, opacity: 0.4
            }));
        });

        (col.items || []).forEach((it) => {
            const eid = it.entityIds && it.entityIds[0];
            const linked = !!eid;
            const eCol = linked ? entityColor(eid) : border;
            const itemRect = el('rect', {
                x: it.x, y: it.y, width: it.w, height: it.h,
                rx: 7,
                fill: linked ? fillTint(eCol, isDark ? 0.38 : 0.22) : cardFill,
                stroke: linked ? eCol : border,
                'stroke-width': linked ? 1.6 : 1.15
            });
            if (typeof setDiagramSourceLine === 'function') {
                setDiagramSourceLine(itemRect, it.line || it.sourceLine);
            }
            svg.appendChild(itemRect);
            const textPad = linked ? 34 : 14;
            const maxW = Math.max(40, it.w - textPad);
            const nameLines = it.nameLines || (typeof wrapTextLines === 'function'
                ? wrapTextLines(it.name, maxW, 11)
                : [it.name]);
            if (typeof appendSvgTextBlock === 'function') {
                const blockH = nameLines.length * 13;
                appendSvgTextBlock(svgNS, svg, {
                    x: it.x + 10,
                    y: it.y + it.h / 2 - blockH / 2 + 10,
                    lines: nameLines,
                    fill: ink,
                    fontSize: 11,
                    fontWeight: '600',
                    lineHeight: 13,
                    dataLabel: it.name || nameLines.join(' ')
                });
            } else {
                const label = el('text', {
                    x: it.x + 10, y: it.y + it.h / 2 + 4,
                    fill: ink, 'font-size': 12, 'font-weight': 600
                });
                label.textContent = nameLines.join(' ');
                label.setAttribute('data-label', nameLines.join(' '));
                svg.appendChild(label);
            }
            if (linked) {
                const bx = it.x + it.w - 20;
                const by = it.y + it.h / 2;
                svg.appendChild(el('circle', { cx: bx, cy: by, r: 9, fill: eCol }));
                const num = el('text', {
                    x: bx, y: by + 3.5,
                    fill: '#fff', 'font-size': 10, 'font-weight': 800, 'text-anchor': 'middle'
                });
                num.textContent = String(eid);
                svg.appendChild(num);
            }
        });
    });

    // Боковая легенда в стиле обратимости
    const ents = entities || [];
    const panelH = listH || (44 + ents.length * 36 + 16);
    svg.appendChild(el('rect', {
        x: listX, y: listY, width: listW, height: panelH,
        rx: 12, fill: panel, stroke: border, 'stroke-width': 1.2
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
    listTitle.textContent = 'Общие сущности';
    svg.appendChild(listTitle);

    let yCursor = listY + 44;
    const nameMaxW = listW - 52;
    ents.forEach((ent) => {
        const parts = (ent.members || []).map((m) => m.name);
        const roles = (ent.members || []).map((m) => m.role);
        const titleLines = ent.titleLines || (typeof wrapTextLines === 'function'
            ? wrapTextLines(parts.join(' · '), nameMaxW, 11)
            : [parts.join(' · ')]);
        const metaLines = ent.metaLines || (typeof wrapTextLines === 'function'
            ? wrapTextLines(roles.filter(Boolean).join(' / '), nameMaxW, 10)
            : [roles.filter(Boolean).join(' / ')]);
        const rowH = ent.rowH || Math.max(36, 8 + titleLines.length * 14 + metaLines.length * 13 + 12);
        const c = entityColor(ent.id);
        const badgeY = yCursor + Math.min(rowH - 12, 12 + titleLines.length * 6);
        svg.appendChild(el('circle', { cx: listX + 18, cy: badgeY, r: 9, fill: c }));
        const n = el('text', {
            x: listX + 18, y: badgeY + 4,
            fill: '#fff', 'font-size': 10, 'font-weight': 800, 'text-anchor': 'middle'
        });
        n.textContent = String(ent.id);
        svg.appendChild(n);

        let used = 0;
        if (typeof appendSvgTextBlock === 'function') {
            used = appendSvgTextBlock(svgNS, svg, {
                x: listX + 34, y: yCursor + 12,
                lines: titleLines, fill: ink, fontSize: 11, fontWeight: '600', lineHeight: 14
            });
            if (metaLines.length && metaLines[0]) {
                appendSvgTextBlock(svgNS, svg, {
                    x: listX + 34, y: yCursor + 12 + used + 2,
                    lines: metaLines, fill: muted, fontSize: 10, fontWeight: '500', lineHeight: 13
                });
            }
        } else {
            const name = el('text', {
                x: listX + 34, y: yCursor + 12,
                fill: ink, 'font-size': 11, 'font-weight': 600
            });
            name.textContent = parts.join(' · ');
            svg.appendChild(name);
        }
        yCursor += rowH;
    });

    return {
        svg,
        width,
        height,
        svgString: new XMLSerializer().serializeToString(svg)
    };
}
