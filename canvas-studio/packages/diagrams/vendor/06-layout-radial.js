// Вычисление весов поддеревьев
function computeWeights(node) {
    let w = 1;
    for (const child of node.children) { computeWeights(child); w += child.weight; }
    node.weight = w;
}

// Радиальная компоновка
function layoutRadial(node, startAngle, endAngle, level, radiusPerLevel = 200) {
    node.level = level;
    node.angle = (startAngle + endAngle) / 2;
    if (level === 0) { node.x = 0; node.y = 0; }
    else {
        const r = level * radiusPerLevel;
        node.x = r * Math.cos(node.angle);
        node.y = r * Math.sin(node.angle);
    }
    if (node.children.length === 0) return;
    const MIN_ANGLE = (20 * Math.PI) / 180;
    const availableAngle = endAngle - startAngle;
    if (node.children.length === 1) {
        const child = node.children[0];
        const span = Math.min(availableAngle, MIN_ANGLE);
        layoutRadial(child, node.angle - span/2, node.angle + span/2, level+1, radiusPerLevel);
        return;
    }
    const totalWeight = node.children.reduce((sum,ch) => sum+ch.weight, 0);
    let currentAngle = startAngle;
    const angles = [];
    for (let i=0; i<node.children.length; i++) {
        const child = node.children[i];
        let span = (child.weight / totalWeight) * availableAngle;
        if (i < node.children.length-1) span = Math.max(span, MIN_ANGLE);
        if (currentAngle + span > endAngle) span = endAngle - currentAngle;
        angles.push(span);
        currentAngle += span;
    }
    const sumAngles = angles.reduce((s,a)=>s+a,0);
    if (sumAngles < availableAngle) angles[angles.length-1] += availableAngle - sumAngles;
    currentAngle = startAngle;
    for (let i=0; i<node.children.length; i++) {
        layoutRadial(node.children[i], currentAngle, currentAngle+angles[i], level+1, radiusPerLevel);
        currentAngle += angles[i];
    }
}

// Разрешение наложений в радиальной схеме
function resolveOverlapsRadial(root) {
    const allNodes = [];
    (function collect(n){ allNodes.push(n); n.children.forEach(collect); })(root);
    const layoutH = (n) => (typeof diagramNodeLayoutHeight === 'function'
        ? diagramNodeLayoutHeight(n)
        : (n.height || 0));
    let moved = true;
    const maxIters = 100;
    let iter = 0;
    while (moved && iter < maxIters) {
        moved = false;
        for (let i=0; i<allNodes.length; i++) {
            for (let j=i+1; j<allNodes.length; j++) {
                const a = allNodes[i], b = allNodes[j];
                if (a===b) continue;
                const aH = layoutH(a), bH = layoutH(b);
                // Слот = блок + зона //; y — центр слота
                const ax1 = a.x-a.width/2, ax2 = a.x+a.width/2;
                const ay1 = a.y-aH/2, ay2 = a.y+aH/2;
                const bx1 = b.x-b.width/2, bx2 = b.x+b.width/2;
                const by1 = b.y-bH/2, by2 = b.y+bH/2;
                // Simmetrika: kept apart by the margins too (only overlapping boxes were moved,
                // so nodes stayed touching — branches read as one blob).
                if (ax1 - 10 < bx2 && ax2 + 10 > bx1 && ay1 - 12 < by2 && ay2 + 12 > by1) {
                    const dx = b.x-a.x, dy = b.y-a.y, dist = Math.hypot(dx,dy)||1;
                    const minDistX = (a.width+b.width)/2 + 16;
                    const minDistY = (aH + bH)/2 + 14;
                    const overlapX = minDistX - Math.abs(dx);
                    const overlapY = minDistY - Math.abs(dy);
                    if (overlapX > 0 && overlapY > 0) {
                        const useY = overlapY <= overlapX;
                        const shift = (useY ? overlapY : overlapX) / 2 + 1;
                        if (useY) {
                            const sy = dy >= 0 ? 1 : -1;
                            a.y -= sy * shift;
                            b.y += sy * shift;
                        } else {
                            const sx = dx >= 0 ? 1 : -1;
                            a.x -= sx * shift;
                            b.x += sx * shift;
                        }
                        moved = true;
                    }
                }
            }
        }
        iter++;
    }
    function recalcAngles(n) {
        if (n.parent) { const dx=n.x-n.parent.x, dy=n.y-n.parent.y; n.angle = Math.atan2(dy,dx); }
        n.children.forEach(recalcAngles);
    }
    recalcAngles(root);
}