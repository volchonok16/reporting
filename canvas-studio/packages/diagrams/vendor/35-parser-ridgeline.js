/**
 * Парсер «Хребтов данных» (Ridgeline).
 *
 * заголовок: …
 * ось: Оценка
 * Продукт A: 5.2, 5.8, 6.1, 7.0
 * Продукт B: 7.0, 7.5, 8.0, 9.0
 */
function parseRidgeline(text) {
    const diagnostics = [];
    let title = 'Хребты данных';
    let axisLabel = 'Значение';
    const groups = [];

    if (typeof parseSpreadsheetMatrix === 'function') {
        const sheet = parseSpreadsheetMatrix(text);
        if (sheet && sheet.rows && sheet.rows.length) {
            String(text || '').split('\n').forEach((raw) => {
                const trimmed = raw.trim();
                const titleVal = typeof parseDiagramTitleLine === 'function'
                    ? parseDiagramTitleLine(trimmed)
                    : null;
                if (titleVal) title = titleVal;
                const axisMatch = trimmed.match(/^(?:ось|axis)\s*:\s*(.+)$/i);
                if (axisMatch) axisLabel = axisMatch[1].trim() || axisLabel;
            });
            sheet.rows.forEach((row) => {
                const vals = (row.values || []).filter((v) => v != null && Number.isFinite(v));
                if (vals.length < 2) {
                    diagnostics.push(diag('warning', 'Нужно ≥2 числа для распределения', {
                        line: row.line, code: 'ridge_short'
                    }));
                    return;
                }
                groups.push({ name: row.name, values: vals, line: row.line });
            });
            if (groups.length) {
                return attachDiagnostics({ title, axisLabel, groups }, diagnostics);
            }
        }
    }

    String(text || '').split('\n').forEach((raw, idx) => {
        const lineNo = idx + 1;
        const trimmed = raw.trim();
        if (typeof isDiagramCommentLine === 'function' ? isDiagramCommentLine(trimmed) : (!trimmed || trimmed.startsWith('#'))) return;
        if (/^ridgeline\s*$/i.test(trimmed) || /^хребты?\s*$/i.test(trimmed)) return;

        const titleVal = typeof parseDiagramTitleLine === 'function'
            ? parseDiagramTitleLine(trimmed)
            : null;
        if (titleVal != null || /^(заголовок|title)\s*:/i.test(trimmed)) {
            if (titleVal) title = titleVal;
            return;
        }
        const axisMatch = trimmed.match(/^(?:ось|axis)\s*:\s*(.+)$/i);
        if (axisMatch) {
            axisLabel = axisMatch[1].trim() || axisLabel;
            return;
        }

        const m = trimmed.match(/^(.+?)\s*:\s*(.+)$/);
        if (!m) {
            diagnostics.push(diag('warning', 'Строка не распознана', {
                line: lineNo, code: 'ridge_bad_line',
                hint: 'Группа: 1.2, 3.4, 5.6'
            }));
            return;
        }
        const name = m[1].trim();
        if (/^(заголовок|title|ось|axis)$/i.test(name)) return;
        const vals = m[2].split(',').map((s) => parseFloat(String(s.trim()).replace(',', '.')))
            .filter((v) => Number.isFinite(v));
        if (vals.length < 2) {
            diagnostics.push(diag('warning', 'Нужно ≥2 числа для распределения', {
                line: lineNo, code: 'ridge_short'
            }));
            return;
        }
        groups.push({ name, values: vals, line: lineNo });
    });

    if (!groups.length) return attachDiagnostics(null, diagnostics);
    return attachDiagnostics({ title, axisLabel, groups }, diagnostics);
}
