/**
 * Компоновка блок-схемы: упаковка поддеревьев + порты по форме + ортогональные рёбра.
 */
function layoutFlowchart(data, options) {
    options = options || {};
    if (!data || !data.nodes || !data.nodes.length) {
        return { nodes: [], edges: [], width: 0, height: 0, title: '', direction: 'tb' };
    }

    const direction = data.direction === 'lr' ? 'lr' : 'tb';
    const nodes = data.nodes.map((n) => Object.assign({}, n));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edges = (data.edges || []).filter((e) => byId.has(e.from) && byId.has(e.to));

    const fontSize = 13;
    const fontFam = (typeof getUiFontFamily === 'function')
        ? getUiFontFamily()
        : 'system-ui, sans-serif';
    const lineH = fontSize * 1.3;
    // Mermaid/Lucidchart-like: щедрее воздух между узлами, чем «плотная упаковка»
    const padX = 22;
    const padY = 16;
    const minW = 80;
    const minH = 40;
    const gapSib = direction === 'tb' ? 56 : 44;
    const arrowClear = 15;
    const edgeLabelFs = 11;
    const edgeLabelMaxW = 128;
    const edgeLabelPad = 14; // зазор подпись ↔ узел
    const cornerR = 10;

    function labeledOutCount(id) {
        let n = 0;
        edges.forEach((e) => {
            if (e.from === id && e.label && String(e.label).trim()) n += 1;
        });
        return n;
    }

    function measureEdgeLabel(str) {
        if (typeof document !== 'undefined') {
            const c = layoutFlowchart._cEdge
                || (layoutFlowchart._cEdge = document.createElement('canvas'));
            const ctx = c.getContext('2d');
            ctx.font = '700 ' + edgeLabelFs + 'px ' + fontFam;
            return ctx.measureText(String(str || '')).width;
        }
        return String(str || '').length * edgeLabelFs * 0.62;
    }

    function wrapEdgeLabel(str) {
        const raw = String(str || '').trim();
        if (!raw) return { lines: [], w: 0, h: 0 };
        let lines = (typeof wrapTextLines === 'function')
            ? wrapTextLines(raw, edgeLabelMaxW, edgeLabelFs, fontFam)
            : [raw];
        if (!lines.length) lines = [raw];
        if (lines.length > 3) {
            lines = lines.slice(0, 2).concat([lines.slice(2).join(' ')]);
        }
        const tw = Math.max(...lines.map(measureEdgeLabel), 28);
        const th = lines.length * (edgeLabelFs * 1.25) + 8;
        return { lines, w: Math.ceil(tw + 16), h: Math.ceil(th) };
    }

    // Предрасчёт подписей — от них зависит rank gap (как nodeSpacing/rankSpacing у Mermaid)
    const edgeWrap = edges.map((e) => wrapEdgeLabel(e.label || ''));
    const maxEdgeLabelH = edgeWrap.reduce((m, w) => Math.max(m, w.h || 0), 0);
    const hasEdgeLabels = maxEdgeLabelH > 0;
    const gapRank = direction === 'tb'
        ? (hasEdgeLabels ? Math.max(128, 72 + maxEdgeLabelH + edgeLabelPad * 2) : 80)
        : (hasEdgeLabels ? Math.max(140, 84 + maxEdgeLabelH + edgeLabelPad * 2) : 96);

    function measureLine(str) {
        if (typeof document !== 'undefined') {
            const c = layoutFlowchart._c || (layoutFlowchart._c = document.createElement('canvas'));
            const ctx = c.getContext('2d');
            ctx.font = '600 ' + fontSize + 'px ' + fontFam;
            return ctx.measureText(String(str || '')).width;
        }
        return String(str || '').length * fontSize * 0.58;
    }

    nodes.forEach((n) => {
        const label = String(n.label || n.id);
        const shape = n.shape || 'rect';
        // Сначала черновая ширина переноса — потом подогоним блок под строки
        // Ромб: шире перенос → меньше строк → компактнее фигура (draw.io practice)
        let wrapMax = shape === 'diamond' ? 148
            : (shape === 'circle' ? 100
                : (shape === 'cylinder' ? 140
                    : (shape === 'parallelogram' ? 156 : 168)));
        let lines = (typeof wrapTextLines === 'function')
            ? wrapTextLines(label, wrapMax, fontSize, fontFam)
            : [label];
        // Длинное слово без пробелов — расширяем перенос
        let maxLine = Math.max(...lines.map(measureLine), 40);
        if (maxLine > wrapMax) {
            wrapMax = Math.min(280, Math.ceil(maxLine + 8));
            lines = (typeof wrapTextLines === 'function')
                ? wrapTextLines(label, wrapMax, fontSize, fontFam)
                : [label];
            maxLine = Math.max(...lines.map(measureLine), 40);
        }
        n.lines = lines;
        const textW = maxLine;
        const textH = Math.max(lineH, lines.length * lineH);

        let w;
        let h;
        if (shape === 'diamond') {
            // Компактный ромб: текст занимает ~42% высоты, ширина из вписанного прямоугольника
            const needW = textW + padX;
            const needH = textH + padY;
            const k = 2.35; // diamondH / textBlockH
            h = Math.max(minH + 24, needH * k);
            w = Math.max(minW + 32, needW * (k / (k - 1)) * 1.06, h * 1.05);
            for (let i = 0; i < 6; i++) {
                const usableW = w * (1 - Math.min(0.78, needH / h));
                if (usableW >= needW + 2) break;
                w = (needW + 2) / Math.max(0.25, (1 - needH / h)) + 8;
                h = Math.max(h, needH * k, w * 0.72);
            }
            const usable = Math.max(64, w * (1 - Math.min(0.78, needH / h)) - 8);
            if (Math.abs(usable - wrapMax) > 8) {
                lines = (typeof wrapTextLines === 'function')
                    ? wrapTextLines(label, usable, fontSize, fontFam)
                    : [label];
                n.lines = lines;
                const tw = Math.max(...lines.map(measureLine), 40);
                const th = Math.max(lineH, lines.length * lineH);
                const nw = tw + padX;
                const nh = th + padY;
                h = Math.max(minH + 24, nh * k);
                w = Math.max(minW + 32, nw * (k / (k - 1)) * 1.06, h * 1.05);
                for (let i = 0; i < 4; i++) {
                    const u2 = w * (1 - Math.min(0.78, nh / h));
                    if (u2 >= nw + 2) break;
                    w = (nw + 2) / Math.max(0.25, (1 - nh / h)) + 8;
                    h = Math.max(h, nh * k, w * 0.72);
                }
            }
        } else if (shape === 'circle') {
            // Вписанный квадрат ≈ D/√2
            const need = Math.max(textW + padX, textH + padY);
            const d = Math.max(minW + 16, need * Math.SQRT2 + 12);
            w = d;
            h = d;
            const usable = d / Math.SQRT2 - 8;
            lines = (typeof wrapTextLines === 'function')
                ? wrapTextLines(label, Math.max(50, usable), fontSize, fontFam)
                : [label];
            n.lines = lines;
            const tw = Math.max(...lines.map(measureLine), 40);
            const th = Math.max(lineH, lines.length * lineH);
            const d2 = Math.max(d, Math.max(tw + padX, th + padY) * Math.SQRT2 + 12);
            w = d2;
            h = d2;
        } else {
            w = Math.max(minW, textW + padX * 2);
            h = Math.max(minH, textH + padY * 2);
            if (shape === 'parallelogram') w += 28;
            if (shape === 'subroutine') w += 8;
            if (shape === 'stadium') w = Math.max(w, h + 28);
            if (shape === 'cylinder') h += 16;
            if (shape === 'document') h += 10;
            if (n.assignee || n.initials || n.deadlineLabel) h += 14;
        }
        if ((shape === 'diamond' || shape === 'circle')
            && (n.assignee || n.initials || n.deadlineLabel)) {
            h += 14;
            if (shape === 'circle') w = Math.max(w, h);
        }
        n.width = w;
        n.height = h;
    });

    const outs = new Map();
    const ins = new Map();
    nodes.forEach((n) => { outs.set(n.id, []); ins.set(n.id, []); });
    edges.forEach((e) => {
        outs.get(e.from).push(e.to);
        ins.get(e.to).push(e.from);
    });
    outs.forEach((list, id) => {
        const seen = Object.create(null);
        outs.set(id, list.filter((to) => {
            if (seen[to]) return false;
            seen[to] = 1;
            return true;
        }));
    });

    const primaryParent = new Map();
    edges.forEach((e) => {
        if (!primaryParent.has(e.to)) primaryParent.set(e.to, e.from);
    });

    const childrenOf = (id) => (outs.get(id) || []).filter((cid) => primaryParent.get(cid) === id);

    const sources = nodes.filter((n) => !(ins.get(n.id) || []).length);
    const roots = sources.length ? sources : [nodes[0]];

    const spanCache = new Map();
    function measureSpan(id, visiting) {
        if (spanCache.has(id)) return spanCache.get(id);
        if (visiting.has(id)) {
            const n = byId.get(id);
            return direction === 'tb' ? n.width : n.height;
        }
        visiting.add(id);
        const n = byId.get(id);
        const kids = childrenOf(id);
        let span;
        if (!kids.length) {
            span = direction === 'tb' ? n.width : n.height;
        } else {
            const childSpans = kids.map((cid) => measureSpan(cid, visiting));
            // Twin-подписи требуют шире щели между колонками детей
            const sibGap = gapSib + (labeledOutCount(id) >= 2 ? 40 : 0);
            const kidsSpan = childSpans.reduce((s, v) => s + v, 0) + sibGap * (kids.length - 1);
            const selfSpan = direction === 'tb' ? n.width : n.height;
            span = Math.max(selfSpan, kidsSpan);
        }
        visiting.delete(id);
        spanCache.set(id, span);
        return span;
    }
    roots.forEach((r) => measureSpan(r.id, new Set()));

    const placed = new Set();
    const padL = 48;
    const padT = data.title ? 64 : 44;
    const padR = 48;
    const padB = 44;

    function placeTree(id, originMain, originCross, visiting) {
        if (visiting.has(id)) return { span: 0, depth: 0 };
        visiting.add(id);
        const n = byId.get(id);
        const kids = childrenOf(id);
        const span = spanCache.get(id) || (direction === 'tb' ? n.width : n.height);

        if (direction === 'tb') {
            n.x = originMain + (span - n.width) / 2;
            n.y = originCross;
            placed.add(id);
            let depth = n.height;
            if (kids.length) {
                const childSpans = kids.map((cid) => spanCache.get(cid) || byId.get(cid).width);
                const sibGap = gapSib + (labeledOutCount(id) >= 2 ? 40 : 0);
                const kidsSpan = childSpans.reduce((s, v) => s + v, 0) + sibGap * (kids.length - 1);
                // Центрируем группу детей под слотом родителя
                let x = originMain + (span - kidsSpan) / 2;
                const childTop = originCross + n.height + gapRank;
                let maxChildDepth = 0;
                kids.forEach((cid, i) => {
                    const sub = placeTree(cid, x, childTop, visiting);
                    x += childSpans[i] + sibGap;
                    maxChildDepth = Math.max(maxChildDepth, sub.depth);
                });
                depth = n.height + gapRank + maxChildDepth;
            }
            visiting.delete(id);
            return { span, depth };
        }

        n.y = originMain + (span - n.height) / 2;
        n.x = originCross;
        placed.add(id);
        let depth = n.width;
        if (kids.length) {
            const childSpans = kids.map((cid) => spanCache.get(cid) || byId.get(cid).height);
            const sibGap = gapSib + (labeledOutCount(id) >= 2 ? 40 : 0);
            const kidsSpan = childSpans.reduce((s, v) => s + v, 0) + sibGap * (kids.length - 1);
            let y = originMain + (span - kidsSpan) / 2;
            const childLeft = originCross + n.width + gapRank;
            let maxChildDepth = 0;
            kids.forEach((cid, i) => {
                const sub = placeTree(cid, y, childLeft, visiting);
                y += childSpans[i] + sibGap;
                maxChildDepth = Math.max(maxChildDepth, sub.depth);
            });
            depth = n.width + gapRank + maxChildDepth;
        }
        visiting.delete(id);
        return { span, depth };
    }

    let cursor = direction === 'tb' ? padL : padT;
    let maxDepth = 0;
    let totalSpan = 0;
    roots.forEach((r, i) => {
        const span = spanCache.get(r.id) || (direction === 'tb' ? r.width : r.height);
        const sub = placeTree(r.id, cursor, direction === 'tb' ? padT : padL, new Set());
        cursor += span + (i < roots.length - 1 ? gapSib * 2 : 0);
        totalSpan += span + (i < roots.length - 1 ? gapSib * 2 : 0);
        maxDepth = Math.max(maxDepth, sub.depth);
    });

    nodes.forEach((n) => {
        if (placed.has(n.id)) return;
        if (direction === 'tb') {
            n.x = padL;
            n.y = padT + maxDepth + gapRank;
            maxDepth += n.height + gapRank;
            totalSpan = Math.max(totalSpan, n.width);
        } else {
            n.x = padL + maxDepth + gapRank;
            n.y = padT;
            maxDepth += n.width + gapRank;
            totalSpan = Math.max(totalSpan, n.height);
        }
        placed.add(n.id);
    });

    let width;
    let height;
    if (direction === 'tb') {
        width = padL + totalSpan + padR;
        height = padT + maxDepth + padB;
    } else {
        width = padL + maxDepth + padR;
        height = padT + totalSpan + padB;
    }

    nodes.forEach((n) => {
        n.cx = n.x + n.width / 2;
        n.cy = n.y + n.height / 2;
        n.rank = null;
    });

    const layout = {
        title: data.title || '',
        direction,
        nodes,
        edges: edges.map((e) => ({
            from: e.from,
            to: e.to,
            label: e.label || '',
            line: e.line || e.sourceLine || null,
            sourceLine: e.line || e.sourceLine || null
        })),
        width: Math.max(320, Math.ceil(width)),
        height: Math.max(200, Math.ceil(height)),
        _autoPos: {}
    };
    layout.nodes.forEach((n) => {
        layout._autoPos[n.id] = { x: n.x, y: n.y };
    });
    return layoutFlowchartReroute(layout);
}

