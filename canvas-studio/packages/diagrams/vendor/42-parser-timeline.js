/**
 * Парсер лёгкого таймлайна (референс: Mermaid timeline).
 *
 * название: Roadmap 2026
 * направление: вправо   // primary: вниз|вправо; aliases: вертикально/горизонтально/vertical/horizontal/td/tb/lr/rl/down/right
 * чередовать            // блоки по разные стороны оси — на текущий ряд
 * раздел: Исследование
 * Июль: Интервью
 *
 * Второй «название:» — новый ряд; направление/чередовать задаются отдельно на каждый ряд.
 */
function parseTimeline(text) {
    const diagnostics = [];
    const tracks = [];
    let currentTrack = null;
    let currentSection = null;
    let lastPeriod = null;

    function trackHasPeriods(track) {
        if (!track || !track.sections) return false;
        return track.sections.some((s) => s.periods && s.periods.length);
    }

    function flushSectionIntoTrack() {
        if (!currentTrack || !currentSection) return;
        if (currentSection.periods.length && !currentTrack.sections.includes(currentSection)) {
            currentTrack.sections.push(currentSection);
        }
    }

    function startTrack(title) {
        flushSectionIntoTrack();
        if (currentTrack && trackHasPeriods(currentTrack)) {
            tracks.push(currentTrack);
        }
        currentTrack = {
            title: title || 'Таймлайн',
            sections: [],
            direction: 'lr',
            alternate: false
        };
        currentSection = { name: '', periods: [] };
        lastPeriod = null;
    }

    function ensureTrack() {
        if (!currentTrack) startTrack('Таймлайн');
        return currentTrack;
    }

    function ensureSection() {
        ensureTrack();
        if (!currentSection) {
            currentSection = { name: '', periods: [] };
        }
        if (!currentTrack.sections.includes(currentSection)) {
            currentTrack.sections.push(currentSection);
        }
        return currentSection;
    }

    function parseDirectionValue(raw, lineNo) {
        // Prefix match (no $): вниз→tb, вправо→lr; aliases вертикально/горизонтально/…
        const d = String(raw || '').trim().toLowerCase();
        if (/^(вправо|горизонт|horizontal|lr|rl|right)/i.test(d)) return 'lr';
        if (/^(вниз|вертикал|vertical|td|tb|down)/i.test(d)) return 'tb';
        diagnostics.push(diag('warning', 'Направление: вниз или вправо', {
            line: lineNo, code: 'timeline_bad_direction',
            hint: 'направление: вниз | вправо'
        }));
        return null;
    }

    String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach((raw, idx) => {
        const lineNo = idx + 1;
        const trimmed = raw.trim();
        if (typeof isDiagramCommentLine === 'function'
            ? isDiagramCommentLine(trimmed)
            : (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//'))) return;

        if (/^(таймлайн|timeline)\s*$/i.test(trimmed)) return;

        if (/^(чередовать|alternate|zigzag)\s*$/i.test(trimmed)) {
            ensureTrack().alternate = true;
            return;
        }
        const altM = trimmed.match(/^(чередовать|alternate|zigzag)\s*:\s*(.+)$/i);
        if (altM) {
            const v = String(altM[2] || '').trim().toLowerCase();
            ensureTrack().alternate = !/^(нет|no|false|0|off|выкл)/i.test(v);
            return;
        }

        const dirM = trimmed.match(/^(направление|direction)\s*:\s*(.+)$/i);
        if (dirM) {
            const next = parseDirectionValue(dirM[2], lineNo);
            if (next) ensureTrack().direction = next;
            return;
        }

        const titleVal = typeof parseDiagramTitleLine === 'function'
            ? parseDiagramTitleLine(trimmed)
            : null;
        if (titleVal != null || /^(заголовок|title)\s*:/i.test(trimmed)) {
            let name = titleVal;
            if (!name) {
                const m = trimmed.match(/^(заголовок|title)\s*:\s*(.*)$/i);
                name = m ? String(m[2] || '').trim() : '';
            }
            name = name || 'Таймлайн';
            if (currentTrack && trackHasPeriods(currentTrack)) {
                startTrack(name);
            } else if (!currentTrack) {
                startTrack(name);
            } else {
                currentTrack.title = name;
            }
            return;
        }

        const secM = trimmed.match(/^(раздел|section|секция)\s*:?\s*(.*)$/i);
        if (secM) {
            ensureTrack();
            flushSectionIntoTrack();
            const name = String(secM[2] || '').trim() || 'Раздел';
            currentSection = { name, periods: [] };
            currentTrack.sections.push(currentSection);
            lastPeriod = null;
            return;
        }

        const contM = trimmed.match(/^:\s*(.+)$/);
        if (contM && lastPeriod) {
            lastPeriod.events.push(contM[1].trim());
            return;
        }

        const colon = trimmed.indexOf(':');
        if (colon > 0) {
            const period = trimmed.slice(0, colon).trim();
            const rest = trimmed.slice(colon + 1).trim();
            if (/^(название|заголовок|title|раздел|section|секция|направление|direction|чередовать|alternate|zigzag)$/i.test(period)) {
                return;
            }
            const events = rest
                ? rest.split(/\s*:\s*/).map((e) => e.trim()).filter(Boolean)
                : [];
            if (!events.length) {
                diagnostics.push(diag('warning', 'У периода нет события', {
                    line: lineNo, code: 'timeline_empty_events',
                    hint: 'Июль: Интервью'
                }));
            }
            ensureSection();
            lastPeriod = { period, events, line: lineNo };
            currentSection.periods.push(lastPeriod);
            return;
        }

        diagnostics.push(diag('warning', 'Строка не распознана', {
            line: lineNo, code: 'timeline_bad_line',
            hint: 'раздел: Запуск   или   Октябрь: Релиз'
        }));
    });

    flushSectionIntoTrack();
    if (currentTrack && trackHasPeriods(currentTrack)) {
        tracks.push(currentTrack);
    }

    if (!tracks.length) {
        return attachDiagnostics(null, diagnostics);
    }

    return attachDiagnostics({
        title: tracks[0].title,
        sections: tracks[0].sections,
        tracks,
        // совместимость: направление первого ряда
        direction: tracks[0].direction || 'lr',
        alternate: !!tracks[0].alternate
    }, diagnostics);
}
