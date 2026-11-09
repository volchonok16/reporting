// «Слайды» tab of a presentation (FEAT-157): the slides in order as small
// pictures — a click shows the slide, dragging reorders, the menu duplicates,
// skips or deletes; «+» adds a slide of a layout after the current one; the
// theme restyles every slide; «Слайд / Все слайды» — one slide at a time (held in place,
// as in Figma Slides) or all of them side by side on one canvas.

import { tr, type NodeId } from '#core';
import { invert } from '#geometry';
import type { TextMeasurer } from '#layout';
import { Canvas2DRenderer } from '#render';
import type { Editor } from '../editor.ts';
import { applySlideTheme, createSlide, currentTheme, formatOf, gridBounds, setSlideFormat, slideFormats, slideIds, slideSize, slideInfo, slideLayouts, slideThemes, type SlideLayout, type SlideTheme } from '../slides.ts';
import { ContextMenu } from './context-menu.ts';
import { h, icon } from './dom.ts';

const VIEW_KEY = 'cs.slides.view';
const THUMB_W = 176;

export type SlidesView = 'slide' | 'grid';

export class SlidesPanel {
  readonly el: HTMLElement;
  private readonly editor: Editor;
  private readonly renderer: Canvas2DRenderer;
  private readonly list: HTMLElement;
  private readonly themeButton: HTMLButtonElement;
  private readonly formatButton: HTMLButtonElement;
  private readonly viewSeg: HTMLElement;
  private readonly menu = new ContextMenu(document.body);
  private visible = false;
  private current: NodeId | null = null;
  private view: SlidesView = 'slide';
  private thumbs = new Map<NodeId, HTMLCanvasElement>();
  private dirty = new Set<NodeId>();
  private all = true;
  private frame = 0;
  private popover: HTMLElement | null = null;
  /** Starts the show from a slide (set by the app). */
  onPresent: ((from: NodeId | null) => void) | null = null;
  /** Exports the slides (set by the app). */
  onExport: ((format: 'pdf' | 'pptx') => void) | null = null;
  /** Adds slides from a .pptx (set by the app). */
  onImport: (() => void) | null = null;
  /** The slide on show or the view changed (the notes under the slide follow; set by the app). */
  onStage: ((single: boolean) => void) | null = null;

