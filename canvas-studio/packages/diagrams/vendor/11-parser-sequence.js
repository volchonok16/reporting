/**
 * Парсинг диаграммы последовательностей (кириллический синтаксис).
 * Короткие блоки (предпочтительно):
 *   если … / конец
 *   параллельно … / и / конец
 *   выбор … / или / конец
 *   цикл … / конец
 * Старые длинные формы тоже принимаются:
 *   Начало ветки / иначе / конец ветки
 *   Начало цикла / конец цикла
 *   Начало параллельных действий / и / конец параллельных действий
 *   Начало опционально / конец опционально
 * Прочее: Участник, сообщения -> / -->, комментарий, автонумерация,
 * активировать / завершить / создать.
 */
function parseSequence(text) {
    const rawLines = String(text || '').split('\n');
    const lines = [];
    rawLines.forEach((l, idx) => {
        if (l.trim() === '') return;
        lines.push({ text: l, line: idx + 1 });
    });
    if (lines.length === 0) return null;

    let title = '';
    let startIdx = 0;
    const firstTrim = lines[0].text.trim();
    const firstTitle = typeof parseDiagramTitleLine === 'function'
        ? parseDiagramTitleLine(firstTrim)
        : null;
    if (firstTitle) {
        title = firstTitle;
        startIdx = 1;
    } else {
        // Сообщение: латинские/кириллические имена + -> / -->
        const firstIsMessage = /^.+\s*(->|-->)\s*.+/i.test(firstTrim);
        // \b плохо работает с кириллицей — граница слова через пробел/конец строки
        const firstIsKeyword = /^(Участник|если|параллельно|выбор|цикл|Начало ветки|Начало цикла|Начало параллельных действий|Начало опционально|Начало альтернативы|Начало комментария|автонумерация|завершить|создать|активировать)(?:\s|$|:)/i.test(firstTrim);
        if (!firstIsMessage && !firstIsKeyword) {
            title = firstTrim;
            startIdx = 1;
        }
    }

    const participantsMap = new Map();
    const participantsOrder = [];
    const items = [];
    const diagnostics = [];
    let autoNumber = false;
    let msgCounter = 0;

    function addParticipant(name, alias = null, lineNo = null) {
        const existing = participantsMap.get(name);
        if (existing) {
            // Обновляем алиас, если участник уже появился из сообщения
            if (alias && !existing.alias) existing.alias = alias;
            if (lineNo != null && existing.sourceLine == null) existing.sourceLine = lineNo;
            return existing;
        }
        // Если имя совпало с чужим алиасом — не создаём дубликат
        for (const p of participantsOrder) {
            if (p.alias && p.alias === name) {
                if (lineNo != null && p.sourceLine == null) p.sourceLine = lineNo;
                return p;
            }
            if (alias && p.name === alias) {
                if (lineNo != null && p.sourceLine == null) p.sourceLine = lineNo;
                return p;
            }
        }
        const p = { name, alias, sourceLine: lineNo != null ? lineNo : null };
        participantsMap.set(name, p);
        participantsOrder.push(p);
        return p;
    }

    function isEndKeyword(line, endKeyword) {
        if (!endKeyword) return false;
        const t = String(line || '').toLowerCase();
        if (Array.isArray(endKeyword)) {
            return endKeyword.some((k) => String(k).toLowerCase() === t);
        }
        return t === String(endKeyword).toLowerCase();
    }

    function parseBlock(blockLines, startFrom, endKeyword, targetItems) {
        let i = startFrom;
        while (i < blockLines.length) {
            const entry = blockLines[i];
            const line = entry.text.trim();
            const lineNo = entry.line;
            if (typeof isDiagramCommentLine === 'function' ? isDiagramCommentLine(line) : (line === '' || line.startsWith('#'))) { i++; continue; }

            if (isEndKeyword(line, endKeyword)) {
                return i;
            }

            // Участник
            const partMatch = line.match(/^[Уу]частник\s+(.+?)(?:\s+как\s+(.+))?$/i);
            if (partMatch) {
                addParticipant(partMatch[1].trim(), partMatch[2]?.trim() || null, lineNo);
                i++;
                continue;
            }

            // Автонумерация
            if (line.toLowerCase() === 'автонумерация') {
                autoNumber = true;
                i++;
                continue;
            }

            // Завершить / активировать / создать (Mermaid-подобные)
            const deactMatch = line.match(/^завершить\s+(.+)$/i);
            if (deactMatch) {
                targetItems.push({ type: 'deactivate', target: deactMatch[1].trim(), line: lineNo });
                i++;
                continue;
            }
            const actMatch = line.match(/^активировать\s+(.+)$/i);
            if (actMatch) {
                targetItems.push({ type: 'activate', target: actMatch[1].trim(), line: lineNo });
                i++;
                continue;
            }
            const createMatch = line.match(/^создать\s+(.+)$/i);
            if (createMatch) {
                const name = createMatch[1].trim();
                addParticipant(name, null, lineNo);
                targetItems.push({ type: 'create', target: name, line: lineNo });
                i++;
                continue;
            }

            // Комментарий начало
            const commentStartMatch = line.match(/^Начало комментария:\s*(.*)$/i);
            if (commentStartMatch) {
                const label = commentStartMatch[1].trim();
                const commentItems = [];

                let target = null;
                const lookAhead = (idx) => {
                    for (let j = idx + 1; j < blockLines.length; j++) {
                        const l = blockLines[j].text.trim();
                        if (typeof isDiagramCommentLine === 'function' ? isDiagramCommentLine(l) : (l === '' || l.startsWith('#'))) continue;
                        if (l.toLowerCase() === 'конец комментария') break;
                        const msgMatch = l.match(/^(.+?)\s*(->|-->)\s*(.+?):/);
                        if (msgMatch) {
                            return msgMatch[1].trim();
                        }
                    }
                    return null;
                };
                target = lookAhead(i) || (participantsOrder.length > 0 ? participantsOrder[participantsOrder.length - 1].name : null);

                targetItems.push({ type: 'comment_start', label, items: commentItems, target, line: lineNo });
                const endAt = parseBlock(blockLines, i + 1, 'конец комментария', commentItems);
                const closed = endAt < blockLines.length
                    && blockLines[endAt].text.trim().toLowerCase() === 'конец комментария';
                if (!closed) {
                    diagnostics.push(diag('error', 'Не закрыт блок «Начало комментария»', {
                        line: lineNo,
                        code: 'seq_unclosed_block',
                        hint: 'Добавьте строку «Конец комментария»'
                    }));
                    i = endAt;
                } else {
                    i = endAt + 1;
                }
                targetItems.push({ type: 'comment_end' });
                continue;
            }

            // Группы: короткие (если/параллельно/выбор/цикл) и длинные «Начало …»
            const groupStartMatch = line.match(/^(если|параллельно|выбор|цикл|Начало ветки|Начало альтернативы|Начало цикла|Начало параллельных действий|Начало опционально)\s*(.*)$/i);
            if (groupStartMatch) {
                const openRaw = groupStartMatch[1];
                const openLower = openRaw.toLowerCase();
                const label = groupStartMatch[2].trim() || '';
                let groupType = openLower;
                let endKwds = ['конец'];
                if (openLower === 'если' || openLower === 'начало опционально') {
                    groupType = 'начало опционально';
                    endKwds = ['конец', 'конец опционально'];
                } else if (openLower === 'параллельно' || openLower === 'начало параллельных действий') {
                    groupType = 'начало параллельных действий';
                    endKwds = ['конец', 'конец параллельных действий'];
                } else if (openLower === 'выбор' || openLower === 'начало ветки' || openLower === 'начало альтернативы') {
                    groupType = 'начало ветки';
                    endKwds = ['конец', 'конец ветки', 'конец альтернативы'];
                } else if (openLower === 'цикл' || openLower === 'начало цикла') {
                    groupType = 'начало цикла';
                    endKwds = ['конец', 'конец цикла'];
                }

                const groupItems = [];
                targetItems.push({ type: 'group_start', group: groupType, label, items: groupItems, line: lineNo });
                const endAt = parseBlock(blockLines, i + 1, endKwds, groupItems);
                const closed = endAt < blockLines.length
                    && isEndKeyword(blockLines[endAt].text.trim(), endKwds);
                if (!closed) {
                    diagnostics.push(diag('error', `Не закрыт блок «${openRaw}»`, {
                        line: lineNo,
                        code: 'seq_unclosed_block',
                        hint: 'Добавьте строку «конец»'
                    }));
                    i = endAt;
                } else {
                    i = endAt + 1;
                }
                targetItems.push({ type: 'group_end' });
                continue;
            }

            // Лишний закрывающий блок без открытия
            const orphanEnd = line.match(/^(Конец ветки|Конец цикла|Конец параллельных действий|Конец опционально|Конец альтернативы|Конец комментария|конец)\s*$/i);
            if (orphanEnd && endKeyword && !isEndKeyword(orphanEnd[1], endKeyword)) {
                diagnostics.push(diag('error', `Лишнее «${orphanEnd[1]}» — ожидается закрытие текущего блока`, {
                    line: lineNo,
                    code: 'seq_wrong_close',
                    hint: 'Проверьте вложенность блоков'
                }));
                i++;
                continue;
            }
            if (orphanEnd && !endKeyword) {
                diagnostics.push(diag('error', `«${orphanEnd[1]}» без соответствующего начала`, {
                    line: lineNo,
                    code: 'seq_orphan_close',
                    hint: 'Сначала откройте блок (если / выбор / параллельно / цикл)'
                }));
                i++;
                continue;
            }

            // Разделители: или/иначе (ветка), и или / (параллель)
            const divLower = line.toLowerCase();
            if (divLower === 'иначе' || divLower === 'или' || divLower === 'и' || divLower === '/') {
                if (!endKeyword) {
                    diagnostics.push(diag('warning', `«${divLower}» вне блока выбора/параллели`, {
                        line: lineNo,
                        code: 'seq_divider_outside',
                        hint: 'Используйте внутри «выбор» / «параллельно»'
                    }));
                }
                let divLabel = 'и';
                if (divLower === 'или') divLabel = 'или';
                else if (divLower === 'иначе') divLabel = 'иначе';
                targetItems.push({ type: 'divider', label: divLabel, line: lineNo });
                i++;
                continue;
            }

            // Сообщение
            const msgMatch = line.match(/^(.+?)\s*(->|-->)\s*(.+?):\s*(.*)$/);
            if (msgMatch) {
                const fromRaw = msgMatch[1].trim();
                const arrowType = msgMatch[2];
                const toRaw = msgMatch[3].trim();
                const msgText = msgMatch[4].trim();

                let fromName = fromRaw;
                let toName = toRaw;
                if (!participantsMap.has(fromRaw)) {
                    for (const [name, p] of participantsMap) {
                        if (p.alias === fromRaw) { fromName = name; break; }
                    }
                }
                if (!participantsMap.has(toRaw)) {
                    for (const [name, p] of participantsMap) {
                        if (p.alias === toRaw) { toName = name; break; }
                    }
                }

                addParticipant(fromName, null, lineNo);
                addParticipant(toName, null, lineNo);

                const seqNum = autoNumber ? ++msgCounter : null;
                targetItems.push({
                    type: 'message',
                    from: fromName,
                    to: toName,
                    text: msgText,
                    arrowType,
                    number: seqNum,
                    line: lineNo
                });
                i++;
                continue;
            }

            diagnostics.push(diag('warning', 'Строка не распознана', {
                line: lineNo,
                code: 'seq_bad_line',
                hint: 'Ожидается Участник / сообщение A -> B: текст / блок если·выбор·параллельно·цикл'
            }));
            i++;
        }
        return i;
    }

    parseBlock(lines, startIdx, null, items);

    const known = new Set(participantsOrder.map((p) => p.name));
    participantsOrder.forEach((p) => { if (p.alias) known.add(p.alias); });

    items.forEach((item) => {
        if (item.type === 'activate' || item.type === 'deactivate' || item.type === 'create') {
            const t = item.target;
            if (t && !known.has(t) && !participantsMap.has(t)) {
                diagnostics.push(diag('warning', `Участник «${t}» в «${item.type}» не объявлен`, {
                    line: item.line || null,
                    code: 'seq_unknown_participant',
                    hint: 'Добавьте «Участник …» или сообщение с этим именем'
                }));
            }
        }
    });

    if (!items.some((it) => it.type === 'message') && participantsOrder.length === 0) {
        diagnostics.push(diag('warning', 'Нет сообщений и участников', {
            code: 'seq_empty',
            hint: 'Добавьте строки вида «А -> Б: текст»'
        }));
    }

    const participants = participantsOrder.map((p, idx) => ({
        name: p.name,
        alias: p.alias || p.name,
        index: idx,
        sourceLine: p.sourceLine || null
    }));

    return attachDiagnostics({ title, participants, items, autoNumber }, diagnostics);
}