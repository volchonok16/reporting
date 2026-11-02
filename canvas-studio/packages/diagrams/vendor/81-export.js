/* Подготовка SVG к экспорту — из DocPlan js/export.js (строки 1–298): рамка по содержимому с запасом,
 * фон темы или прозрачный (без фонового rect рендера), без SVG-фильтров (мыльные блоки в PNG). */
// Экспорт диаграмм (SVG, PDF, PNG)
// PDF/PNG — страница по пропорциям диаграммы (без letterbox на A4)
// PNG «Без фона» — прозрачный фон для вставки в презентации

function getDiagramBackground() {
    const style = getComputedStyle(document.body);
    const v = style.getPropertyValue('--diagram-bg').trim()
        || style.getPropertyValue('--bg').trim();
    return v || (document.body.classList.contains('dark') ? '#0b0b0c' : '#f8fafc');
}

function parseHexColor(hex) {
    const m = String(hex || '').trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!m) return { r: 11, g: 11, b: 12 };
    let h = m[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16)
    };
}

/** Запас под stroke/маркеры/антиалиас: getBBox часто не учитывает stroke. */
const SVG_EXPORT_PAD = 20;

/**
 * Логический размер из data-logical-* / viewBox / width+height.
 * Не используем clientWidth — на мобиле его искажает CSS transform.
 * Zoom в applyTransform перезаписывает width/height на display-пиксели —
 * поэтому приоритет у data-logical-w/h и viewBox.
 */
function getSvgDeclaredBox(svgElement) {
    if (!svgElement) return { x: 0, y: 0, w: 960, h: 720 };

    const lw = parseFloat(svgElement.getAttribute('data-logical-w'));
    const lh = parseFloat(svgElement.getAttribute('data-logical-h'));
    if (lw > 1 && lh > 1 && isFinite(lw) && isFinite(lh)) {
        return { x: 0, y: 0, w: lw, h: lh };
    }

    const vb = svgElement.getAttribute('viewBox');
    if (vb) {
        const p = vb.trim().split(/[\s,]+/).map(Number);
        if (p.length === 4 && p.every((n) => isFinite(n))) {
            const [, , w, h] = p;
            if (w > 1 && h > 1) {
                return { x: p[0], y: p[1], w, h };
            }
        }
    }
    const attrW = parseFloat(svgElement.getAttribute('width'));
    const attrH = parseFloat(svgElement.getAttribute('height'));
    if (attrW > 1 && attrH > 1 && isFinite(attrW) && isFinite(attrH)) {
        return { x: 0, y: 0, w: attrW, h: attrH };
    }
    return { x: 0, y: 0, w: 960, h: 720 };
}

