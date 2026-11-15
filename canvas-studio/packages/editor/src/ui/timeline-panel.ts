// The timeline under the canvas (Motion, stage 2b, Figma Motion's timeline): play and the playhead, the frame's
// duration and looping; the layers with keyframes (and the selected one) with their properties — the value at
// the playhead (typing a value puts a keyframe there), ◆ to put or take a keyframe at the playhead — and their
// keyframes on a time ruler: a click on the ruler moves the playhead, a keyframe is dragged in time, Delete takes
// the selected one away, its curve is chosen above. While it plays only the playhead and the values move.

import { MOTION_PROPS, tr, type Document, type MotionProp, type NodeId } from '#core';
import { allVariables } from '#components';
import type { Editor } from '../editor.ts';
import type { Canvas2DRenderer } from '#render';
import { download, h, icon } from './dom.ts';
import { animatedLayers, motionFrameOf, shownValue } from '../motion/model.ts';

const PROP_LABELS: Record<MotionProp, string> = { x: 'X', y: 'Y', rotation: tr('Поворот'), scale: tr('Масштаб'), opacity: tr('Прозрачность') };

/** Shown as people think of it: rotation in degrees, scale and opacity in percent. */
const toShown = (prop: MotionProp, v: number) => (prop === 'scale' || prop === 'opacity' ? Math.round(v * 1000) / 10 : Math.round(v * 100) / 100);
const fromShown = (prop: MotionProp, v: number) => (prop === 'scale' || prop === 'opacity' ? v / 100 : v);
const UNIT: Record<MotionProp, string> = { x: '', y: '', rotation: '°', scale: '%', opacity: '%' };

const EASES: [string, string][] = [
  ['linear', tr('Линейная')],
  ['ease-in', tr('Плавный старт')],
  ['ease-out', tr('Плавное завершение')],
  ['ease-in-out', tr('Плавно в начале и в конце')],
  ['ease-in-back', tr('С откатом в начале')],
  ['ease-out-back', tr('С перелётом в конце')],
  ['ease-in-out-back', tr('С откатом и перелётом')],
];

/** Variables of a type, in collection order. */
const allVariablesOf = (doc: Document, type: 'EASING') => allVariables(doc).filter((v) => doc.get(v, 'varType') === type);

const seconds = (ms: number) => tr('{0} с', (ms / 1000).toFixed(2).replace('.', ','));

export class TimelinePanel {
  readonly el: HTMLElement;
  private readonly editor: Editor;
  private readonly area: HTMLElement;
  /** The keyframe chosen on the ruler: its curve is offered above; Delete takes it away. */
  private chosen: { id: NodeId; prop: MotionProp; t: number } | null = null;
  private signature = '';
  private playhead: HTMLElement | null = null;
  private timeText: HTMLElement | null = null;
  private playButton: HTMLButtonElement | null = null;
  private values: { input: HTMLInputElement; id: NodeId; prop: MotionProp; mark: HTMLButtonElement }[] = [];

  private readonly renderer: () => Canvas2DRenderer;

  constructor(editor: Editor, area: HTMLElement, renderer: () => Canvas2DRenderer) {
    this.editor = editor;
    this.area = area;
    this.renderer = renderer;
    this.el = h('section', { class: 'timeline-panel', 'aria-label': tr('Таймлайн'), tabindex: '-1', hidden: true });
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    editor.events.on('motion', () => this.update());
    editor.events.on('change', () => this.update(true));
    editor.events.on('selection', () => this.update(true));
  }

  private get frame(): NodeId | null {
    return this.editor.timeline.frame;
  }

  /** Rebuilds when what is listed changed; else moves the playhead and the values only. */
  private update(force = false): void {
    const frame = this.frame;
    this.el.hidden = !frame;
    this.area.classList.toggle('has-timeline', !!frame);
    if (!frame) {
      this.signature = '';
      return;
    }
    const sig = this.structureSignature(frame);
    if (force || sig !== this.signature) {
      this.signature = sig;
      this.render(frame);
    } else this.tick();
  }

  private rows(frame: NodeId): NodeId[] {
    const d = this.editor.doc;
    const list = animatedLayers(d, frame);
    for (const id of this.editor.selection) if (d.store.isAlive(id) && motionFrameOf(d, id) === frame && !list.includes(id)) list.push(id);
    return list;
  }

