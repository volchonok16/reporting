/**
 * Парсер Kanban-доски.
 * Поддерживает многострочные атрибуты с отступом 4 пробела.
 * Колонка: «колонка Имя» или «колонка Имя | лимит: 3»
 */
function parseSecret(text) {
    const lines = text.split('\n');
    if (lines.length === 0) return attachDiagnostics(null, []);

    const colorNames = {
        'красный': '#ef4444', 'красная': '#ef4444',
        'оранжевый': '#f97316', 'оранжевая': '#f97316',
        'жёлтый': '#eab308', 'жёлтая': '#eab308',
        'зелёный': '#22c55e', 'зелёная': '#22c55e', 'зеленый': '#22c55e',
        'голубой': '#06b6d4', 'голубая': '#06b6d4',
        'синий': '#3b82f6', 'синяя': '#3b82f6',
        'фиолетовый': '#8b5cf6', 'фиолетовая': '#8b5cf6',
        'розовый': '#ec4899', 'розовая': '#ec4899',
        'серый': '#6b7280', 'серая': '#6b7280',
        'чёрный': '#1f2937', 'чёрная': '#1f2937', 'черный': '#1f2937',
        'белый': '#ffffff', 'белая': '#ffffff',
        'коричневый': '#92400e', 'коричневая': '#92400e',
        'бирюзовый': '#14b8a6', 'бирюзовая': '#14b8a6',
        'лайм': '#84cc16',
        'индиго': '#6366f1'
    };

    const columns = [];
    const tasks = [];
    const diagnostics = [];
    let title = '';
    let currentColumn = null;
    let pendingTask = null;
    let descriptionLines = [];
    let lineNo = 0;

    function savePendingTask() {
        if (pendingTask) {
            pendingTask.description = descriptionLines.join('\n');
            if (pendingTask.dueDate) {
                const dt = typeof parseIsoDate === 'function'
                    ? parseIsoDate(pendingTask.dueDate)
                    : null;
                if (!dt) {
                    diagnostics.push(diag('warning', `Некорректная дата «${pendingTask.dueDate}»`, {
                        line: pendingTask.sourceLine || pendingTask._line || null,
                        code: 'kanban_bad_date',
                        hint: 'Формат YYYY-MM-DD'
                    }));
                    pendingTask.dueDate = '';
                    pendingTask.dueDateObj = null;
                    pendingTask.overdue = false;
                } else {
                    pendingTask.dueDateObj = dt;
                    const today = typeof startOfToday === 'function' ? startOfToday() : new Date();
                    pendingTask.overdue = dt.getTime() < today.getTime();
                }
            }
            if (pendingTask._line != null && pendingTask.sourceLine == null) {
                pendingTask.sourceLine = pendingTask._line;
            }
            delete pendingTask._line;
            tasks.push(pendingTask);
            pendingTask = null;
            descriptionLines = [];
        }
    }

    function applyAttributeToTask(task, key, value) {
        if (key === '@') {
            task.assignee = value;
        } else if (key === 'тег') {
            const tagMatch = value.match(/^(.+?)(?:\(([^)]+)\))?$/);
            if (tagMatch) {
                let tagText = tagMatch[1].trim();
                let color = null;
                if (tagMatch[2]) {
                    const colorInput = tagMatch[2].trim();
                    if (/^#[0-9A-Fa-f]{6}$/.test(colorInput)) {
                        color = colorInput;
                    } else {
                        color = colorNames[colorInput.toLowerCase()] || null;
                    }
                }
                task.tags.push({ text: tagText, color });
            }
        } else if (key === 'дата' || key === 'до') {
            task.dueDate = value;
        } else if (key === 'приоритет') {
            task.priority = value;
        } else if (key === 'id') {
            task.cardId = value;
        }
    }

    for (const rawLine of lines) {
        lineNo++;
        const trimmed = rawLine.trim();
        if (typeof isDiagramCommentLine === 'function' ? isDiagramCommentLine(trimmed) : (trimmed === '' || trimmed.startsWith('#'))) continue;

        const titleVal = typeof parseDiagramTitleLine === 'function'
            ? parseDiagramTitleLine(trimmed)
            : null;
        if (titleVal != null || /^(заголовок|title)\s*:/i.test(trimmed)) {
            if (titleVal) title = titleVal;
            continue;
        }

        const indent = rawLine.match(/^[ ]*/)[0].length;
        const isIndented = indent >= 4;

        if (isIndented && pendingTask) {
            const assigneeMatch = trimmed.match(/^@(\S+)/);
            if (assigneeMatch) {
                applyAttributeToTask(pendingTask, '@', assigneeMatch[1]);
                continue;
            }
            const tagMatch = trimmed.match(/^тег:\s*(.+)$/i);
            if (tagMatch) {
                applyAttributeToTask(pendingTask, 'тег', tagMatch[1]);
                continue;
            }
            const idMatch = trimmed.match(/^id:\s*(.+)$/i);
            if (idMatch) {
                applyAttributeToTask(pendingTask, 'id', idMatch[1].trim());
                continue;
            }
            const dateMatch = trimmed.match(/^(дата|до):\s*(\S+)/i);
            if (dateMatch) {
                applyAttributeToTask(pendingTask, dateMatch[1].toLowerCase(), dateMatch[2]);
                continue;
            }
            if (/^(не срочно|срочно|важно|средне)$/i.test(trimmed)) {
                applyAttributeToTask(pendingTask, 'приоритет', trimmed.toLowerCase());
                continue;
            }
            descriptionLines.push(trimmed);
            continue;
        }

        if (!isIndented) {
            savePendingTask();
        }

        // колонка Имя [| лимит: N]
        const colMatch = trimmed.match(/^колонка\s+(.+)$/i);
        if (colMatch) {
            let colRaw = colMatch[1].trim();
            let wipLimit = null;
            const limMatch = colRaw.match(/^(.*?)\s*\|\s*лимит:\s*(\d+)\s*$/i);
            if (limMatch) {
                colRaw = limMatch[1].trim();
                wipLimit = parseInt(limMatch[2], 10);
            } else {
                const limOnly = colRaw.match(/^(.*?)\s+лимит:\s*(\d+)\s*$/i);
                if (limOnly) {
                    colRaw = limOnly[1].trim();
                    wipLimit = parseInt(limOnly[2], 10);
                }
            }
            if (columns.some((c) => c.name === colRaw)) {
                diagnostics.push(diag('warning', `Дублируется колонка «${colRaw}»`, {
                    line: lineNo,
                    code: 'kanban_dup_column',
                    hint: 'Карточки попадут во все одноимённые колонки'
                }));
            }
            currentColumn = colRaw;
            columns.push({ name: currentColumn, wipLimit });
            continue;
        }

        const taskMatch = trimmed.match(/^задача:\s*(.+)$/i);
        if (taskMatch) {
            if (!currentColumn) {
                diagnostics.push(diag('warning', 'Задача без колонки пропущена', {
                    line: lineNo,
                    code: 'kanban_task_no_column',
                    hint: 'Сначала укажите «колонка Имя»'
                }));
                continue;
            }
            pendingTask = {
                name: taskMatch[1].trim(),
                href: null,
                column: currentColumn,
                assignee: '',
                priority: 'обычная',
                tags: [],
                dueDate: '',
                dueDateObj: null,
                overdue: false,
                cardId: '',
                description: '',
                _line: lineNo
            };
            if (typeof parseMindmapNodeLink === 'function') {
                const linked = parseMindmapNodeLink(pendingTask.name);
                pendingTask.name = linked.text || pendingTask.name;
                pendingTask.href = linked.href || null;
            }
            if (typeof parseDiagramNodeMeta === 'function') {
                const meta = parseDiagramNodeMeta(pendingTask.name);
                pendingTask.name = meta.text || pendingTask.name;
                if (meta.assignee) {
                    pendingTask.assignee = meta.assignee;
                    pendingTask.initials = meta.initials;
                }
                if (meta.deadlineLabel) {
                    if (meta.deadlineDate && typeof meta.deadlineDate.toISOString === 'function') {
                        const y = meta.deadlineDate.getFullYear();
                        const mo = String(meta.deadlineDate.getMonth() + 1).padStart(2, '0');
                        const d = String(meta.deadlineDate.getDate()).padStart(2, '0');
                        pendingTask.dueDate = y + '-' + mo + '-' + d;
                    } else {
                        pendingTask.dueDate = meta.deadlineLabel;
                    }
                    pendingTask.deadlineLabel = meta.deadlineLabel;
                }
            } else {
                const details = pendingTask.name;
                const atMatch = details.match(/@(\S+)/);
                if (atMatch) {
                    pendingTask.assignee = atMatch[1];
                    pendingTask.name = pendingTask.name.replace(atMatch[0], '').trim();
                }
            }
            const details = pendingTask.name;
            if (/не срочно/i.test(details)) {
                pendingTask.priority = 'не срочно';
                pendingTask.name = pendingTask.name.replace(/не\s+срочно/gi, '').trim();
            } else if (details.includes('срочно')) {
                pendingTask.priority = 'срочно';
                pendingTask.name = pendingTask.name.replace(/срочно/gi, '').trim();
            } else if (details.includes('важно')) {
                pendingTask.priority = 'важно';
                pendingTask.name = pendingTask.name.replace(/важно/gi, '').trim();
            } else if (/средне/i.test(details)) {
                pendingTask.priority = 'средне';
                pendingTask.name = pendingTask.name.replace(/средне/gi, '').trim();
            }
            const tagRegex = /тег:\s*([^(\s]+)(?:\(([^)]+)\))?/g;
            let tagMatch;
            while ((tagMatch = tagRegex.exec(details)) !== null) {
                const tagText = tagMatch[1];
                let color = null;
                if (tagMatch[2]) {
                    const colorInput = tagMatch[2].trim();
                    if (/^#[0-9A-Fa-f]{6}$/.test(colorInput)) color = colorInput;
                    else color = colorNames[colorInput.toLowerCase()] || null;
                }
                pendingTask.tags.push({ text: tagText, color });
            }
            pendingTask.name = pendingTask.name.replace(/тег:\s*[^(\s]+(?:\([^)]+\))?/g, '').trim();
            const dateMatch = details.match(/(?:дата|до):\s*(\d{4}-\d{2}-\d{2})/);
            if (dateMatch) {
                pendingTask.dueDate = dateMatch[1];
                pendingTask.name = pendingTask.name.replace(dateMatch[0], '').trim();
            }
            pendingTask.name = pendingTask.name.replace(/\s+/g, ' ').trim();
            continue;
        }
    }

    savePendingTask();

    columns.forEach((col) => {
        if (col.wipLimit == null) return;
        const count = tasks.filter((t) => t.column === col.name).length;
        if (count > col.wipLimit) {
            diagnostics.push(diag('warning', `WIP «${col.name}»: ${count}/${col.wipLimit}`, {
                code: 'kanban_wip_exceeded',
                hint: 'Превышен лимит колонки'
            }));
        }
        col.wipCount = count;
        col.wipExceeded = count > col.wipLimit;
    });

    if (!columns.length) return attachDiagnostics(null, diagnostics);
    return attachDiagnostics({ title, columns, tasks }, diagnostics);
}
