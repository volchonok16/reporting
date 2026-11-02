/**
 * Компоновка роллаута: колонки-фазы, карточки, легенда ролей.
 * Цвета ролей задаёт палитра темы в svg-renderer.
 */
function layoutRollout(data) {
    if (!data || !data.phases || !data.phases.length) {
        return { phases: [], roles: [], width: 0, height: 0, title: '' };
    }

    const pad = 20;
    const titleH = 68;
    const axisH = 22;
    const colW = 200;
    const colGap = 14;
    const headerH = 44;
    const cardGap = 8;
    const wrapName = (name, maxW, fs) => (typeof wrapTextLines === 'function'
        ? wrapTextLines(name, maxW, fs)
        : [String(name || '')]);

    const rolesOrder = [];
    const seenRole = new Set();

    function noteRole(label) {
        const key = rolloutRoleKey(label);
        if (!key || seenRole.has(key)) return;
        seenRole.add(key);
        rolesOrder.push({ key, label: String(label || '').trim() || key });
    }

    const phases = data.phases.map((p, index) => {
        const cards = (p.tasks || []).map((t) => {
            const roles = Array.isArray(t.roles) && t.roles.length
                ? t.roles.slice()
                : (t.lead ? [t.lead] : []);
            roles.forEach(noteRole);

            const titleLines = wrapName(t.name, colW - 28, 11).slice(0, 5);

            let ownerBlockH = 0;
            let ownerLines = [];
            let ownerMode = 'none';
            if (roles.length === 1) {
                ownerMode = 'single';
                ownerLines = wrapName(roles[0], colW - 36, 9).slice(0, 2);
                ownerBlockH = 4 + ownerLines.length * 12;
            } else if (roles.length > 1) {
                ownerMode = 'multi';
                ownerLines = roles.map((r) => String(r || '').trim()).filter(Boolean);
                ownerBlockH = 6 + ownerLines.length * 14 + 4;
            }

            const h = 10 + titleLines.length * 14
                + ownerBlockH
                + 8;
            return {
                name: t.name,
                nameLines: titleLines,
                roles,
                lead: roles[0] || '',
                ownerLabel: roles.join(' + '),
                ownerLines,
                ownerMode,
                line: t.line,
                h: Math.max(44, h)
            };
        });
        let yOff = 8;
        cards.forEach((c) => {
            c.yOff = yOff;
            yOff += c.h + cardGap;
        });
        return {
            name: p.name,
            nameLines: wrapName(p.name, colW - 16, 12).slice(0, 2),
            line: p.line,
            index,
            cards,
            bodyH: Math.max(48, yOff + 4)
        };
    });

    const maxBody = phases.reduce((m, p) => Math.max(m, p.bodyH), 80);
    // Легенда крупнее: заголовок + строки ~26px
    const legendH = rolesOrder.length ? (22 + Math.ceil(rolesOrder.length / 4) * 26) : 0;
    const colsBlockW = phases.length * colW + Math.max(0, phases.length - 1) * colGap;
    const width = pad + colsBlockW + pad;
    const height = titleH + axisH + headerH + maxBody + legendH + pad;

    phases.forEach((p, i) => {
        p.x = pad + i * (colW + colGap);
        p.y = titleH + axisH;
        p.width = colW;
        p.height = headerH + maxBody;
        p.bodyY = p.y + headerH;
        p.cards.forEach((c) => {
            c.x = p.x + 8;
            c.y = p.bodyY + c.yOff;
            c.w = colW - 16;
        });
        p.axisX = p.x + colW / 2;
        p.axisY = titleH + 10;
    });

    return {
        title: data.title || 'Роллаут',
        phases,
        roles: rolesOrder,
        width,
        height,
        titleH,
        pad,
        legendH,
        colW,
        headerH
    };
}

function rolloutRoleKey(name) {
    let n = String(name || '').toLowerCase().trim();
    n = n.replace(/^vas\s+/, '');
    if (/домен/.test(n)) return 'домен';
    if (/продукт/.test(n)) return 'продукт';
    if (/поддерж/.test(n)) return 'поддержка';
    if (/обучен/.test(n)) return 'обучение';
    if (/маркетинг|pr\b/.test(n)) return 'маркетинг';
    if (/закуп/.test(n)) return 'закупки';
    if (/юрист|правов/.test(n)) return 'юристы';
    if (/канал/.test(n)) return 'каналы';
    if (/партн[её]р/.test(n)) return 'партнёр';
    if (/it\b|ит\b|техблок|тб/.test(n)) return 'it';
    return n || 'прочее';
}

/**
 * Цвет роли из палитры темы (как у flowchart/timeline).
 */
function rolloutRoleColor(name, isDark, themeColors, rolesOrder) {
    const key = rolloutRoleKey(name);
    const palette = (themeColors && themeColors.length)
        ? themeColors
        : (isDark
            ? ['#60a5fa', '#34d399', '#c4b5fd', '#fbbf24', '#fb7185', '#38bdf8', '#a78bfa']
            : ['#2563eb', '#059669', '#7c3aed', '#d97706', '#e11d48', '#0284c7', '#6d28d9']);

    let idx = -1;
    if (rolesOrder && rolesOrder.length) {
        idx = rolesOrder.findIndex((r) => r && (r.key === key || rolloutRoleKey(r.label) === key));
    }
    if (idx < 0) {
        let h = 0;
        for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
        idx = h % palette.length;
    }
    return palette[idx % palette.length];
}
