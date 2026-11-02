/**
 * Дорожки (lanes): строки = роли, колонки = фазы, в ячейках — названия задач.
 * Данные из parseRollout (тот же синтаксис, что у роллаута).
 */
function layoutLanes(data) {
    if (!data || !data.phases || !data.phases.length) {
        return { phases: [], lanes: [], width: 0, height: 0, title: '' };
    }

    const pad = 20;
    const titleH = 56;
    const labelW = 108;
    const colW = 168;
    const colGap = 0;
    const rowGap = 0;
    const headerH = 34;
    const cellPad = 6;
    const cardGap = 5;
    const wrapName = (name, maxW, fs) => (typeof wrapTextLines === 'function'
        ? wrapTextLines(name, maxW, fs)
        : [String(name || '')]);

    const phases = data.phases.map((p, index) => ({
        name: p.name,
        nameLines: wrapName(p.name, colW - 16, 11).slice(0, 2),
        index,
        line: p.line,
        tasks: (p.tasks || []).map((t) => {
            const roles = Array.isArray(t.roles) && t.roles.length
                ? t.roles.slice()
                : (t.lead ? [t.lead] : []);
            const nameLines = wrapName(t.name, colW - 28, 10).slice(0, 3);
            const roleLine = roles.join(' · ');
            const roleLines = roleLine
                ? wrapName(roleLine, colW - 28, 9).slice(0, 2)
                : [];
            const h = 8 + nameLines.length * 12 + (roleLines.length ? 2 + roleLines.length * 11 : 0) + 6;
            return {
                name: t.name,
                nameLines,
                roles,
                roleLines,
                line: t.line,
                h: Math.max(36, h)
            };
        })
    }));

    const rolesOrder = [];
    const seen = new Set();
    phases.forEach((p) => {
        p.tasks.forEach((t) => {
            (t.roles || []).forEach((label) => {
                const key = typeof rolloutRoleKey === 'function' ? rolloutRoleKey(label) : String(label).toLowerCase();
                if (!key || seen.has(key)) return;
                seen.add(key);
                rolesOrder.push({ key, label: String(label || '').trim() || key });
            });
        });
    });

    const lanes = rolesOrder.map((role) => {
        const cells = phases.map((p) => {
            const cards = p.tasks
                .filter((t) => (t.roles || []).some((r) => {
                    const k = typeof rolloutRoleKey === 'function' ? rolloutRoleKey(r) : String(r).toLowerCase();
                    return k === role.key;
                }))
                .map((c) => ({
                    name: c.name,
                    nameLines: c.nameLines,
                    roles: c.roles,
                    roleLines: c.roleLines,
                    line: c.line,
                    h: c.h
                }));
            return { phaseIndex: p.index, cards, bodyH: 40 };
        });
        return { role, cells, rowH: 56 };
    });

    if (!lanes.length) {
        // нет ролей — одна дорожка «Без роли»
        const cells = phases.map((p) => {
            const cards = p.tasks.slice();
            let yOff = cellPad;
            const mapped = cards.map((c) => {
                const item = {
                    name: c.name,
                    nameLines: c.nameLines,
                    roles: c.roles,
                    roleLines: c.roleLines,
                    line: c.line,
                    h: c.h,
                    yOff
                };
                yOff += c.h + cardGap;
                return item;
            });
            return {
                phaseIndex: p.index,
                cards: mapped,
                bodyH: Math.max(40, yOff + cellPad - cardGap)
            };
        });
        const rowH = Math.max(56, ...cells.map((c) => c.bodyH)) + 4;
        lanes.push({
            role: { key: 'none', label: 'Без роли' },
            cells,
            rowH
        });
    } else {
        lanes.forEach((lane) => {
            lane.cells.forEach((cell) => {
                let yOff = cellPad;
                cell.cards.forEach((c) => {
                    c.yOff = yOff;
                    yOff += c.h + cardGap;
                });
                cell.bodyH = Math.max(40, yOff + cellPad - cardGap);
            });
            lane.rowH = Math.max(56, ...lane.cells.map((c) => c.bodyH)) + 4;
        });
    }

    const colsW = phases.length * colW;
    const width = pad + labelW + colsW + pad;
    const bodyH = lanes.reduce((s, l) => s + l.rowH + rowGap, 0);
    const height = titleH + headerH + bodyH + pad;

    let y = titleH + headerH;
    lanes.forEach((lane) => {
        lane.y = y;
        lane.labelX = pad;
        lane.labelW = labelW;
        lane.cells.forEach((cell, i) => {
            cell.x = pad + labelW + i * colW;
            cell.y = y;
            cell.w = colW;
            cell.h = lane.rowH;
            cell.cards.forEach((c) => {
                c.x = cell.x + 6;
                c.y = cell.y + c.yOff;
                c.w = colW - 12;
            });
        });
        y += lane.rowH + rowGap;
    });

    phases.forEach((p, i) => {
        p.x = pad + labelW + i * colW;
        p.y = titleH;
        p.width = colW;
        p.height = headerH;
    });

    return {
        title: data.title || 'Дорожки',
        phases,
        lanes,
        roles: rolesOrder,
        width,
        height,
        titleH,
        pad,
        labelW,
        headerH,
        colW
    };
}
