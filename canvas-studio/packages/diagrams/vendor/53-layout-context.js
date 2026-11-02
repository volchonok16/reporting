/**
 * Раскладка контекста (C4 L1): люди | система | внешние;
 * сервисы — ряд снизу. Связи — ортогональные каналы без наложений подписей.
 */
function layoutContext(data) {
    if (!data || !data.nodes || !data.nodes.length) {
        return { nodes: [], links: [], width: 0, height: 0, title: '', colLabels: null, subtitle: '' };
    }

    const fontFam = (typeof getUiFontFamily === 'function')
        ? getUiFontFamily()
        : 'system-ui, sans-serif';
    const pad = 52;
    const titleH = 56;
    const colLabelH = 24;
    const corridor = 280;
    const gapY = 56;
    const personW = 168;
    const externalW = 168;
    const systemW = 230;
    const serviceGapX = 48;
    const bottomLaneGap = 88;

    function wrap(text, maxW, fs) {
        return (typeof wrapTextLines === 'function')
            ? wrapTextLines(String(text || ''), maxW, fs, fontFam)
            : [String(text || '')];
    }

    const nodes = data.nodes.map((n) => {
        const isSys = n.kind === 'system';
        const boxW = isSys ? systemW : (n.kind === 'person' ? personW : externalW);
        const nameLines = wrap(n.name, boxW - 28, isSys ? 14 : 12).slice(0, 2);
        const descLines = n.desc ? wrap(n.desc, boxW - 28, 11).slice(0, 2) : [];
        const h = 16 + nameLines.length * 16 + (descLines.length ? 4 + descLines.length * 13 : 0) + 14;
        return Object.assign({}, n, {
            nameLines,
            descLines,
            width: boxW,
            height: Math.max(52, h)
        });
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));

    const primary = byId.get(data.primaryId) || nodes.find((n) => n.kind === 'system') || nodes[0];
    const people = nodes.filter((n) => n.id !== primary.id && n.kind === 'person');
    const externals = nodes.filter((n) => n.id !== primary.id && n.kind === 'external');
    const services = nodes.filter((n) => n.id !== primary.id && n.kind === 'system');

    function stackHeight(list) {
        return list.reduce((s, n, i) => s + n.height + (i ? gapY : 0), 0);
    }

    const leftLinkCount = (data.links || []).filter((l) => {
        const a = byId.get(l.from);
        const b = byId.get(l.to);
        if (!a || !b) return false;
        return (a.id === primary.id && people.some((p) => p.id === b.id))
            || (b.id === primary.id && people.some((p) => p.id === a.id));
    }).length;
    const rightLinkCount = (data.links || []).filter((l) => {
        const a = byId.get(l.from);
        const b = byId.get(l.to);
        if (!a || !b) return false;
        return (a.id === primary.id && externals.some((p) => p.id === b.id))
            || (b.id === primary.id && externals.some((p) => p.id === a.id));
    }).length;
    const portNeed = Math.max(leftLinkCount, rightLinkCount, people.length, externals.length, 1);
    primary.height = Math.max(primary.height, 40 + portNeed * 26);

    const leftH = stackHeight(people);
    const rightH = stackHeight(externals);
    const centerH = primary.height;
    const bodyH = Math.max(leftH, rightH, centerH, 160);

    const leftW = people.length ? Math.max(...people.map((n) => n.width), personW) : 0;
    const rightW = externals.length ? Math.max(...externals.map((n) => n.width), externalW) : 0;

    const servicesRowW = services.length
        ? services.reduce((s, n) => s + n.width, 0) + serviceGapX * Math.max(0, services.length - 1)
        : 0;
    const mainW = leftW + (leftW ? corridor : 24) + primary.width + (rightW ? corridor : 24) + rightW;
    const width = pad * 2 + Math.max(mainW, servicesRowW, primary.width);

    // Сколько нижних «полос» нужно под сервис↔внешние
    const svcExtCount = (data.links || []).filter((l) => {
        const a = byId.get(l.from);
        const b = byId.get(l.to);
        if (!a || !b) return false;
        const aSvc = services.some((s) => s.id === a.id);
        const bSvc = services.some((s) => s.id === b.id);
        const aExt = externals.some((s) => s.id === a.id) || people.some((s) => s.id === a.id);
        const bExt = externals.some((s) => s.id === b.id) || people.some((s) => s.id === b.id);
        return (aSvc && bExt) || (bSvc && aExt);
    }).length;

    const top = titleH + pad + colLabelH;
    const servicesGap = services.length ? 80 : 0;
    const servicesH = services.length ? Math.max(...services.map((n) => n.height)) : 0;
    const bottomExtra = svcExtCount ? bottomLaneGap + svcExtCount * 26 + 24 : 24;
    const height = top + bodyH + servicesGap + servicesH + bottomExtra + pad;

    const mainLeft = pad + Math.max(0, (width - pad * 2 - mainW) / 2);
    primary.x = mainLeft + leftW + (leftW ? corridor : 24);
    primary.y = top + (bodyH - primary.height) / 2;
    primary.cx = primary.x + primary.width / 2;
    primary.cy = primary.y + primary.height / 2;

    function placeCol(list, x) {
        let y = top + Math.max(0, (bodyH - stackHeight(list)) / 2);
        list.forEach((n) => {
            n.x = x;
            n.y = y;
            n.cx = n.x + n.width / 2;
            n.cy = n.y + n.height / 2;
            y += n.height + gapY;
        });
    }

    placeCol(people, mainLeft);
    placeCol(externals, primary.x + primary.width + corridor);

    if (services.length) {
        let sx = pad + Math.max(0, (width - pad * 2 - servicesRowW) / 2);
        const sy = top + bodyH + servicesGap;
        services.forEach((n) => {
            n.x = sx;
            n.y = sy;
            n.cx = n.x + n.width / 2;
            n.cy = n.y + n.height / 2;
            n._role = 'service';
            sx += n.width + serviceGapX;
        });
    }

    function classify(l) {
        const a = byId.get(l.from);
        const b = byId.get(l.to);
        if (!a || !b) return 'skip';
        const aP = people.some((p) => p.id === a.id);
        const bP = people.some((p) => p.id === b.id);
        const aE = externals.some((p) => p.id === a.id);
        const bE = externals.some((p) => p.id === b.id);
        const aS = services.some((p) => p.id === a.id);
        const bS = services.some((p) => p.id === b.id);
        const aPri = a.id === primary.id;
        const bPri = b.id === primary.id;

        if ((aPri && bP) || (bPri && aP)) return 'left';
        if ((aPri && bE) || (bPri && aE)) return 'right';
        if ((aPri && bS) || (bPri && aS)) return 'svcPrimary';
        if ((aS && bE) || (bS && aE) || (aS && bP) || (bS && aP)) return 'svcOuter';
        if (aS && bS) return 'svcSvc';
        return 'other';
    }

    const leftLinks = (data.links || []).filter((l) => classify(l) === 'left');
    const rightLinks = (data.links || []).filter((l) => classify(l) === 'right');
    const svcPrimary = (data.links || []).filter((l) => classify(l) === 'svcPrimary');
    const svcOuter = (data.links || []).filter((l) => classify(l) === 'svcOuter');
    const svcSvc = (data.links || []).filter((l) => classify(l) === 'svcSvc');
    const otherLinks = (data.links || []).filter((l) => classify(l) === 'other');

    // Сортируем боковые связи по Y внешнего узла — порт = человек/внешняя
    function outerOf(l, side) {
        const a = byId.get(l.from);
        const b = byId.get(l.to);
        if (side === 'left') return people.find((p) => p.id === a.id || p.id === b.id);
        return externals.find((p) => p.id === a.id || p.id === b.id);
    }
    leftLinks.sort((a, b) => (outerOf(a, 'left').cy || 0) - (outerOf(b, 'left').cy || 0));
    rightLinks.sort((a, b) => (outerOf(a, 'right').cy || 0) - (outerOf(b, 'right').cy || 0));

    function elbow(x1, y1, x2, y2, midX) {
        const mx = midX != null ? midX : (x1 + x2) / 2;
        return {
            x1, y1, x2, y2,
            points: [
                { x: x1, y: y1 },
                { x: mx, y: y1 },
                { x: mx, y: y2 },
                { x: x2, y: y2 }
            ],
            lx: mx,
            ly: (y1 + y2) / 2
        };
    }

    function buildSideLink(l, side, index, total) {
        const a = byId.get(l.from);
        const b = byId.get(l.to);
        const fromPrimary = a.id === primary.id;
        const outer = fromPrimary ? b : a;
        const ox = side === 'left' ? outer.x + outer.width : outer.x;
        const oy = outer.cy;
        // Порт на primary напротив outer
        const portY = Math.max(
            primary.y + 14,
            Math.min(primary.y + primary.height - 14, oy)
        );
        const px = side === 'left' ? primary.x : primary.x + primary.width;
        const x1 = fromPrimary ? px : ox;
        const y1 = fromPrimary ? portY : oy;
        const x2 = fromPrimary ? ox : px;
        const y2 = fromPrimary ? oy : portY;

        const leftBound = Math.min(x1, x2) + 28;
        const rightBound = Math.max(x1, x2) - 28;
        const span = Math.max(48, rightBound - leftBound);
        // Каждый индекс — свой вертикальный канал
        const t = (index + 1) / (Math.max(1, total) + 1);
        const midX = leftBound + span * t;
        const geo = elbow(x1, y1, x2, y2, midX);
        // Подпись смещена вдоль канала, не на середине Y чужих линий
        const labelSide = side === 'left' ? -1 : 1;
        geo.lx = midX + labelSide * 8;
        geo.ly = y1 + (y2 - y1) * (0.28 + (index % 3) * 0.18);
        return {
            from: l.from,
            to: l.to,
            label: l.label || '',
            line: l.line || null,
            points: geo.points,
            x1: geo.x1, y1: geo.y1, x2: geo.x2, y2: geo.y2,
            lx: geo.lx,
            ly: geo.ly
        };
    }

    const links = [];
    leftLinks.forEach((l, i) => links.push(buildSideLink(l, 'left', i, leftLinks.length)));
    rightLinks.forEach((l, i) => links.push(buildSideLink(l, 'right', i, rightLinks.length)));

    // Primary ↔ сервис: разные X-каналы, подписи слева/справа от линии
    svcPrimary.forEach((l, i) => {
        const other = byId.get(l.from === primary.id ? l.to : l.from);
        const fromPrimary = l.from === primary.id;
        const t = (i + 1) / (svcPrimary.length + 1);
        const portX = primary.x + primary.width * t;
        const x1 = fromPrimary ? portX : other.cx;
        const y1 = fromPrimary ? primary.y + primary.height : other.y;
        const x2 = fromPrimary ? other.cx : portX;
        const y2 = fromPrimary ? other.y : primary.y + primary.height;
        // Для пары встречных связей — разный midY и смещение подписи
        const pairKey = [l.from, l.to].sort().join('|');
        const siblings = svcPrimary.filter((x) => [x.from, x.to].sort().join('|') === pairKey);
        const sibIdx = siblings.indexOf(l);
        const midY = Math.min(y1, y2) + Math.abs(y2 - y1) * (0.35 + sibIdx * 0.22);
        const labelOffX = (sibIdx === 0 ? -1 : 1) * 56;
        links.push({
            from: l.from,
            to: l.to,
            label: l.label || '',
            line: l.line || null,
            points: [
                { x: x1, y: y1 },
                { x: x1, y: midY },
                { x: x2, y: midY },
                { x: x2, y: y2 }
            ],
            x1, y1, x2, y2,
            lx: (x1 + x2) / 2 + labelOffX,
            ly: midY - 10
        });
    });

    // Сервис ↔ внешняя/человек: полосы ПОД рядом сервисов (не через правый коридор)
    const svcBottom = services.length
        ? Math.max(...services.map((n) => n.y + n.height))
        : top + bodyH;
    svcOuter.forEach((l, i) => {
        const a = byId.get(l.from);
        const b = byId.get(l.to);
        const aIsSvc = services.some((s) => s.id === a.id);
        const from = aIsSvc ? a : b;
        const to = aIsSvc ? b : a;
        const laneY = svcBottom + 28 + i * 26;
        const x1 = from.cx;
        const y1 = from.y + from.height;
        const toRight = to.x > from.x;
        const x2 = toRight ? to.x : to.x + to.width;
        const y2 = to.cy;
        const midX = toRight
            ? to.x - 36 - (i % 3) * 16
            : to.x + to.width + 36 + (i % 3) * 16;
        links.push({
            from: l.from,
            to: l.to,
            label: l.label || '',
            line: l.line || null,
            points: [
                { x: x1, y: y1 },
                { x: x1, y: laneY },
                { x: midX, y: laneY },
                { x: midX, y: y2 },
                { x: x2, y: y2 }
            ],
            x1, y1, x2, y2,
            lx: (x1 + midX) / 2,
            ly: laneY - 10
        });
    });

    svcSvc.forEach((l, i) => {
        const a = byId.get(l.from);
        const b = byId.get(l.to);
        const midY = Math.min(a.y, b.y) - 20 - i * 16;
        links.push({
            from: l.from,
            to: l.to,
            label: l.label || '',
            line: l.line || null,
            points: [
                { x: a.cx, y: a.y },
                { x: a.cx, y: midY },
                { x: b.cx, y: midY },
                { x: b.cx, y: b.y }
            ],
            x1: a.cx, y1: a.y, x2: b.cx, y2: b.y,
            lx: (a.cx + b.cx) / 2,
            ly: midY - 8
        });
    });

    otherLinks.forEach((l, i) => {
        const a = byId.get(l.from);
        const b = byId.get(l.to);
        const midY = Math.min(a.y, b.y) - 24 - (i % 3) * 16;
        links.push({
            from: l.from,
            to: l.to,
            label: l.label || '',
            line: l.line || null,
            points: [
                { x: a.cx, y: a.y },
                { x: a.cx, y: midY },
                { x: b.cx, y: midY },
                { x: b.cx, y: b.y }
            ],
            x1: a.cx, y1: a.y, x2: b.cx, y2: b.y,
            lx: (a.cx + b.cx) / 2,
            ly: midY - 8
        });
    });

    // Развести подписи: AABB по приблизительной ширине
    const labeled = links.filter((l) => l.label);
    labeled.forEach((l) => {
        l._lw = Math.min(150, Math.max(40, String(l.label).length * 6.2 + 14));
    });
    for (let pass = 0; pass < 6; pass++) {
        for (let i = 0; i < labeled.length; i++) {
            for (let j = i + 1; j < labeled.length; j++) {
                const a = labeled[i];
                const b = labeled[j];
                const dx = Math.abs(a.lx - b.lx);
                const dy = Math.abs(a.ly - b.ly);
                const overlapX = dx < (a._lw + b._lw) / 2 + 8;
                const overlapY = dy < 18;
                if (overlapX && overlapY) {
                    if (a.ly <= b.ly) b.ly = a.ly + 20;
                    else a.ly = b.ly + 20;
                }
            }
        }
    }

    const colLabels = {
        left: people.length ? { text: 'Люди', x: mainLeft + leftW / 2, y: titleH + pad - 4 } : null,
        center: { text: 'Система', x: primary.cx, y: titleH + pad - 4 },
        right: externals.length
            ? { text: 'Внешние', x: primary.x + primary.width + corridor + rightW / 2, y: titleH + pad - 4 }
            : null,
        services: services.length
            ? { text: 'Внутренние сервисы', x: width / 2, y: top + bodyH + 28 }
            : null
    };

    return {
        title: data.title || '',
        subtitle: 'Люди слева · система в центре · внешние справа. Стрелки = кто с чем связан',
        nodes,
        links,
        colLabels,
        width: Math.max(640, Math.ceil(width)),
        height: Math.max(420, Math.ceil(height))
    };
}