  private structureSignature(frame: NodeId): string {
    const d = this.editor.doc;
    return [frame, JSON.stringify(d.get(frame, 'motion')), this.editor.selection.join(','), this.editor.timeline.playing, this.editor.timeline.autokey, JSON.stringify(this.chosen), ...this.rows(frame).map((id) => `${id}${d.get(id, 'name')}${JSON.stringify(d.get(id, 'keyframes'))}`)].join('|');
  }

  private render(frame: NodeId): void {
    const d = this.editor.doc;
    const tl = this.editor.timeline;
    const duration = tl.duration;
    const motion = d.get(frame, 'motion')!;
    this.values = [];
    // Header.
    this.playButton = h('button', { class: 'icon-button tl-play', type: 'button', title: tl.playing ? tr('Пауза') : tr('Играть'), 'aria-label': tl.playing ? tr('Пауза') : tr('Играть'), onclick: () => tl.toggle() }, icon(tl.playing ? 'pause' : 'play', 14));
    this.timeText = h('span', { class: 'tl-time' });
    const durationInput = h('input', { class: 'proto-input tl-duration', type: 'number', min: 0.1, max: 60, step: 0.1, value: String(duration / 1000), 'aria-label': tr('Длительность, с'), title: tr('Длительность, с') });
    durationInput.addEventListener('keydown', (e) => e.stopPropagation());
    durationInput.addEventListener('change', () => tl.setSettings({ duration: Number(durationInput.value.replace(',', '.')) * 1000 || duration }));
    const loop = h('input', { type: 'checkbox', checked: motion.loop, 'aria-label': tr('Повтор') });
    loop.addEventListener('change', () => tl.setSettings({ loop: loop.checked }));
    const head = h(
      'div',
      { class: 'tl-head' },
      this.playButton,
      this.timeText,
      h('label', { class: 'tl-field' }, h('span', {}, tr('Длительность, с')), durationInput),
      h('label', { class: 'tl-field' }, loop, h('span', {}, tr('Повтор'))),
      (() => {
        const auto = h('input', { type: 'checkbox', checked: tl.autokey, 'aria-label': tr('Автозапись') });
        auto.addEventListener('change', () => tl.setAutokey(auto.checked));
        return h('label', { class: 'tl-field', title: tr('Когда вы двигаете, поворачиваете или меняете прозрачность слоя, в месте бегунка ставится ключевой кадр') }, auto, h('span', { class: tl.autokey ? 'tl-rec' : '' }, tr('Автозапись')));
      })(),
      h('span', { class: 'tl-spacer' }),
      ...this.easeControl(),
      h('button', { class: 'text-button', type: 'button', title: tr('Появление, сдвиг, масштаб и свои стили — на выделенные слои в месте бегунка'), onclick: () => void import('./animation-styles.ts').then(({ openAnimationStyles }) => openAnimationStyles(this.editor)) }, icon('styles', 14), h('span', {}, tr('Стили'))),
      this.exportControl(frame),
      h('button', { class: 'text-button', type: 'button', title: tr('Убрать таймлайн и все ключевые кадры фрейма'), onclick: () => tl.removeTimeline() }, tr('Убрать таймлайн')),
      h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть таймлайн'), 'aria-label': tr('Закрыть таймлайн'), onclick: () => tl.close() }, icon('close', 14)),
    );
    // Ruler and rows.
    const ruler = h('div', { class: 'tl-ruler' });
    const step = duration <= 2000 ? 250 : duration <= 6000 ? 500 : 1000;
    for (let t = 0; t <= duration + 1; t += step) {
      ruler.append(h('span', { class: `tl-tick${t % 1000 === 0 ? ' major' : ''}${t + step > duration + 1 ? ' last' : ''}`, style: `left:${(t / duration) * 100}%` }, t % 1000 === 0 || step >= 500 ? seconds(t) : ''));
    }
    this.seekOn(ruler);
    const names = h('div', { class: 'tl-names' }, h('div', { class: 'tl-corner' }, d.get(frame, 'name')));
    const tracks = h('div', { class: 'tl-tracks' }, ruler);
    const rows = this.rows(frame);
    if (rows.length === 0) names.append(h('p', { class: 'hint small tl-empty' }, tr('Выделите слой во фрейме и нажмите ◆ у свойства, чтобы поставить первый ключевой кадр')));
    for (const id of rows) {
      const keys = d.get(id, 'keyframes') ?? {};
      const selected = this.editor.selection.includes(id);
      names.append(h('div', { class: `tl-layer${selected ? ' selected' : ''}`, onclick: () => this.editor.setSelection([id]) }, d.get(id, 'name')));
      tracks.append(h('div', { class: 'tl-layer-track' }));
      for (const prop of MOTION_PROPS) {
        if (!selected && !keys[prop]?.length) continue;
        const input = h('input', { class: 'proto-input tl-value', type: 'number', step: prop === 'scale' || prop === 'opacity' ? 1 : 1, 'aria-label': `${d.get(id, 'name')}: ${PROP_LABELS[prop]}` });
        input.addEventListener('keydown', (e) => e.stopPropagation());
        input.addEventListener('change', () => {
          const v = Number(input.value.replace(',', '.'));
          if (Number.isFinite(v)) tl.addKeyframe(id, prop, fromShown(prop, v));
        });
        const mark = h('button', { class: 'tl-mark', type: 'button', title: tr('Ключевой кадр здесь: поставить или убрать'), 'aria-label': tr('Ключевой кадр здесь: поставить или убрать') }, '◆');
        mark.addEventListener('click', () => {
          const at = (d.get(id, 'keyframes')?.[prop] ?? []).find((k) => Math.abs(k.t - tl.time) < 1);
          if (at) tl.removeKeyframe(id, prop, at.t);
          else tl.addKeyframe(id, prop);
        });
        this.values.push({ input, id, prop, mark });
        names.append(h('div', { class: 'tl-prop' }, h('span', { class: 'tl-prop-name' }, PROP_LABELS[prop]), input, h('span', { class: 'tl-unit' }, UNIT[prop]), mark));
        const track = h('div', { class: 'tl-track' });
        this.seekOn(track);
        for (const k of keys[prop] ?? []) track.append(this.diamond(id, prop, k.t, duration));
        tracks.append(track);
      }
    }
    this.playhead = h('div', { class: 'tl-playhead' });
    tracks.append(this.playhead);
    this.el.replaceChildren(head, h('div', { class: 'tl-body' }, names, tracks));
    this.tick();
  }

