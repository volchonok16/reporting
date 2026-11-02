/**
 * Компоновка карты обратимости: боль ошибки (Y) × цена отката (X).
 * Подписи — в боковом списке; ×N — тоже в списке связей, не на точках.
 */
function layoutReversibility(data, options = {}) {
    if (!data || !data.nodes || !data.nodes.length) {
        return { nodes: [], links: [], width: 0, height: 0, title: '' };
    }

    const listW = 300;
    const width = options.width || 1140;
    const height = options.height || 680;
    const padL = 72;
    const padR = listW + 28;
    const padT = 78;
    const padB = 64;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    function sx(irrev) {
        return padL + (Math.max(0, Math.min(100, irrev)) / 100) * plotW;
    }
    function sy(impact) {
        return padT + plotH - (Math.max(0, Math.min(100, impact)) / 100) * plotH;
    }

    const nodes = data.nodes.map((n, i) => {
        const impact = n.impact;
        const irrev = n.irreversibility;
        const danger = (impact + irrev) / 2;
        let zone = 'plateau';
        // Четверти: низ-лево плато, верх-лево хребет, верх-право ущелье, низ-право ловушка
        if (impact >= 55 && irrev >= 55) zone = 'canyon';
        else if (impact < 55 && irrev >= 55) zone = 'trap';
        else if (impact >= 50 && irrev < 50) zone = 'ridge';
        else if (impact >= 40 || irrev >= 40) zone = 'ridge';
        else zone = 'plateau';

        return {
            id: i,
            num: i + 1,
            name: n.name,
            impact,
            irreversibility: irrev,
            confidence: n.confidence === 'fact' ? 'fact' : 'hyp',
            zone,
            danger,
            x: sx(irrev),
            y: sy(impact),
            r: 12
        };
    });

    for (let pass = 0; pass < 4; pass++) {
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const a = nodes[i];
                const b = nodes[j];
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const dist = Math.hypot(dx, dy) || 0.01;
                const minD = a.r + b.r + 8;
                if (dist < minD) {
                    const push = (minD - dist) / 2;
                    const ux = dx / dist;
                    const uy = dy / dist;
                    a.x = Math.max(padL + 10, Math.min(padL + plotW - 10, a.x - ux * push));
                    a.y = Math.max(padT + 10, Math.min(padT + plotH - 10, a.y - uy * push));
                    b.x = Math.max(padL + 10, Math.min(padL + plotW - 10, b.x + ux * push));
                    b.y = Math.max(padT + 10, Math.min(padT + plotH - 10, b.y + uy * push));
                }
            }
        }
    }

    const byName = new Map(nodes.map((n) => [n.name.toLowerCase(), n]));
    const links = (data.links || []).map((l, idx) => {
        const from = byName.get(String(l.from || '').toLowerCase());
        const to = byName.get(String(l.to || '').toLowerCase());
        if (!from || !to) return null;
        const midY = (from.y + to.y) / 2;
        const preferUp = midY > padT + plotH * 0.45;
        const bend = (preferUp ? -1 : 1) * (48 + (idx % 3) * 20);
        return {
            from,
            to,
            factor: l.factor,
            bend,
            fromNum: from.num,
            toNum: to.num
        };
    }).filter(Boolean);

    // Точка на кривой, максимально далеко от всех узлов — для крошечной метки (если нужна)
    function bestLabelPoint(lnk) {
        const x1 = lnk.from.x;
        const y1 = lnk.from.y;
        const x2 = lnk.to.x;
        const y2 = lnk.to.y;
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2 + lnk.bend;
        let best = { x: mx, y: my, score: -Infinity };
        for (let t = 0.2; t <= 0.8; t += 0.1) {
            // квадратичная Безье
            const ox = (1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * mx + t * t * x2;
            const oy = (1 - t) * (1 - t) * y1 + 2 * (1 - t) * t * my + t * t * y2;
            let minD = Infinity;
            nodes.forEach((n) => {
                minD = Math.min(minD, Math.hypot(ox - n.x, oy - n.y) - n.r);
            });
            if (minD > best.score) best = { x: ox, y: oy, score: minD };
        }
        // если всё равно близко к узлу — прячем метку с поля
        lnk.showChip = false; // ×N только в списке справа
        lnk.chipX = best.x;
        lnk.chipY = best.y;
        return lnk;
    }
    links.forEach(bestLabelPoint);

    const listX = width - listW - 16;
    const listY = padT; // верх легенды = верх поля графика
    const listItems = nodes.map((n) => ({
        num: n.num,
        name: n.name,
        impact: n.impact,
        irreversibility: n.irreversibility,
        confidence: n.confidence,
        zone: n.zone
    }));
    const linkNotes = links.map((l) => ({
        fromNum: l.fromNum,
        toNum: l.toNum,
        fromName: l.from.name,
        toName: l.to.name,
        factor: l.factor
    }));
    const nameMaxW = listW - 52;
    const wrap = (typeof wrapTextLines === 'function')
        ? (t, fs) => wrapTextLines(t, nameMaxW, fs)
        : (t) => [String(t || '')];
    let listBodyH = 0;
    listItems.forEach((it) => {
        const nameLines = wrap(it.name, 11);
        it.nameLines = nameLines;
        it.rowH = Math.max(36, 8 + nameLines.length * 14 + 18);
        listBodyH += it.rowH;
    });
    let linkBlockH = 0;
    if (linkNotes.length) {
        linkBlockH = 22;
        linkNotes.forEach((ln) => {
            const fac = Number.isInteger(ln.factor) ? String(ln.factor) : String(ln.factor);
            const line = ln.fromNum + ' → ' + ln.toNum + ': откат ×' + fac
                + (ln.fromName && ln.toName ? ' (' + ln.fromName + ' → ' + ln.toName + ')' : '');
            ln.lines = wrap(line, 10);
            ln.rowH = Math.max(16, ln.lines.length * 13);
            linkBlockH += ln.rowH;
        });
    }
    const needH = listY + 44 + listBodyH + linkBlockH + 56;
    const finalHeight = Math.max(height, needH);

    return {
        title: data.title || 'Карта обратимости',
        nodes,
        links,
        listItems,
        linkNotes,
        listX,
        listY,
        listW,
        listBodyH,
        linkBlockH,
        width,
        height: finalHeight,
        padL,
        padR,
        padT,
        padB,
        plotW,
        plotH
    };
}
