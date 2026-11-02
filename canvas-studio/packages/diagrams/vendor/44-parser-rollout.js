/**
 * Парсер «Роллаут»: фазы по оси, карточки задач, роли @Роль.
 *
 * название: Вывод продукта
 * фаза: Реализация
 *   Development Board @Продукт
 *   Обвязка Т2–партнёр @Продукт + Юристы + Партнёр
 *
 * Устаревшее «трек: X» трактуется как ещё одна роль (как @X), не отдельная категория.
 * «!шлюз» / «шлюз» игнорируются.
 */
function parseRollout(text) {
    const diagnostics = [];
    const phases = [];
    let title = 'Роллаут';
    let current = null;
    let lastTask = null;

    function startPhase(name, line) {
        current = {
            name: name || 'Этап',
            tasks: [],
            line
        };
        phases.push(current);
        lastTask = null;
        return current;
    }

    function parseRoles(raw) {
        return String(raw || '')
            .split(/\s*[+,/]\s*|\s+и\s+/i)
            .map((s) => s.trim())
            .filter(Boolean);
    }

    function stripLegacyFlags(s) {
        let rest = String(s || '').trim();
        // бывший !шлюз — просто убираем из текста
        rest = rest.replace(/\s*!(шлюз|gate)\s*$/i, '').trim();
        return rest;
    }

    function addRole(task, role) {
        const r = String(role || '').trim();
        if (!task || !r) return;
        const key = typeof rolloutRoleKey === 'function' ? rolloutRoleKey(r) : r.toLowerCase();
        const exists = (task.roles || []).some((x) => {
            const k = typeof rolloutRoleKey === 'function' ? rolloutRoleKey(x) : String(x).toLowerCase();
            return k === key;
        });
        if (exists) return;
        task.roles.push(r);
        if (!task.lead) task.lead = r;
        task.ownerLabel = task.roles.join(' + ');
    }

    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    lines.forEach((raw, idx) => {
        const lineNo = idx + 1;
        const trimmed = raw.trim();
        if (typeof isDiagramCommentLine === 'function'
            ? isDiagramCommentLine(trimmed)
            : (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//'))) return;
        if (/^(роллаут|rollout)\s*$/i.test(trimmed)) return;

        const titleVal = typeof parseDiagramTitleLine === 'function'
            ? parseDiagramTitleLine(trimmed)
            : null;
        if (titleVal != null || /^(заголовок|title)\s*:/i.test(trimmed)) {
            if (titleVal) title = titleVal;
            else {
                const m = trimmed.match(/^(заголовок|title)\s*:\s*(.*)$/i);
                title = (m ? String(m[2] || '').trim() : '') || title;
            }
            return;
        }

        const phaseM = trimmed.match(/^(фаза|этап|колонка|phase|column)\s*:\s*(.+)$/i);
        if (phaseM) {
            startPhase(stripLegacyFlags(phaseM[2]), lineNo);
            return;
        }

        const indent = (raw.match(/^[ \t]*/) || [''])[0].replace(/\t/g, '    ').length;

        // «трек: партнёр» → роль Партнёр (как остальные участники)
        const trackM = trimmed.match(/^(трек|контур|track)\s*:\s*(.+)$/i);
        if (trackM) {
            if (!lastTask) {
                diagnostics.push(diag('warning', 'Роль из «трек:» должна стоять под задачей', {
                    line: lineNo, code: 'rollout_track_orphan',
                    hint: 'Лучше сразу: задача @Продукт + Партнёр'
                }));
                return;
            }
            addRole(lastTask, trackM[2]);
            return;
        }

        // одиночная строка «шлюз» — игнор
        if (indent >= 2 && /^(шлюз|gate)\s*$/i.test(trimmed)) {
            return;
        }

        if (!current) startPhase('Этап', lineNo);

        let name = stripLegacyFlags(trimmed);
        let roles = [];
        const at = name.lastIndexOf(' @');
        const atStart = name.indexOf('@') === 0 ? 0 : -1;
        if (at >= 0) {
            roles = parseRoles(name.slice(at + 2));
            name = name.slice(0, at).trim();
        } else if (atStart === 0) {
            diagnostics.push(diag('warning', 'Нет названия задачи перед @', {
                line: lineNo, code: 'rollout_empty_task'
            }));
            return;
        }

        const task = {
            name: name || 'Задача',
            roles: roles.slice(),
            lead: roles[0] || '',
            ownerLabel: roles.join(' + '),
            line: lineNo
        };
        current.tasks.push(task);
        lastTask = task;
    });

    if (!phases.length || !phases.some((p) => p.tasks.length)) {
        diagnostics.push(diag('warning', 'Добавьте фазу и хотя бы одну задачу', {
            line: 1, code: 'rollout_empty',
            hint: 'фаза: Подготовка\n  Анализ рынка @Продукт'
        }));
        return attachDiagnostics(null, diagnostics);
    }

    phases.forEach((p) => {
        if (!p.tasks.length) {
            diagnostics.push(diag('warning', `Пустая фаза «${p.name}»`, {
                line: p.line, code: 'rollout_empty_phase'
            }));
        }
    });

    return attachDiagnostics({ title, phases }, diagnostics);
}