/**
 * Применить dx/dy overrides к авто-раскладке и пересчитать рёбра.
 * layout._autoPos — позиции до ручных сдвигов (обновляется при сдвиге холста в +).
 */
function applyFlowchartManualOffsets(layout, overrides) {
    if (!layout || !Array.isArray(layout.nodes) || !layout.nodes.length) return layout;
    if (!layout._autoPos) {
        layout._autoPos = {};
        layout.nodes.forEach((n) => {
            layout._autoPos[n.id] = { x: n.x, y: n.y };
        });
    }
    const nodesMap = (overrides && overrides.nodes) || {};
    layout.nodes.forEach((n) => {
        if (!layout._autoPos[n.id]) layout._autoPos[n.id] = { x: n.x, y: n.y };
        const base = layout._autoPos[n.id];
        const o = nodesMap[String(n.id)] || {};
        n.x = base.x + (Number(o.dx) || 0);
        n.y = base.y + (Number(o.dy) || 0);
        n.cx = n.x + n.width / 2;
        n.cy = n.y + n.height / 2;
    });

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    layout.nodes.forEach((n) => {
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + n.width);
        maxY = Math.max(maxY, n.y + n.height);
    });
    const shiftX = (Number.isFinite(minX) && minX < 24) ? (24 - minX) : 0;
    const shiftY = (Number.isFinite(minY) && minY < 48) ? (48 - minY) : 0;
    if (shiftX || shiftY) {
        layout.nodes.forEach((n) => {
            n.x += shiftX;
            n.y += shiftY;
            n.cx += shiftX;
            n.cy += shiftY;
        });
        Object.keys(layout._autoPos).forEach((id) => {
            layout._autoPos[id].x += shiftX;
            layout._autoPos[id].y += shiftY;
        });
        maxX += shiftX;
        maxY += shiftY;
    }
    if (Number.isFinite(maxX) && Number.isFinite(maxY)) {
        layout.width = Math.max(layout.width || 0, Math.ceil(maxX + 40), 320);
        layout.height = Math.max(layout.height || 0, Math.ceil(maxY + 40), 200);
    }
    return layoutFlowchartReroute(layout);
}

