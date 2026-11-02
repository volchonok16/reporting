/**
 * Компоновка Kanban-доски (assignee внизу справа, dueDate внизу слева,
 * отступ первой задачи от шапки выровнен с боковыми отступами).
 * Добавлена поддержка многострочного описания (description) с переносом длинных строк.
 */
function layoutSecret(data, options = {}) {
    const { columns, tasks } = data;
    const boardTitle = (data && data.title) || '';
    const {
        startX = 60,
        startY = boardTitle ? 108 : 80,
        columnWidth = 220,
        columnGap = 30,
        taskBaseHeight = 70,
        taskExtraLineHeight = 16,
        taskGap = 16,
        headerHeight = 40,
        tagHeight = 22,
        tagHorizontalGap = 8,
        taskPadding = 12,
        footerHeight = 20,
        topTaskMargin = 12,
        descriptionLineHeight = 16,
        descriptionFontSize = 12,
        maxCharsPerLine = 28   // будет пересчитан в рендерере на основе ширины
    } = options;

    const columnPositions = [];
    const taskPositions = [];
    let currentX = startX;
    // ширина контента внутри карточки
    const contentWidth = columnWidth - 24 - 2 * taskPadding; // 24 = боковые отступы колонки (12+12)

    columns.forEach(col => {
        const colTasks = tasks.filter(t => t.column === col.name);
        let y = startY + headerHeight + topTaskMargin;

        colTasks.forEach(task => {
            let height = taskBaseHeight;

            const titleFontSize = 13;
            const titleLineHeight = 18;
            // Шильдик приоритета справа сверху — резерв = реальная ширина бейджа + зазор
            const hasPrio = !!(task.priority && task.priority !== 'обычная');
            const prioBadgeW = hasPrio
                ? Math.max(50, String(task.priority).length * 6.5 + 14)
                : 0;
            const prioGap = hasPrio ? 10 : 0;
            // +8: название font-weight 600 шире, чем measure в wrapTextLines
            const titleMaxWidth = Math.max(40, contentWidth - prioBadgeW - prioGap - 8);
            const titleLines = (typeof wrapTextLines === 'function')
                ? wrapTextLines(task.name || '', titleMaxWidth, titleFontSize)
                : [String(task.name || '').trim() || 'Без названия'];
            if (titleLines.length > 1) {
                height += (titleLines.length - 1) * titleLineHeight;
            }

            // Вычисляем количество строк тегов
            let tagRows = 0;
            if (task.tags && task.tags.length > 0) {
                let currentRowWidth = 0;
                tagRows = 1;
                // максимальная ширина для тегов (с учётом отступов)
                const maxTagWidth = contentWidth;
                task.tags.forEach(tag => {
                    const tagWidth = tag.text.length * 7 + 16;
                    if (currentRowWidth + tagWidth + tagHorizontalGap > maxTagWidth && currentRowWidth > 0) {
                        tagRows++;
                        currentRowWidth = tagWidth;
                    } else {
                        currentRowWidth += tagWidth + (currentRowWidth > 0 ? tagHorizontalGap : 0);
                    }
                });
                height += tagRows * tagHeight;
            }

            // Описание с учётом переноса длинных строк
            if (task.description) {
                const descLines = task.description.split('\n');
                let totalLines = 0;
                // примерное число символов в строке при шрифте 12px
                const approxCharsPerLine = Math.floor(contentWidth / (descriptionFontSize * 0.6));
                descLines.forEach(line => {
                    if (line.length <= approxCharsPerLine) {
                        totalLines += 1;
                    } else {
                        totalLines += Math.ceil(line.length / approxCharsPerLine);
                    }
                });
                height += totalLines * descriptionLineHeight + 4;
            }

            // Нижняя полоса под assignee / dueDate (просрочено + имя — две строки)
            if (task.assignee || task.dueDate) {
                const twoLineFooter = !!(task.assignee && task.dueDate && task.overdue);
                height += twoLineFooter ? footerHeight + 16 : footerHeight;
                task._footerTwoLine = twoLineFooter;
            }

            taskPositions.push({
                ...task,
                x: currentX + 12, // 12 — отступ колонки
                y: y,
                width: columnWidth - 24,
                height: height,
                titleLines,
                titleLineHeight,
                titleFontSize,
                prioBadgeW,
                descriptionLines: task.description ? task.description.split('\n') : [],
                descriptionLineHeight,
                descriptionFontSize,
                taskPadding: taskPadding, // передаём для рендерера
                contentWidth: contentWidth // передаём для расчёта переноса
            });
            y += height + taskGap;
        });

        const maxY = y;
        columnPositions.push({
            name: col.name,
            x: currentX,
            y: startY,
            width: columnWidth,
            height: Math.max(maxY - startY, 100),
            wipLimit: col.wipLimit != null ? col.wipLimit : null,
            wipCount: col.wipCount != null ? col.wipCount : colTasks.length,
            wipExceeded: !!col.wipExceeded
        });
        currentX += columnWidth + columnGap;
    });

    const totalWidth = currentX - columnGap + startX;
    const maxHeight = Math.max(...columnPositions.map(c => c.y + c.height)) + 40;

    // Diagnostics парсера не копируем — mergeDiagnostics(parser, layout) сделает это сам
    return {
        columns: columnPositions,
        tasks: taskPositions,
        title: boardTitle,
        width: totalWidth,
        height: maxHeight,
        columnWidth,
        taskBaseHeight,
        tagHeight,
        tagHorizontalGap,
        taskPadding,
        footerHeight
    };
}