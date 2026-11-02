// Prototype viewer (FR-PRT-050, 051): shows one screen at a time, overlays on
// top of it, and plays the interactions. It works on its own copy of the
// document, so whatever happens while playing — scrolling, variant changes,
// smart animate — never touches the file being edited; "Restart" simply takes
// a fresh copy. The same viewer runs over the editor and in a separate tab.

import { linkAt, openLink } from '../text-links.ts';
import { locale, tr } from '#core';
import { processTransaction } from '#components';
import { deserialize, serialize, type Color, type Document, type NodeId, type Reaction, type Transition } from '#core';
import { apply, invert, type Point } from '#geometry';
import type { TextMeasurer } from '#layout';
import { Canvas2DRenderer, cssColor, SceneGraph } from '#render';
import { h, icon } from '../ui/dom.ts';
import { easingFunction } from './easing.ts';
import { flows, interactiveLayers, isScreen, PrototypeSession, reachable, screens, type Effect, type OpenOverlay } from './model.ts';
import { ScrollState } from './scroll.ts';
import { allVariables } from '#components';
import type { PrototypeDevice } from '#core';
import { deviceInsets, drawDevice, drawDeviceOverlay, screenRadius } from './devices.ts';
import { formatValue, type ExprValue } from '#components';
import { readVariable } from './vars.ts';
import { applySmartAnimate, planFromSnapshot, planSmartAnimate, snapshotLayers, type SmartPlan } from './smart.ts';

export type ScaleMode = 'fit' | 'actual' | 'width';

export interface PlayerOptions {
  /** The document to play; it is copied, the original is never changed. */
  doc: Document;
  pageId: NodeId;
  start: NodeId;
  measurer: TextMeasurer;
  /** Shown as a close button and on Esc; absent in a separate tab. */
  onClose?: () => void;
}

const DEFAULT_BG: Color = { r: 0.118, g: 0.118, b: 0.118, a: 1 };
const PAD = 24;
const PREFS = 'cs.player';
/** Pointer travel (px) after which a press becomes a drag-scroll instead of a click. */
const DRAG_SLOP = 5;

interface Prefs {
  scale: ScaleMode;
  hotspots: boolean;
}

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS) ?? 'null') as Partial<Prefs> | null;
    return { scale: p?.scale ?? 'fit', hotspots: p?.hotspots ?? true };
  } catch {
    return { scale: 'fit', hotspots: true };
  }
}

/** A screen's place on the canvas, in CSS pixels. */
interface Box {
  x: number;
  y: number;
  scale: number;
  width: number;
  height: number;
}

/** A running animation: progress p (eased) is fed to `step` every frame. */
interface Tween {
  start: number;
  duration: number;
  ease: (p: number) => number;
  step: (p: number) => void;
  done?: () => void;
}

export class PrototypePlayer {
  readonly el: HTMLElement;
  private doc: Document;
  private scene: SceneGraph;
  private scroll: ScrollState;
  private unsubscribe: () => void;
  private readonly snapshot: string;
  private readonly pageId: NodeId;
  private readonly measurer: TextMeasurer;
  private readonly renderer: Canvas2DRenderer;
  private session: PrototypeSession;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly title: HTMLElement;
  private readonly flowSelect: HTMLSelectElement;
  private readonly backButton: HTMLButtonElement;
  private readonly onClose?: () => void;
  private prefs = loadPrefs();
  /** Place of the current screen, recomputed on every draw. */
  private box: Box = { x: 0, y: 0, scale: 1, width: 0, height: 0 };
  /** Vertical offset when the screen is taller than the window (100 % and "fit width"). */
  private windowScroll = 0;
  private hovered: NodeId[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private flash: { ids: NodeId[]; until: number } | null = null;
  private frame = 0;
  /** Screen-to-screen transition; input waits until it ends. */
  private anim: { from: NodeId; to: NodeId; transition: Transition; ease: (p: number) => number; duration: number; start: number; smart: SmartPlan | null } | null = null;
  /** Overlay appearance per overlay screen: 0 hidden → 1 shown, and how it moves in. */
  private overlayShow = new Map<NodeId, { p: number; transition: Transition | null }>();
  /** Overlays animating out after the session closed them. */
  private closing: OpenOverlay[] = [];
  private tweens: Tween[] = [];
  /** What a "while hovering" / "while pressing" interaction undoes when it ends. */
  private revert: { node: NodeId; kind: 'ON_HOVER' | 'ON_PRESS'; undo: () => void } | null = null;
  private press: { x: number; y: number; chain: NodeId[]; dragging: boolean; pointer: number } | null = null;
  private suppressClick = false;
  private readonly resize: ResizeObserver;
  private readonly keyHandler: (e: KeyboardEvent) => void;
  private readonly debugPanel: HTMLElement;
  private readonly debugButton: HTMLButtonElement;
  /** Interactions that fired and what they did, newest last (FR-PRT-043). */
  private journal: { time: number; cause: string; lines: string[] }[] = [];

  constructor(options: PlayerOptions) {
    // A private copy: playing must not edit the file (and must not land in its undo history).
    this.snapshot = serialize(options.doc);
    this.pageId = options.pageId;
    this.measurer = options.measurer;
    this.onClose = options.onClose;
    this.renderer = new Canvas2DRenderer(options.measurer);
    this.renderer.images.onLoad = () => this.request();
    this.doc = deserialize(this.snapshot);
    this.scene = new SceneGraph(this.doc, this.pageId);
    this.scroll = new ScrollState(this.doc);
    // Scrolling and smart animate write into the private copy; the scene follows.
    this.unsubscribe = this.doc.subscribe((changes) => this.scene.invalidate(changes));
    this.session = this.newSession(options.start);

    this.canvas = h('canvas', { class: 'player-canvas', 'aria-label': tr('Экран прототипа') });
    this.ctx = this.canvas.getContext('2d')!;
    this.title = h('span', { class: 'player-title' });
    this.flowSelect = h('select', { class: 'field-select player-flows', 'aria-label': tr('Поток') });
    this.flowSelect.addEventListener('change', () => this.startAt(this.flowSelect.value));
    this.backButton = button('back', tr('Назад (Backspace)'), () => this.goBack());
    const restart = button('reset', tr('Перезапустить (R)'), () => this.restart());
    const prev = button('chevronLeft', tr('Предыдущий экран (←)'), () => this.step(-1));
    const next = button('chevronRight', tr('Следующий экран (→)'), () => this.step(1));
    const scale = h('select', { class: 'field-select player-scale', 'aria-label': tr('Масштаб') });
    for (const [v, label] of [['fit', tr('Вписать')], ['actual', '100 %'], ['width', tr('По ширине')]] as const) scale.append(h('option', { value: v }, label));
    scale.value = this.prefs.scale;
    scale.addEventListener('change', () => {
      this.prefs.scale = scale.value as ScaleMode;
      this.windowScroll = 0;
      this.savePrefs();
      this.request();
    });
    const hotspots = h('input', { type: 'checkbox', checked: this.prefs.hotspots });
    hotspots.addEventListener('change', () => {
      this.prefs.hotspots = hotspots.checked;
      this.savePrefs();
    });
    const hotspotLabel = h('label', { class: 'checkbox player-check', title: tr('Щелчок мимо подсвечивает, где можно нажать') }, hotspots, h('span', {}, tr('Подсказки')));
    const close = this.onClose ? button('close', tr('Закрыть (Esc)'), () => this.close()) : null;
    const debug = button('variable', tr('Отладка: переменные и журнал (D)'), () => this.toggleDebug());
    this.debugButton = debug;
    const bar = h('header', { class: 'player-bar' }, this.flowSelect, prev, this.title, next, h('span', { class: 'player-spacer' }), this.backButton, restart, debug, scale, hotspotLabel, ...(close ? [close] : []));
    for (const el of [scale, this.flowSelect]) el.addEventListener('keydown', (e) => e.stopPropagation());
    this.debugPanel = h('aside', { class: 'player-debug', hidden: true, 'aria-label': tr('Отладка прототипа') });
    this.el = h('div', { class: 'player', role: 'dialog', 'aria-label': tr('Просмотр прототипа') }, bar, h('div', { class: 'player-body' }, h('div', { class: 'player-stage' }, this.canvas), this.debugPanel));

    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.onUp(e));
    this.canvas.addEventListener('pointerleave', () => this.setHovered([]));
    this.canvas.addEventListener('click', (e) => this.onClick(e));
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.keyHandler = (e) => this.onKey(e);
    window.addEventListener('keydown', this.keyHandler, true);
    this.resize = new ResizeObserver(() => this.request());
    this.resize.observe(this.canvas);
    this.fillFlows();
    this.arrive();
  }

