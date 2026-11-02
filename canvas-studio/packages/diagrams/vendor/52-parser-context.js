/**
 * Контекст системы (лёгкий C4 L1).
 *
 * название: Контекст DocPlan
 * система: DocPlan — планы и документы
 * человек: Автор
 * человек: Читатель
 * внешняя: Telegram
 * внешняя: Google Drive
 * Автор -> DocPlan: пишет
 * Читатель -> DocPlan: читает
 * DocPlan -> Telegram: пуш
 * DocPlan -> Google Drive: экспорт
 */
function parseContext(text) {
    const diagnostics = [];
    let title = 'Контекст системы';
    const nodes = new Map();
    const links = [];
    let autoSeq = 0;
    let primarySystem = null;

    function slug(label) {
        return String(label || '')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, '_')
            .replace(/^_|_$/g, '')
            .slice(0, 48) || ('n' + (++autoSeq));
    }

    function splitNameDesc(raw) {
        const s = String(raw || '').trim();
        const m = s.match(/^(.+?)\s*[—–\-:]\s*(.+)$/);
        if (m) return { name: m[1].trim(), desc: m[2].trim() };
        return { name: s, desc: '' };
    }

    function ensureNode(raw, kind, lineNo) {
        const parts = splitNameDesc(raw);
        const name = parts.name;
        if (!name) return null;
        for (const n of nodes.values()) {
            if (n.name === name) {
                if (kind && n.kind === 'system' && kind !== 'system') { /* keep */ }
                else if (kind) n.kind = kind;
                if (parts.desc && !n.desc) n.desc = parts.desc;
                if (lineNo != null && n.line == null) n.line = lineNo;
                return n;
            }
        }
        let id = slug(name);
        if (nodes.has(id)) id = id + '_' + (++autoSeq);
        const node = {
            id,
            name,
            desc: parts.desc || '',
            kind: kind || 'system',
            line: lineNo || null
        };
        nodes.set(id, node);
        if (kind === 'system' && !primarySystem) primarySystem = node;
        return node;
    }

    function findByName(raw) {
        const name = splitNameDesc(raw).name;
        for (const n of nodes.values()) {
            if (n.name === name) return n;
        }
        return null;
    }

    String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach((raw, idx) => {
        const lineNo = idx + 1;
        const trimmed = raw.trim();
        if (typeof isDiagramCommentLine === 'function'
            ? isDiagramCommentLine(trimmed)
            : (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//'))) return;

        if (/^(контекст|context|c4)\s*$/i.test(trimmed)) return;

        const titleVal = typeof parseDiagramTitleLine === 'function'
            ? parseDiagramTitleLine(trimmed)
            : null;
        if (titleVal != null) {
            title = titleVal;
            return;
        }

        const person = trimmed.match(/^(человек|персона|actor|user|роль)\s*:\s*(.+)$/i);
        if (person) {
            ensureNode(person[2], 'person', lineNo);
            return;
        }
        const ext = trimmed.match(/^(внешняя|внешняя система|external|система вне)\s*:\s*(.+)$/i);
        if (ext) {
            ensureNode(ext[2], 'external', lineNo);
            return;
        }
        const sys = trimmed.match(/^(система|system)\s*:\s*(.+)$/i);
        if (sys) {
            const n = ensureNode(sys[2], 'system', lineNo);
            if (n && !primarySystem) primarySystem = n;
            return;
        }

        const edgeM = trimmed.match(/^(.+?)\s*(->|-->)\s*(.+?)(?:\s*:\s*(.*))?$/);
        if (edgeM) {
            const fromRaw = edgeM[1].trim();
            const toRaw = edgeM[3].trim();
            const label = (edgeM[4] != null ? edgeM[4] : '').trim();
            let from = findByName(fromRaw);
            let to = findByName(toRaw);
            if (!from) from = ensureNode(fromRaw, 'person', lineNo);
            if (!to) to = ensureNode(toRaw, primarySystem ? 'external' : 'system', lineNo);
            if (!from || !to) {
                diagnostics.push(diag('warning', 'Не разобрана связь', {
                    line: lineNo, code: 'context_bad_edge'
                }));
                return;
            }
            links.push({ from: from.id, to: to.id, label, line: lineNo });
            return;
        }

        if (trimmed) {
            diagnostics.push(diag('warning', 'Строка не распознана', {
                line: lineNo, code: 'context_bad_line',
                hint: 'система: … · человек: … · внешняя: … · A -> B: описание'
            }));
        }
    });

    const list = Array.from(nodes.values());
    if (!list.length) {
        return attachDiagnostics(null, diagnostics);
    }
    if (!primarySystem) {
        primarySystem = list.find((n) => n.kind === 'system') || list[0];
        if (primarySystem) primarySystem.kind = 'system';
    }

    return attachDiagnostics({
        title,
        nodes: list,
        links,
        primaryId: primarySystem ? primarySystem.id : list[0].id
    }, diagnostics);
}
