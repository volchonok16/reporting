// Хранилище цветовых палитр для тем диаграммы
const themes = {
  default: [
    '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#34495e',
    '#e91e63', '#00bcd4', '#8bc34a', '#ff9800', '#673ab7', '#009688', '#ff5722', '#607d8b',
    '#cddc39', '#03a9f4', '#ffc107', '#795548', '#ad1457', '#1565c0', '#2e7d32', '#f57f17',
    '#6a1b9a', '#00695c', '#bf360c', '#263238', '#880e4f', '#00838f', '#558b2f', '#ef6c00',
    '#4a148c', '#004d40', '#d84315', '#37474f', '#827717', '#0277bd', '#f9a825', '#4e342e'
  ],
  dark: [
    '#c0392b', '#8e44ad', '#2980b9', '#16a085', '#f39c12', '#d35400', '#7f8c8d', '#2c3e50',
    '#e74c3c', '#9b59b6', '#3498db', '#1abc9c', '#e67e22', '#95a5a6', '#34495e', '#f1c40f',
    '#e91e63', '#00bcd4', '#ff5722', '#607d8b', '#b71c1c', '#6a1b9a', '#1976d2', '#00695c',
    '#ffa000', '#e65100', '#546e7a', '#1a237e', '#c62828', '#4a148c', '#0d47a1', '#004d40',
    '#ff8f00', '#bf360c', '#455a64', '#0d47a1', '#880e4f', '#006064', '#d84315', '#37474f'
  ],
  neutral: [
    '#e67e22', '#2c3e50', '#e74c3c', '#8e44ad', '#27ae60', '#f1c40f', '#95a5a6', '#1abc9c',
    '#e91e63', '#00bcd4', '#8bc34a', '#ff9800', '#673ab7', '#009688', '#ff5722', '#607d8b',
    '#cddc39', '#03a9f4', '#ffc107', '#795548', '#ad1457', '#1565c0', '#2e7d32', '#f57f17',
    '#6a1b9a', '#00695c', '#bf360c', '#263238', '#880e4f', '#00838f', '#558b2f', '#ef6c00',
    '#4a148c', '#004d40', '#d84315', '#37474f', '#827717', '#0277bd', '#f9a825', '#4e342e'
  ],
  neon: [
    '#ff0040', '#00ffff', '#39ff14', '#ff6600', '#ff00ff', '#ffff00', '#00ff00', '#ff0090',
    '#ff073a', '#0ff0fc', '#adff2f', '#ffa500', '#ff1493', '#ffd700', '#7fff00', '#ff4500',
    '#00ff7f', '#ff69b4', '#1e90ff', '#ff6347', '#ff0055', '#00ffff', '#5cff00', '#ff8800',
    '#ff00aa', '#eeff00', '#00cc00', '#ff0088', '#ff0022', '#00dddd', '#88ff00', '#ff5500',
    '#ff0066', '#ffcc00', '#66ff00', '#ff3300', '#ff00cc', '#00ffcc', '#ccff00', '#ff1100'
  ],
  catppuccin: [
    '#f5e0dc', '#f2cdcd', '#f5c2e7', '#cba6f7', '#f38ba8', '#eba0ac', '#fab387', '#f9e2af',
    '#a6e3a1', '#94e2d5', '#89b4fa', '#b4befe', '#cdd6f4', '#bac2de', '#a6adc8', '#9399b2',
    '#7f849c', '#6c7086', '#585b70', '#45475a', '#313244', '#1e1e2e', '#181825', '#11111b',
    '#e8d5d0', '#e0c8c0', '#d8bbb0', '#d0aea0', '#c8a190', '#c09480', '#b88770', '#b07a60',
    '#a86d50', '#a06040', '#985330', '#904620', '#883910', '#802c00', '#782000', '#701400'
  ],
  viridis: [
    '#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58',
    '#b5de2b', '#fde725', '#440154', '#472a7a', '#3f4889', '#31688e', '#26828e', '#1f9e89',
    '#35b779', '#6ece58', '#b5de2b', '#fde725', '#440154', '#482878', '#3e4989', '#31688e',
    '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725', '#440154', '#482878',
    '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'
  ],
  tableau: [
    '#4e79a7', '#f28e2c', '#e15759', '#76b7b2', '#59a14f', '#edc949', '#af7ac1', '#ff9da7',
    '#9c755f', '#bab0ab', '#4e79a7', '#f28e2c', '#e15759', '#76b7b2', '#59a14f', '#edc949',
    '#af7ac1', '#ff9da7', '#9c755f', '#bab0ab', '#4e79a7', '#f28e2c', '#e15759', '#76b7b2',
    '#59a14f', '#edc949', '#af7ac1', '#ff9da7', '#9c755f', '#bab0ab', '#4e79a7', '#f28e2c',
    '#e15759', '#76b7b2', '#59a14f', '#edc949', '#af7ac1', '#ff9da7', '#9c755f', '#bab0ab'
  ],
  soft: [
    /* спокойнее: teal / sky / mint / sand — без лилового акцента */
    '#5eead4', '#7dd3fc', '#86efac', '#fdba74', '#bae6fd', '#a7f3d0', '#fde68a', '#67e8f9',
    '#99f6e4', '#93c5fd', '#6ee7b7', '#fcd34d', '#38bdf8', '#5eead4', '#fbbf24', '#2dd4bf',
    '#7dd3fc', '#34d399', '#fb923c', '#0ea5e9', '#14b8a6', '#0284c7', '#22c55e', '#ea580c',
    '#06b6d4', '#10b981', '#f59e0b', '#0891b2', '#0d9488', '#0369a1', '#16a34a', '#c2410c',
    '#22d3ee', '#059669', '#d97706', '#0e7490', '#115e59', '#075985', '#15803d', '#9a3412'
  ],
  /** Минимализм: только серые оттенки (на части типов диаграмм недоступна). */
  mono: [
    '#525252', '#737373', '#404040', '#a3a3a3', '#262626', '#8a8a8a', '#5c5c5c', '#b0b0b0',
    '#3f3f3f', '#6b6b6b', '#949494', '#2e2e2e', '#7a7a7a', '#4a4a4a', '#adadad', '#1f1f1f',
    '#666666', '#8f8f8f', '#383838', '#c0c0c0', '#555555', '#787878', '#454545', '#9e9e9e',
    '#303030', '#6e6e6e', '#888888', '#242424', '#5a5a5a', '#a8a8a8', '#3a3a3a', '#707070',
    '#484848', '#919191', '#2a2a2a', '#636363', '#858585', '#353535', '#9a9a9a', '#1a1a1a'
  ]
};