  /**
   * A session over the current private copy. Setting a variable re-resolves the
   * layers bound to it (FR-PRT-040), with scrolling paused like any structural change.
   */
  private newSession(start: NodeId): PrototypeSession {
    const session = new PrototypeSession(this.doc, start);
    session.writeVariable = (variable, mode, value) => {
      this.scroll.unscrolled(() => {
        this.doc.transact(
          (tx) => {
            tx.set(variable, 'varValues', { ...this.doc.get(variable, 'varValues'), [mode]: value });
            processTransaction(tx, this.measurer);
          },
          { undoable: false },
        );
      });
    };
    return session;
  }

  /** Current screen (for tests and the debugger). */
  get current(): NodeId {
    return this.session.current;
  }

  /** The private document being played (for tests). */
  get playing(): Document {
    return this.doc;
  }

  close(): void {
    this.dispose();
    this.onClose?.();
  }

  dispose(): void {
    this.clearTimers();
    this.finishTransition();
    this.unsubscribe();
    this.resize.disconnect();
    window.removeEventListener('keydown', this.keyHandler, true);
    cancelAnimationFrame(this.frame);
    this.el.remove();
  }

  private savePrefs(): void {
    try {
      localStorage.setItem(PREFS, JSON.stringify(this.prefs));
    } catch {
      // private mode: keep for this session only
    }
  }

  private fillFlows(): void {
    const list = flows(this.doc, this.pageId);
    this.flowSelect.replaceChildren(...list.map((f) => h('option', { value: f.nodeId }, f.name)));
    this.flowSelect.hidden = list.length === 0;
    if (list.some((f) => f.nodeId === this.session.start)) this.flowSelect.value = this.session.start;
  }

  /** A fresh copy of the file: variants, scrolling and (later) variables start over (FR-PRT-042). */
  private reload(start: NodeId): void {
    this.clearTimers();
    this.anim = null;
    this.tweens = [];
    this.closing = [];
    this.overlayShow.clear();
    this.revert = null;
    this.journal = [];
    this.unsubscribe();
    this.doc = deserialize(this.snapshot);
    this.scene = new SceneGraph(this.doc, this.pageId);
    this.scroll = new ScrollState(this.doc);
    this.unsubscribe = this.doc.subscribe((changes) => this.scene.invalidate(changes));
    this.session = this.newSession(start);
    this.arrive();
  }

  private startAt(start: NodeId): void {
    this.reload(start);
  }

  private restart(): void {
    this.reload(this.session.start);
  }

  /** Arrow keys: the screens of the flow in the order they are reached, else all screens of the page. */
  private step(delta: number): void {
    const order = reachable(this.doc, this.session.start);
    const list = order.length > 1 ? order : screens(this.doc, this.pageId);
    const i = list.indexOf(this.session.current);
    const to = list[i + delta];
    if (!to) return;
    const e = this.session.goTo(to);
    if (e) this.apply([e]);
  }

