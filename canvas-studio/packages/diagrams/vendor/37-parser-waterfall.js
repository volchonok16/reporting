/**
 * Парсер «Водопада» (waterfall).
 *
 * заголовок: Прибыль Q3
 * единицы: млн ₽
 * Старт: 50
 * Выручка: +120
 * Подытог
 * Скидки: -15
 * Итог
 *
 * план: / факт: — две серии (сравнение).
 */
function parseWaterfall(text) {
    const diagnostics = [];
    let title = 'Водопад';
    let units = '';
    let showPct = true;
    let seriesName = 'основной';
    const seriesMap = new Map();

    function ensureSeries(name) {
        if (!seriesMap.has(name)) {
            seriesMap.set(name, { name, steps: [] });
        }
        return seriesMap.get(name);
    }

    function isTotalName(name) {
        return /^(итог|всего|итого|total|summa|сумма)$/i.test(String(name || '').trim());
    }
    function isSubtotalName(name) {
        return /^(подытог|checkpoint|промежуточный\s*итог|промежуточный)$/i.test(String(name || '').trim());
    }
    function isStartName(name) {
        return /^(старт|начало|баз[аы]|start|baseline)$/i.test(String(name || '').trim());
    }

    ensureSeries(seriesName);

    // Excel: две колонки «статья | число» (или одна колонка Итог/Подытог без числа)
    if (typeof parseSpreadsheetMatrix === 'function') {
        const sheet = parseSpreadsheetMatrix(text);
        if (sheet && sheet.rows && sheet.rows.length) {
            String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach((raw) => {
                const trimmed = raw.trim();
                const titleVal = typeof parseDiagramTitleLine === 'function'
                    ? parseDiagramTitleLine(trimmed)
                    : null;
                if (titleVal) title = titleVal;
                const unitsM = trimmed.match(/^(единицы|units)\s*:\s*(.*)$/i);
                if (unitsM) units = (unitsM[2] || '').trim();
                const seriesM = trimmed.match(/^(план|факт|plan|actual|fact)\s*:?\s*$/i);
                if (seriesM) {
                    const key = seriesM[1].toLowerCase();
                    seriesName = /^(план|plan)$/i.test(key) ? 'план' : 'факт';
                    ensureSeries(seriesName);
                }
            });
            const series = ensureSeries(seriesName);
            let usedSheet = false;
            sheet.rows.forEach((row) => {
                const name = String(row.name || '').trim();
                if (!name) return;
                if (row.bareTotal || isTotalName(name) || isSubtotalName(name)) {
                    const firstNum = (row.values || []).find((v) => v != null);
                    series.steps.push({
                        name,
                        kind: isSubtotalName(name) ? 'subtotal' : 'total',
                        value: firstNum != null ? firstNum : null,
                        line: row.line
                    });
                    usedSheet = true;
                    return;
                }
                // берём первое число в строке (типичная выгрузка «статья | сумма»)
                const nums = (row.values || []).filter((v) => v != null);
                if (!nums.length) return;
                const value = nums[0];
                const abs = Math.abs(value);
                if (isStartName(name) || !series.steps.length) {
                    series.steps.push({
                        name,
                        kind: 'start',
                        value: abs,
                        line: row.line
                    });
                } else {
                    series.steps.push({
                        name,
                        kind: 'delta',
                        value: value,
                        line: row.line
                    });
                }
                usedSheet = true;
            });
            if (usedSheet && series.steps.length) {
                const seriesListEarly = [];
                seriesMap.forEach((s) => {
                    const fin = finalizeSeries(s);
                    if (fin) seriesListEarly.push(fin);
                });
                if (seriesListEarly.length) {
                    const named = seriesListEarly.filter((s) => s.name !== 'основной' || seriesListEarly.length === 1);
                    const outSeries = named.length ? named : seriesListEarly;
                    return attachDiagnostics({
                        title,
                        units,
                        showPct,
                        series: outSeries,
                        steps: outSeries[0].steps
                    }, diagnostics);
                }
            } else {
                // не вышло — очистим и пойдём DSL
                seriesMap.clear();
                seriesName = 'основной';
                ensureSeries(seriesName);
            }
        }
    }

    String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach((raw, idx) => {
        const lineNo = idx + 1;
        const trimmed = raw.trim();
        if (typeof isDiagramCommentLine === 'function' ? isDiagramCommentLine(trimmed) : (!trimmed || trimmed.startsWith('#'))) return;
        if (/^(waterfall|водопад)\s*$/i.test(trimmed)) return;

        const titleVal = typeof parseDiagramTitleLine === 'function'
            ? parseDiagramTitleLine(trimmed)
            : null;
        if (titleVal != null || /^(заголовок|title)\s*:/i.test(trimmed)) {
            if (titleVal) title = titleVal;
            return;
        }

        const unitsM = trimmed.match(/^(единицы|units)\s*:\s*(.*)$/i);
        if (unitsM) {
            units = (unitsM[2] || '').trim();
            return;
        }

        const pctM = trimmed.match(/^(проценты|%|показывать)\s*:\s*(.*)$/i);
        if (pctM) {
            const v = (pctM[2] || '').trim().toLowerCase();
            showPct = !/^(нет|no|off|0|false|выкл)$/i.test(v);
            return;
        }

        const seriesM = trimmed.match(/^(план|факт|plan|actual|fact)\s*:?\s*$/i);
        if (seriesM) {
            const key = seriesM[1].toLowerCase();
            seriesName = /^(план|plan)$/i.test(key) ? 'план' : 'факт';
            ensureSeries(seriesName);
            return;
        }

        const series = ensureSeries(seriesName);
        const bare = trimmed.replace(/:$/, '').trim();

        if ((isTotalName(bare) || isSubtotalName(bare)) && !/:\s*[+\-0-9]/.test(trimmed)) {
            series.steps.push({
                name: bare,
                kind: isSubtotalName(bare) ? 'subtotal' : 'total',
                value: null,
                line: lineNo
            });
            return;
        }

        const m = trimmed.match(/^(.+?)\s*:\s*([+\−\-]?)\s*([0-9]+(?:[.,][0-9]+)?)\s*$/);
        if (!m) {
            diagnostics.push(diag('warning', 'Строка не распознана', {
                line: lineNo,
                code: 'waterfall_bad_line',
                hint: 'Пример: Выручка: +120  или  Скидки: -15'
            }));
            return;
        }

        const name = m[1].trim();
        if (/^(заголовок|title|единицы|units|проценты|показывать)$/i.test(name)) return;
        const signRaw = m[2].replace('−', '-');
        const abs = parseFloat(String(m[3]).replace(',', '.'));
        if (!Number.isFinite(abs)) {
            diagnostics.push(diag('warning', 'Нужно число', {
                line: lineNo, code: 'waterfall_bad_number'
            }));
            return;
        }

        if (isTotalName(name) || isSubtotalName(name)) {
            series.steps.push({
                name,
                kind: isSubtotalName(name) ? 'subtotal' : 'total',
                value: abs,
                line: lineNo
            });
            return;
        }

        let kind;
        let value;
        if (signRaw === '+' || signRaw === '-') {
            kind = 'delta';
            value = signRaw === '-' ? -abs : abs;
        } else if (!series.steps.length || isStartName(name)) {
            kind = 'start';
            value = abs;
        } else {
            kind = 'delta';
            value = abs;
        }
        series.steps.push({ name, kind, value, line: lineNo });
    });

    function finalizeSeries(series) {
        const steps = series.steps.slice();
        if (!steps.length) return null;

        const hasFinalTotal = steps.some((s) => s.kind === 'total');
        if (!hasFinalTotal) {
            steps.push({ name: 'Итог', kind: 'total', value: null, line: null });
        }

        let run = 0;
        let started = false;
        let startValue = null;

        steps.forEach((s) => {
            if (s.kind === 'start') {
                run = s.value;
                started = true;
                startValue = s.value;
                s.base = 0;
                s.top = s.value;
            } else if (s.kind === 'delta') {
                if (!started) {
                    started = true;
                    run = 0;
                    startValue = 0;
                }
                s.base = run;
                run += s.value;
                s.top = run;
            } else if (s.kind === 'subtotal' || s.kind === 'total') {
                if (s.value != null && Math.abs(s.value - run) > 0.009) {
                    diagnostics.push(diag('warning',
                        `«${s.name}»: указано ${s.value}, по шагам выходит ${Math.round(run * 100) / 100} — берём расчёт`, {
                            line: s.line,
                            code: 'waterfall_total_mismatch'
                        }));
                }
                s.value = run;
                s.base = 0;
                s.top = run;
                // подытог — checkpoint, бегущая сумма не сбрасывается
            }

            if (startValue != null && Math.abs(startValue) > 1e-9) {
                if (s.kind === 'start') {
                    // Старт = база 100%; подпись «+100%» бессмысленна
                    s.pctOfStart = null;
                    s.pctLabel = null;
                } else if (s.kind === 'delta') {
                    s.pctOfStart = (s.value / startValue) * 100;
                    s.pctLabel = ((s.value / Math.abs(startValue)) * 100);
                } else {
                    s.pctOfStart = (s.top / startValue) * 100;
                    s.pctLabel = (s.top / Math.abs(startValue)) * 100;
                }
            } else {
                s.pctOfStart = null;
                s.pctLabel = null;
            }
        });

        series.steps = steps;
        series.startValue = startValue;
        return series;
    }

    const seriesList = [];
    seriesMap.forEach((s) => {
        const fin = finalizeSeries(s);
        if (fin) seriesList.push(fin);
    });

    if (!seriesList.length) return attachDiagnostics(null, diagnostics);

    // если только «основной» — одна серия
    const named = seriesList.filter((s) => s.name !== 'основной' || seriesList.length === 1);
    const outSeries = named.length ? named : seriesList;

    return attachDiagnostics({
        title,
        units,
        showPct,
        series: outSeries,
        // совместимость со старым layout: первая серия как steps
        steps: outSeries[0].steps
    }, diagnostics);
}
