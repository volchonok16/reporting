/**
 * Парсер «Динамика волны».
 *
 * Вариант 1:
 *   даты: Янв, Фев, Мар
 *   Продажи: 70, 45, 60
 *
 * Вариант 2:
 *   даты: Янв, Фев, Мар
 *   Продажи 70 -> Продажи 45 -> Продажи 60
 */
function parsePulsewave(text) {
    const diagnostics = [];
    let title = '';
    let slices = [];
    const series = [];

    function parseNumber(raw) {
        const v = parseFloat(String(raw || '').trim().replace(',', '.'));
        return Number.isFinite(v) ? Math.round(v * 100) / 100 : NaN;
    }

    function parseSeriesToken(token) {
        const m = String(token || '').trim().match(/^(.+?)\s+([0-9]+(?:[.,][0-9]+)?)$/);
        if (!m) return null;
        return {
            name: m[1].trim(),
            value: parseNumber(m[2])
        };
    }

    // Excel / Sheets: первая строка — даты, дальше ряды
    if (typeof parseSpreadsheetMatrix === 'function') {
        const sheet = parseSpreadsheetMatrix(text);
        if (sheet && sheet.rows && sheet.rows.length) {
            String(text || '').split('\n').forEach((raw) => {
                const trimmed = raw.trim();
                const titleVal = typeof parseDiagramTitleLine === 'function'
                    ? parseDiagramTitleLine(trimmed)
                    : null;
                if (titleVal) title = titleVal;
            });
            if (sheet.hasHeader && sheet.colLabels && sheet.colLabels.length) {
                slices = sheet.colLabels.slice();
            }
            sheet.rows.forEach((row) => {
                const values = (row.values || [])
                    .map((v) => (v == null ? NaN : Math.round(Math.abs(v) * 100) / 100))
                    .filter((v) => Number.isFinite(v));
                if (values.length < 2) {
                    diagnostics.push(diag('warning', 'Для ряда нужно минимум 2 значения', {
                        line: row.line,
                        code: 'pulsewave_short_row',
                        hint: 'Вставьте таблицу: даты в первой строке, ряды ниже'
                    }));
                    return;
                }
                if (values.some((v) => !(v > 0))) {
                    diagnostics.push(diag('warning', 'Значения должны быть > 0', {
                        line: row.line,
                        code: 'pulsewave_non_positive'
                    }));
                    return;
                }
                series.push({ name: row.name, values, line: row.line });
            });
            if (series.length) {
                let expectedLen = 0;
                series.forEach((row) => {
                    expectedLen = Math.max(expectedLen, row.values.length);
                });
                if (slices.length) expectedLen = slices.length;
                series.forEach((row) => {
                    if (row.values.length !== expectedLen) {
                        diagnostics.push(diag('error', `Ряд «${row.name}» имеет ${row.values.length} знач., ожидается ${expectedLen}`, {
                            line: row.line,
                            code: 'pulsewave_length_mismatch'
                        }));
                    }
                });
                if (!slices.length) {
                    slices = Array.from({ length: expectedLen }, (_, i) => 'Срез ' + (i + 1));
                }
                return attachDiagnostics({ title, slices, series }, diagnostics);
            }
        }
    }

    String(text || '').split('\n').forEach((raw, idx) => {
        const lineNo = idx + 1;
        const trimmed = raw.trim();
        if (typeof isDiagramCommentLine === 'function' ? isDiagramCommentLine(trimmed) : (!trimmed || trimmed.startsWith('#'))) return;
        if (/^pulsewave\s*$/i.test(trimmed) || /^динамика волны\s*$/i.test(trimmed)) return;

        const titleVal = typeof parseDiagramTitleLine === 'function'
            ? parseDiagramTitleLine(trimmed)
            : null;
        if (titleVal != null || /^(заголовок|title)\s*:/i.test(trimmed)) {
            if (titleVal) title = titleVal;
            return;
        }

        const slicesMatch = trimmed.match(/^(даты|срезы|dates|slices)\s*:\s*(.+)$/i);
        if (slicesMatch) {
            slices = slicesMatch[2]
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            if (slices.length < 2) {
                diagnostics.push(diag('warning', 'Нужно минимум 2 даты/среза', {
                    line: lineNo,
                    code: 'pulsewave_short_slices',
                    hint: 'Пример: даты: Янв, Фев, Мар'
                }));
            }
            return;
        }

        const compact = trimmed.match(/^(.+?)\s*:\s*(.+)$/);
        if (compact && !/->/.test(trimmed)) {
            const name = compact[1].trim();
            if (/^(заголовок|title|даты|срезы|dates|slices)$/i.test(name)) return;
            const values = compact[2]
                .split(',')
                .map((part) => parseNumber(part))
                .filter((v) => Number.isFinite(v));
            if (values.length < 2) {
                diagnostics.push(diag('warning', 'Для ряда нужно минимум 2 значения', {
                    line: lineNo,
                    code: 'pulsewave_short_row',
                    hint: 'Пример: Продажи: 70, 45, 60'
                }));
                return;
            }
            if (values.some((v) => !(v > 0))) {
                diagnostics.push(diag('warning', 'Значения должны быть > 0', {
                    line: lineNo,
                    code: 'pulsewave_non_positive',
                    hint: 'Толщина ленты должна быть положительной'
                }));
                return;
            }
            series.push({ name, values, line: lineNo });
            return;
        }

        if (/->/.test(trimmed)) {
            const parts = trimmed.split(/\s*(?:->|-->)\s*/).map((s) => s.trim()).filter(Boolean);
            if (parts.length < 2) {
                diagnostics.push(diag('warning', 'В цепочке нужно минимум 2 точки', {
                    line: lineNo,
                    code: 'pulsewave_bad_chain'
                }));
                return;
            }
            const parsed = parts.map(parseSeriesToken);
            if (parsed.some((p) => !p || !p.name || !Number.isFinite(p.value))) {
                diagnostics.push(diag('warning', 'Строка не распознана', {
                    line: lineNo,
                    code: 'pulsewave_bad_line',
                    hint: 'Пример: Продажи 70 -> Продажи 45 -> Продажи 60'
                }));
                return;
            }
            const baseName = parsed[0].name;
            const wrong = parsed.find((p) => p.name !== baseName);
            if (wrong) {
                diagnostics.push(diag('error', `В одной цепочке должно быть одно имя ряда: «${baseName}» ≠ «${wrong.name}»`, {
                    line: lineNo,
                    code: 'pulsewave_mixed_names',
                    hint: 'Для разных сущностей используйте отдельные строки'
                }));
                return;
            }
            const values = parsed.map((p) => p.value);
            if (values.some((v) => !(v > 0))) {
                diagnostics.push(diag('warning', 'Значения должны быть > 0', {
                    line: lineNo,
                    code: 'pulsewave_non_positive',
                    hint: 'Толщина ленты должна быть положительной'
                }));
                return;
            }
            series.push({ name: baseName, values, line: lineNo });
            return;
        }

        diagnostics.push(diag('warning', 'Строка не распознана', {
            line: lineNo,
            code: 'pulsewave_bad_line',
            hint: 'Пример: Продажи: 70, 45, 60'
        }));
    });

    if (!series.length) return attachDiagnostics(null, diagnostics);

    let expectedLen = 0;
    series.forEach((row) => {
        expectedLen = Math.max(expectedLen, row.values.length);
    });
    if (slices.length) {
        expectedLen = slices.length;
    }

    series.forEach((row) => {
        if (row.values.length !== expectedLen) {
            diagnostics.push(diag('error', `Ряд «${row.name}» имеет ${row.values.length} знач., ожидается ${expectedLen}`, {
                line: row.line,
                code: 'pulsewave_length_mismatch',
                hint: slices.length
                    ? 'Количество значений должно совпадать с числом дат'
                    : 'Все ряды должны иметь одинаковую длину'
            }));
        }
    });

    if (!slices.length) {
        slices = Array.from({ length: expectedLen }, (_, i) => 'Срез ' + (i + 1));
    }

    return attachDiagnostics({ title, slices, series }, diagnostics);
}