  private goBack(): void {
    const e = this.session.back();
    if (e) this.apply([e]);
  }

  // ---------- effects ----------

  private apply(effects: readonly Effect[], cause = ''): void {
    if (effects.length > 0) this.record(cause, effects);
    let first: NodeId | null = null;
    let last: Extract<Effect, { type: 'navigate' }> | null = null;
    for (const e of effects) {
      switch (e.type) {
        case 'navigate':
          first ??= e.from;
          last = e;
          break;
        case 'url':
          window.open(e.url, e.newTab || this.onClose ? '_blank' : '_self', 'noopener');
          break;
        case 'overlay-open':
          this.settingsCache.set(e.screen, { screen: e.screen, settings: e.settings, trigger: e.trigger, transition: e.transition });
          this.showOverlay(e.screen, e.transition);
          break;
        case 'overlay-swap':
          this.settingsCache.set(e.screen, { screen: e.screen, settings: e.settings, trigger: e.trigger, transition: e.transition });
          this.overlayShow.delete(e.from);
          this.showOverlay(e.screen, e.transition && e.transition.type !== 'INSTANT' ? { ...e.transition, type: 'DISSOLVE' } : null);
          break;
        case 'overlay-close':
          this.hideOverlay(e.screen, e.transition);
          break;
        case 'scroll':
          this.scrollTo(e.target, e.offset, e.transition);
          break;
        case 'change':
          this.changeVariant(e.instance, e.variant, e.transition);
          break;
        case 'variable':
        case 'error':
          // Already done by the session; shown in the debugger.
          break;
      }
    }
    if (last && first !== null) {
      // Several moves in one interaction animate as one, from the first screen to the last.
      this.closing = [];
      this.overlayShow.clear();
      if (!last.preserveScroll) this.scroll.reset(last.to);
      this.startTransition(first, last.to, last.transition);
      this.arrive();
    } else {
      this.updateChrome();
      this.request();
    }
  }

  private updateChrome(): void {
    this.title.textContent = this.doc.get(this.session.current, 'name');
    this.backButton.disabled = !this.session.canGoBack;
    this.renderDebug();
  }

  // ---------- debugger (FR-PRT-043) ----------

  private toggleDebug(): void {
    this.debugPanel.hidden = !this.debugPanel.hidden;
    this.debugButton.classList.toggle('active', !this.debugPanel.hidden);
    this.renderDebug();
    this.request();
  }

  private name(id: NodeId): string {
    return this.doc.store.isAlive(id) ? `«${this.doc.get(id, 'name')}»` : '«?»';
  }

  private describe(e: Effect): string {
    switch (e.type) {
      case 'navigate':
        return `${e.back ? tr('← назад к') : '→'} ${this.name(e.to)}`;
      case 'url':
        return tr('ссылка {0}', e.url);
      case 'overlay-open':
        return tr('оверлей {0}', this.name(e.screen));
      case 'overlay-swap':
        return tr('оверлей заменён на {0}', this.name(e.screen));
      case 'overlay-close':
        return tr('оверлей {0} закрыт', this.name(e.screen));
      case 'scroll':
        return tr('прокрутка к {0}', this.name(e.target));
      case 'change':
        return tr('{0} → вариант {1}', this.name(e.instance), this.name(e.variant));
      case 'variable':
        return `${this.name(e.variable)} = ${formatValue(e.value as ExprValue)}`;
      case 'error':
        return `⚠ ${e.message}`;
    }
  }

  private record(cause: string, effects: readonly Effect[]): void {
    this.journal.push({ time: Date.now(), cause: cause || tr('действие'), lines: effects.map((e) => this.describe(e)) });
    if (this.journal.length > 100) this.journal.splice(0, this.journal.length - 100);
  }

  private renderDebug(): void {
    if (this.debugPanel.hidden) return;
    const d = this.doc;
    const context = this.session.top;
    const rows = allVariables(d)
      .filter((v) => d.store.isAlive(v))
      .map((v) => {
        const value = readVariable(d, `#${v}`, context);
        const swatch = value !== undefined && typeof value === 'object' ? h('span', { class: 'player-swatch', style: `background:${cssColor(value)}` }) : null;
        return h('div', { class: 'player-var' }, h('span', { class: 'player-var-name', title: d.get(d.parent(v)!, 'name') }, d.get(v, 'name')), h('span', { class: 'player-var-value' }, ...(swatch ? [swatch] : []), value === undefined ? '—' : formatValue(value)));
      });
    const log = this.journal
      .slice()
      .reverse()
      .slice(0, 40)
      .map((j) => h('div', { class: 'player-log-entry' }, h('div', { class: 'player-log-cause' }, h('time', {}, new Date(j.time).toLocaleTimeString(locale())), ' ', j.cause), ...j.lines.map((l) => h('div', { class: `player-log-line${l.startsWith('⚠') ? ' error' : ''}` }, l))));
    this.debugPanel.replaceChildren(
      h('h3', {}, tr('Переменные')),
      ...(rows.length > 0 ? rows : [h('p', { class: 'player-empty' }, tr('В файле нет переменных.'))]),
      h('h3', {}, tr('Журнал')),
      ...(log.length > 0 ? log : [h('p', { class: 'player-empty' }, tr('Здесь появятся сработавшие взаимодействия.'))]),
    );
  }

  /** Starts the animation between two screens (FR-PRT-020, 021); instant ones just switch. */
  private startTransition(from: NodeId, to: NodeId, transition: Transition | null): void {
    this.finishTransition();
    if (!this.animates(transition) || from === to) return;
    const { ease, duration } = easingFunction(transition!.easing, transition!.duration);
    const smart = transition!.type === 'SMART_ANIMATE' ? planSmartAnimate(this.doc, from, to) : null;
    if (smart) applySmartAnimate(this.doc, smart, 0);
    this.anim = { from, to, transition: transition!, ease, duration, start: performance.now(), smart };
  }

