/* Построение схемы для Симметрики: функция generateMindmap из DocPlan js/main.js
 * (строки 392–947) целиком; вместо вставки в страницу «mountDiagramCanvas»
 * запоминает, что получилось — SVG, размер, диагностику или текст пустого
 * состояния, — и это возвращается вызывающему. */
var simRenderDiagram = (function () {
    var container = null;
    var scalable = null;
    var currentLayout = 'radial';
    var currentTheme = 'soft';
    var hierarchyDirection = 'lr';
    var rawText = '';
    var result = null;
    var DIAGRAM_LAYOUT_LABELS = window.DIAGRAM_LAYOUT_LABELS || {};
    function getRawText() { return rawText; }
    function mountDiagramCanvas(_container, opts) {
        result = Object.assign({}, opts || {});
        var svg = result.svg;
        if (svg) {
            // As DocPlan's mountDiagramCanvas: logical size, a viewBox, the diagram's font.
            if (!svg.getAttribute('role')) {
                svg.setAttribute('role', 'img');
                svg.setAttribute('aria-label', result.ariaLabel || 'Диаграмма');
            }
            if (result.width) svg.setAttribute('data-logical-w', String(result.width));
            if (result.height) svg.setAttribute('data-logical-h', String(result.height));
            if (!svg.getAttribute('viewBox') && result.width && result.height) svg.setAttribute('viewBox', '0 0 ' + result.width + ' ' + result.height);
            var fontFam = typeof getUiFontFamily === 'function' ? getUiFontFamily() : '';
            if (fontFam) {
                svg.style.fontFamily = fontFam;
                svg.setAttribute('font-family', fontFam);
            }
        }
        // Hints on how the text is written, as DocPlan adds them when it shows a diagram.
        try {
            if (typeof collectDiagramStyleHints === 'function' && rawText) {
                result.diagnostics = mergeDiagnostics(result.diagnostics, collectDiagramStyleHints(rawText, currentLayout));
            }
        } catch (_) { /* ignore */ }
        return {};
    }
    function finishDiagramMount() {}
    function mountBlockedOrEmpty(_container, _keepView, diagnostics, emptyMessage) {
        result = { emptyMessage: emptyMessage || 'Исправьте ошибки в тексте — схема не построена', diagnostics: diagnostics || [], blocked: true };
    }
    function shouldBlockDiagram(diagnostics) {
        return typeof diagnosticsBlockRender === 'function' && diagnosticsBlockRender(diagnostics);
    }
    function updateHierarchyDirUI() {}
function softSequenceColor(hex) {
    const raw = String(hex || '').trim();
    const m = /^#?([0-9a-f]{6})$/i.exec(raw);
    if (!m) return raw || '#64748b';
    const n = parseInt(m[1], 16);
    let r = (n >> 16) & 255;
    let g = (n >> 8) & 255;
    let b = n & 255;
    const isDark = document.body.classList.contains('dark');
    // Тянем к серо-синему нейтралу (~slate), не в белый — чтобы цвет оставался узнаваемым
    const nr = isDark ? 148 : 100;
    const ng = isDark ? 163 : 116;
    const nb = isDark ? 184 : 139;
    const t = isDark ? 0.42 : 0.48;
    r = Math.round(r * (1 - t) + nr * t);
    g = Math.round(g * (1 - t) + ng * t);
    b = Math.round(b * (1 - t) + nb * t);
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}
function generateMindmap(keepView = false) {
    const raw = getRawText();
    const label = DIAGRAM_LAYOUT_LABELS[currentLayout] || 'Диаграмма';
    if (typeof mountDiagramCanvas !== 'function') {
        console.error('[diagrams] mountDiagramCanvas не загружен (проверьте js/utils.js)');
        if (container) {
            container.textContent = '';
            const p = document.createElement('p');
            p.className = 'diagram-error-msg';
            p.textContent = 'Не загружен модуль диаграмм. Обновите страницу с очисткой кэша (Cmd+Shift+R).';
            container.appendChild(p);
        }
        scalable = null;
        return;
    }

    try {
        if (currentLayout === 'wave') {
            const waveData = parseWave(raw);
            if (!waveData || !waveData.links || !waveData.links.length) {
                const mounted = mountDiagramCanvas(container, {
                    emptyMessage: 'Введите связи вида «A -> B: 10» для волнообразной диаграммы',
                    diagnostics: waveData && waveData.diagnostics
                });
                finishDiagramMount(mounted, keepView, waveData && waveData.diagnostics);
                return;
            }
            const layout = layoutWave(waveData);
            const { svg, width, height } = generateWaveSVG(layout, themes[currentTheme]);
            const diagnostics = mergeDiagnostics(waveData, layout);
            if (shouldBlockDiagram(diagnostics)) {
                mountBlockedOrEmpty(container, keepView, diagnostics,
                    'Есть критические ошибки — схема не построена. Смотрите диагностику ниже.');
                return;
            }
            const mounted = mountDiagramCanvas(container, {
                svg, width, height, diagnostics, ariaLabel: label
            });
            finishDiagramMount(mounted, keepView, diagnostics);
            return;
        }

        if (currentLayout === 'sankey') {
            const sankeyData = parseSankey(raw);
            if (!sankeyData || !sankeyData.links || !sankeyData.links.length) {
                const mounted = mountDiagramCanvas(container, {
                    emptyMessage: 'Введите потоки вида «A -> B: 10» для диаграммы потоков (Sankey)',
                    diagnostics: sankeyData && sankeyData.diagnostics
                });
                finishDiagramMount(mounted, keepView, sankeyData && sankeyData.diagnostics);
                return;
            }
            const layout = layoutSankey(sankeyData);
            const { svg, width, height } = generateSankeySVG(layout, themes[currentTheme]);
            const diagnostics = mergeDiagnostics(sankeyData, layout);
            if (shouldBlockDiagram(diagnostics)) {
                mountBlockedOrEmpty(container, keepView, diagnostics,
                    'Есть критические ошибки — схема не построена. Смотрите диагностику ниже.');
                return;
            }
            const mounted = mountDiagramCanvas(container, {
                svg, width, height, diagnostics, ariaLabel: label
            });
            finishDiagramMount(mounted, keepView, diagnostics);
            return;
        }

        if (currentLayout === 'pulsewave') {
            const pulseData = parsePulsewave(raw);
            if (!pulseData || !pulseData.series || !pulseData.series.length) {
                const mounted = mountDiagramCanvas(container, {
                    emptyMessage: 'Введите ряды вида «Продажи: 70, 45, 60» или «Продажи 70 -> Продажи 45 -> Продажи 60»',
                    diagnostics: pulseData && pulseData.diagnostics
                });
                finishDiagramMount(mounted, keepView, pulseData && pulseData.diagnostics);
                return;
            }
            const layout = layoutPulsewave(pulseData);
            const { svg, width, height } = generatePulsewaveSVG(layout, themes[currentTheme]);
            const diagnostics = mergeDiagnostics(pulseData, layout);
            if (shouldBlockDiagram(diagnostics)) {
                mountBlockedOrEmpty(container, keepView, diagnostics,
                    'Есть критические ошибки — схема не построена. Смотрите диагностику ниже.');
                return;
            }
            const mounted = mountDiagramCanvas(container, {
                svg, width, height, diagnostics, ariaLabel: label
            });
            finishDiagramMount(mounted, keepView, diagnostics);
            return;
        }

        if (currentLayout === 'secret') {
            const kanbanData = parseSecret(raw);
            if (!kanbanData || !kanbanData.columns || !kanbanData.columns.length) {
                const mounted = mountDiagramCanvas(container, {
                    emptyMessage: 'Добавьте «колонка …» и «задача: …» для Kanban-доски',
                    diagnostics: kanbanData && kanbanData.diagnostics
                });
                finishDiagramMount(mounted, keepView, kanbanData && kanbanData.diagnostics);
                return;
            }
            const layout = layoutSecret(kanbanData);
            const { svg, width, height } = generateSecretSVG(layout, themes[currentTheme]);
            const diagnostics = mergeDiagnostics(kanbanData, layout);
            if (shouldBlockDiagram(diagnostics)) {
                mountBlockedOrEmpty(container, keepView, diagnostics,
                    'Есть критические ошибки — схема не построена. Смотрите диагностику ниже.');
                return;
            }
            const mounted = mountDiagramCanvas(container, {
                svg, width, height, diagnostics, ariaLabel: label
            });
            finishDiagramMount(mounted, keepView, diagnostics);
            return;
        }

        if (currentLayout === 'bpmn') {
            const bpmnData = parseBPMN(raw);
            if (!bpmnData || !bpmnData.elements.length) {
                const mounted = mountDiagramCanvas(container, {
                    emptyMessage: 'Опишите процесс: дорожки, задачи, события и связи →',
                    diagnostics: bpmnData && bpmnData.diagnostics
                });
                finishDiagramMount(mounted, keepView, bpmnData && bpmnData.diagnostics);
                return;
            }
            const layout = layoutBPMN(bpmnData);
            const { svg, width, height } = generateBPMNSVG(layout, themes[currentTheme]);
            const diagnostics = mergeDiagnostics(bpmnData, layout);
            if (shouldBlockDiagram(diagnostics)) {
                mountBlockedOrEmpty(container, keepView, diagnostics,
                    'Есть критические ошибки — схема не построена. Смотрите диагностику ниже.');
                return;
            }
            const mounted = mountDiagramCanvas(container, {
                svg, width, height, diagnostics, ariaLabel: label
            });
            finishDiagramMount(mounted, keepView, diagnostics);
            return;
        }

        if (currentLayout === 'sequence') {
            const seqData = parseSequence(raw);
            if (!seqData || !seqData.participants || seqData.participants.length === 0) {
                const mounted = mountDiagramCanvas(container, {
                    emptyMessage: 'Добавьте участников и сообщения «A -> B: текст»',
                    diagnostics: seqData && seqData.diagnostics
                });
                finishDiagramMount(mounted, keepView, seqData && seqData.diagnostics);
                return;
            }
            const palette = themes[currentTheme];
            seqData.participants.forEach((p, i) => {
                // Sequence: приглушённые цвета (палитры mindmap слишком пёстрые для lifeline/стрелок)
                p.color = softSequenceColor(palette[i % palette.length]);
            });
            const layoutData = layoutSequence(seqData.participants, seqData.items, {
                startX: 100, startY: seqData.title ? 100 : 80, gapX: 180, gapY: 40,
                title: seqData.title || ''
            });
            const { svg, width, height } = generateSequenceSVG(layoutData, themes[currentTheme]);
            const diagnostics = mergeDiagnostics(seqData, layoutData);
            if (shouldBlockDiagram(diagnostics)) {
                mountBlockedOrEmpty(container, keepView, diagnostics,
                    'Есть критические ошибки — схема не построена. Смотрите диагностику ниже.');
                return;
            }
            const mounted = mountDiagramCanvas(container, {
                svg, width, height, diagnostics, ariaLabel: label
            });
            finishDiagramMount(mounted, keepView, diagnostics);
            return;
        }

        if (currentLayout === 'gantt') {
            const ganttData = parseGantt(raw);
            if (!ganttData || !ganttData.sections || ganttData.sections.length === 0) {
                const mounted = mountDiagramCanvas(container, {
                    emptyMessage: 'Добавьте разделы и задачи для диаграммы Ганта',
                    diagnostics: ganttData && ganttData.diagnostics
                });
                finishDiagramMount(mounted, keepView, ganttData && ganttData.diagnostics);
                return;
            }
            const layout = layoutGantt(ganttData);
            const { svg, width, height } = generateGanttSVG(layout, themes[currentTheme]);
            const diagnostics = mergeDiagnostics(ganttData, layout);
            if (shouldBlockDiagram(diagnostics)) {
                mountBlockedOrEmpty(container, keepView, diagnostics,
                    'Есть критические ошибки — схема не построена. Смотрите диагностику ниже.');
                return;
            }
            const mounted = mountDiagramCanvas(container, {
                svg, width, height, diagnostics, ariaLabel: label
            });
            finishDiagramMount(mounted, keepView, diagnostics);
            return;
        }

        if (currentLayout === 'treemap') {
            const treemapData = parseTreemap(raw);
            if (!treemapData || !treemapData.root) {
                const mounted = mountDiagramCanvas(container, {
                    emptyMessage: 'Иерархия отступами; у листьев укажите значение: «Имя: 10»',
                    diagnostics: treemapData && treemapData.diagnostics
                });
                finishDiagramMount(mounted, keepView, treemapData && treemapData.diagnostics);
                return;
            }
            const layout = layoutTreemap(treemapData);
            const { svg, width, height } = generateTreemapSVG(layout, themes[currentTheme]);
            const diagnostics = mergeDiagnostics(treemapData, layout);
            if (shouldBlockDiagram(diagnostics)) {
                mountBlockedOrEmpty(container, keepView, diagnostics,
                    'Есть критические ошибки — схема не построена. Смотрите диагностику ниже.');
                return;
            }
            const mounted = mountDiagramCanvas(container, {
                svg, width, height, diagnostics, ariaLabel: label
            });
            finishDiagramMount(mounted, keepView, diagnostics);
            return;
        }

        if (currentLayout === 'heatmap') {
            const heatData = parseHeatmap(raw);
            if (!heatData || !heatData.matrix || !heatData.matrix.length) {
                const mounted = mountDiagramCanvas(container, {
                    emptyMessage: 'ось X: Пн, Вт… · Backend: 2, 5, 8 — или вставьте таблицу из Excel',
                    diagnostics: heatData && heatData.diagnostics
                });
                finishDiagramMount(mounted, keepView, heatData && heatData.diagnostics);
                return;
            }
            const layout = layoutHeatmap(heatData);
            const { svg, width, height } = generateHeatmapSVG(layout, themes[currentTheme]);
            const diagnostics = mergeDiagnostics(heatData, layout);
            if (shouldBlockDiagram(diagnostics)) {
                mountBlockedOrEmpty(container, keepView, diagnostics,
                    'Есть критические ошибки — схема не построена. Смотрите диагностику ниже.');
                return;
            }
            const mounted = mountDiagramCanvas(container, {
                svg, width, height, diagnostics, ariaLabel: label
            });
            finishDiagramMount(mounted, keepView, diagnostics);
            return;
        }


        if (currentLayout === 'reversibility') {
            const revData = parseReversibility(raw);
            if (!revData || !revData.nodes || !revData.nodes.length) {
                const mounted = mountDiagramCanvas(container, {
                    emptyMessage: 'Решение: боль, откат [, факт|гипотеза]. Связь: A -> B: 3',
                    diagnostics: revData && revData.diagnostics
                });
                finishDiagramMount(mounted, keepView, revData && revData.diagnostics);
                return;
            }
            const layout = layoutReversibility(revData);
            const { svg, width, height } = generateReversibilitySVG(layout, themes[currentTheme]);
            const diagnostics = mergeDiagnostics(revData, layout);
            if (shouldBlockDiagram(diagnostics)) {
                mountBlockedOrEmpty(container, keepView, diagnostics,
                    'Есть критические ошибки — схема не построена. Смотрите диагностику ниже.');
                return;
            }
            const mounted = mountDiagramCanvas(container, {
                svg, width, height, diagnostics, ariaLabel: label
            });
            finishDiagramMount(mounted, keepView, diagnostics);
            return;
        }

        if (currentLayout === 'perspective') {
            const perspData = parsePerspective(raw);
            if (!perspData || !perspData.perspectives || !perspData.perspectives.length) {
                const mounted = mountDiagramCanvas(container, {
                    emptyMessage: 'Роль: [Пользователь], дерево отступами; связь сущностей: = A | B | C',
                    diagnostics: perspData && perspData.diagnostics
                });
                finishDiagramMount(mounted, keepView, perspData && perspData.diagnostics);
                return;
            }
            const layout = layoutPerspective(perspData);
            const { svg, width, height } = generatePerspectiveSVG(layout, themes[currentTheme]);
            const diagnostics = mergeDiagnostics(perspData, layout);
            if (shouldBlockDiagram(diagnostics)) {
                mountBlockedOrEmpty(container, keepView, diagnostics,
                    'Есть критические ошибки — схема не построена. Смотрите диагностику ниже.');
                return;
            }
            const mounted = mountDiagramCanvas(container, {
                svg, width, height, diagnostics, ariaLabel: label
            });
            finishDiagramMount(mounted, keepView, diagnostics);
            return;
        }

        if (currentLayout === 'fan') {
            const fanData = parseFan(raw);
            if (!fanData || !fanData.axes || !fanData.axes.length || !fanData.series || !fanData.series.length) {
                const mounted = mountDiagramCanvas(container, {
                    emptyMessage: 'вес: Скорость 90, Качество 50\nПродукт A: 80, 60',
                    diagnostics: fanData && fanData.diagnostics
                });
                finishDiagramMount(mounted, keepView, fanData && fanData.diagnostics);
                return;
            }
            const layout = layoutFan(fanData);
            const { svg, width, height } = generateFanSVG(layout, themes[currentTheme]);
            const diagnostics = mergeDiagnostics(fanData, layout);
            if (shouldBlockDiagram(diagnostics)) {
                mountBlockedOrEmpty(container, keepView, diagnostics,
                    'Есть критические ошибки — схема не построена. Смотрите диагностику ниже.');
                return;
            }
            const mounted = mountDiagramCanvas(container, {
                svg, width, height, diagnostics, ariaLabel: label
            });
            finishDiagramMount(mounted, keepView, diagnostics);
            return;
        }

        if (currentLayout === 'ridgeline') {
            const ridgeData = parseRidgeline(raw);
            if (!ridgeData || !ridgeData.groups || !ridgeData.groups.length) {
                const mounted = mountDiagramCanvas(container, {
                    emptyMessage: 'Группа: 1.2, 3.4, 5.6, 7.8',
                    diagnostics: ridgeData && ridgeData.diagnostics
                });
                finishDiagramMount(mounted, keepView, ridgeData && ridgeData.diagnostics);
                return;
            }
            const layout = layoutRidgeline(ridgeData);
            const { svg, width, height } = generateRidgelineSVG(layout, themes[currentTheme]);
            const diagnostics = mergeDiagnostics(ridgeData, layout);
            if (shouldBlockDiagram(diagnostics)) {
                mountBlockedOrEmpty(container, keepView, diagnostics,
                    'Есть критические ошибки — схема не построена. Смотрите диагностику ниже.');
                return;
            }
            const mounted = mountDiagramCanvas(container, {
                svg, width, height, diagnostics, ariaLabel: label
            });
            finishDiagramMount(mounted, keepView, diagnostics);
            return;
        }

        if (currentLayout === 'waterfall') {
            const wfData = parseWaterfall(raw);
            if (!wfData || !wfData.steps || !wfData.steps.length) {
                const mounted = mountDiagramCanvas(container, {
                    emptyMessage: 'Старт: 50\nВыручка: +120\nСкидки: -15\nИтог',
                    diagnostics: wfData && wfData.diagnostics
                });
                finishDiagramMount(mounted, keepView, wfData && wfData.diagnostics);
                return;
            }
            const layout = layoutWaterfall(wfData);
            const { svg, width, height } = generateWaterfallSVG(layout, themes[currentTheme]);
            const diagnostics = mergeDiagnostics(wfData, layout);
            if (shouldBlockDiagram(diagnostics)) {
                mountBlockedOrEmpty(container, keepView, diagnostics,
                    'Есть критические ошибки — схема не построена. Смотрите диагностику ниже.');
                return;
            }
            const mounted = mountDiagramCanvas(container, {
                svg, width, height, diagnostics, ariaLabel: label
            });
            finishDiagramMount(mounted, keepView, diagnostics);
            return;
        }

        if (currentLayout === 'flowchart') {
            const fcData = parseFlowchart(raw);
            if (!fcData || !fcData.nodes || !fcData.nodes.length) {
                const mounted = mountDiagramCanvas(container, {
                    emptyMessage: '[Старт] -> {Нужна проверка?}\n{Нужна проверка?} -> [Да]: да',
                    diagnostics: fcData && fcData.diagnostics
                });
                finishDiagramMount(mounted, keepView, fcData && fcData.diagnostics);
                return;
            }
            let layout = layoutFlowchart(fcData);
            if (typeof applyFlowchartManualOffsets === 'function'
                && typeof getLayoutOverrides === 'function') {
                layout = applyFlowchartManualOffsets(layout, getLayoutOverrides());
            }
            const { svg, width, height } = generateFlowchartSVG(layout, themes[currentTheme]);
            const diagnostics = mergeDiagnostics(fcData, layout);
            if (shouldBlockDiagram(diagnostics)) {
                mountBlockedOrEmpty(container, keepView, diagnostics,
                    'Есть критические ошибки — схема не построена. Смотрите диагностику ниже.');
                return;
            }
            const mounted = mountDiagramCanvas(container, {
                svg, width, height, diagnostics, ariaLabel: label
            });
            finishDiagramMount(mounted, keepView, diagnostics);
            if (typeof bindManualLayout === 'function') {
                bindManualLayout(svg);
            } else if (typeof bindFlowchartManualLayout === 'function') {
                bindFlowchartManualLayout(svg, layout);
            }
            return;
        }

        if (currentLayout === 'timeline') {
            const tlData = parseTimeline(raw);
            const hasTracks = tlData && (
                (tlData.tracks && tlData.tracks.length)
                || (tlData.sections && tlData.sections.length)
            );
            if (!hasTracks) {
                const mounted = mountDiagramCanvas(container, {
                    emptyMessage: 'название: Roadmap\nраздел: Запуск\nОктябрь: Релиз',
                    diagnostics: tlData && tlData.diagnostics
                });
                finishDiagramMount(mounted, keepView, tlData && tlData.diagnostics);
                return;
            }
            const layout = layoutTimeline(tlData);
            const { svg, width, height } = generateTimelineSVG(layout, themes[currentTheme]);
            const diagnostics = mergeDiagnostics(tlData, layout);
            if (shouldBlockDiagram(diagnostics)) {
                mountBlockedOrEmpty(container, keepView, diagnostics,
                    'Есть критические ошибки — схема не построена. Смотрите диагностику ниже.');
                return;
            }
            const mounted = mountDiagramCanvas(container, {
                svg, width, height, diagnostics, ariaLabel: label
            });
            finishDiagramMount(mounted, keepView, diagnostics);
            return;
        }

        if (currentLayout === 'rollout' || currentLayout === 'lanes' || currentLayout === 'ribbon') {
            const roData = parseRollout(raw);
            if (!roData || !roData.phases || !roData.phases.length) {
                const mounted = mountDiagramCanvas(container, {
                    emptyMessage: 'фаза: Подготовка\n  Анализ рынка @Продукт',
                    diagnostics: roData && roData.diagnostics
                });
                finishDiagramMount(mounted, keepView, roData && roData.diagnostics);
                return;
            }
            let svg; let width; let height; let layout;
            if (currentLayout === 'lanes') {
                layout = layoutLanes(roData);
                ({ svg, width, height } = generateLanesSVG(layout, themes[currentTheme]));
            } else if (currentLayout === 'ribbon') {
                layout = layoutRibbon(roData);
                ({ svg, width, height } = generateRibbonSVG(layout, themes[currentTheme]));
            } else {
                layout = layoutRollout(roData);
                ({ svg, width, height } = generateRolloutSVG(layout, themes[currentTheme]));
            }
            const diagnostics = mergeDiagnostics(roData, layout);
            if (shouldBlockDiagram(diagnostics)) {
                mountBlockedOrEmpty(container, keepView, diagnostics,
                    'Есть критические ошибки — схема не построена. Смотрите диагностику ниже.');
                return;
            }
            const mounted = mountDiagramCanvas(container, {
                svg, width, height, diagnostics, ariaLabel: label
            });
            finishDiagramMount(mounted, keepView, diagnostics);
            return;
        }

        if (currentLayout === 'journey') {
            const jData = parseJourney(raw);
            if (!jData || !jData.stages || !jData.stages.length) {
                const mounted = mountDiagramCanvas(container, {
                    emptyMessage: 'этап: Осознание\n  касание: …\n  эмоция: 3',
                    diagnostics: jData && jData.diagnostics
                });
                finishDiagramMount(mounted, keepView, jData && jData.diagnostics);
                return;
            }
            const layout = layoutJourney(jData);
            const { svg, width, height } = generateJourneySVG(layout, themes[currentTheme]);
            const diagnostics = mergeDiagnostics(jData, layout);
            if (shouldBlockDiagram(diagnostics)) {
                mountBlockedOrEmpty(container, keepView, diagnostics,
                    'Есть критические ошибки — схема не построена. Смотрите диагностику ниже.');
                return;
            }
            const mounted = mountDiagramCanvas(container, {
                svg, width, height, diagnostics, ariaLabel: label
            });
            finishDiagramMount(mounted, keepView, diagnostics);
            return;
        }

        // Древовидные режимы (radial, classic и horizontal):
        // одинаковый отступ = соседи, больший = вложенность (и для →, и для ↓)
        // Для иерархии: «направление: вертикаль|горизонт» в тексте (или кнопки →/↓)
        let hierDir = hierarchyDirection;
        if (currentLayout === 'horizontal') {
            const dirMatch = String(raw || '').match(
                /^(?:направление|direction)\s*:\s*(вертикал\w*|tb|top[\s-]*down|горизонт\w*|lr|left[\s-]*right)\s*$/im
            );
            if (dirMatch) {
                const v = String(dirMatch[1] || '').toLowerCase();
                hierDir = /вертикал|tb|top/.test(v) ? 'tb' : 'lr';
                if (hierDir !== hierarchyDirection) {
                    hierarchyDirection = hierDir;
                    if (typeof updateHierarchyDirUI === 'function') updateHierarchyDirUI();
                }
            }
        }
        const root = parseTree(raw);
        if (!root) {
            const mounted = mountDiagramCanvas(container, {
                emptyMessage: 'Введите текст с отступами — корень и ветви'
            });
            finishDiagramMount(mounted, keepView, []);
            return;
        }
        assignColors(root, currentTheme);
        const spacingScale = typeof getTreeSpacingScale === 'function'
            ? getTreeSpacingScale(currentLayout)
            : 1;
        const spacingOpts = { spacingScale };
        const rendered = currentLayout === 'radial'
            ? generateRadialSVG(root, spacingOpts)
            : currentLayout === 'classic'
            ? generateClassicSVG(root, spacingOpts)
            : generateHorizontalSVG(root, hierDir, spacingOpts);
        const diagnostics = mergeDiagnostics(root);
        const mounted = mountDiagramCanvas(container, {
            svg: rendered.svg,
            width: rendered.width,
            height: rendered.height,
            diagnostics,
            ariaLabel: label
        });
        finishDiagramMount(mounted, keepView, diagnostics);
        if (typeof bindManualLayout === 'function') {
            bindManualLayout(rendered.svg);
        } else if (typeof bindFlowchartManualLayout === 'function') {
            bindFlowchartManualLayout(rendered.svg, null);
        }
        return;
    } catch (e) {
        const mounted = mountDiagramCanvas(container, {
            errorMessage: 'Ошибка построения: ' + (e && e.message ? e.message : String(e))
        });
        finishDiagramMount(mounted, keepView, []);
    }
}

    return function render(opts) {
        rawText = String(opts.text || '');
        currentLayout = opts.layout || 'radial';
        currentTheme = opts.theme || 'soft';
        hierarchyDirection = opts.direction === 'tb' ? 'tb' : 'lr';
        result = null;
        generateMindmap(false);
        var r = result || { emptyMessage: 'Пусто' };
        r.direction = hierarchyDirection;
        return r;
    };
})();
