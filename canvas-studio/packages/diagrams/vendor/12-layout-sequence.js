/**
 * Компоновка диаграммы последовательностей (комментарии всегда слева от всей диаграммы,
 * автоматический сдвиг вправо при необходимости, без наложений).
 */
function layoutSequence(participants, items, options = {}) {
    const {
        startX = 120,
        startY = 80,
        gapX = 200,
        gapY = 44,
        activationHeight = 20,
        groupPadding = 36,
        groupTopMargin = 52,
        commentWidth = 150,
        commentOffset = 30,        // отступ от левого края комментария до линий жизни
        selfMessageWidth = 90,
        blockSpacing = 28,
        title = ''
    } = options;

    // Расставляем участников с обычным gapX
    let participantPos = {};
    participants.forEach((p, i) => {
        participantPos[p.name] = {
            x: startX + i * gapX,
            y: startY,
            name: p.name,
            alias: p.alias,
            index: i,
            color: p.color || '#666',
            sourceLine: p.sourceLine || p.line || null,
            line: p.sourceLine || p.line || null
        };
    });

    // ========== Вычисляем необходимый сдвиг вправо для левых комментариев ==========
    let shiftRight = 0;
    for (const item of items) {
        if (item.type === 'comment_start') {
            // Комментарий будет слева от startX (после сдвига) с отступом commentOffset
            // Нужно, чтобы startX + shiftRight >= commentWidth + commentOffset
            const neededStartX = commentWidth + commentOffset;
            const currentStartX = startX + shiftRight;
            if (currentStartX < neededStartX) {
                shiftRight = neededStartX - startX;
            }
        }
    }

    // Применяем сдвиг
    if (shiftRight > 0) {
        for (const name in participantPos) {
            participantPos[name].x += shiftRight;
        }
    }

    let currentY = startY + 60;
    const finalItems = [];
    let overallMinX = Infinity, overallMaxX = -Infinity;

    function updateOverallXBounds(x, width = 0) {
        if (x < overallMinX) overallMinX = x;
        if (x + width > overallMaxX) overallMaxX = x + width;
    }

    function processItems(itemList, targetArray) {
        for (const item of itemList) {
            if (item.type === 'message') {
                const fromPos = participantPos[item.from];
                const toPos = participantPos[item.to];
                if (!fromPos || !toPos) continue;
                const isSelf = (item.from === item.to);
                const x1 = fromPos.x;
                const x2 = toPos.x;
                const y = currentY;

                const messageEntry = {
                    type: 'message',
                    from: item.from,
                    to: item.to,
                    text: item.text,
                    number: item.number,
                    arrowType: item.arrowType,
                    line: item.line || item.sourceLine || null,
                    sourceLine: item.line || item.sourceLine || null,
                    x1, x2, y,
                    activationY: y - activationHeight / 2,
                    height: activationHeight,
                    isSelf
                };

                if (isSelf) {
                    messageEntry.selfMaxX = x1 + selfMessageWidth;
                    updateOverallXBounds(x1, selfMessageWidth);
                }

                targetArray.push(messageEntry);
                currentY += gapY;
            } else if (item.type === 'group_start') {
                const startYGroup = currentY;
                currentY += groupTopMargin;
                const subItems = [];
                const groupEntry = {
                    type: 'group_start',
                    group: item.group,
                    label: item.label,
                    y: currentY,
                    items: subItems,
                    line: item.line || item.sourceLine || null,
                    sourceLine: item.line || item.sourceLine || null
                };
                targetArray.push(groupEntry);
                processItems(item.items, subItems);

                const endY = currentY;
                groupEntry.boxY = startYGroup;
                groupEntry.boxH = endY - startYGroup;

                const xs = Object.values(participantPos).map(p => p.x);
                const minX = Math.min(...xs) - groupPadding;
                const maxX = Math.max(...xs) + groupPadding;
                groupEntry.x = minX;
                groupEntry.width = maxX - minX;

                currentY = endY + blockSpacing;
                updateOverallXBounds(minX, maxX - minX);
            } else if (item.type === 'comment_start') {
                const side = 'left';

                const startYComment = currentY;
                const subItems = [];
                const commentEntry = {
                    type: 'comment_start',
                    side: side,
                    label: item.label,
                    y: currentY,
                    items: subItems,
                    target: item.target,
                    line: item.line || item.sourceLine || null,
                    sourceLine: item.line || item.sourceLine || null
                };
                targetArray.push(commentEntry);
                processItems(item.items, subItems);

                const endY = currentY;
                commentEntry.boxY = startYComment;
                commentEntry.boxH = endY - startYComment;

                // Комментарий всегда слева от startX (с учётом сдвига)
                // startX уже скорректирован на shiftRight, поэтому startX + shiftRight не нужно
                const leftX = startX - commentWidth - commentOffset;   // startX здесь уже исходный? Нет, startX не менялся, менялись координаты участников.
                // Проще: берём минимальную координату X среди всех участников (после сдвига) и вычитаем ширину комментария + отступ
                const minX = Math.min(...Object.values(participantPos).map(p => p.x));
                commentEntry.x = minX - commentWidth - commentOffset;
                if (commentEntry.x < 0) commentEntry.x = 0; // на всякий случай
                commentEntry.width = commentWidth;

                currentY = endY + blockSpacing;
                updateOverallXBounds(commentEntry.x, commentWidth);
            } else if (item.type === 'divider') {
                targetArray.push({
                    type: 'divider',
                    label: item.label,
                    y: currentY,
                    line: item.line || item.sourceLine || null,
                    sourceLine: item.line || item.sourceLine || null
                });
                currentY += gapY;
            } else if (item.type === 'deactivate' || item.type === 'activate' || item.type === 'create') {
                targetArray.push({
                    type: item.type,
                    target: item.target,
                    y: currentY,
                    line: item.line || item.sourceLine || null,
                    sourceLine: item.line || item.sourceLine || null
                });
                currentY += gapY * 0.8;
            }
        }
    }

    processItems(items, finalItems);

    for (const name in participantPos) {
        updateOverallXBounds(participantPos[name].x);
    }

    if (!isFinite(overallMinX) || !isFinite(overallMaxX)) {
        overallMinX = 0;
        overallMaxX = startX + Math.max(participants.length - 1, 0) * gapX;
    }

    // Равномерные поля: сдвигаем участников и ВСЕ вложенные items (группы/заметки)
    const padding = 48;
    const shiftX = padding - overallMinX;
    if (Math.abs(shiftX) > 0.5) {
        for (const name in participantPos) {
            participantPos[name].x += shiftX;
        }
        (function shiftItems(list) {
            if (!list || !list.length) return;
            list.forEach((it) => {
                if (it.x1 != null) it.x1 += shiftX;
                if (it.x2 != null) it.x2 += shiftX;
                if (it.x != null) it.x += shiftX;
                if (it.selfMaxX != null) it.selfMaxX += shiftX;
                if (it.items) shiftItems(it.items);
            });
        })(finalItems);
        overallMinX += shiftX;
        overallMaxX += shiftX;
    }

    const totalHeight = currentY + 40;
    const width = (overallMaxX - overallMinX) + padding * 2;

    return {
        participants: Object.values(participantPos),
        items: finalItems,
        width,
        height: totalHeight,
        activationHeight,
        title: title || options.title || ''
    };
}