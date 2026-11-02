// Узел интеллект-карты
class MindMapNode {
    constructor(text) {
        this.text = text;
        this.children = [];
        this.parent = null;
        this.level = 0;
        this.angle = 0;
        this.x = 0; this.y = 0;
        this.weight = 1;
        this.color = '#333';
        this.width = 0; this.height = 30;
        this.done = false;          // флаг выполненности
        this.lines = null;
        this.href = null;           // http(s)/mailto — клик только в PDF
        this.assignee = null;       // @ответственный
        this.initials = null;
        this.deadlineLabel = null;  // !дедлайн
        this.deadlineDate = null;
        this.overdue = false;
        this.note = null;           // // подпись под блоком
        this.sourceLine = null;
    }
}

/** Подпись узла: «Текст // заметка» (пробел перед // обязателен — не путать с http://). */
function extractInlineNodeNote(str) {
    const s = String(str == null ? '' : str);
    const m = s.match(/^(.*?)\s+\/\/\s*(.+)$/);
    if (!m) return { text: s, note: null };
    const note = String(m[2] || '').trim();
    return { text: String(m[1] || '').trim(), note: note || null };
}

// Очистка текста узла от маркеров статуса (единый набор: готово/выполнено/done/ok/…)
function cleanNodeText(str) {
    const extracted = typeof extractInlineNodeNote === 'function'
        ? extractInlineNodeNote(str)
        : { text: str, note: null };
    let base;
    if (typeof parseDiagramDoneMarker === 'function') {
        base = parseDiagramDoneMarker(extracted.text);
    } else {
        let done = false;
        let text = extracted.text;
        const statusMatch = text.match(/Статус:\s*(готово|выполнено)/i);
        if (statusMatch) {
            done = true;
            text = text.replace(/Статус:\s*(готово|выполнено)/i, '').trim();
        }
        if (!done) {
            const suffixMatch = text.match(/\s*[\(\[ ]?(готово|выполнено)[\)\] ]?\s*$/i);
            if (suffixMatch) {
                done = true;
                text = text.replace(/\s*[\(\[ ]?(готово|выполнено)[\)\] ]?\s*$/i, '').trim();
            }
        }
        base = { text, done };
    }
    if (typeof parseDiagramNodeMeta === 'function') {
        const meta = parseDiagramNodeMeta(base.text);
        return {
            text: meta.text,
            done: base.done,
            assignee: meta.assignee,
            initials: meta.initials,
            deadlineLabel: meta.deadlineLabel,
            deadlineDate: meta.deadlineDate,
            overdue: meta.overdue,
            note: extracted.note
        };
    }
    return {
        text: base.text,
        done: base.done,
        assignee: null,
        initials: null,
        deadlineLabel: null,
        deadlineDate: null,
        overdue: false,
        note: extracted.note
    };
}