  constructor(editor: Editor, measurer: TextMeasurer) {
    this.editor = editor;
    this.renderer = new Canvas2DRenderer(measurer);
    this.renderer.images.onLoad = () => this.redraw(true);
    try {
      this.view = localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'slide';
    } catch {
      // the default view
    }
    // The view is on from the start, not only once switched (BUG-133: an opened file showed all slides under «Слайд»).
    if (this.view === 'slide') this.editor.slideStage = { current: () => this.currentSlide(), flip: (step) => this.next(step) };
    const add = h('button', { class: 'text-button primary sl-add', type: 'button', title: tr('Новый слайд после текущего (раскладка — на выбор)') }, icon('plus', 14), h('span', {}, tr('Слайд')));
    add.addEventListener('click', () => this.openLayouts(add));
    const present = h('button', { class: 'text-button sl-present', type: 'button', title: tr('Показ с текущего слайда (⌘⌥Enter)') }, icon('play', 14), h('span', {}, tr('Показ')));
    present.addEventListener('click', () => this.onPresent?.(this.current));
    const exportButton = h('button', { class: 'icon-button sl-export', type: 'button', title: tr('Экспорт и импорт: PDF, PowerPoint'), 'aria-label': tr('Экспорт и импорт презентации') }, icon('export', 16));
    exportButton.addEventListener('click', () => {
      const r = exportButton.getBoundingClientRect();
      this.menu.open(r.left, r.bottom + 4, [
        { kind: 'action', label: tr('PDF — страница на слайд'), run: () => this.onExport?.('pdf') },
        { kind: 'action', label: tr('PowerPoint (PPTX)…'), run: () => this.onExport?.('pptx') },
        { kind: 'separator' },
        { kind: 'action', label: tr('Импорт PowerPoint: слайды после текущего…'), disabled: this.editor.doc.readOnly, run: () => this.onImport?.() },
        { kind: 'action', label: tr('Шаблон «Новая айдентика»'), disabled: this.editor.doc.readOnly, run: () => void this.insertIdentity() },
      ]);
    });
    this.themeButton = h('button', { class: 'text-button sl-theme', type: 'button' });
    this.themeButton.addEventListener('click', () => this.openThemes(this.themeButton));
    this.formatButton = h('button', { class: 'text-button sl-format', type: 'button', title: tr('Формат слайдов: 16:9, 4:3, квадрат, сторис, A4…') });
    this.formatButton.addEventListener('click', () => this.openFormats(this.formatButton));
    this.viewSeg = h('div', { class: 'segmented with-text sl-view', role: 'radiogroup', 'aria-label': tr('Вид') });
    this.list = h('div', { class: 'sl-list', role: 'listbox', 'aria-label': tr('Слайды'), tabindex: 0 });
    this.list.addEventListener('keydown', (e) => this.onKey(e));
    this.el = h('div', { class: 'slides-panel' }, h('div', { class: 'sl-head' }, add, present, exportButton), h('div', { class: 'sl-head' }, this.themeButton, this.formatButton), h('div', { class: 'sl-head' }, this.viewSeg), this.list);
    editor.events.on('change', ({ changes }) => {
      if (changes.structural) this.all = true;
      for (const id of [...changes.created, ...changes.updated.keys(), ...changes.moved]) {
        const slide = this.slideOf(id);
        if (slide) this.dirty.add(slide);
      }
      if (changes.updated.has(editor.doc.rootId)) this.all = true;
      this.schedule();
    });
    editor.events.on('selection', () => {
      const slide = editor.selection.length ? this.slideOf(editor.selection[0]!) : null;
      if (slide && slide !== this.current) {
        this.current = slide;
        this.markCurrent();
        // A layer of another slide picked (in the layers, by search): that slide comes on show.
        if (this.singleView) this.editor.fitStage();
      }
    });
    editor.events.on('document', () => {
      this.all = true;
      this.thumbs.clear();
      this.schedule();
    });
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) {
      this.all = true;
      this.schedule();
    }
  }

  /** The slide a layer is on (its top-level frame on the page), or null. */
  slideOf(id: NodeId): NodeId | null {
    const d = this.editor.doc;
    if (!d.store.isAlive(id)) return null;
    let at: NodeId | null = id;
    while (at && d.parent(at) !== this.editor.pageId) at = d.parent(at);
    return at && d.type(at) === 'FRAME' ? at : null;
  }

  /** Whether one slide is on show (the «Слайд» view), not all of them. */
  get singleView(): boolean {
    return this.view === 'slide' && !this.phone;
  }

  /** On a phone the canvas is free, as a design's: a finger scrolls, two zoom (BUG-151); the remembered view is kept for elsewhere. */
  private phone = false;

  setPhone(phone: boolean): void {
    if (phone === this.phone) return;
    this.phone = phone;
    this.applyView();
  }

  currentSlide(): NodeId | null {
    const slides = slideIds(this.editor.doc, this.editor.pageId);
    if (this.current && slides.includes(this.current)) return this.current;
    return slides[0] ?? null;
  }

  // ---------- drawing ----------

  private schedule(): void {
    if (!this.visible || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.redraw(this.all);
    });
  }

  private redraw(all: boolean): void {
    if (!this.visible) return;
    const d = this.editor.doc;
    const slides = slideIds(d, this.editor.pageId);
    if (all || this.list.childElementCount !== slides.length) {
      this.all = false;
      this.dirty.clear();
      this.list.replaceChildren(...slides.map((id, i) => this.item(id, i)));
      this.drawHead();
      this.markCurrent();
      return;
    }
    for (const id of this.dirty) {
      const canvas = this.thumbs.get(id);
      if (canvas) this.paint(id, canvas);
    }
    this.dirty.clear();
  }

  private item(id: NodeId, i: number): HTMLElement {
    const canvas = this.thumbs.get(id) ?? h('canvas', { class: 'sl-thumb' });
    this.thumbs.set(id, canvas);
    this.paint(id, canvas);
    const info = slideInfo(this.editor.doc, id);
    const item = h(
      'div',
      { class: `sl-item${info.skip ? ' skipped' : ''}`, role: 'option', draggable: 'true', 'data-id': id, title: info.skip ? tr('Пропускается при показе') : this.editor.doc.get(id, 'name') },
      h('span', { class: 'sl-num' }, String(i + 1)),
      h('span', { class: 'sl-frame' }, canvas, info.skip ? h('span', { class: 'sl-skip' }, icon('eyeOff', 12)) : null, info.notes ? h('span', { class: 'sl-has-notes', title: tr('Есть заметки') }, icon('note', 12)) : null),
    );
    item.addEventListener('click', () => this.show(id));
    item.addEventListener('dblclick', () => this.onPresent?.(id));
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.show(id);
      this.menu.open(e.clientX, e.clientY, this.slideMenu(id));
    });
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('application/x-simmetrika-slide', id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => item.classList.remove('dragging'));
    item.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('application/x-simmetrika-slide')) return;
      e.preventDefault();
      const r = item.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      item.classList.toggle('drop-before', !after);
      item.classList.toggle('drop-after', after);
    });
    item.addEventListener('dragleave', () => item.classList.remove('drop-before', 'drop-after'));
    item.addEventListener('drop', (e) => {
      const moved = e.dataTransfer?.getData('application/x-simmetrika-slide');
      const after = item.classList.contains('drop-after');
      item.classList.remove('drop-before', 'drop-after');
      if (!moved || moved === id) return;
      e.preventDefault();
      this.editor.commit(tr('Порядок слайдов'), (tx) => tx.move(moved, this.editor.pageId, after ? { after: id } : { before: id }));
    });
    return item;
  }

  /** The slide drawn small: the same drawing as the canvas, at the thumbnail's scale. */
  private paint(id: NodeId, canvas: HTMLCanvasElement): void {
    const d = this.editor.doc;
    if (!d.store.isAlive(id)) return;
    const w = d.get(id, 'width');
    const hgt = d.get(id, 'height');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const k = THUMB_W / Math.max(1, w);
    canvas.width = Math.round(THUMB_W * dpr);
    canvas.height = Math.round(hgt * k * dpr);
    canvas.style.aspectRatio = `${w} / ${hgt}`;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const scene = this.editor.scene;
    const inv = invert(scene.world(id));
    if (!inv) return;
    ctx.setTransform(k * dpr, 0, 0, k * dpr, 0, 0);
    ctx.transform(inv.a, inv.b, inv.c, inv.d, inv.e, inv.f);
    this.renderer.renderNode(ctx, scene, id, scene.renderBounds(id), k * dpr);
  }

  private markCurrent(): void {
    this.onStage?.(this.singleView);
    const current = this.currentSlide();
    for (const el of this.list.querySelectorAll<HTMLElement>('.sl-item')) {
      const on = el.dataset.id === current;
      el.classList.toggle('current', on);
      el.setAttribute('aria-selected', String(on));
      if (on) el.scrollIntoView({ block: 'nearest' });
    }
  }

  private drawHead(): void {
    const theme = currentTheme(this.editor.doc);
    const size = slideSize(this.editor.doc, this.editor.pageId);
    this.formatButton.replaceChildren(formatPicture(size, 14), h('span', {}, formatOf(size)?.name ?? `${size.w}×${size.h}`), icon('chevronDown', 12));
    this.themeButton.replaceChildren(h('span', { class: 'sl-theme-dots' }, ...[theme.bg, theme.accent, theme.text].map((c) => h('span', { style: { background: c } }))), h('span', {}, tr('Тема: {0}', theme.name)), icon('chevronDown', 12));
    this.viewSeg.replaceChildren(
      ...([
        ['slide', tr('Слайд'), tr('Работа с одним слайдом: он закреплён и занимает весь холст, прокрутка листает слайды')],
        ['grid', tr('Все слайды'), tr('Все слайды рядом на одном полотне: сравнить их, переставить перетаскиванием')],
      ] as const).map(([value, label, hint]) => {
        const on = this.view === value;
        const b = h('button', { class: `segment${on ? ' active' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(on), title: hint }, label);
        b.addEventListener('click', () => this.setView(value));
        return b;
      }),
    );
  }

  // ---------- actions ----------

  /**
   * Shows a slide. In «Слайд» the view fits it and nothing is selected — the slide is the paper,
   * its settings are on the right while nothing is; in «Все слайды» it is selected, to be dragged.
   */
  show(id: NodeId): void {
    this.current = id;
    this.markCurrent();
    if (this.singleView) {
      if (this.editor.selection.some((s) => this.slideOf(s) !== id)) this.editor.setSelection([]);
      this.editor.fitStage();
    } else {
      this.editor.setSelection([id]);
    }
  }

  setView(view: SlidesView): void {
    this.view = view;
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      // not remembered
    }
    this.applyView();
  }

  private applyView(): void {
    const single = this.singleView;
    // «Слайд»: the slide is the paper and the view keeps to it; «Все слайды» (and a phone): the canvas is free.
    this.editor.slideStage = single ? { current: () => this.currentSlide(), flip: (step) => this.next(step) } : null;
    this.onStage?.(single);
    this.drawHead();
    const slides = slideIds(this.editor.doc, this.editor.pageId);
    const current = this.currentSlide();
    if (this.phone && current) {
      // The slide across the screen, the others a finger away.
      this.editor.zoomToBounds(this.editor.scene.bounds(current), 16);
    } else if (!single && slides.length) {
      this.editor.zoomToBounds(gridBounds(slides.length, slideSize(this.editor.doc, this.editor.pageId)), 56);
    } else if (current) this.show(current);
  }

  /** The remembered view: the first (current) slide, or all of them. */
  restoreView(): void {
    this.setView(this.view);
  }

  next(step: 1 | -1): void {
    const slides = slideIds(this.editor.doc, this.editor.pageId);
    const at = slides.indexOf(this.currentSlide() ?? '');
    const to = slides[Math.max(0, Math.min(slides.length - 1, at + step))];
    if (to) this.show(to);
  }

  addSlide(layout: SlideLayout): void {
    const editor = this.editor;
    if (editor.doc.readOnly) return;
    const after = this.currentSlide();
    let made = '';
    editor.commit(tr('Новый слайд'), (tx) => (made = createSlide(editor.doc, tx, editor.pageId, layout, after)));
    if (made) requestAnimationFrame(() => this.show(made));
  }

  copySlide(id: NodeId): void {
    this.editor.setSelection([id]);
    document.execCommand('copy');
    this.editor.toast(tr('Слайд скопирован. В другой презентации вставьте его: ⌘V'));
  }

  duplicate(id: NodeId): void {
    const editor = this.editor;
    const [copy] = editor.duplicate([id]);
    if (copy) requestAnimationFrame(() => this.show(copy));
  }

  remove(id: NodeId): void {
    const editor = this.editor;
    const slides = slideIds(editor.doc, editor.pageId);
    const next = slides[slides.indexOf(id) + 1] ?? slides[slides.indexOf(id) - 1] ?? null;
    editor.commit(tr('Удалить слайд'), (tx) => tx.delete(id));
    if (next) this.show(next);
  }

  toggleSkip(id: NodeId): void {
    const info = slideInfo(this.editor.doc, id);
    this.editor.commit(info.skip ? tr('Показывать слайд') : tr('Пропускать слайд'), (tx) => tx.set(id, 'slide', { ...info, skip: !info.skip }));
  }

  private slideMenu(id: NodeId) {
    const info = slideInfo(this.editor.doc, id);
    const ro = this.editor.doc.readOnly;
    return [
      { kind: 'action' as const, label: tr('Показ с этого слайда'), run: () => this.onPresent?.(id) },
      { kind: 'separator' as const },
      { kind: 'submenu' as const, label: tr('Новый слайд после'), disabled: ro, items: slideLayouts().map((l) => ({ kind: 'action' as const, label: l.name, run: () => this.addSlide(l.id) })) },
      { kind: 'action' as const, label: tr('Копировать слайд'), shortcut: '⌘C', run: () => this.copySlide(id) },
      { kind: 'action' as const, label: tr('Дублировать'), shortcut: '⌘D', disabled: ro, run: () => this.duplicate(id) },
      { kind: 'action' as const, label: info.skip ? tr('Показывать при показе') : tr('Пропускать при показе'), disabled: ro, run: () => this.toggleSkip(id) },
      { kind: 'separator' as const },
      { kind: 'action' as const, label: tr('Удалить слайд'), shortcut: '⌫', disabled: ro, run: () => this.remove(id) },
    ];
  }

  private onKey(e: KeyboardEvent): void {
    const id = this.currentSlide();
    if (!id) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') this.next(1);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') this.next(-1);
    else if ((e.key === 'Delete' || e.key === 'Backspace') && !this.editor.doc.readOnly) this.remove(id);
    else if (mod && e.code === 'KeyD' && !this.editor.doc.readOnly) this.duplicate(id);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  // ---------- popovers ----------

  private closePopover(): void {
    this.popover?.remove();
    this.popover = null;
    this.popoverCleanup?.();
    this.popoverCleanup = null;
  }

  private popoverCleanup: (() => void) | null = null;

  private openPopover(anchor: HTMLElement, content: HTMLElement): void {
    if (this.popover) return this.closePopover();
    const pop = h('div', { class: 'sl-popover' }, content);
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.left))}px`;
    pop.style.top = `${Math.max(8, Math.min(innerHeight - pop.offsetHeight - 8, r.bottom + 6))}px`;
    this.popover = pop;
    // A click elsewhere or Esc closes it; both listeners go with it.
    const outside = (e: Event) => {
      if (!pop.contains(e.target as Node) && !anchor.contains(e.target as Node)) this.closePopover();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      this.closePopover();
    };
    addEventListener('pointerdown', outside, true);
    addEventListener('keydown', onKey, true);
    this.popoverCleanup = () => {
      removeEventListener('pointerdown', outside, true);
      removeEventListener('keydown', onKey, true);
    };
  }

  private async insertIdentity(): Promise<void> {
    if (this.editor.doc.readOnly) return;
    this.closePopover();
    this.editor.toast(tr('Добавляю шаблон «Новая айдентика»…'));
    try {
      const { loadSlideTemplate } = await import('../slide-templates.ts');
      const { importPptxInto } = await import('../pptx/import-run.ts');
      const file = await loadSlideTemplate('identity');
      const { note } = await importPptxInto(this.editor, file, this.currentSlide());
      this.editor.toast(note);
    } catch (error) {
      this.editor.toast(error instanceof Error ? error.message : tr('Не удалось добавить шаблон'), 'error');
    }
  }

  private openLayouts(anchor: HTMLElement): void {
    if (this.editor.doc.readOnly) return;
    const theme = currentTheme(this.editor.doc);
    const grid = h(
      'div',
      { class: 'sl-layouts', role: 'menu', 'aria-label': tr('Раскладка нового слайда') },
      ...slideLayouts().map((l) => {
        const b = h('button', { class: 'sl-layout', type: 'button', role: 'menuitem' }, layoutPicture(l.id, theme), h('span', {}, l.name));
        b.addEventListener('click', () => {
          this.closePopover();
          this.addSlide(l.id);
        });
        return b;
      }),
    );
    this.openPopover(anchor, h('div', {}, h('div', { class: 'new-kind-title' }, tr('Новый слайд')), grid));
  }

  private openFormats(anchor: HTMLElement): void {
    const now = slideSize(this.editor.doc, this.editor.pageId);
    const list = h(
      'div',
      { class: 'sl-formats', role: 'menu', 'aria-label': tr('Формат слайдов') },
      ...slideFormats().map((f) => {
        const on = f.size.w === now.w && f.size.h === now.h;
        const b = h('button', { class: `sl-format-item${on ? ' on' : ''}`, type: 'button', role: 'menuitemradio', 'aria-checked': String(on), disabled: this.editor.doc.readOnly }, h('span', { class: 'sl-format-pic' }, formatPicture(f.size, 28)), h('span', { class: 'sl-format-text' }, h('strong', {}, f.name), h('span', {}, `${f.hint} · ${f.size.w}×${f.size.h}`)));
        b.addEventListener('click', () => {
          this.closePopover();
          setSlideFormat(this.editor, f.size);
          this.all = true;
          this.schedule();
          requestAnimationFrame(() => this.restoreView());
        });
        return b;
      }),
    );
    this.openPopover(anchor, h('div', {}, h('div', { class: 'new-kind-title' }, tr('Формат: слайды подстроятся целиком')), list));
  }

  private openThemes(anchor: HTMLElement): void {
    const now = currentTheme(this.editor.doc);
    const grid = h(
      'div',
      { class: 'sl-themes', role: 'menu', 'aria-label': tr('Тема презентации') },
      ...slideThemes().map((t) => {
        const b = h('button', { class: `sl-theme-card${t.id === now.id ? ' on' : ''}`, type: 'button', role: 'menuitemradio', 'aria-checked': String(t.id === now.id), disabled: this.editor.doc.readOnly }, themePicture(t), h('span', {}, t.name));
        b.addEventListener('click', () => {
          this.closePopover();
          applySlideTheme(this.editor, t);
        });
        return b;
      }),
    );
    this.openPopover(anchor, h('div', {}, h('div', { class: 'new-kind-title' }, tr('Тема: цвета и шрифты всех слайдов')), grid));
  }
}

/** A theme as a small slide: its background, a heading line in its font, the accent. */
function themePicture(t: SlideTheme): HTMLElement {
  return h(
    'span',
    { class: 'sl-theme-pic', style: { background: t.bg, color: t.text } },
    h('span', { class: 'sl-theme-aa', style: { fontFamily: `"${t.heading}", system-ui`, fontWeight: String(t.headingWeight) } }, 'Аа'),
    h('span', { class: 'sl-theme-bar', style: { background: t.accent } }),
    h('span', { class: 'sl-theme-line', style: { background: t.muted } }),
  );
}

/** A layout as a sketch in the theme's colours (16 : 9). */
function layoutPicture(layout: SlideLayout, t: SlideTheme): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 96 54');
  svg.setAttribute('aria-hidden', 'true');
  const r = (x: number, y: number, w: number, hh: number, fill: string, rx = 1) => `<rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="${rx}" fill="${fill}"/>`;
  const body = {
    title: r(8, 20, 1.5, 12, t.accent, 0.5) + r(12, 20, 52, 6, t.text) + r(12, 29, 34, 3, t.muted),
    section: r(8, 20, 16, 2, t.accent) + r(8, 25, 56, 7, t.text),
    titleText: r(8, 8, 46, 5, t.text) + r(8, 18, 60, 2.5, t.muted) + r(8, 23, 54, 2.5, t.muted) + r(8, 28, 40, 2.5, t.muted),
    twoColumns: r(8, 8, 36, 5, t.text) + r(8, 18, 20, 3, t.accent) + r(8, 24, 36, 2, t.muted) + r(8, 28, 30, 2, t.muted) + r(52, 18, 20, 3, t.accent) + r(52, 24, 36, 2, t.muted) + r(52, 28, 30, 2, t.muted),
    imageText: r(0, 0, 48, 54, t.surface, 0) + r(54, 18, 32, 5, t.text) + r(54, 27, 34, 2, t.muted) + r(54, 31, 28, 2, t.muted),
    threeCards: r(8, 6, 40, 5, t.text) + [0, 1, 2].map((i) => r(8 + i * 27.3, 16, 25, 32, t.surface, 2) + r(11 + i * 27.3, 20, 8, 4, t.accent)).join(''),
    quote: r(8, 8, 6, 8, t.accent) + r(12, 20, 64, 4, t.text) + r(12, 26, 50, 4, t.text) + r(12, 36, 30, 2, t.muted),
    bigNumber: r(8, 12, 36, 16, t.accent, 2) + r(8, 33, 50, 3, t.text) + r(8, 39, 30, 2, t.muted),
    blank: '',
  }[layout];
  svg.innerHTML = `<rect width="96" height="54" rx="3" fill="${t.bg}" stroke="rgba(0,0,0,.12)"/>${body}`;
  return svg;
}

/** A format as a small rectangle of its proportions. */
function formatPicture(size: { w: number; h: number }, box: number): HTMLElement {
  const k = box / Math.max(size.w, size.h);
  return h('span', { class: 'sl-format-rect', style: { width: `${Math.max(4, Math.round(size.w * k))}px`, height: `${Math.max(4, Math.round(size.h * k))}px` } });
}