  private animates(transition: Transition | null): boolean {
    return !!transition && transition.type !== 'INSTANT' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  private finishTransition(): void {
    const anim = this.anim;
    if (!anim) return;
    this.anim = null;
    if (anim.smart) applySmartAnimate(this.doc, anim.smart, 1);
  }

  /** Runs a tween; instant when there is no animation. */
  private tween(transition: Transition | null, step: (p: number) => void, done?: () => void): void {
    if (!this.animates(transition)) {
      step(1);
      done?.();
      this.request();
      return;
    }
    const { ease, duration } = easingFunction(transition!.easing, transition!.duration);
    this.tweens.push({ start: performance.now(), duration, ease, step, done });
    this.request();
  }

  private runTweens(now: number): void {
    if (this.tweens.length === 0) return;
    const running: Tween[] = [];
    for (const t of this.tweens) {
      const k = Math.min(1, (now - t.start) / t.duration);
      t.step(k >= 1 ? 1 : t.ease(k));
      if (k >= 1) t.done?.();
      else running.push(t);
    }
    this.tweens = running;
    this.scene.ensure();
  }

  private showOverlay(screen: NodeId, transition: Transition | null): void {
    const state = { p: 0, transition };
    this.overlayShow.set(screen, state);
    this.tween(transition, (p) => (state.p = p));
    for (const { delay, reaction } of this.session.timeouts(screen)) this.timers.push(setTimeout(() => this.runReaction(screen, reaction), delay));
  }

  private hideOverlay(screen: NodeId, transition: Transition | null): void {
    const state = this.overlayShow.get(screen);
    const entry = this.settingsCache.get(screen);
    if (!state || !entry) {
      this.overlayShow.delete(screen);
      return;
    }
    this.closing.push(entry);
    this.tween(
      transition,
      (p) => (state.p = 1 - p),
      () => {
        this.closing = this.closing.filter((o) => o.screen !== screen);
        this.overlayShow.delete(screen);
      },
    );
  }

  /** Overlays the viewer has shown, by screen: their settings outlive the session entry while closing. */
  private readonly settingsCache = new Map<NodeId, OpenOverlay>();

  /** "Scroll to" (FR-PRT-010): animates the nearest scrolling ancestor so the target sits at the offset. */
  private scrollTo(target: NodeId, offset: { x: number; y: number }, transition: Transition | null): void {
    const plan = this.scroll.targetOffset(target, this.screenOf(target), offset);
    if (!plan) return;
    const from = this.scroll.offset(plan.container);
    this.tween(transition, (p) => this.scroll.set(plan.container, from.x + (plan.to.x - from.x) * p, from.y + (plan.to.y - from.y) * p));
  }

  /** "Change to" (FR-PRT-010): the instance switches variant; smart animate morphs between them. */
  private changeVariant(instance: NodeId, variant: NodeId, transition: Transition | null): void {
    const before = this.animates(transition) ? snapshotLayers(this.doc, instance) : null;
    this.scroll.unscrolled(() => {
      this.doc.transact(
        (tx) => {
          tx.set(instance, 'mainComponent', variant);
          processTransaction(tx, this.measurer);
        },
        { undoable: false },
      );
    });
    if (!before) return;
    const plan = planFromSnapshot(this.doc, before, instance);
    applySmartAnimate(this.doc, plan, 0);
    this.tween(transition!.type === 'SMART_ANIMATE' || transition!.type === 'DISSOLVE' ? transition : { ...transition!, type: 'SMART_ANIMATE' }, (p) => applySmartAnimate(this.doc, plan, p));
  }

  /** On every new screen: reset hover, schedule "after delay" reactions. */
  private arrive(): void {
    this.clearTimers();
    this.windowScroll = 0;
    this.hovered = [];
    this.revert = null;
    this.flash = null;
    const screen = this.session.current;
    this.updateChrome();
    for (const { delay, reaction } of this.session.timeouts()) {
      this.timers.push(setTimeout(() => this.runReaction(screen, reaction), delay));
    }
    this.request();
  }

  private runReaction(screen: NodeId, reaction: Reaction): void {
    const open = this.session.current === screen || this.session.overlays.some((o) => o.screen === screen);
    if (!open) return;
    this.apply(this.session.run(reaction.actions, screen), tr('{0} · через {1} мс', this.name(screen), reaction.trigger.timeout ?? 800));
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  // ---------- geometry of screens and overlays ----------

  /** Where a screen sits on the canvas and at what scale (FR-PRT-050). */
  private get device(): PrototypeDevice {
    return this.doc.get(this.pageId, 'prototypeDevice');
  }

  private place(screen: NodeId, cw: number, ch: number, scale?: number): Box {
    const w = this.doc.get(screen, 'width');
    const hgt = this.doc.get(screen, 'height');
    // The device body takes room around the screen (FR-PRT-050).
    const ins = deviceInsets(this.device, w);
    const fw = w + ins.left + ins.right;
    const fh = hgt + ins.top + ins.bottom;
    const fit = Math.min((cw - PAD * 2) / fw, (ch - PAD * 2) / fh);
    const s = scale ?? (this.prefs.scale === 'actual' ? 1 : this.prefs.scale === 'width' ? (cw - PAD * 2) / fw : Math.min(1, fit));
    // Taller than the window: the window scrolls; otherwise the screen is centred.
    const maxScroll = Math.max(0, fh * s + PAD * 2 - ch);
    if (scale === undefined) this.windowScroll = Math.max(0, Math.min(maxScroll, this.windowScroll));
    const x = Math.round((cw - fw * s) / 2 + ins.left * s);
    const y = Math.round(maxScroll > 0 ? PAD - (scale === undefined ? this.windowScroll : 0) + ins.top * s : (ch - fh * s) / 2 + ins.top * s);
    return { x, y, scale: s, width: w * s, height: hgt * s };
  }

  /** Clips to the visible screen: rounded on phones and tablets. */
  private clipScreen(x: number, y: number, w: number, h: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    const r = screenRadius(this.device, this.box.width || w);
    if (r > 0) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
    ctx.clip();
  }

  /** Canvas rectangle of a layer drawn as part of `screen` at `box` (unrotated bounds). */
  private layerRect(id: NodeId, screen: NodeId, box: Box): { x: number; y: number; width: number; height: number } {
    const b = this.scene.bounds(id);
    const a = apply(invert(this.scene.world(screen))!, { x: b.x, y: b.y });
    return { x: box.x + a.x * box.scale, y: box.y + a.y * box.scale, width: b.width * box.scale, height: b.height * box.scale };
  }

  /** Overlay placement relative to the screen under it (FR-PRT-011). */
  private overlayBox(o: OpenOverlay, base: Box): Box {
    const s = base.scale;
    const w = this.doc.get(o.screen, 'width') * s;
    const hh = this.doc.get(o.screen, 'height') * s;
    let x = base.x + (base.width - w) / 2;
    let y = base.y + (base.height - hh) / 2;
    const left = base.x;
    const right = base.x + base.width - w;
    const top = base.y;
    const bottom = base.y + base.height - hh;
    switch (o.settings.position) {
      case 'TOP_LEFT':
        [x, y] = [left, top];
        break;
      case 'TOP_CENTER':
        y = top;
        break;
      case 'TOP_RIGHT':
        [x, y] = [right, top];
        break;
      case 'BOTTOM_LEFT':
        [x, y] = [left, bottom];
        break;
      case 'BOTTOM_CENTER':
        y = bottom;
        break;
      case 'BOTTOM_RIGHT':
        [x, y] = [right, bottom];
        break;
      case 'MANUAL':
        [x, y] = [left + o.settings.offset.x * s, top + o.settings.offset.y * s];
        break;
      case 'RELATIVE': {
        // Below the layer that opened it, shifted by the offset (menus, tooltips).
        if (o.trigger && this.doc.store.isAlive(o.trigger)) {
          const host = this.screenOf(o.trigger);
          const hostBox = host === this.session.current ? base : this.overlayBox(this.settingsCache.get(host) ?? o, base);
          const r = this.layerRect(o.trigger, host, hostBox);
          [x, y] = [r.x + o.settings.offset.x * s, r.y + r.height + o.settings.offset.y * s];
        }
        break;
      }
      default:
        break;
    }
    return { x: Math.round(x), y: Math.round(y), scale: s, width: w, height: hh };
  }

  /** The screen (base or overlay) a layer belongs to. */
  private screenOf(id: NodeId): NodeId {
    let current: NodeId | null = id;
    while (current !== null) {
      if (isScreen(this.doc, current)) return current;
      current = this.doc.parent(current);
    }
    return this.session.current;
  }

  /** Overlays to draw (open and closing), bottom first, with their placement. */
  private overlayLayers(): { overlay: OpenOverlay; box: Box; shown: number }[] {
    const list = [...this.session.overlays, ...this.closing.map((c) => this.settingsCache.get(c.screen) ?? c)];
    return list
      .filter((o) => this.doc.store.isAlive(o.screen))
      .map((overlay) => ({ overlay, box: this.overlayBox(overlay, this.box), shown: this.overlayShow.get(overlay.screen)?.p ?? 1 }));
  }

  // ---------- input ----------

  private local(e: MouseEvent): Point {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /**
   * What is under the pointer: the top overlay takes input (overlays are modal);
   * outside it nothing on the screen below reacts.
   */
  private target(e: MouseEvent): { screen: NodeId | null; hits: NodeId[]; outside: OpenOverlay | null } {
    const p = this.local(e);
    const overlays = this.overlayLayers().filter((o) => this.session.overlays.includes(o.overlay));
    const top = overlays[overlays.length - 1];
    if (top) {
      const inside = p.x >= top.box.x && p.y >= top.box.y && p.x <= top.box.x + top.box.width && p.y <= top.box.y + top.box.height;
      return inside ? { screen: top.overlay.screen, hits: this.hitsIn(top.overlay.screen, top.box, p), outside: null } : { screen: null, hits: [], outside: top.overlay };
    }
    const screen = this.session.current;
    const b = this.box;
    if (p.x < b.x || p.y < b.y || p.x > b.x + b.width || p.y > b.y + b.height) return { screen: null, hits: [], outside: null };
    return { screen, hits: this.hitsIn(screen, b, p), outside: null };
  }

  /** The link of the text character under the pointer, if any. */
  private linkUnder(e: MouseEvent, screen: NodeId | null, id: NodeId): string | null {
    if (!screen || this.doc.type(id) !== 'TEXT') return null;
    const layer = this.overlayLayers().find((o) => o.overlay.screen === screen && this.session.overlays.includes(o.overlay));
    const box = layer ? layer.box : this.box;
    const p = this.local(e);
    const local = { x: (p.x - box.x) / box.scale, y: (p.y - box.y) / box.scale };
    return linkAt(this.doc, this.scene, this.measurer, id, apply(this.scene.world(screen), local));
  }

  private hitsIn(screen: NodeId, box: Box, p: Point): NodeId[] {
    const local = { x: (p.x - box.x) / box.scale, y: (p.y - box.y) / box.scale };
    const world = apply(this.scene.world(screen), local);
    return this.scene.hitTest(world).filter((id) => this.doc.store.isAncestorOrSelf(screen, id));
  }

  /** The hit layer and its ancestors up to its screen. */
  private chainOf(hits: NodeId[], screen: NodeId | null): NodeId[] {
    const top = hits[0];
    if (!top || !screen) return [];
    return [top, ...this.doc.store.ancestors(top).filter((a) => this.doc.store.isAncestorOrSelf(screen, a))];
  }

  private busy(): boolean {
    return this.anim !== null;
  }

  private onDown(e: PointerEvent): void {
    if (this.busy() || e.button !== 0) return;
    const t = this.target(e);
    const chain = this.chainOf(t.hits, t.screen);
    this.press = { ...this.local(e), chain, dragging: false, pointer: e.pointerId };
    this.suppressClick = false;
    // "While pressing" (FR-PRT-003): runs now, undone on release.
    if (t.hits[0]) this.startWhile(t.hits[0], 'ON_PRESS');
  }

  private onUp(e: PointerEvent): void {
    if (this.press?.dragging) {
      this.suppressClick = true;
      if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    }
    this.press = null;
    if (this.revert?.kind === 'ON_PRESS') this.endWhile();
  }

  private onClick(e: MouseEvent): void {
    if (this.busy()) return;
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    const t = this.target(e);
    if (t.outside) {
      // A click outside an overlay closes it when it is set to (FR-PRT-011).
      if (t.outside.settings.closeOnClickOutside) this.apply(this.session.run([{ type: 'CLOSE_OVERLAY' }]), tr('щелчок вне оверлея'));
      return;
    }
    const top = t.hits[0];
    // A link in a text opens the site (a new tab), before any reaction of the layers around it.
    const link = top ? this.linkUnder(e, t.screen, top) : null;
    if (link) {
      openLink(link);
      return;
    }
    const found = top ? this.session.findReaction(top, 'ON_CLICK') : null;
    if (found) {
      this.apply(this.session.run(found.reaction.actions, found.node), tr('{0} · по нажатию', this.name(found.node)));
      return;
    }
    // A click that does nothing shows where one would (FR-PRT-051).
    if (this.prefs.hotspots && t.screen) {
      const ids = interactiveLayers(this.doc, t.screen);
      if (ids.length > 0) {
        this.flash = { ids, until: performance.now() + 600 };
        this.request();
      }
    }
  }

  private onMove(e: PointerEvent): void {
    if (this.busy()) return;
    const press = this.press;
    if (press && (e.buttons & 1) !== 0) {
      const p = this.local(e);
      if (!press.dragging && Math.hypot(p.x - press.x, p.y - press.y) > DRAG_SLOP && press.chain.some((id) => this.scroll.isContainer(id))) {
        press.dragging = true;
        this.canvas.setPointerCapture(press.pointer);
        if (this.revert?.kind === 'ON_PRESS') this.endWhile();
      }
      if (press.dragging) {
        // Dragging scrolls the content under the finger, like on a phone.
        const scale = this.box.scale;
        this.scroll.scrollBy(press.chain.filter((id) => this.scroll.isContainer(id)), -(p.x - press.x) / scale, -(p.y - press.y) / scale);
        press.x = p.x;
        press.y = p.y;
        this.request();
        return;
      }
    }
    const t = this.target(e);
    const chain = this.chainOf(t.hits, t.screen);
    this.setHovered(chain);
    const clickable = chain.some((id) => this.doc.get(id, 'reactions').some((r) => r.trigger.type === 'ON_CLICK')) || (t.outside?.settings.closeOnClickOutside ?? false) || (!!t.hits[0] && !!this.linkUnder(e, t.screen, t.hits[0]));
    this.canvas.style.cursor = clickable ? 'pointer' : 'default';
  }

  /** Mouse enter / leave and "while hovering" reactions of layers the pointer entered or left. */
  private setHovered(chain: NodeId[]): void {
    const before = new Set(this.hovered);
    const after = new Set(chain);
    this.hovered = chain;
    if (this.revert?.kind === 'ON_HOVER' && !after.has(this.revert.node)) this.endWhile();
    const screen = this.session.current;
    for (const id of before) {
      if (after.has(id) || this.session.current !== screen || !this.doc.store.isAlive(id)) continue;
      const r = this.doc.get(id, 'reactions').find((x) => x.trigger.type === 'MOUSE_LEAVE');
      if (r) this.apply(this.session.run(r.actions, id), tr('{0} · курсор ушёл', this.name(id)));
    }
    for (const id of chain) {
      if (before.has(id) || this.session.current !== screen) continue;
      const r = this.doc.get(id, 'reactions').find((x) => x.trigger.type === 'MOUSE_ENTER');
      if (r) this.apply(this.session.run(r.actions, id), tr('{0} · при наведении', this.name(id)));
      if (!this.revert && this.doc.get(id, 'reactions').some((x) => x.trigger.type === 'ON_HOVER')) this.startWhile(id, 'ON_HOVER');
    }
  }

  /** "While hovering / pressing": run the interaction and remember how to undo it. */
  private startWhile(id: NodeId, kind: 'ON_HOVER' | 'ON_PRESS'): void {
    if (this.revert) return;
    const found = this.session.findReaction(id, kind);
    if (!found) return;
    const effects = this.session.run(found.reaction.actions, found.node);
    if (effects.length === 0) return;
    const undo: (() => void)[] = [];
    for (const e of effects) {
      if (e.type === 'change') {
        const previous = this.doc.get(e.instance, 'mainComponent');
        if (previous) undo.push(() => this.changeVariant(e.instance, previous, e.transition));
      } else if (e.type === 'overlay-open') {
        undo.push(() => this.apply(this.session.run([{ type: 'CLOSE_OVERLAY' }], e.screen)));
      } else if (e.type === 'navigate') {
        undo.push(() => this.goBack());
      }
    }
    this.apply(effects, `${this.name(found.node)} · ${kind === 'ON_HOVER' ? tr('пока наведено') : tr('пока зажато')}`);
    this.revert = { node: found.node, kind, undo: () => undo.reverse().forEach((f) => f()) };
  }

  private endWhile(): void {
    const r = this.revert;
    this.revert = null;
    r?.undo();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (this.busy()) return;
    const t = this.target(e);
    const chain = this.chainOf(t.hits, t.screen).filter((id) => this.scroll.isContainer(id));
    const scale = this.box.scale;
    // Shift turns a vertical wheel into horizontal scrolling, as in browsers.
    const dx = (e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX) / scale;
    const dy = (e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY) / scale;
    const rest = this.scroll.scrollBy(chain, dx, dy);
    // What the screen could not use scrolls the window (a screen taller than it).
    this.windowScroll += rest.y * scale;
    this.request();
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.el.isConnected) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
    e.stopPropagation();
    // Keys the prototype itself reacts to come first.
    const effects = this.session.key(e.key);
    if (effects && effects.length > 0) {
      e.preventDefault();
      this.apply(effects, tr('клавиша {0}', e.key));
      return;
    }
    if (e.key.toLowerCase() === 'd' || e.key.toLowerCase() === 'в') {
      e.preventDefault();
      this.toggleDebug();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      // Esc closes the top overlay first, then the viewer.
      if (this.session.overlays.length > 0) this.apply(this.session.run([{ type: 'CLOSE_OVERLAY' }]));
      else if (this.onClose) this.close();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      this.step(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      this.step(-1);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      this.goBack();
    } else if (e.key.toLowerCase() === 'r' || e.key.toLowerCase() === 'к') {
      e.preventDefault();
      this.restart();
    }
  }

  // ---------- drawing ----------

  private request(): void {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.draw());
  }

  private draw(): void {
    const dpr = window.devicePixelRatio || 1;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (cw === 0 || ch === 0) return;
    if (this.canvas.width !== Math.round(cw * dpr) || this.canvas.height !== Math.round(ch * dpr)) {
      this.canvas.width = Math.round(cw * dpr);
      this.canvas.height = Math.round(ch * dpr);
    }
    const now = performance.now();
    this.runTweens(now);
    const ctx = this.ctx;
    const screen = this.session.current;
    this.scene.ensure();
    const box = this.place(screen, cw, ch);
    this.box = box;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = cssColor(this.doc.get(this.pageId, 'prototypeBackground') ?? DEFAULT_BG);
    ctx.fillRect(0, 0, cw, ch);

    drawDevice(ctx, this.device, box.x, box.y, box.width, box.height);
    // While the device is on, everything below is drawn within its screen.
    ctx.save();
    this.clipScreen(box.x, box.y, box.width, box.height);
    const anim = this.anim;
    let more = this.tweens.length > 0;
    if (anim && anim.to === screen) {
      const t = Math.min(1, (now - anim.start) / anim.duration);
      this.drawTransition(anim, t >= 1 ? 1 : anim.ease(t), box, cw, ch, dpr);
      if (t >= 1) this.finishTransition();
      more = true;
    } else {
      if (anim) this.finishTransition();
      this.drawScreen(screen, box, 0, 0, 1, dpr, true);
    }

    // Overlays: dimming over the screen below, then the overlay sliding or fading in (FR-PRT-011).
    for (const { overlay, box: ob, shown } of this.overlayLayers()) {
      const bg = overlay.settings.background;
      if (bg && shown > 0) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = cssColor(bg, Math.max(0, Math.min(1, shown)));
        ctx.fillRect(box.x, box.y, box.width, box.height);
      }
      const motion = this.overlayMotion(overlay, ob, box, shown);
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // An overlay stays inside the device screen.
      this.clipScreen(box.x, box.y, box.width, box.height);
      this.drawScreen(overlay.screen, ob, motion.dx, motion.dy, motion.alpha, dpr, true);
      ctx.restore();
    }

    ctx.restore();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawDeviceOverlay(ctx, this.device, box.x, box.y, box.width);

    if (this.flash && now < this.flash.until) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = 'rgba(79, 91, 213, 0.25)';
      ctx.strokeStyle = 'rgba(79, 91, 213, 0.9)';
      ctx.lineWidth = 2;
      const layers = this.overlayLayers();
      for (const id of this.flash.ids) {
        const host = this.screenOf(id);
        const hostBox = host === screen ? box : (layers.find((l) => l.overlay.screen === host)?.box ?? box);
        const r = this.layerRect(id, host, hostBox);
        ctx.fillRect(r.x, r.y, r.width, r.height);
        ctx.strokeRect(r.x + 1, r.y + 1, r.width - 2, r.height - 2);
      }
      more = true;
    } else if (this.flash) {
      this.flash = null;
    }
    if (more) this.request();
    else if (this.renderer.animated.size > 0) {
      // A video or an animated GIF on the screen: about 30 frames a second.
      this.renderer.animated.clear();
      setTimeout(() => this.request(), 33);
    }
  }

