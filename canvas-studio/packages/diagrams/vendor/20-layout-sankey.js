/**
 * Layout классического Sankey («Потоки»).
 * Двусторонний barycenter, пропорциональные высоты, выравнивание колонок.
 */
function layoutSankey(data, options = {}) {
    const nodes = (data && data.nodes) || [];
    const links = (data && data.links) || [];
    const title = (data && data.title) || '';
    const declaredColumns = Array.isArray(data && data.columns) ? data.columns : [];
    const {
        startX = 140,
        startY = title ? 112 : 78,
        nodeWidth = 28,
        nodePadding = 14,
        layerGap = 200,
        minNodeHeight = 20,
        chartBodyHeight = 420,
        sideLabelPad = 110
    } = options;

    if (!nodes.length) return { nodes: [], links: [], width: 0, height: 0, title: '' };

    const nodeByName = new Map(nodes.map((n) => [n.name, n]));
    const hasIncoming = new Set();
    links.forEach((l) => hasIncoming.add(l.target));

    // --- Слои ---
    let layers = [];
    const layerMap = new Map();

    if (declaredColumns.length) {
        layers = declaredColumns.map(() => []);
        const colIndex = new Map(declaredColumns.map((c, i) => [c, i]));

        // Сначала закреплённые @колонка
        nodes.forEach((n) => {
            if (n.column && colIndex.has(n.column)) {
                const li = colIndex.get(n.column);
                layers[li].push(n.name);
                layerMap.set(n.name, li);
            }
        });

        // Остальные — по BFS от источников, с clamp в диапазон колонок
        const queue = [];
        nodes.forEach((n) => {
            if (layerMap.has(n.name)) return;
            if (!hasIncoming.has(n.name)) {
                layerMap.set(n.name, 0);
                layers[0].push(n.name);
                queue.push(n.name);
            }
        });
        if (!queue.length && nodes[0]) {
            if (!layerMap.has(nodes[0].name)) {
                layerMap.set(nodes[0].name, 0);
                layers[0].push(nodes[0].name);
            }
            queue.push(nodes[0].name);
        }
        while (queue.length) {
            const name = queue.shift();
            const li = layerMap.get(name) || 0;
            links.forEach((l) => {
                if (l.source !== name) return;
                if (layerMap.has(l.target)) return;
                const next = Math.min(li + 1, layers.length - 1);
                layerMap.set(l.target, next);
                layers[next].push(l.target);
                queue.push(l.target);
            });
        }
        nodes.forEach((n) => {
            if (layerMap.has(n.name)) return;
            const last = layers.length - 1;
            layerMap.set(n.name, last);
            layers[last].push(n.name);
        });
    } else {
        const visited = new Set();
        const queue = [];
        nodes.forEach((n) => {
            if (!hasIncoming.has(n.name)) {
                queue.push(n.name);
                visited.add(n.name);
            }
        });
        if (!queue.length) {
            queue.push(nodes[0].name);
            visited.add(nodes[0].name);
        }
        let currentLayer = 0;
        while (queue.length) {
            const levelSize = queue.length;
            const level = [];
            for (let i = 0; i < levelSize; i++) {
                const name = queue.shift();
                layerMap.set(name, currentLayer);
                level.push(name);
                links.forEach((l) => {
                    if (l.source === name && !visited.has(l.target)) {
                        visited.add(l.target);
                        queue.push(l.target);
                    }
                });
            }
            layers.push(level);
            currentLayer++;
        }
        nodes.forEach((n) => {
            if (layerMap.has(n.name)) return;
            layerMap.set(n.name, currentLayer);
            if (!layers[currentLayer]) layers[currentLayer] = [];
            layers[currentLayer].push(n.name);
        });
    }

    // --- Потоки ---
    const nodeFlowIn = new Map();
    const nodeFlowOut = new Map();
    nodes.forEach((n) => {
        nodeFlowIn.set(n.name, 0);
        nodeFlowOut.set(n.name, 0);
    });
    links.forEach((l) => {
        nodeFlowOut.set(l.source, (nodeFlowOut.get(l.source) || 0) + l.value);
        nodeFlowIn.set(l.target, (nodeFlowIn.get(l.target) || 0) + l.value);
    });

    const nodeFlow = new Map();
    let maxFlow = 0;
    nodes.forEach((n) => {
        const flow = Math.max(nodeFlowIn.get(n.name) || 0, nodeFlowOut.get(n.name) || 0, 1);
        nodeFlow.set(n.name, flow);
        if (flow > maxFlow) maxFlow = flow;
    });
    if (!(maxFlow > 0)) maxFlow = 1;

    function baryIn(name, indexOfPrev, fallback) {
        let sum = 0;
        let w = 0;
        links.forEach((l) => {
            if (l.target !== name || !indexOfPrev.has(l.source)) return;
            sum += indexOfPrev.get(l.source) * l.value;
            w += l.value;
        });
        return w > 0 ? sum / w : fallback;
    }

    function baryOut(name, indexOfNext, fallback) {
        let sum = 0;
        let w = 0;
        links.forEach((l) => {
            if (l.source !== name || !indexOfNext.has(l.target)) return;
            sum += indexOfNext.get(l.target) * l.value;
            w += l.value;
        });
        return w > 0 ? sum / w : fallback;
    }

    // Классика: туда-обратно barycenter
    for (let iter = 0; iter < 12; iter++) {
        for (let li = 1; li < layers.length; li++) {
            const prevIdx = new Map();
            layers[li - 1].forEach((n, i) => prevIdx.set(n, i));
            const order = new Map(layers[li].map((n, i) => [n, i]));
            layers[li] = [...layers[li]].sort((a, b) => {
                const da = baryIn(a, prevIdx, order.get(a));
                const db = baryIn(b, prevIdx, order.get(b));
                return da - db || order.get(a) - order.get(b);
            });
        }
        for (let li = layers.length - 2; li >= 0; li--) {
            const nextIdx = new Map();
            layers[li + 1].forEach((n, i) => nextIdx.set(n, i));
            const order = new Map(layers[li].map((n, i) => [n, i]));
            layers[li] = [...layers[li]].sort((a, b) => {
                const da = baryOut(a, nextIdx, order.get(a));
                const db = baryOut(b, nextIdx, order.get(b));
                return da - db || order.get(a) - order.get(b);
            });
        }
    }

    // Высоты пропорциональны потоку; масштаб общий, чтобы сравнивать колонки
    function heightOf(name) {
        const flow = nodeFlow.get(name) || 1;
        return Math.max(minNodeHeight, (flow / maxFlow) * chartBodyHeight);
    }

    // Высота каждой колонки → центрируем относительно самой высокой
    const layerHeights = layers.map((layer) => {
        let h = 0;
        layer.forEach((name, i) => {
            h += heightOf(name);
            if (i < layer.length - 1) h += nodePadding;
        });
        return h;
    });
    const maxLayerH = Math.max.apply(null, layerHeights.concat([0]));

    const nodePositions = [];
    const nodeMap = new Map();
    const columnLabels = [];

    layers.forEach((layer, layerIndex) => {
        const x = startX + layerIndex * (nodeWidth + layerGap);
        let y = startY + Math.max(0, (maxLayerH - layerHeights[layerIndex]) / 2);
        if (declaredColumns[layerIndex]) {
            columnLabels.push({
                text: declaredColumns[layerIndex],
                x: x + nodeWidth / 2,
                y: title ? 64 : 40
            });
        }
        layer.forEach((name) => {
            const height = heightOf(name);
            const flow = nodeFlow.get(name) || 1;
            const pos = { name, x, y, width: nodeWidth, height, flow };
            nodePositions.push(pos);
            nodeMap.set(name, pos);
            y += height + nodePadding;
        });
    });

    const linksBySource = new Map();
    const linksByTarget = new Map();
    links.forEach((l) => {
        if (!linksBySource.has(l.source)) linksBySource.set(l.source, []);
        if (!linksByTarget.has(l.target)) linksByTarget.set(l.target, []);
        linksBySource.get(l.source).push(l);
        linksByTarget.get(l.target).push(l);
    });
    linksBySource.forEach((arr) => {
        arr.sort((a, b) => ((nodeMap.get(a.target) || {}).y || 0) - ((nodeMap.get(b.target) || {}).y || 0));
    });
    linksByTarget.forEach((arr) => {
        arr.sort((a, b) => ((nodeMap.get(a.source) || {}).y || 0) - ((nodeMap.get(b.source) || {}).y || 0));
    });

    const linkPositions = [];
    const sourceOffsets = new Map();
    const sourcesTopDown = [...nodeMap.entries()]
        .sort((a, b) => (a[1].y - b[1].y) || (a[1].x - b[1].x))
        .map(([name]) => name);

    const placed = new Set();
    sourcesTopDown.forEach((src) => {
        (linksBySource.get(src) || []).forEach((link) => {
            const key = link.source + '\0' + link.target + '\0' + link.value + '\0' + (link.line || '');
            if (placed.has(key)) return;
            placed.add(key);
            const sourceNode = nodeMap.get(link.source);
            const targetNode = nodeMap.get(link.target);
            if (!sourceNode || !targetNode) return;

            const sourceTotalOut = nodeFlowOut.get(link.source) || 1;
            const sourceFraction = link.value / sourceTotalOut;
            let sourceOffset = sourceOffsets.get(link.source) || 0;
            const sourceBand = sourceFraction * sourceNode.height;
            const sourceY = sourceNode.y + sourceOffset + sourceBand / 2;
            sourceOffsets.set(link.source, sourceOffset + sourceBand);

            linkPositions.push({
                source: link.source,
                target: link.target,
                value: link.value,
                x1: sourceNode.x + sourceNode.width,
                y1: sourceY,
                x2: targetNode.x,
                y2: 0,
                thickness: Math.max(2, sourceBand),
                targetThickness: 0
            });
        });
    });

    const linkByRef = new Map();
    linkPositions.forEach((lp) => {
        const k = lp.source + '\0' + lp.target + '\0' + lp.value;
        if (!linkByRef.has(k)) linkByRef.set(k, []);
        linkByRef.get(k).push(lp);
    });

    linksByTarget.forEach((arr, target) => {
        const targetNode = nodeMap.get(target);
        if (!targetNode) return;
        const targetTotalIn = nodeFlowIn.get(target) || 1;
        let targetOffset = 0;
        arr.forEach((link) => {
            const targetFraction = link.value / targetTotalIn;
            const targetBand = targetFraction * targetNode.height;
            const targetY = targetNode.y + targetOffset + targetBand / 2;
            targetOffset += targetBand;
            const k = link.source + '\0' + link.target + '\0' + link.value;
            const bucket = linkByRef.get(k) || [];
            const lp = bucket.find((p) => p.targetThickness === 0) || bucket[0];
            if (lp) {
                lp.y2 = targetY;
                lp.targetThickness = Math.max(2, targetBand);
            }
        });
    });

    linkPositions.forEach((lp) => {
        if (!lp.targetThickness) {
            const targetNode = nodeMap.get(lp.target);
            lp.targetThickness = lp.thickness;
            lp.y2 = targetNode ? targetNode.y + targetNode.height / 2 : lp.y1;
        }
    });

    let maxY = startY;
    nodeMap.forEach((node) => {
        maxY = Math.max(maxY, node.y + node.height);
    });

    const estimateLabelW = (name) => Math.ceil(String(name || '').length * 8.2) + 28;
    const leftNames = layers[0] || [];
    const rightNames = layers[layers.length - 1] || [];
    const leftNeed = Math.max(sideLabelPad, ...leftNames.map(estimateLabelW), 80);
    const rightNeed = Math.max(sideLabelPad, ...rightNames.map(estimateLabelW), 80);
    const shiftX = Math.max(0, leftNeed - startX);
    if (shiftX > 0) {
        nodePositions.forEach((n) => { n.x += shiftX; });
        linkPositions.forEach((l) => { l.x1 += shiftX; l.x2 += shiftX; });
        columnLabels.forEach((c) => { c.x += shiftX; });
    }

    const lastNodeRight = startX + shiftX + (layers.length - 1) * (nodeWidth + layerGap) + nodeWidth;
    const totalWidth = lastNodeRight + rightNeed;
    const totalHeight = maxY + (title ? 72 : 48);

    return {
        nodes: nodePositions,
        links: linkPositions,
        columnLabels,
        title,
        width: totalWidth,
        height: totalHeight,
        nodeWidth
    };
}
