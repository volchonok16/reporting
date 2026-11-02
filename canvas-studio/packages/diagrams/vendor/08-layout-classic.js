// Классическая интеллект-карта: корень в центре, основные ветки влево и вправо

function classicNodeH(node) {
    return typeof diagramNodeLayoutHeight === 'function'
        ? diagramNodeLayoutHeight(node)
        : (node.height || 0);
}

function measureClassicSubtree(node, gapY) {
    const selfH = classicNodeH(node);
    if (!node.children.length) {
        node._classicH = selfH;
        return selfH;
    }
    let total = 0;
    for (let i = 0; i < node.children.length; i++) {
        total += measureClassicSubtree(node.children[i], gapY);
        if (i < node.children.length - 1) total += gapY;
    }
    node._classicH = Math.max(selfH, total);
    return node._classicH;
}

function layoutClassicSubtree(node, x, y, dir, level, gapX, gapY) {
    node.x = x;
    node.y = y;
    node.level = level;
    node.side = dir < 0 ? 'left' : 'right';

    if (!node.children.length) return;

    const kids = node.children;
    const blockH = kids.reduce((s, c) => s + c._classicH, 0) + gapY * Math.max(0, kids.length - 1);
    let childY = y - blockH / 2;

    for (const child of kids) {
        const childX = x + dir * (node.width / 2 + gapX + child.width / 2);
        const cy = childY + child._classicH / 2;
        layoutClassicSubtree(child, childX, cy, dir, level + 1, gapX, gapY);
        childY += child._classicH + gapY;
    }
}

function placeClassicSide(kids, root, level, gapX, gapY, dir) {
    if (!kids.length) return;
    const totalH = kids.reduce((s, c) => s + c._classicH, 0) + gapY * Math.max(0, kids.length - 1);
    let y = -totalH / 2;
    for (const child of kids) {
        const x = dir * (root.width / 2 + gapX + child.width / 2);
        const cy = y + child._classicH / 2;
        layoutClassicSubtree(child, x, cy, dir, level, gapX, gapY);
        y += child._classicH + gapY;
    }
}

function layoutClassic(root, gapX, gapY) {
    const gx = gapX == null ? 190 : gapX;
    const gy = gapY == null ? 28 : gapY;
    root.x = 0;
    root.y = 0;
    root.level = 0;

    const kids = root.children;
    if (!kids.length) return;

    const rightCount = Math.ceil(kids.length / 2);
    const rightKids = kids.slice(0, rightCount);
    const leftKids = kids.slice(rightCount);

    rightKids.forEach((c) => measureClassicSubtree(c, gy));
    leftKids.forEach((c) => measureClassicSubtree(c, gy));

    placeClassicSide(rightKids, root, 1, gx, gy, 1);
    placeClassicSide(leftKids, root, 1, gx, gy, -1);
}

function resolveOverlapsClassic(root) {
    if (typeof resolveOverlapsRadial === 'function') resolveOverlapsRadial(root);
}
