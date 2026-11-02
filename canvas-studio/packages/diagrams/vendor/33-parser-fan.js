/**
 * Парсер «Веера значимости» (Significance Fan).
 *
 * заголовок: …
 * вес: Скорость 90, Качество 50, Дизайн 30
 * Продукт A: 80, 60, 90
 * Продукт B: 60, 90, 50
 *
 * Вес — важность оси (0–100). Значения серии — оценка по оси (0–100).
 */
function parseFan(text) {
    const diagnostics = [];
    let title = 'Веер значимости';
    let axes = [];
    const series = [];

    String(text || '').split('\n').forEach((raw, idx) => {
        const lineNo = idx + 1;
        const trimmed = raw.trim();
        if (typeof isDiagramCommentLine === 'function' ? isDiagramCommentLine(trimmed) : (!trimmed || trimmed.startsWith('#'))) return;
        if (/^fan\s*$/i.test(trimmed) || /^веер\s*$/i.test(trimmed)) return;

        const titleVal = typeof parseDiagramTitleLine === 'function'
            ? parseDiagramTitleLine(trimmed)
            : null;
        if (titleVal != null || /^(заголовок|title)\s*:/i.test(trimmed)) {
            if (titleVal) title = titleVal;
            return;
        }

        const weightMatch = trimmed.match(/^(?:вес|оси|критерии)\s*:\s*(.+)$/i);
        if (weightMatch) {
            axes = [];
            weightMatch[1].split(',').forEach((part) => {
                const p = part.trim();
                if (!p) return;
                const m = p.match(/^(.+?)\s+([0-9]+(?:[.,][0-9]+)?)\s*%?\s*$/);
                if (!m) {
                    diagnostics.push(diag('warning', 'Не разобран критерий веса', {
                        line: lineNo, code: 'fan_bad_weight', hint: 'Скорость 90'
                    }));
                    return;
                }
                let w = parseFloat(String(m[2]).replace(',', '.'));
                if (!(w >= 0)) w = 50;
                if (w > 1 && w <= 100) w = w / 100;
                else if (w > 100) w = 1;
                axes.push({ label: m[1].trim(), weight: Math.max(0.05, Math.min(1, w)) });
            });
            return;
        }

        const seriesMatch = trimmed.match(/^(.+?)\s*:\s*(.+)$/);
        if (seriesMatch) {
            const name = seriesMatch[1].trim();
            if (/^(заголовок|title|вес|оси|критерии)$/i.test(name)) return;
            const vals = seriesMatch[2].split(',').map((s) => {
                let v = parseFloat(String(s.trim()).replace(',', '.'));
                if (!Number.isFinite(v)) return null;
                if (v > 1 && v <= 100) v = v / 100;
                else if (v > 100) v = 1;
                return Math.max(0, Math.min(1, v));
            });
            if (vals.some((v) => v == null)) {
                diagnostics.push(diag('warning', 'В серии должны быть числа 0–100', {
                    line: lineNo, code: 'fan_bad_series'
                }));
                return;
            }
            series.push({ name, values: vals, line: lineNo });
            return;
        }

        diagnostics.push(diag('warning', 'Строка не распознана', {
            line: lineNo, code: 'fan_bad_line',
            hint: 'вес: A 90, B 50  или  Серия: 80, 60, 40'
        }));
    });

    if (!axes.length || !series.length) {
        return attachDiagnostics(null, diagnostics);
    }

    let mismatch = false;
    series.forEach((s) => {
        if (s.values.length !== axes.length) {
            mismatch = true;
            diagnostics.push(diag('error',
                `Серия «${s.name}»: ${s.values.length} знач. при ${axes.length} осях — схема не построена`, {
                    line: s.line || null,
                    code: 'fan_length_mismatch',
                    hint: 'Число значений должно совпадать с числом критериев в «вес:»'
                }));
        }
    });
    if (mismatch) {
        return attachDiagnostics(null, diagnostics);
    }

    return attachDiagnostics({ title, axes, series }, diagnostics);
}
