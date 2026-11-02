/**
 * Парсер «Карты обратимости».
 *
 * Решение: боль, откат [, факт|гипотеза]
 *   боль  — насколько больно, если решение окажется ошибкой (0–100)
 *   откат — насколько дорого/долго развернуть назад (0–100)
 * A -> B: 3  — «сделали A → откат B примерно в 3 раза дороже»
 * заголовок: …
 *
 * Для совместимости ещё принимаются fact/hyp и старое имя «удар» в справке.
 */
function parseReversibility(text) {
    const diagnostics = [];
    const nodes = [];
    const links = [];
    let title = 'Карта обратимости';
    const byName = new Map();

    function upsertNode(name, patch, line) {
        const key = name.toLowerCase();
        let node = byName.get(key);
        if (!node) {
            node = {
                name,
                impact: 50,
                irreversibility: 50,
                confidence: 'hyp',
                line
            };
            byName.set(key, node);
            nodes.push(node);
        }
        if (patch) Object.assign(node, patch);
        return node;
    }

    String(text || '').split('\n').forEach((raw, idx) => {
        const lineNo = idx + 1;
        const trimmed = raw.trim();
        if (typeof isDiagramCommentLine === 'function' ? isDiagramCommentLine(trimmed) : (!trimmed || trimmed.startsWith('#'))) return;
        if (/^reversibility\s*$/i.test(trimmed)) return;

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
        if (link) {
            const from = link.from;
            const to = link.to;
            let factor = parseFloat(String(link.valueRaw).replace(',', '.'));
            if (!(factor > 0)) {
                diagnostics.push(diag('warning', 'Множитель связи должен быть > 0', {
                    line: lineNo,
                    code: 'rev_bad_factor',
                    hint: 'Пример: Публичный API v1 -> Миграция БД: 3'
                }));
                return;
            }
            if (from === to) {
                diagnostics.push(diag('warning', 'Связь на себя пропущена', {
                    line: lineNo,
                    code: 'self_loop'
                }));
                return;
            }
            upsertNode(from, null, lineNo);
            upsertNode(to, null, lineNo);
            links.push({ from, to, factor, line: lineNo });
            return;
        }

        const nodeMatch = trimmed.match(
            /^(.+?)\s*:\s*([0-9]+(?:[.,][0-9]+)?)\s*,\s*([0-9]+(?:[.,][0-9]+)?)\s*(?:,\s*(факт|гипотеза|fact|hyp))?\s*$/i
        );
        if (nodeMatch) {
            const name = nodeMatch[1].trim();
            let impact = parseFloat(String(nodeMatch[2]).replace(',', '.'));
            let irrev = parseFloat(String(nodeMatch[3]).replace(',', '.'));
            let confRaw = (nodeMatch[4] || 'гипотеза').toLowerCase();
            if (confRaw === 'fact' || confRaw === 'факт') confRaw = 'fact';
            else confRaw = 'hyp';
            const confidence = confRaw === 'fact' ? 'fact' : 'hyp';
            if (!Number.isFinite(impact)) impact = 50;
            if (!Number.isFinite(irrev)) irrev = 50;
            impact = Math.max(0, Math.min(100, impact));
            irrev = Math.max(0, Math.min(100, irrev));
            if (!name) {
                diagnostics.push(diag('warning', 'Пустое имя решения', {
                    line: lineNo,
                    code: 'empty_name'
                }));
                return;
            }
            upsertNode(name, { impact, irreversibility: irrev, confidence, line: lineNo }, lineNo);
            return;
        }

        diagnostics.push(diag('warning', 'Строка не распознана', {
            line: lineNo,
            code: 'rev_bad_line',
            hint: 'Пример: Миграция БД: 85, 90, факт'
        }));
    });

    if (!nodes.length) {
        return attachDiagnostics(null, diagnostics);
    }

    return attachDiagnostics({ title, nodes, links }, diagnostics);
}