// Парсинг текста с отступами в дерево.
// Одинаковый отступ — соседи; больший — дети строки выше (и для → Горизонт, и для ↓ Вертикаль).
// Подпись под блоком: «Узел // текст» или отдельная строка «// текст» (как в BPMN).
function parseTree(text, opts) {
    opts = opts || {};
    const clean = text.replace(/·/g, ' ')
                      .replace(/\t/g, '    ');
    const rawLines = clean.split('\n');
    const lines = [];
    rawLines.forEach((l, idx) => {
        const t = l.trim();
        if (!t || t.charAt(0) === '#') return; // # — только файл-комментарий; // обрабатываем ниже
        lines.push({ text: l, line: idx + 1 });
    });
    if (!lines.length) return null;

    const diagnostics = [];

    // Опционально: заголовок: … — метаданные (не корень дерева)
    let startIdx = 0;
    const firstTrim = lines[0].text.trim();
    const titleVal = typeof parseDiagramTitleLine === 'function'
        ? parseDiagramTitleLine(firstTrim)
        : null;
    if (titleVal != null || /^(заголовок|title)\s*:/i.test(firstTrim)) {
        startIdx = 1;
    }
    // Иерархия: направление: вертикаль|горизонт — мета, не узел
    while (startIdx < lines.length
        && /^(направление|direction)\s*:/i.test(lines[startIdx].text.trim())) {
        startIdx++;
    }
    // Пропуск ведущих // до корня
    while (startIdx < lines.length && lines[startIdx].text.trim().slice(0, 2) === '//') {
        startIdx++;
    }
    if (startIdx >= lines.length) return null;

    function applyNoteTo(node, noteText) {
        if (!node || !noteText) return;
        const n = String(noteText).trim();
        if (!n) return;
        node.note = node.note ? (node.note + ' · ' + n) : n;
    }

    // Корень
    const rootClean = cleanNodeText(lines[startIdx].text.trim());
    const rootLink = typeof parseMindmapNodeLink === 'function'
        ? parseMindmapNodeLink(rootClean.text)
        : { text: rootClean.text, href: null };
    const root = new MindMapNode(rootLink.text);
    root.done = rootClean.done;
    root.href = rootLink.href || null;
    root.assignee = rootClean.assignee || null;
    root.initials = rootClean.initials || null;
    root.deadlineLabel = rootClean.deadlineLabel || null;
    root.deadlineDate = rootClean.deadlineDate || null;
    root.overdue = !!rootClean.overdue;
    root.note = rootClean.note || null;
    root.sourceLine = lines[startIdx].line;
    root.level = 0;
    if (titleVal) root.diagramTitle = titleVal;

    let lastNode = root;
    const stack = [{ indent: 0, node: root }];
    for (let i = startIdx + 1; i < lines.length; i++) {
        const line = lines[i].text;
        const lineNo = lines[i].line;
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.slice(0, 2) === '//') {
            applyNoteTo(lastNode, trimmed.slice(2));
            continue;
        }

        const indent = line.match(/^[ ]*/)[0].length;
        if (indent % 4 !== 0) {
            diagnostics.push(diag('warning', `Отступ ${indent} пробелов — лучше кратно 4`, {
                line: lineNo,
                code: 'indent_not_multiple',
                hint: 'Используйте таб или 4 пробела на уровень'
            }));
        }
        const cleaned = cleanNodeText(trimmed);
        const linked = typeof parseMindmapNodeLink === 'function'
            ? parseMindmapNodeLink(cleaned.text)
            : { text: cleaned.text, href: null };
        const nodeText = linked.text;
        const nodeDone = cleaned.done;
        if (!nodeText) {
            diagnostics.push(diag('warning', 'Пустой узел пропущен', {
                line: lineNo,
                code: 'empty_node',
                hint: 'После маркера (готово) должно остаться имя'
            }));
            continue;
        }
        const node = new MindMapNode(nodeText);
        node.done = nodeDone;
        node.href = linked.href || null;
        node.assignee = cleaned.assignee || null;
        node.initials = cleaned.initials || null;
        node.deadlineLabel = cleaned.deadlineLabel || null;
        node.deadlineDate = cleaned.deadlineDate || null;
        node.overdue = !!cleaned.overdue;
        node.note = cleaned.note || null;
        node.sourceLine = lineNo;

        while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
        const parent = stack.length === 0 ? root : stack[stack.length - 1].node;
        stack.push({ indent, node });

        parent.children.push(node);
        node.parent = parent;
        node.level = (parent.level || 0) + 1;
        lastNode = node;
    }
    if (diagnostics.length && typeof attachDiagnostics === 'function') {
        attachDiagnostics(root, diagnostics);
    } else {
        root.diagnostics = diagnostics;
    }
    return root;
}

// Назначение цветов узлам
function assignColors(root, theme) {
    const palette = themes[theme];
    root.children.forEach((child, i) => {
        const color = palette[i % palette.length];
        setSubtreeColor(child, color);
    });
    root.color = '#666666';
}
function setSubtreeColor(node, branchColor) {
    const isDark = typeof document !== 'undefined' && document.body && document.body.classList.contains('dark');
    const fadeToward = isDark ? '#0f172a' : '#f1f5f9';
    // Плавное снижение яркости от ветки корня к листьям (мягко, без потери узнаваемости цвета)
    const depth = Math.max(0, (node.level || 1) - 1);
    const t = Math.min(0.36, depth * 0.11);
    node.color = (t <= 0.001 || typeof mixHex !== 'function')
        ? branchColor
        : mixHex(branchColor, fadeToward, t);
    node.children.forEach((ch) => setSubtreeColor(ch, branchColor));
}
