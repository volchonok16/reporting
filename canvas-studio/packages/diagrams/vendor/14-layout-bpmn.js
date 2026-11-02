/**
 * Компоновка BPMN: ярусы по графу потоков, слоты в дорожке, ортогональные маршруты.
 */
function layoutBPMN(bpmnData, options = {}) {
    const { elements, lanes, flows, pools } = bpmnData;
    const {
        laneHeight = 140,
        laneGap = 56,
        startX = 120,
        startY = 100,
        taskWidth = 130,
        taskHeight = 60,
        eventRadius = 25,
        gatewaySize = 50,
        annotationWidth = 160,
        annotationHeight = 50,
        dataWidth = 56,
        dataHeight = 70,
        elementSpacing = 70,
        rankGap = 70,
        slotGap = 28,
        poolGap = 28,
        poolHeader = 28
    } = options;

    if (lanes.length === 0) {
        lanes.push({ name: 'Основная дорожка', pool: null });
        elements.forEach(el => { if (!el.lane) el.lane = 'Основная дорожка'; });
    }

    const defaultLane = lanes[0].name;
    elements.forEach(el => {
        if (!el.lane) el.lane = defaultLane;
        if (el.attachedTo && !el.boundary) el.boundary = true;
    });

    // Размеры фигур
    function sizeOf(el) {
        if (el.type === 'task') {
            if (el.taskType === 'подпроцесс' || el.isSubprocess) {
                const kids = (el.children && el.children.length) || 0;
                const innerCols = Math.max(1, Math.ceil(Math.sqrt(Math.max(kids, 1))));
                const innerRows = Math.max(1, Math.ceil(Math.max(kids, 1) / innerCols));
                return {
                    w: Math.max(taskWidth + 40, 36 + innerCols * 88),
                    h: Math.max(taskHeight + 24, 40 + innerRows * 36)
                };
            }
            return { w: taskWidth, h: taskHeight };
        }
        if (el.type === 'event') return { w: eventRadius * 2, h: eventRadius * 2 };
        if (el.type === 'gateway') return { w: gatewaySize, h: gatewaySize };
        if (el.type === 'annotation') {
            const padX = 16;
            const fontSize = 11;
            const lineHeight = fontSize * 1.3;
            const lines = wrapTextLines(el.name, annotationWidth - padX, fontSize);
            el._wrapLines = lines;
            return { w: annotationWidth, h: Math.max(annotationHeight, 12 + lines.length * lineHeight) };
        }
        if (el.type === 'data' || el.type === 'datastore') {
            return { w: dataWidth, h: dataHeight };
        }
        return { w: taskWidth, h: taskHeight };
    }

    elements.forEach((el) => {
        const s = sizeOf(el);
        el.width = s.w;
        el.height = s.h;
    });

    // Граф для раскладки: sequence + message (association не двигает узлы)
    const layoutFlows = flows.filter((f) =>
        f.type === 'sequence' || f.type === 'conditional' || f.type === 'default' || f.type === 'message' || !f.type
    );
    const assocFlows = flows.filter((f) => f.type === 'association');
    const msgFlows = []; // message уже в layoutFlows для рангов; маршруты — все вместе ниже

    const nameToEl = new Map(elements.map((e) => [e.name, e]));
    const freeElements = elements.filter((e) =>
        !(e.boundary && e.attachedTo) && !e._nested && !e.parentSubprocess
    );

    const outs = new Map();
    const inns = new Map();
    freeElements.forEach((e) => {
        outs.set(e.name, []);
        inns.set(e.name, []);
    });
    layoutFlows.forEach((f) => {
        if (!outs.has(f.from) || !inns.has(f.to)) return;
        const toEl = nameToEl.get(f.to);
        // Обратные/условные рёбра в событие-старт не тянут старт вправо
        if (toEl && toEl.type === 'event' && toEl.eventType === 'начало') return;
        outs.get(f.from).push(f.to);
        inns.get(f.to).push(f.from);
    });

    const rank = new Map();
    function computeRank(name, stack) {
        if (rank.has(name)) return rank.get(name);
        if (stack.has(name)) return 0;
        const el = nameToEl.get(name);
        if (el && el.type === 'event' && el.eventType === 'начало') {
            rank.set(name, 0);
            return 0;
        }
        stack.add(name);
        const preds = inns.get(name) || [];
        let r = 0;
        if (preds.length) {
            r = Math.max(...preds.map((p) => computeRank(p, stack) + 1));
        }
        stack.delete(name);
        rank.set(name, r);
        return r;
    }
    freeElements.forEach((e) => computeRank(e.name, new Set()));

    // События-завершения без предшественников в графе рангов — от message/sequence в исходных flows
    let maxRankSeen = 0;
    freeElements.forEach((e) => {
        maxRankSeen = Math.max(maxRankSeen, rank.get(e.name) || 0);
    });
    freeElements.forEach((e) => {
        if (e.type === 'event' && e.eventType === 'завершение') {
            const preds = inns.get(e.name) || [];
            if (!preds.length) {
                const fromMsg = flows.filter((f) => f.to === e.name && nameToEl.has(f.from));
                if (fromMsg.length) {
                    const pr = Math.max(...fromMsg.map((f) => (rank.get(f.from) || 0) + 1), maxRankSeen);
                    rank.set(e.name, pr);
                    // зарегистрировать для слотов
                    fromMsg.forEach((f) => {
                        if (inns.has(e.name) && !inns.get(e.name).includes(f.from)) {
                            inns.get(e.name).push(f.from);
                        }
                    });
                    maxRankSeen = Math.max(maxRankSeen, pr);
                }
            }
        }
    });

    // В дорожке: параллельные (общий предшественник) делят колонку.
    // Не толкаем вправо элементы, у которых уже есть ранг по графу —
    // иначе «Нет в наличии» (ветка от шлюза) уезжает в конец дорожки.
    const declIndex = new Map(freeElements.map((e, i) => [e.name, i]));
    function shareColumn(a, b) {
        const pa = inns.get(a.name) || [];
        const pb = inns.get(b.name) || [];
        if (!pa.length || !pb.length) return false;
        return pa.some((p) => pb.includes(p));
    }
    lanes.forEach((lane) => {
        const els = freeElements
            .filter((e) => e.lane === lane.name)
            .sort((a, b) => declIndex.get(a.name) - declIndex.get(b.name));
        const placed = [];
        els.forEach((el) => {
            let r = rank.get(el.name) || 0;
            const peers = placed.filter((p) => shareColumn(el, p));
            const preds = inns.get(el.name) || [];
            if (peers.length) {
                r = Math.min(...peers.map((p) => rank.get(p.name) || 0));
            } else if (!preds.length && placed.length) {
                // Нет входящих рёбер — ставим правее уже размещённых в этой дорожке
                const maxPrev = Math.max(...placed.map((p) => rank.get(p.name) || 0));
                if (r <= maxPrev) r = maxPrev + 1;
            }
            rank.set(el.name, r);
            placed.push(el);
        });
    });

    // Внутри дорожки: слот по ветвлению (barycenter / порядок объявления)
    const laneEls = new Map();
    lanes.forEach((lane) => laneEls.set(lane.name, []));
    freeElements.forEach((el) => {
        if (laneEls.has(el.lane)) laneEls.get(el.lane).push(el);
        else {
            // элемент вне известных дорожек — в первую
            laneEls.get(defaultLane).push(el);
            el.lane = defaultLane;
        }
    });

    laneEls.forEach((els) => {
        // группируем по rank
        const byRank = new Map();
        els.forEach((el) => {
            const r = rank.get(el.name) || 0;
            el._rank = r;
            if (!byRank.has(r)) byRank.set(r, []);
            byRank.get(r).push(el);
        });
        // слоты: для каждого ранга — порядок по среднему слоту родителей, иначе порядок в тексте
        const orderIndex = new Map(els.map((e, i) => [e.name, i]));
        const maxRank = Math.max(0, ...els.map((e) => e._rank));
        for (let r = 0; r <= maxRank; r++) {
            const group = byRank.get(r) || [];
            group.sort((a, b) => {
                const pa = (inns.get(a.name) || [])
                    .map((n) => nameToEl.get(n))
                    .filter((p) => p && p.lane === a.lane && p._slot != null);
                const pb = (inns.get(b.name) || [])
                    .map((n) => nameToEl.get(n))
                    .filter((p) => p && p.lane === b.lane && p._slot != null);
                const ba = pa.length ? pa.reduce((s, p) => s + p._slot, 0) / pa.length : orderIndex.get(a.name);
                const bb = pb.length ? pb.reduce((s, p) => s + p._slot, 0) / pb.length : orderIndex.get(b.name);
                if (ba !== bb) return ba - bb;
                return orderIndex.get(a.name) - orderIndex.get(b.name);
            });
            group.forEach((el, i) => { el._slot = i; });
        }
    });

    // Пулы: группировка дорожек
    const poolList = (pools && pools.length)
        ? pools
        : [{ name: null, lanes: lanes.map((l) => l.name) }];

    // если у дорожек есть pool, пересоберём
    const poolFromLanes = [];
    if (!pools || !pools.length) {
        const seen = new Map();
        lanes.forEach((l) => {
            const pn = l.pool || null;
            if (!seen.has(pn)) {
                seen.set(pn, { name: pn, lanes: [] });
                poolFromLanes.push(seen.get(pn));
            }
            seen.get(pn).lanes.push(l.name);
        });
    }
    const effectivePools = (pools && pools.length) ? pools : poolFromLanes;

    const titleBand = 32;
    const vPad = 18;
    let currentY = startY + (bpmnData.processName ? 20 : 0);
    const lanePositions = [];
    const poolPositions = [];
    const elementPositions = new Map();

    // глобальный max rank для выравнивания X между дорожками
    let globalMaxRank = 0;
    freeElements.forEach((e) => {
        globalMaxRank = Math.max(globalMaxRank, e._rank || 0);
    });

    // ширина колонки = max width в ранге
    const rankMaxW = [];
    for (let r = 0; r <= globalMaxRank; r++) {
        let mw = taskWidth;
        freeElements.forEach((e) => {
            if ((e._rank || 0) === r) mw = Math.max(mw, e.width || taskWidth);
        });
        rankMaxW[r] = mw;
    }
    const rankX = [];
    let cx = startX;
    for (let r = 0; r <= globalMaxRank; r++) {
        rankX[r] = cx;
        cx += rankMaxW[r] + rankGap;
    }

    effectivePools.forEach((pool) => {
        const poolLaneNames = pool.lanes || [];
        // подхватить дорожки с тем же pool.name, если забыли в списке
        if (pool.name) {
            lanes.forEach((l) => {
                if (l.pool === pool.name && !poolLaneNames.includes(l.name)) {
                    poolLaneNames.push(l.name);
                }
            });
        }
        const poolTop = currentY;
        if (pool.name) currentY += poolHeader + 8;

        poolLaneNames.forEach((laneName) => {
            const lane = lanes.find((l) => l.name === laneName) || { name: laneName };
            const els = (laneEls.get(laneName) || []).slice();
            const hasNotes = els.some((el) => el.note);
            const needsBelowLabel = els.some((el) => el.type === 'gateway' || el.type === 'event' || el.type === 'data' || el.type === 'datastore');
            const belowLabelReserve = needsBelowLabel ? 28 : 0;
            const noteReserve = hasNotes ? 48 : 0;

            const maxSlot = els.reduce((m, e) => Math.max(m, e._slot || 0), 0);
            let maxFigH = taskHeight;
            els.forEach((el) => { maxFigH = Math.max(maxFigH, el.height || taskHeight); });

            const minGap = Math.max(slotGap, 20);
            const slotH = maxFigH + minGap;
            const contentH = Math.max(
                maxFigH + belowLabelReserve,
                slotH * (maxSlot + 1) - minGap + belowLabelReserve,
                88
            );
            const effectiveLaneH = titleBand + vPad * 2 + contentH + noteReserve;
            const slots = maxSlot + 1;
            const usable = contentH - belowLabelReserve;
            // Один step на всю дорожку — иначе task/event на соседних рангах получают разный Y
            const laneStep = slots <= 1
                ? usable
                : Math.max(usable / slots, maxFigH + minGap);

            els.forEach((el) => {
                const r = el._rank || 0;
                const slot = el._slot || 0;
                const colW = rankMaxW[r] || el.width;
                el.x = rankX[r] + (colW - el.width) / 2;
                const bandTop = currentY + titleBand + vPad;
                if (slots <= 1) {
                    el.y = bandTop + (usable - el.height) / 2;
                } else {
                    el.y = bandTop + slot * laneStep + (laneStep - el.height) / 2;
                }
                elementPositions.set(el.name, el);
            });

            // boundary events — на нижнем/боковом краю attached задачи
            elements.filter((e) => e.boundary && e.attachedTo).forEach((bev) => {
                if (bev.lane !== laneName) return;
                const host = elementPositions.get(bev.attachedTo);
                if (!host) return;
                bev.width = eventRadius * 2;
                bev.height = eventRadius * 2;
                bev.x = host.x + host.width - eventRadius;
                bev.y = host.y + host.height - eventRadius;
                elementPositions.set(bev.name, bev);
            });

            // дети подпроцесса — сетка внутри
            els.filter((e) => e.isSubprocess || e.taskType === 'подпроцесс').forEach((sp) => {
                const kids = (sp.children || []).map((n) => nameToEl.get(n)).filter(Boolean);
                if (!kids.length) return;
                const cols = Math.max(1, Math.ceil(Math.sqrt(kids.length)));
                const cellW = 80;
                const cellH = 28;
                kids.forEach((kid, i) => {
                    const c = i % cols;
                    const row = Math.floor(i / cols);
                    kid.width = Math.min(kid.width || 72, cellW - 6);
                    kid.height = Math.min(kid.height || 24, cellH - 4);
                    kid.x = sp.x + 12 + c * cellW;
                    kid.y = sp.y + 28 + row * cellH;
                    kid._nested = true;
                    elementPositions.set(kid.name, kid);
                });
            });

            lanePositions.push({
                lane,
                y: currentY,
                height: effectiveLaneH,
                name: lane.name,
                pool: pool.name || null
            });
            currentY += effectiveLaneH + laneGap;
        });

        if (pool.name) {
            poolPositions.push({
                name: pool.name,
                y: poolTop,
                height: currentY - poolTop - laneGap + 8,
                x: 12,
            });
            currentY += poolGap;
        }
    });

    const laneByName = new Map(lanePositions.map((lp) => [lp.name, lp]));

    const maxX = elements.reduce((max, el) => Math.max(max, (el.x || 0) + (el.width || 0)), startX);
    const maxY = currentY - laneGap;

    // Ортогональные маршруты; якоря на краю фигуры (особенно круги событий)
    const edgeBucket = new Map();
    function bucketKey(a, b, route) {
        return a + '=>' + b + '|' + route;
    }

    function centerOf(el) {
        return { x: el.x + el.width / 2, y: el.y + el.height / 2 };
    }

    /** Точка на периметре фигуры в сторону (tx,ty) */
    function edgeAnchor(el, tx, ty) {
        const c = centerOf(el);
        const dx = tx - c.x;
        const dy = ty - c.y;
        if (el.type === 'event') {
            const r = (el.width || eventRadius * 2) / 2;
            const len = Math.hypot(dx, dy) || 1;
            return { x: c.x + (dx / len) * r, y: c.y + (dy / len) * r };
        }
        if (el.type === 'gateway') {
            // ромб: приближаем как круг чуть меньше
            const r = Math.min(el.width, el.height) * 0.42;
            const len = Math.hypot(dx, dy) || 1;
            return { x: c.x + (dx / len) * r, y: c.y + (dy / len) * r };
        }
        // прямоугольник — сторона по доминирующей оси
        if (Math.abs(dx) >= Math.abs(dy)) {
            return {
                x: dx >= 0 ? el.x + el.width : el.x,
                y: Math.max(el.y + 8, Math.min(el.y + el.height - 8, c.y + dy * 0.15))
            };
        }
        return {
            x: Math.max(el.x + 8, Math.min(el.x + el.width - 8, c.x + dx * 0.15)),
            y: dy >= 0 ? el.y + el.height : el.y
        };
    }

    const positionedFlows = [];
    const skippedFlows = [];
    const allRouteFlows = [...layoutFlows, ...assocFlows];

    allRouteFlows.forEach((flow) => {
        const fromEl = elementPositions.get(flow.from);
        const toEl = elementPositions.get(flow.to);
        if (!fromEl || !toEl) {
            skippedFlows.push(flow);
            return;
        }

        const fromC = centerOf(fromEl);
        const toC = centerOf(toEl);
        let route = 'direct';
        let labelX;
        let labelY;
        let midY = null;
        let midX = null;
        const sameLane = fromEl.lane === toEl.lane;

        // Черновые якоря по центрам, потом уточним на периметре
        let fromX;
        let fromY;
        let toX;
        let toY;

        if (flow.type === 'message' && !sameLane) {
            const goingDown = toC.y > fromC.y;
            const roughFrom = { x: fromC.x, y: goingDown ? fromEl.y + fromEl.height : fromEl.y };
            const roughTo = { x: toC.x, y: goingDown ? toEl.y : toEl.y + toEl.height };
            const a0 = edgeAnchor(fromEl, roughFrom.x, roughFrom.y + (goingDown ? 40 : -40));
            const a1 = edgeAnchor(toEl, roughTo.x, roughTo.y + (goingDown ? -40 : 40));
            fromX = a0.x; fromY = a0.y; toX = a1.x; toY = a1.y;
            route = 'message';
            const fromLaneInfo = laneByName.get(fromEl.lane);
            const toLaneInfo = laneByName.get(toEl.lane);
            if (fromLaneInfo && toLaneInfo) {
                midY = goingDown
                    ? (fromLaneInfo.y + fromLaneInfo.height + toLaneInfo.y) / 2
                    : (toLaneInfo.y + toLaneInfo.height + fromLaneInfo.y) / 2;
            } else {
                midY = (fromY + toY) / 2;
            }
            labelX = (fromX + toX) / 2;
            labelY = midY - 8;
        } else if (sameLane) {
            const goingForward = toEl.x >= fromEl.x - 4;
            if (goingForward) {
                // Одна горизонталь: разные высоты task/event иначе дают «ломаную» на 5–15px
                const yLine = (fromC.y + toC.y) / 2;
                fromX = fromEl.x + fromEl.width;
                toX = toEl.x;
                fromY = yLine;
                toY = yLine;
                if (fromEl.type === 'gateway') {
                    // Правый острый угол ромба (не середина bounding box)
                    const r = Math.min(fromEl.width, fromEl.height) * 0.42;
                    fromX = fromC.x + r;
                    fromY = fromC.y;
                    toY = fromC.y;
                }
                if (toEl.type === 'gateway') {
                    const r = Math.min(toEl.width, toEl.height) * 0.42;
                    toX = toC.x - r;
                    toY = toC.y;
                    if (fromEl.type !== 'gateway') fromY = toC.y;
                }
                route = 'forward';
                midX = (fromX + toX) / 2;
                labelX = midX;
                labelY = yLine - 12;
            } else {
                fromX = fromC.x;
                fromY = fromEl.y;
                toX = toC.x;
                toY = toEl.y;
                if (fromEl.type === 'event') {
                    fromX = fromC.x;
                    fromY = fromEl.y;
                }
                if (toEl.type === 'event') {
                    toX = toC.x;
                    toY = toEl.y;
                }
                route = 'above';
                const bk = bucketKey(flow.from, flow.to, 'above');
                const n = edgeBucket.get(bk) || 0;
                edgeBucket.set(bk, n + 1);
                const arcY = Math.min(fromEl.y, toEl.y) - 34 - n * 16;
                labelX = (fromX + toX) / 2;
                labelY = arcY - 6;
                positionedFlows.push({
                    ...flow,
                    fromX, fromY, toX, toY,
                    arcY,
                    route,
                    labelX,
                    labelY,
                    fromLane: fromEl.lane,
                    toLane: toEl.lane
                });
                return;
            }
        } else {
            const goingDown = toC.y > fromC.y;
            // Якоря на периметре: у шлюза/события — с острия, без «висящего» старта рядом с блоком
            if (fromEl.type === 'gateway') {
                fromX = fromC.x;
                fromY = goingDown ? fromEl.y + fromEl.height : fromEl.y;
            } else if (fromEl.type === 'event') {
                fromX = fromC.x;
                fromY = goingDown ? fromEl.y + fromEl.height : fromEl.y;
            } else {
                const a0 = edgeAnchor(fromEl, fromC.x, goingDown ? fromEl.y + fromEl.height + 80 : fromEl.y - 80);
                fromX = a0.x;
                fromY = a0.y;
            }
            if (toEl.type === 'gateway') {
                toX = toC.x;
                toY = goingDown ? toEl.y : toEl.y + toEl.height;
            } else if (toEl.type === 'event') {
                toX = toC.x;
                toY = goingDown ? toEl.y : toEl.y + toEl.height;
            } else {
                const a1 = edgeAnchor(toEl, toC.x, goingDown ? toEl.y - 80 : toEl.y + toEl.height + 80);
                toX = a1.x;
                toY = a1.y;
            }
            if (fromEl.note && goingDown && fromEl.type !== 'gateway' && fromEl.type !== 'event') fromY += 36;
            if (toEl.note && !goingDown && toEl.type !== 'gateway' && toEl.type !== 'event') toY += 36;

            const fromLaneInfo = laneByName.get(fromEl.lane);
            const toLaneInfo = laneByName.get(toEl.lane);
            const fromLaneIdx = lanePositions.findIndex((lp) => lp.name === fromEl.lane);
            const toLaneIdx = lanePositions.findIndex((lp) => lp.name === toEl.lane);
            const laneSpan = (fromLaneIdx >= 0 && toLaneIdx >= 0)
                ? Math.abs(toLaneIdx - fromLaneIdx)
                : 1;
            const bk = bucketKey(fromEl.lane + '|' + flow.from, toEl.lane + '|' + flow.to, 'cross');
            const n = edgeBucket.get(bk) || 0;
            edgeBucket.set(bk, n + 1);

            /** Центр зазора между двумя соседними дорожками */
            function gapMidY(upper, lower) {
                if (!upper || !lower) return (fromY + toY) / 2;
                const a = upper.y + upper.height;
                const b = lower.y;
                if (b > a + 8) return (a + b) / 2;
                return (fromY + toY) / 2;
            }

            // Всегда простой cross: вниз/вверх у источника, горизонталь в зазоре, вход в цель.
            // Без обхода справа — он накрывал чужие стрелки.
            route = 'cross';
            if (fromLaneInfo && toLaneInfo) {
                if (laneSpan > 1) {
                    // Дальняя дорожка: горизонталь в зазоре ПЕРЕД целевой (вертикаль у fromX, не bus справа)
                    midY = goingDown
                        ? toLaneInfo.y - 18 - n * 10
                        : toLaneInfo.y + toLaneInfo.height + 18 + n * 10;
                } else {
                    const upper = goingDown ? fromLaneInfo : toLaneInfo;
                    const lower = goingDown ? toLaneInfo : fromLaneInfo;
                    midY = gapMidY(upper, lower) + (n - 0.5) * 12;
                    const minY = upper.y + upper.height + 14;
                    const maxY = lower.y - 14;
                    if (maxY > minY) midY = Math.max(minY, Math.min(maxY, midY));
                }
            } else {
                midY = (fromY + toY) / 2 + n * 10;
            }
            labelX = (fromX + toX) / 2;
            labelY = midY - 8;
        }

        // параллельные рёбра: разводим через midX, не сдвигая якорь с круга
        if (route === 'forward' || route === 'ortho') {
            const bk = bucketKey(flow.from, flow.to, route);
            const n = edgeBucket.get(bk) || 0;
            edgeBucket.set(bk, n + 1);
            if (n > 0) {
                const dx = (n % 2 === 1 ? 1 : -1) * Math.ceil(n / 2) * 14;
                midX = (fromX + toX) / 2 + dx;
                route = 'ortho';
                labelX = midX;
                labelY = Math.min(fromY, toY) - 12;
            }
        }

        positionedFlows.push({
            ...flow,
            fromX, fromY, toX, toY,
            midY,
            midX,
            route,
            labelX,
            labelY,
            fromLane: fromEl.lane,
            toLane: toEl.lane
        });
    });

    const layoutDiagnostics = skippedFlows.map((flow) => diag('error',
        `Связь не построена: «${flow.from}» → «${flow.to}»`, {
            line: flow.line || null,
            code: 'flow_skipped',
            hint: 'Имя не совпало ни с одним элементом'
        }));

    const flowBusMax = positionedFlows.reduce((m, f) => Math.max(m, f.busX || 0, f.fromX || 0, f.toX || 0), 0);
    return attachDiagnostics({
        lanes: lanePositions,
        pools: poolPositions,
        elements,
        flows: positionedFlows,
        processName: bpmnData.processName || '',
        width: Math.max(maxX + 80, flowBusMax + 64, 800),
        height: maxY + 100 + (bpmnData.processName ? 40 : 0),
        taskWidth,
        taskHeight,
        eventRadius,
        gatewaySize
    }, layoutDiagnostics);
}