  /** How an overlay moves while it opens or closes: fades, or slides in from a side. */
  private overlayMotion(o: OpenOverlay, ob: Box, base: Box, shown: number): { dx: number; dy: number; alpha: number } {
    const t = this.overlayShow.get(o.screen)?.transition ?? o.transition;
    if (!t || t.type === 'INSTANT' || shown >= 1) return { dx: 0, dy: 0, alpha: shown > 0 ? 1 : 0 };
    if (t.type === 'DISSOLVE' || t.type === 'SMART_ANIMATE') return { dx: 0, dy: 0, alpha: shown };
    // Slides from outside the device edge opposite to the motion.
    const dir = t.direction ?? 'TOP';
    const rest = 1 - shown;
    const dx = dir === 'LEFT' ? (base.x + base.width - ob.x) * rest : dir === 'RIGHT' ? -(ob.x + ob.width - base.x) * rest : 0;
    const dy = dir === 'TOP' ? (base.y + base.height - ob.y) * rest : dir === 'BOTTOM' ? -(ob.y + ob.height - base.y) * rest : 0;
    return { dx, dy, alpha: 1 };
  }

  /** Draws a screen at its place, shifted by (dx, dy) CSS pixels, clipped to its own box. */
  private drawScreen(screen: NodeId, box: Box, dx: number, dy: number, alpha: number, dpr: number, clip: boolean): void {
    const ctx = this.ctx;
    const x = box.x + dx;
    const y = box.y + dy;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (clip) {
      // The window onto the screen: nothing outside it shows, as on a device.
      this.clipScreen(x, y, box.width, box.height);
    }
    this.toScreenSpace(screen, x, y, box.scale, dpr);
    const parent = this.doc.parent(screen);
    if (parent && this.doc.type(parent) !== 'PAGE') {
      const m = this.scene.world(parent);
      ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    }
    this.renderer.renderNode(ctx, this.scene, screen, this.scene.renderBounds(screen), box.scale * dpr);
    ctx.restore();
  }

