// "Export to PowerPoint" window (FEAT-038): the "Layers to PPTX" Figma plugin,
// built into the editor. Selected frames (or every frame of the page) become
// slides in reading order; text stays editable text, shapes stay shapes.

import { plural, tr } from '#core';
import { base64ToBytes, type NodeId } from '#core';
import { exportSvg, rasterize, renderThumbnail, layerPicture, zip, type Canvas2DRenderer } from '#render';
import type { Editor } from '../editor.ts';
import { safeName } from '../exporter.ts';
import { clear, download, h, icon } from '../ui/dom.ts';
import { collectSlides, slideTargets, type CollectEnv } from './collect.ts';
import { BRAND_FACES } from '../t2-fonts.ts';
import { documentFaces, localFaces, useOfficeFonts } from './fonts.ts';
import { buildPptx, PPTX_MIME, type Image } from './writer.ts';

const MAX_THUMBS = 60;

const slides = (n: number) => `${n} ${plural(n, tr('слайд'), tr('слайда'), tr('слайдов'))}`;

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** The browser half of the export: rendering, SVG and image bytes. */
function browserEnv(editor: Editor, renderer: Canvas2DRenderer): CollectEnv {
  const scene = editor.scene;
  return {
    async raster(id, scale) {
      const { canvas, bounds } = await rasterize(renderer, scene, id, scale);
      return { bytes: await blobBytes(await canvas.convertToBlob({ type: 'image/png' })), bounds };
    },
    svg(id) {
      try {
        return exportSvg(scene, editor.measurer, [id], renderer.images, { picture: (n) => layerPicture(renderer, scene, n) }).svg;
      } catch {
        return null;
      }
    },
    async image(hash) {
      const blob = editor.doc.store.blobs.get(hash);
      if (!blob) return null;
      const bytes = base64ToBytes(blob.data);
      const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: blob.mime })).catch(() => null);
      if (!bitmap) return null;
      const { width, height } = bitmap;
      const ext: Image['ext'] | null = blob.mime === 'image/png' ? 'png' : blob.mime === 'image/jpeg' ? 'jpeg' : blob.mime === 'image/gif' ? 'gif' : null;
      if (ext) return { bytes, ext, width, height };
      // WebP and others: PowerPoint wants PNG.
      const canvas = new OffscreenCanvas(width, height);
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
      return { bytes: await blobBytes(await canvas.convertToBlob({ type: 'image/png' })), ext: 'png', width, height };
    },
    world: (id) => scene.world(id),
    bounds: (id) => scene.bounds(id),
  };
}

export class PptxExportDialog {
  private readonly editor: Editor;
  private readonly renderer: Canvas2DRenderer;
  private readonly overlay: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly notes: HTMLElement;
  private readonly status: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly tabs: Record<'selection' | 'page', HTMLButtonElement>;
  private readonly mode: HTMLSelectElement;
  private readonly size: HTMLSelectElement;
  private readonly scale: HTMLSelectElement;
  private readonly svg: HTMLInputElement;
  private readonly groups: HTMLInputElement;
  private readonly fileName: HTMLInputElement;
  private readonly vectorOptions: HTMLElement[];
  private scope: 'selection' | 'page';
  private ids: NodeId[] = [];
  private busy = false;

