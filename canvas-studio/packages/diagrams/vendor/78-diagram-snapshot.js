/**
 * Снимок схемы в SVG без переключения вкладки.
 * Нужен для встройки :::схема в Документ и офлайн-экспорта.
 */
(function (global) {
    function resolveThemeName(layout, preferred) {
        const lockAll = layout === 'perspective' || layout === 'reversibility';
        const lockMono = lockAll
            || layout === 'wave'
            || layout === 'sankey'
            || layout === 'secret'
            || layout === 'treemap'
            || layout === 'fan'
            || layout === 'ridgeline'
            || layout === 'pulsewave';
        let name = preferred;
        if (!name || (typeof themes !== 'undefined' && !themes[name])) {
            try {
                if (typeof currentTheme !== 'undefined' && themes && themes[currentTheme]) name = currentTheme;
            } catch (_) { /* ignore */ }
        }
        if (!name) name = 'neutral';
        if (lockAll || (lockMono && name === 'mono')) name = 'neutral';
        return name;
    }

    function themePalette(layout, preferred) {
        const name = resolveThemeName(layout, preferred);
        try {
            if (typeof themes !== 'undefined' && themes[name]) return themes[name];
        } catch (_) { /* ignore */ }
        return ['#3b82f6', '#06b6d4', '#8b5cf6', '#10b981', '#f59e0b'];
    }

    function renderEntry(entry) {
        if (!entry || !entry.layout) {
            return { ok: false, error: 'Нет записи схемы' };
        }
        return renderLayoutText(entry.layout, entry.text || '', {
            hierarchyDirection: entry.hierarchyDirection,
            theme: entry.theme,
            title: entry.title,
            layoutOverrides: entry.layoutOverrides || null
        });
    }

    function renderLayoutText(layout, text, opts) {
        opts = opts || {};
        const raw = String(text || '');
        const themeName = resolveThemeName(layout, opts.theme);
        const palette = themePalette(layout, themeName);
        const dir = opts.hierarchyDirection || (typeof hierarchyDirection !== 'undefined' ? hierarchyDirection : 'lr');

        try {
            let svg = null;
            let width = 0;
            let height = 0;

            if (layout === 'flowchart' && typeof parseFlowchart === 'function') {
                const d = parseFlowchart(raw);
                if (!d || d.__empty || !d.nodes || !d.nodes.length) return { ok: false, error: 'Пустая блок-схема' };
                let L = layoutFlowchart(d);
                if (opts.layoutOverrides && typeof applyFlowchartManualOffsets === 'function') {
                    L = applyFlowchartManualOffsets(L, opts.layoutOverrides);
                }
                const r = generateFlowchartSVG(L, palette);
                svg = r.svg; width = r.width; height = r.height;
            } else if (layout === 'timeline' && typeof parseTimeline === 'function') {
                const d = parseTimeline(raw);
                const has = d && (
                    (d.tracks && d.tracks.length)
                    || (d.sections && d.sections.length)
                );
                if (!has || d.__empty) return { ok: false, error: 'Пустой таймлайн' };
                const L = layoutTimeline(d);
                const r = generateTimelineSVG(L, palette);
                svg = r.svg; width = r.width; height = r.height;
            } else if ((layout === 'rollout' || layout === 'lanes' || layout === 'ribbon')
                && typeof parseRollout === 'function') {
                const d = parseRollout(raw);
                if (!d || !d.phases || !d.phases.length) return { ok: false, error: 'Пустой роллаут' };
                let L; let r;
                if (layout === 'lanes' && typeof layoutLanes === 'function') {
                    L = layoutLanes(d);
                    r = generateLanesSVG(L, palette);
                } else if (layout === 'ribbon' && typeof layoutRibbon === 'function') {
                    L = layoutRibbon(d);
                    r = generateRibbonSVG(L, palette);
                } else {
                    L = layoutRollout(d);
                    r = generateRolloutSVG(L, palette);
                }
                svg = r.svg; width = r.width; height = r.height;
            } else if (layout === 'state' && typeof parseState === 'function') {
                const d = parseState(raw);
                if (!d || !d.states || !d.states.length) return { ok: false, error: 'Пустые состояния' };
                const L = layoutState(d);
                const r = generateStateSVG(L, palette);
                svg = r.svg; width = r.width; height = r.height;
            } else if (layout === 'journey' && typeof parseJourney === 'function') {
                const d = parseJourney(raw);
                if (!d || !d.stages || !d.stages.length) return { ok: false, error: 'Пустой путь' };
                const L = layoutJourney(d);
                const r = generateJourneySVG(L, palette);
                svg = r.svg; width = r.width; height = r.height;
            } else if (layout === 'context' && typeof parseContext === 'function') {
                const d = parseContext(raw);
                if (!d || !d.nodes || !d.nodes.length) return { ok: false, error: 'Пустой контекст' };
                const L = layoutContext(d);
                const r = generateContextSVG(L, palette);
                svg = r.svg; width = r.width; height = r.height;
            } else if (layout === 'waterfall' && typeof parseWaterfall === 'function') {
                const d = parseWaterfall(raw);
                if (!d || !d.steps || !d.steps.length) return { ok: false, error: 'Пустой водопад' };
                const L = layoutWaterfall(d);
                const r = generateWaterfallSVG(L, palette);
                svg = r.svg; width = r.width; height = r.height;
            } else if (layout === 'fan' && typeof parseFan === 'function') {
                const d = parseFan(raw);
                if (!d || !d.axes || !d.axes.length) return { ok: false, error: 'Пустой веер' };
                const L = layoutFan(d);
                const r = generateFanSVG(L, palette);
                svg = r.svg; width = r.width; height = r.height;
            } else if (layout === 'wave' && typeof parseWave === 'function') {
                const d = parseWave(raw);
                if (!d || !d.links || !d.links.length) return { ok: false, error: 'Пустая волна' };
                const L = layoutWave(d);
                const r = generateWaveSVG(L, palette);
                svg = r.svg; width = r.width; height = r.height;
            } else if (layout === 'sankey' && typeof parseSankey === 'function') {
                const d = parseSankey(raw);
                if (!d || !d.links || !d.links.length) return { ok: false, error: 'Пустой sankey' };
                const L = layoutSankey(d);
                const r = generateSankeySVG(L, palette);
                svg = r.svg; width = r.width; height = r.height;
            } else if (layout === 'pulsewave' && typeof parsePulsewave === 'function') {
                const d = parsePulsewave(raw);
                if (!d || !d.series || !d.series.length) return { ok: false, error: 'Пустая динамика' };
                const L = layoutPulsewave(d);
                const r = generatePulsewaveSVG(L, palette);
                svg = r.svg; width = r.width; height = r.height;
            } else if (layout === 'secret' && typeof parseSecret === 'function') {
                const d = parseSecret(raw);
                if (!d || !d.columns || !d.columns.length) return { ok: false, error: 'Пустой канбан' };
                const L = layoutSecret(d);
                const r = generateSecretSVG(L, palette);
                svg = r.svg; width = r.width; height = r.height;
            } else if (layout === 'gantt' && typeof parseGantt === 'function') {
                const d = parseGantt(raw);
                if (!d) return { ok: false, error: 'Пустой гант' };
                const L = layoutGantt(d);
                const r = generateGanttSVG(L, palette);
                svg = r.svg; width = r.width; height = r.height;
            } else if (layout === 'treemap' && typeof parseTreemap === 'function') {
                const d = parseTreemap(raw);
                if (!d || !d.root) return { ok: false, error: 'Пустые плитки' };
                const L = layoutTreemap(d);
                const r = generateTreemapSVG(L, palette);
                svg = r.svg; width = r.width; height = r.height;
            } else if (layout === 'heatmap' && typeof parseHeatmap === 'function') {
                const d = parseHeatmap(raw);
                if (!d || !d.matrix || !d.matrix.length) return { ok: false, error: 'Пустая тепловая карта' };
                const L = layoutHeatmap(d);
                const r = generateHeatmapSVG(L, palette);
                svg = r.svg; width = r.width; height = r.height;
            } else if (layout === 'sequence' && typeof parseSequence === 'function') {
                const d = parseSequence(raw);
                if (!d || !d.participants) return { ok: false, error: 'Пустая последовательность' };
                const L = layoutSequence(d.participants, d.items, { title: d.title });
                const r = generateSequenceSVG(L, palette);
                svg = r.svg; width = r.width; height = r.height;
            } else if (layout === 'bpmn' && typeof parseBPMN === 'function') {
                const d = parseBPMN(raw);
                if (!d) return { ok: false, error: 'Пустой BPMN' };
                const L = layoutBPMN(d);
                const r = generateBPMNSVG(L, palette);
                svg = r.svg; width = r.width; height = r.height;
            } else if (layout === 'ridgeline' && typeof parseRidgeline === 'function') {
                const d = parseRidgeline(raw);
                if (!d || !d.groups || !d.groups.length) return { ok: false, error: 'Пустые хребты' };
                const L = layoutRidgeline(d);
                const r = generateRidgelineSVG(L, palette);
                svg = r.svg; width = r.width; height = r.height;
            } else if (layout === 'reversibility' && typeof parseReversibility === 'function') {
                const d = parseReversibility(raw);
                if (!d || !d.nodes || !d.nodes.length) return { ok: false, error: 'Пустая карта обратимости' };
                const L = layoutReversibility(d);
                const r = generateReversibilitySVG(L, palette);
                svg = r.svg; width = r.width; height = r.height;
            } else if (layout === 'perspective' && typeof parsePerspective === 'function') {
                const d = parsePerspective(raw);
                if (!d || !d.perspectives || !d.perspectives.length) return { ok: false, error: 'Пустые перспективы' };
                const L = layoutPerspective(d);
                const r = generatePerspectiveSVG(L, palette);
                svg = r.svg; width = r.width; height = r.height;
            } else if ((layout === 'radial' || layout === 'classic' || layout === 'horizontal') && typeof parseTree === 'function') {
                const root = parseTree(raw);
                if (!root) return { ok: false, error: 'Пустое дерево' };
                if (typeof assignColors === 'function') assignColors(root, themeName);
                const spacingScale = (opts && opts.treeSpacingScales && typeof opts.treeSpacingScales[layout] === 'number')
                    ? opts.treeSpacingScales[layout]
                    : ((opts && typeof opts.treeSpacingScale === 'number' && layout !== 'classic')
                        ? opts.treeSpacingScale
                        : ((opts && typeof opts.classicSpacingScale === 'number' && layout === 'classic')
                            ? opts.classicSpacingScale
                            : (typeof getTreeSpacingScale === 'function' ? getTreeSpacingScale(layout) : 1)));
                const spacingOpts = { spacingScale };
                const r = layout === 'radial'
                    ? generateRadialSVG(root, spacingOpts)
                    : layout === 'classic'
                    ? generateClassicSVG(root, spacingOpts)
                    : generateHorizontalSVG(root, dir, spacingOpts);
                svg = r.svg; width = r.width; height = r.height;
            } else {
                return { ok: false, error: 'Тип схемы не поддерживает встройку: ' + layout };
            }

            if (!svg) return { ok: false, error: 'Не удалось отрисовать' };
            let svgString = new XMLSerializer().serializeToString(svg);
            if (typeof prepareExportSvg === 'function') {
                try {
                    const prep = prepareExportSvg(svg, { transparent: false });
                    if (prep && prep.svgString) svgString = prep.svgString;
                    if (prep && prep.w) width = prep.w;
                    if (prep && prep.h) height = prep.h;
                } catch (_) { /* keep raw */ }
            }
            const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString);
            return { ok: true, svgString, dataUrl, width, height, title: (opts.title || '') };
        } catch (e) {
            return { ok: false, error: (e && e.message) ? e.message : String(e) };
        }
    }

    function renderByRef(ref, opts) {
        opts = opts || {};
        const lib = global.diagramLibrary;
        if (!lib) return { ok: false, error: 'Библиотека схем не загружена' };
        let entry = null;
        let s = String(ref || '').trim();
        if (!s) return { ok: false, error: 'Не указан id или название схемы' };
        const wantPin = !!(opts.preferPin || opts.pin);
        s = s.replace(/\s+pin\s*$/i, '').trim();
        const idOnly = s.replace(/^id:\s*/i, '');
        if (typeof lib.findById === 'function') entry = lib.findById(idOnly);
        if (!entry && typeof lib.findByTitle === 'function') entry = lib.findByTitle(s);
        if (!entry && idOnly !== s && typeof lib.findByTitle === 'function') entry = lib.findByTitle(idOnly);
        if (!entry) return { ok: false, error: 'Схема не найдена в библиотеке: ' + s };

        if (wantPin && entry.preview && entry.preview.dataUrl) {
            return {
                ok: true,
                dataUrl: entry.preview.dataUrl,
                width: entry.preview.width || 0,
                height: entry.preview.height || 0,
                title: entry.title || '',
                pinned: true
            };
        }
        if (wantPin) {
            return {
                ok: false,
                error: 'Нет закреплённого снимка — откройте схему в Диаграммах и нажмите «Обновить» / «Сохранить»',
                pinMissing: true,
                title: entry.title || ''
            };
        }

        const snap = renderEntry(entry);
        if (snap.ok) snap.title = entry.title || snap.title;
        return snap;
    }

    /** Сохранить SVG-превью в запись (для :::схема … pin и экспорта). */
    function buildPreviewForEntry(entry) {
        const snap = renderEntry(entry);
        if (!snap || !snap.ok || !snap.dataUrl) return null;
        if (String(snap.dataUrl).length > 350000) return null; // не раздуваем localStorage
        return {
            dataUrl: snap.dataUrl,
            width: snap.width || 0,
            height: snap.height || 0,
            at: Date.now()
        };
    }

    async function svgDataUrlToPngBlob(dataUrl) {
        const src = String(dataUrl || '');
        if (!src) throw new Error('empty');
        const img = await new Promise((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error('svg load'));
            el.src = src;
        });
        let w = img.naturalWidth || 800;
        let h = img.naturalHeight || 450;
        const maxW = 1600;
        const scale = w > maxW ? maxW / w : 1;
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no canvas');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return new Promise((resolve, reject) => {
            canvas.toBlob((blob) => {
                if (blob) resolve(blob);
                else reject(new Error('png failed'));
            }, 'image/png');
        });
    }

    global.diagramSnapshot = {
        renderEntry,
        renderLayoutText,
        renderByRef,
        buildPreviewForEntry,
        svgDataUrlToPngBlob
    };
})(typeof window !== 'undefined' ? window : globalThis);
