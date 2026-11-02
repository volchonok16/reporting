/**
 * Парсер «Потоки» — классическая диаграмма Sankey.
 * Синтаксис как у волны: A -> B: число
 * Опционально: колонки: Источник, Переработка, Сбыт
 * Узел можно закрепить: Узел @ Колонка (в связи не нужно).
 */
function parseSankey(text) {
    const allLines = String(text || '').split('\n');
    const diagnostics = [];
    const nodesMap = new Map();
    const links = [];
    let title = '';
    let columns = [];
    const nodeColumn = new Map();

    allLines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (typeof isDiagramCommentLine === 'function' ? isDiagramCommentLine(trimmed) : (!trimmed || trimmed.startsWith('#'))) return;
        if (/^sankey\s*$/i.test(trimmed) || /^потоки\s*$/i.test(trimmed)) return;

        const titleVal = typeof parseDiagramTitleLine === 'function'
            ? parseDiagramTitleLine(trimmed)
            : null;
        if (titleVal != null || /^(заголовок|title)\s*:/i.test(trimmed)) {
            if (titleVal) title = titleVal;
            return;
        }

        const colMatch = trimmed.match(/^(колонки|слои|columns|layers)\s*:\s*(.+)$/i);
        if (colMatch) {
            columns = colMatch[2].split(',').map((s) => s.trim()).filter(Boolean);
            return;
        }

        const pin = trimmed.match(/^(.+?)\s*@\s*(.+)$/);
        if (pin && !/->/.test(trimmed) && !/:\s*[0-9]/.test(trimmed)) {
            const name = pin[1].trim();
            const col = pin[2].trim();
            if (name && col) {
                nodesMap.set(name, true);
                nodeColumn.set(name, col);
            }
            return;
        }

        const link = typeof matchDiagramValueLink === 'function'
            ? matchDiagramValueLink(trimmed)
            : null;
        if (!link) {
            diagnostics.push(diag('warning', 'Строка не распознана (ожидается A -> B: число)', {
                line: idx + 1,
                code: 'sankey_bad_line',
                hint: 'Пример: Бюджет -> Маркетинг: 40  (также A --> B: число)'
            }));
            return;
        }
        const source = link.from;
        const target = link.to;
        let value = parseFloat(link.valueRaw.replace(',', '.'));
        value = Math.round(value * 100) / 100;
        if (!(value > 0)) {
            diagnostics.push(diag('warning', 'Значение должно быть > 0', {
                line: idx + 1,
                code: 'sankey_non_positive',
                hint: 'Толщина потока — положительное число'
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

    const nodes = Array.from(nodesMap.keys()).map((name, index) => ({
        name,
        index,
        column: nodeColumn.get(name) || null
    }));

    const graph = analyzeDirectedGraph(
        nodes.map((n) => n.name),
        links,
        { allowMissingNodes: false }
    );
    graph.diagnostics.forEach((d) => {
        if (d.code === 'cycle') {
            d.message = 'Sankey поддерживает только DAG (без циклов): ' + d.message.replace(/^Обнаружен цикл зависимостей:\s*/, '');
            d.hint = 'Уберите циклические связи или разбейте поток';
        }
    });
    diagnostics.push(...graph.diagnostics.filter((d) => d.code === 'cycle' || d.code === 'self_loop'));

    if (columns.length) {
        const colSet = new Set(columns);
        nodeColumn.forEach((col, name) => {
            if (!colSet.has(col)) {
                diagnostics.push(diag('warning', `Колонка «${col}» для «${name}» не в списке колонок`, {
                    code: 'sankey_unknown_column',
                    hint: 'Добавьте её в «колонки: …» или исправьте имя'
                }));
            }
        });
    }

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
        if (inn <= 0) return;
        if (out > inn + eps) {
            const lines = outLines.get(n.name) || [];
            const fmt = (v) => (Math.round(v * 100) / 100).toLocaleString('ru-RU');
            diagnostics.push(diag('error',
                `«${n.name}»: сумма выходов (${fmt(out)}) больше входа (${fmt(inn)})`, {
                    line: lines.length ? lines[lines.length - 1] : null,
                    code: 'sankey_balance',
                    hint: 'В классическом Sankey потоки сохраняются: уменьшите исходящие или увеличьте вход'
                }));
        }
    });

    return attachDiagnostics({
        title,
        columns,
        nodes,
        links,
        hasCycle: graph.hasCycle
    }, diagnostics);
}