  constructor(editor: Editor, renderer: Canvas2DRenderer) {
    this.editor = editor;
    this.renderer = renderer;
    this.scope = editor.selection.length ? 'selection' : 'page';
    this.grid = h('div', { class: 'px-grid' });
    this.notes = h('div', { class: 'px-notes' });
    this.status = h('p', { class: 'hi-status', role: 'status' });
    this.progress = h('div', { class: 'px-progress', hidden: true }, h('div'));
    this.button = h('button', { class: 'text-button primary', type: 'button', onclick: () => void this.run() }, tr('Скачать PPTX'));

    const tab = (label: string, scope: 'selection' | 'page') => h('button', { class: 'auth-tab', type: 'button', role: 'tab', onclick: () => this.setScope(scope) }, label);
    this.tabs = { selection: tab(tr('Выделенное'), 'selection'), page: tab(tr('Вся страница'), 'page') };

    const select = (label: string, options: [string, string][], value: string) => {
      const el = h('select', { class: 'share-select hi-width', 'aria-label': label });
      for (const [v, text] of options) el.append(h('option', { value: v }, text));
      el.value = value;
      return { el, row: h('label', { class: 'share-setting' }, h('span', {}, label), el) };
    };
    const mode = select(tr('Как переносить'), [['editable', tr('Редактируемые слои')], ['image', tr('Картинками: слайд = PNG')]], 'editable');
    const size = select(tr('Размер слайда'), [['standard', tr('Стандарт PowerPoint')], ['px', tr('Как во фрейме')]], 'standard');
    const scale = select(tr('Качество картинок'), [['1', '1×'], ['2', '2×'], ['3', '3×']], '2');
    this.mode = mode.el;
    this.size = size.el;
    this.scale = scale.el;
    const check = (label: string, hint: string) => {
      const input = h('input', { type: 'checkbox', checked: true });
      return { input, el: h('label', { class: 'hi-check' }, input, h('span', {}, h('strong', {}, label), h('small', {}, hint))) };
    };
    const svg = check(tr('Иконки и векторы — в SVG'), tr('Чёткие при любом масштабе. Старые версии PowerPoint покажут PNG-копию'));
    const groups = check(tr('Группировать как во фреймах'), tr('Содержимое каждого фрейма и группы станет группой в PowerPoint'));
    this.svg = svg.input;
    this.groups = groups.input;
    this.vectorOptions = [svg.el, groups.el];
    this.mode.addEventListener('change', () => this.refreshOptions());
    this.fileName = h('input', { class: 'dialog-input px-name', type: 'text', spellcheck: 'false', value: safeName(editor.doc.get(editor.doc.rootId, 'name')) });

    const close = h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть'), onclick: () => this.close() }, icon('close'));
    const dialog = h(
      'div',
      { class: 'dialog hi-dialog px-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('Экспорт в PowerPoint') },
      h('header', { class: 'dialog-header' }, h('h2', {}, tr('Экспорт в PowerPoint')), close),
      h(
        'div',
        { class: 'hi-body' },
        h(
          'div',
          { class: 'hi-side' },
          h('p', { class: 'share-muted' }, tr('Каждый фрейм станет слайдом. Текст останется текстом, который можно править в PowerPoint и Keynote; фигуры, градиенты, тени и картинки — объектами презентации.')),
          h('div', { class: 'auth-tabs', role: 'tablist' }, this.tabs.selection, this.tabs.page),
          mode.row,
          size.row,
          scale.row,
          svg.el,
          groups.el,
          h('label', { class: 'share-setting' }, h('span', {}, tr('Имя файла')), h('span', { class: 'px-suffix' }, this.fileName, h('span', {}, '.pptx'))),
        ),
        h('div', { class: 'hi-main' }, this.grid, this.notes),
      ),
      h('footer', { class: 'dialog-footer hi-footer' }, h('div', { class: 'px-state' }, this.status, this.progress), this.button),
    );
    this.overlay = h('div', { class: 'dialog-overlay' }, dialog);
    this.overlay.addEventListener('pointerdown', (e) => {
      if (e.target === this.overlay && !this.busy) this.close();
    });
    dialog.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' && !this.busy) this.close();
    });
    document.body.append(this.overlay);
    this.setScope(this.scope);
    this.button.focus();
  }

  close(): void {
    this.overlay.remove();
  }

  private setScope(scope: 'selection' | 'page'): void {
    if (this.busy) return;
    const editor = this.editor;
    const found = slideTargets(editor.doc, editor.pageId, scope === 'selection' ? editor.topLevelSelection() : [], (id) => editor.scene.bounds(id));
    this.scope = found.scope;
    this.ids = found.ids;
    this.tabs.selection.classList.toggle('active', this.scope === 'selection');
    this.tabs.page.classList.toggle('active', this.scope === 'page');
    this.renderGrid();
    this.renderNotes(scope === 'selection' && found.scope === 'page');
    this.setStatus('');
    this.refreshButton();
  }

  private renderGrid(): void {
    clear(this.grid);
    if (!this.ids.length) {
      this.grid.append(h('p', { class: 'hi-empty px-empty' }, tr('На странице нет фреймов. Нарисуйте фрейм (F) — он станет слайдом.')));
      return;
    }
    const doc = this.editor.doc;
    this.ids.forEach((id, i) => {
      const canvas = h('canvas', { class: 'px-canvas' });
      const card = h('figure', { class: 'px-slide', title: doc.get(id, 'name') }, h('div', { class: 'px-thumb' }, canvas, h('span', { class: 'px-n' }, String(i + 1))), h('figcaption', {}, doc.get(id, 'name')));
      this.grid.append(card);
      if (i < MAX_THUMBS) requestAnimationFrame(() => renderThumbnail(this.renderer, this.editor.scene, id, canvas, 240, 135, 0));
    });
  }

  private renderNotes(noSelection: boolean): void {
    clear(this.notes);
    const note = (text: string, warn = false) => this.notes.append(h('p', { class: warn ? 'hi-note px-warn' : 'hi-note' }, text));
    if (noSelection) note(tr('Ничего не выделено — экспортируются все фреймы страницы.'));
    if (this.ids.length > 1) {
      note(tr('Порядок слайдов — как на холсте: по рядам сверху вниз, в ряду слева направо.'));
      const b = this.ids.map((id) => this.editor.scene.bounds(id));
      if (b.some((r) => Math.abs(r.width - b[0]!.width) > 0.5 || Math.abs(r.height - b[0]!.height) > 0.5)) note(tr('У фреймов разный размер: размер слайда берётся по первому, остальные вписываются по центру.'), true);
    }
  }

  private refreshOptions(): void {
    const image = this.mode.value === 'image';
    for (const el of this.vectorOptions) el.classList.toggle('px-off', image);
  }

  private refreshButton(): void {
    this.button.disabled = this.busy || !this.ids.length;
    this.button.textContent = this.ids.length ? tr('Скачать PPTX — {0}', slides(this.ids.length)) : tr('Скачать PPTX');
  }

  private setStatus(text: string, error = false): void {
    this.status.textContent = text;
    this.status.classList.toggle('error', error);
  }

  private setProgress(p: number | null): void {
    this.progress.hidden = p === null;
    (this.progress.firstElementChild as HTMLElement).style.width = `${Math.round((p ?? 0) * 100)}%`;
  }

  private async run(): Promise<void> {
    if (this.busy || !this.ids.length) return;
    this.busy = true;
    this.refreshButton();
    // While the click is fresh: the browser may ask for the computer's fonts.
    const local = localFaces();
    try {
      const collected = await collectSlides(
        this.editor.doc,
        this.ids,
        browserEnv(this.editor, this.renderer),
        { mode: this.mode.value === 'image' ? 'image' : 'editable', scale: Number(this.scale.value) || 2, svg: this.svg.checked, groups: this.groups.checked },
        (done, total) => {
          this.setStatus(tr('Собираю слайд {0} из {1}…', Math.min(done + 1, total), total));
          this.setProgress((done / total) * 0.9);
        },
      );
      const brand = BRAND_FACES.map((face) => ({
        family: face.family,
        weight: Number(face.weight),
        italic: false,
        bytes: async () => new Uint8Array(await (await fetch(face.url)).arrayBuffer()),
      }));
      const fonts = await useOfficeFonts(collected.slides, [...documentFaces(this.editor.doc), ...brand, ...(await local)]);
      this.setStatus(tr('Упаковываю файл…'));
      const name = safeName(this.fileName.value.replace(/\.pptx$/i, '')) || tr('Презентация');
      const files = buildPptx(collected.slides, collected.images, { size: this.size.value === 'px' ? 'px' : 'standard', title: name });
      const packed = await zip(files);
      download(new Blob([packed], { type: PPTX_MIME }), `${name}.pptx`);
      this.setProgress(null);
      const lines = [tr('Готово: {0}.', slides(collected.slides.length))];
      if (collected.rasterized) lines.push(tr('Картинкой вставлено: {0} (иконки, векторы, эффекты).', collected.rasterized));
      if (fonts.fonts.length) lines.push(tr('Шрифты: {0} — они должны быть установлены там, где откроют презентацию.', fonts.fonts.join(', ')));
      for (const m of fonts.missing)
        lines.push(
          m.like
            ? tr('Шрифта «{0}» нет ни в файле, ни на этом компьютере — PowerPoint покажет вместо него другой. Похоже, имелся в виду «{1}»: замените его через «Заменить шрифты…».', m.family, m.like)
            : tr('Шрифта «{0}» нет ни в файле, ни на этом компьютере — PowerPoint покажет вместо него другой.', m.family),
        );
      this.setStatus(lines.join(' '), fonts.missing.length > 0);
    } catch (error) {
      this.setProgress(null);
      this.setStatus(tr('Ошибка: {0}', error instanceof Error ? error.message : String(error)), true);
    } finally {
      this.busy = false;
      this.refreshButton();
    }
  }
}
