// The diagram editor (FEAT-090) — DocPlan's «Схемы» in Simmetrika's look.
// Left: the text of the diagram with its syntax coloured, line numbers and
// the problems found in it. Middle: the picture, moved and zoomed like a
// canvas; a click on a block goes to its line, the caret's line lights its
// block up; nodes of maps and flowcharts can be moved by hand. Right:
// the look — palette, font, spacing, direction — and export.
//
// The diagram lives in the document's root (model.ts): every edit is an
// ordinary change, so undo, versions and editing together work as for any
// file. Typing is one undo step per pause.

import { colorToHex, hexToColor, tr, type DiagramOffsets, type DiagramSpec } from '#core';
import type { Editor, EditorGesture } from '../editor.ts';
import { applyTheme, isDark, onThemeChange } from '../theme.ts';
import { prefsChanged } from '../prefs.ts';
import { h, icon } from '../ui/dom.ts';
import { openColorPicker } from '../ui/color-picker.ts';
import { FontPicker } from '../ui/font-picker.ts';
import { editableZoom } from '../ui/zoom-input.ts';
import { onFontsRegistered } from '../fonts.ts';
import { loadDiagramEngine, type DiagramDiagnostic, type DiagramEngine } from './engine.ts';
import { diagramKind, diagramKindGroups } from './kinds.ts';
import { diagramBackground, diagramDark, diagramFontFamily, diagramSpec, diagramText, moveBranch, paletteFrom, sameDiagramText, withDiagramText } from './model.ts';
import { download, fileNameOf, fontFaceCss, pdfBlob, pngBlob, prepareSvg, svgFile, thumbnailDataUrl, type PreparedSvg } from './export.ts';

export interface DiagramHost {
  toast(message: string, kind?: 'info' | 'error'): void;
  /** The file's name, for exported files. */
  fileName(): string;
  /** Hides or shows the text panel (DocPlan's «Скрыть текст»). */
  toggleText(): void;
  textHidden(): boolean;
}

const INDENT = '    ';
const CARET_KEY = 'cs-diagram-caret';
const PALETTE_NAMES: Record<string, string> = {
  soft: 'Мягкая',
  default: 'Стандартная',
  dark: 'Тёмная',
  neutral: 'Нейтральная',
  neon: 'Неон',
  catppuccin: 'Капучино',
  viridis: 'Viridis',
  tableau: 'Tableau 10',
  mono: 'Без цвета',
};
const SPACING_NAMES: Record<string, string> = { compact: 'Плотно', normal: 'Обычно', spacious: 'Просторно' };

const svgIcon = (inner: string, size = 18): SVGSVGElement => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = inner;
  return svg;
};

export class DiagramView {
  /** The text panel (the left column of the app). */
  readonly source: HTMLElement;
  /** The picture (in the canvas area). */
  readonly stage: HTMLElement;
  /** The look and export (the right column). */
  readonly panel: HTMLElement;

  private readonly editor: Editor;
  private readonly host: DiagramHost;
  private engine: DiagramEngine | null = null;

  private readonly kindButton: HTMLButtonElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly highlight: HTMLElement;
  private readonly gutter: HTMLElement;
  private readonly problems: HTMLElement;
  private readonly canvas: HTMLElement;
  private readonly scalable: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly zoomLabel: HTMLButtonElement;
  private readonly handButton: HTMLButtonElement;
  private readonly moveButton: HTMLButtonElement;
  private readonly resetButton: HTMLButtonElement;
  private readonly panelBody: HTMLElement;

  private svg: SVGSVGElement | null = null;
  private svgW = 0;
  private svgH = 0;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  /** The view was placed by hand (zoom, pan): a new picture keeps it. */
  private placed = false;
  /** What the picture was built from: rebuilt only when it changes. */
  private built = '';
  private typing: EditorGesture | null = null;
  private typingTimer: ReturnType<typeof setTimeout> | null = null;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private tool: 'hand' | 'move' = 'hand';
  private caretHighlight = true;
  private diagnostics: DiagramDiagnostic[] = [];
  private panelFor = '';
  private destroyed = false;

  private fontPicker: FontPicker | null = null;
  private readonly offFonts: () => void;

  constructor(editor: Editor, host: DiagramHost) {
    this.editor = editor;
    this.host = host;
    try {
      this.caretHighlight = localStorage.getItem(CARET_KEY) !== 'off';
    } catch {
      // the default
    }

    // ---------- the text ----------
    this.kindButton = h('button', { class: 'dg-kind', type: 'button', 'aria-haspopup': 'dialog', title: tr('Тип схемы: сменить') });
    this.kindButton.addEventListener('click', () => this.openKinds());
    const example = h('button', { class: 'text-button dg-small', type: 'button', title: tr('Вставить пример этого типа схемы') }, tr('Пример'));
    example.addEventListener('click', () => void this.insertExample());
    this.textarea = h('textarea', { class: 'dg-input', spellcheck: false, autocomplete: 'off', autocapitalize: 'off', wrap: 'off', 'aria-label': tr('Текст схемы') });
    this.highlight = h('pre', { class: 'dg-highlight', 'aria-hidden': 'true' });
    this.gutter = h('div', { class: 'dg-gutter', 'aria-hidden': 'true' });
    this.problems = h('div', { class: 'dg-problems', role: 'list', 'aria-label': tr('Замечания к тексту') });
    this.source = h(
      'aside',
      { class: 'dg-source', 'aria-label': tr('Текст схемы') },
      h('header', { class: 'dg-source-head' }, this.kindButton, h('div', { class: 'dg-source-actions' }, example)),
      h('div', { class: 'dg-editor' }, this.gutter, h('div', { class: 'dg-code' }, this.highlight, this.textarea)),
      this.problems,
    );
    this.bindTextarea();

    // ---------- the picture ----------
    this.scalable = h('div', { class: 'dg-scalable' });
    this.empty = h('div', { class: 'dg-empty', hidden: true });
    // DocPlan's manual layout looks for #diagram.
    this.canvas = h('div', { class: 'dg-canvas', id: 'diagram' }, this.scalable);
    this.handButton = this.dockButton(tr('Рука: двигать холст (H)'), icon('hand', 18), () => this.setTool('hand'));
    this.moveButton = this.dockButton(tr('Двигать блоки (V): рамкой или с Shift — несколько'), icon('select', 18), () => this.setTool('move'));
    this.resetButton = this.dockButton(tr('Вернуть блоки на свои места'), icon('undo', 18), () => this.resetOffsets());
    this.zoomLabel = h('button', { class: 'zoom-label', type: 'button', title: tr('Масштаб: щёлкните и введите процент (вписать всё — Shift+1)') }, '100%');
    editableZoom(this.zoomLabel, () => this.zoom, (zoom) => this.zoomBy(zoom / this.zoom));
    const dock = h(
      'div',
      { class: 'tool-dock dg-dock', role: 'toolbar', 'aria-label': tr('Холст схемы') },
      this.handButton,
      this.moveButton,
      this.resetButton,
      h('span', { class: 'dock-separator', 'aria-hidden': 'true' }),
      this.dockButton(tr('Уменьшить (−)'), icon('minus', 18), () => this.zoomBy(1 / 1.25)),
      this.zoomLabel,
      this.dockButton(tr('Увеличить (+)'), icon('plus', 18), () => this.zoomBy(1.25)),
      this.dockButton(tr('Вписать в экран (Shift+1)'), icon('fit', 18), () => this.fit()),
      this.dockButton(tr('Во весь экран'), icon('expand', 18), () => this.fullscreen()),
    );
    const textToggle = (this.textToggle = this.dockButton(tr('Скрыть или показать текст (⌘\\)'), icon('panelLeft', 18), () => {
      this.host.toggleText();
      textToggle.classList.toggle('active', !this.host.textHidden());
    }));
    textToggle.classList.add('active');
    dock.prepend(textToggle, h('span', { class: 'dock-separator', 'aria-hidden': 'true' }));
    this.stage = h('section', { class: 'dg-stage', 'aria-label': tr('Схема') }, this.canvas, this.empty, dock);
    this.bindStage();

    // ---------- the look ----------
    this.panelBody = h('div', { class: 'dg-panel-body' });
    this.panel = h('aside', { class: 'dg-panel', 'aria-label': tr('Оформление схемы') }, this.panelBody);

    this.editor.events.on('change', ({ source }) => this.onDocChange(source));
    onThemeChange(() => this.render(true));
    // The file's fonts came (on opening, or one just added): the diagram was measured with a fallback.
    this.offFonts = onFontsRegistered(() => this.render(true));
    new ResizeObserver(() => {
      if (!this.placed) this.fit(false);
      else this.applyTransform();
    }).observe(this.canvas);
    void loadDiagramEngine()
      .then((engine) => {
        this.engine = engine;
        this.syncAll();
        // A new diagram: what kind it will be is the first thing to choose.
        if (diagramSpec(this.editor.doc).fresh && !this.editor.doc.readOnly) this.openKinds(true);
      })
      .catch(() => {
        this.showEmpty(tr('Не загрузился модуль схем. Обновите страницу.'));
      });
  }

