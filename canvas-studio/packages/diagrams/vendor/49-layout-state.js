/**
 * Раскладка диаграммы состояний сверху вниз (TB):
 * ранги = ряды, ветвления разведены по X, возвраты — боковые дорожки.
 * Высота растёт с содержимым — без «плоской» полоски.
 */
function layoutState(data) {
    if (!data || !data.states || !data.states.length) {
        return { nodes: [], edges: [], width: 0, height: 0, title: '' };
    }

    const nodes = data.states.map((s) => Object.assign({}, s));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edges = (data.transitions || []).filter((e) => byId.has(e.from) && byId.has(e.to));

    const fontSize = 13;
    const fontFam = (typeof getUiFontFamily === 'function')
        ? getUiFontFamily()
        : 'system-ui, sans-serif';

    nodes.forEach((n) => {
        if (n.kind === 'initial' || n.kind === 'final') {
            n.width = 28;
            n.height = 28;
            n.lines = [n.label];
            return;
        }
        const label = String(n.label || n.id);
        const lines = (typeof wrapTextLines === 'function')
            ? wrapTextLines(label, 140, fontSize, fontFam)
            : [label];
        n.lines = lines.slice(0, 3);
        let maxLine = 56;
        n.lines.forEach((l) => {
            const w = String(l).length * fontSize * 0.56;
            if (w > maxLine) maxLine = w;
        });
        n.width = Math.max(128, Math.min(220, maxLine + 40));
        n.height = Math.max(56, n.lines.length * 18 + 30);
    });

    const outs = new Map();
    const ins = new Map();
    nodes.forEach((n) => { outs.set(n.id, []); ins.set(n.id, []); });
    edges.forEach((e) => {
        outs.get(e.from).push(e.to);
        ins.get(e.to).push(e.from);
    });

    // Longest-path ранги (вперёд по ациклической ориентации)
    const rank = new Map();
    nodes.forEach((n) => rank.set(n.id, 0));
    const initials = nodes.filter((n) => n.kind === 'initial');
    const sources = nodes.filter((n) => n.kind === 'initial' || !(ins.get(n.id) || []).length);
    const startIds = initials.length
        ? initials.map((n) => n.id)
        : (sources.length ? sources.map((n) => n.id) : [nodes[0].id]);

    // Удаляем обратные рёбра для раскладки: оставляем только DAG по BFS-слою
    const dagOut = new Map();
    nodes.forEach((n) => dagOut.set(n.id, []));
    const bfsRank = new Map();
    const q0 = startIds.slice();
    startIds.forEach((id) => bfsRank.set(id, 0));
    while (q0.length) {
        const id = q0.shift();
        const r = bfsRank.get(id) || 0;
        (outs.get(id) || []).forEach((to) => {
            if (!bfsRank.has(to)) {
                bfsRank.set(to, r + 1);
                q0.push(to);
            }
        });
    }
    edges.forEach((e) => {
        const ra = bfsRank.has(e.from) ? bfsRank.get(e.from) : 0;
        const rb = bfsRank.has(e.to) ? bfsRank.get(e.to) : 0;
        if (rb > ra) dagOut.get(e.from).push(e.to);
        else if (rb === ra && e.from !== e.to) {
            // same-rank: не влияет на longest-path
        }
        // rb < ra → обратное, в DAG не берём
    });

    // Топологический longest-path по DAG
    const indeg = new Map();
    nodes.forEach((n) => indeg.set(n.id, 0));
    dagOut.forEach((tos) => tos.forEach((to) => indeg.set(to, (indeg.get(to) || 0) + 1)));
    const topo = [];
    const q = [];
    nodes.forEach((n) => {
        if ((indeg.get(n.id) || 0) === 0) q.push(n.id);
    });
    while (q.length) {
        const id = q.shift();
        topo.push(id);
        (dagOut.get(id) || []).forEach((to) => {
            indeg.set(to, (indeg.get(to) || 0) - 1);
            if (indeg.get(to) === 0) q.push(to);
        });
    }
    startIds.forEach((id) => rank.set(id, 0));
    topo.forEach((id) => {
        const base = rank.get(id) || 0;
        (dagOut.get(id) || []).forEach((to) => {
            rank.set(to, Math.max(rank.get(to) || 0, base + 1));
        });
    });
    nodes.forEach((n) => {
        if (!rank.has(n.id) || (!bfsRank.has(n.id) && n.kind === 'normal')) {
            const mx = Math.max(0, ...Array.from(rank.values()));
            rank.set(n.id, mx);
        }
    });

    nodes.forEach((n) => {
        if (n.kind === 'initial') rank.set(n.id, 0);
    });
    const finals = nodes.filter((n) => n.kind === 'final');
    if (finals.length) {
        const nonFinalMax = Math.max(
            0,
            ...nodes.filter((n) => n.kind !== 'final').map((n) => rank.get(n.id) || 0)
        );
        finals.forEach((n) => rank.set(n.id, nonFinalMax + 1));
    }

    // Изоляты без рёбер — отдельный ряд внизу перед финалом
    const maxConnected = Math.max(
        0,
        ...nodes
            .filter((n) => ((ins.get(n.id) || []).length + (outs.get(n.id) || []).length) > 0)
            .map((n) => rank.get(n.id) || 0)
    );
    nodes.forEach((n) => {
        const deg = (ins.get(n.id) || []).length + (outs.get(n.id) || []).length;
        if (!deg && n.kind === 'normal') rank.set(n.id, maxConnected);
    });

    nodes.forEach((n) => { n.rank = rank.get(n.id) || 0; });
    const maxR = Math.max(...nodes.map((n) => n.rank), 0);

    const ranks = [];
    for (let r = 0; r <= maxR; r++) {
        const layer = nodes.filter((n) => n.rank === r);
        if (layer.length) ranks.push(layer);
    }

    function orderPass(forward) {
        const seq = forward
            ? ranks.map((_, i) => i)
            : ranks.map((_, i) => ranks.length - 1 - i);
        seq.forEach((ri) => {
            const layer = ranks[ri];
            layer.forEach((n) => {
                const neigh = forward ? (ins.get(n.id) || []) : (outs.get(n.id) || []);
                if (!neigh.length) {
                    n._bary = layer.indexOf(n);
                    return;
                }
                let sum = 0;
                let cnt = 0;
                neigh.forEach((id) => {
                    const other = byId.get(id);
                    if (!other) return;
                    const layerO = ranks.find((L) => L.some((x) => x.id === other.id)) || [];
                    const idx = layerO.indexOf(other);
                    if (idx >= 0) { sum += idx; cnt += 1; }
                });
                n._bary = cnt ? sum / cnt : layer.indexOf(n);
            });
            layer.sort((a, b) => {
                if (a.kind === 'initial') return -1;
                if (b.kind === 'initial') return 1;
                if (a.kind === 'final') return 1;
                if (b.kind === 'final') return -1;
                return a._bary - b._bary;
            });
            ranks[ri] = layer;
        });
    }
    orderPass(true);
    orderPass(false);
    orderPass(true);

    const gapX = 96;
    const gapY = 128;
    const pad = 56;
    const titleH = 56;
    const sideLanePad = 100;
    const labelLane = 36;

    // Ширина рядов → maxRowW (не растягивать узлы слишком далеко — плотнее по смыслу)
    let maxRowW = 0;
    ranks.forEach((layer) => {
        let w = 0;
        layer.forEach((n, i) => { w += n.width + (i ? gapX : 0); });
        if (layer.length === 1) w = Math.max(w, 200);
        if (w > maxRowW) maxRowW = w;
    });
    maxRowW = Math.max(maxRowW, 360);

    let y = titleH + pad;
    ranks.forEach((layer, li) => {
        let totalW = 0;
        layer.forEach((n, i) => { totalW += n.width + (i ? gapX : 0); });
        const useGap = gapX;
        totalW = layer.reduce((s, n) => s + n.width, 0) + useGap * Math.max(0, layer.length - 1);
        let x = pad + sideLanePad + Math.max(0, (maxRowW - totalW) / 2);
        const rowH = Math.max(...layer.map((n) => n.height), 56);
        layer.forEach((n) => {
            n.x = x;
            n.y = y + (rowH - n.height) / 2;
            n.cx = n.x + n.width / 2;
            n.cy = n.y + n.height / 2;
            x += n.width + useGap;
        });
        // Анти-наложение внутри ряда
        for (let i = 1; i < layer.length; i++) {
            const prev = layer[i - 1];
            const cur = layer[i];
            const minX = prev.x + prev.width + 28;
            if (cur.x < minX) {
                const shift = minX - cur.x;
                for (let j = i; j < layer.length; j++) {
                    layer[j].x += shift;
                    layer[j].cx = layer[j].x + layer[j].width / 2;
                }
            }
        }
        y += rowH + gapY + (li < ranks.length - 1 ? labelLane : 0);
    });

    // Пересчитать maxRowW после сдвигов
    maxRowW = Math.max(
        maxRowW,
        ...ranks.map((layer) => {
            if (!layer.length) return 0;
            const left = Math.min(...layer.map((n) => n.x));
            const right = Math.max(...layer.map((n) => n.x + n.width));
            return right - left;
        })
    );

    const contentBottom = y - gapY;
    const width = pad * 2 + sideLanePad * 2 + maxRowW;
    const height = Math.max(640, contentBottom + pad + 40);

    const outSlot = new Map();
    const inSlot = new Map();
    edges.forEach((e) => {
        outSlot.set(e.from, (outSlot.get(e.from) || 0) + 1);
        inSlot.set(e.to, (inSlot.get(e.to) || 0) + 1);
    });
    const outIdx = new Map();
    const inIdx = new Map();

    function nextSlot(map, id, total) {
        const i = map.get(id) || 0;
        map.set(id, i + 1);
        if (total <= 1) return 0;
        return (i - (total - 1) / 2) * 14;
    }

    function port(n, side, off) {
        const o = off || 0;
        if (side === 'bottom') return { x: Math.max(n.x + 10, Math.min(n.x + n.width - 10, n.cx + o)), y: n.y + n.height };
        if (side === 'top') return { x: Math.max(n.x + 10, Math.min(n.x + n.width - 10, n.cx + o)), y: n.y };
        if (side === 'left') return { x: n.x, y: Math.max(n.y + 8, Math.min(n.y + n.height - 8, n.cy + o)) };
        return { x: n.x + n.width, y: Math.max(n.y + 8, Math.min(n.y + n.height - 8, n.cy + o)) };
    }

    let backSeq = 0;
    const forwardByGap = new Map(); // key: fromRank->toRank → count
    const laidEdges = edges.map((e) => {
        const a = byId.get(e.from);
        const b = byId.get(e.to);
        const forward = a.rank < b.rank;
        const same = a.rank === b.rank;
        const oOff = nextSlot(outIdx, e.from, outSlot.get(e.from) || 1);
        const iOff = nextSlot(inIdx, e.to, inSlot.get(e.to) || 1);

        let x1; let y1; let x2; let y2;
        let cx1; let cy1; let cx2; let cy2;
        let lx; let ly;

        if (forward) {
            const p1 = port(a, 'bottom', oOff);
            const p2 = port(b, 'top', iOff);
            x1 = p1.x; y1 = p1.y; x2 = p2.x; y2 = p2.y;
            const gapKey = a.rank + '>' + b.rank;
            const gapIdx = forwardByGap.get(gapKey) || 0;
            forwardByGap.set(gapKey, gapIdx + 1);
            const aligned = Math.abs(x2 - x1) < 12;

            // Прямая вертикаль, если узлы друг под другом
            if (aligned) {
                const x = (x1 + x2) / 2;
                lx = x + 14;
                ly = (y1 + y2) / 2;
                return {
                    from: e.from, to: e.to, label: e.label || '',
                    line: e.line || null, sourceLine: e.line || null,
                    route: 'forward',
                    orth: true,
                    points: [
                        { x: x, y: y1 },
                        { x: x, y: y2 }
                    ],
                    x1: x, y1, x2: x, y2, cx1: x, cy1: (y1 + y2) / 2, cx2: x, cy2: (y1 + y2) / 2, lx, ly
                };
            }

            // Ортогональный локоть с уникальной midY — без наложений параллельных стрелок
            const midY = y1 + (y2 - y1) * (0.35 + (gapIdx % 4) * 0.12);
            lx = (x1 + x2) / 2;
            ly = midY - 10;
            return {
                from: e.from, to: e.to, label: e.label || '',
                line: e.line || null, sourceLine: e.line || null,
                route: 'forward',
                orth: true,
                points: [
                    { x: x1, y: y1 },
                    { x: x1, y: midY },
                    { x: x2, y: midY },
                    { x: x2, y: y2 }
                ],
                x1, y1, x2, y2, cx1: x1, cy1: midY, cx2: x2, cy2: midY, lx, ly
            };
        }

        if (same) {
            const p1 = port(a, 'right', oOff);
            const p2 = port(b, 'right', iOff);
            x1 = p1.x; y1 = p1.y; x2 = p2.x; y2 = p2.y;
            const bump = 44 + Math.abs(oOff) + Math.abs(y2 - y1) * 0.12;
            cx1 = x1 + bump; cy1 = y1;
            cx2 = x2 + bump; cy2 = y2;
            lx = x1 + bump + 6;
            ly = (y1 + y2) / 2;
            return {
                from: e.from, to: e.to, label: e.label || '',
                line: e.line || null, sourceLine: e.line || null,
                route: 'same',
                orth: true,
                points: [
                    { x: x1, y: y1 },
                    { x: cx1, y: y1 },
                    { x: cx2, y: y2 },
                    { x: x2, y: y2 }
                ],
                x1, y1, x2, y2, cx1, cy1, cx2, cy2, lx, ly
            };
        }

        // назад — боковая дорожка (чередуемлево/право)
        const lane = backSeq++;
        const leftSide = lane % 2 === 0;
        const p1 = port(a, leftSide ? 'left' : 'right', oOff);
        const p2 = port(b, leftSide ? 'left' : 'right', iOff);
        x1 = p1.x; y1 = p1.y; x2 = p2.x; y2 = p2.y;
        const laneX = leftSide
            ? pad + 18 + Math.floor(lane / 2) * 22
            : width - pad - 18 - Math.floor(lane / 2) * 22;
        return {
            from: e.from, to: e.to, label: e.label || '',
            line: e.line || null, sourceLine: e.line || null,
            route: 'back',
            orth: true,
            points: [
                { x: x1, y: y1 },
                { x: laneX, y: y1 },
                { x: laneX, y: y2 },
                { x: x2, y: y2 }
            ],
            x1, y1, x2, y2,
            cx1: laneX, cy1: y1, cx2: laneX, cy2: y2,
            lx: laneX + (leftSide ? 10 : -10),
            ly: (y1 + y2) / 2
        };
    });

    // Развести подписи: не ближе 18px по Y
    const labeled = laidEdges.filter((e) => e.label).sort((a, b) => a.ly - b.ly);
    for (let i = 1; i < labeled.length; i++) {
        const prev = labeled[i - 1];
        const cur = labeled[i];
        if (Math.abs(cur.lx - prev.lx) < 120 && cur.ly - prev.ly < 18) {
            cur.ly = prev.ly + 18;
        }
    }

    return {
        title: data.title || '',
        orientation: 'tb',
        nodes,
        edges: laidEdges,
        width: Math.max(420, Math.ceil(width)),
        height: Math.max(640, Math.ceil(height))
    };
}
