// «Массовая правка стилей» window (as the Batch Styler plugin): on the left the
// file's text or colour styles with checkboxes (a folder ticks all of it), on the
// right what to change — an empty field changes nothing. The list shows what each
// ticked style becomes; «Применить» does it in one undo step and the window stays
// for the next change.

import { colorToHex, hexToColor, tr, type Document, type NodeId, type TextCase, type TextDecoration } from '#core';
import { parseLetterSpacing, parseLineHeight, parseNumberChange, planBatch, type ColorChanges, type NameChanges, type TextChanges } from '../batch-styles.ts';
import type { Editor } from '../editor.ts';
import { h, icon } from './dom.ts';
import { MIXED } from './fields.ts';
import { FontPicker } from './font-picker.ts';
import { styleMeta, stylePreview } from './styles-ui.ts';

const WEIGHTS: [number, string][] = [
  [100, 'Thin 100'],
  [200, 'ExtraLight 200'],
  [300, 'Light 300'],
  [400, 'Regular 400'],
  [500, 'Medium 500'],
  [600, 'SemiBold 600'],
  [700, 'Bold 700'],
  [800, 'ExtraBold 800'],
  [900, 'Black 900'],
];

let current: { close: () => void } | null = null;

/** Opens the window on text or colour styles; `ticked` — styles ticked from the start. */
export function openBatchStyles(editor: Editor, type: 'TEXT' | 'FILL' = 'TEXT', ticked: readonly NodeId[] = []): void {
  current?.close();
  const doc = editor.doc;
  let kind: 'TEXT' | 'FILL' = type;
  if (editor.stylesOf(kind).length === 0 && editor.stylesOf(kind === 'TEXT' ? 'FILL' : 'TEXT').length > 0) kind = kind === 'TEXT' ? 'FILL' : 'TEXT';
  const checked = new Set<NodeId>(ticked.filter((id) => doc.get(id, 'styleType') === kind));
  let query = '';

  // ---------- what to change ----------
  let fontFamily: string | undefined;
  const font = new FontPicker(
    () => doc,
    () => {
      if (fontFamily) return fontFamily;
      const families = new Set([...checked].map((id) => doc.get(id, 'fontFamily')));
      return families.size === 1 ? [...families][0]! : checked.size ? MIXED : '';
    },
    (family) => {
      fontFamily = family;
      font.refresh();
      update();
    },
  );
  const select = <T extends string>(label: string, options: [T, string][]) => {
    const s = h('select', { class: 'dialog-input bst-select', 'aria-label': label }, h('option', { value: '' }, tr('Не менять')), ...options.map(([v, t]) => h('option', { value: v }, t))) as HTMLSelectElement;
    s.addEventListener('change', update);
    return s;
  };
  const input = (label: string, placeholder: string) => {
    const i = h('input', { class: 'dialog-input', type: 'text', placeholder, 'aria-label': label, spellcheck: false }) as HTMLInputElement;
    i.addEventListener('input', update);
    return i;
  };
  const weight = select(tr('Начертание'), WEIGHTS.map(([w, n]) => [String(w), n]));
  const italic = select(tr('Курсив'), [['no', tr('Прямой')], ['yes', tr('Курсив')]]);
  const size = input(tr('Размер'), tr('24, +2, −2, ×1.25'));
  const lineHeight = input(tr('Межстрочный интервал'), tr('Авто, 120%, 24, +4'));
  const letterSpacing = input(tr('Межбуквенный интервал'), tr('0, −2%, 1px, +1'));
  const paragraph = input(tr('Отступ после абзаца'), tr('8, +4'));
  const textCase = select<TextCase>(tr('Регистр'), [['ORIGINAL', tr('Как набрано')], ['UPPER', tr('ВСЕ ПРОПИСНЫЕ')], ['LOWER', tr('все строчные')], ['TITLE', tr('Каждое Слово С Прописной')]]);
  const decoration = select<TextDecoration>(tr('Оформление'), [['NONE', tr('Без линий')], ['UNDERLINE', tr('Подчёркнутый')], ['STRIKETHROUGH', tr('Зачёркнутый')]]);

  const oneColorOn = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const oneColor = h('input', { type: 'color', value: '#5B6CF0', 'aria-label': tr('Цвет') }) as HTMLInputElement;
  const oneColorHex = h('input', { class: 'dialog-input bst-hex', type: 'text', value: '#5B6CF0', maxLength: 7, spellcheck: false, 'aria-label': 'HEX' }) as HTMLInputElement;
  oneColorOn.addEventListener('change', update);
  oneColor.addEventListener('input', () => {
    oneColorHex.value = oneColor.value.toUpperCase();
    oneColorOn.checked = true;
    update();
  });
  oneColorHex.addEventListener('input', () => {
    const c = hexToColor(oneColorHex.value.startsWith('#') ? oneColorHex.value : `#${oneColorHex.value}`);
    if (!c || !/^#?[0-9a-f]{6}$/i.test(oneColorHex.value)) return;
    oneColor.value = colorToHex(c).slice(0, 7);
    oneColorOn.checked = true;
    update();
  });
  const opacity = input(tr('Непрозрачность'), tr('Не менять: 100, 80…'));
  const slider = (label: string, min: number, max: number) => {
    const r = h('input', { type: 'range', min: String(min), max: String(max), value: '0', 'aria-label': label }) as HTMLInputElement;
    const v = h('span', { class: 'gen-value' }, '0');
    r.addEventListener('input', () => {
      v.textContent = Number(r.value) > 0 ? `+${r.value}` : r.value;
      update();
    });
    return { r, v, reset: () => ((r.value = '0'), (v.textContent = '0')) };
  };
  const lightness = slider(tr('Светлота'), -40, 40);
  const chroma = slider(tr('Насыщенность'), -40, 40);
  const hue = slider(tr('Оттенок'), -180, 180);

  const find = input(tr('Найти в названиях'), tr('Найти'));
  const replace = input(tr('Заменить на'), tr('Заменить на'));
  const folderOn = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const folder = input(tr('Папка'), tr('Кнопки/Основные; пусто — без папки'));
  folderOn.addEventListener('change', update);
  folder.addEventListener('input', () => (folderOn.checked = true));

  const field = (label: string, control: HTMLElement, hint?: string) => h('label', { class: 'bst-field' }, h('span', { class: 'bst-label' }, label), control, hint ? h('span', { class: 'bst-hint' }, hint) : null);
  const textFields = h(
    'div',
    { class: 'bst-group' },
    h('div', { class: 'bst-field' }, h('span', { class: 'bst-label' }, tr('Шрифт')), font.el),
    field(tr('Начертание'), weight),
    field(tr('Курсив'), italic),
    field(tr('Размер'), size),
    field(tr('Межстрочный'), lineHeight),
    field(tr('Межбуквенный'), letterSpacing),
    field(tr('После абзаца'), paragraph),
    field(tr('Регистр'), textCase),
    field(tr('Оформление'), decoration),
  );
  const colorFields = h(
    'div',
    { class: 'bst-group' },
    h('div', { class: 'bst-field' }, h('label', { class: 'bst-label bst-check' }, oneColorOn, h('span', {}, tr('Один цвет для всех'))), h('div', { class: 'bst-row' }, oneColor, oneColorHex)),
    field(tr('Непрозрачность, %'), opacity),
    h('div', { class: 'bst-field' }, h('span', { class: 'bst-label' }, tr('Светлота')), h('div', { class: 'bst-row' }, lightness.r, lightness.v)),
    h('div', { class: 'bst-field' }, h('span', { class: 'bst-label' }, tr('Насыщенность')), h('div', { class: 'bst-row' }, chroma.r, chroma.v)),
    h('div', { class: 'bst-field' }, h('span', { class: 'bst-label' }, tr('Оттенок, °')), h('div', { class: 'bst-row' }, hue.r, hue.v)),
    h('p', { class: 'dialog-hint' }, tr('Сдвиги — в OKLCH: равные шаги выглядят равными, градиенты меняются по всем точкам.')),
  );
  const nameFields = h(
    'div',
    { class: 'bst-group' },
    h('div', { class: 'bst-field' }, h('span', { class: 'bst-label' }, tr('Названия')), h('div', { class: 'bst-row' }, find, replace)),
    h('div', { class: 'bst-field' }, h('label', { class: 'bst-label bst-check' }, folderOn, h('span', {}, tr('Переложить в папку'))), folder),
  );

  // ---------- the list ----------
  const tabs = h('div', { class: 'bst-tabs', role: 'tablist' });
  const search = h('input', { class: 'dialog-input', type: 'search', placeholder: tr('Найти стиль'), 'aria-label': tr('Найти стиль') }) as HTMLInputElement;
  search.addEventListener('input', () => {
    query = search.value.toLowerCase();
    drawList();
  });
  const all = h('input', { type: 'checkbox', 'aria-label': tr('Выбрать все') }) as HTMLInputElement;
  all.addEventListener('change', () => {
    for (const id of visible()) {
      if (all.checked) checked.add(id);
      else checked.delete(id);
    }
    font.refresh();
    drawList();
    update();
  });
  const list = h('div', { class: 'bst-list', role: 'list' });
  const summary = h('span', { class: 'bst-summary' });
  const apply = h('button', { class: 'text-button primary', type: 'button' }, tr('Применить'));
  const done = h('button', { class: 'text-button', type: 'button', onclick: () => close() }, tr('Готово'));

  const visible = () => editor.stylesOf(kind).filter((id) => !query || doc.get(id, 'name').toLowerCase().includes(query));

  function changes(): { text: TextChanges; color: ColorChanges; names: NameChanges } {
    const text: TextChanges = {};
    if (fontFamily) text.fontFamily = fontFamily;
    if (weight.value) text.fontWeight = Number(weight.value);
    if (italic.value) text.italic = italic.value === 'yes';
    text.fontSize = parseNumberChange(size.value) ?? undefined;
    text.lineHeight = parseLineHeight(lineHeight.value) ?? undefined;
    text.letterSpacing = parseLetterSpacing(letterSpacing.value) ?? undefined;
    text.paragraphSpacing = parseNumberChange(paragraph.value) ?? undefined;
    if (textCase.value) text.textCase = textCase.value as TextCase;
    if (decoration.value) text.textDecoration = decoration.value as TextDecoration;
    const color: ColorChanges = {};
    if (oneColorOn.checked) color.color = hexToColor(oneColor.value) ?? undefined;
    const op = Number(opacity.value.replace('%', '').replace(',', '.'));
    if (opacity.value.trim() && Number.isFinite(op)) color.opacity = Math.min(100, Math.max(0, op)) / 100;
    if (Number(lightness.r.value)) color.lightness = Number(lightness.r.value);
    if (Number(chroma.r.value)) color.chroma = Number(chroma.r.value);
    if (Number(hue.r.value)) color.hue = Number(hue.r.value);
    const names: NameChanges = {};
    if (find.value) {
      names.find = find.value;
      names.replace = replace.value;
    }
    if (folderOn.checked) names.folder = folder.value;
    return { text, color, names };
  }

  const plan = () => {
    const c = changes();
    return planBatch(doc, [...checked].filter((id) => doc.store.isAlive(id)), c.text, c.color, c.names);
  };

  function drawTabs(): void {
    tabs.replaceChildren(
      ...(['TEXT', 'FILL'] as const).map((t) => {
        const n = editor.stylesOf(t).length;
        const b = h('button', { class: `fp-group${t === kind ? ' on' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(t === kind), disabled: n === 0 }, h('span', {}, `${t === 'TEXT' ? tr('Текст') : tr('Цвета')} · ${n}`));
        b.addEventListener('click', () => {
          kind = t;
          checked.clear();
          drawTabs();
          drawList();
          update();
        });
        return b;
      }),
    );
    textFields.hidden = kind !== 'TEXT';
    colorFields.hidden = kind !== 'FILL';
  }

  function drawList(): void {
    const ids = visible();
    const p = plan();
    all.checked = ids.length > 0 && ids.every((id) => checked.has(id));
    all.indeterminate = !all.checked && ids.some((id) => checked.has(id));
    const rows: HTMLElement[] = [];
    let lastFolder: string | null = null;
    for (const id of ids) {
      const name = doc.get(id, 'name');
      const folderName = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';
      if (folderName !== lastFolder && folderName) {
        const inFolder = ids.filter((s) => doc.get(s, 'name').startsWith(`${folderName}/`) && !doc.get(s, 'name').slice(folderName.length + 1).includes('/'));
        const box = h('input', { type: 'checkbox', checked: inFolder.every((s) => checked.has(s)), 'aria-label': tr('Выбрать папку {0}', folderName) }) as HTMLInputElement;
        box.addEventListener('change', () => {
          for (const s of inFolder) box.checked ? checked.add(s) : checked.delete(s);
          font.refresh();
          drawList();
          update();
        });
        rows.push(h('label', { class: 'bst-folder' }, box, icon('folder', 12), h('span', {}, folderName)));
      }
      lastFolder = folderName;
      const box = h('input', { type: 'checkbox', checked: checked.has(id) }) as HTMLInputElement;
      box.addEventListener('change', () => {
        box.checked ? checked.add(id) : checked.delete(id);
        font.refresh();
        drawList();
        update();
      });
      const patch = p.get(id);
      const after = patch ? previewAfter(id, patch) : null;
      rows.push(
        h(
          'label',
          { class: `bst-item${folderName ? ' nested' : ''}${patch ? ' changes' : ''}`, role: 'listitem' },
          box,
          stylePreview(doc, id),
          h('span', { class: 'bst-text' }, h('span', { class: 'bst-name' }, name.split('/').pop()!), h('span', { class: 'bst-meta' }, styleMeta(doc, id))),
          after,
        ),
      );
    }
    if (!ids.length) rows.push(h('p', { class: 'dialog-hint' }, editor.stylesOf(kind).length ? tr('Ничего не нашлось') : tr('В файле нет таких стилей')));
    list.replaceChildren(...rows);
  }

  /** «→ Inter 700 · 20/Авто» or «→ #5B6CF0»: what the style becomes. */
  function previewAfter(id: NodeId, patch: Record<string, unknown>): HTMLElement {
    // The usual preview and description read the style through `get`: a view with the patch over it.
    const after = { get: (node: NodeId, key: string) => (node === id && key in patch ? patch[key] : doc.get(node, key as never)) } as unknown as Document;
    const name = typeof patch.name === 'string' ? patch.name.split('/').pop()! : null;
    const look = Object.keys(patch).some((k) => k !== 'name');
    return h(
      'span',
      { class: 'bst-after' },
      '→',
      look ? stylePreview(after, id) : null,
      h('span', { class: 'bst-text' }, name ? h('span', { class: 'bst-name' }, name) : null, look ? h('span', { class: 'bst-meta' }, styleMeta(after, id)) : null),
    );
  }

  function update(): void {
    const p = plan();
    const users = new Set([...p.keys()].flatMap((id) => editor.styleUsers(id))).size;
    summary.textContent = checked.size === 0 ? tr('Отметьте стили слева') : p.size === 0 ? tr('Отмечено: {0}. Задайте, что изменить', checked.size) : tr('Изменится стилей: {0}, слоёв с ними: {1}', p.size, users);
    apply.disabled = p.size === 0 || doc.readOnly;
    drawList();
  }

  apply.addEventListener('click', () => {
    const p = plan();
    if (!p.size) return;
    editor.commit(tr('Массовая правка стилей'), (tx) => {
      for (const [id, patch] of p) tx.update(id, patch);
    });
    editor.toast(tr('Изменено стилей: {0}. Отменить — ⌘Z', p.size));
    // The fields start over; the ticks stay for the next change.
    fontFamily = undefined;
    for (const el of [weight, italic, textCase, decoration]) el.value = '';
    for (const el of [size, lineHeight, letterSpacing, paragraph, opacity, find, replace, folder]) el.value = '';
    oneColorOn.checked = false;
    folderOn.checked = false;
    for (const s of [lightness, chroma, hue]) s.reset();
    font.refresh();
    update();
  });

  const closeButton = h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть'), onclick: () => close() }, icon('close'));
  const dialog = h(
    'div',
    { class: 'dialog batch-styles', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('Массовая правка стилей') },
    h('header', { class: 'dialog-header' }, h('h2', {}, tr('Массовая правка стилей')), closeButton),
    h(
      'div',
      { class: 'bst-body' },
      h('div', { class: 'bst-left' }, tabs, h('div', { class: 'bst-search' }, all, search), list),
      h('div', { class: 'bst-right' }, textFields, colorFields, nameFields, h('p', { class: 'dialog-hint' }, tr('Пустое поле ничего не меняет. Слои со стилями обновятся сразу.'))),
    ),
    h('footer', { class: 'dialog-footer bst-footer' }, summary, done, apply),
  );
  const overlay = h('div', { class: 'dialog-overlay' }, dialog);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !document.querySelector('.font-popover')) {
      e.preventDefault();
      close();
    }
  };
  function close(): void {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    current = null;
  }
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) close();
  });
  dialog.addEventListener('keydown', (e) => e.stopPropagation());
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  current = { close };
  drawTabs();
  update();
  search.focus();
}

