/**
 * Плотность древовидных диаграмм: classic, radial, horizontal.
 */
const TREE_SPACING_LAYOUTS = ['classic', 'radial', 'horizontal'];
const TREE_SPACING_MIN = 0.5;
const RADIAL_SPACING_MIN = 0.75;
const TREE_SPACING_MAX = 2;
const TREE_SPACING_PRESETS = {
    compact: 0.75,
    normal: 1,
    spacious: 1.45
};
const TREE_SPACING_DEFAULTS = {
    radial: TREE_SPACING_PRESETS.normal,
    horizontal: TREE_SPACING_PRESETS.compact,
    classic: TREE_SPACING_PRESETS.compact
};

const CLASSIC_GAP_X = 190;
const CLASSIC_GAP_Y = 28;
const RADIAL_RADIUS_PER_LEVEL = 200;
const HORIZONTAL_GAP_X = 200;
const HORIZONTAL_GAP_Y = 40;
const HORIZONTAL_ORIGIN_X = 60;
const HORIZONTAL_ORIGIN_Y = 60;
const VERTICAL_PHASE_GAP_X = 44;
const VERTICAL_GAP_Y = 30;
const VERTICAL_NEST_GAP_X = 18;

function clampTreeSpacingScale(scale) {
    const n = Number(scale);
    if (!Number.isFinite(n)) return 1;
    return Math.min(TREE_SPACING_MAX, Math.max(TREE_SPACING_MIN, n));
}

function getTreeSpacingMin(layout) {
    return layout === 'radial' ? RADIAL_SPACING_MIN : TREE_SPACING_MIN;
}

function getEffectiveTreeSpacingScale(layout, scale) {
    const s = clampTreeSpacingScale(scale == null ? getTreeSpacingScale() : scale);
    return Math.max(getTreeSpacingMin(layout), s);
}

function getTreeSpacingSliderMinPct(layout) {
    return Math.round(getTreeSpacingMin(layout) * 100);
}

function createDefaultTreeSpacingScales() {
    return {
        radial: TREE_SPACING_DEFAULTS.radial,
        horizontal: TREE_SPACING_DEFAULTS.horizontal,
        classic: TREE_SPACING_DEFAULTS.classic
    };
}

function getDefaultTreeSpacingScale(layout) {
    if (layout === 'classic') return TREE_SPACING_DEFAULTS.classic;
    if (layout === 'horizontal') return TREE_SPACING_DEFAULTS.horizontal;
    return TREE_SPACING_DEFAULTS.radial;
}

function normalizeTreeSpacingScales(scales) {
    const out = createDefaultTreeSpacingScales();
    if (!scales || typeof scales !== 'object') return out;
    TREE_SPACING_LAYOUTS.forEach((layout) => {
        if (typeof scales[layout] === 'number' && Number.isFinite(scales[layout])) {
            out[layout] = clampTreeSpacingScale(scales[layout]);
        }
    });
    return out;
}

function readTreeSpacingScales() {
    if (typeof treeSpacingScales !== 'undefined' && treeSpacingScales) {
        return normalizeTreeSpacingScales(treeSpacingScales);
    }
    const legacy = (typeof treeSpacingScale !== 'undefined')
        ? treeSpacingScale
        : ((typeof classicSpacingScale !== 'undefined') ? classicSpacingScale : null);
    if (typeof legacy === 'number' && Number.isFinite(legacy)) {
        const s = clampTreeSpacingScale(legacy);
        return { radial: s, horizontal: s, classic: s };
    }
    return createDefaultTreeSpacingScales();
}

function getTreeSpacingScale(layout) {
    const key = layout || (typeof currentLayout !== 'undefined' ? currentLayout : 'radial');
    const scales = readTreeSpacingScales();
    if (isTreeSpacingLayout(key) && typeof scales[key] === 'number') {
        return clampTreeSpacingScale(scales[key]);
    }
    return getDefaultTreeSpacingScale(key);
}

function setTreeSpacingScaleForLayout(layout, scale) {
    if (!isTreeSpacingLayout(layout)) return getTreeSpacingScale(layout);
    const next = clampTreeSpacingScale(scale);
    const scales = readTreeSpacingScales();
    scales[layout] = next;
    try {
        if (typeof treeSpacingScales !== 'undefined') treeSpacingScales = scales;
        if (typeof syncTreeSpacingGlobals === 'function') syncTreeSpacingGlobals();
    } catch (_) { /* ignore */ }
    return next;
}

function syncTreeSpacingGlobals() {
    const scales = readTreeSpacingScales();
    try {
        window.treeSpacingScales = scales;
        const layout = (typeof currentLayout !== 'undefined') ? currentLayout : 'radial';
        window.treeSpacingScale = getTreeSpacingScale(layout);
        window.classicSpacingScale = getTreeSpacingScale('classic');
    } catch (_) { /* ignore */ }
}

function treeSpacingPresetForScale(scale) {
    const s = clampTreeSpacingScale(scale);
    let best = 'normal';
    let bestDiff = Infinity;
    Object.keys(TREE_SPACING_PRESETS).forEach((key) => {
        const diff = Math.abs(TREE_SPACING_PRESETS[key] - s);
        if (diff < bestDiff) {
            bestDiff = diff;
            best = key;
        }
    });
    return bestDiff <= 0.06 ? best : '';
}

function isTreeSpacingLayout(layout) {
    return TREE_SPACING_LAYOUTS.indexOf(layout) !== -1;
}

function getClassicLayoutGaps(scale) {
    const s = clampTreeSpacingScale(scale == null ? getTreeSpacingScale('classic') : scale);
    return {
        scale: s,
        gapX: CLASSIC_GAP_X * s,
        gapY: CLASSIC_GAP_Y * s
    };
}

function getRadialLayoutRadius(scale) {
    const s = getEffectiveTreeSpacingScale('radial', scale);
    return RADIAL_RADIUS_PER_LEVEL * s;
}

function getHorizontalLayoutGaps(scale, direction) {
    const s = clampTreeSpacingScale(scale == null ? getTreeSpacingScale('horizontal') : scale);
    if (direction === 'tb') {
        return {
            scale: s,
            originX: HORIZONTAL_ORIGIN_X,
            originY: HORIZONTAL_ORIGIN_Y,
            phaseGapX: VERTICAL_PHASE_GAP_X * s,
            gapY: VERTICAL_GAP_Y * s,
            nestGapX: VERTICAL_NEST_GAP_X * s
        };
    }
    return {
        scale: s,
        originX: HORIZONTAL_ORIGIN_X,
        originY: HORIZONTAL_ORIGIN_Y,
        gapX: HORIZONTAL_GAP_X * s,
        gapY: HORIZONTAL_GAP_Y * s
    };
}

// Совместимость с предыдущим API
function clampClassicSpacingScale(scale) { return clampTreeSpacingScale(scale); }
function getClassicSpacingScale() { return getTreeSpacingScale('classic'); }
function classicSpacingPresetForScale(scale) { return treeSpacingPresetForScale(scale); }
const CLASSIC_SPACING_PRESETS = TREE_SPACING_PRESETS;
