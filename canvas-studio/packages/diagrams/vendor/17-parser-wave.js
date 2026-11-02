/**
 * Парсер волнообразной диаграммы (Sankey).
 * Поддерживает десятичные числа с точкой или запятой.
 * заголовок: … — опционально
 *
 * Баланс: у узла с входами сумма исходящих не может превышать сумму входящих.
 */
function parseWave(text) {
    const allLines = text.split('\n');
    const diagnostics = [];
    const nodesMap = new Map();
    const links = [];
    let title = '';

    allLines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (typeof isDiagramCommentLine === 'function' ? isDiagramCommentLine(trimmed) : (!trimmed || trimmed.startsWith('#'))) return;

        const titleVal = typeof parseDiagramTitleLine === 'function'
            ? parseDiagramTitleLine(trimmed)
            : null;
        if (titleVal != null || /^(заголовок|title)\s*:/i.test(trimmed)) {
            if (titleVal) title = titleVal;
            return;
        }

        const link = typeof matchDiagramValueLink === 'function'
            ? matchDiagramValueLink(trimmed)
            : null;
        if (!link) {
            diagnostics.push(diag('warning', `Строка не распознана (ожидается A -> B: число)`, {
                line: idx + 1,
                code: 'wave_bad_line',
                hint: 'Пример: Сырьё -> Обработка: 80  (также A --> B: число)'
            }));
            return;
        }
        const source = link.from;
        const target = link.to;
        let value = parseFloat(link.valueRaw.replace(',', '.'));
        value = Math.round(value * 100) / 100;
        if (!(value > 0)) {
            diagnostics.push(diag('warning', `Значение должно быть > 0`, {
                line: idx + 1,
                code: 'wave_non_positive',
                hint: 'Толщина ленты — положительное число, можно с запятой'
            }));
            return;
        }
        if (source === target) {
            diagnostics.push(diag('warning', `Петля «${source}» → «${target}»`, {
                line: idx + 1,
                code: 'self_loop',
                hint: 'Источник и приёмник не должны совпадать'
            }));
        }
        nodesMap.set(source, true);
        nodesMap.set(target, true);
        links.push({ source, target, value, line: idx + 1, from: source, to: target });
    });

    const nodes = Array.from(nodesMap.keys()).map((name, index) => ({ name, index }));
    const graph = analyzeDirectedGraph(
        nodes.map((n) => n.name),
        links,
        { allowMissingNodes: false }
    );
    graph.diagnostics.forEach((d) => {
        if (d.code === 'cycle') {
            d.message = 'Волновая диаграмма поддерживает только DAG (без циклов): ' + d.message.replace(/^Обнаружен цикл зависимостей:\s*/, '');
            d.hint = 'Уберите циклические связи или разбейте поток';
        }
    });
    diagnostics.push(...graph.diagnostics.filter((d) => d.code === 'cycle' || d.code === 'self_loop'));

    // Баланс потоков: исходящие ≤ входящие (у источников входящих нет — не проверяем)
    const eps = 0.009;
    const inflow = new Map();
    const outflow = new Map();
    const outLines = new Map();
    links.forEach((l) => {
        inflow.set(l.target, (inflow.get(l.target) || 0) + l.value);
        outflow.set(l.source, (outflow.get(l.source) || 0) + l.value);
        if (!outLines.has(l.source)) outLines.set(l.source, []);
        outLines.get(l.source).push(l.line);
    });
    nodes.forEach((n) => {
        const inn = inflow.get(n.name) || 0;
        const out = outflow.get(n.name) || 0;
        if (inn <= 0) return; // корень / источник
        if (out > inn + eps) {
            const lines = outLines.get(n.name) || [];
            const fmt = (v) => (Math.round(v * 100) / 100).toLocaleString('ru-RU');
            diagnostics.push(diag('error',
                `«${n.name}»: сумма выходов (${fmt(out)}) больше входа (${fmt(inn)})`, {
                    line: lines.length ? lines[lines.length - 1] : null,
                    code: 'wave_balance',
                    hint: 'Уменьшите исходящие ленты или увеличьте входящий поток'
                }));
        }
    });

    return attachDiagnostics({ title, nodes, links, hasCycle: graph.hasCycle }, diagnostics);
}
