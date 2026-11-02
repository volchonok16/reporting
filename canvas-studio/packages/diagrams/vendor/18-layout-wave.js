function layoutWave(waveData, options = {}) {
    const { nodes, links } = waveData;
    const title = (waveData && waveData.title) || '';
    const {
        startX = 120,
        startY = title ? 88 : 56,
        nodeWidth = 18,
        nodePadding = 18,
        layerGap = 220,
        minNodeHeight = 24,
        maxNodeHeight = 280,
        sideLabelPad = 100
    } = options;

    if (nodes.length === 0) return { nodes: [], links: [], width: 0, height: 0, title: '' };

    // Слои: BFS, порядок открытия = порядок в тексте (не сортируем по «толщине» —
    // иначе дети разных родителей перемешиваются и ленты визуально «путаются»)
    const layers = [];
    const visited = new Set();
    const queue = [];
    const hasIncoming = new Set();
    links.forEach(l => hasIncoming.add(l.target));
    nodes.forEach(n => {
        if (!hasIncoming.has(n.name)) {
            queue.push(n.name);
            visited.add(n.name);
        }
    });
    if (queue.length === 0) {
        queue.push(nodes[0].name);
        visited.add(nodes[0].name);
    }

    const layerMap = new Map();
    let currentLayer = 0;
    while (queue.length > 0) {
        const levelSize = queue.length;
        const currentLevelNodes = [];
        for (let i = 0; i < levelSize; i++) {
            const name = queue.shift();
            layerMap.set(name, currentLayer);
            currentLevelNodes.push(name);
            // Исходящие в порядке появления в тексте
            links.forEach(l => {
                if (l.source === name && !visited.has(l.target)) {
                    visited.add(l.target);
                    queue.push(l.target);
                }
            });
        }
        layers.push(currentLevelNodes);
        currentLayer++;
    }
    nodes.forEach(n => {
        if (!layerMap.has(n.name)) {
            layerMap.set(n.name, currentLayer);
            if (!layers[currentLayer]) layers[currentLayer] = [];
            layers[currentLayer].push(n.name);
        }
    });

    const nodeFlowIn = new Map();
    const nodeFlowOut = new Map();
    nodes.forEach(n => {
        nodeFlowIn.set(n.name, 0);
        nodeFlowOut.set(n.name, 0);
    });
    links.forEach(l => {
        nodeFlowOut.set(l.source, nodeFlowOut.get(l.source) + l.value);
        nodeFlowIn.set(l.target, nodeFlowIn.get(l.target) + l.value);
    });

    const nodeFlow = new Map();
    let maxFlow = 0;
    nodes.forEach(n => {
        const flow = Math.max(nodeFlowIn.get(n.name), nodeFlowOut.get(n.name), 1);
        nodeFlow.set(n.name, flow);
        if (flow > maxFlow) maxFlow = flow;
    });
    if (maxFlow === 0) maxFlow = 1;

    function baryIn(name, indexOfPrev, fallback) {
        let sum = 0;
        let w = 0;
        links.forEach(l => {
            if (l.target !== name || !indexOfPrev.has(l.source)) return;
            sum += indexOfPrev.get(l.source) * l.value;
            w += l.value;
        });
        return w > 0 ? sum / w : fallback;
    }

    // Только прямой проход по родителям. Обратный (по детям) с fallback «в середину»
    // вставлял листья без исходящих между сиблингами — ветки лезли друг через друга.
    for (let iter = 0; iter < 8; iter++) {
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
    }

    const nodePositions = [];
    const nodeMap = new Map();

    layers.forEach((layer, layerIndex) => {
        const x = startX + layerIndex * (nodeWidth + layerGap);
        let y = startY;

        layer.forEach(name => {
            const flow = nodeFlow.get(name) || 1;
            const height = Math.max(minNodeHeight, (flow / maxFlow) * maxNodeHeight);
            nodePositions.push({
                name,
                x,
                y,
                width: nodeWidth,
                height,
                flow
            });
            nodeMap.set(name, { x, y, width: nodeWidth, height, flow });
            y += height + nodePadding;
        });
    });

    // Ленты: у каждого узла исходящие/входящие в порядке Y противоположного конца
    const linkPositions = [];
    const linksBySource = new Map();
    const linksByTarget = new Map();
    links.forEach(l => {
        if (!linksBySource.has(l.source)) linksBySource.set(l.source, []);
        if (!linksByTarget.has(l.target)) linksByTarget.set(l.target, []);
        linksBySource.get(l.source).push(l);
        linksByTarget.get(l.target).push(l);
    });
    linksBySource.forEach((arr) => {
        arr.sort((a, b) => {
            const ay = (nodeMap.get(a.target) || {}).y || 0;
            const by = (nodeMap.get(b.target) || {}).y || 0;
            return ay - by;
        });
    });
    linksByTarget.forEach((arr) => {
        arr.sort((a, b) => {
            const ay = (nodeMap.get(a.source) || {}).y || 0;
            const by = (nodeMap.get(b.source) || {}).y || 0;
            return ay - by;
        });
    });

    const sourceOffsets = new Map();
    const targetOffsets = new Map();
    // Стабильный порядок обхода: по источникам сверху вниз, внутри — уже отсортированные исходящие
    const sourcesTopDown = [...nodeMap.entries()]
        .sort((a, b) => (a[1].y - b[1].y) || (a[1].x - b[1].x))
        .map(([name]) => name);

    const placed = new Set();
    sourcesTopDown.forEach(src => {
        const outs = linksBySource.get(src) || [];
        outs.forEach(link => {
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

            // Входящий слот на приёмнике — по порядку входящих (уже отсортированы по Y источника)
            // Но offset должен соответствовать порядку в linksByTarget, не порядку обхода по источникам.
            // Поэтому target offset считаем отдельно вторым проходом.
            linkPositions.push({
                source: link.source,
                target: link.target,
                value: link.value,
                x1: sourceNode.x + sourceNode.width,
                y1: sourceY,
                x2: targetNode.x,
                y2: 0, // заполним ниже
                thickness: Math.max(2, sourceBand),
                targetThickness: 0,
                _targetOrderKey: link
            });
        });
    });

    // Второй проход: y2 / targetThickness в порядке входящих на каждый target
    const linkByRef = new Map();
    linkPositions.forEach(lp => {
        const k = lp.source + '\0' + lp.target + '\0' + lp.value;
        if (!linkByRef.has(k)) linkByRef.set(k, []);
        linkByRef.get(k).push(lp);
    });

    linksByTarget.forEach((arr, target) => {
        const targetNode = nodeMap.get(target);
        if (!targetNode) return;
        const targetTotalIn = nodeFlowIn.get(target) || 1;
        let targetOffset = 0;
        arr.forEach(link => {
            const targetFraction = link.value / targetTotalIn;
            const targetBand = targetFraction * targetNode.height;
            const targetY = targetNode.y + targetOffset + targetBand / 2;
            targetOffset += targetBand;
            const k = link.source + '\0' + link.target + '\0' + link.value;
            const bucket = linkByRef.get(k) || [];
            const lp = bucket.find(p => p.targetThickness === 0) || bucket[0];
            if (lp) {
                lp.y2 = targetY;
                lp.targetThickness = Math.max(2, targetBand);
            }
        });
    });

    linkPositions.forEach(lp => {
        delete lp._targetOrderKey;
        if (!lp.targetThickness) {
            const targetNode = nodeMap.get(lp.target);
            lp.targetThickness = lp.thickness;
            lp.y2 = targetNode ? targetNode.y + targetNode.height / 2 : lp.y1;
        }
    });

    let maxY = startY;
    layers.forEach(layer => {
        layer.forEach(name => {
            const node = nodeMap.get(name);
            const bottom = node.y + node.height;
            if (bottom > maxY) maxY = bottom;
        });
    });

    const estimateLabelW = (name) => Math.ceil(String(name || '').length * 8.4) + 14;
    const leftNames = layers[0] || [];
    const rightNames = layers[layers.length - 1] || [];
    const leftNeed = Math.max(sideLabelPad, ...leftNames.map(estimateLabelW), 80);
    const rightNeed = Math.max(sideLabelPad, ...rightNames.map(estimateLabelW), 80);

    const shiftX = Math.max(0, leftNeed - startX);
    if (shiftX > 0) {
        nodePositions.forEach((n) => { n.x += shiftX; });
        linkPositions.forEach((l) => { l.x1 += shiftX; l.x2 += shiftX; });
    }

    const lastNodeRight = startX + shiftX + (layers.length - 1) * (nodeWidth + layerGap) + nodeWidth;
    const totalWidth = lastNodeRight + rightNeed;
    const totalHeight = maxY + startY;

    return {
        nodes: nodePositions,
        links: linkPositions,
        title,
        width: totalWidth,
        height: totalHeight,
        nodeWidth
    };
}
