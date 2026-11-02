/**
 * Парсинг BPMN 2.0 диаграмм.
 * Пулы, дорожки, boundary events, подпроцесс, данные/хранилище.
 */
function parseBPMN(text) {
    const cleanText = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    const lines = cleanText.split('\n');
    if (lines.length === 0) return null;

    let processName = '';
    const lanes = [];
    const pools = [];
    const elements = [];
    const flows = [];
    const diagnostics = [];
    let currentLane = null;
    let currentPool = null;
    let currentElement = null;
    let currentSubprocess = null;
    const laneMap = new Map();
    const elementMap = new Map();
    const poolMap = new Map();

    function getOrCreatePool(name) {
        if (!poolMap.has(name)) {
            const pool = { name, lanes: [] };
            pools.push(pool);
            poolMap.set(name, pool);
        }
        return poolMap.get(name);
    }

    function getOrCreateLane(name) {
        if (!laneMap.has(name)) {
            const lane = { name, pool: currentPool ? currentPool.name : null };
            lanes.push(lane);
            laneMap.set(name, lane);
            if (currentPool && !currentPool.lanes.includes(name)) {
                currentPool.lanes.push(name);
            }
        } else if (currentPool && laneMap.get(name).pool == null) {
            laneMap.get(name).pool = currentPool.name;
            if (!currentPool.lanes.includes(name)) currentPool.lanes.push(name);
        }
        return laneMap.get(name);
    }

    function cleanElementName(name) {
        return String(name || '').replace(/[^\w\sа-яА-ЯёЁ.,!?\-()/:]/g, '').trim();
    }

    function addElement(type, name, laneName, extra = {}, lineNo = null) {
        let cleanName = cleanElementName(name);
        if (!cleanName) {
            diagnostics.push(diag('warning', 'Пустое имя элемента пропущено', {
                line: lineNo,
                code: 'empty_name',
                hint: 'Укажите имя после Задача:/Событие:/Шлюз:'
            }));
            return null;
        }
        if (elementMap.has(cleanName)) {
            diagnostics.push(diag('error', `Дублируется элемент «${cleanName}» — вторая копия пропущена`, {
                line: lineNo,
                code: 'duplicate_element',
                hint: 'Задайте уникальные имена задачам/событиям/шлюзам (связи ссылаются на имя)'
            }));
            return null;
        }
        const id = `${type}_${cleanName}_${elements.length}`;
        const element = { id, type, name: cleanName, lane: laneName, sourceLine: lineNo, ...extra };
        elements.push(element);
        elementMap.set(cleanName, element);
        if (currentSubprocess && type === 'task' && !extra.isSubprocess) {
            currentSubprocess.children = currentSubprocess.children || [];
            currentSubprocess.children.push(cleanName);
            element.parentSubprocess = currentSubprocess.name;
            element._nested = true;
        }
        return element;
    }

    function applyAttributeToCurrentElement(key, value) {
        if (!currentElement) return;
        if (key === 'тип') {
            if (currentElement.type === 'task') {
                currentElement.taskType = value;
                if (/подпроцесс/i.test(value)) currentElement.isSubprocess = true;
            } else if (currentElement.type === 'event') {
                currentElement.eventType = value;
            } else if (currentElement.type === 'gateway') {
                currentElement.gatewayType = value;
            } else if (currentElement.type === 'data' || currentElement.type === 'datastore') {
                currentElement.dataKind = value;
            }
        } else if (key === 'доп.тип' || key === 'маркер') {
            if (currentElement.type === 'event') {
                currentElement.eventSubType = value;
            } else if (currentElement.type === 'task') {
                currentElement.marker = value.toLowerCase();
            }
        } else if (key === 'заметка') {
            currentElement.note = value;
        } else if (key === 'на' || key === 'граничное' || key === 'boundary') {
            currentElement.attachedTo = cleanElementName(value);
            currentElement.boundary = true;
            if (currentElement.type === 'event' && !currentElement.eventType) {
                currentElement.eventType = 'промежуточное';
            }
        }
    }

    let startIdx = 0;
    while (startIdx < lines.length) {
        const t = lines[startIdx].trim();
        if (t && !(typeof isDiagramCommentLine === 'function' ? isDiagramCommentLine(t) : t.startsWith('#'))) break;
        startIdx++;
    }
    if (startIdx < lines.length) {
        const firstLine = lines[startIdx].trim();
        const titleVal = typeof parseDiagramTitleLine === 'function'
            ? parseDiagramTitleLine(firstLine, ['название', 'заголовок', 'title', 'процесс'])
            : null;
        if (titleVal || /^(название|заголовок|title|процесс)\s*:/i.test(firstLine)) {
            if (titleVal) processName = titleVal;
            startIdx++;
        }
    }

    for (let i = startIdx; i < lines.length; i++) {
        const rawLine = lines[i];
        const trimmed = rawLine.trim();
        if (typeof isDiagramCommentLine === 'function' ? isDiagramCommentLine(trimmed) : (trimmed === '' || trimmed.startsWith('#'))) {
            currentElement = null;
            continue;
        }

        const indent = rawLine.match(/^[ ]*/)[0].length;
        const isAttribute = (indent >= 4);

        // выход из подпроцесса при декларе верхнего уровня
        if (indent < 4) {
            currentSubprocess = null;
        }

        if (isAttribute && (currentElement || currentSubprocess)) {
            const host = currentElement || currentSubprocess;
            if (/^\/\//.test(trimmed) && currentElement) {
                currentElement.note = trimmed.substring(2).trim();
                continue;
            }
            const noteMatch = trimmed.match(/^заметка:\s*(.+)$/i);
            if (noteMatch && currentElement) {
                currentElement.note = noteMatch[1].trim();
                continue;
            }
            const attrMatch = trimmed.match(/^(тип|доп\.тип|маркер|на|граничное|boundary):\s*(.+)$/i);
            if (attrMatch && currentElement) {
                const key = attrMatch[1].toLowerCase();
                const value = attrMatch[2].trim();
                applyAttributeToCurrentElement(key, value);
                if (currentElement.isSubprocess || currentElement.taskType === 'подпроцесс') {
                    currentSubprocess = currentElement;
                }
                continue;
            }
            // вложенные задачи подпроцесса
            const nestedTask = trimmed.match(/^(Задача|задача):\s*(.+?)(?:\s*\(тип:\s*(.+?)\))?\s*$/i);
            const spHost = (currentSubprocess
                || ((currentElement && (currentElement.isSubprocess || currentElement.taskType === 'подпроцесс'))
                    ? currentElement
                    : null));
            if (nestedTask && spHost) {
                currentSubprocess = spHost;
                const name = nestedTask[2].trim();
                const taskType = nestedTask[3] ? nestedTask[3].trim() : 'пользовательская';
                const el = addElement('task', name, currentLane ? currentLane.name : null, {
                    taskType,
                    parentSubprocess: spHost.name,
                    _nested: true
                }, i + 1);
                currentElement = el;
                continue;
            }
            continue;
        }

        currentElement = null;

        if (/^(Пул|пул):/.test(trimmed)) {
            const name = trimmed.substring(trimmed.indexOf(':') + 1).trim();
            currentPool = getOrCreatePool(name);
            currentLane = null;
            continue;
        }

        if (/^(Дорожка|дорожка):/.test(trimmed)) {
            const name = trimmed.substring(trimmed.indexOf(':') + 1).trim();
            currentLane = getOrCreateLane(name);
            continue;
        }

        const lineNo = i + 1;

        const taskMatch = trimmed.match(/^(Задача|задача|Подпроцесс|подпроцесс):\s*(.+?)(?:\s*\(тип:\s*(.+?)\))?\s*$/i);
        if (taskMatch) {
            const isSp = /^подпроцесс$/i.test(taskMatch[1]);
            const name = taskMatch[2].trim();
            const taskType = taskMatch[3]
                ? taskMatch[3].trim()
                : (isSp ? 'подпроцесс' : 'пользовательская');
            const el = addElement('task', name, currentLane ? currentLane.name : null, {
                taskType,
                isSubprocess: isSp || /подпроцесс/i.test(taskType),
                children: []
            }, lineNo);
            currentElement = el;
            if (el && el.isSubprocess) currentSubprocess = el;
            continue;
        }

        // Короткие ярлыки: начало:/конец:/выбор:/ветка:/таймер:
        const startShort = trimmed.match(/^(начало):\s*(.+)$/i);
        if (startShort) {
            const el = addElement('event', startShort[2].trim(), currentLane ? currentLane.name : null, {
                eventType: 'начало', eventSubType: null
            }, lineNo);
            currentElement = el;
            continue;
        }
        const endShort = trimmed.match(/^(конец):\s*(.+)$/i);
        if (endShort) {
            const el = addElement('event', endShort[2].trim(), currentLane ? currentLane.name : null, {
                eventType: 'завершение', eventSubType: null
            }, lineNo);
            currentElement = el;
            continue;
        }
        const timerShort = trimmed.match(/^(таймер):\s*(.+)$/i);
        if (timerShort) {
            const el = addElement('event', timerShort[2].trim(), currentLane ? currentLane.name : null, {
                eventType: 'промежуточное', eventSubType: 'таймер'
            }, lineNo);
            currentElement = el;
            continue;
        }
        const choiceShort = trimmed.match(/^(выбор|ветка):\s*(.+?)(?:\s*\(тип:\s*(.+?)\))?\s*$/i);
        if (choiceShort) {
            const name = choiceShort[2].trim();
            const gatewayType = choiceShort[3] ? choiceShort[3].trim() : 'исключающий';
            const el = addElement('gateway', name, currentLane ? currentLane.name : null, { gatewayType }, lineNo);
            currentElement = el;
            continue;
        }

        const eventMatch = trimmed.match(/^(Событие|событие):\s*(.+?)(?:\s*\(тип:\s*(.+?)(?:,\s*доп\.тип:\s*(.+?))?\))?\s*$/i);
        if (eventMatch) {
            const name = eventMatch[2].trim();
            const eventType = eventMatch[3] ? eventMatch[3].trim() : 'промежуточное';
            const eventSubType = eventMatch[4] ? eventMatch[4].trim() : null;
            const el = addElement('event', name, currentLane ? currentLane.name : null, { eventType, eventSubType }, lineNo);
            currentElement = el;
            continue;
        }

        const gatewayMatch = trimmed.match(/^(Шлюз|шлюз):\s*(.+?)(?:\s*\(тип:\s*(.+?)\))?\s*$/i);
        if (gatewayMatch) {
            const name = gatewayMatch[2].trim();
            const gatewayType = gatewayMatch[3] ? gatewayMatch[3].trim() : 'исключающий';
            const el = addElement('gateway', name, currentLane ? currentLane.name : null, { gatewayType }, lineNo);
            currentElement = el;
            continue;
        }

        const dataMatch = trimmed.match(/^(Данные|данные|Документ|документ):\s*(.+)$/i);
        if (dataMatch) {
            const el = addElement('data', dataMatch[2].trim(), currentLane ? currentLane.name : null, {}, lineNo);
            currentElement = el;
            continue;
        }

        const storeMatch = trimmed.match(/^(Хранилище|хранилище|Склад данных|склад данных):\s*(.+)$/i);
        if (storeMatch) {
            const el = addElement('datastore', storeMatch[2].trim(), currentLane ? currentLane.name : null, {}, lineNo);
            currentElement = el;
            continue;
        }

        const flowMatch = trimmed.match(/^(.+?)\s*(->|-->|~~>|\.\.\.>|=>)\s*(.+?)(?:\s*:\s*(.*))?$/);
        if (flowMatch) {
            const fromName = cleanElementName(flowMatch[1]);
            const arrowType = flowMatch[2];
            const toName = cleanElementName(flowMatch[3]);
            const label = flowMatch[4] ? flowMatch[4].trim() : '';
            let flowType = 'sequence';
            if (arrowType === '-->') flowType = 'conditional';
            else if (arrowType === '~~>') flowType = 'message';
            else if (arrowType === '...>') flowType = 'association';
            else if (arrowType === '=>') flowType = 'default';
            flows.push({ from: fromName, to: toName, type: flowType, label, line: lineNo });
            continue;
        }

        if (/^\/\//.test(trimmed)) {
            const noteText = trimmed.substring(2).trim();
            addElement('annotation', noteText, currentLane ? currentLane.name : null, {}, lineNo);
            continue;
        }

        diagnostics.push(diag('warning', 'Строка не распознана', {
            line: lineNo,
            code: 'bpmn_bad_line',
            hint: 'Ожидается Пул:/Дорожка:/Задача:/начало:/конец:/выбор:/Событие:/Шлюз: или связь A -> B'
        }));
    }

    // boundary: если attachedTo задан — не участвует в lane order отдельно уже в layout
    elements.forEach((el) => {
        if (el.attachedTo && elementMap.has(el.attachedTo)) {
            el.boundary = true;
            el.lane = elementMap.get(el.attachedTo).lane;
        }
    });

    // если пулы объявлены — убедимся что у каждой дорожки есть пул
    if (pools.length) {
        lanes.forEach((l) => {
            if (l.pool) {
                const p = poolMap.get(l.pool);
                if (p && !p.lanes.includes(l.name)) p.lanes.push(l.name);
            }
        });
    }

    const names = elements.map((e) => e.name);
    const graph = analyzeDirectedGraph(names, flows.map((f) => ({ from: f.from, to: f.to, line: f.line })));
    diagnostics.push(...graph.diagnostics.filter((d) =>
        d.code === 'cycle' || d.code === 'self_loop' || d.code === 'orphan_from' || d.code === 'orphan_to'
    ));

    return attachDiagnostics({ processName, lanes, pools, elements, flows }, diagnostics);
}
