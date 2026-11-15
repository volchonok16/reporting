// «Песочница компонента» (step 7): the window. On the left the component's
// variant axes and properties; on the right the instance as it is now and its
// code (CSS, SwiftUI, Compose) — both follow every change at once. Nothing in
// the file changes: the window works on a copy (playground.ts).

import { tr, type NodeId } from '#core';
import type { Canvas2DRenderer } from '#render';
import type { CodeLang } from '../dev-code.ts';
import type { Editor } from '../editor.ts';
import { connectedCode } from '../code-connect.ts';
import { axisControls, openPlayground, playgroundCode, propControls, setAxis, setProp, type Playground } from '../playground.ts';
import { drawLayer } from './compare-dialog.ts';
import { h, icon } from './dom.ts';
import { fadeAway } from './motion-ui.ts';

export function openPlaygroundDialog(editor: Editor, renderer: Canvas2DRenderer, id: NodeId): void {
  const pg = openPlayground(editor, id);
  if (!pg) return void editor.toast(tr('Песочница открывается для компонента, набора вариантов или копии компонента'));
  new PlaygroundDialog(editor, renderer, pg);
}

class PlaygroundDialog {
  private readonly overlay: HTMLElement;
  private readonly controls: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly code: HTMLElement;
  /** «connect» — the component's code from the repository (Code Connect), when it has one. */
  private lang: CodeLang | 'connect' = 'css';
  private readonly previousOnLoad: (hash: string) => void;
  private readonly editor: Editor;
  private readonly renderer: Canvas2DRenderer;
  private readonly pg: Playground;
  /** The starting values, to bring the instance back to. */
  private readonly start: { axes: Record<string, string>; props: Record<string, string | boolean> };

