/**
 * Парсер Treemap (иерархия отступами, значения у листьев — как в Mermaid treemap).
 *
 * Бюджет
 *     Разработка: 40
 *     Маркетинг
 *         Реклама: 25
 *     Операции: 20
 *
 * Кавычки необязательны. Первая строка treemap / treemap-beta — опциональна.
 */
function parseTreemap(text) {
    const clean = String(text || '')
        .replace(/·/g, ' ')
        .replace(/\t/g, '    ');
    const rawLines = clean.split('\n');
    const diagnostics = [];
    const lines = [];

    rawLines.forEach((l, idx) => {
        const t = l.trim();
        if (typeof isDiagramCommentLine === 'function' ? isDiagramCommentLine(t) : (!t || t.startsWith('#'))) return;
        if (/^treemap(-beta)?\s*$/i.test(t)) return;
        lines.push({ text: l, line: idx + 1 });
    });
    if (!lines.length) return attachDiagnostics(null, diagnostics);

    let title = '';
    if (lines.length) {
        const firstTrim = lines[0].text.trim();
        const titleVal = typeof parseDiagramTitleLine === 'function'
            ? parseDiagramTitleLine(firstTrim)
            : null;
        if (titleVal != null || /^(заголовок|title)\s*:/i.test(firstTrim)) {
            if (titleVal) title = titleVal;
            lines.shift();
        }
    }
    if (!lines.length) return attachDiagnostics(null, diagnostics);

    function parseNameValue(trimmed) {
        let s = trimmed;
        // "Name": 12  или  Name: 12  или  "Name"
        let name = s;
        let value = null;
        const m = s.match(/^(?:"([^"]+)"|(.+?))\s*:\s*([0-9]+(?:[.,][0-9]+)?)\s*$/);
        if (m) {
            name = (m[1] != null ? m[1] : m[2]).trim();
            value = parseFloat(String(m[3]).replace(',', '.'));
            if (!(value > 0)) {
                value = null;
            }
        } else {
            const q = s.match(/^"([^"]+)"\s*$/);
            name = q ? q[1].trim() : s.replace(/^["']|["']$/g, '').trim();
        }
        name = name.replace(/\s+/g, ' ').trim();
        return { name, value };
    }

    const rootStack = []; // { indent, node }
    let root = null;

    lines.forEach((entry) => {
        const lineNo = entry.line;
        const raw = entry.text;
        const trimmed = raw.trim();
        const indent = raw.match(/^[ ]*/)[0].length;
        if (indent % 4 !== 0) {
            diagnostics.push(diag('warning', `Отступ ${indent} пробелов — лучше кратно 4`, {
                line: lineNo,
                code: 'indent_not_multiple',
                hint: 'Используйте Tab или 4 пробела'
            }));
        }
        const { name, value } = parseNameValue(trimmed);
        if (!name) {
            diagnostics.push(diag('warning', 'Пустое имя узла пропущено', {
                line: lineNo,
                code: 'empty_name'
            }));
            return;
        }
        const node = {
            name,
            value: value,
            children: [],
            line: lineNo
        };

        if (!root) {
            root = node;
            rootStack.length = 0;
            rootStack.push({ indent: 0, node: root });
            return;
        }

        while (rootStack.length > 1 && rootStack[rootStack.length - 1].indent >= indent) {
            rootStack.pop();
        }
        const parent = rootStack[rootStack.length - 1].node;
        parent.children.push(node);
        rootStack.push({ indent, node });
    });

    if (!root) return attachDiagnostics(null, diagnostics);

    function finalize(node) {
        if (node.children && node.children.length) {
            node.children.forEach(finalize);
            const sum = node.children.reduce((s, c) => s + (c.value || 0), 0);
            if (node.value != null && Math.abs(node.value - sum) > 1e-6) {
                diagnostics.push(diag('warning',
                    `«${node.name}»: указано ${node.value}, сумма детей ${sum} — берём сумму детей`, {
                        line: node.line || null,
                        code: 'treemap_value_override'
                    }));
            }
            node.value = sum > 0 ? sum : (node.value || 0);
            node.isLeaf = false;
        } else {
            node.isLeaf = true;
            if (!(node.value > 0)) {
                diagnostics.push(diag('warning',
                    `Лист «${node.name}» без значения > 0 — подставлено 1`, {
                        line: node.line || null,
                        code: 'treemap_default_value',
                        hint: 'Укажите «Имя: число»'
                    }));
                node.value = 1;
            }
        }
    }
    finalize(root);

    if (!(root.value > 0)) {
        diagnostics.push(diag('error', 'Нет положительных значений для treemap', {
            code: 'treemap_empty'
        }));
        return attachDiagnostics({ root: null }, diagnostics);
    }

    return attachDiagnostics({ root, title }, diagnostics);
}