/**
 * Пересчитать ортогональные рёбра и подписи по текущим координатам узлов.
 */
function layoutFlowchartReroute(layout) {
    if (!layout || !Array.isArray(layout.nodes) || !layout.nodes.length) return layout;

    const direction = layout.direction === 'lr' ? 'lr' : 'tb';
    const nodes = layout.nodes;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edges = (layout.edges || [])
        .map((e) => ({
            from: e.from,
            to: e.to,
            label: e.label || '',
            line: e.line || e.sourceLine || null,
            sourceLine: e.line || e.sourceLine || null
        }))
        .filter((e) => byId.has(e.from) && byId.has(e.to));

    const fontFam = (typeof getUiFontFamily === 'function')
        ? getUiFontFamily()
        : 'system-ui, sans-serif';
    const arrowClear = 15;
    const edgeLabelFs = 11;
    const edgeLabelMaxW = 128;
    const edgeLabelPad = 14;
    const cornerR = 10;
    let width = Math.max(320, Math.ceil(layout.width || 0));
    let height = Math.max(200, Math.ceil(layout.height || 0));

    function measureEdgeLabel(str) {
        if (typeof document !== 'undefined') {
            const c = layoutFlowchart._cEdge
                || (layoutFlowchart._cEdge = document.createElement('canvas'));
            const ctx = c.getContext('2d');
            ctx.font = '700 ' + edgeLabelFs + 'px ' + fontFam;
            return ctx.measureText(String(str || '')).width;
        }
        return String(str || '').length * edgeLabelFs * 0.62;
    }

    function wrapEdgeLabel(str) {
        const raw = String(str || '').trim();
        if (!raw) return { lines: [], w: 0, h: 0 };
        let lines = (typeof wrapTextLines === 'function')
            ? wrapTextLines(raw, edgeLabelMaxW, edgeLabelFs, fontFam)
            : [raw];
        if (!lines.length) lines = [raw];
        if (lines.length > 3) {
            lines = lines.slice(0, 2).concat([lines.slice(2).join(' ')]);
        }
        const tw = Math.max(...lines.map(measureEdgeLabel), 28);
        const th = lines.length * (edgeLabelFs * 1.25) + 8;
        return { lines, w: Math.ceil(tw + 16), h: Math.ceil(th) };
    }

    const edgeWrap = edges.map((e) => wrapEdgeLabel(e.label || ''));

    function boundaryPoint(n, ux, uy) {
        const cx = n.x + n.width / 2;
        const cy = n.y + n.height / 2;
        const shape = n.shape || 'rect';
        if (shape === 'diamond') {
            const hw = n.width / 2;
            const hh = n.height / 2;
            const den = Math.abs(ux) / hw + Math.abs(uy) / hh;
            const t = den > 0 ? 1 / den : 0;
            return { x: cx + ux * t, y: cy + uy * t };
        }
        if (shape === 'circle') {
            const rx = n.width / 2;
            const ry = n.height / 2;
            return { x: cx + ux * rx, y: cy + uy * ry };
        }
        const hw = n.width / 2;
        const hh = n.height / 2;
        const tx = ux !== 0 ? hw / Math.abs(ux) : Infinity;
        const ty = uy !== 0 ? hh / Math.abs(uy) : Infinity;
        const t = Math.min(tx, ty);
        return { x: cx + ux * t, y: cy + uy * t };
    }

    function shorten(from, to, by) {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const cut = Math.min(by, Math.max(0, len - 2));
        return {
            x: to.x - (dx / len) * cut,
            y: to.y - (dy / len) * cut
        };
    }

    // Simmetrika: where two nodes overlap across the edge, the edge goes straight — a step of a few
    // pixels between centres of nodes of different heights read as a mistake. The line is put at the
    // centre of a diamond or circle (their boundary is exact there), else within the overlap.
    // Shapes whose side is straight across the line: entered anywhere along it.
    const FLAT = { h: ['rect', 'round', 'subroutine', 'cylinder', 'document'], v: ['rect', 'round', 'subroutine', 'stadium', 'parallelogram'] };
    const exactAnywhere = (n, along) => FLAT[along].includes(n.shape || 'rect');
    function edgeAt(n, along, coord, sign) {
        // The boundary of n on the line `coord` across the main axis ('x' — a vertical line at x).
        const cx = n.x + n.width / 2;
        const cy = n.y + n.height / 2;
        const shape = n.shape || 'rect';
        if (along === 'h') {
            const dy = coord - cy;
            let hx = n.width / 2;
            if (shape === 'diamond') hx = (n.width / 2) * (1 - Math.abs(dy) / (n.height / 2));
            else if (shape === 'circle') hx = (n.width / 2) * Math.sqrt(Math.max(0, 1 - Math.pow(dy / (n.height / 2), 2)));
            return { x: cx + sign * hx, y: coord };
        }
        const dx = coord - cx;
        let hy = n.height / 2;
        if (shape === 'diamond') hy = (n.height / 2) * (1 - Math.abs(dx) / (n.width / 2));
        else if (shape === 'circle') hy = (n.height / 2) * Math.sqrt(Math.max(0, 1 - Math.pow(dx / (n.width / 2), 2)));
        return { x: coord, y: cy + sign * hy };
    }
    function straightLine(a, b, along) {
        const lo = along === 'h' ? Math.max(a.y, b.y) + 6 : Math.max(a.x, b.x) + 6;
        const hi = along === 'h' ? Math.min(a.y + a.height, b.y + b.height) - 6 : Math.min(a.x + a.width, b.x + b.width) - 6;
        if (hi < lo) return null;
        const c = (n) => (along === 'h' ? n.y + n.height / 2 : n.x + n.width / 2);
        const fixed = [a, b].filter((n) => !exactAnywhere(n, along));
        let at;
        if (fixed.length === 2) {
            if (Math.abs(c(a) - c(b)) > 0.5) return null;
            at = c(a);
        } else if (fixed.length === 1) at = c(fixed[0]);
        else at = (c(a) + c(b)) / 2;
        if (at < lo || at > hi) return null;
        return at;
    }

    const laidEdges = edges.map((e, ei) => {
        const a = byId.get(e.from);
        const b = byId.get(e.to);

        const clearDown = b.y >= a.y + a.height - 8;
        const clearRight = b.x >= a.x + a.width - 8;
        const aCx = a.x + a.width / 2;
        const bCx = b.x + b.width / 2;
        const aCy = a.y + a.height / 2;
        const bCy = b.y + b.height / 2;

        let p1;
        let p2;
        let points;
        if (direction === 'tb') {
            const straightX = clearDown && Math.abs(aCx - bCx) > 0.5 ? straightLine(a, b, 'v') : null;
            const straightY = !clearDown && Math.abs(aCy - bCy) > 0.5 ? straightLine(a, b, 'h') : null;
            if (clearDown && straightX !== null) {
                p1 = edgeAt(a, 'v', straightX, 1);
                p2 = edgeAt(b, 'v', straightX, -1);
                const midY = (p1.y + p2.y) / 2;
                points = [p1, { x: straightX, y: midY }, { x: straightX, y: midY }, p2];
            } else if (clearDown) {
                p1 = boundaryPoint(a, 0, 1);
                p2 = boundaryPoint(b, 0, -1);
                const midY = (p1.y + p2.y) / 2;
                points = [
                    { x: p1.x, y: p1.y },
                    { x: p1.x, y: midY },
                    { x: p2.x, y: midY },
                    { x: p2.x, y: p2.y }
                ];
            } else if (straightY !== null) {
                const s = bCx >= aCx ? 1 : -1;
                p1 = edgeAt(a, 'h', straightY, s);
                p2 = edgeAt(b, 'h', straightY, -s);
                const midX = (p1.x + p2.x) / 2;
                points = [p1, { x: midX, y: straightY }, { x: midX, y: straightY }, p2];
            } else {
                if (bCx >= aCx) {
                    p1 = boundaryPoint(a, 1, 0);
                    p2 = boundaryPoint(b, -1, 0);
                } else {
                    p1 = boundaryPoint(a, -1, 0);
                    p2 = boundaryPoint(b, 1, 0);
                }
                const midX = (p1.x + p2.x) / 2;
                points = [
                    { x: p1.x, y: p1.y },
                    { x: midX, y: p1.y },
                    { x: midX, y: p2.y },
                    { x: p2.x, y: p2.y }
                ];
            }
        } else if (clearRight && Math.abs(aCy - bCy) > 0.5 && straightLine(a, b, 'h') !== null) {
            const y = straightLine(a, b, 'h');
            p1 = edgeAt(a, 'h', y, 1);
            p2 = edgeAt(b, 'h', y, -1);
            const midX = (p1.x + p2.x) / 2;
            points = [p1, { x: midX, y }, { x: midX, y }, p2];
        } else if (clearRight) {
            p1 = boundaryPoint(a, 1, 0);
            p2 = boundaryPoint(b, -1, 0);
            const midX = (p1.x + p2.x) / 2;
            points = [
                { x: p1.x, y: p1.y },
                { x: midX, y: p1.y },
                { x: midX, y: p2.y },
                { x: p2.x, y: p2.y }
            ];
        } else {
            if (bCy >= aCy) {
                p1 = boundaryPoint(a, 0, 1);
                p2 = boundaryPoint(b, 0, -1);
            } else {
                p1 = boundaryPoint(a, 0, -1);
                p2 = boundaryPoint(b, 0, 1);
            }
            const midY = (p1.y + p2.y) / 2;
            points = [
                { x: p1.x, y: p1.y },
                { x: p1.x, y: midY },
                { x: p2.x, y: midY },
                { x: p2.x, y: p2.y }
            ];
        }

        const last = points[points.length - 1];
        const prev = points[points.length - 2];
        const tip = { x: last.x, y: last.y };
        const shortened = shorten(prev, last, arrowClear);
        points[points.length - 1] = shortened;

        const mid = points[1];
        const label = e.label || '';
        const wrapped = edgeWrap[ei] || { lines: [], w: 0, h: 0 };
        const labelW = wrapped.w;
        const labelH = wrapped.h;
        let lx = 0;
        let ly = 0;
        if (labelW > 0) {
            if (direction === 'tb') {
                const midY = mid.y;
                const sameCol = Math.abs(p1.x - p2.x) < 4;
                lx = sameCol ? (p1.x + p2.x) / 2 : p2.x;
                if (sameCol) {
                    ly = (p1.y + p2.y) / 2;
                } else {
                    ly = midY - labelH / 2 - 4;
                }
                const yMin = p1.y + labelH / 2 + edgeLabelPad;
                const yMax = p2.y - labelH / 2 - edgeLabelPad;
                if (yMax > yMin) ly = Math.max(yMin, Math.min(yMax, ly));
                else ly = (p1.y + p2.y) / 2;
            } else {
                const midX = mid.x;
                const sameRow = Math.abs(p1.y - p2.y) < 4;
                ly = sameRow ? (p1.y + p2.y) / 2 : p2.y;
                if (sameRow) {
                    lx = (p1.x + p2.x) / 2;
                } else {
                    lx = midX - labelW / 2 - 4;
                }
                const xMin = p1.x + labelW / 2 + edgeLabelPad;
                const xMax = p2.x - labelW / 2 - edgeLabelPad;
                if (xMax > xMin) lx = Math.max(xMin, Math.min(xMax, lx));
                else lx = (p1.x + p2.x) / 2;
            }
        }
        return {
            from: e.from,
            to: e.to,
            label,
            labelLines: wrapped.lines,
            labelW,
            labelH,
            line: e.line || e.sourceLine || null,
            sourceLine: e.line || e.sourceLine || null,
            points,
            tip,
            cornerR,
            x1: points[0].x, y1: points[0].y,
            x2: shortened.x, y2: shortened.y,
            cx1: mid.x, cy1: mid.y,
            cx2: points[2].x, cy2: points[2].y,
            lx,
            ly
        };
    });

    (function resolveEdgeLabelCollisions() {
        const labeled = laidEdges.filter((e) => e.label && e.labelW > 0);
        if (!labeled.length) return;

        function labelBox(e) {
            return {
                x1: e.lx - e.labelW / 2,
                x2: e.lx + e.labelW / 2,
                y1: e.ly - e.labelH / 2,
                y2: e.ly + e.labelH / 2
            };
        }
        function nodeBox(n) {
            return {
                x1: n.x - 4,
                x2: n.x + n.width + 4,
                y1: n.y - 4,
                y2: n.y + n.height + 4
            };
        }
        function overlap(a, b) {
            return Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) > 0
                && Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) > 0;
        }

        const byFrom = new Map();
        labeled.forEach((e) => {
            if (!byFrom.has(e.from)) byFrom.set(e.from, []);
            byFrom.get(e.from).push(e);
        });
        byFrom.forEach((group) => {
            if (group.length < 2) return;
            if (direction === 'tb') {
                group.sort((a, b) => a.lx - b.lx || a.to.localeCompare(b.to));
                const midLy = group.reduce((s, e) => s + e.ly, 0) / group.length;
                group.forEach((e) => { e.ly = midLy; });
                for (let i = 0; i < group.length - 1; i++) {
                    const a = group[i];
                    const b = group[i + 1];
                    const need = (a.labelW + b.labelW) / 2 + 16;
                    const gap = b.lx - a.lx;
                    if (gap < need) {
                        const push = (need - gap) / 2;
                        a.lx -= push;
                        b.lx += push;
                    }
                }
            } else {
                group.sort((a, b) => a.ly - b.ly || a.to.localeCompare(b.to));
                const midLx = group.reduce((s, e) => s + e.lx, 0) / group.length;
                group.forEach((e) => { e.lx = midLx; });
                for (let i = 0; i < group.length - 1; i++) {
                    const a = group[i];
                    const b = group[i + 1];
                    const need = (a.labelH + b.labelH) / 2 + 16;
                    const gap = b.ly - a.ly;
                    if (gap < need) {
                        const push = (need - gap) / 2;
                        a.ly -= push;
                        b.ly += push;
                    }
                }
            }
        });

        const pad = 10;
        for (let pass = 0; pass < 8; pass++) {
            let moved = false;
            for (let i = 0; i < labeled.length; i++) {
                for (let j = i + 1; j < labeled.length; j++) {
                    const a = labeled[i];
                    const b = labeled[j];
                    if (!overlap(labelBox(a), labelBox(b))) continue;
                    if (direction === 'tb') {
                        const aLeft = a.lx <= b.lx;
                        const push = (Math.min(a.lx + a.labelW / 2, b.lx + b.labelW / 2)
                            - Math.max(a.lx - a.labelW / 2, b.lx - b.labelW / 2)) / 2 + pad;
                        if (aLeft) { a.lx -= push; b.lx += push; }
                        else { a.lx += push; b.lx -= push; }
                    } else {
                        const aUp = a.ly <= b.ly;
                        const push = (Math.min(a.ly + a.labelH / 2, b.ly + b.labelH / 2)
                            - Math.max(a.ly - a.labelH / 2, b.ly - b.labelH / 2)) / 2 + pad;
                        if (aUp) { a.ly -= push; b.ly += push; }
                        else { a.ly += push; b.ly -= push; }
                    }
                    moved = true;
                }
            }
            if (!moved) break;
        }

        for (let pass = 0; pass < 6; pass++) {
            let moved = false;
            labeled.forEach((e) => {
                const lb = labelBox(e);
                nodes.forEach((n) => {
                    const nb = nodeBox(n);
                    if (!overlap(lb, nb)) return;
                    if (direction === 'tb') {
                        const up = (lb.y2 - nb.y1) + 6;
                        e.ly -= up;
                        moved = true;
                    } else {
                        e.lx -= (lb.x2 - nb.x1) + 6;
                        moved = true;
                    }
                });
            });
            if (!moved) break;
        }

        labeled.forEach((e) => {
            const a = byId.get(e.from);
            const b = byId.get(e.to);
            if (direction === 'tb') {
                const yMin = a.y + a.height + e.labelH / 2 + 6;
                const yMax = b.y - e.labelH / 2 - 6;
                if (yMax > yMin) e.ly = Math.max(yMin, Math.min(yMax, e.ly));
            } else {
                const xMin = a.x + a.width + e.labelW / 2 + 6;
                const xMax = b.x - e.labelW / 2 - 6;
                if (xMax > xMin) e.lx = Math.max(xMin, Math.min(xMax, e.lx));
            }
            e.lx = Math.max(e.labelW / 2 + 4, Math.min(width - e.labelW / 2 - 4, e.lx));
            e.ly = Math.max(e.labelH / 2 + 8, Math.min(height - e.labelH / 2 - 4, e.ly));
        });
    })();

    nodes.forEach((n) => {
        n.cx = n.x + n.width / 2;
        n.cy = n.y + n.height / 2;
    });

    layout.direction = direction;
    layout.nodes = nodes;
    layout.edges = laidEdges;
    layout.width = width;
    layout.height = height;
    return layout;
}
