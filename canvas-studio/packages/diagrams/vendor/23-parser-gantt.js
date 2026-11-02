/**
 * Парсер диаграммы Ганта с поддержкой многострочных атрибутов (отступ 4 пробела).
 * Типы связей FS/SS/FF/SF + лаг, рабочий календарь, baseline, масштаб, ответственный.
 */
function parseGantt(text) {
    const lines = text.split('\n');
    if (lines.length === 0) return null;

    let projectTitle = '';
    let projectStartDate = null;
    let calendarMode = 'work'; // work | all
    let holidays = [];
    let scaleMode = 'auto'; // auto | day | week | month
    const sections = [];
    let currentSection = null;
    let currentTask = null;
    const earlyDiagnostics = [];

    const ATTR_KEYS = [
        'длительность', 'длится', 'после', 'потом', 'начало', 'завершение',
        'комментарий', 'примечание', 'прогресс',
        'базовый-старт', 'базовое-завершение', 'план-начало', 'план-конец',
        'ответственный', 'ресурс',
        'одновременно с', 'вместе с', 'закончить с'
    ];

    const ATTR_CANON = {
        'длится': 'длительность',
        'примечание': 'комментарий',
        'потом': 'после',
        'одновременно с': '_ss',
        'вместе с': '_ss',
        'закончить с': '_ff'
    };

    function canonAttrKey(kw) {
        const k = String(kw || '').toLowerCase();
        return ATTR_CANON[k] || k;
    }

    function parseDuration(str) {
        str = String(str).trim();
        const match = str.match(/^([\d.]+)\s*([днм])$/i);
        if (!match) return null;
        const value = parseFloat(match[1]);
        const unit = match[2].toLowerCase();
        let days = 0;
        if (unit === 'д') days = value;
        else if (unit === 'н') days = value * 7;
        else if (unit === 'м') days = value * 30;
        return Math.round(days);
    }

    function parseDate(str) {
        const parts = String(str).trim().split('-');
        if (parts.length !== 3) return null;
        const year = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10) - 1;
        const day = parseInt(parts[2], 10);
        if (isNaN(year) || isNaN(month) || isNaN(day)) return null;
        if (month < 0 || month > 11 || day < 1 || day > 31) return null;
        const date = new Date(year, month, day);
        if (
            isNaN(date.getTime()) ||
            date.getFullYear() !== year ||
            date.getMonth() !== month ||
            date.getDate() !== day
        ) {
            return null;
        }
        date.setHours(0, 0, 0, 0);
        return date;
    }

    function parseProgress(str) {
        const m = String(str).trim().match(/^(\d{1,3})\s*%?$/);
        if (!m) return null;
        return Math.max(0, Math.min(100, parseInt(m[1], 10)));
    }

    /** «Анализ FS+2д» | «Макет (начало-начало)» | «Опрос (через 2 дня)» | «Презентация (за 1 день до окончания)» */
    function parseLagPhrase(text) {
        const s = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
        let lagDays = 0;
        const through = s.match(/через\s+(\d+(?:\.\d+)?)\s*(д(?:ень|ня|ней)?|н(?:едел[яиюь])?|м(?:есяц(?:а|ев)?)?)?/i);
        if (through) {
            let d = parseFloat(through[1]);
            const u = (through[2] || 'д').charAt(0).toLowerCase();
            if (u === 'н') d *= 7;
            if (u === 'м') d *= 30;
            lagDays = Math.round(d);
        }
        const before = s.match(/за\s+(\d+(?:\.\d+)?)\s*(д(?:ень|ня|ней)?|н(?:едел[яиюь])?|м(?:есяц(?:а|ев)?)?)?\s*до/i);
        if (before) {
            let d = parseFloat(before[1]);
            const u = (before[2] || 'д').charAt(0).toLowerCase();
            if (u === 'н') d *= 7;
            if (u === 'м') d *= 30;
            lagDays = -Math.round(d);
        }
        return lagDays;
    }

    function parseLinkTypeRu(text) {
        const s = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
        if (/начало\s*[-–—]?\s*начало|одновремен/i.test(s)) return 'SS';
        if (/окончание\s*[-–—]?\s*окончание|финиш\s*[-–—]?\s*финиш/i.test(s)) return 'FF';
        if (/начало\s*[-–—]?\s*окончание|старт\s*[-–—]?\s*финиш/i.test(s)) return 'SF';
        if (/окончание\s*[-–—]?\s*начало|финиш\s*[-–—]?\s*старт/i.test(s)) return 'FS';
        if (/^(FS|SS|FF|SF)$/i.test(s)) return s.toUpperCase();
        return null;
    }

    function parseDepToken(raw) {
        const s = String(raw || '').trim();
        if (!s) return null;

        // «Анализ (через 2 дня)» / «Макет (начало-начало)» / «Анализ (окончание-начало, через 2 дня)»
        const paren = s.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
        if (paren && paren[1].trim()) {
            const name = paren[1].trim();
            const inside = paren[2];
            let type = parseLinkTypeRu(inside) || 'FS';
            const lagDays = parseLagPhrase(inside);
            return { name, type, lagDays };
        }

        const m = s.match(/^(.*?)(?:\s+(FS|SS|FF|SF))?(?:\s*([+\−\-]\s*\d+(?:\.\d+)?)\s*([днм])?)?\s*$/i);
        if (!m) return { name: s, type: 'FS', lagDays: 0 };
        let name = (m[1] || '').trim();
        const glued = name.match(/^(.*?)(FS|SS|FF|SF)([+\−\-]?\d+(?:\.\d+)?[днм]?)?$/i);
        let type = (m[2] || 'FS').toUpperCase();
        let lagDays = 0;
        if (glued && !m[2]) {
            name = glued[1].trim();
            type = glued[2].toUpperCase();
            if (glued[3]) {
                const lm = glued[3].match(/^([+\−\-])?\s*([\d.]+)\s*([днм])?$/i);
                if (lm) {
                    const sign = (lm[1] || '+').replace('−', '-') === '-' ? -1 : 1;
                    let d = parseFloat(lm[2]);
                    const u = (lm[3] || 'д').toLowerCase();
                    if (u === 'н') d *= 7;
                    if (u === 'м') d *= 30;
                    lagDays = Math.round(sign * d);
                }
            }
        } else if (m[3]) {
            const sign = m[3].replace(/\s/g, '').replace('−', '-').startsWith('-') ? -1 : 1;
            let d = parseFloat(String(m[3]).replace(/[+\−\-]/g, '').trim());
            const u = (m[4] || 'д').toLowerCase();
            if (u === 'н') d *= 7;
            if (u === 'м') d *= 30;
            lagDays = Math.round(sign * d);
        }
        if (!name) return null;
        if (!/^(FS|SS|FF|SF)$/.test(type)) type = 'FS';
        return { name, type, lagDays };
    }

    function extractAttributes(line) {
        const attrs = {};
        const lower = line.toLowerCase();
        // Длинные ключи первыми («одновременно с» раньше «с»)
        const keysSorted = ATTR_KEYS.slice().sort((a, b) => b.length - a.length);
        keysSorted.forEach(kw => {
            const idx = lower.indexOf(kw + ':');
            if (idx === -1) return;
            // не матчить середину другого слова
            if (idx > 0 && /[а-яёa-z0-9-]/i.test(lower[idx - 1])) return;
            const valueStart = idx + kw.length + 1;
            let valueEnd = line.length;
            keysSorted.forEach(other => {
                if (other === kw) return;
                const re = new RegExp('\\s' + other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:', 'i');
                const rest = line.slice(valueStart);
                const m = rest.match(re);
                if (m && m.index !== undefined) {
                    valueEnd = Math.min(valueEnd, valueStart + m.index);
                }
            });
            const canon = canonAttrKey(kw);
            attrs[canon] = line.slice(valueStart, valueEnd).trim();
        });
        return attrs;
    }

    function stripInlineAttrs(namePart) {
        let cut = namePart.length;
        ATTR_KEYS.forEach(kw => {
            const re = new RegExp('\\s+' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:', 'i');
            const m = namePart.match(re);
            if (m && m.index !== undefined && m.index < cut) cut = m.index;
        });
        // снять @ответственный из хвоста имени
        const at = namePart.slice(0, cut).match(/^(.*?)(?:\s+@\S+)\s*$/);
        if (at) return at[1].trim();
        return namePart.slice(0, cut).trim();
    }

    function extractAssigneeFromName(raw) {
        const m = String(raw || '').match(/@([^\s,;]+)/);
        return m ? m[1] : null;
    }

    function applyAttributes(task, attrs, lineNo) {
        if (attrs.длительность) {
            const d = parseDuration(attrs.длительность);
            if (d !== null) {
                task.duration = d;
                if (d === 0) task.isMilestone = true;
            } else {
                earlyDiagnostics.push(diag('warning', `Некорректная длительность «${attrs.длительность}»`, {
                    line: lineNo || null,
                    code: 'gantt_bad_duration',
                    hint: 'Пример: 5д, 2н, 1м (0д = веха)'
                }));
            }
        }
        if (attrs.после) {
            const tokens = [];
            let buf = '';
            let depth = 0;
            for (const ch of String(attrs.после)) {
                if (ch === '(') depth++;
                if (ch === ')') depth = Math.max(0, depth - 1);
                if ((ch === ',' || ch === ';') && depth === 0) {
                    if (buf.trim()) tokens.push(buf.trim());
                    buf = '';
                    continue;
                }
                buf += ch;
            }
            if (buf.trim()) tokens.push(buf.trim());
            task.deps = tokens.map(parseDepToken).filter(Boolean);
            task.afterList = task.deps.map(d => d.name);
            task.after = task.afterList[0] || null;
        }
        if (attrs._ss) {
            const dep = { name: attrs._ss.trim(), type: 'SS', lagDays: 0 };
            task.deps = (task.deps || []).concat([dep]);
            task.afterList = task.deps.map(d => d.name);
            task.after = task.afterList[0] || null;
        }
        if (attrs._ff) {
            const dep = { name: attrs._ff.trim(), type: 'FF', lagDays: 0 };
            task.deps = (task.deps || []).concat([dep]);
            task.afterList = task.deps.map(d => d.name);
            task.after = task.afterList[0] || null;
        }
        if (attrs.начало) {
            const d = parseDate(attrs.начало);
            if (d) task.startDate = d;
            else {
                earlyDiagnostics.push(diag('warning', `Некорректная дата начала «${attrs.начало}»`, {
                    line: lineNo || null,
                    code: 'gantt_bad_start',
                    hint: 'Формат ГГГГ-ММ-ДД'
                }));
            }
        }
        if (attrs.завершение) {
            const d = parseDate(attrs.завершение);
            if (d) task.endDate = d;
            else {
                earlyDiagnostics.push(diag('warning', `Некорректная дата завершения «${attrs.завершение}»`, {
                    line: lineNo || null,
                    code: 'gantt_bad_end',
                    hint: 'Формат ГГГГ-ММ-ДД'
                }));
            }
        }
        const blStart = attrs['базовый-старт'] || attrs['план-начало'];
        const blEnd = attrs['базовое-завершение'] || attrs['план-конец'];
        if (blStart) {
            const d = parseDate(blStart);
            if (d) task.baselineStart = d;
            else {
                earlyDiagnostics.push(diag('warning', `Некорректный базовый-старт «${blStart}»`, {
                    line: lineNo || null, code: 'gantt_bad_baseline'
                }));
            }
        }
        if (blEnd) {
            const d = parseDate(blEnd);
            if (d) task.baselineEnd = d;
            else {
                earlyDiagnostics.push(diag('warning', `Некорректное базовое-завершение «${blEnd}»`, {
                    line: lineNo || null, code: 'gantt_bad_baseline'
                }));
            }
        }
        if (attrs.комментарий) task.comment = attrs.комментарий;
        if (attrs.прогресс != null) {
            const p = parseProgress(attrs.прогресс);
            if (p !== null) task.progress = p;
            else {
                earlyDiagnostics.push(diag('warning', `Некорректный прогресс «${attrs.прогресс}»`, {
                    line: lineNo || null,
                    code: 'gantt_bad_progress',
                    hint: 'Число 0–100 или с %'
                }));
            }
        }
        const who = attrs.ответственный || attrs.ресурс;
        if (who) task.assignee = who;
    }

    function makeTask(name, extra = {}) {
        return {
            name,
            duration: 1,
            after: null,
            afterList: [],
            deps: [],
            startDate: null,
            endDate: null,
            baselineStart: null,
            baselineEnd: null,
            comment: null,
            progress: null,
            assignee: null,
            isMilestone: false,
            isCritical: false,
            computedStart: null,
            computedEnd: null,
            ...extra
        };
    }

    function isWorkDay(d) {
        if (calendarMode === 'all') return true;
        const wd = d.getDay();
        if (wd === 0 || wd === 6) return false;
        const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        return !holidays.some((h) => {
            const hk = h.getFullYear() + '-' + String(h.getMonth() + 1).padStart(2, '0') + '-' + String(h.getDate()).padStart(2, '0');
            return hk === key;
        });
    }

    function addCalendarDays(date, delta) {
        const d = new Date(date);
        d.setDate(d.getDate() + delta);
        return d;
    }

    function nextWorkDay(date) {
        const d = new Date(date);
        let guard = 0;
        while (!isWorkDay(d) && guard++ < 4000) d.setDate(d.getDate() + 1);
        return d;
    }

    function prevWorkDay(date) {
        const d = new Date(date);
        let guard = 0;
        while (!isWorkDay(d) && guard++ < 4000) d.setDate(d.getDate() - 1);
        return d;
    }

    /** сдвиг на N рабочих дней (lag); 0 = тот же день (если рабочий) */
    function shiftWorkDays(date, lagDays) {
        if (!lagDays) return new Date(date);
        const d = new Date(date);
        const step = lagDays > 0 ? 1 : -1;
        let left = Math.abs(lagDays);
        let guard = 0;
        while (left > 0 && guard++ < 8000) {
            d.setDate(d.getDate() + step);
            if (isWorkDay(d)) left--;
        }
        return d;
    }

    /** длительность в рабочих днях: start..end включительно */
    function endFromStartAndDuration(start, durationDays) {
        if (durationDays <= 0) return new Date(start);
        let d = nextWorkDay(new Date(start));
        let left = Math.max(durationDays, 1) - 1;
        let guard = 0;
        while (left > 0 && guard++ < 8000) {
            d.setDate(d.getDate() + 1);
            if (isWorkDay(d)) left--;
        }
        return d;
    }

    function startFromEndAndDuration(end, durationDays) {
        if (durationDays <= 0) return new Date(end);
        let d = prevWorkDay(new Date(end));
        let left = Math.max(durationDays, 1) - 1;
        let guard = 0;
        while (left > 0 && guard++ < 8000) {
            d.setDate(d.getDate() - 1);
            if (isWorkDay(d)) left--;
        }
        return d;
    }

    function countWorkDaysInclusive(a, b) {
        if (b < a) return 0;
        let n = 0;
        const d = new Date(a);
        let guard = 0;
        while (d.getTime() <= b.getTime() && guard++ < 8000) {
            if (isWorkDay(d)) n++;
            d.setDate(d.getDate() + 1);
        }
        return n;
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (typeof isDiagramCommentLine === 'function' ? isDiagramCommentLine(trimmed) : (trimmed === '' || trimmed.startsWith('#'))) continue;

        const indent = line.match(/^[ ]*/)[0].length;

        if (indent >= 4 && currentTask) {
            const throughAfter = trimmed.match(/^через\s+(\d+(?:\.\d+)?)\s*(д(?:ень|ня|ней)?|н(?:едел[яиюь])?|м(?:есяц(?:а|ев)?)?)?\s+после:\s*(.+)$/i);
            if (throughAfter) {
                let d = parseFloat(throughAfter[1]);
                const u = (throughAfter[2] || 'д').charAt(0).toLowerCase();
                if (u === 'н') d *= 7;
                if (u === 'м') d *= 30;
                const dep = parseDepToken(throughAfter[3].trim()) || { name: throughAfter[3].trim(), type: 'FS', lagDays: 0 };
                dep.type = dep.type || 'FS';
                dep.lagDays = Math.round(d);
                currentTask.deps = (currentTask.deps || []).concat([dep]);
                currentTask.afterList = currentTask.deps.map((x) => x.name);
                currentTask.after = currentTask.afterList[0] || null;
                continue;
            }
            applyAttributes(currentTask, extractAttributes(trimmed), i + 1);
            continue;
        }

        const lower = trimmed.toLowerCase();

        const titleVal = typeof parseDiagramTitleLine === 'function'
            ? parseDiagramTitleLine(trimmed, ['заголовок', 'title', 'название', 'name'])
            : null;
        if (titleVal != null || lower.startsWith('заголовок:') || lower.startsWith('title:') || lower.startsWith('название:') || lower.startsWith('name:')) {
            projectTitle = titleVal || trimmed.substring(trimmed.indexOf(':') + 1).trim();
            continue;
        }

        if (lower.startsWith('дата-начала:') || lower.startsWith('старт:')) {
            const raw = trimmed.substring(trimmed.indexOf(':') + 1).trim();
            const d = parseDate(raw);
            if (d) projectStartDate = d;
            else {
                earlyDiagnostics.push(diag('warning', `Некорректная дата старта «${raw}»`, {
                    line: i + 1,
                    code: 'gantt_bad_project_start',
                    hint: 'Формат ГГГГ-ММ-ДД'
                }));
            }
            continue;
        }

        if (lower.startsWith('календарь:')) {
            const v = trimmed.substring(trimmed.indexOf(':') + 1).trim().toLowerCase();
            if (/^(все(\s*дни)?|all|календарн)/i.test(v)) calendarMode = 'all';
            else calendarMode = 'work'; // рабочие / будни
            continue;
        }

        if (lower.startsWith('праздники:') || lower.startsWith('нерабочие:')) {
            const raw = trimmed.substring(trimmed.indexOf(':') + 1).trim();
            raw.split(/[,;]/).map(s => s.trim()).filter(Boolean).forEach((p) => {
                const d = parseDate(p);
                if (d) holidays.push(d);
                else {
                    earlyDiagnostics.push(diag('warning', `Некорректный нерабочий день «${p}»`, {
                        line: i + 1, code: 'gantt_bad_holiday'
                    }));
                }
            });
            continue;
        }

        if (lower.startsWith('масштаб:') || lower.startsWith('шаг:')) {
            const v = trimmed.substring(trimmed.indexOf(':') + 1).trim().toLowerCase();
            if (/^ден/.test(v) || v === 'day') scaleMode = 'day';
            else if (/^нед/.test(v) || v === 'week') scaleMode = 'week';
            else if (/^мес/.test(v) || v === 'month') scaleMode = 'month';
            else scaleMode = 'auto';
            continue;
        }

        if (lower.startsWith('раздел:')) {
            const sectionName = trimmed.substring(trimmed.indexOf(':') + 1).trim();
            currentSection = { name: sectionName, tasks: [] };
            sections.push(currentSection);
            currentTask = null;
            continue;
        }

        if (lower.startsWith('веха:')) {
            const rawName = trimmed.substring(trimmed.indexOf(':') + 1).trim();
            const assigneeInline = extractAssigneeFromName(rawName);
            const name = stripInlineAttrs(rawName) || rawName;
            const task = makeTask(name, { duration: 0, isMilestone: true, assignee: assigneeInline, sourceLine: i + 1 });
            if (!currentSection) {
                currentSection = { name: 'Задачи', tasks: [] };
                sections.push(currentSection);
            }
            currentSection.tasks.push(task);
            currentTask = task;
            applyAttributes(task, extractAttributes(trimmed), i + 1);
            task.isMilestone = true;
            task.duration = 0;
            continue;
        }

        if (lower.startsWith('задача:')) {
            const rawName = trimmed.substring(trimmed.indexOf(':') + 1).trim();
            const assigneeInline = extractAssigneeFromName(rawName);
            const name = stripInlineAttrs(rawName) || rawName;
            const task = makeTask(name, { assignee: assigneeInline, sourceLine: i + 1 });
            if (!currentSection) {
                currentSection = { name: 'Задачи', tasks: [] };
                sections.push(currentSection);
            }
            currentSection.tasks.push(task);
            currentTask = task;
            applyAttributes(task, extractAttributes(trimmed), i + 1);
            continue;
        }

        earlyDiagnostics.push(diag('warning', 'Строка не распознана', {
            line: i + 1,
            code: 'gantt_bad_line',
            hint: 'Ожидается название:/раздел:/задача:/веха: или атрибут с отступом'
        }));
        currentTask = null;
    }

    if (!projectTitle) projectTitle = 'Диаграмма Ганта';
    if (!projectStartDate) {
        projectStartDate = new Date();
        projectStartDate.setHours(0, 0, 0, 0);
    }

    const taskMap = {};
    const allTasks = [];
    sections.forEach(section => {
        section.tasks.forEach(task => {
            let key = task.name;
            let counter = 1;
            while (taskMap[key]) {
                key = task.name + ' (' + counter + ')';
                counter++;
            }
            taskMap[key] = task;
            task._key = key;
            allTasks.push(task);
        });
    });

    allTasks.forEach(task => {
        let start = task.startDate ? new Date(task.startDate) : null;
        let end = task.endDate ? new Date(task.endDate) : null;
        if (start && isNaN(start.getTime())) start = null;
        if (end && isNaN(end.getTime())) end = null;

        if (task.isMilestone || task.duration === 0) {
            task.isMilestone = true;
            task.duration = 0;
            if (!start && end) start = new Date(end);
            if (!start) start = nextWorkDay(new Date(projectStartDate));
            else start = nextWorkDay(start);
            end = new Date(start);
            task.computedStart = start;
            task.computedEnd = end;
            return;
        }

        if (start && end) {
            start = nextWorkDay(start);
            end = prevWorkDay(end);
            if (end < start) end = new Date(start);
            const d = countWorkDaysInclusive(start, end);
            if (d > 0) task.duration = d;
        } else if (end && !start) {
            end = prevWorkDay(end);
            start = startFromEndAndDuration(end, Math.max(task.duration, 1));
        } else if (start && !end) {
            start = nextWorkDay(start);
            end = endFromStartAndDuration(start, Math.max(task.duration, 1));
        } else {
            start = nextWorkDay(new Date(projectStartDate));
            end = endFromStartAndDuration(start, Math.max(task.duration, 1));
        }

        task.computedStart = start;
        task.computedEnd = end;
    });

    const diagnostics = [...earlyDiagnostics];
    const depEdges = [];
    allTasks.forEach((task) => {
        const deps = (task.deps && task.deps.length)
            ? task.deps
            : ((task.afterList && task.afterList.length)
                ? task.afterList.map((n) => ({ name: n, type: 'FS', lagDays: 0 }))
                : (task.after ? [{ name: task.after, type: 'FS', lagDays: 0 }] : []));
        task.deps = deps;
        deps.forEach((dep) => {
            depEdges.push({ from: dep.name, to: task.name, type: dep.type, lagDays: dep.lagDays });
            if (!taskMap[dep.name]) {
                diagnostics.push(diag('error', `Неизвестная зависимость «${dep.name}» у задачи «${task.name}»`, {
                    code: 'gantt_unresolved_dep',
                    hint: 'Имя в «после:» должно совпадать с задачей'
                }));
            }
        });
    });

    const nameCounts = new Map();
    allTasks.forEach((t) => nameCounts.set(t.name, (nameCounts.get(t.name) || 0) + 1));
    nameCounts.forEach((count, name) => {
        if (count > 1) {
            diagnostics.push(diag('warning', `Дублируется имя задачи «${name}»`, {
                code: 'gantt_duplicate_task',
                hint: 'Зависимости «после:» могут ссылаться неоднозначно'
            }));
        }
    });

    const graph = analyzeDirectedGraph(
        allTasks.map((t) => t.name),
        depEdges.map((e) => ({ from: e.from, to: e.to })),
        { allowMissingNodes: true }
    );
    diagnostics.push(...graph.diagnostics.filter((d) => d.code === 'cycle' || d.code === 'self_loop'));

    function earliestFromDep(dep, parent) {
        // после предшественника + лаг → дата, с которой может начаться/закончиться текущая
        const pS = parent.computedStart;
        const pE = parent.computedEnd;
        if (!pS || !pE) return null;
        const type = (dep.type || 'FS').toUpperCase();
        let anchor;
        if (type === 'SS') {
            // start-to-start: текущий старт >= parent.start + lag
            anchor = shiftWorkDays(pS, dep.lagDays || 0);
            return { kind: 'start', date: nextWorkDay(anchor) };
        }
        if (type === 'FF') {
            // finish-to-finish: текущий конец >= parent.end + lag
            anchor = shiftWorkDays(pE, dep.lagDays || 0);
            return { kind: 'end', date: prevWorkDay(anchor) };
        }
        if (type === 'SF') {
            // start-to-finish: текущий конец >= parent.start + lag
            anchor = shiftWorkDays(pS, dep.lagDays || 0);
            return { kind: 'end', date: prevWorkDay(anchor) };
        }
        // FS: старт на следующий рабочий день после конца + lag
        // lag +0: день после finish; lag +2: ещё 2 рабочих
        let afterFinish = addCalendarDays(pE, 1);
        afterFinish = nextWorkDay(afterFinish);
        if (dep.lagDays) afterFinish = shiftWorkDays(afterFinish, dep.lagDays);
        return { kind: 'start', date: nextWorkDay(afterFinish) };
    }

    if (!graph.hasCycle) {
        const maxIter = allTasks.length + 4;
        let changed = true;
        let iter = 0;
        while (changed && iter < maxIter) {
            changed = false;
            iter++;
            allTasks.forEach(task => {
                if (task.startDate) return; // явная дата начала важнее
                const deps = task.deps || [];
                if (!deps.length) return;

                let reqStart = null;
                let reqEnd = null;
                deps.forEach((dep) => {
                    const parent = taskMap[dep.name];
                    if (!parent || !parent.computedEnd) return;
                    const r = earliestFromDep(dep, parent);
                    if (!r) return;
                    if (r.kind === 'start') {
                        if (!reqStart || r.date > reqStart) reqStart = r.date;
                    } else {
                        if (!reqEnd || r.date > reqEnd) reqEnd = r.date;
                    }
                });

                if (!reqStart && !reqEnd) return;

                let newStart = task.computedStart;
                let newEnd = task.computedEnd;

                if (task.isMilestone) {
                    const cand = reqStart || reqEnd;
                    if (cand && cand.getTime() !== task.computedStart.getTime()) {
                        task.computedStart = new Date(cand);
                        task.computedEnd = new Date(cand);
                        changed = true;
                    }
                    return;
                }

                if (reqStart) {
                    newStart = nextWorkDay(reqStart);
                    newEnd = endFromStartAndDuration(newStart, Math.max(task.duration, 1));
                }
                if (reqEnd) {
                    // нужно закончить не раньше reqEnd
                    if (!newEnd || newEnd < reqEnd) {
                        newEnd = prevWorkDay(reqEnd);
                        newStart = startFromEndAndDuration(newEnd, Math.max(task.duration, 1));
                    }
                }
                // если оба ограничения — берём более позднее начало
                if (reqStart && reqEnd) {
                    const fromStart = nextWorkDay(reqStart);
                    const endFromS = endFromStartAndDuration(fromStart, Math.max(task.duration, 1));
                    if (endFromS >= reqEnd) {
                        newStart = fromStart;
                        newEnd = endFromS;
                    } else {
                        newEnd = prevWorkDay(reqEnd);
                        newStart = startFromEndAndDuration(newEnd, Math.max(task.duration, 1));
                        if (newStart < fromStart) {
                            newStart = fromStart;
                            newEnd = endFromStartAndDuration(newStart, Math.max(task.duration, 1));
                        }
                    }
                }

                if (
                    newStart && newEnd &&
                    (newStart.getTime() !== task.computedStart.getTime() ||
                        newEnd.getTime() !== task.computedEnd.getTime())
                ) {
                    task.computedStart = newStart;
                    task.computedEnd = newEnd;
                    changed = true;
                }
            });
        }
    } else {
        diagnostics.push(diag('error', 'Расписание по зависимостям не пересчитано из‑за цикла — даты ненадёжны', {
            code: 'gantt_cycle',
            hint: 'Исправьте цикл зависимостей; пока бары помечены как «дата не вычислена»'
        }));
        allTasks.forEach((task) => {
            task.scheduleInvalid = true;
        });
    }

    allTasks.forEach(task => {
        if (task.scheduleInvalid) {
            // не подставляем «нормальный» старт проекта без метки
            if (!task.computedStart || isNaN(task.computedStart.getTime())) {
                task.computedStart = nextWorkDay(new Date(projectStartDate));
            }
            if (!task.computedEnd || isNaN(task.computedEnd.getTime())) {
                task.computedEnd = new Date(task.computedStart);
                if (!task.isMilestone) {
                    task.computedEnd = endFromStartAndDuration(task.computedStart, Math.max(task.duration, 1));
                }
            }
            return;
        }
        if (!task.computedStart || isNaN(task.computedStart.getTime())) {
            task.computedStart = nextWorkDay(new Date(projectStartDate));
        }
        if (!task.computedEnd || isNaN(task.computedEnd.getTime())) {
            task.computedEnd = new Date(task.computedStart);
            if (!task.isMilestone) {
                task.computedEnd = endFromStartAndDuration(task.computedStart, Math.max(task.duration, 1));
            }
        }
        if (task.baselineStart && !task.baselineEnd && !task.isMilestone) {
            task.baselineEnd = endFromStartAndDuration(task.baselineStart, Math.max(task.duration, 1));
        }
        if (task.baselineEnd && !task.baselineStart) {
            task.baselineStart = task.isMilestone
                ? new Date(task.baselineEnd)
                : startFromEndAndDuration(task.baselineEnd, Math.max(task.duration, 1));
        }
    });

    // Critical path: самый длинный путь по рабочим дням (сумма span задач)
    let projectEnd = projectStartDate;
    allTasks.forEach((t) => {
        if (t.computedEnd && t.computedEnd > projectEnd) projectEnd = t.computedEnd;
    });

    function taskSpan(t) {
        if (!t || !t.computedStart || !t.computedEnd) return 0;
        if (t.isMilestone) return 0;
        return countWorkDaysInclusive(t.computedStart, t.computedEnd);
    }

    const parentsOf = new Map();
    allTasks.forEach((t) => parentsOf.set(t.name, []));
    depEdges.forEach((e) => {
        if (parentsOf.has(e.to) && taskMap[e.from]) {
            parentsOf.get(e.to).push(e.from);
        }
    });

    const bestTo = new Map();
    const predOnBest = new Map();
    const visiting = new Set();

    function longestTo(name) {
        if (bestTo.has(name)) return bestTo.get(name);
        if (visiting.has(name)) return 0;
        visiting.add(name);
        const t = taskMap[name];
        const span = taskSpan(t);
        let best = span;
        let bestPred = null;
        (parentsOf.get(name) || []).forEach((pname) => {
            const via = longestTo(pname) + span;
            if (via > best) {
                best = via;
                bestPred = pname;
            }
        });
        visiting.delete(name);
        bestTo.set(name, best);
        if (bestPred) predOnBest.set(name, bestPred);
        return best;
    }

    allTasks.forEach((t) => longestTo(t.name));

    let critEndName = null;
    let critBest = -1;
    allTasks.forEach((t) => {
        const v = bestTo.get(t.name) || 0;
        const atEnd = t.computedEnd && t.computedEnd.getTime() === projectEnd.getTime();
        if (atEnd && v >= critBest) {
            critBest = v;
            critEndName = t.name;
        }
    });
    if (!critEndName) {
        allTasks.forEach((t) => {
            const v = bestTo.get(t.name) || 0;
            if (v > critBest) {
                critBest = v;
                critEndName = t.name;
            }
        });
    }

    if (critEndName) {
        let cur = critEndName;
        const seen = new Set();
        while (cur && !seen.has(cur)) {
            seen.add(cur);
            if (taskMap[cur]) taskMap[cur].isCritical = true;
            cur = predOnBest.get(cur) || null;
        }
    }

    return attachDiagnostics({
        title: projectTitle,
        startDate: projectStartDate,
        sections: sections,
        calendarMode,
        holidays,
        scaleMode
    }, diagnostics);
}
