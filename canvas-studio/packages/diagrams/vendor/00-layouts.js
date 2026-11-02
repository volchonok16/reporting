/* Типы схем, палитры и подписи — из начала DocPlan js/main.js. */
const VALID_DIAGRAM_LAYOUTS = ['radial', 'classic', 'horizontal', 'sequence', 'bpmn', 'wave', 'sankey', 'pulsewave', 'secret', 'gantt', 'treemap', 'heatmap', 'reversibility', 'perspective', 'fan', 'ridgeline', 'waterfall', 'flowchart', 'timeline', 'rollout', 'lanes', 'ribbon', 'journey'];
const VALID_DIAGRAM_THEMES = ['default', 'dark', 'neutral', 'neon', 'catppuccin', 'viridis', 'tableau', 'soft', 'mono'];
const DIAGRAM_LAYOUT_LABELS = {
    radial: 'Радиальная',
    classic: 'Классическая карта',
    horizontal: 'Иерархическая',
    sequence: 'Последовательность',
    bpmn: 'BPMN',
    wave: 'Волнообразная',
    sankey: 'Потоки',
    pulsewave: 'Динамика волны',
    secret: 'Канбан',
    gantt: 'Гант',
    treemap: 'Плитки',
    heatmap: 'Тепловая',
    reversibility: 'Карта обратимости',
    perspective: 'Перспективы',
    fan: 'Веер значимости',
    ridgeline: 'Хребты данных',
    waterfall: 'Водопад',
    flowchart: 'Блок-схема',
    timeline: 'Таймлайн',
    rollout: 'Роллаут',
    lanes: 'Дорожки',
    ribbon: 'Лента фаз',
    journey: 'Путь пользователя'
};
window.DIAGRAM_LAYOUT_LABELS = DIAGRAM_LAYOUT_LABELS;
