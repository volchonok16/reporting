/* Связка движка схем (DocPlan) с Симметрикой: всё, что нужно редактору, —
 * в одном объекте window.SimmetrikaDiagrams. Движок рисует SVG по тексту;
 * тема (тёмная или светлая), шрифт и плотность веток задаются здесь на время
 * одного построения, как их ждут рендеры DocPlan (body.dark, --diagram-font,
 * treeSpacingScales). */
(function () {
    'use strict';
    var FAMILY = { radial: 'tree', classic: 'tree', horizontal: 'tree', rollout: 'rollout', lanes: 'rollout', ribbon: 'rollout' };

    /** The CSS stack of a diagram's font: a name of DocPlan's list, or any family (Simmetrika: as on the canvas). */
    function fontStack(font) {
        if (DIAGRAM_FONTS[font]) return DIAGRAM_FONTS[font];
        if (!font || font === 'system-ui') return DIAGRAM_FONTS.system;
        return '"' + String(font).replace(/["\\]/g, '') + '", ' + DIAGRAM_FONTS.system;
    }

    function withLook(opts, fn) {
        var body = document.body;
        var wasDark = body.classList.contains('dark');
        var root = document.documentElement;
        var prevFont = root.style.getPropertyValue('--diagram-font');
        body.classList.toggle('dark', !!opts.dark);
        root.style.setProperty('--diagram-font', fontStack(opts.font));
        if (opts.spacing) window.treeSpacingScales = normalizeTreeSpacingScales(opts.spacing);
        // Read as globals by parts of the engine (the soft palette, spacing, manual layout).
        window.currentTheme = opts.theme;
        window.currentLayout = opts.layout;
        try {
            return fn();
        } finally {
            body.classList.toggle('dark', wasDark);
            if (prevFont) root.style.setProperty('--diagram-font', prevFont);
            else root.style.removeProperty('--diagram-font');
        }
    }

    window.SimmetrikaDiagrams = {
        layouts: VALID_DIAGRAM_LAYOUTS.slice(),
        labels: Object.assign({}, DIAGRAM_LAYOUT_LABELS),
        themes: VALID_DIAGRAM_THEMES.slice(),
        palettes: themes,
        fonts: DIAGRAM_FONTS,
        fontStack: fontStack,
        /** Layouts sharing one text (same syntax). */
        family: function (layout) { return FAMILY[layout] || layout; },
        /** The palette a layout is drawn with: some have colours of their own, some cannot be grey. */
        theme: function (layout, preferred) {
            var lockAll = layout === 'perspective' || layout === 'reversibility' || layout === 'heatmap';
            var lockMono = lockAll || ['wave', 'sankey', 'secret', 'treemap', 'fan', 'ridgeline', 'pulsewave'].indexOf(layout) >= 0;
            if (lockAll) return { theme: 'neutral', locked: 'all' };
            if (lockMono && preferred === 'mono') return { theme: 'neutral', locked: 'mono' };
            return { theme: themes[preferred] ? preferred : 'soft', locked: lockMono ? 'mono' : null };
        },
        /** Builds the picture: { svg, width, height, diagnostics, emptyMessage, errorMessage, direction }. */
        render: function (opts) {
            // Colours of one's own (Simmetrika): a palette of the moment, under a name of its own.
            if (opts.colors && opts.colors.length) {
                themes.__custom = opts.colors.slice();
                opts = Object.assign({}, opts, { theme: '__custom' });
            }
            var result = withLook(opts, function () { return simRenderDiagram(opts); });
            // Drawn in the font it was measured with (else the text took the page's font), and exported so.
            if (result && result.svg) {
                var stack = fontStack(opts.font);
                result.svg.setAttribute('font-family', stack);
                result.svg.style.fontFamily = stack;
                result.svg.setAttribute('data-font', stack);
            }
            return result;
        },
        /** HTML of the text with its syntax coloured (for the layer under the textarea). */
        highlight: function (text, layout) {
            return highlightSyntax(String(text || ''), layout === 'horizontal' || layout === 'classic' ? 'radial' : layout);
        },
        /** The example text of a layout. */
        example: function (layout, direction) {
            if (layout === 'horizontal') return direction === 'tb' ? (demos.horizontalVertical || demos.horizontal) : demos.horizontal;
            if (layout === 'lanes' || layout === 'ribbon') return demos[layout] || demos.rollout;
            return demos[layout] || demos.radial;
        },
        /** The reference of a layout's commands: { title, html }. */
        help: function (layout) { return simDiagramHelp(layout); },
        /**
         * The picture as a file (DocPlan's prepareExportSvg): framed by what is drawn, with the
         * background, or `transparent` — without the renderers' own background rect.
         */
        exportSvg: function (svg, opts) {
            var body = document.body;
            var prev = body.style.getPropertyValue('--diagram-bg');
            var root = document.documentElement;
            var prevFont = root.style.getPropertyValue('--diagram-font');
            body.style.setProperty('--diagram-bg', opts.background);
            // The export names the font of the picture (it read the page's font when none was set).
            if (svg.getAttribute('data-font')) root.style.setProperty('--diagram-font', svg.getAttribute('data-font'));
            try {
                return prepareExportSvg(svg, { transparent: !!opts.transparent });
            } finally {
                if (prevFont) root.style.setProperty('--diagram-font', prevFont);
                else root.style.removeProperty('--diagram-font');
                if (prev) body.style.setProperty('--diagram-bg', prev);
                else body.style.removeProperty('--diagram-bg');
            }
        },
        /** Removes a renderer's own full-size background rect (on the dotted canvas it shows as a slab). */
        stripBackground: function (svg) {
            try {
                stripFullCanvasBackgroundRect(svg, getSvgDeclaredBox(svg), getDiagramBackground());
            } catch (_) { /* ignore */ }
        },
        blocks: function (diagnostics) { return typeof diagnosticsBlockRender === 'function' && diagnosticsBlockRender(diagnostics); },
        spacing: {
            layouts: TREE_SPACING_LAYOUTS.slice(),
            presets: TREE_SPACING_PRESETS,
            min: function (layout) { return layout === 'radial' ? RADIAL_SPACING_MIN : TREE_SPACING_MIN; },
            max: TREE_SPACING_MAX,
            defaults: function () { return createDefaultTreeSpacingScales(); },
            clamp: function (v) { return clampTreeSpacingScale(v); }
        },
        manual: {
            supports: function (layout) { return typeof supportsManualLayout === 'function' ? !!supportsManualLayout(layout) : false; },
            enabled: function () { return isManualLayoutEnabled(); },
            setEnabled: function (on) { setManualLayoutEnabled(!!on, { save: false, rerender: false, syncTool: false }); },
            overrides: function () { return getLayoutOverrides(); },
            setOverrides: function (o) { setLayoutOverrides(o || { nodes: {} }, { save: false, rerender: false }); },
            clear: function () { clearLayoutOverrides(); },
            bind: function (svg) { if (typeof bindManualLayout === 'function') bindManualLayout(svg); },
            undo: function () { return undoManualLayout(); },
            redo: function () { return redoManualLayout(); }
        }
    };
})();
