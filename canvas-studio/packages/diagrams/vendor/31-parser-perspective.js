/**
 * Парсер «Диаграммы перспектив».
 *
 * заголовок: …
 * [Роль]
 *   Узел
 *     Дочерний
 * = ИмяA | ИмяB | ИмяC   — одна сущность в разных картинах мира
 */
function parsePerspective(text) {
    const diagnostics = [];
    const perspectives = [];
    const aliases = [];
    let title = 'Диаграмма перспектив';
    let current = null;

    function ensurePerspective(name, line) {
        const key = name.toLowerCase();
        let p = perspectives.find((x) => x.name.toLowerCase() === key);
        if (!p) {
            p = { name, nodes: [], roots: [], line };
            perspectives.push(p);
        }
        return p;
    }

    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const stack = []; // { indent, node } within current perspective

    lines.forEach((raw, idx) => {
        const lineNo = idx + 1;
        const trimmed = raw.trim();
        if (typeof isDiagramCommentLine === 'function' ? isDiagramCommentLine(trimmed) : (!trimmed || trimmed.startsWith('#'))) return;
        if (/^perspective\s*$/i.test(trimmed)) return;

        const titleVal = typeof parseDiagramTitleLine === 'function'
            ? parseDiagramTitleLine(trimmed)
            : null;
        if (titleVal != null || /^(заголовок|title)\s*:/i.test(trimmed)) {
            if (titleVal) title = titleVal;
            return;
        }

        const roleMatch = trimmed.match(/^\[(.+?)\]\s*$/) || trimmed.match(/^роль\s*:\s*(.+)$/i);
        if (roleMatch) {
            current = ensurePerspective(roleMatch[1].trim(), lineNo);
            stack.length = 0;
            return;
        }

        if (trimmed.startsWith('=')) {
            const parts = trimmed.slice(1).split('|').map((s) => s.trim()).filter(Boolean);
            if (parts.length < 2) {
                diagnostics.push(diag('warning', 'В связи нужно ≥2 имени через |', {
                    line: lineNo,
                    code: 'persp_alias_short',
                    hint: 'Пример: = Оплата | Платёжный сервис | Оферта'
                }));
                return;
            }
            aliases.push({ names: parts, line: lineNo });
            return;
        }

        if (!current) {
            diagnostics.push(diag('warning', 'Сначала укажите роль: [Пользователь]', {
                line: lineNo,
                code: 'persp_no_role'
            }));
            return;
        }

        const indent = (raw.match(/^[ \t]*/) || [''])[0].replace(/\t/g, '    ').length;
        const name = trimmed;
        const node = {
            name,
            children: [],
            line: lineNo,
            perspective: current.name
        };

        while (stack.length && stack[stack.length - 1].indent >= indent) {
            stack.pop();
        }
        if (!stack.length) {
            current.roots.push(node);
        } else {
            stack[stack.length - 1].node.children.push(node);
        }
        stack.push({ indent, node });
        current.nodes.push(node);
    });

    if (!perspectives.length) {
        return attachDiagnostics(null, diagnostics);
    }

    return attachDiagnostics({ title, perspectives, aliases }, diagnostics);
}