  constructor(editor: Editor, renderer: Canvas2DRenderer, pg: Playground) {
    this.editor = editor;
    this.renderer = renderer;
    this.pg = pg;
    this.start = this.snapshot();
    this.controls = h('div', { class: 'pg-controls' });
    this.canvas = h('canvas', { class: 'versions-canvas pg-canvas' });
    this.code = h('pre', { class: 'code-block pg-code', tabIndex: 0 });
    const lang = h('select', { class: 'field-select', 'aria-label': tr('Язык кода') }, h('option', { value: 'css' }, 'HTML + CSS'), h('option', { value: 'swiftui' }, 'SwiftUI'), h('option', { value: 'compose' }, 'Jetpack Compose'));
    if (connectedCode(pg.editor.doc, pg.instance)) {
      lang.prepend(h('option', { value: 'connect' }, tr('Код из репозитория')));
      lang.value = 'connect';
      this.lang = 'connect';
    }
    lang.addEventListener('change', () => {
      this.lang = lang.value as CodeLang | 'connect';
      this.renderCode();
    });
    const copy = h('button', { class: 'icon-button', type: 'button', title: tr('Скопировать код'), 'aria-label': tr('Скопировать код'), onclick: () => void this.copy() }, icon('copy', 14));
    const close = h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть'), onclick: () => this.close() }, icon('close'));
    const reset = h('button', { class: 'text-button', type: 'button', onclick: () => this.reset() }, tr('Сбросить'));
    this.overlay = h(
      'div',
      { class: 'dialog-overlay' },
      h(
        'div',
        { class: 'dialog pg-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('Песочница компонента') },
        h('header', { class: 'dialog-header' }, h('h2', {}, tr('Песочница: «{0}»', pg.title)), close),
        h(
          'div',
          { class: 'pg-body' },
          h('div', { class: 'pg-side' }, this.controls, h('p', { class: 'hint pg-note' }, tr('Меняется только картинка и код здесь — файл остаётся как есть.')), reset),
          h('div', { class: 'pg-main' }, this.canvas, h('div', { class: 'code-controls pg-code-bar' }, h('div', { class: 'select-wrap' }, lang), copy), this.code),
        ),
      ),
    );
    this.overlay.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
    });
    this.overlay.addEventListener('pointerdown', (e) => {
      if (e.target === this.overlay) this.close();
    });
    document.body.append(this.overlay);
    this.previousOnLoad = renderer.images.onLoad;
    renderer.images.onLoad = (hash) => {
      this.previousOnLoad(hash);
      this.draw();
    };
    this.pg.editor.events.on('change', () => this.update());
    this.renderControls();
    this.renderCode();
    requestAnimationFrame(() => this.draw());
    close.focus();
  }

  private snapshot(): { axes: Record<string, string>; props: Record<string, string | boolean> } {
    const axes: Record<string, string> = {};
    for (const a of axisControls(this.pg)) axes[a.name] = a.value;
    const props: Record<string, string | boolean> = {};
    for (const p of propControls(this.pg)) if (p.value !== null) props[p.def.id] = p.value;
    return { axes, props };
  }

  private reset(): void {
    for (const [axis, value] of Object.entries(this.start.axes)) setAxis(this.pg, axis, value);
    for (const [id, value] of Object.entries(this.start.props)) setProp(this.pg, id, value);
  }

  private update(): void {
    if (!this.overlay.isConnected) return;
    this.renderControls();
    this.renderCode();
    this.draw();
  }

  private renderControls(): void {
    const rows: HTMLElement[] = [];
    for (const a of axisControls(this.pg)) {
      const select = h('select', { class: 'field-select', 'aria-label': a.name }, ...a.values.map((v) => h('option', { value: v }, v)));
      select.value = a.value;
      select.addEventListener('change', () => setAxis(this.pg, a.name, select.value));
      rows.push(h('label', { class: 'pg-row' }, h('span', { class: 'pg-label' }, a.name), h('div', { class: 'select-wrap' }, select)));
    }
    for (const p of propControls(this.pg)) {
      const name = p.def.name;
      if (p.def.type === 'BOOLEAN') {
        const box = h('input', { type: 'checkbox', checked: p.value === true, 'aria-label': name });
        box.addEventListener('change', () => setProp(this.pg, p.def.id, box.checked));
        rows.push(h('label', { class: 'pg-row checkbox' }, box, h('span', {}, name)));
      } else if (p.def.type === 'TEXT') {
        const input = h('input', { class: 'dialog-input', type: 'text', value: typeof p.value === 'string' ? p.value : '', 'aria-label': name, maxLength: 5000 });
        input.addEventListener('input', () => setProp(this.pg, p.def.id, input.value));
        rows.push(h('label', { class: 'pg-row' }, h('span', { class: 'pg-label' }, name), input));
      } else {
        const select = h('select', { class: 'field-select', 'aria-label': name }, ...p.options.map((o) => h('option', { value: o.id }, o.name)));
        if (typeof p.value === 'string') select.value = p.value;
        select.addEventListener('change', () => setProp(this.pg, p.def.id, select.value));
        rows.push(h('label', { class: 'pg-row' }, h('span', { class: 'pg-label' }, name), h('div', { class: 'select-wrap' }, select)));
      }
    }
    if (!rows.length) rows.push(h('p', { class: 'hint' }, tr('У этого компонента нет вариантов и свойств — здесь только его код.')));
    // A field being typed in keeps its focus and caret: replace only when nothing here is focused.
    const focused = document.activeElement;
    if (focused && this.controls.contains(focused) && focused instanceof HTMLInputElement && focused.type === 'text') return;
    this.controls.replaceChildren(...rows);
  }

  private renderCode(): void {
    const connected = this.lang === 'connect' ? connectedCode(this.pg.editor.doc, this.pg.instance)?.code : null;
    this.code.textContent = connected ?? (playgroundCode(this.pg, this.lang === 'connect' ? 'css' : this.lang) || tr('/* Нет свойств для кода */'));
  }

  private draw(): void {
    if (!this.canvas.isConnected) return;
    drawLayer(this.canvas, this.pg.editor.doc, this.pg.instance, this.renderer, [], tr('Слоя нет'));
  }

  private async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.code.textContent ?? '');
      this.editor.toast(tr('Код скопирован'));
    } catch {
      this.editor.toast(tr('Не удалось скопировать: браузер не дал доступ к буферу обмена'), 'error');
    }
  }

  private close(): void {
    this.renderer.images.onLoad = this.previousOnLoad;
    fadeAway(this.overlay);
    this.overlay.remove();
  }
}