  // ---------- state ----------

  private spec(): DiagramSpec {
    return diagramSpec(this.editor.doc);
  }

  private get readOnly(): boolean {
    return this.editor.doc.readOnly;
  }

  /** The text shown: what is written for this kind, or its example (shown, not saved, until edited). */
  private text(spec = this.spec()): string {
    return diagramText(spec) ?? this.engine?.example(spec.layout, spec.direction) ?? '';
  }

  private change(label: string, fn: (spec: DiagramSpec) => DiagramSpec): void {
    if (this.readOnly) return;
    this.flushTyping();
    const next = fn(this.spec());
    this.editor.commit(label, (tx) => tx.set(this.editor.doc.rootId, 'diagram', next));
  }

  private onDocChange(source: string): void {
    if (this.destroyed) return;
    // Our own typing is already in the textarea; anything else (undo, someone else) is brought in.
    if (source !== 'local' || !this.typing) this.syncText();
    this.fontPicker?.refresh();
    this.syncKind();
    this.syncPanel();
    this.scheduleRender();
  }

  private syncAll(): void {
    this.syncKind();
    this.syncText();
    this.syncPanel();
    this.render();
  }

  // ---------- the text ----------

  private syncText(): void {
    const text = this.text();
    if (this.textarea.value !== text) {
      const { selectionStart, selectionEnd } = this.textarea;
      const focused = document.activeElement === this.textarea;
      this.textarea.value = text;
      if (focused) this.textarea.setSelectionRange(Math.min(selectionStart, text.length), Math.min(selectionEnd, text.length));
    }
    this.textarea.readOnly = this.readOnly;
    this.paintText();
  }

  private paintText(): void {
    const text = this.textarea.value;
    const layout = this.spec().layout;
    // A trailing newline keeps the layer as tall as the textarea.
    let html = `${this.engine ? this.engine.highlight(text, layout) : escapeHtml(text)}\n`;
    // The line of a block picked on the picture, marked for a moment (a selection in the clear textarea is faint).
    if (this.jumpLine > 0) {
      const parts = html.split('\n');
      const i = this.jumpLine - 1;
      if (i < parts.length) parts[i] = `<span class="dg-jump-line">${parts[i] || '&nbsp;'}</span>`;
      html = parts.join('\n');
    }
    this.highlight.innerHTML = html;
    const lines = text.split('\n').length;
    if (this.gutter.childElementCount !== lines) {
      const frag = document.createDocumentFragment();
      for (let i = 1; i <= lines; i++) frag.append(h('div', { class: 'dg-line-no' }, String(i)));
      this.gutter.replaceChildren(frag);
    }
    this.markProblemLines();
    this.syncScroll();
  }

  private syncScroll(): void {
    this.highlight.scrollTop = this.textarea.scrollTop;
    this.highlight.scrollLeft = this.textarea.scrollLeft;
    this.gutter.scrollTop = this.textarea.scrollTop;
  }

