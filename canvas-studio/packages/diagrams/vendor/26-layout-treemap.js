/**
 * Компоновка Treemap — squarified tiling (вложенные прямоугольники по иерархии).
 */
function layoutTreemap(treemapData, options = {}) {
    const root = treemapData && treemapData.root;
    if (!root) return { nodes: [], width: 0, height: 0 };

    const {
        width = 960,
        height = 640,
        padding = 3,
        headerHeight = 22,
        margin = 12,
        titleBand = 36
    } = options;

    const nodes = [];
    const innerX = margin;
    const innerY = titleBand;
    const innerW = Math.max(40, width - margin * 2);
    const innerH = Math.max(40, height - titleBand - margin);

    function worstAspect(row, rowSum, side) {
        if (!row.length || !(rowSum > 0) || !(side > 0)) return Infinity;
        let minV = Infinity;
        let maxV = 0;
        row.forEach((n) => {
            const v = n.value;
            if (v < minV) minV = v;
            if (v > maxV) maxV = v;
        });
        const s2 = side * side;
        const r2 = rowSum * rowSum;
        return Math.max((s2 * maxV) / r2, r2 / (s2 * minV));
    }

    function layoutRow(row, rowSum, x, y, w, h, horizontal) {
        let offset = 0;
        row.forEach((n, idx) => {
            const isLast = idx === row.length - 1;
            if (horizontal) {
                const nh = isLast ? (h - offset) : (h * (n.value / rowSum));
                placeNode(n, x, y + offset, w, nh);
                offset += nh;
            } else {
                const nw = isLast ? (w - offset) : (w * (n.value / rowSum));
                placeNode(n, x + offset, y, nw, h);
                offset += nw;
            }
        });
    }

    function squarify(items, x, y, w, h) {
        if (!(w > 1) || !(h > 1) || !items.length) return;
        const nodesSorted = items.slice().sort((a, b) => b.value - a.value);
        let remaining = nodesSorted.reduce((s, n) => s + n.value, 0);
        if (!(remaining > 0)) return;

        let i = 0;
        let cx = x;
        let cy = y;
        let cw = w;
        let ch = h;

        while (i < nodesSorted.length && remaining > 0 && cw > 0.5 && ch > 0.5) {
            const horizontal = cw >= ch;
            const side = horizontal ? ch : cw;
            const row = [];
            let rowSum = 0;
            let best = Infinity;

            while (i < nodesSorted.length) {
                const trial = row.concat([nodesSorted[i]]);
                const trialSum = rowSum + nodesSorted[i].value;
                const scale = (cw * ch) / remaining;
                const normRow = trial.map((n) => ({ value: n.value * scale }));
                const score = worstAspect(normRow, trialSum * scale, side);
                if (row.length && score > best) break;
                row.push(nodesSorted[i]);
                rowSum = trialSum;
                best = score;
                i++;
            }

            // Доля от оставшейся суммы → оставшийся прямоугольник заполняется целиком
            const rowArea = (rowSum / remaining) * (cw * ch);
            const isLastPass = i >= nodesSorted.length;
            if (horizontal) {
                const rowW = isLastPass ? cw : (rowArea / ch);
                layoutRow(row, rowSum, cx, cy, rowW, ch, true);
                cx += rowW;
                cw -= rowW;
            } else {
                const rowH = isLastPass ? ch : (rowArea / cw);
                layoutRow(row, rowSum, cx, cy, cw, rowH, false);
                cy += rowH;
                ch -= rowH;
            }
            remaining -= rowSum;
        }
    }

    function placeNode(node, x, y, w, h) {
        const depth = node._depth || 0;
        const isLeaf = !node.children || !node.children.length;
        const pad = padding;

        if (isLeaf) {
            nodes.push({
                name: node.name,
                value: node.value,
                x: x + pad / 2,
                y: y + pad / 2,
                width: Math.max(0, w - pad),
                height: Math.max(0, h - pad),
                depth,
                isLeaf: true
            });
            return;
        }

        const hdr = Math.min(headerHeight, Math.max(0, h * 0.2));
        nodes.push({
            name: node.name,
            value: node.value,
            x: x + pad / 2,
            y: y + pad / 2,
            width: Math.max(0, w - pad),
            height: Math.max(0, hdr - pad / 2),
            depth,
            isLeaf: false,
            isHeader: true
        });

        const kids = node.children || [];
        if (!kids.length) return;
        const ix = x + pad;
        const iy = y + hdr + pad / 2;
        const iw = Math.max(0, w - pad * 2);
        const ih = Math.max(0, h - hdr - pad);
        kids.forEach((c) => { c._depth = depth + 1; });
        squarify(kids, ix, iy, iw, ih);
    }

    root._depth = 0;
    if (root.children && root.children.length) {
        // Корень — рамка всего treemap без отдельного заголовка-полосы на весь холст:
        // дети заполняют область; имя корня рисуется в title layout
        squarify(root.children.map((c) => {
            c._depth = 1;
            return c;
        }), innerX, innerY, innerW, innerH);
    } else {
        placeNode(root, innerX, innerY, innerW, innerH);
    }

    // Diagnostics парсера не копируем — mergeDiagnostics(parser, layout) сделает это сам
    return {
        nodes,
        rootName: (treemapData && treemapData.title) || root.name,
        rootValue: root.value,
        width,
        height
    };
}