  /** «Экспорт…»: the animation as a video or a GIF made here, its code as CSS or JSON to the clipboard (stage 5). */
  private exportControl(frame: NodeId): HTMLElement {
    const sel = h('select', { class: 'field-select proto-select', 'aria-label': tr('Экспорт анимации'), title: tr('Экспорт анимации') });
    for (const [v, label] of [['', tr('Экспорт…')], ['video', tr('Видео')], ['gif', 'GIF'], ['lottie', 'Lottie'], ['css', tr('Код CSS')], ['json', tr('Код JSON')]] as const) sel.append(h('option', { value: v }, label));
    sel.addEventListener('keydown', (e) => e.stopPropagation());
    sel.addEventListener('change', () => {
      const what = sel.value;
      sel.value = '';
      void this.exportAs(frame, what);
    });
    return sel;
  }

  private async exportAs(frame: NodeId, what: string): Promise<void> {
    const editor = this.editor;
    const name = editor.doc.get(frame, 'name').replace(/[\\/:*?"<>|]+/g, '_') || 'animation';
    try {
      if (what === 'css' || what === 'json') {
        const { motionCss, motionJson } = await import('../motion/code.ts');
        await navigator.clipboard.writeText(what === 'css' ? motionCss(editor.doc, frame) : motionJson(editor.doc, frame));
        editor.toast(what === 'css' ? tr('Код анимации (CSS) скопирован') : tr('Код анимации (JSON) скопирован'));
        return;
      }
      const ex = await import('../motion/export.ts');
      editor.timeline.pause();
      if (what === 'gif') {
        editor.toast(tr('Собираю GIF…'));
        download(await ex.exportGif(editor, this.renderer(), frame), `${name}.gif`);
        editor.toast(tr('GIF сохранён'));
      } else if (what === 'lottie') {
        download(await ex.exportLottie(editor, this.renderer(), frame), `${name}.json`);
        editor.toast(tr('Lottie сохранён'));
      } else if (what === 'video') {
        editor.toast(tr('Записываю видео — {0} с…', (editor.timeline.duration / 1000).toFixed(1).replace('.', ',')));
        const { blob, ext } = await ex.exportVideo(editor, this.renderer(), frame);
        download(blob, `${name}.${ext}`);
        editor.toast(tr('Видео сохранено ({0})', ext.toUpperCase()));
      }
    } catch (error) {
      editor.toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  /** The curve of the chosen keyframe: a preset, or an EASING variable. */
  private easeControl(): HTMLElement[] {
    const c = this.chosen;
    const d = this.editor.doc;
    const k = c ? (d.get(c.id, 'keyframes')?.[c.prop] ?? []).find((x) => Math.abs(x.t - c.t) < 1) : undefined;
    if (!c || !k) return [];
    const variables = allVariablesOf(d, 'EASING');
    const sel = h('select', { class: 'field-select proto-select', 'aria-label': tr('Кривая до следующего кадра'), title: tr('Кривая до следующего кадра') });
    for (const [v, label] of EASES) sel.append(h('option', { value: v }, label));
    for (const v of variables) sel.append(h('option', { value: `var:${v}` }, tr('Переменная: {0}', d.get(v, 'name'))));
    const current = k.easeVar && d.store.isAlive(k.easeVar) ? `var:${k.easeVar}` : (k.ease ?? 'ease-in-out');
    // A curve of its own (cubic-bezier, spring, from a file) stays offered as it is.
    if (![...sel.options].some((o) => o.value === current)) sel.append(h('option', { value: current }, current));
    sel.value = current;
    sel.addEventListener('keydown', (e) => e.stopPropagation());
    sel.addEventListener('change', () => this.editor.timeline.setEase(c.id, c.prop, c.t, sel.value.startsWith('var:') ? { variable: sel.value.slice(4) } : { text: sel.value }));
    return [h('label', { class: 'tl-field' }, h('span', {}, tr('Кривая')), sel)];
  }

  private diamond(id: NodeId, prop: MotionProp, t: number, duration: number): HTMLElement {
    const c = this.chosen;
    const chosen = !!c && c.id === id && c.prop === prop && Math.abs(c.t - t) < 1;
    const el = h('button', { class: `tl-key${chosen ? ' chosen' : ''}`, type: 'button', style: `left:${(t / duration) * 100}%`, title: seconds(t), 'aria-label': tr('Ключевой кадр {0}', seconds(t)) }, '◆');
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const track = el.parentElement!;
      const box = track.getBoundingClientRect();
      let to = t;
      el.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        to = Math.round(Math.max(0, Math.min(1, (ev.clientX - box.left) / box.width)) * duration / 10) * 10;
        el.style.left = `${(to / duration) * 100}%`;
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        this.chosen = { id, prop, t: to };
        if (Math.abs(to - t) >= 1) this.editor.timeline.moveKeyframe(id, prop, t, to);
        this.editor.timeline.seek(to);
        this.el.focus({ preventScroll: true });
        this.update(true);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
    return el;
  }

  /** A press (and drag) on the ruler or a track moves the playhead. */
  private seekOn(el: HTMLElement): void {
    el.addEventListener('pointerdown', (e) => {
      const box = el.getBoundingClientRect();
      const at = (x: number) => Math.max(0, Math.min(1, (x - box.left) / box.width)) * this.editor.timeline.duration;
      this.editor.timeline.pause();
      this.editor.timeline.seek(at(e.clientX));
      el.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => this.editor.timeline.seek(at(ev.clientX));
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
  }

  /** The playhead, the time and the values at it. */
  private tick(): void {
    const tl = this.editor.timeline;
    const d = this.editor.doc;
    if (this.playhead) this.playhead.style.left = `calc(${(tl.time / tl.duration) * 100}%)`;
    if (this.timeText) this.timeText.textContent = `${seconds(tl.time)} / ${seconds(tl.duration)}`;
    for (const v of this.values) {
      if (!d.store.isAlive(v.id)) continue;
      if (document.activeElement !== v.input) v.input.value = String(toShown(v.prop, shownValue(d, v.id, v.prop, tl.time)));
      const here = (d.get(v.id, 'keyframes')?.[v.prop] ?? []).some((k) => Math.abs(k.t - tl.time) < 1);
      v.mark.classList.toggle('on', here);
    }
  }

  private onKey(e: KeyboardEvent): void {
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.chosen) {
      e.preventDefault();
      e.stopPropagation();
      const c = this.chosen;
      this.chosen = null;
      this.editor.timeline.removeKeyframe(c.id, c.prop, c.t);
    } else if (e.key === ' ' && (e.target as HTMLElement).tagName !== 'INPUT') {
      e.preventDefault();
      e.stopPropagation();
      this.editor.timeline.toggle();
    }
  }
}
