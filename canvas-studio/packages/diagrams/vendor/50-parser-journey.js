/**
 * Путь пользователя (user journey).
 *
 * название: Путь к подписке
 * этап: Осознание
 *   касание: Статья в блоге
 *   мысль: Интересно, но дорого?
 *   эмоция: 2
 *   боль: Нет кейсов из отрасли
 * этап: Оценка
 *   касание: Демо
 *   мысль: Понял ценность
 *   эмоция: 4
 *   боль: Долго настраивать
 * этап: Решение
 *   касание: Оплата
 *   эмоция: 5
 */
function parseJourney(text) {
    const diagnostics = [];
    let title = 'Путь пользователя';
    const stages = [];
    let current = null;

    function ensureStage(name, lineNo) {
        current = {
            name: String(name || '').trim() || 'Этап',
            touch: '',
            thought: '',
            emotion: null,
            pain: '',
            line: lineNo || null
        };
        stages.push(current);
        return current;
    }

    String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach((raw, idx) => {
        const lineNo = idx + 1;
        const trimmed = raw.trim();
        if (typeof isDiagramCommentLine === 'function'
            ? isDiagramCommentLine(trimmed)
            : (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//'))) return;

        if (/^(путь|journey|user\s*journey)\s*$/i.test(trimmed)) return;

        const titleVal = typeof parseDiagramTitleLine === 'function'
            ? parseDiagramTitleLine(trimmed)
            : null;
        if (titleVal != null) {
            title = titleVal;
            return;
        }

        const stageM = trimmed.match(/^(этап|стадия|stage|шаг)\s*:\s*(.+)$/i);
        if (stageM) {
            ensureStage(stageM[2], lineNo);
            return;
        }

        const fieldM = trimmed.match(/^(касание|канал|touch|мысль|feeling|эмоция|emotion|настроение|боль|барьер|pain|проблема)\s*:\s*(.+)$/i);
        if (fieldM) {
            if (!current) ensureStage('Этап', lineNo);
            const key = fieldM[1].toLowerCase();
            const val = fieldM[2].trim();
            if (/^(касание|канал|touch)$/i.test(key)) current.touch = val;
            else if (/^(мысль|feeling)$/i.test(key)) current.thought = val;
            else if (/^(боль|барьер|pain|проблема)$/i.test(key)) current.pain = val;
            else if (/^(эмоция|emotion|настроение)$/i.test(key)) {
                const n = parseInt(val, 10);
                if (Number.isFinite(n) && n >= 1 && n <= 5) {
                    current.emotion = n;
                } else {
                    diagnostics.push(diag('warning', 'Эмоция: число от 1 до 5', {
                        line: lineNo, code: 'journey_bad_emotion',
                        hint: 'эмоция: 3'
                    }));
                }
            }
            return;
        }

        if (trimmed) {
            diagnostics.push(diag('warning', 'Строка не распознана', {
                line: lineNo, code: 'journey_bad_line',
                hint: 'этап: … · касание: … · мысль: … · эмоция: 1–5 · боль: …'
            }));
        }
    });

    if (!stages.length) {
        return attachDiagnostics(null, diagnostics);
    }

    return attachDiagnostics({ title, stages }, diagnostics);
}