function unionSvgBoxes(a, b) {
    const x1 = Math.min(a.x, b.x);
    const y1 = Math.min(a.y, b.y);
    const x2 = Math.max(a.x + a.w, b.x + b.w);
    const y2 = Math.max(a.y + a.h, b.y + b.h);
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function padSvgBox(box, pad) {
    const p = Math.max(0, pad || 0);
    return { x: box.x - p, y: box.y - p, w: box.w + p * 2, h: box.h + p * 2 };
}

/**
 * Реальные границы нарисованного контента.
 * В UI у SVG overflow:visible — линии/подписи могут вылезать за viewBox;
 * при экспорте через Image() наружный SVG клипается по viewBox (overflow:hidden).
 */
function measureSvgContentBox(svgElement) {
    if (!svgElement || typeof svgElement.getBBox !== 'function') return null;

    const tryBBox = (el) => {
        if (!el || typeof el.getBBox !== 'function') return null;
        try {
            let b;
            try {
                b = el.getBBox({ stroke: true, markers: true, clipped: false });
            } catch (_) {
                b = el.getBBox();
            }
            if (!b || !isFinite(b.x) || !isFinite(b.y) || !isFinite(b.width) || !isFinite(b.height)) {
                return null;
            }
            if (b.width < 0.5 || b.height < 0.5) return null;
            return { x: b.x, y: b.y, w: b.width, h: b.height };
        } catch (_) {
            return null;
        }
    };

    let box = tryBBox(svgElement);
    // Если корневой getBBox пустой/упал — собираем по детям
    if (!box) {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        const skip = { defs: 1, title: 1, desc: 1, style: 1, metadata: 1, script: 1 };
        Array.from(svgElement.children || []).forEach((el) => {
            const tag = String(el.tagName || '').toLowerCase();
            if (skip[tag]) return;
            const b = tryBBox(el);
            if (!b) return;
            minX = Math.min(minX, b.x);
            minY = Math.min(minY, b.y);
            maxX = Math.max(maxX, b.x + b.w);
            maxY = Math.max(maxY, b.y + b.h);
        });
        if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) return null;
        box = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    return box;
}

/**
 * Область экспорта: по факту нарисованного контента + одинаковый pad со всех сторон.
 * Логический размер (data-logical / viewBox) — только fallback и защита от
 * «квадратного» display-size после zoom.
 */
function getSvgExportBox(svgElement) {
    const declared = getSvgDeclaredBox(svgElement);
    const content = measureSvgContentBox(svgElement);
    if (!content) return padSvgBox(declared, SVG_EXPORT_PAD);

    const aDec = declared.w / Math.max(declared.h, 1);
    const aCont = content.w / Math.max(content.h, 1);
    // Content похож на display-квадрат после zoom — берём логический размер
    const contentLooksLikeDisplay =
        aDec > 0 && aCont > 0 &&
        (aCont / aDec > 1.45 || aDec / aCont > 1.45) &&
        content.w < declared.w * 0.55;

    if (contentLooksLikeDisplay) {
        return padSvgBox(declared, SVG_EXPORT_PAD);
    }

    // Иначе обрезаем по контенту: без пустого поля справа/слева из завышенного layout.width
    return padSvgBox(content, SVG_EXPORT_PAD);
}

function pickRasterScale(w, h, preferScale, maxEdge) {
    let scale = preferScale;
    const edge = Math.max(w, h);
    if (edge * scale > maxEdge) scale = maxEdge / edge;
    // Ниже 2× — заметно мыльно на retina; не уходим в субпиксель
    return Math.max(2, scale);
}

function normalizeCssColor(c) {
    return String(c || '').trim().toLowerCase().replace(/\s+/g, '');
}

/**
 * Убрать полноэкранный фоновый rect, который рендереры кладут в SVG
 * (водопад / веер / ганта и т.п.), чтобы «без фона» реально был прозрачным.
 */
function stripFullCanvasBackgroundRect(clone, box, bgColor) {
    const bgNorm = normalizeCssColor(bgColor);
    const kids = Array.from(clone.children || []);
    for (let i = 0; i < kids.length; i++) {
        const el = kids[i];
        if (!el || !el.tagName) continue;
        if (String(el.tagName).toLowerCase() !== 'rect') continue;
        if (el.getAttribute('data-export-bg') === '1') {
            el.remove();
            continue;
        }
        const wAttr = el.getAttribute('width');
        const hAttr = el.getAttribute('height');
        const x = parseFloat(el.getAttribute('x') || '0');
        const y = parseFloat(el.getAttribute('y') || '0');
        const fill = normalizeCssColor(el.getAttribute('fill'));
        if (!fill || fill === 'none' || fill === 'transparent') continue;

        const coversPct = wAttr === '100%' && hAttr === '100%';
        const coversBox =
            Number.isFinite(x) && Number.isFinite(y) &&
            Math.abs(x - box.x) < 0.51 &&
            Math.abs(y - box.y) < 0.51 &&
            Math.abs(parseFloat(wAttr) - box.w) < 1.1 &&
            Math.abs(parseFloat(hAttr) - box.h) < 1.1;

        if (!coversPct && !coversBox) continue;
        // Полный canvas + либо цвет темы, либо просто первый full-bleed rect
        if (bgNorm && fill === bgNorm) {
            el.remove();
            return;
        }
        if (coversPct || coversBox) {
            el.remove();
            return;
        }
    }
}

/**
 * Клон SVG для экспорта: viewBox охватывает весь видимый контент (+ pad).
 * @param {{ transparent?: boolean }} opts — без фонового rect (для презентаций)
 */
function prepareExportSvg(svgElement, opts) {
    opts = opts || {};
    const transparent = !!opts.transparent;
    const bgColor = getDiagramBackground();
    const declared = getSvgDeclaredBox(svgElement);
    const box = getSvgExportBox(svgElement);
    const clone = svgElement.cloneNode(true);
    // Шрифт сайта: без этого SVG→Image() падает на дефолт (часто serif) — «другие шрифты в экспорте»
    const fontFamily = (typeof getResolvedUiFontFamily === 'function')
        ? getResolvedUiFontFamily()
        : ((typeof getUiFontFamily === 'function')
            ? getUiFontFamily()
            : 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif');

    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    clone.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
    // Intrinsic size для Image() = логический размер (соотношение сторон = viewBox)
    clone.setAttribute('width', String(box.w));
    clone.setAttribute('height', String(box.h));
    // В документе overflow:visible; как Image() наружный SVG по умолчанию клипает —
    // расширенный viewBox + явный overflow закрывают оба случая.
    clone.setAttribute('overflow', 'visible');
    clone.setAttribute('font-family', fontFamily);
    clone.removeAttribute('style');
    clone.style.cssText = '';
    clone.style.fontFamily = fontFamily;
    clone.style.overflow = 'visible';

    // Убрать возможные фоновые rect от прошлых экспортов / thrash
    Array.from(clone.querySelectorAll('[data-export-bg="1"]')).forEach((n) => n.remove());

    // SVG filter (feDropShadow и т.п.) при SVG→Image→canvas часто растеризуется
    // в intrinsic size viewBox, а затем растягивается на 3–4× canvas — узлы мыльные,
    // а текст/линии без filter остаются чёткими (типично для блок-схем).
    try {
        clone.querySelectorAll('[filter]').forEach((el) => {
            el.removeAttribute('filter');
        });
        clone.querySelectorAll('defs filter').forEach((f) => f.remove());
    } catch (_) { /* ignore */ }

    if (transparent) {
        // Фоновые rect рендереров совпадают с declared viewBox, не с расширенным
        stripFullCanvasBackgroundRect(clone, declared, bgColor);
    } else {
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('data-export-bg', '1');
        rect.setAttribute('x', String(box.x));
        rect.setAttribute('y', String(box.y));
        rect.setAttribute('width', String(box.w));
        rect.setAttribute('height', String(box.h));
        rect.setAttribute('fill', bgColor);
        clone.insertBefore(rect, clone.firstChild);
    }

    // Заметки узлов: в превью только <title>, в PNG/PDF — короткая подпись
    try {
        const svgNS = 'http://www.w3.org/2000/svg';
        clone.querySelectorAll('title.node-note-tip').forEach((tip) => {
            const host = tip.parentNode;
            if (!host || !host.getAttribute) return;
            const note = String(tip.textContent || '').trim();
            if (!note) return;
            const hx = parseFloat(host.getAttribute('x'));
            const hy = parseFloat(host.getAttribute('y'));
            if (!Number.isFinite(hx) || !Number.isFinite(hy)) return;
            const badge = document.createElementNS(svgNS, 'text');
            badge.setAttribute('x', String(hx));
            badge.setAttribute('y', String(hy + 14));
            badge.setAttribute('fill', '#b45309');
            badge.setAttribute('font-size', '10px');
            badge.setAttribute('font-weight', '600');
            badge.setAttribute('text-anchor', host.getAttribute('text-anchor') || 'start');
            badge.setAttribute('data-export-note', '1');
            const short = note.length > 48 ? note.slice(0, 46) + '…' : note;
            badge.textContent = '✎ ' + short;
            host.parentNode && host.parentNode.appendChild(badge);
        });
        clone.querySelectorAll('.node-note-dot').forEach((el) => el.remove());
    } catch (_) { /* ignore */ }

    return {
        svgString: new XMLSerializer().serializeToString(clone),
        w: box.w,
        h: box.h,
        bgColor: transparent ? 'transparent' : bgColor,
        transparent
    };
}