  /** Typing: one undo step per pause; the picture follows a moment later. */
  private onInput(): void {
    this.jumpLine = 0;
    if (this.readOnly) return;
    const value = this.textarea.value;
    const spec = this.spec();
    this.typing ??= this.editor.beginGesture(tr('Текст схемы'));
    this.typing.update((tx) => tx.set(this.editor.doc.rootId, 'diagram', withDiagramText(spec, value)));
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => this.flushTyping(), 900);
    this.paintText();
    this.scheduleRender(150);
  }

  private flushTyping(): void {
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = null;
    const typing = this.typing;
    this.typing = null;
    typing?.commit();
  }

  private bindTextarea(): void {
    const ta = this.textarea;
    ta.addEventListener('input', () => this.onInput());
    ta.addEventListener('scroll', () => this.syncScroll());
    const caret = () => this.lightCaretLine();
    ta.addEventListener('keyup', caret);
    ta.addEventListener('click', caret);
    ta.addEventListener('focus', caret);
    ta.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      // Undo and redo go through the file's history (the textarea's own would not know of the rest).
      if (mod && !e.altKey && (key === 'z' || key === 'y' || key === 'я' || key === 'н')) {
        e.preventDefault();
        e.stopPropagation();
        this.flushTyping();
        if ((key === 'z' || key === 'я') && !e.shiftKey) this.editor.undo();
        else this.editor.redo();
        return;
      }
      // The file's shortcuts stay with the file; typing keys stay in the text.
      if (!mod) e.stopPropagation();
      if (this.readOnly || e.isComposing) return;
      if (e.key === 'Tab') {
        e.preventDefault();
        this.indent(e.shiftKey);
      } else if (e.key === 'Enter' && !e.shiftKey && !mod && !e.altKey) {
        // A new line keeps the indent (tabs become four spaces, as Tab writes them).
        e.preventDefault();
        const { selectionStart: start, selectionEnd: end, value } = ta;
        const lineStart = value.lastIndexOf('\n', start - 1) + 1;
        const indent = (/^[ \t]*/.exec(value.slice(lineStart))?.[0] ?? '').replace(/\t/g, INDENT);
        this.replace(start, end, `\n${indent}`, start + 1 + indent.length, start + 1 + indent.length);
      } else if (e.key === 'Escape') {
        ta.blur();
      }
    });
  }

  /** Tab / Shift+Tab: four spaces in or out — for the line or every selected line (DocPlan's rules). */
  private indent(out: boolean): void {
    const ta = this.textarea;
    const { selectionStart: start, selectionEnd: end, value } = ta;
    const lead = (line: string) => (line.startsWith(INDENT) ? INDENT.length : line.startsWith('\t') ? 1 : (/^ {1,3}/.exec(line)?.[0].length ?? 0));
    const multi = start !== end && value.slice(start, end).includes('\n');
    if (multi) {
      const blockStart = value.lastIndexOf('\n', start - 1) + 1;
      const endPos = value[end - 1] === '\n' ? end - 1 : end;
      const nl = value.indexOf('\n', endPos);
      const blockEnd = nl < 0 ? value.length : nl;
      const lines = value.slice(blockStart, blockEnd).split('\n');
      if (out) {
        let before = 0;
        let total = 0;
        let pos = blockStart;
        const next = lines
          .map((line) => {
            const r = lead(line);
            if (r && pos + r <= start) before += r;
            total += r;
            pos += line.length + 1;
            return line.slice(r);
          })
          .join('\n');
        const s = Math.max(blockStart, start - before);
        this.replace(blockStart, blockEnd, next, s, Math.max(s, end - total));
      } else {
        const before = value.slice(blockStart, start).split('\n').length;
        this.replace(blockStart, blockEnd, lines.map((l) => INDENT + l).join('\n'), start + INDENT.length * before, end + INDENT.length * lines.length);
      }
      return;
    }
    if (out) {
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const r = lead(value.slice(lineStart));
      if (r > 0) {
        const at = Math.max(lineStart, start - r);
        this.replace(lineStart, lineStart + r, '', at, at);
      }
      return;
    }
    this.replace(start, end, INDENT, start + INDENT.length, start + INDENT.length);
  }

  private replace(from: number, to: number, text: string, selStart: number, selEnd: number): void {
    const ta = this.textarea;
    ta.value = ta.value.slice(0, from) + text + ta.value.slice(to);
    ta.setSelectionRange(selStart, selEnd);
    this.onInput();
  }

  private lineAtCaret(): number {
    const ta = this.textarea;
    return ta.value.slice(0, ta.selectionStart).split('\n').length;
  }

  /** The line of a block picked on the picture (right click, ⌘-click): selected, marked, the text shown. */
  private jumpTo(line: number): void {
    if (this.host.textHidden()) {
      this.host.toggleText();
      this.textToggle?.classList.add('active');
    }
    this.goToLine(line);
    this.jumpLine = line;
    if (this.jumpTimer) clearTimeout(this.jumpTimer);
    this.jumpTimer = setTimeout(() => {
      this.jumpLine = 0;
      this.paintText();
    }, 4000);
    this.paintText();
  }

  private jumpLine = 0;
  private textToggle: HTMLButtonElement | null = null;
  private jumpTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The source line of what is under the pointer (DocPlan's rules): the
   * smallest block containing the point, else anything under it, else the
   * nearest block within 28 px.
   */
  private lineAt(target: EventTarget | null, x: number, y: number): number | null {
    const svg = this.svg;
    if (!svg) return null;
    const lineOf = (el: Element | null | undefined) => {
      const n = Number(el?.closest('[data-source-line]')?.getAttribute('data-source-line'));
      return el && svg.contains(el) && Number.isFinite(n) && n > 0 ? n : null;
    };
    const direct = target instanceof Element ? lineOf(target) : null;
    if (direct) return direct;
    for (const el of document.elementsFromPoint(x, y)) {
      const n = lineOf(el);
      if (n) return n;
    }
    let inside: { line: number; area: number } | null = null;
    let near: { line: number; d: number } | null = null;
    for (const el of svg.querySelectorAll('[data-source-line]')) {
      const r = el.getBoundingClientRect();
      if (r.width < 0.5 && r.height < 0.5) continue;
      const line = Number(el.getAttribute('data-source-line'));
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        const area = r.width * r.height;
        if (!inside || area < inside.area) inside = { line, area };
        continue;
      }
      const d = Math.hypot(x - Math.min(Math.max(x, r.left), r.right), y - Math.min(Math.max(y, r.top), r.bottom));
      if (!near || d < near.d) near = { line, d };
    }
    if (inside) return inside.line;
    return near && near.d <= 28 ? near.line : null;
  }

  /** Puts the caret on a line (from a click on its block, or a problem). */
  private goToLine(line: number): void {
    const ta = this.textarea;
    const lines = ta.value.split('\n');
    const n = Math.max(1, Math.min(lines.length, line));
    let start = 0;
    for (let i = 0; i < n - 1; i++) start += lines[i]!.length + 1;
    const end = start + lines[n - 1]!.length;
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(start, end);
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    const top = (n - 1) * lineHeight;
    if (top < ta.scrollTop || top > ta.scrollTop + ta.clientHeight - lineHeight * 2) ta.scrollTop = Math.max(0, top - ta.clientHeight / 3);
    this.syncScroll();
    this.lightCaretLine();
  }

  private lightCaretLine(): void {
    const svg = this.svg;
    if (!svg) return;
    for (const el of svg.querySelectorAll('.is-source-line-active')) el.classList.remove('is-source-line-active');
    if (!this.caretHighlight || document.activeElement !== this.textarea) return;
    const n = this.lineAtCaret();
    let nodes = [...svg.querySelectorAll(`[data-source-line="${n}"]`)];
    if (nodes.length === 0) {
      // The nearest line above (nested blocks often sit on their own lines).
      let best: Element | null = null;
      let bestLine = -1;
      for (const el of svg.querySelectorAll('[data-source-line]')) {
        const line = Number(el.getAttribute('data-source-line'));
        if (line <= n && line >= bestLine) {
          bestLine = line;
          best = el;
        }
      }
      if (best) nodes = [best];
    }
    for (const el of nodes) el.classList.add('is-source-line-active');
  }

  // ---------- problems ----------

  private showProblems(list: DiagramDiagnostic[]): void {
    this.diagnostics = list;
    const order = { error: 0, warning: 1, info: 2 } as const;
    const sorted = [...list].sort((a, b) => order[a.severity] - order[b.severity] || (a.line ?? 0) - (b.line ?? 0));
    this.problems.replaceChildren(
      ...sorted.slice(0, 50).map((d) => {
        const row = h(
          'button',
          { class: `dg-problem ${d.severity}`, type: 'button', role: 'listitem', disabled: d.line === null },
          h('span', { class: 'dg-problem-dot', 'aria-hidden': 'true' }),
          h(
            'span',
            { class: 'dg-problem-text' },
            h('span', {}, d.line !== null ? tr('Строка {0}: {1}', d.line, d.message) : d.message),
            d.hint ? h('code', { class: 'dg-problem-hint' }, d.hint) : '',
          ),
        );
        if (d.line !== null) row.addEventListener('click', () => this.goToLine(d.line!));
        return row;
      }),
    );
    this.problems.hidden = list.length === 0;
    this.markProblemLines();
  }

  private markProblemLines(): void {
    const marks = new Map<number, string>();
    for (const d of this.diagnostics) if (d.line !== null && (d.severity === 'error' || !marks.has(d.line))) marks.set(d.line, d.severity);
    this.gutter.querySelectorAll('.dg-line-no').forEach((el, i) => {
      const sev = marks.get(i + 1);
      el.className = sev ? `dg-line-no ${sev}` : 'dg-line-no';
    });
  }

  // ---------- the picture ----------

  private scheduleRender(delay = 60): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => this.render(), delay);
  }

  /** Builds the picture when what it is made of changed (or `force`: the theme). */
  private render(force = false): void {
    const engine = this.engine;
    if (!engine || this.destroyed) return;
    const spec = this.spec();
    const text = this.text(spec);
    const look = engine.theme(spec.layout, spec.theme);
    const dark = diagramDark(spec, isDark());
    // A diagram drawn otherwise than the interface gets a canvas of its own theme (else it would not read).
    this.stage.classList.toggle('dg-light', !dark && isDark());
    this.stage.classList.toggle('dg-dark', dark && !isDark());
    // Colours of one's own, unless the kind has colours of its own (they carry its meaning).
    const colors = spec.colors?.length && look.locked !== 'all' ? spec.colors : undefined;
    const key = JSON.stringify([spec.layout, text, look.theme, colors ?? null, spec.font, spec.direction, spec.spacing, spec.offsets[spec.layout] ?? null, dark, this.tool]);
    if (key === this.built && !force) return;
    const layoutChanged = !this.built.startsWith(JSON.stringify([spec.layout]).slice(0, -1));
    this.built = key;
    // DocPlan's manual layout reads these.
    document.body.dataset.diagramLayout = spec.layout;
    engine.manual.setOverrides(spec.offsets[spec.layout] ?? { nodes: {} });
    engine.manual.setEnabled(this.tool === 'move' && engine.manual.supports(spec.layout) && !this.readOnly);
    let result;
    try {
      result = engine.render({ text, layout: spec.layout, theme: look.theme, font: spec.font, direction: spec.direction, spacing: spec.spacing, dark, ...(colors ? { colors } : {}) });
    } catch (error) {
      result = { errorMessage: error instanceof Error ? error.message : String(error), direction: spec.direction } as const;
    }
    this.showProblems(result.diagnostics ?? []);
    if (!result.svg) {
      this.svg = null;
      this.scalable.replaceChildren();
      this.showEmpty(result.errorMessage ? tr('Ошибка построения: {0}', result.errorMessage) : (result.emptyMessage ?? tr('Напишите текст схемы слева')));
      return;
    }
    this.empty.hidden = true;
    // No slab under the diagram: it lies on the dotted canvas (exports add their own background).
    engine.stripBackground(result.svg);
    this.svg = result.svg;
    this.svgW = result.width ?? 0;
    this.svgH = result.height ?? 0;
    this.scalable.replaceChildren(result.svg);
    if (engine.manual.enabled()) engine.manual.bind(result.svg);
    for (const el of result.svg.querySelectorAll<SVGElement>('[data-pdf-href]')) el.style.cursor = 'pointer';
    if (layoutChanged || !this.placed) this.fit(false);
    else this.applyTransform();
    this.lightCaretLine();
    this.syncDock();
  }

  private showEmpty(message: string): void {
    this.empty.textContent = message;
    this.empty.hidden = false;
    this.syncDock();
  }

  /** Re-render requested by the manual layout (after a drag): the moved nodes are saved first. */
  rerender(): void {
    this.render(true);
  }

  /** The manual layout moved nodes: their offsets go into the file. */
  saveOffsets(): void {
    const engine = this.engine;
    if (!engine || this.readOnly) return;
    const spec = this.spec();
    const now: DiagramOffsets = engine.manual.overrides();
    const before = spec.offsets[spec.layout] ?? { nodes: {} };
    if (JSON.stringify(now) === JSON.stringify(before)) return;
    if (this.dropIntoNode(now, before)) return;
    this.change(tr('Сдвинуть блоки'), (s) => ({ ...s, offsets: { ...s.offsets, [s.layout]: now } }));
  }

  /** Where the pointer was last over the picture (for a drop onto a node). */
  private lastPointer: { x: number; y: number } | null = null;

  private dropTarget: Element | null = null;

  private markDropTarget(g: Element | null): void {
    if (g === this.dropTarget) return;
    this.dropTarget?.classList.remove('dg-drop-target');
    this.dropTarget = g;
    g?.classList.add('dg-drop-target');
  }

  /** The map node under a point that is not one of those being dragged (picked ones). */
  private dropTargetAt(x: number, y: number): Element | null {
    const svg = this.svg;
    if (!svg || !['radial', 'classic', 'horizontal'].includes(this.spec().layout)) return null;
    const picked = [...svg.querySelectorAll('g.mm-node.is-selected[data-node-id]')].map((g) => g.getAttribute('data-node-id')!);
    for (const el of document.elementsFromPoint(x, y)) {
      const g = el.closest('g.mm-node[data-node-id]');
      const id = g?.getAttribute('data-node-id');
      if (!g || !svg.contains(g) || !id) continue;
      if (picked.some((p) => id === p || id.startsWith(`${p}.`))) continue;
      return g;
    }
    return null;
  }

  /**
   * A map's node dropped onto another node becomes its branch (FEAT-092): its
   * line and the lines nested under it move under that node's line in the
   * text. True — done so (the move by hand is dropped).
   */
  private dropIntoNode(now: DiagramOffsets, before: DiagramOffsets): boolean {
    const svg = this.svg;
    const at = this.lastPointer;
    const spec = this.spec();
    if (!svg || !at || !['radial', 'classic', 'horizontal'].includes(spec.layout)) return false;
    const moved = Object.keys(now.nodes).filter((id) => JSON.stringify(now.nodes[id]) !== JSON.stringify(before.nodes[id]));
    if (moved.length !== 1) return false;
    const dragged = moved[0]!;
    const nodeOf = (id: string) => svg.querySelector(`g.mm-node[data-node-id="${CSS.escape(id)}"]`);
    let target: Element | null = null;
    for (const el of document.elementsFromPoint(at.x, at.y)) {
      const g = el.closest('g.mm-node[data-node-id]');
      const id = g?.getAttribute('data-node-id');
      if (!g || !svg.contains(g) || !id || id === dragged || id.startsWith(`${dragged}.`)) continue;
      target = g;
      break;
    }
    if (!target) return false;
    const lineOf = (g: Element | null) => Number(g?.querySelector('[data-source-line]')?.getAttribute('data-source-line'));
    const from = lineOf(nodeOf(dragged));
    const to = lineOf(target);
    if (!(from > 0) || !(to > 0)) return false;
    const next = moveBranch(this.text(spec), from, to);
    if (next === null || next === this.text(spec)) return false;
    // Node ids are paths in the tree: after a move, hand-made offsets would land on other nodes.
    this.change(tr('Перенести ветку'), (s) => {
      const offsets = { ...s.offsets };
      delete offsets[s.layout];
      return { ...withDiagramText(s, next), offsets };
    });
    this.host.toast(tr('Ветка перенесена — текст переписан. Отменить: ⌘Z'));
    return true;
  }

  private resetOffsets(): void {
    this.change(tr('Вернуть блоки на места'), (s) => {
      const offsets = { ...s.offsets };
      delete offsets[s.layout];
      return { ...s, offsets };
    });
  }

  private hasOffsets(spec = this.spec()): boolean {
    return Object.keys(spec.offsets[spec.layout]?.nodes ?? {}).length > 0;
  }

  // ---------- moving and zooming the picture ----------

  private applyTransform(): void {
    const svg = this.svg;
    if (!svg) return;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    const w = this.svgW * this.zoom;
    const hgt = this.svgH * this.zoom;
    this.scalable.style.transform = `translate(${(cw - w) / 2 + this.panX}px, ${(ch - hgt) / 2 + this.panY}px)`;
    // The size, not a CSS scale: the picture stays sharp at any zoom.
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(hgt));
    svg.style.width = `${w}px`;
    svg.style.height = `${hgt}px`;
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
  }

  /** Fits the whole picture into the view. `byHand` — the user asked (the view is theirs again). */
  fit(byHand = true): void {
    if (!this.svg || !this.svgW || !this.svgH) return;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (!cw || !ch) return;
    this.zoom = Math.max(0.05, Math.min(2, Math.min((cw - 48) / this.svgW, (ch - 120) / this.svgH)));
    this.panX = 0;
    this.panY = -24;
    this.placed = byHand ? false : this.placed && false;
    this.applyTransform();
  }

  private zoomBy(k: number, at?: { x: number; y: number }): void {
    if (!this.svg) return;
    const rect = this.canvas.getBoundingClientRect();
    const px = at ? at.x - rect.left : rect.width / 2;
    const py = at ? at.y - rect.top : rect.height / 2;
    const before = this.zoom;
    const next = Math.max(0.05, Math.min(8, before * k));
    if (next === before) return;
    // The point under the pointer stays where it is.
    const cx = rect.width / 2 + this.panX;
    const cy = rect.height / 2 + this.panY;
    const f = next / before;
    this.panX = px - (px - cx) * f - rect.width / 2;
    this.panY = py - (py - cy) * f - rect.height / 2;
    this.zoom = next;
    this.placed = true;
    this.applyTransform();
  }

  private bindStage(): void {
    const canvas = this.canvas;
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) this.zoomBy(Math.exp(-e.deltaY * 0.01), { x: e.clientX, y: e.clientY });
        else {
          this.panX -= e.deltaX;
          this.panY -= e.deltaY;
          this.placed = true;
          this.applyTransform();
        }
      },
      { passive: false },
    );
    let drag: { x: number; y: number; px: number; py: number; moved: boolean; id: number } | null = null;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch: { d: number; zoom: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a!.x - b!.x, a!.y - b!.y), zoom: this.zoom };
        drag = null;
        return;
      }
      // In the "move blocks" mode the manual layout takes the left button on the picture.
      if (this.tool === 'move' && e.button === 0 && !this.spaceDown) return;
      if (e.button !== 0 && e.button !== 1) return;
      drag = { x: e.clientX, y: e.clientY, px: this.panX, py: this.panY, moved: false, id: e.pointerId };
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add('grabbing');
    });
    // Remembered for a drop of a map's node onto another one (the manual layout reports the drop without a point).
    window.addEventListener('pointermove', (e) => {
      if (this.tool !== 'move') return;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      // While a map's node is dragged, the node it would join is outlined.
      const dragging = (e.buttons & 1) === 1 && document.body.classList.contains('diagram-node-dragging');
      this.markDropTarget(dragging ? this.dropTargetAt(e.clientX, e.clientY) : null);
    }, true);
    window.addEventListener('pointerup', () => this.markDropTarget(null), true);
    canvas.addEventListener('pointermove', (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        this.zoomBy((pinch.zoom * (d / pinch.d)) / this.zoom, { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 });
        return;
      }
      if (!drag || drag.id !== e.pointerId) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      this.panX = drag.px + dx;
      this.panY = drag.py + dy;
      this.placed = true;
      this.applyTransform();
    });
    const end = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (!drag || drag.id !== e.pointerId) return;
      const clicked = !drag.moved;
      drag = null;
      canvas.classList.remove('grabbing');
      if (clicked && e.type === 'pointerup') this.clickAt(e);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    // Right click on a block: its piece of the text, selected (DocPlan's quickest way from picture to text).
    canvas.addEventListener(
      'contextmenu',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        const line = this.lineAt(e.target, e.clientX, e.clientY);
        if (line) this.jumpTo(line);
      },
      true,
    );
    canvas.addEventListener('dblclick', (e) => {
      if (e.target === canvas || e.target === this.scalable) this.fit();
    });
    // Space held: the hand for a moment, whatever the tool.
    window.addEventListener('keydown', (e) => {
      if (this.destroyed || !this.stage.isConnected) return;
      const typing = e.target instanceof HTMLElement && (e.target.closest('input, textarea, select, [contenteditable="true"]') !== null);
      if (typing) return;
      if (e.code === 'Space') {
        this.spaceDown = true;
        canvas.classList.add('space');
      } else if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === 'h' || e.key === 'р') this.setTool('hand');
        else if ((e.key === 'v' || e.key === 'м') && this.engine?.manual.supports(this.spec().layout)) this.setTool('move');
        else if (e.key === '!' || (e.shiftKey && e.code === 'Digit1')) this.fit();
        else if (e.key === '+' || e.key === '=') this.zoomBy(1.25);
        else if (e.key === '-') this.zoomBy(1 / 1.25);
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = false;
        canvas.classList.remove('space');
      }
    });
  }

  private spaceDown = false;

  /** A click on the picture: a link opens; with ⌘ (Ctrl) — the block's line is picked in the text. */
  private clickAt(e: PointerEvent): void {
    const target = e.target instanceof Element ? e.target : null;
    if (e.metaKey || e.ctrlKey) {
      const line = this.lineAt(target, e.clientX, e.clientY);
      if (line) this.jumpTo(line);
      return;
    }
    if (!target || !this.svg?.contains(target)) return;
    const link = target.closest('[data-pdf-href]');
    const href = link?.getAttribute('data-pdf-href')?.trim();
    if (href && /^(https?:|mailto:)/i.test(href)) window.open(href, '_blank', 'noopener,noreferrer');
  }

  private setTool(tool: 'hand' | 'move'): void {
    if (tool === 'move' && (this.readOnly || !this.engine?.manual.supports(this.spec().layout))) tool = 'hand';
    if (tool === this.tool) return;
    this.tool = tool;
    this.canvas.classList.toggle('moving', tool === 'move');
    this.syncDock();
    this.render(true);
  }

  private fullscreen(): void {
    const el = this.stage;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.().then(() => setTimeout(() => this.fit(), 100));
  }

  private dockButton(label: string, content: Node, run: () => void): HTMLButtonElement {
    const b = h('button', { class: 'tool-button', type: 'button', title: label, 'aria-label': label }, content);
    b.addEventListener('click', run);
    return b;
  }

  private syncDock(): void {
    const supports = !!this.engine?.manual.supports(this.spec().layout) && !this.readOnly;
    this.moveButton.hidden = !supports;
    if (!supports && this.tool === 'move') this.tool = 'hand';
    this.handButton.classList.toggle('active', this.tool === 'hand');
    this.moveButton.classList.toggle('active', this.tool === 'move');
    this.resetButton.hidden = !supports || !this.hasOffsets();
  }

  // ---------- the kind ----------

  private syncKind(): void {
    const kind = diagramKind(this.spec().layout);
    this.kindButton.replaceChildren(h('span', { class: 'dg-kind-icon' }, svgIcon(kind.icon)), h('span', { class: 'dg-kind-text' }, h('span', { class: 'dg-kind-caption' }, tr('Тип схемы')), h('span', { class: 'dg-kind-label' }, kind.label)), icon('chevronDown', 14));
    this.kindButton.disabled = this.readOnly;
  }

  /**
   * One file is one diagram. Until something is written the kind changes freely (the example
   * is only shown); a written text stays for a kind of its syntax family, for another kind
   * it is replaced by that kind's example once agreed — or the kind opens in a new file.
   */
  private async setKind(layout: string): Promise<void> {
    if (!this.engine) return;
    this.flushTyping();
    const spec = this.spec();
    const text = diagramText(spec);
    const keep = text === null || sameDiagramText(spec.layout, layout);
    if (!keep && text.trim() && text !== this.engine.example(spec.layout, spec.direction)) {
      const choice = await this.askReplace(spec.layout, layout);
      if (choice === 'new') window.open(`/?new=1&diagram=${encodeURIComponent(layout)}`, '_blank', 'noopener');
      if (choice !== 'replace') return;
    }
    this.change(tr('Тип схемы'), (s) => {
      const { fresh: _fresh, ...rest } = s;
      // Another syntax: the old text and its hand-made offsets go (⌘Z brings them back).
      return keep ? { ...withDiagramText(rest, text), layout } : { ...withDiagramText(rest, null), layout, offsets: {} };
    });
    this.placed = false;
  }

  /** A written text and a kind of another syntax: replace it, or open the kind in a new file. */
  private async askReplace(from: string, to: string): Promise<'replace' | 'new' | null> {
    const { openDialog } = await import('../ui/dialog.ts');
    let choice: 'replace' | 'new' | null = null;
    const elsewhere = h('button', { class: 'text-button dg-kind-elsewhere', type: 'button' }, tr('Открыть «{0}» в новом файле', diagramKind(to).label));
    elsewhere.addEventListener('click', () => {
      choice = 'new';
      (elsewhere.closest('form')?.querySelector('.dialog-header .icon-button') as HTMLElement | null)?.click();
    });
    const ok = await openDialog({
      title: tr('Сменить тип схемы?'),
      body: [h('p', { class: 'dialog-message' }, tr('Текст написан для типа «{0}», а у типа «{1}» другая запись. Текст заменится примером — вернуть прежний можно через ⌘Z или историю версий.', diagramKind(from).label, diagramKind(to).label)), elsewhere],
      confirm: tr('Заменить текст'),
      cancel: tr('Отмена'),
    });
    return ok ? 'replace' : choice;
  }

  /** The kinds in groups; `first` — a new diagram (the example of the chosen kind becomes its text). */
  openKinds(first = false): void {
    if (this.readOnly) return;
    const current = this.spec().layout;
    const close = () => overlay.remove();
    const grid = h(
      'div',
      { class: 'dg-kinds' },
      ...diagramKindGroups().map((g) =>
        h(
          'section',
          { class: 'dg-kind-group' },
          h('h3', {}, g.name),
          h(
            'div',
            { class: 'dg-kind-list' },
            ...g.kinds.map((k) => {
              // Each kind with a picture of its example (tools/diagram-kinds.html): what it looks like before choosing.
              const b = h(
                'button',
                { class: `dg-kind-option${k.id === current && !first ? ' current' : ''}`, type: 'button' },
                h('img', { class: 'dg-kind-shot', src: `/apps/web/diagram-kinds/${k.id}.webp`, alt: '', loading: 'lazy', width: '240', height: '150' }),
                h('span', { class: 'dg-kind-row' }, h('span', { class: 'dg-kind-icon' }, svgIcon(k.icon, 18)), h('span', { class: 'dg-kind-text' }, h('strong', {}, k.label), h('span', {}, k.hint))),
              );
              b.addEventListener('click', () => {
                close();
                void this.setKind(k.id);
              });
              return b;
            }),
          ),
        ),
      ),
    );
    const closeButton = h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть') }, icon('close'));
    closeButton.addEventListener('click', () => {
      close();
      // A new diagram closed without a choice: a map, as DocPlan starts.
      if (first) void this.setKind('radial');
    });
    const dialog = h(
      'div',
      { class: 'dialog dg-kinds-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('Тип схемы') },
      h('header', { class: 'dialog-header' }, h('h2', {}, first ? tr('Какую схему рисуем?') : tr('Тип схемы')), closeButton),
      h('p', { class: 'dg-kinds-lead' }, first ? tr('Схема строится по тексту. Выберите тип — появится пример, его можно сразу править.') : tr('В файле одна схема. Пока текст не тронут, тип меняется свободно; карты между собой и планы между собой рисуют один и тот же текст.')),
      grid,
    );
    const overlay = h('div', { class: 'dialog-overlay' }, dialog);
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) closeButton.click();
    });
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeButton.click();
      }
    });
    document.body.append(overlay);
    (dialog.querySelector('.dg-kind-option.current') as HTMLElement | null ?? dialog.querySelector('.dg-kind-option') as HTMLElement | null)?.focus();
  }

  async insertExample(): Promise<void> {
    const engine = this.engine;
    if (!engine || this.readOnly) return;
    const spec = this.spec();
    const example = engine.example(spec.layout, spec.direction);
    const now = this.text(spec);
    if (now === example) return;
    if (now.trim()) {
      const { askConfirm } = await import('../ui/dialog.ts');
      const ok = await askConfirm({ title: tr('Заменить текст примером?'), message: tr('Текст схемы заменится примером этого типа. Вернуть прежний — ⌘Z.'), confirm: tr('Заменить') });
      if (!ok) return;
    }
    this.change(tr('Пример схемы'), (s) => withDiagramText(s, example));
  }

  /** The kind shown (for the help: its article on writing it). */
  get layout(): string {
    return this.spec().layout;
  }

  // ---------- the look and export ----------

  private syncPanel(): void {
    const engine = this.engine;
    if (!engine) return;
    const spec = this.spec();
    const key = JSON.stringify([spec.layout, spec.theme, spec.look ?? null, spec.colors ?? null, spec.font, spec.direction, spec.spacing[spec.layout] ?? null, this.readOnly, this.hasOffsets(spec)]);
    if (key === this.panelFor) return;
    this.panelFor = key;
    const disabled = this.readOnly;
    const sections: HTMLElement[] = [];
    const section = (title: string, ...body: (Node | string | null)[]) => h('section', { class: 'panel-section' }, h('header', { class: 'section-header' }, h('h3', {}, title)), h('div', { class: 'section-body' }, ...body.filter((b): b is Node | string => b !== null)));

    // Palette: every palette with its first colours; some kinds have colours of their own.
    const look = engine.theme(spec.layout, spec.theme);
    const custom = !!spec.colors?.length && look.locked !== 'all';
    const palettes = h(
      'div',
      { class: 'dg-palettes', role: 'radiogroup', 'aria-label': tr('Палитра') },
      // The soft palette (the default) first.
      ...['soft', ...engine.themes.filter((t) => t !== 'soft')].map((name) => {
        const off = disabled || look.locked === 'all' || (name === 'mono' && look.locked === 'mono');
        const b = h(
          'button',
          { class: `dg-palette${look.theme === name && !custom ? ' active' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(look.theme === name && !custom), disabled: off },
          h('span', { class: 'dg-palette-dots', 'aria-hidden': 'true' }, ...(engine.palettes[name] ?? []).slice(0, 5).map((c) => h('span', { style: { background: c } }))),
          h('span', { class: 'dg-palette-name' }, tr(PALETTE_NAMES[name] ?? name)),
        );
        // A ready palette replaces colours of one's own.
        b.addEventListener('click', () =>
          this.change(tr('Палитра схемы'), (s) => {
            const next = { ...s, theme: name };
            delete next.colors;
            return next;
          }),
        );
        return b;
      }),
    );
    // The same picker as on the canvas: any font, found by typing its name.
    this.fontPicker?.dispose();
    this.fontPicker = new FontPicker(
      () => this.editor.doc,
      () => (disabled ? null : diagramFontFamily(this.spec())),
      (family) => this.change(tr('Шрифт схемы'), (s) => ({ ...s, font: family })),
      { label: (f) => (f === 'system-ui' ? tr('Как в интерфейсе') : null), first: [[tr('По умолчанию'), ['system-ui']]] },
    );
    const font = this.fontPicker.el;
    // Light or dark, for everyone who opens the file and in exports; «Авто» — as each one's interface.
    const lookSeg = h('div', { class: 'segmented with-text', role: 'radiogroup', 'aria-label': tr('Тема схемы') });
    for (const [value, label] of [
      [undefined, tr('Авто')],
      ['light', tr('Светлая')],
      ['dark', tr('Тёмная')],
    ] as const) {
      const on = (spec.look ?? undefined) === value;
      const b = h('button', { class: `segment${on ? ' active' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(on), disabled, title: value ? '' : tr('Как интерфейс у того, кто смотрит') }, label);
      b.addEventListener('click', () => {
        this.change(tr('Тема схемы'), (s) => {
          const next = { ...s };
          if (value) next.look = value;
          else delete next.look;
          return next;
        });
        // The whole interface follows (panels too, not only the canvas), and so does «Настройки → Тема».
        applyTheme(value ?? 'system', true);
        prefsChanged();
      });
      lookSeg.append(b);
    }
    sections.push(
      section(
        tr('Оформление'),
        h('div', { class: 'subsection-title' }, tr('Тема')),
        lookSeg,
        h('div', { class: 'subsection-title' }, tr('Палитра')),
        palettes,
        look.locked === 'all' ? h('p', { class: 'hint small' }, tr('У этого типа свои цвета: они показывают смысл.')) : look.locked === 'mono' ? h('p', { class: 'hint small' }, tr('«Без цвета» этому типу не подходит: цвета различают потоки.')) : null,
        look.locked === 'all' ? null : this.ownColors(spec, engine.palettes[look.theme] ?? [], disabled),
        h('div', { class: 'dg-own' }, h('div', { class: 'subsection-title' }, tr('Шрифт')), font),
      ),
    );

    // Spacing of the maps.
    if (engine.spacing.layouts.includes(spec.layout)) {
      const value = spec.spacing[spec.layout] ?? engine.spacing.defaults()[spec.layout] ?? 1;
      const min = engine.spacing.min(spec.layout);
      const presets = h('div', { class: 'segmented with-text', role: 'group', 'aria-label': tr('Плотность') });
      for (const [id, v] of Object.entries(engine.spacing.presets)) {
        const b = h('button', { class: `segment${Math.abs(v - value) < 0.01 ? ' active' : ''}`, type: 'button', disabled }, tr(SPACING_NAMES[id] ?? id));
        b.addEventListener('click', () => this.setSpacing(v));
        presets.append(b);
      }
      const slider = h('input', { class: 'dg-range', type: 'range', min: String(min), max: String(engine.spacing.max), step: '0.05', value: String(value), 'aria-label': tr('Расстояние между ветками'), disabled });
      const shown = h('span', { class: 'dg-range-value' }, `${Math.round(value * 100)}%`);
      slider.addEventListener('input', () => {
        shown.textContent = `${Math.round(Number(slider.value) * 100)}%`;
      });
      slider.addEventListener('change', () => this.setSpacing(Number(slider.value)));
      sections.push(section(tr('Плотность веток'), presets, h('div', { class: 'dg-range-line' }, slider, shown)));
    }

    // Direction of the hierarchy.
    if (spec.layout === 'horizontal') {
      const seg = h('div', { class: 'segmented with-text', role: 'radiogroup', 'aria-label': tr('Направление') });
      for (const [dir, label] of [
        ['lr', tr('Слева направо')],
        ['tb', tr('Сверху вниз')],
      ] as const) {
        const b = h('button', { class: `segment${spec.direction === dir ? ' active' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(spec.direction === dir), disabled }, label);
        b.addEventListener('click', () => this.change(tr('Направление схемы'), (s) => ({ ...s, direction: dir })));
        seg.append(b);
      }
      sections.push(section(tr('Направление'), seg, h('p', { class: 'hint small' }, tr('Строка «направление: вертикаль» в тексте тоже переключает.'))));
    }

    // Moving blocks by hand.
    if (engine.manual.supports(spec.layout) && !disabled) {
      const move = h('button', { class: 'text-button', type: 'button' }, icon('select', 14), h('span', {}, this.tool === 'move' ? tr('Готово') : tr('Двигать блоки')));
      move.addEventListener('click', () => {
        this.setTool(this.tool === 'move' ? 'hand' : 'move');
        this.panelFor = '';
        this.syncPanel();
      });
      const reset = this.hasOffsets(spec) ? h('button', { class: 'text-button', type: 'button' }, tr('Вернуть на места')) : null;
      reset?.addEventListener('click', () => this.resetOffsets());
      sections.push(section(tr('Расположение блоков'), h('div', { class: 'dg-row' }, move, reset), h('p', { class: 'hint small' }, tr('Блоки встают сами по тексту; сдвинутые вручную остаются на своих местах при правке.'))));
    }

    // Lighting the caret's block.
    const check = h('input', { type: 'checkbox', checked: this.caretHighlight });
    check.addEventListener('change', () => {
      this.caretHighlight = check.checked;
      try {
        localStorage.setItem(CARET_KEY, check.checked ? 'on' : 'off');
      } catch {
        // for this visit
      }
      this.lightCaretLine();
    });
    sections.push(section(tr('Подсветка'), h('label', { class: 'checkbox' }, check, h('span', {}, tr('Блок строки, где курсор')))));

    // Export.
    const exp = (label: string, run: () => Promise<void> | void) => {
      const b = h('button', { class: 'text-button dg-export', type: 'button' }, label);
      b.addEventListener('click', () => void Promise.resolve(run()).catch(() => this.host.toast(tr('Не удалось сохранить файл'), 'error')));
      return b;
    };
    sections.push(
      section(
        tr('Экспорт'),
        h(
          'div',
          { class: 'dg-exports' },
          exp('PNG', () => this.exportAs('png')),
          exp(tr('PNG без фона'), () => this.exportAs('png-clear')),
          exp('SVG', () => this.exportAs('svg')),
          exp(tr('PDF, A4'), () => this.exportAs('pdf')),
          exp(tr('Текст (.txt)'), () => this.exportAs('txt')),
        ),
        exp(tr('Копировать для макета'), () => this.copyForDesign()),
        h('p', { class: 'hint small' }, tr('Вставьте в макет (⌘V) — схема станет слоями, которые можно править.')),
      ),
    );
    this.panelBody.replaceChildren(...sections);
  }

  /**
   * «Свои цвета»: the palette's first eight as swatches — any can be changed
   * (a branch made red); «Из одного цвета» builds all eight from a brand's
   * colour; «Сбросить» — back to the ready palette.
   */
  private ownColors(spec: DiagramSpec, palette: readonly string[], disabled: boolean): HTMLElement {
    const now = spec.colors?.length ? spec.colors : palette.slice(0, 8).map((c) => normalizeHex(c));
    // Our own picker (the system one does not open from a hidden input); the
    // diagram follows the drag, written once the hand rests.
    const pickColor = (anchor: HTMLElement, value: string, done: (hex: string) => void) => {
      let timer = 0;
      openColorPicker({
        anchor,
        color: hexToColor(normalizeHex(value)) ?? { r: 0.3, g: 0.36, b: 0.84, a: 1 },
        opacity: 1,
        noOpacity: true,
        onChange: (color) => {
          clearTimeout(timer);
          timer = window.setTimeout(() => done(colorToHex(color).slice(0, 7).toUpperCase()), 120);
        },
      });
    };
    const swatches = h(
      'div',
      { class: 'dg-own-colors', role: 'group', 'aria-label': tr('Свои цвета') },
      ...now.map((hex, i) => {
        const b = h('button', { class: 'dg-own-color', type: 'button', title: tr('Цвет {0}: сменить', i + 1), 'aria-label': tr('Цвет {0}: сменить', i + 1), disabled, style: { background: hex } });
        b.addEventListener('click', () =>
          pickColor(b, hex, (next) =>
            this.change(tr('Свой цвет схемы'), (s) => {
              const colors = [...now];
              colors[i] = next;
              return { ...s, colors };
            }),
          ),
        );
        return b;
      }),
    );
    const fromOne = h('button', { class: 'text-button', type: 'button', disabled, title: tr('Выберите один цвет (например, фирменный) — из него получатся все восемь, в тон') }, tr('Из одного цвета…'));
    fromOne.addEventListener('click', () => pickColor(fromOne, now[0] ?? '#4F5BD5', (hex) => this.change(tr('Палитра из цвета'), (s) => ({ ...s, colors: paletteFrom(hex) }))));
    const reset = spec.colors?.length ? h('button', { class: 'link-button', type: 'button', disabled }, tr('Сбросить')) : null;
    reset?.addEventListener('click', () =>
      this.change(tr('Сбросить свои цвета'), (s) => {
        const next = { ...s };
        delete next.colors;
        return next;
      }),
    );
    return h('div', { class: 'dg-own' }, h('div', { class: 'subsection-title' }, tr('Свои цвета'), reset ?? ''), swatches, fromOne);
  }

  private setSpacing(v: number): void {
    const engine = this.engine;
    if (!engine) return;
    const value = Math.round(engine.spacing.clamp(v) * 100) / 100;
    this.change(tr('Плотность схемы'), (s) => ({ ...s, spacing: { ...s.spacing, [s.layout]: value } }));
  }

  /** The background of exported pictures: the canvas's, light or dark. */
  private background(): string {
    return diagramBackground(diagramDark(this.spec(), isDark()));
  }

  async exportAs(kind: 'png' | 'png-clear' | 'svg' | 'pdf' | 'txt'): Promise<void> {
    const name = this.host.fileName();
    if (kind === 'txt') {
      download(new Blob([this.text()], { type: 'text/plain;charset=utf-8' }), fileNameOf(name, 'txt'));
      return;
    }
    const p = this.prepared(kind === 'png-clear');
    if (!p) return;
    if (kind === 'svg') download(new Blob([svgFile(p)], { type: 'image/svg+xml' }), fileNameOf(name, 'svg'));
    else if (kind === 'pdf') download(await pdfBlob(p, this.background(), name), fileNameOf(name, 'pdf'));
    else download(await pngBlob(p), fileNameOf(name, 'png'));
  }

  /** The picture prepared for a file, or null (none yet: said so). */
  private prepared(transparent: boolean, quiet = false): PreparedSvg | null {
    if (!this.svg || !this.engine) {
      if (!quiet) this.host.toast(tr('Схема ещё не построена: поправьте текст слева'), 'error');
      return null;
    }
    return prepareSvg(this.engine, this.svg, this.background(), transparent, fontFaceCss(this.editor.doc, diagramFontFamily(this.spec())));
  }

  async copyForDesign(): Promise<void> {
    const p = this.prepared(true);
    if (!p) return;
    await navigator.clipboard.writeText(svgFile(p));
    this.host.toast(tr('Схема скопирована. Откройте макет и вставьте её (⌘V) — она станет слоями.'));
  }

  /** A picture of the diagram for the file's card on the home screen. */
  async thumbnail(): Promise<string | null> {
    const p = this.prepared(false, true);
    return p ? thumbnailDataUrl(p, this.background()) : null;
  }

  destroy(): void {
    this.destroyed = true;
    this.offFonts();
    this.fontPicker?.dispose();
    this.flushTyping();
    delete document.body.dataset.diagramLayout;
  }
}

/** #RGB / #RRGGBB / rgb() → #RRGGBB (the colour input takes only that). */
function normalizeHex(c: string): string {
  const s = c.trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) return `#${[...s.slice(1)].map((x) => x + x).join('')}`.toUpperCase();
  const m = /rgba?\((\d+)\D+(\d+)\D+(\d+)/.exec(s);
  if (m) return `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
  return '#888888';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}
