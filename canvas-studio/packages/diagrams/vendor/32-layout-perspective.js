/**
 * Компоновка перспектив: колонки + боковая легенда сущностей (как у обратимости).
 */
function layoutPerspective(data, options = {}) {
    if (!data || !data.perspectives || !data.perspectives.length) {
        return { columns: [], entities: [], width: 0, height: 0, title: '' };
    }

    const cols = data.perspectives;
    const colGap = 28;
    const pad = 24;
    const headerH = 48;
    const titleH = 56;
    const nodeH = 34;
    const nodeGap = 10;
    const indentW = 14;
    const minColW = 188;
    const colW = Math.max(minColW, options.colWidth || 200);
    const listW = 288;

    function flattenTree(roots) {
        const out = [];
        function walk(node, depth) {
            out.push({ node, depth });
            (node.children || []).forEach((ch) => walk(ch, depth + 1));
        }
        (roots || []).forEach((r) => walk(r, 0));
        return out;
    }

    const wrapName = (name, maxW) => (typeof wrapTextLines === 'function'
        ? wrapTextLines(name, maxW, 11)
        : [String(name || '')]);

    let maxBodyH = 120;
    const columns = cols.map((p) => {
        const flat = flattenTree(p.roots);
        const items = flat.map((f, ri) => {
            const depth = f.depth;
            const w = colW - 24 - depth * indentW;
            const textW = Math.max(40, w - 34);
            const lines = wrapName(f.node.name, textW);
            const lineCount = Math.max(1, Math.min(lines.length, 6)); // полный текст, до 6 строк
            const h = Math.max(nodeH, 10 + lineCount * 13 + 8);
            return {
                name: f.node.name,
                nameLines: lines.slice(0, 6),
                depth,
                key: (p.name + '::' + f.node.name + '::' + ri).toLowerCase(),
                row: ri,
                linked: false,
                entityIds: [],
                line: f.node.line || null,
                sourceLine: f.node.line || null,
                h
            };
        });
        let yOff = 12;
        items.forEach((it) => {
            it.yOff = yOff;
            yOff += it.h + nodeGap;
        });
        maxBodyH = Math.max(maxBodyH, yOff + 12);
        return { name: p.name, index: 0, items, x: 0, width: colW };
    });
    columns.forEach((c, i) => { c.index = i; });

    const colsBlockW = columns.length * colW + Math.max(0, columns.length - 1) * colGap;
    const width = pad + colsBlockW + 20 + listW + pad;
    const bodyH = maxBodyH;
    const height = Math.max(titleH + headerH + bodyH + pad, titleH + 40 + 8 * 36);

    columns.forEach((col, i) => {
        col.x = pad + i * (colW + colGap);
        col.y = titleH;
        col.bodyY = col.y + headerH;
        col.height = headerH + bodyH;
        col.items.forEach((it) => {
            it.x = col.x + 12 + it.depth * indentW;
            it.y = col.bodyY + it.yOff;
            it.w = colW - 24 - it.depth * indentW;
            it.cx = it.x + it.w / 2;
            it.cy = it.y + it.h / 2;
        });
    });

    const byName = new Map();
    columns.forEach((col) => {
        col.items.forEach((it) => {
            const k = it.name.toLowerCase();
            if (!byName.has(k)) byName.set(k, []);
            byName.get(k).push({ col, item: it });
        });
    });

    function pickOnePerColumn(name) {
        const hits = byName.get(String(name || '').toLowerCase()) || [];
        const bestByCol = new Map();
        hits.forEach((h) => {
            const ci = h.col.index;
            const prev = bestByCol.get(ci);
            if (!prev
                || h.item.depth < prev.item.depth
                || (h.item.depth === prev.item.depth && h.item.row < prev.item.row)) {
                bestByCol.set(ci, h);
            }
        });
        return Array.from(bestByCol.values());
    }

    const entities = [];
    (data.aliases || []).forEach((alias) => {
        const points = [];
        const seenCols = new Set();
        alias.names.forEach((nm) => {
            pickOnePerColumn(nm).forEach((h) => {
                if (seenCols.has(h.col.index)) return;
                seenCols.add(h.col.index);
                points.push(h);
            });
        });
        if (points.length < 2) return;
        const id = entities.length + 1;
        points.forEach((p) => {
            p.item.linked = true;
            if (!p.item.entityIds.includes(id)) p.item.entityIds.push(id);
        });
        entities.push({
            id,
            names: alias.names,
            members: points.map((p) => ({
                name: p.item.name,
                role: p.col.name,
                col: p.col.index
            }))
        });
    });

    const listX = pad + colsBlockW + 20;
    const listY = titleH;
    const nameMaxW = listW - 52;
    const wrap = (typeof wrapTextLines === 'function')
        ? (t, fs) => wrapTextLines(t, nameMaxW, fs)
        : (t) => [String(t || '')];
    let listBodyH = 0;
    entities.forEach((ent) => {
        const parts = (ent.members || []).map((m) => m.name);
        const roles = (ent.members || []).map((m) => m.role);
        const titleLine = parts.join(' · ');
        const metaLine = roles.filter(Boolean).join(' / ');
        ent.titleLines = wrap(titleLine, 11);
        ent.metaLines = metaLine ? wrap(metaLine, 10) : [];
        ent.rowH = Math.max(
            36,
            8 + ent.titleLines.length * 14 + (ent.metaLines.length ? ent.metaLines.length * 13 + 4 : 0) + 8
        );
        listBodyH += ent.rowH;
    });
    const listH = Math.max(headerH + bodyH, 44 + listBodyH + 16);

    return {
        title: data.title || 'Диаграмма перспектив',
        columns,
        entities,
        width,
        height: Math.max(height, listY + listH + pad),
        titleH,
        headerH,
        pad,
        listX,
        listY,
        listW,
        listH,
        listBodyH
    };
}
