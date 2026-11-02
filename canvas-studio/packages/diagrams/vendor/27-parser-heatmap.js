/**
 * Парсер тепловой карты (heatmap).
 *
 * Вариант A — DSL:
 *   название: Нагрузка
 *   ось X: Пн, Вт, Ср, Чт, Пт
 *   Backend: 2, 5, 8, 3, 1
 *   Frontend: 4, 4, 6, 7, 2
 *
 * Вариант B — вставка из Excel (TSV / CSV):
 *   \tПн\tВт\tСр
 *   Backend\t2\t5\t8
 *
 * Первая строка «тепловая» / heatmap — опциональна.
 */
function parseHeatmap(text) {
    const clean = String(text || '').replace(/·/g, ' ');
    const diagnostics = [];
    const rawLines = clean.split(/\r?\n/);

    function pushDiag(level, message, extra) {
        if (typeof diag === 'function') {
            diagnostics.push(diag(level, message, extra || {}));
        } else {
            diagnostics.push({ level, message, ...(extra || {}) });
        }
    }

    function attach(data) {
        if (typeof attachDiagnostics === 'function') {
            return attachDiagnostics(data, diagnostics);
        }
        if (data) data.diagnostics = diagnostics;
        return data;
    }

    function splitList(s) {
        const t = String(s || '').trim();
        if (!t) return [];
        if (t.indexOf('\t') >= 0) {
            return t.split('\t').map((x) => x.trim());
        }
        if (t.indexOf('|') >= 0) {
            return t.split('|').map((x) => x.trim()).filter(Boolean);
        }
        if (t.indexOf(';') >= 0 && t.indexOf(',') < 0) {
            return t.split(';').map((x) => x.trim()).filter(Boolean);
        }
        return t.split(',').map((x) => x.trim()).filter(Boolean);
    }

    function parseNum(tok) {
        const s = String(tok || '').trim().replace(/\s/g, '').replace(',', '.');
        if (s === '' || s === '—' || s === '-' || s === '–' || s.toLowerCase() === 'n/a') return null;
        const n = parseFloat(s);
        return Number.isFinite(n) ? n : null;
    }

    function looksLikeNumberRow(cells) {
        if (!cells.length) return false;
        let nums = 0;
        cells.forEach((c) => { if (parseNum(c) != null) nums += 1; });
        return nums >= Math.ceil(cells.length * 0.6);
    }

    const contentLines = [];
    rawLines.forEach((l, idx) => {
        const t = l.trim();
        if (typeof isDiagramCommentLine === 'function' ? isDiagramCommentLine(t) : (!t || t.startsWith('#'))) return;
        if (/^(тепловая|heatmap|heat|теплокарта)\s*$/i.test(t)) return;
        contentLines.push({ text: l, line: idx + 1 });
    });
    if (!contentLines.length) return attach(null);

    let title = '';
    let colLabels = [];
    let rowLabels = [];
    const matrix = [];

    // --- TSV / CSV matrix (Excel paste) ---
    const tabHeavy = contentLines.filter((e) => e.text.indexOf('\t') >= 0).length
        >= Math.max(1, Math.ceil(contentLines.length * 0.5));
    const semicolonHeavy = !tabHeavy && contentLines.filter((e) => (e.text.match(/;/g) || []).length >= 2).length
        >= Math.max(1, Math.ceil(contentLines.length * 0.5));

    if (tabHeavy || semicolonHeavy) {
        const sep = tabHeavy ? '\t' : ';';
        const rows = contentLines.map((e) => e.text.split(sep).map((c) => c.trim()));
        const maxCols = Math.max(...rows.map((r) => r.length), 0);
        const normalized = rows.map((r) => {
            const copy = r.slice();
            while (copy.length < maxCols) copy.push('');
            return copy;
        });

        let startR = 0;
        let startC = 0;
        // Corner cell empty → first row = X labels, first col = Y labels
        if (normalized.length >= 2 && normalized[0].length >= 2) {
            const corner = normalized[0][0];
            const restHeader = normalized[0].slice(1);
            const firstCol = normalized.slice(1).map((r) => r[0]);
            if ((!corner || /^(ряд|строка|row|y|ось)$/i.test(corner))
                && restHeader.some((h) => h && parseNum(h) == null)
                && firstCol.some((h) => h && parseNum(h) == null)) {
                colLabels = restHeader.map((h, i) => h || ('C' + (i + 1)));
                startR = 1;
                startC = 1;
            } else if (looksLikeNumberRow(normalized[0])) {
                // all-numeric first row → synthetic labels
                colLabels = normalized[0].map((_, i) => String(i + 1));
                startR = 0;
                startC = 0;
            } else {
                colLabels = normalized[0].map((h, i) => h || ('C' + (i + 1)));
                startR = 1;
                startC = 0;
            }
        }

        for (let r = startR; r < normalized.length; r++) {
            const row = normalized[r];
            let label = '';
            let vals;
            if (startC === 1) {
                label = row[0] || ('R' + (r - startR + 1));
                vals = row.slice(1).map(parseNum);
            } else {
                label = 'R' + (r - startR + 1);
                vals = row.map(parseNum);
            }
            // Skip title-like single cell rows
            if (vals.every((v) => v == null) && label && !looksLikeNumberRow(row)) {
                if (!title && /название|title/i.test(label) === false && r === startR && vals.length <= 1) {
                    // ignore
                }
                continue;
            }
            rowLabels.push(label);
            matrix.push(vals);
        }

        // Align columns
        const w = Math.max(colLabels.length, ...matrix.map((m) => m.length), 1);
        while (colLabels.length < w) colLabels.push('C' + (colLabels.length + 1));
        matrix.forEach((m) => {
            while (m.length < w) m.push(null);
            if (m.length > w) m.length = w;
        });
        colLabels = colLabels.slice(0, w);

        if (!matrix.length) {
            pushDiag('error', 'Не удалось разобрать таблицу из вставки', { code: 'heatmap_empty' });
            return attach(null);
        }
        return attach({
            title: title || '',
            colLabels,
            rowLabels,
            matrix,
            min: null,
            max: null
        });
    }

    // --- DSL ---
    let presetRows = false;
    const dataLines = [];
    contentLines.forEach((entry) => {
        const trimmed = entry.text.trim();
        const titleVal = typeof parseDiagramTitleLine === 'function'
            ? parseDiagramTitleLine(trimmed)
            : null;
        if (titleVal != null || /^(заголовок|title|название)\s*:/i.test(trimmed)) {
            if (titleVal) title = titleVal;
            else title = trimmed.replace(/^(заголовок|title|название)\s*:/i, '').trim();
            return;
        }
        const axisX = trimmed.match(/^(?:ось\s*x|x|столбцы|columns|cols)\s*:\s*(.+)$/i);
        if (axisX) {
            colLabels = splitList(axisX[1]);
            return;
        }
        const axisY = trimmed.match(/^(?:ось\s*y|y|строки|rows)\s*:\s*(.+)$/i);
        if (axisY) {
            rowLabels = splitList(axisY[1]);
            presetRows = true;
            return;
        }
        dataLines.push(entry);
    });

    const collectedNames = [];
    dataLines.forEach((entry) => {
        const trimmed = entry.text.trim();
        let name = '';
        let rest = '';
        const mColon = trimmed.match(/^(.+?)\s*:\s*(.+)$/);
        const mPipe = trimmed.match(/^(.+?)\s*\|\s*(.+)$/);
        if (mColon && !/^(https?|id)$/i.test(mColon[1])) {
            name = mColon[1].trim();
            rest = mColon[2].trim();
        } else if (mPipe) {
            name = mPipe[1].trim();
            rest = mPipe[2].trim();
        } else {
            const parts = trimmed.split(/\s+/);
            const nums = [];
            while (parts.length && parseNum(parts[parts.length - 1]) != null) {
                nums.unshift(parts.pop());
            }
            if (nums.length && parts.length) {
                name = parts.join(' ');
                rest = nums.join(',');
            } else {
                pushDiag('warning', 'Строка не похожа на ряд тепловой карты', {
                    line: entry.line,
                    code: 'heatmap_skip_line',
                    hint: 'Формат: Backend: 2, 5, 8  или вставьте таблицу из Excel'
                });
                return;
            }
        }
        const vals = splitList(rest).map(parseNum);
        if (!vals.length) {
            pushDiag('warning', 'Пустые значения в ряду «' + name + '»', {
                line: entry.line,
                code: 'heatmap_empty_row'
            });
            return;
        }
        matrix.push(vals);
        collectedNames.push(name);
    });

    if (!matrix.length) {
        pushDiag('error', 'Нет данных для тепловой карты', {
            code: 'heatmap_empty',
            hint: 'ось X: … и строки «Имя: 1, 2, 3» или вставьте таблицу из Excel'
        });
        return attach(null);
    }

    if (!presetRows || rowLabels.length !== matrix.length) {
        rowLabels = collectedNames;
    }

    const w = Math.max(
        colLabels.length,
        ...matrix.map((m) => m.length),
        1
    );
    if (!colLabels.length) {
        for (let i = 0; i < w; i++) colLabels.push(String(i + 1));
    }
    while (colLabels.length < w) colLabels.push('C' + (colLabels.length + 1));
    colLabels = colLabels.slice(0, w);
    matrix.forEach((m) => {
        while (m.length < w) m.push(null);
        if (m.length > w) m.length = w;
    });

    let min = Infinity;
    let max = -Infinity;
    matrix.forEach((row) => {
        row.forEach((v) => {
            if (v == null) return;
            if (v < min) min = v;
            if (v > max) max = v;
        });
    });
    if (!Number.isFinite(min)) { min = 0; max = 1; }
    if (min === max) { max = min + 1; }

    return attach({
        title,
        colLabels,
        rowLabels,
        matrix,
        min,
        max
    });
}
