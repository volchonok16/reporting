/**
 * Построчная подсветка DSL без изменения ширины глифов и длины строки.
 * (иначе слой подсветки и textarea расходятся — курсор «на другой строке»).
 */
(function (global) {
    'use strict';

    function esc(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function wrap(cls, text) {
        return `<span class="${cls}">${esc(text)}</span>`;
    }

    /**
     * Линии уровней на ведущих пробелах/табах.
     * Классика VS Code/Mermaid: линия у левого края каждого уровня (col 0,4,8…).
     * У вложенной строки самая правая линия совпадает с началом текста родителя.
     * Tab → пробелы как tab-size:4. Только box-shadow — ширина глифа не меняется.
     */
    function indentGuideHtml(ws) {
        let html = '';
        let col = 0;
        const s = String(ws || '');
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (ch === '\t') {
                const n = 4 - (col % 4);
                for (let k = 0; k < n; k++) {
                    if (col % 4 === 0) {
                        html += '<span class="hl-indent-unit is-guide"> </span>';
                    } else {
                        html += ' ';
                    }
                    col += 1;
                }
            } else if (ch === ' ') {
                if (col % 4 === 0) {
                    html += '<span class="hl-indent-unit is-guide"> </span>';
                } else {
                    html += ' ';
                }
                col += 1;
            } else {
                html += esc(ch);
                col += 1;
            }
        }
        return html;
    }

    function paintSegments(segments) {
        return segments.map((s, i) => {
            if (!s.cls && i === 0 && /^[ \t]+$/.test(s.text || '')) {
                return indentGuideHtml(s.text);
            }
            return s.cls ? wrap(s.cls, s.text) : esc(s.text);
        }).join('');
    }

    /** Для строк без сегментов (esc целиком) — тоже нарисовать guides на ведущем отступе. */
    function withLeadingIndentGuides(rawLine, html) {
        if (!rawLine || /hl-indent-unit/.test(html)) return html;
        const m = String(rawLine).match(/^[ \t]+/);
        if (!m) return html;
        const indent = m[0];
        const escIndent = esc(indent);
        if (html.startsWith(escIndent)) {
            return indentGuideHtml(indent) + html.slice(escIndent.length);
        }
        // Tab в HTML как один символ — длина escIndent может не совпасть с visual
        if (indent.indexOf('\t') >= 0 && html.charAt(0) === '\t') {
            // rare: esc doesn't change tab
        }
        if (html.startsWith(indent)) {
            return indentGuideHtml(indent) + html.slice(indent.length);
        }
        return html;
    }

    /** Рисуем только если склейка сегментов === исходной строке */
    function paintExact(line, segments) {
        const plain = segments.map(s => s.text).join('');
        if (plain !== line) return esc(line);
        return paintSegments(segments);
    }

    /** Разбить строку по первому совпадению regex, вернуть [до, match, после] или null */
    function take(re, line) {
        const m = line.match(re);
        if (!m || m.index === undefined) return null;
        return {
            before: line.slice(0, m.index),
            match: m[0],
            groups: m,
            after: line.slice(m.index + m[0].length)
        };
    }

    function highlightSequenceLine(line) {
        const trimmed = line.trimStart();
        const indent = line.slice(0, line.length - trimmed.length);

        const titleM = trimmed.match(/^(название|заголовок|title|name|название|name)(\s*:)(\s*)(.*)$/i);
        if (titleM) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-keyword', text: titleM[1] },
                { cls: 'hl-operator', text: titleM[2] },
                { text: titleM[3] },
                { cls: 'hl-string', text: titleM[4] }
            ]);
        }

        const kwFull = [
            /^Участник(?=\s|$)/i,
            /^Начало комментария:/i,
            /^Конец комментария(?=\s|$)/i,
            /^если(?=\s|$)/i,
            /^параллельно(?=\s|$)/i,
            /^выбор(?=\s|$)/i,
            /^цикл(?=\s|$)/i,
            /^или(?=\s|$)/i,
            /^Начало ветки(?=\s|$)/i,
            /^конец ветки(?=\s|$)/i,
            /^Начало альтернативы(?=\s|$)/i,
            /^конец альтернативы(?=\s|$)/i,
            /^Начало цикла(?=\s|$)/i,
            /^конец цикла(?=\s|$)/i,
            /^Начало параллельных действий(?=\s|$)/i,
            /^конец параллельных действий(?=\s|$)/i,
            /^Начало опционально(?=\s|$)/i,
            /^конец опционально(?=\s|$)/i,
            /^конец(?=\s|$)/i,
            /^иначе(?=\s|$)/i,
            /^и(?=\s|$)/i,
            /^автонумерация(?=\s|$)/i,
            /^завершить(?=\s|$)/i,
            /^создать(?=\s|$)/i,
            /^активировать(?=\s|$)/i
        ];

        for (const re of kwFull) {
            const t = take(re, trimmed);
            if (!t || t.before !== '') continue;
            const segs = [{ text: indent }, { cls: 'hl-keyword', text: t.match }];
            let rest = t.after;

            if (/^Участник(?=\s|$)/i.test(t.match)) {
                const pm = rest.match(/^(\s+)(\S+)(?:(\s+)(как)(\s+)(\S+))?(.*)$/i);
                if (pm) {
                    segs.push({ text: pm[1] }, { cls: 'hl-variable', text: pm[2] });
                    if (pm[4]) {
                        segs.push({ text: pm[3] }, { cls: 'hl-keyword', text: pm[4] }, { text: pm[5] }, { cls: 'hl-variable', text: pm[6] });
                    }
                    if (pm[7]) segs.push({ text: pm[7] });
                    return paintExact(line, segs);
                }
            }
            if (/^(завершить|создать|активировать)(?=\s|$)/i.test(t.match)) {
                const pm = rest.match(/^(\s+)(\S+)(.*)$/);
                if (pm) {
                    segs.push({ text: pm[1] }, { cls: 'hl-variable', text: pm[2] });
                    if (pm[3]) segs.push({ text: pm[3] });
                    return paintExact(line, segs);
                }
            }
            if (/^(Начало|если|параллельно|выбор|цикл)(?=\s|$)/i.test(t.match) && rest) {
                segs.push({ cls: 'hl-string', text: rest });
                return paintExact(line, segs);
            }
            if (rest) segs.push({ text: rest });
            return paintExact(line, segs);
        }

        const msg = trimmed.match(/^(.+?)(\s*)(->|-->)(\s*)(.+?)(?:(\s*)(:)(\s*)(.*))?$/);
        if (msg) {
            const segs = [
                { text: indent },
                { cls: 'hl-variable', text: msg[1] },
                { text: msg[2] },
                { cls: 'hl-operator', text: msg[3] },
                { text: msg[4] },
                { cls: 'hl-variable', text: msg[5] }
            ];
            if (msg[7]) {
                segs.push({ text: msg[6] || '' }, { cls: 'hl-operator', text: msg[7] }, { text: msg[8] || '' }, { cls: 'hl-string', text: msg[9] || '' });
            }
            return paintExact(line, segs);
        }

        return esc(line);
    }

    function highlightBpmnLine(line) {
        const trimmed = line.trimStart();
        const indent = line.slice(0, line.length - trimmed.length);

        if (/^\/\//.test(trimmed)) {
            return paintExact(line, [{ text: indent }, { cls: 'hl-string', text: trimmed }]);
        }

        const decl = trimmed.match(/^(название|заголовок|title|name|название|name|Процесс|процесс|Пул|пул|Дорожка|дорожка|Задача|задача|Подпроцесс|подпроцесс|Событие|событие|Шлюз|шлюз|начало|конец|выбор|ветка|таймер|Данные|данные|Документ|документ|Хранилище|хранилище):(\s*)(.*)$/i);
        if (decl) {
            const segs = [
                { text: indent },
                { cls: 'hl-keyword', text: decl[1] + ':' },
                { text: decl[2] }
            ];
            const rest = decl[3] || '';
            const inlineType = rest.match(/^(.*?)(\s*)(\()(\s*)(тип:)(\s*)(.+?)(\s*)(\))(\s*)$/i);
            if (inlineType) {
                segs.push(
                    { cls: 'hl-variable', text: inlineType[1] },
                    { text: inlineType[2] },
                    { cls: 'hl-operator', text: inlineType[3] },
                    { text: inlineType[4] },
                    { cls: 'hl-attribute', text: inlineType[5] },
                    { text: inlineType[6] },
                    { cls: 'hl-string', text: inlineType[7] },
                    { text: inlineType[8] },
                    { cls: 'hl-operator', text: inlineType[9] },
                    { text: inlineType[10] }
                );
            } else if (rest) {
                segs.push({ cls: 'hl-variable', text: rest });
            }
            return paintExact(line, segs);
        }

        const attr = trimmed.match(/^(тип|доп\.тип|маркер|заметка|на|граничное|boundary):(\s*)(.*)$/i);
        if (attr) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-attribute', text: attr[1] + ':' },
                { text: attr[2] },
                { cls: 'hl-string', text: attr[3] }
            ]);
        }

        const flow = trimmed.match(/^(.+?)(\s*)(->|-->|~~>|\.\.\.>|=>)(\s*)(.+?)(?:(\s*)(:)(\s*)(.*))?$/);
        if (flow) {
            const segs = [
                { text: indent },
                { cls: 'hl-variable', text: flow[1] },
                { text: flow[2] },
                { cls: 'hl-operator', text: flow[3] },
                { text: flow[4] },
                { cls: 'hl-variable', text: flow[5] }
            ];
            if (flow[7]) {
                segs.push(
                    { text: flow[6] || '' },
                    { cls: 'hl-operator', text: flow[7] },
                    { text: flow[8] || '' },
                    { cls: 'hl-string', text: flow[9] || '' }
                );
            }
            return paintExact(line, segs);
        }

        return esc(line);
    }

    function highlightSecretLine(line) {
        const trimmed = line.trimStart();
        const indent = line.slice(0, line.length - trimmed.length);

        const titleM = trimmed.match(/^(название|заголовок|title|name)(\s*:)(\s*)(.*)$/i);
        if (titleM) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-keyword', text: titleM[1] },
                { cls: 'hl-operator', text: titleM[2] },
                { text: titleM[3] },
                { cls: 'hl-string', text: titleM[4] }
            ]);
        }

        if (/^колонка(?=\s|$)/i.test(trimmed)) {
            const m = trimmed.match(/^(колонка)(\s+)(.*)$/i);
            if (m) {
                return paintExact(line, [
                    { text: indent },
                    { cls: 'hl-keyword', text: m[1] },
                    { text: m[2] },
                    { cls: 'hl-variable', text: m[3] }
                ]);
            }
        }
        if (/^задача:/i.test(trimmed)) {
            const m = trimmed.match(/^(задача:)(\s*)(.*)$/i);
            const segs = [
                { text: indent },
                { cls: 'hl-keyword', text: m[1] },
                { text: m[2] }
            ];
            appendMetaAwareSegs(segs, m[3], 'hl-string');
            return paintExact(line, segs);
        }
        if (/^Описание:/i.test(trimmed)) {
            const m = trimmed.match(/^(Описание:)(\s*)(.*)$/i);
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-attribute', text: m[1] },
                { text: m[2] },
                { cls: 'hl-string', text: m[3] }
            ]);
        }

        let rest = trimmed;
        const out = [{ text: indent }];
        while (rest.length) {
            let m;
            if ((m = rest.match(/^@(\S+)/))) {
                out.push({ cls: 'hl-keyword', text: '@' }, { cls: 'hl-variable', text: m[1] });
                rest = rest.slice(m[0].length);
            } else if ((m = rest.match(/^!(\S+)/))) {
                out.push({ cls: 'hl-operator', text: '!' }, { cls: 'hl-attribute', text: m[1] });
                rest = rest.slice(m[0].length);
            } else if ((m = rest.match(/^(тег:|дата:|до:)/i))) {
                out.push({ cls: 'hl-attribute', text: m[1] });
                rest = rest.slice(m[1].length);
            } else if ((m = rest.match(/^(не срочно|срочно|важно|средне)(?=\s|$)/i))) {
                out.push({ cls: 'hl-attribute', text: m[1] });
                rest = rest.slice(m[1].length);
            } else if ((m = rest.match(/^\(#[0-9A-Fa-f]{6}\)/))) {
                out.push({ cls: 'hl-string', text: m[0] });
                rest = rest.slice(m[0].length);
            } else if ((m = rest.match(/^\S+/))) {
                out.push({ text: m[0] });
                rest = rest.slice(m[0].length);
            } else if ((m = rest.match(/^\s+/))) {
                out.push({ text: m[0] });
                rest = rest.slice(m[0].length);
            } else {
                out.push({ text: rest });
                break;
            }
        }
        return paintExact(line, out);
    }

    /** Подсветка @ответственный и !дедлайн внутри сегмента текста. */
    function appendMetaAwareSegs(out, text, defaultCls) {
        let rest = String(text || '');
        while (rest.length) {
            let m = rest.match(/^@([^\s@!\]\}\)]+)/);
            if (m) {
                out.push({ cls: 'hl-keyword', text: '@' });
                out.push({ cls: 'hl-variable', text: m[1] });
                rest = rest.slice(m[0].length);
                continue;
            }
            m = rest.match(/^!([^\s@!\]\}\)]+)/);
            if (m) {
                out.push({ cls: 'hl-operator', text: '!' });
                out.push({ cls: 'hl-attribute', text: m[1] });
                rest = rest.slice(m[0].length);
                continue;
            }
            m = rest.match(/^[^@!]+/);
            if (m) {
                out.push(defaultCls ? { cls: defaultCls, text: m[0] } : { text: m[0] });
                rest = rest.slice(m[0].length);
                continue;
            }
            out.push({ text: rest.charAt(0) });
            rest = rest.slice(1);
        }
    }

    function highlightAssigneeDeadlineHtml(escaped) {
        return String(escaped || '')
            .replace(/(^|[\s>])@([^\s@!&<\]]+)/g,
                '$1<span class="hl-keyword">@</span><span class="hl-variable">$2</span>')
            .replace(/(^|[\s>])!([^\s@!&<\]]+)/g,
                '$1<span class="hl-operator">!</span><span class="hl-attribute">$2</span>');
    }

    function highlightGanttLine(line) {
        const trimmed = line.trimStart();
        const indent = line.slice(0, line.length - trimmed.length);
        const m = trimmed.match(/^(название|заголовок|name|title|дата-начала|старт|календарь|праздники|нерабочие|масштаб|шаг|раздел|задача|веха|длительность|длится|после|потом|начало|завершение|комментарий|примечание|прогресс|базовый-старт|базовое-завершение|план-начало|план-конец|ответственный|ресурс|одновременно с|вместе с|закончить с):(\s*)(.*)$/i);
        if (m) {
            const isKw = /^(название|заголовок|name|title|дата-начала|старт|календарь|праздники|нерабочие|масштаб|шаг|раздел|задача|веха)$/i.test(m[1]);
            const segs = [
                { text: indent },
                { cls: isKw ? 'hl-keyword' : 'hl-attribute', text: m[1] + ':' },
                { text: m[2] }
            ];
            appendMetaAwareSegs(segs, m[3], 'hl-string');
            return paintExact(line, segs);
        }
        const segs = [{ text: indent }];
        appendMetaAwareSegs(segs, trimmed, null);
        return paintExact(line, segs);
    }

    function highlightTreeLine(line) {
        const trimmed = line.trimStart();
        const indent = line.slice(0, line.length - trimmed.length);
        // Сегменты + guides на отступе (не regex по всей строке — иначе легко съехать)
        const segs = [{ text: indent }];
        appendMetaAwareSegs(segs, trimmed, null);
        let html = paintExact(line, segs);
        // Доп. токены статуса/ссылок без изменения длины текста
        html = html
            .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/gi,
                '<span class="hl-attribute">[$1]($2)</span>')
            .replace(/(\[|\()?(готово|выполнено|done|ok)(\]|\))?/gi, (m, a, word, b, offset, full) => {
                // не трогаем, если уже внутри span
                return '<span class="hl-string">' + m + '</span>';
            })
            .replace(/(Статус:)/gi, '<span class="hl-keyword">$1</span>');
        return html;
    }

    function highlightWaveLine(line) {
        const trimmed = line.trimStart();
        const indent = line.slice(0, line.length - trimmed.length);
        const titleM = trimmed.match(/^(название|заголовок|title|name)(\s*:)(\s*)(.*)$/i);
        if (titleM) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-keyword', text: titleM[1] },
                { cls: 'hl-operator', text: titleM[2] },
                { text: titleM[3] },
                { cls: 'hl-string', text: titleM[4] }
            ]);
        }
        const m = trimmed.match(/^(.+?)(\s*)(->)(\s*)(.+?)(?:(\s*)(:)(\s*)(.*))?$/);
        if (m) {
            const segs = [
                { text: indent },
                { cls: 'hl-variable', text: m[1] },
                { text: m[2] },
                { cls: 'hl-operator', text: m[3] },
                { text: m[4] },
                { cls: 'hl-variable', text: m[5] }
            ];
            if (m[7]) {
                segs.push(
                    { text: m[6] || '' },
                    { cls: 'hl-operator', text: m[7] },
                    { text: m[8] || '' },
                    { cls: 'hl-number', text: m[9] || '' }
                );
            }
            return paintExact(line, segs);
        }
        return esc(line);
    }

    function highlightSankeyLine(line) {
        const trimmed = line.trimStart();
        const indent = line.slice(0, line.length - trimmed.length);
        const titleM = trimmed.match(/^(название|заголовок|title|name)(\s*:)(\s*)(.*)$/i);
        if (titleM) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-keyword', text: titleM[1] },
                { cls: 'hl-operator', text: titleM[2] },
                { text: titleM[3] },
                { cls: 'hl-string', text: titleM[4] }
            ]);
        }
        const colM = trimmed.match(/^(колонки|слои|columns|layers)(\s*:)(\s*)(.*)$/i);
        if (colM) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-keyword', text: colM[1] },
                { cls: 'hl-operator', text: colM[2] },
                { text: colM[3] },
                { cls: 'hl-string', text: colM[4] }
            ]);
        }
        const pin = trimmed.match(/^(.+?)(\s*@\s*)(.+)$/);
        if (pin && !/->/.test(trimmed)) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-variable', text: pin[1] },
                { cls: 'hl-operator', text: pin[2] },
                { cls: 'hl-string', text: pin[3] }
            ]);
        }
        return highlightWaveLine(line);
    }

    function highlightPulsewaveLine(line) {
        const trimmed = line.trimStart();
        const indent = line.slice(0, line.length - trimmed.length);
        const titleM = trimmed.match(/^(название|заголовок|title|name)(\s*:)(\s*)(.*)$/i);
        if (titleM) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-keyword', text: titleM[1] },
                { cls: 'hl-operator', text: titleM[2] },
                { text: titleM[3] },
                { cls: 'hl-string', text: titleM[4] }
            ]);
        }
        const slicesM = trimmed.match(/^(даты|срезы|dates|slices)(\s*:)(\s*)(.*)$/i);
        if (slicesM) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-keyword', text: slicesM[1] },
                { cls: 'hl-operator', text: slicesM[2] },
                { text: slicesM[3] },
                { cls: 'hl-string', text: slicesM[4] }
            ]);
        }
        const compact = trimmed.match(/^(.+?)(\s*)(:)(\s*)([0-9]+(?:[.,][0-9]+)?(?:\s*,\s*[0-9]+(?:[.,][0-9]+)?)*)\s*$/);
        if (compact && !/->/.test(trimmed)) {
            const nums = compact[5].split(/(\s*,\s*)/);
            const segs = [
                { text: indent },
                { cls: 'hl-variable', text: compact[1] },
                { text: compact[2] },
                { cls: 'hl-operator', text: compact[3] },
                { text: compact[4] }
            ];
            nums.forEach((part) => {
                if (/^\s*,\s*$/.test(part)) segs.push({ cls: 'hl-operator', text: part });
                else segs.push({ cls: 'hl-number', text: part });
            });
            return paintExact(line, segs);
        }
        if (/->/.test(trimmed)) {
            const parts = trimmed.split(/(\s*->\s*)/);
            const segs = [{ text: indent }];
            parts.forEach((part, idx) => {
                if (idx % 2 === 1) {
                    segs.push({ cls: 'hl-operator', text: part });
                    return;
                }
                const m = part.match(/^(.+?)(\s+)([0-9]+(?:[.,][0-9]+)?)$/);
                if (m) {
                    segs.push(
                        { cls: 'hl-variable', text: m[1] },
                        { text: m[2] },
                        { cls: 'hl-number', text: m[3] }
                    );
                } else {
                    segs.push({ text: part });
                }
            });
            return paintExact(line, segs);
        }
        return esc(line);
    }

    function highlightHeatmapLine(line) {
        const trimmed = line.trimStart();
        const indent = line.slice(0, line.length - trimmed.length);
        if (/^(тепловая|heatmap|heat|теплокарта)\s*$/i.test(trimmed)) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-keyword', text: trimmed }
            ]);
        }
        const titleM = trimmed.match(/^(название|заголовок|title|name)(\s*:)(\s*)(.*)$/i);
        if (titleM) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-keyword', text: titleM[1] },
                { cls: 'hl-operator', text: titleM[2] },
                { text: titleM[3] },
                { cls: 'hl-string', text: titleM[4] }
            ]);
        }
        const axisM = trimmed.match(/^(ось\s*[xy]|x|y|столбцы|строки|columns|cols|rows)(\s*:)(\s*)(.*)$/i);
        if (axisM) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-keyword', text: axisM[1] },
                { cls: 'hl-operator', text: axisM[2] },
                { text: axisM[3] },
                { cls: 'hl-string', text: axisM[4] }
            ]);
        }
        const rowM = trimmed.match(/^(.+?)(\s*)(:)(\s*)(.+)$/);
        if (rowM) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-variable', text: rowM[1] },
                { text: rowM[2] },
                { cls: 'hl-operator', text: rowM[3] },
                { text: rowM[4] },
                { cls: 'hl-number', text: rowM[5] }
            ]);
        }
        return esc(line);
    }

    function highlightTreemapLine(line) {
        const trimmed = line.trimStart();
        const indent = line.slice(0, line.length - trimmed.length);
        if (/^treemap(-beta)?\s*$/i.test(trimmed)) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-keyword', text: trimmed }
            ]);
        }
        const titleM = trimmed.match(/^(название|заголовок|title|name)(\s*:)(\s*)(.*)$/i);
        if (titleM) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-keyword', text: titleM[1] },
                { cls: 'hl-operator', text: titleM[2] },
                { text: titleM[3] },
                { cls: 'hl-string', text: titleM[4] }
            ]);
        }
        const m = trimmed.match(/^(?:"([^"]+)"|(.+?))(\s*)(:)(\s*)([0-9]+(?:[.,][0-9]+)?)\s*$/);
        if (m) {
            const name = m[1] != null ? '"' + m[1] + '"' : m[2];
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-variable', text: name },
                { text: m[3] },
                { cls: 'hl-operator', text: m[4] },
                { text: m[5] },
                { cls: 'hl-number', text: m[6] }
            ]);
        }
        const q = trimmed.match(/^"([^"]+)"\s*$/);
        if (q) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-variable', text: trimmed }
            ]);
        }
        return paintExact(line, [
            { text: indent },
            { cls: 'hl-variable', text: trimmed }
        ]);
    }

    function highlightReversibilityLine(line) {
        const trimmed = line.trimStart();
        const indent = line.slice(0, line.length - trimmed.length);
        if (/^reversibility\s*$/i.test(trimmed) || /^(название|заголовок|title|name)\s*:/i.test(trimmed)) {
            const m = trimmed.match(/^(название|заголовок|title|name)(\s*:)(\s*)(.+)$/i);
            if (m) {
                return paintExact(line, [
                    { text: indent },
                    { cls: 'hl-keyword', text: m[1] },
                    { cls: 'hl-operator', text: m[2] },
                    { text: m[3] },
                    { cls: 'hl-string', text: m[4] }
                ]);
            }
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-keyword', text: trimmed }
            ]);
        }
        const link = trimmed.match(/^(.+?)(\s*->\s*)(.+?)(\s*:)(\s*)([0-9]+(?:[.,][0-9]+)?)\s*$/);
        if (link) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-variable', text: link[1] },
                { cls: 'hl-operator', text: link[2] },
                { cls: 'hl-variable', text: link[3] },
                { cls: 'hl-operator', text: link[4] },
                { text: link[5] },
                { cls: 'hl-number', text: link[6] }
            ]);
        }
        const node = trimmed.match(
            /^(.+?)(\s*:)(\s*)([0-9]+(?:[.,][0-9]+)?)(\s*,\s*)([0-9]+(?:[.,][0-9]+)?)(\s*,\s*)?(факт|гипотеза|fact|hyp)?\s*$/i
        );
        if (node) {
            const segs = [
                { text: indent },
                { cls: 'hl-variable', text: node[1] },
                { cls: 'hl-operator', text: node[2] },
                { text: node[3] },
                { cls: 'hl-number', text: node[4] },
                { cls: 'hl-operator', text: node[5] },
                { cls: 'hl-number', text: node[6] }
            ];
            if (node[7] || node[8]) {
                segs.push({ text: node[7] || '' });
                if (node[8]) segs.push({ cls: 'hl-keyword', text: node[8] });
            }
            return paintExact(line, segs);
        }
        return paintExact(line, [
            { text: indent },
            { cls: 'hl-variable', text: trimmed }
        ]);
    }

    function highlightPerspectiveLine(line) {
        const trimmed = line.trimStart();
        const indent = line.slice(0, line.length - trimmed.length);
        if (/^(название|заголовок|title|name)\s*:/i.test(trimmed)) {
            const m = trimmed.match(/^(название|заголовок|title|name)(\s*:)(\s*)(.+)$/i);
            if (m) {
                return paintExact(line, [
                    { text: indent },
                    { cls: 'hl-keyword', text: m[1] },
                    { cls: 'hl-operator', text: m[2] },
                    { text: m[3] },
                    { cls: 'hl-string', text: m[4] }
                ]);
            }
        }
        if (/^\[.+\]\s*$/.test(trimmed) || /^роль\s*:/i.test(trimmed)) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-keyword', text: trimmed }
            ]);
        }
        if (trimmed.startsWith('=')) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-operator', text: '=' },
                { cls: 'hl-variable', text: trimmed.slice(1) }
            ]);
        }
        return paintExact(line, [
            { text: indent },
            { cls: 'hl-variable', text: trimmed }
        ]);
    }

    function highlightFanLine(line) {
        const trimmed = line.trimStart();
        const indent = line.slice(0, line.length - trimmed.length);
        if (/^(название|заголовок|title|name|вес|оси|критерии)\s*:/i.test(trimmed)) {
            const m = trimmed.match(/^(\S+)(\s*:)(\s*)(.*)$/i);
            if (m) {
                return paintExact(line, [
                    { text: indent },
                    { cls: 'hl-keyword', text: m[1] },
                    { cls: 'hl-operator', text: m[2] },
                    { text: m[3] },
                    { cls: 'hl-string', text: m[4] }
                ]);
            }
        }
        const m = trimmed.match(/^(.+?)(\s*:)(\s*)(.+)$/);
        if (m) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-variable', text: m[1] },
                { cls: 'hl-operator', text: m[2] },
                { text: m[3] },
                { cls: 'hl-number', text: m[4] }
            ]);
        }
        return paintExact(line, [{ text: indent }, { cls: 'hl-variable', text: trimmed }]);
    }

    function highlightRidgelineLine(line) {
        return highlightFanLine(line);
    }

    function highlightWaterfallLine(line) {
        const trimmed = line.trimStart();
        const indent = line.slice(0, line.length - trimmed.length);
        const titleM = trimmed.match(/^(название|заголовок|title|name|единицы|units|проценты|показывать|план|факт|plan|actual|fact)(\s*:)(\s*)(.*)$/i);
        if (titleM) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-keyword', text: titleM[1] },
                { cls: 'hl-operator', text: titleM[2] },
                { text: titleM[3] },
                { cls: 'hl-string', text: titleM[4] }
            ]);
        }
        if (/^(итог|всего|итого|total|подытог|checkpoint)\s*:?\s*$/i.test(trimmed)) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-keyword', text: trimmed }
            ]);
        }
        if (/^(план|факт|plan|actual|fact)\s*:?\s*$/i.test(trimmed)) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-keyword', text: trimmed }
            ]);
        }
        const m = trimmed.match(/^(.+?)(\s*:)(\s*)([+\−\-]?)(\s*)([0-9]+(?:[.,][0-9]+)?)\s*$/);
        if (m) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-variable', text: m[1] },
                { cls: 'hl-operator', text: m[2] },
                { text: m[3] },
                { cls: 'hl-operator', text: m[4] },
                { text: m[5] },
                { cls: 'hl-number', text: m[6] }
            ]);
        }
        return paintExact(line, [{ text: indent }, { cls: 'hl-variable', text: trimmed }]);
    }

    function highlightMarkdownLine(line) {
        const trimmed = line.trimStart();
        const indent = line.slice(0, line.length - trimmed.length);

        if (/^#{1,6}\s/.test(trimmed)) {
            const m = trimmed.match(/^(#{1,6})(\s+)(.*)$/);
            if (m) {
                return paintExact(line, [
                    { text: indent },
                    { cls: 'hl-keyword', text: m[1] },
                    { text: m[2] },
                    { cls: 'hl-string', text: m[3] }
                ]);
            }
        }
        if (/^(`{3,}|~{3,})/.test(trimmed)) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-attribute', text: trimmed }
            ]);
        }
        if (/^(?:[-*_]\s*){3,}$/.test(trimmed)) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-operator', text: trimmed }
            ]);
        }
        if (/^!\s*(?:заметка|важно|подсказка|опасно|note|tip|warning|danger|caution)\b/i.test(trimmed)) {
            const m = trimmed.match(/^(!)(\s+)(\S+)([\s\S]*)$/);
            if (m) {
                return paintExact(line, [
                    { text: indent },
                    { cls: 'hl-keyword', text: m[1] },
                    { text: m[2] },
                    { cls: 'hl-attribute', text: m[3] },
                    { cls: 'hl-string', text: m[4] || '' }
                ]);
            }
        }
        if (/^::(?::)?(детали|спойлер|ряд|схема|details|spoiler|row|diagram)\b/i.test(trimmed)) {
            const m = trimmed.match(/^(::(?::)?)(детали|спойлер|ряд|схема|details|spoiler|row|diagram)(\s*)(.*)$/i);
            if (m) {
                return paintExact(line, [
                    { text: indent },
                    { cls: 'hl-keyword', text: m[1] + m[2] },
                    { text: m[3] },
                    { cls: 'hl-string', text: m[4] || '' }
                ]);
            }
        }
        if (/^::(?::)?\s*$/.test(trimmed)) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-keyword', text: trimmed }
            ]);
        }
        if (/^\?[^\s=]+\s*=/.test(trimmed)) {
            const m = trimmed.match(/^(\?[^\s=]+)(\s*=\s*)(.*)$/);
            if (m) {
                return paintExact(line, [
                    { text: indent },
                    { cls: 'hl-attribute', text: m[1] },
                    { cls: 'hl-operator', text: m[2] },
                    { cls: 'hl-string', text: m[3] }
                ]);
            }
        }
        if (/^>\s?/.test(trimmed)) {
            const m = trimmed.match(/^(>)(\s?)(.*)$/);
            const rest = m[3] || '';
            if (/^\[!/.test(rest)) {
                const cm = rest.match(/^(\[!)([^\]]+)(\])([\s\S]*)$/);
                if (cm) {
                    return paintExact(line, [
                        { text: indent },
                        { cls: 'hl-keyword', text: m[1] + m[2] + cm[1] },
                        { cls: 'hl-attribute', text: cm[2] + cm[3] },
                        { cls: 'hl-string', text: cm[4] || '' }
                    ]);
                }
            }
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-keyword', text: m[1] },
                { text: m[2] },
                { cls: 'hl-string', text: rest }
            ]);
        }
        const list = trimmed.match(/^([-*+]|\d+[.)])(\s+)(\[[ xXхХ]\]\s+)?(.*)$/);
        if (list) {
            const segs = [
                { text: indent },
                { cls: 'hl-keyword', text: list[1] },
                { text: list[2] }
            ];
            if (list[3]) segs.push({ cls: 'hl-attribute', text: list[3] });
            segs.push({ text: list[4] });
            return paintExact(line, segs);
        }
        if (/[`«»()]/.test(trimmed) || /\*\*[^*]+\*\*/.test(trimmed) || /\+\+[^+]+\+\+/.test(trimmed) || /\[[^\]]+\]\([^)]+\)/.test(trimmed) || /==[^=]+==/.test(trimmed) || /\?[\p{L}]/u.test(trimmed)) {
            let rest = trimmed;
            const out = [{ text: indent }];
            while (rest.length) {
                let m;
                if ((m = rest.match(/^`([^`]+)`/))) {
                    out.push({ cls: 'hl-string', text: m[0] });
                    rest = rest.slice(m[0].length);
                } else if ((m = rest.match(/^«([^»]+)»/))) {
                    out.push({ cls: 'hl-attribute', text: m[0] });
                    rest = rest.slice(m[0].length);
                } else if ((m = rest.match(/^\(([^)\n]+)\)([^(\n]+)/))) {
                    out.push({ cls: 'hl-keyword', text: '(' + m[1] + ')' });
                    out.push({ cls: 'hl-string', text: m[2] || '' });
                    rest = rest.slice(m[0].length);
                } else if ((m = rest.match(/^\*\*([^*]+)\*\*/))) {
                    out.push({ cls: 'hl-keyword', text: m[0] });
                    rest = rest.slice(m[0].length);
                } else if ((m = rest.match(/^==([^=]+?)==/))) {
                    out.push({ cls: 'hl-attribute', text: m[0] });
                    rest = rest.slice(m[0].length);
                } else if ((m = rest.match(/^\+\+([^+]+)\+\+/))) {
                    out.push({ cls: 'hl-attribute', text: m[0] });
                    rest = rest.slice(m[0].length);
                } else if ((m = rest.match(/^\?([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9_-]*)/))) {
                    out.push({ cls: 'hl-attribute', text: m[0] });
                    rest = rest.slice(m[0].length);
                } else if ((m = rest.match(/^\[[^\]]+\]\([^)]+\)/))) {
                    out.push({ cls: 'hl-attribute', text: m[0] });
                    rest = rest.slice(m[0].length);
                } else if ((m = rest.match(/^\S+/))) {
                    out.push({ text: m[0] });
                    rest = rest.slice(m[0].length);
                } else if ((m = rest.match(/^\s+/))) {
                    out.push({ text: m[0] });
                    rest = rest.slice(m[0].length);
                } else {
                    out.push({ text: rest });
                    break;
                }
            }
            return paintExact(line, out);
        }
        return esc(line);
    }


    function highlightFlowchartLine(line) {
        const trimmed = line.trimStart();
        const indent = line.slice(0, line.length - trimmed.length);
        if (/^\s*(#|\/\/)/.test(line) || !trimmed) return esc(line);

        const meta = trimmed.match(/^(название|заголовок|title|направление|direction)(\s*:)(\s*)(.*)$/i);
        if (meta) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-keyword', text: meta[1] },
                { cls: 'hl-operator', text: meta[2] },
                { text: meta[3] },
                { cls: 'hl-string', text: meta[4] }
            ]);
        }

        const edge = trimmed.match(/^(.+?)(\s*)(->|-->)(\s*)(.+?)(?:(\s*)(:)(\s*)(.*))?$/);
        if (edge) {
            const segs = [{ text: indent }];
            appendMetaAwareSegs(segs, edge[1], 'hl-variable');
            segs.push({ text: edge[2] }, { cls: 'hl-arrow', text: edge[3] }, { text: edge[4] });
            appendMetaAwareSegs(segs, edge[5], 'hl-variable');
            if (edge[7]) {
                segs.push({ text: edge[6] }, { cls: 'hl-operator', text: edge[7] }, { text: edge[8] || '' });
                if (edge[9]) segs.push({ cls: 'hl-string', text: edge[9] });
            }
            return paintExact(line, segs);
        }

        // формы: [[ ]] ([ ]) [( )] [/ /] [~ ~] (( )) [ ] { } ( )
        const shape = trimmed.match(/^(\[\[|\(\[|\[\(|\[\/|\[~|\(\(|[\[\{\(])(.+?)(\]\]|\]\)|\)\]|\/\]|~\]|\)\)|[\]\}\)])(.*)$/);
        if (shape) {
            const segs = [
                { text: indent },
                { cls: 'hl-attribute', text: shape[1] }
            ];
            appendMetaAwareSegs(segs, shape[2], 'hl-variable');
            segs.push({ cls: 'hl-attribute', text: shape[3] });
            if (shape[4]) appendMetaAwareSegs(segs, shape[4], null);
            return paintExact(line, segs);
        }

        const ru = trimmed.match(/^(старт|начало|конец|финал|выход|выбор|решение|процесс|ввод|вывод|данные|ввод-вывод|подпрограмма|подпроцесс|процедура|бд|база|хранилище|документ)(\s*:)(\s*)(.*)$/i);
        if (ru) {
            const segs = [
                { text: indent },
                { cls: 'hl-keyword', text: ru[1] },
                { cls: 'hl-operator', text: ru[2] },
                { text: ru[3] }
            ];
            appendMetaAwareSegs(segs, ru[4], 'hl-string');
            return paintExact(line, segs);
        }

        return esc(line);
    }

    function highlightTimelineLine(line) {
        const trimmed = line.trimStart();
        const indent = line.slice(0, line.length - trimmed.length);
        if (/^\s*(#|\/\/)/.test(line) || !trimmed) return esc(line);

        if (/^(чередовать|alternate|zigzag)\s*$/i.test(trimmed)) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-keyword', text: trimmed }
            ]);
        }

        const meta = trimmed.match(/^(название|заголовок|title|раздел|section|секция|направление|direction|чередовать|alternate|zigzag)(\s*:)(\s*)(.*)$/i);
        if (meta) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-keyword', text: meta[1] },
                { cls: 'hl-operator', text: meta[2] },
                { text: meta[3] },
                { cls: 'hl-string', text: meta[4] }
            ]);
        }

        if (/^:\s*/.test(trimmed)) {
            const m = trimmed.match(/^(:)(\s*)(.*)$/);
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-arrow', text: m[1] },
                { text: m[2] },
                { cls: 'hl-string', text: m[3] }
            ]);
        }

        const period = trimmed.match(/^([^:]+)(:)(\s*)(.*)$/);
        if (period) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-variable', text: period[1] },
                { cls: 'hl-arrow', text: period[2] },
                { text: period[3] },
                { cls: 'hl-string', text: period[4] }
            ]);
        }

        return esc(line);
    }

    function highlightRolloutLine(line) {
        const trimmed = line.trimStart();
        const indent = line.slice(0, line.length - trimmed.length);
        if (/^\s*(#|\/\/)/.test(line) || !trimmed) return esc(line);

        const meta = trimmed.match(/^(название|заголовок|title|фаза|этап|колонка|phase|column|трек|контур|track)(\s*:)(\s*)(.*)$/i);
        if (meta) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-keyword', text: meta[1] },
                { cls: 'hl-operator', text: meta[2] },
                { text: meta[3] },
                { cls: 'hl-string', text: meta[4] }
            ]);
        }
        if (/^(шлюз|gate|роллаут|rollout)\s*$/i.test(trimmed)) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-keyword', text: trimmed }
            ]);
        }

        const at = trimmed.match(/^(.*?)(\s+@)(.+)$/);
        if (at) {
            return paintExact(line, [
                { text: indent },
                { cls: 'hl-string', text: at[1] },
                { cls: 'hl-operator', text: at[2] },
                { cls: 'hl-variable', text: at[3] }
            ]);
        }
        return esc(line);
    }

    function highlightStateLine(line) {
        const trimmed = line.trim();
        const indent = line.match(/^\s*/)[0];
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return esc(line);

        if (/^(состояние|state)\s*:/i.test(trimmed) || /^(название|заголовок|title)\s*:/i.test(trimmed)) {
            const m = trimmed.match(/^([^:]+):\s*(.*)$/);
            if (m) {
                return paintExact(line, [
                    { text: indent },
                    { cls: 'hl-keyword', text: m[1] + ':' },
                    { cls: 'hl-string', text: m[2] ? ' ' + m[2] : '' }
                ]);
            }
        }
        if (/\[\*\]|\(\*\)|^(старт|начало|конец|финиш)\b/i.test(trimmed) || /\s*(->|-->)\s*/.test(trimmed)) {
            return highlightFlowchartLine(line);
        }
        return esc(line);
    }

    function highlightJourneyLine(line) {
        const trimmed = line.trim();
        const indent = line.match(/^\s*/)[0];
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return esc(line);
        if (/^(этап|стадия|stage|шаг|касание|канал|touch|мысль|feeling|эмоция|emotion|настроение|боль|барьер|pain|проблема|название|заголовок|title)\s*:/i.test(trimmed)) {
            const m = trimmed.match(/^([^:]+):\s*(.*)$/);
            if (m) {
                return paintExact(line, [
                    { text: indent },
                    { cls: 'hl-keyword', text: m[1] + ':' },
                    { cls: 'hl-string', text: m[2] ? ' ' + m[2] : '' }
                ]);
            }
        }
        return esc(line);
    }

    function highlightContextLine(line) {
        const trimmed = line.trim();
        const indent = line.match(/^\s*/)[0];
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return esc(line);
        if (/^(система|system|человек|персона|actor|user|роль|внешняя|внешняя система|external|система вне|название|заголовок|title)\s*:/i.test(trimmed)) {
            const m = trimmed.match(/^([^:]+):\s*(.*)$/);
            if (m) {
                return paintExact(line, [
                    { text: indent },
                    { cls: 'hl-keyword', text: m[1] + ':' },
                    { cls: 'hl-string', text: m[2] ? ' ' + m[2] : '' }
                ]);
            }
        }
        if (/\s*(->|-->)\s*/.test(trimmed)) return highlightFlowchartLine(line);
        return esc(line);
    }

    function highlightSyntax(text, mode) {
        if (typeof text !== 'string') text = String(text ?? '');
        const lines = text.split('\n');
        const out = lines.map(line => {
            let html;
            switch (mode) {
                case 'sequence': html = highlightSequenceLine(line); break;
                case 'bpmn': html = highlightBpmnLine(line); break;
                case 'secret': html = highlightSecretLine(line); break;
                case 'gantt': html = highlightGanttLine(line); break;
                case 'wave': html = highlightWaveLine(line); break;
                case 'sankey': html = highlightSankeyLine(line); break;
                case 'pulsewave': html = highlightPulsewaveLine(line); break;
                case 'treemap': html = highlightTreemapLine(line); break;
                case 'heatmap': html = highlightHeatmapLine(line); break;
                case 'reversibility': html = highlightReversibilityLine(line); break;
                case 'perspective': html = highlightPerspectiveLine(line); break;
                case 'fan': html = highlightFanLine(line); break;
                case 'ridgeline': html = highlightRidgelineLine(line); break;
                case 'waterfall': html = highlightWaterfallLine(line); break;
                case 'flowchart': html = highlightFlowchartLine(line); break;
                case 'timeline': html = highlightTimelineLine(line); break;
                case 'rollout':
                case 'lanes':
                case 'ribbon':
                    html = highlightRolloutLine(line); break;
                case 'state': html = highlightStateLine(line); break;
                case 'journey': html = highlightJourneyLine(line); break;
                case 'context': html = highlightContextLine(line); break;
                case 'markdown': html = highlightMarkdownLine(line); break;
                case 'radial':
                case 'classic':
                case 'horizontal':
                    html = highlightTreeLine(line); break;
                default: html = esc(line); break;
            }
            return withLeadingIndentGuides(line, html);
        });
        return out.join('\n');
    }

    global.diagramHighlightSyntax = highlightSyntax;
    if (typeof global.highlightSyntax !== 'function') {
        global.highlightSyntax = highlightSyntax;
    }
})(typeof window !== 'undefined' ? window : globalThis);