  /** Sets the context so that world coordinates land where `screen` is drawn at (x, y). */
  private toScreenSpace(screen: NodeId, x: number, y: number, scale: number, dpr: number): void {
    const inv = invert(this.scene.world(screen))!;
    this.ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * x, dpr * y);
    this.ctx.transform(inv.a, inv.b, inv.c, inv.d, inv.e, inv.f);
  }

  /**
   * One frame of a transition at progress p. Directions name where the motion
   * goes: "LEFT" brings the new screen in from the right edge (FR-PRT-020).
   */
  private drawTransition(anim: NonNullable<PrototypePlayer['anim']>, p: number, to: Box, cw: number, ch: number, dpr: number): void {
    const ctx = this.ctx;
    const from = this.place(anim.from, cw, ch, to.scale);
    // Moving screens stay inside the device: the union of both boxes.
    const left = Math.min(from.x, to.x);
    const top = Math.min(from.y, to.y);
    const right = Math.max(from.x + from.width, to.x + to.width);
    const bottom = Math.max(from.y + from.height, to.y + to.height);
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath();
    ctx.rect(left, top, right - left, bottom - top);
    ctx.clip();
    const dir = anim.transition.direction ?? 'LEFT';
    const vx = dir === 'LEFT' ? -1 : dir === 'RIGHT' ? 1 : 0;
    const vy = dir === 'TOP' ? -1 : dir === 'BOTTOM' ? 1 : 0;
    const W = right - left;
    const H = bottom - top;
    // Offset of a screen that travels `amount` of the way along the motion.
    const off = (amount: number) => ({ x: vx * W * amount, y: vy * H * amount });
    const draw = (screen: NodeId, box: Box, o: { x: number; y: number }, alpha = 1) => this.drawScreen(screen, box, o.x, o.y, alpha, dpr, true);
    switch (anim.transition.type) {
      case 'DISSOLVE':
        draw(anim.from, from, off(0));
        draw(anim.to, to, off(0), p);
        break;
      case 'MOVE_IN':
        draw(anim.from, from, off(0));
        draw(anim.to, to, off(p - 1));
        break;
      case 'MOVE_OUT':
        draw(anim.to, to, off(0));
        draw(anim.from, from, off(p));
        break;
      case 'PUSH':
        draw(anim.from, from, off(p));
        draw(anim.to, to, off(p - 1));
        break;
      case 'SLIDE_IN':
        // The old screen drifts a little (parallax) while the new one covers it.
        draw(anim.from, from, off(p * 0.3));
        draw(anim.to, to, off(p - 1));
        break;
      case 'SLIDE_OUT':
        draw(anim.to, to, off((p - 1) * 0.3));
        draw(anim.from, from, off(p));
        break;
      case 'SMART_ANIMATE':
        if (anim.smart) {
          applySmartAnimate(this.doc, anim.smart, p);
          this.scene.ensure();
        }
        draw(anim.to, to, off(0));
        if (anim.smart) this.drawFadingOut(anim.smart, to, 1 - p, dpr);
        break;
      default:
        draw(anim.to, to, off(0));
    }
    ctx.restore();
  }

  /** Layers of the old screen with no match, fading out over the new screen. */
  private drawFadingOut(plan: SmartPlan, box: Box, alpha: number, dpr: number): void {
    if (alpha <= 0) return;
    const ctx = this.ctx;
    const targetOf = new Map(plan.matched.map((m) => [m.source, m.id]));
    for (const id of plan.fadeOut) {
      const parent = this.doc.parent(id)!;
      ctx.save();
      ctx.globalAlpha = Math.min(1, alpha);
      ctx.beginPath();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.rect(box.x, box.y, box.width, box.height);
      ctx.clip();
      if (parent === plan.from) {
        this.toScreenSpace(plan.from, box.x, box.y, box.scale, dpr);
        const m = this.scene.world(plan.from);
        ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
      } else {
        // The parent morphs: follow its current (interpolated) place in the new screen.
        const host = targetOf.get(parent);
        this.toScreenSpace(plan.to, box.x, box.y, box.scale, dpr);
        const m = this.scene.world(host ?? parent);
        ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
      }
      this.renderer.renderNode(ctx, this.scene, id, this.scene.renderBounds(id), box.scale * dpr);
      ctx.restore();
    }
  }
}

function button(name: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = h('button', { class: 'icon-button', type: 'button', title, 'aria-label': title }, icon(name, 16));
  b.addEventListener('click', onClick);
  return b;
}
