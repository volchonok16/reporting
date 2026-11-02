/**
 * Парсер простой блок-схемы (референс: Mermaid flowchart + привычные формы ISO).
 *
 * название: Заявка на доступ
 * направление: вниз
 * ([Старт]) -> [/Ввод заявки/]
 * [/Ввод заявки/] -> {Нужен VPN?}
 * {Нужен VPN?} -> [[Выдать VPN]]: да
 * {Нужен VPN?} -> ([Готово]): нет
 *
 * Формы:
 *   [прямоуг]  (скругл)  {ромб}  ((круг))
 *   ([старт/конец])  [[подпроцесс]]  [/ввод-вывод/]  [(БД)]  [~документ~]
 * Стрелки: -> и --> ; подпись после «:».
 * Также: id[Текст] и рёбра A -> B.
 * Ярлыки: старт:/конец:/выбор:/ввод:/бд:/документ:/подпроцесс: …
 */
function parseFlowchart(text) {
    const diagnostics = [];
    let title = 'Блок-схема';
    let direction = 'tb'; // tb | lr
    const nodes = new Map(); // id -> { id, label, shape, line }
    const edges = [];
    let autoSeq = 0;

    function slugId(label) {
        return String(label || '')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, '_')
            .replace(/^_|_$/g, '')
            .slice(0, 40) || ('n' + (++autoSeq));
    }

    function ensureNode(id, label, shape, line) {
        const key = String(id || '').trim();
        if (!key) return null;
        let cleanLabel = label != null ? String(label) : key;
        let meta = null;
        if (typeof parseDiagramNodeMeta === 'function' && label != null) {
            meta = parseDiagramNodeMeta(cleanLabel);
            cleanLabel = meta.text || key;
        }
        if (!nodes.has(key)) {
            const n = {
                id: key,
                label: cleanLabel,
                shape: shape || 'rect',
                line: line || null
            };
            if (meta) {
                if (meta.assignee) { n.assignee = meta.assignee; n.initials = meta.initials; }
                if (meta.deadlineLabel) {
                    n.deadlineLabel = meta.deadlineLabel;
                    n.deadlineDate = meta.deadlineDate;
                    n.overdue = meta.overdue;
                }
            }
            nodes.set(key, n);
        } else {
            const n = nodes.get(key);
            if (label != null && cleanLabel !== key) n.label = cleanLabel;
            if (shape) n.shape = shape;
            if (line != null && n.line == null) n.line = line;
            if (meta) {
                if (meta.assignee) { n.assignee = meta.assignee; n.initials = meta.initials; }
                if (meta.deadlineLabel) {
                    n.deadlineLabel = meta.deadlineLabel;
                    n.deadlineDate = meta.deadlineDate;
                    n.overdue = meta.overdue;
                }
            }
        }
        return nodes.get(key);
    }

    function ensureByLabel(label, shape, line) {
        let lab = String(label || '').trim();
        if (typeof parseDiagramNodeMeta === 'function') {
            lab = parseDiagramNodeMeta(lab).text || lab;
        }
        for (const n of nodes.values()) {
            if (n.label === lab) {
                if (shape) n.shape = shape;
                if (typeof parseDiagramNodeMeta === 'function' && label) {
                    const meta = parseDiagramNodeMeta(String(label));
                    if (meta.assignee) { n.assignee = meta.assignee; n.initials = meta.initials; }
                    if (meta.deadlineLabel) {
                        n.deadlineLabel = meta.deadlineLabel;
                        n.deadlineDate = meta.deadlineDate;
                        n.overdue = meta.overdue;
                    }
                }
                return n;
            }
        }
        return ensureNode(slugId(lab), label, shape, line);
    }

    const ID = '([A-Za-zА-Яа-яЁё0-9_]+)';

    /** Разбор токена узла — сначала более специфичные скобки. */
    function parseNodeToken(raw, lineNo) {
        const s = String(raw || '').trim();
        if (!s) return null;

        let m;

        // id[[Текст]] / [[Текст]] — подпроцесс
        m = s.match(new RegExp('^' + ID + '\\s*\\[\\[\\s*([^\\]]*)\\s*\\]\\]$'));
        if (m) return ensureNode(m[1], m[2].trim() || m[1], 'subroutine', lineNo);
        m = s.match(/^\[\[\s*([^\]]+)\s*\]\]$/);
        if (m) return ensureByLabel(m[1].trim(), 'subroutine', lineNo);

        // id([Текст]) / ([Текст]) — stadium (вход/выход)
        m = s.match(new RegExp('^' + ID + '\\s*\\(\\s*\\[\\s*([^\\]]*)\\s*\\]\\s*\\)$'));
        if (m) return ensureNode(m[1], m[2].trim() || m[1], 'stadium', lineNo);
        m = s.match(/^\(\[\s*([^\]]+)\s*\]\)$/);
        if (m) return ensureByLabel(m[1].trim(), 'stadium', lineNo);

        // id[(Текст)] / [(Текст)] — цилиндр / БД
        m = s.match(new RegExp('^' + ID + '\\s*\\[\\(\\s*([^)]*)\\s*\\)\\]$'));
        if (m) return ensureNode(m[1], m[2].trim() || m[1], 'cylinder', lineNo);
        m = s.match(/^\[\(\s*([^)]+)\s*\)\]$/);
        if (m) return ensureByLabel(m[1].trim(), 'cylinder', lineNo);

        // id[/Текст/] / [/Текст/] — параллелограмм (ввод/вывод)
        m = s.match(new RegExp('^' + ID + '\\s*\\[/\\s*([^/]*?)\\s*/\\]$'));
        if (m) return ensureNode(m[1], m[2].trim() || m[1], 'parallelogram', lineNo);
        m = s.match(/^\[\/\s*([^/]+?)\s*\/\]$/);
        if (m) return ensureByLabel(m[1].trim(), 'parallelogram', lineNo);

        // id[~Текст~] / [~Текст~] — документ
        m = s.match(new RegExp('^' + ID + '\\s*\\[~\\s*([^~]*?)\\s*~\\]$'));
        if (m) return ensureNode(m[1], m[2].trim() || m[1], 'document', lineNo);
        m = s.match(/^\[~\s*([^~]+?)\s*~\]$/);
        if (m) return ensureByLabel(m[1].trim(), 'document', lineNo);

        // id((Текст)) / ((Текст)) — круг
        m = s.match(new RegExp('^' + ID + '\\s*\\(\\(\\s*([^)]*)\\s*\\)\\)$'));
        if (m) return ensureNode(m[1], m[2].trim() || m[1], 'circle', lineNo);
        m = s.match(/^\(\(\s*([^)]+)\s*\)\)$/);
        if (m) return ensureByLabel(m[1].trim(), 'circle', lineNo);

        // id(Текст) / (Текст) — скруглённый
        m = s.match(new RegExp('^' + ID + '\\s*\\(\\s*([^)]*)\\s*\\)$'));
        if (m) return ensureNode(m[1], m[2].trim() || m[1], 'round', lineNo);
        m = s.match(/^\(\s*([^)]+)\s*\)$/);
        if (m) return ensureByLabel(m[1].trim(), 'round', lineNo);

        // id{Текст} / {Текст} — ромб
        m = s.match(new RegExp('^' + ID + '\\s*\\{\\s*([^}]*)\\s*\\}$'));
        if (m) return ensureNode(m[1], m[2].trim() || m[1], 'diamond', lineNo);
        m = s.match(/^\{\s*([^}]+)\s*\}$/);
        if (m) return ensureByLabel(m[1].trim(), 'diamond', lineNo);

        // id[Текст] / [Текст] — прямоугольник
        m = s.match(new RegExp('^' + ID + '\\s*\\[\\s*([^\\]]*)\\s*\\]$'));
        if (m) return ensureNode(m[1], m[2].trim() || m[1], 'rect', lineNo);
        m = s.match(/^\[\s*([^\]]+)\s*\]$/);
        if (m) return ensureByLabel(m[1].trim(), 'rect', lineNo);

        if (/^[A-Za-zА-Яа-яЁё0-9_]+$/.test(s)) {
            return ensureNode(s, s, 'rect', lineNo);
        }
        return ensureByLabel(s, 'rect', lineNo);
    }

    function looksLikeNodeToken(trimmed) {
        return /^(?:[\[\(\{]|\(\[|\[\[|\[\/|\[\(|\[~|[A-Za-zА-Яа-яЁё0-9_]+\s*(?:[\[\(\{]|\(\[|\[\[|\[\/|\[\(|\[~))/.test(trimmed);
    }

    String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach((raw, idx) => {
        const lineNo = idx + 1;
        const trimmed = raw.trim();
        if (typeof isDiagramCommentLine === 'function'
            ? isDiagramCommentLine(trimmed)
            : (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//'))) return;

        if (/^(блок-?схема|flowchart|flow)\s*$/i.test(trimmed)) return;

        const headerDir = trimmed.match(/^(блок-?схема|flowchart|flow)\s+(\S+)\s*$/i);
        if (headerDir) {
            const d = headerDir[2].toLowerCase();
            if (/^(вправо|горизонт|horizontal|lr|rl|right)/i.test(d)) direction = 'lr';
            else if (/^(вниз|вертикал|vertical|td|tb|down)/i.test(d)) direction = 'tb';
            return;
        }

        const titleVal = typeof parseDiagramTitleLine === 'function'
            ? parseDiagramTitleLine(trimmed)
            : null;
        if (titleVal != null || /^(заголовок|title)\s*:/i.test(trimmed)) {
            if (titleVal) title = titleVal;
            return;
        }

        const dirM = trimmed.match(/^(направление|direction)\s*:\s*(.+)$/i);
        if (dirM) {
            const d = String(dirM[2] || '').trim().toLowerCase();
            if (/^(вправо|горизонт|horizontal|lr|rl|right)/i.test(d)) direction = 'lr';
            else if (/^(вниз|вертикал|vertical|td|tb|down)/i.test(d)) direction = 'tb';
            else {
                diagnostics.push(diag('warning', 'Направление: вниз или вправо', {
                    line: lineNo, code: 'flowchart_bad_direction',
                    hint: 'направление: вниз | вправо'
                }));
            }
            return;
        }

        // Русские ярлыки форм
        const shapeRu = trimmed.match(/^(старт|начало|конец|финал|выход|выбор|решение|процесс|ввод|вывод|данные|ввод-вывод|подпрограмма|подпроцесс|процедура|бд|база|хранилище|документ)\s*:\s*(.+)$/i);
        if (shapeRu) {
            const kind = shapeRu[1].toLowerCase();
            const label = shapeRu[2].trim();
            let shape = 'rect';
            if (/^(старт|начало|конец|финал|выход)$/i.test(kind)) shape = 'stadium';
            else if (/^(выбор|решение)$/i.test(kind)) shape = 'diamond';
            else if (/^(ввод|вывод|данные|ввод-вывод)$/i.test(kind)) shape = 'parallelogram';
            else if (/^(подпрограмма|подпроцесс|процедура)$/i.test(kind)) shape = 'subroutine';
            else if (/^(бд|база|хранилище)$/i.test(kind)) shape = 'cylinder';
            else if (/^документ$/i.test(kind)) shape = 'document';
            ensureByLabel(label, shape, lineNo);
            return;
        }

        const edgeM = trimmed.match(/^(.+?)\s*(->|-->)\s*(.+?)(?:\s*:\s*(.*))?$/);
        if (edgeM) {
            const fromTok = edgeM[1].trim();
            const toTok = edgeM[3].trim();
            const label = (edgeM[4] != null ? edgeM[4] : '').trim();
            const from = parseNodeToken(fromTok, lineNo);
            const to = parseNodeToken(toTok, lineNo);
            if (!from || !to) {
                diagnostics.push(diag('warning', 'Не разобрано ребро', {
                    line: lineNo, code: 'flowchart_bad_edge',
                    hint: '([Старт]) -> [/Данные/] -> {Ок?}: да'
                }));
                return;
            }
            if (from.id === to.id) {
                diagnostics.push(diag('warning', 'Петля на себя пропущена', {
                    line: lineNo, code: 'flowchart_self_loop'
                }));
                return;
            }
            edges.push({
                from: from.id,
                to: to.id,
                label,
                line: lineNo
            });
            return;
        }

        const alone = parseNodeToken(trimmed, lineNo);
        if (alone && looksLikeNodeToken(trimmed)) {
            return;
        }

        if (trimmed) {
            diagnostics.push(diag('warning', 'Строка не распознана', {
                line: lineNo, code: 'flowchart_bad_line',
                hint: '([Старт]) -> {Выбор?}: да'
            }));
        }
    });

    if (!nodes.size) {
        return attachDiagnostics(null, diagnostics);
    }
    if (!edges.length) {
        diagnostics.push(diag('warning', 'Нет стрелок — показаны только узлы', {
            code: 'flowchart_no_edges',
            hint: 'Свяжите блоки: ([A]) -> [B] или {Выбор?} -> ([Конец]): да'
        }));
    }

    const names = Array.from(nodes.keys());
    if (edges.length && typeof analyzeDirectedGraph === 'function') {
        const graph = analyzeDirectedGraph(names, edges.map((e) => ({
            from: e.from, to: e.to, line: e.line
        })), { allowMissingNodes: false });
        (graph.diagnostics || []).forEach((d) => {
            if (d.code === 'cycle') {
                diagnostics.push(Object.assign({}, d, {
                    severity: 'warning',
                    message: 'В схеме есть цикл — раскладка может «плавать»'
                }));
            } else if (d.code === 'orphan_from' || d.code === 'orphan_to') {
                diagnostics.push(d);
            }
        });
    }

    return attachDiagnostics({
        title,
        direction,
        nodes: Array.from(nodes.values()),
        edges
    }, diagnostics);
}