/** Шрифты диаграмм (системные стеки — работают в SVG/PNG/PDF без CDN). */
const DIAGRAM_FONTS = {
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  arial: 'Arial, Helvetica, "Helvetica Neue", sans-serif',
  georgia: 'Georgia, "Times New Roman", Times, serif',
  times: '"Times New Roman", Times, Baskerville, Georgia, serif',
  verdana: 'Verdana, Geneva, Tahoma, sans-serif',
  trebuchet: '"Trebuchet MS", "Segoe UI", Tahoma, sans-serif',
  mono: '"Courier New", Courier, ui-monospace, monospace'
};

const VALID_DIAGRAM_FONTS = Object.keys(DIAGRAM_FONTS);

/** Мягкий UI (body.soft) и/или палитра soft */
function isSoftDiagramStyle() {
  try {
    if (typeof currentTheme !== 'undefined' && currentTheme === 'soft') return true;
    if (typeof document !== 'undefined' && document.body && document.body.classList.contains('soft')) return true;
  } catch (_) { /* ignore */ }
  return false;
}

function softMixFill(hex) {
  if (typeof mixHex === 'function') return mixHex(hex, '#ffffff', 0.58);
  return hex;
}

function softMixStroke(hex) {
  if (typeof mixHex === 'function') return mixHex(hex, '#d6d3d1', 0.42);
  return hex;
}

try {
  if (typeof window !== 'undefined') {
    window.isSoftDiagramStyle = isSoftDiagramStyle;
    window.softMixFill = softMixFill;
    window.softMixStroke = softMixStroke;
  }
} catch (_) { /* ignore */ }