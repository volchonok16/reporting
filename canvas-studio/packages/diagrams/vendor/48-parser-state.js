/**
 * Диаграмма состояний (state machine).
 *
 * название: Статус заявки
 * [*] -> Черновик
 * Черновик -> На проверке: отправить
 * На проверке -> Утверждена: ок
 * На проверке -> Черновик: правки
 * Утверждена -> [*]
 * состояние: Архив
 *
 * Старт/финиш: [*] | старт | конец | начало | финиш
 * Переход: A -> B: событие
 */
function parseState(text) {
    const diagnostics = [];
    let title = 'Состояния';
    const states = new Map();
    const transitions = [];
    let autoSeq = 0;

    function slug(label) {
        return String(label || '')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, '_')
            .replace(/^_|_$/g, '')
            .slice(0, 48) || ('s' + (++autoSeq));
    }

    function terminalRole(raw) {
        const t = String(raw || '').trim();
        if (t === '[*]' || t === '(*)' || t === '*') return 'star';
        if (/^(старт|начало|start)$/i.test(t)) return 'initial';
        if (/^(конец|финиш|end)$/i.test(t)) return 'final';
        return null;
    }

    function ensureInitial(lineNo) {
        const id = '__initial__';
        if (!states.has(id)) {
            states.set(id, { id, label: '●', kind: 'initial', line: lineNo || null });
        } else if (lineNo != null && states.get(id).line == null) {
            states.get(id).line = lineNo;
        }
        return states.get(id);
    }

    function ensureFinal(lineNo) {
        const id = '__final__';
        if (!states.has(id)) {
            states.set(id, { id, label: '◉', kind: 'final', line: lineNo || null });
        } else if (lineNo != null && states.get(id).line == null) {
            states.get(id).line = lineNo;
        }
        return states.get(id);
    }

    function ensureState(raw, lineNo, edgeSide) {
        const label = String(raw || '').trim();
        if (!label) return null;
        const role = terminalRole(label);
        if (role === 'initial') return ensureInitial(lineNo);
        if (role === 'final') return ensureFinal(lineNo);
        if (role === 'star') {
            // [*] слева = старт, справа = финиш (как в Mermaid)
            return edgeSide === 'to' ? ensureFinal(lineNo) : ensureInitial(lineNo);
        }

        for (const s of states.values()) {
            if (s.kind === 'normal' && s.label === label) {
                if (lineNo != null && s.line == null) s.line = lineNo;
                return s;
            }
        }
        let id = slug(label);
        if (states.has(id)) id = id + '_' + (++autoSeq);
        const node = { id, label, kind: 'normal', line: lineNo || null };
        states.set(id, node);
        return node;
    }

    String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach((raw, idx) => {
        const lineNo = idx + 1;
        const trimmed = raw.trim();
        if (typeof isDiagramCommentLine === 'function'
            ? isDiagramCommentLine(trimmed)
            : (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//'))) return;

        if (/^(состояния|state|statemachine|fsm)\s*$/i.test(trimmed)) return;

        const titleVal = typeof parseDiagramTitleLine === 'function'
            ? parseDiagramTitleLine(trimmed)
            : null;
        if (titleVal != null) {
            title = titleVal;
            return;
        }

        const decl = trimmed.match(/^(состояние|state)\s*:\s*(.+)$/i);
        if (decl) {
            ensureState(decl[2].trim(), lineNo, null);
            return;
        }

        const edgeM = trimmed.match(/^(.+?)\s*(->|-->)\s*(.+?)(?:\s*:\s*(.*))?$/);
        if (edgeM) {
            const fromRaw = edgeM[1].trim();
            const toRaw = edgeM[3].trim();
            const label = (edgeM[4] != null ? edgeM[4] : '').trim();
            const from = ensureState(fromRaw, lineNo, 'from');
            const to = ensureState(toRaw, lineNo, 'to');
            if (!from || !to) {
                diagnostics.push(diag('warning', 'Не разобран переход', {
                    line: lineNo, code: 'state_bad_edge',
                    hint: 'Черновик -> Готово: событие'
                }));
                return;
            }
            transitions.push({
                from: from.id,
                to: to.id,
                label,
                line: lineNo
            });
            return;
        }

        if (trimmed) {
            diagnostics.push(diag('warning', 'Строка не распознана', {
                line: lineNo, code: 'state_bad_line',
                hint: 'состояние: Имя · или A -> B: событие · [*] для старта/финиша'
            }));
        }
    });

    const list = Array.from(states.values());
    if (!list.length) {
        return attachDiagnostics(null, diagnostics);
    }

    return attachDiagnostics({
        title,
        states: list,
        transitions
    }, diagnostics);
}
