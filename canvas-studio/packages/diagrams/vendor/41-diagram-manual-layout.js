/**
 * Ручная раскладка узлов: режим ON — двигать узлы (+ мультивыбор) и править текст;
 * OFF — только текст. Overrides: { nodes: { [id]: { dx, dy } } }.
 * Поддержка: flowchart, radial, classic, horizontal.
 */
(function (global) {
    'use strict';

    const MANUAL_LAYOUTS = { flowchart: 1, radial: 1, classic: 1, horizontal: 1 };
    const NODE_SEL = 'g.fc-node[data-node-id], g.mm-node[data-node-id]';

    let manualLayoutEnabled = false;
    let layoutOverrides = { nodes: {} };
    let dragSession = null;
    let selectedIds = new Set();
    let marqueeSession = null;
    let undoStack = [];
    let redoStack = [];
    const UNDO_LIMIT = 40;

    function resolveDiagramLayout() {
        try {
            const fromBody = document.body && document.body.getAttribute('data-diagram-layout');
            if (fromBody) return String(fromBody);
        } catch (_) { /* ignore */ }
        try {
            const activeBtn = document.querySelector('.layout-btn.active[data-layout], .layout-btn[aria-pressed="true"][data-layout]');
            if (activeBtn && activeBtn.getAttribute('data-layout')) {
                return String(activeBtn.getAttribute('data-layout'));
            }
        } catch (_) { /* ignore */ }
        try {
            if (typeof currentLayout !== 'undefined' && currentLayout) return String(currentLayout);
        } catch (_) { /* ignore */ }
        try {
            if (global.currentLayout) return String(global.currentLayout);
        } catch (_) { /* ignore */ }
        return '';
    }

    function supportsManualLayout(layout) {
        return !!MANUAL_LAYOUTS[String(layout || '')];
    }

    function cloneOverrides(src) {
        const out = { nodes: {} };
        const nodes = (src && src.nodes) || {};
        Object.keys(nodes).forEach((id) => {
            const o = nodes[id];
            if (!o) return;
            const dx = Number(o.dx) || 0;
            const dy = Number(o.dy) || 0;
            if (!dx && !dy) return;
            out.nodes[String(id)] = { dx: dx, dy: dy };
        });
        return out;
    }

    function isManualLayoutEnabled() {
        return !!manualLayoutEnabled;
    }

    function setManualLayoutEnabled(on, opts) {
        opts = opts || {};
        const next = !!on;
        if (next === manualLayoutEnabled && !opts.force) {
            updateManualLayoutUI();
            return manualLayoutEnabled;
        }
        manualLayoutEnabled = next;
        if (!manualLayoutEnabled) clearSelection();
        try {
            document.body.classList.toggle('diagram-manual-layout', manualLayoutEnabled);
        } catch (_) { /* ignore */ }
        updateManualLayoutUI();
        if (opts.syncTool !== false && typeof global.syncDiagramToolWithManualLayout === 'function') {
            try { global.syncDiagramToolWithManualLayout(manualLayoutEnabled); } catch (_) { /* ignore */ }
        }
        if (opts.save !== false && typeof global.saveState === 'function') global.saveState();
        if (opts.rerender !== false && typeof global.generateMindmap === 'function') {
            global.generateMindmap(!!opts.keepView);
        }
        return manualLayoutEnabled;
    }

    function getLayoutOverrides() {
        return cloneOverrides(layoutOverrides);
    }

    function setLayoutOverrides(next, opts) {
        opts = opts || {};
        layoutOverrides = cloneOverrides(next || {});
        updateManualLayoutUI();
        if (opts.save !== false && typeof global.saveState === 'function') global.saveState();
        if (opts.rerender && typeof global.generateMindmap === 'function') {
            global.generateMindmap(opts.keepView !== false);
        }
    }

    function clearLayoutOverrides(opts) {
        if (hasLayoutOverrides()) pushUndoSnapshot();
        setLayoutOverrides({ nodes: {} }, Object.assign({ rerender: true, keepView: true }, opts || {}));
    }

    function hasLayoutOverrides() {
        return Object.keys((layoutOverrides && layoutOverrides.nodes) || {}).length > 0;
    }

    function pushUndoSnapshot(before) {
        const snap = cloneOverrides(before != null ? before : layoutOverrides);
        undoStack.push(snap);
        if (undoStack.length > UNDO_LIMIT) undoStack.shift();
        redoStack = [];
    }

    function undoManualLayout() {
        if (!undoStack.length) return false;
        redoStack.push(cloneOverrides(layoutOverrides));
        const prev = undoStack.pop();
        layoutOverrides = cloneOverrides(prev || { nodes: {} });
        updateManualLayoutUI();
        if (typeof global.saveState === 'function') global.saveState();
        if (typeof global.generateMindmap === 'function') global.generateMindmap(true);
        return true;
    }

    function redoManualLayout() {
        if (!redoStack.length) return false;
        undoStack.push(cloneOverrides(layoutOverrides));
        const next = redoStack.pop();
        layoutOverrides = cloneOverrides(next || { nodes: {} });
        updateManualLayoutUI();
        if (typeof global.saveState === 'function') global.saveState();
        if (typeof global.generateMindmap === 'function') global.generateMindmap(true);
        return true;
    }

    function cssEscape(id) {
        if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(String(id));
        return String(id).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    function clientToSvgPoint(svg, clientX, clientY) {
        const pt = svg.createSVGPoint();
        pt.x = clientX;
        pt.y = clientY;
        const ctm = svg.getScreenCTM();
        if (!ctm) return { x: clientX, y: clientY };
        const p = pt.matrixTransform(ctm.inverse());
        return { x: p.x, y: p.y };
    }

    function queryNode(svg, nodeId) {
        if (!svg || !nodeId) return null;
        return svg.querySelector(
            'g.fc-node[data-node-id="' + cssEscape(nodeId) + '"], g.mm-node[data-node-id="' + cssEscape(nodeId) + '"]'
        );
    }

    function syncSelectionClasses(svg) {
        const root = svg || document.querySelector('#diagram svg');
        if (!root) return;
        root.querySelectorAll(NODE_SEL).forEach(function (g) {
            const id = g.getAttribute('data-node-id');
            g.classList.toggle('is-selected', !!(id && selectedIds.has(id)));
        });
    }

    function clearSelection(svg) {
        selectedIds = new Set();
        syncSelectionClasses(svg);
    }

    function setSelection(ids, svg) {
        selectedIds = new Set((ids || []).map(String).filter(Boolean));
        syncSelectionClasses(svg);
    }

    function toggleSelection(id, svg) {
        const s = String(id || '');
        if (!s) return;
        if (selectedIds.has(s)) selectedIds.delete(s);
        else selectedIds.add(s);
        syncSelectionClasses(svg);
    }

    function selectOnly(id, svg) {
        selectedIds = new Set(id ? [String(id)] : []);
        syncSelectionClasses(svg);
    }

    /** Стабильные path-id для дерева: "0", "0.1", "0.1.2" */
    function assignTreeNodeIds(root) {
        if (!root) return;
        function walk(node, path) {
            if (!node) return;
            node.id = String(path);
            const kids = node.children || [];
            for (let i = 0; i < kids.length; i++) walk(kids[i], path + '.' + i);
        }
        walk(root, '0');
    }

    function captureTreeAutoPos(root) {
        if (!root) return;
        function walk(node) {
            if (!node) return;
            node._autoPos = { x: Number(node.x) || 0, y: Number(node.y) || 0 };
            (node.children || []).forEach(walk);
        }
        walk(root);
    }

    function applyTreeManualOffsets(root, overrides) {
        if (!root) return root;
        const nodesMap = (overrides && overrides.nodes) || {};
        function walk(node) {
            if (!node) return;
            const id = String(node.id || '');
            if (!node._autoPos) node._autoPos = { x: Number(node.x) || 0, y: Number(node.y) || 0 };
            const base = node._autoPos;
            const o = nodesMap[id] || {};
            node.x = base.x + (Number(o.dx) || 0);
            node.y = base.y + (Number(o.dy) || 0);
            (node.children || []).forEach(walk);
        }
        walk(root);
        return root;
    }

    function prepareTreeManualLayout(root, overrides) {
        if (!root) return root;
        assignTreeNodeIds(root);
        captureTreeAutoPos(root);
        if (overrides && overrides.nodes && Object.keys(overrides.nodes).length) {
            applyTreeManualOffsets(root, overrides);
        }
        return root;
    }

    function setNodeOffset(nodeId, dx, dy) {
        const id = String(nodeId || '');
        if (!id) return;
        if (!layoutOverrides.nodes) layoutOverrides.nodes = {};
        const x = Number(dx) || 0;
        const y = Number(dy) || 0;
        if (!x && !y) delete layoutOverrides.nodes[id];
        else layoutOverrides.nodes[id] = { dx: x, dy: y };
    }

    function endDrag(commit) {
        if (!dragSession) return;
        const sess = dragSession;
        dragSession = null;
        try {
            document.body.classList.remove('diagram-node-dragging');
            const container = document.getElementById('diagram');
            if (container) container.removeAttribute('data-manual-dragging');
        } catch (_) { /* ignore */ }
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);
        if (commit) {
            const moved = Math.abs(sess.ddx) > 0.5 || Math.abs(sess.ddy) > 0.5;
            if (moved) {
                pushUndoSnapshot(sess.beforeOverrides || layoutOverrides);
                (sess.ids || [sess.nodeId]).forEach(function (id) {
                    const start = (sess.starts && sess.starts[id]) || { dx: 0, dy: 0 };
                    setNodeOffset(id, start.dx + sess.ddx, start.dy + sess.ddy);
                });
                if (typeof global.saveState === 'function') global.saveState();
                if (typeof global.generateMindmap === 'function') global.generateMindmap(true);
                updateManualLayoutUI();
            } else {
                // клик без сдвига — снять transform-превью
                (sess.ids || []).forEach(function (id) {
                    const g = queryNode(sess.svg, id);
                    if (g) g.removeAttribute('transform');
                });
            }
        }
    }

    function onPointerMove(e) {
        if (marqueeSession) {
            updateMarquee(e);
            return;
        }
        if (!dragSession) return;
        const sess = dragSession;
        const svg = sess.svg;
        if (!svg || !svg.isConnected) {
            const live = document.querySelector('#diagram svg');
            if (!live) {
                endDrag(false);
                return;
            }
            sess.svg = live;
        }
        const cur = clientToSvgPoint(sess.svg, e.clientX, e.clientY);
        const ddx = cur.x - sess.origin.x;
        const ddy = cur.y - sess.origin.y;
        sess.ddx = ddx;
        sess.ddy = ddy;
        (sess.ids || []).forEach(function (id) {
            const g = queryNode(sess.svg, id);
            if (g) {
                g.setAttribute('transform', 'translate(' + ddx + ' ' + ddy + ')');
                g.style.cursor = 'grabbing';
            }
        });
    }

    function onPointerUp(e) {
        if (marqueeSession) {
            finishMarquee(e);
            return;
        }
        endDrag(true);
    }

    function ensureMarqueeEl(svg) {
        let el = svg.querySelector('rect.mm-marquee');
        if (el) return el;
        const ns = 'http://www.w3.org/2000/svg';
        el = document.createElementNS(ns, 'rect');
        el.setAttribute('class', 'mm-marquee');
        el.setAttribute('fill', 'rgba(14, 116, 144, 0.12)');
        el.setAttribute('stroke', '#0e7490');
        el.setAttribute('stroke-width', '1.5');
        el.setAttribute('stroke-dasharray', '4 3');
        el.setAttribute('pointer-events', 'none');
        svg.appendChild(el);
        return el;
    }

    function updateMarquee(e) {
        const sess = marqueeSession;
        if (!sess) return;
        const cur = clientToSvgPoint(sess.svg, e.clientX, e.clientY);
        sess.cur = cur;
        const x = Math.min(sess.origin.x, cur.x);
        const y = Math.min(sess.origin.y, cur.y);
        const w = Math.abs(cur.x - sess.origin.x);
        const h = Math.abs(cur.y - sess.origin.y);
        const el = ensureMarqueeEl(sess.svg);
        el.setAttribute('x', x);
        el.setAttribute('y', y);
        el.setAttribute('width', w);
        el.setAttribute('height', h);
        el.style.display = w + h > 2 ? '' : 'none';
    }

    function finishMarquee(e) {
        const sess = marqueeSession;
        marqueeSession = null;
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);
        if (!sess || !sess.svg) return;
        const el = sess.svg.querySelector('rect.mm-marquee');
        if (el) el.remove();
        const curX = e ? e.clientX : (sess.originClient && sess.originClient.x);
        const curY = e ? e.clientY : (sess.originClient && sess.originClient.y);
        if (curX == null || curY == null) return;
        const ox = sess.originClient ? sess.originClient.x : curX;
        const oy = sess.originClient ? sess.originClient.y : curY;
        const x1 = Math.min(ox, curX);
        const y1 = Math.min(oy, curY);
        const x2 = Math.max(ox, curX);
        const y2 = Math.max(oy, curY);
        if (Math.abs(x2 - x1) < 4 && Math.abs(y2 - y1) < 4) {
            if (!sess.additive) clearSelection(sess.svg);
            return;
        }
        // Hit-test в экранных координатах — устойчиво к viewBox / transform / направлению рамки
        const hit = [];
        sess.svg.querySelectorAll(NODE_SEL).forEach(function (g) {
            try {
                const r = g.getBoundingClientRect();
                if (r.width < 1 && r.height < 1) return;
                if (r.right >= x1 && r.left <= x2 && r.bottom >= y1 && r.top <= y2) {
                    const id = g.getAttribute('data-node-id');
                    if (id) hit.push(id);
                }
            } catch (_) { /* ignore */ }
        });
        if (sess.additive) {
            hit.forEach(function (id) { selectedIds.add(id); });
            syncSelectionClasses(sess.svg);
        } else {
            setSelection(hit, sess.svg);
        }
    }

    function startMarquee(svg, e, additive) {
        const origin = clientToSvgPoint(svg, e.clientX, e.clientY);
        marqueeSession = {
            svg: svg,
            origin: origin,
            cur: origin,
            originClient: { x: e.clientX, y: e.clientY },
            additive: !!additive
        };
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);
    }

    function startGroupDrag(svg, e, primaryId) {
        const id = String(primaryId || '');
        if (!id) return;
        const additive = e.shiftKey || e.metaKey || e.ctrlKey;
        if (additive) {
            toggleSelection(id, svg);
        } else if (!selectedIds.has(id)) {
            selectOnly(id, svg);
        }
        if (!selectedIds.size) selectOnly(id, svg);

        const ids = Array.from(selectedIds);
        const starts = {};
        ids.forEach(function (nid) {
            const cur = (layoutOverrides.nodes && layoutOverrides.nodes[nid]) || {};
            starts[nid] = { dx: Number(cur.dx) || 0, dy: Number(cur.dy) || 0 };
        });
        const origin = clientToSvgPoint(svg, e.clientX, e.clientY);
        dragSession = {
            svg: svg,
            nodeId: id,
            ids: ids,
            starts: starts,
            beforeOverrides: cloneOverrides(layoutOverrides),
            origin: origin,
            ddx: 0,
            ddy: 0
        };
        try {
            document.body.classList.add('diagram-node-dragging');
            const container = document.getElementById('diagram');
            if (container) container.setAttribute('data-manual-dragging', '1');
        } catch (_) { /* ignore */ }
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);
    }

    function bindManualLayout(svg) {
        if (!svg) return;

        if (!manualLayoutEnabled) {
            svg.querySelectorAll(NODE_SEL).forEach(function (g) {
                g.removeAttribute('data-manual-draggable');
                g.classList.remove('is-selected');
                g.style.cursor = '';
            });
            return;
        }

        svg.querySelectorAll(NODE_SEL).forEach(function (g) {
            g.setAttribute('data-manual-draggable', '1');
            g.style.cursor = 'grab';
        });
        syncSelectionClasses(svg);

        if (svg._manualLayoutBound) return;
        svg._manualLayoutBound = true;
        svg.addEventListener('pointerdown', function (e) {
            if (!manualLayoutEnabled) return;
            if (e.button != null && e.button !== 0) return;
            const g = e.target && e.target.closest
                ? e.target.closest(NODE_SEL + '[data-manual-draggable]')
                : null;
            if (g && svg.contains(g)) {
                const nodeId = g.getAttribute('data-node-id');
                if (!nodeId) return;
                e.preventDefault();
                e.stopPropagation();
                // Shift/⌘ — добавить к выделению; обычный клик по уже выбранному — двигать группу
                startGroupDrag(svg, e, nodeId);
                return;
            }
            // Пустое место: ЛКМ без модификаторов = рамка выделения
            if (e.target === svg || (e.target && e.target.closest && !e.target.closest(NODE_SEL))) {
                e.preventDefault();
                e.stopPropagation();
                startMarquee(svg, e, e.shiftKey || e.metaKey || e.ctrlKey);
            }
        });
    }

    /** @deprecated alias */
    function bindFlowchartManualLayout(svg, layout) {
        if (svg && layout) svg._manualLayoutData = { layout: layout };
        bindManualLayout(svg);
    }

    function updateManualLayoutUI() {
        const layout = resolveDiagramLayout();
        const show = supportsManualLayout(layout);
        const row = document.getElementById('manualLayoutRow');
        // В «Оформлении» только сброс смещений, когда они есть
        if (row) row.style.display = (show && hasLayoutOverrides()) ? 'flex' : 'none';

        const stripBtn = document.getElementById('manualLayoutStripBtn');
        if (stripBtn) {
            stripBtn.hidden = true;
            stripBtn.setAttribute('hidden', '');
            stripBtn.style.display = 'none';
            stripBtn.setAttribute('aria-hidden', 'true');
        }

        const selectBtn = document.getElementById('diagramToolSelectBtn');
        if (selectBtn) {
            const can = show;
            selectBtn.disabled = !can;
            selectBtn.style.opacity = can ? '' : '0.4';
            selectBtn.title = can
                ? (manualLayoutEnabled
                    ? 'Ручная раскладка включена: ЛКМ-рамка выделяет, перетаскивание двигает'
                    : 'Ручная раскладка: выделить и двигать узлы')
                : 'Ручная раскладка доступна для Радиал / Классика / Иерарх / Блок-схема';
            if (!can && manualLayoutEnabled) {
                // тип схемы не поддерживает — выключим без рекурсии tool
                manualLayoutEnabled = false;
                try { document.body.classList.remove('diagram-manual-layout'); } catch (_) { /* ignore */ }
            }
        }

        const resetBtn = document.getElementById('manualLayoutResetBtn');
        if (resetBtn) {
            resetBtn.disabled = !hasLayoutOverrides();
            resetBtn.style.opacity = hasLayoutOverrides() ? '' : '0.45';
        }
    }

    function initManualLayoutUI() {
        document.querySelectorAll('[data-manual-layout]').forEach(function (btn) {
            if (btn._manualLayoutBound) return;
            btn._manualLayoutBound = true;
            btn.addEventListener('click', function () {
                const on = btn.getAttribute('data-manual-layout') === '1';
                setManualLayoutEnabled(on, { keepView: true });
            });
        });
        const resetBtn = document.getElementById('manualLayoutResetBtn');
        if (resetBtn && !resetBtn._manualLayoutBound) {
            resetBtn._manualLayoutBound = true;
            resetBtn.addEventListener('click', function () {
                clearLayoutOverrides({ save: true });
            });
        }
        const stripBtn = document.getElementById('manualLayoutStripBtn');
        if (stripBtn && !stripBtn._manualLayoutBound) {
            stripBtn._manualLayoutBound = true;
            stripBtn.addEventListener('click', function () {
                setManualLayoutEnabled(!manualLayoutEnabled, { keepView: true });
            });
        }
        if (!document._manualLayoutUndoBound) {
            document._manualLayoutUndoBound = true;
            document.addEventListener('keydown', function (e) {
                if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
                const key = String(e.key || '').toLowerCase();
                const isUndo = key === 'z' && !e.shiftKey;
                const isRedo = (key === 'z' && e.shiftKey) || key === 'y';
                if (!isUndo && !isRedo) return;
                const ae = document.activeElement;
                if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.isContentEditable)) return;
                // Есть стек смещений — перехватываем до ui.js (фокус в textarea)
                if (isUndo && undoStack.length) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    undoManualLayout();
                    return;
                }
                if (isRedo && redoStack.length) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    redoManualLayout();
                }
            }, true);
        }
        updateManualLayoutUI();
    }

    global.isManualLayoutEnabled = isManualLayoutEnabled;
    global.setManualLayoutEnabled = setManualLayoutEnabled;
    global.getLayoutOverrides = getLayoutOverrides;
    global.setLayoutOverrides = setLayoutOverrides;
    global.clearLayoutOverrides = clearLayoutOverrides;
    global.hasLayoutOverrides = hasLayoutOverrides;
    global.undoManualLayout = undoManualLayout;
    global.redoManualLayout = redoManualLayout;
    global.bindFlowchartManualLayout = bindFlowchartManualLayout;
    global.bindManualLayout = bindManualLayout;
    global.assignTreeNodeIds = assignTreeNodeIds;
    global.prepareTreeManualLayout = prepareTreeManualLayout;
    global.applyTreeManualOffsets = applyTreeManualOffsets;
    global.supportsManualLayout = supportsManualLayout;
    global.updateManualLayoutUI = updateManualLayoutUI;
    global.initManualLayoutUI = initManualLayoutUI;
})(typeof window !== 'undefined' ? window : this);
