function nodeLayoutH(node) {
    return typeof diagramNodeLayoutHeight === 'function'
        ? diagramNodeLayoutHeight(node)
        : (node.height || 0);
}

// Иерархическая компоновка: слева направо
function layoutHorizontal(node, x, y, gapX = 200, gapY = 40, cols = null, depth = 0) {
    // Simmetrika: columns as wide as their widest node (a fixed step let a long name,
    // «Группа рисков №1», run under the next column).
    if (!cols) {
        const widest = [];
        (function walk(n, d) {
            widest[d] = Math.max(widest[d] || 0, n.width || 0);
            for (const c of n.children) walk(c, d + 1);
        })(node, 0);
        cols = [x];
        for (let d = 1; d < widest.length; d++) cols[d] = cols[d - 1] + Math.max(gapX, widest[d - 1] + 48);
    }
    x = cols[depth];
    if (node.children.length === 0) {
        node.x = x; node.y = y;
        return nodeLayoutH(node) + gapY;
    }
    let childY = y;
    for (const child of node.children) {
        const childH = layoutHorizontal(child, x + gapX, childY, gapX, gapY, cols, depth + 1);
        childY += childH;
    }
    const first = node.children[0], last = node.children[node.children.length - 1];
    node.x = x;
    node.y = (first.y + first.height / 2 + last.y + last.height / 2) / 2 - node.height / 2;
    return childY - y;
}

/**
 * ↓ Вертикаль:
 *  — дети корня (фазы) — столбцы слева направо;
 *  — внутри фазы / любой не-корневой узел: дети столбиком сверху вниз
 *    (соседи с одним отступом идут друг за другом; больший отступ —
 *    ветка от предшествующей строки, уже заложена в parseTree).
 * Возвращает { width, height } поддерева.
 */
function layoutVerticalColumn(node, leftX, topY, nestGapX = 18, gapY = 30, depth = 0) {
    node.x = leftX;
    node.y = topY;

    const selfH = nodeLayoutH(node);
    if (!node.children.length) {
        return { width: node.width, height: selfH };
    }

    // Глубже — чуть меньше сдвиг вправо (экономия ширины колонок)
    const indent = Math.max(12, Math.round(nestGapX * Math.pow(0.84, Math.min(depth, 5))));
    const childLeft = leftX + indent;
    // После родителя — полный gap; между листьями — плотнее
    const afterParentGap = Math.max(14, Math.round(gapY * 0.9));
    const leafSiblingGap = Math.max(8, Math.round(gapY * 0.48));
    const branchSiblingGap = Math.max(12, Math.round(gapY * 0.72));

    let y = topY + selfH + afterParentGap;
    let maxW = node.width;
    const kids = node.children;

    for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        const sub = layoutVerticalColumn(child, childLeft, y, nestGapX, gapY, depth + 1);
        maxW = Math.max(maxW, (childLeft - leftX) + sub.width);
        if (i < kids.length - 1) {
            const next = kids[i + 1];
            const eitherHasKids = !!(child.children && child.children.length)
                || !!(next.children && next.children.length);
            y += sub.height + (eitherHasKids ? branchSiblingGap : leafSiblingGap);
        } else {
            y += sub.height;
        }
    }

    return { width: maxW, height: y - topY };
}

function layoutVertical(root, originX = 60, originY = 60, phaseGapX = 44, gapY = 30, nestGapX = 18) {
    root.x = originX;
    root.y = originY;

    if (!root.children.length) {
        return root.width;
    }

    const phaseTop = originY + nodeLayoutH(root) + Math.max(18, Math.round(gapY * 0.95));
    let x = originX;
    const phaseWidths = [];

    for (const phase of root.children) {
        const sub = layoutVerticalColumn(phase, x, phaseTop, nestGapX, gapY, 0);
        phaseWidths.push({ phase, x, width: sub.width });
        x += sub.width + phaseGapX;
    }

    const totalW = x - phaseGapX - originX;
    root.x = originX + Math.max(0, (totalW - root.width) / 2);
    return totalW;
}

// Разрешение наложений по вертикали (для L→R)
function resolveOverlapsHorizontal(root) {
    const levels = {};
    (function group(n) {
        if (!levels[n.level]) levels[n.level] = [];
        levels[n.level].push(n);
        n.children.forEach(group);
    })(root);
    const MIN_GAP = 12;
    for (const lvl in levels) {
        if (lvl == 0) continue;
        const nodes = levels[lvl].sort((a, b) => a.y - b.y);
        for (let i = 1; i < nodes.length; i++) {
            const prev = nodes[i - 1], curr = nodes[i];
            const overlap = prev.y + nodeLayoutH(prev) + MIN_GAP - curr.y;
            if (overlap > 0) shiftSubtreeY(curr, overlap);
        }
    }
}

/**
 * ↓ Вертикаль: фазы не должны пересекаться по X;
 * внутри столбца — по Y (соседи / вложенные).
 */
function resolveOverlapsVertical(root) {
    const MIN_GAP_X = 28;
    const MIN_GAP_Y = 10;

    // Фазы (дети корня) — развести по X
    if (root.children && root.children.length > 1) {
        const phases = root.children.slice().sort((a, b) => a.x - b.x);
        for (let i = 1; i < phases.length; i++) {
            const prev = phases[i - 1];
            const curr = phases[i];
            const prevRight = subtreeMaxX(prev);
            const overlap = prevRight + MIN_GAP_X - curr.x;
            if (overlap > 0) shiftSubtreeX(curr, overlap);
        }
    }

    // Внутри каждого поддерева — развести по Y при наложении
    function fixColumn(node) {
        if (!node.children.length) return;
        const kids = node.children.slice().sort((a, b) => a.y - b.y);
        for (let i = 1; i < kids.length; i++) {
            const prev = kids[i - 1];
            const curr = kids[i];
            const prevBottom = subtreeMaxY(prev);
            const overlap = prevBottom + MIN_GAP_Y - curr.y;
            if (overlap > 0) shiftSubtreeY(curr, overlap);
        }
        node.children.forEach(fixColumn);
    }
    root.children.forEach(fixColumn);
}

function subtreeMaxX(node) {
    let max = node.x + node.width;
    for (const ch of node.children) max = Math.max(max, subtreeMaxX(ch));
    return max;
}

function subtreeMaxY(node) {
    let max = node.y + nodeLayoutH(node);
    for (const ch of node.children) max = Math.max(max, subtreeMaxY(ch));
    return max;
}
