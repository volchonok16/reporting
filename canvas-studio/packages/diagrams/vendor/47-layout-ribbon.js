/**
 * Лента по фазам: вертикальные секции, полный список задач с ролями.
 * Данные из parseRollout.
 */
function layoutRibbon(data) {
    if (!data || !data.phases || !data.phases.length) {
        return { phases: [], roles: [], width: 0, height: 0, title: '' };
    }

    const pad = 24;
    const titleH = 56;
    const contentW = 640;
    const sectionGap = 18;
    const rowGap = 6;
    const wrapName = (name, maxW, fs) => (typeof wrapTextLines === 'function'
        ? wrapTextLines(name, maxW, fs)
        : [String(name || '')]);

    const rolesOrder = [];
    const seen = new Set();
    function noteRole(label) {
        const key = typeof rolloutRoleKey === 'function' ? rolloutRoleKey(label) : String(label).toLowerCase();
        if (!key || seen.has(key)) return;
        seen.add(key);
        rolesOrder.push({ key, label: String(label || '').trim() || key });
    }

    const phases = data.phases.map((p, index) => {
        const tasks = (p.tasks || []).map((t) => {
            const roles = Array.isArray(t.roles) && t.roles.length
                ? t.roles.slice()
                : (t.lead ? [t.lead] : []);
            roles.forEach(noteRole);
            const nameLines = wrapName(t.name, contentW - 120, 12).slice(0, 3);
            const roleLabel = roles.join(' · ');
            const roleLines = roleLabel
                ? wrapName(roleLabel, contentW - 120, 10).slice(0, 2)
                : [];
            const h = 10 + nameLines.length * 14 + (roleLines.length ? 2 + roleLines.length * 12 : 0) + 8;
            return {
                name: t.name,
                nameLines,
                roles,
                roleLines,
                line: t.line,
                h: Math.max(40, h)
            };
        });
        const headerH = 28;
        let body = 8;
        tasks.forEach((t) => { body += t.h + rowGap; });
        body += 4;
        return {
            name: p.name,
            index,
            line: p.line,
            tasks,
            headerH,
            h: headerH + body
        };
    });

    const width = pad + contentW + pad;
    let height = titleH;
    phases.forEach((p, i) => {
        p.x = pad;
        p.y = height;
        p.w = contentW;
        let ty = p.y + p.headerH + 8;
        p.tasks.forEach((t) => {
            t.x = p.x + 14;
            t.y = ty;
            t.w = contentW - 28;
            ty += t.h + rowGap;
        });
        height += p.h + (i < phases.length - 1 ? sectionGap : 0);
    });
    height += pad;

    const legendH = rolesOrder.length ? (18 + Math.ceil(rolesOrder.length / 5) * 22) : 0;
    height += legendH;

    return {
        title: data.title || 'Лента фаз',
        phases,
        roles: rolesOrder,
        width,
        height,
        titleH,
        pad,
        contentW,
        legendH
    };
}
