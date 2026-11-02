// Prototype model (section 13 of the spec): which layers are screens, flows and
// their entry points, connections between screens, and a playback session that
// turns user input into navigation. Pure logic over the document — no DOM — so
// the editor, the in-app viewer and the viewer in a separate tab share it and
// it is covered by tests.

import { tr } from '#core';
import { reverseTransition } from './easing.ts';
import { formatValue, tryEvaluate, type ExprError, type ExprValue } from '#components';
import { coerce, readVariable, variableMode } from './vars.ts';
import type { Document, FlowStart, NodeId, OverlaySettings, PrototypeAction, Reaction, Transition, TriggerType, VariableLiteral, Vec } from '#core';

/** Screen types: frames and components placed directly on the page or in a section. */
const SCREEN_TYPES = new Set(['FRAME', 'COMPONENT', 'INSTANCE']);

/** A "screen" is a top-level frame: its parent is the page or a section (FR-PRT-001). */
export function isScreen(doc: Document, id: NodeId): boolean {
  if (!doc.store.isAlive(id) || !SCREEN_TYPES.has(doc.type(id))) return false;
  const parent = doc.parent(id);
  if (!parent) return false;
  const t = doc.type(parent);
  return t === 'PAGE' || t === 'SECTION';
}

/** The screen containing a layer (the layer itself when it is one), or null. */
export function screenOf(doc: Document, id: NodeId): NodeId | null {
  let current: NodeId | null = id;
  while (current !== null && doc.store.isAlive(current)) {
    if (isScreen(doc, current)) return current;
    current = doc.parent(current);
  }
  return null;
}

/** Page this node lives on. */
export function pageOf(doc: Document, id: NodeId): NodeId | null {
  let current: NodeId | null = id;
  while (current !== null) {
    if (doc.type(current) === 'PAGE') return current;
    current = doc.parent(current);
  }
  return null;
}

/** Screens of a page in layer order (sections are looked into). */
export function screens(doc: Document, pageId: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const walk = (parent: NodeId) => {
    for (const id of doc.children(parent)) {
      if (doc.type(id) === 'SECTION') walk(id);
      else if (isScreen(doc, id)) out.push(id);
    }
  };
  walk(pageId);
  return out;
}

/** Flow entry points of a page whose screens still exist. */
export function flows(doc: Document, pageId: NodeId): FlowStart[] {
  return doc.get(pageId, 'flowStartingPoints').filter((f) => isScreen(doc, f.nodeId) && pageOf(doc, f.nodeId) === pageId);
}

/** A NAVIGATE action drawn as an arrow on the canvas. */
export interface Connection {
  source: NodeId;
  destination: NodeId;
  reaction: number;
  action: number;
  trigger: TriggerType;
  /** Overlays are drawn dashed. */
  overlay: boolean;
}

/** Actions of an interaction including those inside conditions (nested ones get index -1). */
export function allActions(actions: readonly PrototypeAction[]): { action: PrototypeAction; index: number }[] {
  const out: { action: PrototypeAction; index: number }[] = [];
  const walk = (list: readonly PrototypeAction[], top: boolean) => {
    list.forEach((action, i) => {
      out.push({ action, index: top ? i : -1 });
      if (action.type === 'CONDITIONAL') for (const b of action.branches) walk(b.actions, false);
    });
  };
  walk(actions, true);
  return out;
}

/** Every live connection on a page (FR-PRT-001: blue arrows). */
export function connections(doc: Document, pageId: NodeId): Connection[] {
  const out: Connection[] = [];
  doc.store.walk(pageId, (id) => {
    const reactions = doc.get(id, 'reactions');
    reactions.forEach((r, ri) => {
      allActions(r.actions).forEach(({ action: a, index: ai }) => {
        if ((a.type === 'NAVIGATE' || a.type === 'OPEN_OVERLAY' || a.type === 'SWAP_OVERLAY') && a.destinationId && isScreen(doc, a.destinationId) && a.destinationId !== screenOf(doc, id)) {
          out.push({ source: id, destination: a.destinationId, reaction: ri, action: ai, trigger: r.trigger.type, overlay: a.type !== 'NAVIGATE' });
        }
      });
    });
  });
  return out;
}

/** Screens reachable from `start` by navigation, breadth first: the order arrow keys follow. */
export function reachable(doc: Document, start: NodeId): NodeId[] {
  const seen = new Set<NodeId>([start]);
  const order = [start];
  for (let i = 0; i < order.length; i++) {
    doc.store.walk(order[i]!, (id) => {
      for (const r of doc.get(id, 'reactions')) {
        for (const { action: a } of allActions(r.actions)) {
          if (a.type === 'NAVIGATE' && a.destinationId && !seen.has(a.destinationId) && isScreen(doc, a.destinationId)) {
            seen.add(a.destinationId);
            order.push(a.destinationId);
          }
        }
      }
    });
  }
  return order;
}

/** Layers of a screen that react to the pointer (for the "clickable areas" hint, FR-PRT-051). */
export function interactiveLayers(doc: Document, screen: NodeId): NodeId[] {
  const out: NodeId[] = [];
  doc.store.walk(screen, (id) => {
    if (id !== screen && doc.get(id, 'visible') && doc.get(id, 'reactions').some((r) => POINTER_TRIGGERS.has(r.trigger.type))) out.push(id);
  });
  return out;
}

const POINTER_TRIGGERS = new Set<TriggerType>(['ON_CLICK', 'ON_HOVER', 'ON_PRESS', 'MOUSE_ENTER', 'MOUSE_LEAVE']);

export const DEFAULT_TRANSITION: Transition = { type: 'INSTANT', duration: 300, easing: { type: 'EASE_OUT' } };

export const DEFAULT_OVERLAY: OverlaySettings = { position: 'CENTER', offset: { x: 0, y: 0 }, closeOnClickOutside: true, background: { r: 0, g: 0, b: 0, a: 0.4 } };

/** What the viewer must do after an interaction. */
export type Effect =
  | { type: 'navigate'; from: NodeId; to: NodeId; transition: Transition | null; back: boolean; preserveScroll: boolean }
  | { type: 'url'; url: string; newTab: boolean }
  | { type: 'overlay-open'; screen: NodeId; settings: OverlaySettings; trigger: NodeId | null; transition: Transition | null }
  | { type: 'overlay-swap'; from: NodeId; screen: NodeId; settings: OverlaySettings; trigger: NodeId | null; transition: Transition | null }
  | { type: 'overlay-close'; screen: NodeId; transition: Transition | null }
  | { type: 'scroll'; target: NodeId; offset: Vec; transition: Transition | null }
  | { type: 'change'; instance: NodeId; variant: NodeId; transition: Transition | null }
  /** A variable got a new value (for the debugger; the session has already written it). */
  | { type: 'variable'; variable: NodeId; value: VariableLiteral }
  /** An expression could not be computed: the action is skipped, the debugger shows why. */
  | { type: 'error'; message: string };

/** Nesting limit of conditions (FR-PRT-041). */
export const MAX_CONDITION_DEPTH = 5;

/**
 * Writes a variable's value during playback. The viewer passes one that also
 * re-resolves bound layers; by default the value is just stored.
 */
export type VariableWriter = (variable: NodeId, mode: string, value: VariableLiteral) => void;

/** An overlay shown over the current screen (FR-PRT-011). */
export interface OpenOverlay {
  screen: NodeId;
  settings: OverlaySettings;
  /** The layer that opened it (for "relative to trigger" placement). */
  trigger: NodeId | null;
  transition: Transition | null;
}

/**
 * One run of a prototype (FR-PRT-042: state lives for the session; "Restart"
 * resets it). Tracks the current screen, open overlays and history for "Back".
 */
export class PrototypeSession {
  readonly doc: Document;
  readonly start: NodeId;
  current: NodeId;
  /** Overlays over the current screen, bottom first. */
  overlays: OpenOverlay[] = [];
  /** Screens left, with the transition that left them ("Back" plays it reversed). */
  private history: { screen: NodeId; transition: Transition | null }[] = [];
  writeVariable: VariableWriter;

  constructor(doc: Document, start: NodeId) {
    this.doc = doc;
    this.start = start;
    this.current = start;
    this.writeVariable = (variable, mode, value) => {
      doc.transact((tx) => tx.set(variable, 'varValues', { ...doc.get(variable, 'varValues'), [mode]: value }), { undoable: false });
    };
  }

  /** Evaluates an expression as seen from `context` (variable modes come from its ancestors). */
  evaluate(expression: string, context: NodeId | null): { value: ExprValue } | { error: ExprError } {
    return tryEvaluate(expression, (ref) => readVariable(this.doc, ref, context ?? this.current));
  }

  get canGoBack(): boolean {
    return this.history.length > 0 || this.overlays.length > 0;
  }

  /** The screen that takes input: the top overlay, else the current screen. */
  get top(): NodeId {
    return this.overlays[this.overlays.length - 1]?.screen ?? this.current;
  }

  restart(): void {
    this.current = this.start;
    this.history = [];
    this.overlays = [];
  }

  /**
   * The reaction for a trigger on a layer: the layer itself or the nearest
   * ancestor up to its screen that has one (a click on a label inside a button
   * triggers the button).
   */
  findReaction(id: NodeId, type: TriggerType, key?: string): { node: NodeId; reaction: Reaction } | null {
    let current: NodeId | null = id;
    while (current !== null && this.doc.store.isAlive(current)) {
      const reaction = this.doc.get(current, 'reactions').find((r) => r.trigger.type === type && (type !== 'ON_KEY' || keyMatches(r.trigger.key, key)));
      if (reaction) return { node: current, reaction };
      if (isScreen(this.doc, current)) break;
      current = this.doc.parent(current);
    }
    return null;
  }

  /** Fires a trigger on a layer; returns what to show. Nothing happens if no layer reacts. */
  fire(id: NodeId, type: TriggerType, key?: string): Effect[] | null {
    const found = this.findReaction(id, type, key);
    return found ? this.run(found.reaction.actions, found.node) : null;
  }

  /** A key press: ON_KEY reactions of the top overlay first, then of the screen. */
  key(key: string): Effect[] | null {
    let result: Effect[] | null = null;
    const roots = [...this.overlays.map((o) => o.screen).reverse(), this.current];
    for (const root of roots) {
      this.doc.store.walk(root, (id) => {
        if (result) return;
        const r = this.doc.get(id, 'reactions').find((x) => x.trigger.type === 'ON_KEY' && keyMatches(x.trigger.key, key));
        if (r) result = this.run(r.actions, id);
      });
      if (result) break;
    }
    return result;
  }

  /** AFTER_TIMEOUT reactions of a screen (the current one by default): the viewer schedules them on arrival. */
  timeouts(screen = this.current): { delay: number; reaction: Reaction }[] {
    return this.doc
      .get(screen, 'reactions')
      .filter((r) => r.trigger.type === 'AFTER_TIMEOUT')
      .map((reaction) => ({ delay: Math.max(0, reaction.trigger.timeout ?? 800), reaction }));
  }

  /** Runs actions in order; `node` is the layer whose interaction it is. */
  run(actions: readonly PrototypeAction[], node: NodeId | null = null, depth = 0): Effect[] {
    const effects: Effect[] = [];
    const d = this.doc;
    for (const action of actions) {
      switch (action.type) {
        case 'SET_VARIABLE': {
          const variable = action.variableId && d.store.isAlive(action.variableId) && d.type(action.variableId) === 'VARIABLE' ? action.variableId : null;
          if (!variable) break;
          const result = this.evaluate(action.expression, node);
          if ('error' in result) {
            effects.push({ type: 'error', message: `${d.get(variable, 'name')}: ${result.error.message}` });
            break;
          }
          const value = coerce(d, variable, result.value);
          const mode = variableMode(d, variable, node ?? this.current);
          if (value === null || !mode) {
            effects.push({ type: 'error', message: tr('{0}: значение «{1}» не подходит переменной', d.get(variable, 'name'), formatValue(result.value)) });
            break;
          }
          this.writeVariable(variable, mode, value);
          effects.push({ type: 'variable', variable, value });
          break;
        }
        case 'CONDITIONAL': {
          if (depth >= MAX_CONDITION_DEPTH) {
            effects.push({ type: 'error', message: tr('Условия вложены глубже {0} уровней', MAX_CONDITION_DEPTH) });
            break;
          }
          for (const branch of action.branches) {
            if (branch.condition !== null) {
              const result = this.evaluate(branch.condition, node);
              if ('error' in result) {
                effects.push({ type: 'error', message: tr('Условие: {0}', result.error.message) });
                continue;
              }
              if (result.value !== true) {
                if (typeof result.value !== 'boolean') effects.push({ type: 'error', message: tr('Условие должно давать «истина» или «ложь», а даёт «{0}»', formatValue(result.value)) });
                continue;
              }
            }
            effects.push(...this.run(branch.actions, node, depth + 1));
            break;
          }
          break;
        }
        case 'NAVIGATE': {
          const to = action.destinationId;
          if (!to || !isScreen(d, to)) break;
          // Navigating from an overlay changes the screen under it and closes the overlays.
          this.overlays = [];
          if (to !== this.current) this.history.push({ screen: this.current, transition: action.transition });
          effects.push({ type: 'navigate', from: this.current, to, transition: action.transition, back: false, preserveScroll: !!action.preserveScroll });
          this.current = to;
          break;
        }
        case 'BACK': {
          const overlay = this.overlays.pop();
          if (overlay) {
            effects.push({ type: 'overlay-close', screen: overlay.screen, transition: reverseTransition(overlay.transition) });
            break;
          }
          const entry = this.history.pop();
          if (!entry || !d.store.isAlive(entry.screen)) break;
          effects.push({ type: 'navigate', from: this.current, to: entry.screen, transition: reverseTransition(entry.transition), back: true, preserveScroll: true });
          this.current = entry.screen;
          break;
        }
        case 'URL': {
          const url = safeUrl(action.url);
          if (url) effects.push({ type: 'url', url, newTab: action.newTab });
          break;
        }
        case 'OPEN_OVERLAY':
        case 'SWAP_OVERLAY': {
          const screen = action.destinationId;
          if (!screen || !isScreen(d, screen) || screen === this.current || this.overlays.some((o) => o.screen === screen)) break;
          const entry: OpenOverlay = { screen, settings: action.overlay, trigger: node, transition: action.transition };
          const top = this.overlays[this.overlays.length - 1];
          if (action.type === 'SWAP_OVERLAY' && top) {
            this.overlays[this.overlays.length - 1] = entry;
            effects.push({ type: 'overlay-swap', from: top.screen, screen, settings: action.overlay, trigger: node, transition: action.transition });
          } else {
            this.overlays.push(entry);
            effects.push({ type: 'overlay-open', screen, settings: action.overlay, trigger: node, transition: action.transition });
          }
          break;
        }
        case 'CLOSE_OVERLAY': {
          // Closes the overlay the layer is in (and any above it), else the top one.
          const own = node ? this.overlays.findIndex((o) => d.store.isAncestorOrSelf(o.screen, node)) : -1;
          const from = own >= 0 ? own : this.overlays.length - 1;
          if (from < 0) break;
          for (const o of this.overlays.splice(from).reverse()) effects.push({ type: 'overlay-close', screen: o.screen, transition: reverseTransition(o.transition) });
          break;
        }
        case 'SCROLL_TO': {
          const target = action.destinationId;
          if (!target || !d.store.isAlive(target)) break;
          effects.push({ type: 'scroll', target, offset: action.offset, transition: action.transition });
          break;
        }
        case 'CHANGE_TO': {
          // The instance showing a variant switches to another variant of the same set.
          const variant = action.destinationId;
          const instance = node ? nearestInstance(d, node) : null;
          if (!instance || !variant || !d.store.isAlive(variant) || d.type(variant) !== 'COMPONENT') break;
          if (d.get(instance, 'mainComponent') === variant) break;
          effects.push({ type: 'change', instance, variant, transition: action.transition });
          break;
        }
      }
    }
    return effects;
  }

  /** Jumps to a screen (flow list, arrow keys): a plain move that "Back" can undo. */
  goTo(to: NodeId): Effect | null {
    if (!isScreen(this.doc, to) || to === this.current) return null;
    const from = this.current;
    this.history.push({ screen: from, transition: null });
    this.overlays = [];
    this.current = to;
    return { type: 'navigate', from, to, transition: null, back: false, preserveScroll: false };
  }

  back(): Effect | null {
    const effects = this.run([{ type: 'BACK' }]);
    return effects[0] ?? null;
  }
}

/** The instance a layer belongs to, nearest first (the layer itself if it is one). */
function nearestInstance(doc: Document, id: NodeId): NodeId | null {
  let current: NodeId | null = id;
  while (current !== null) {
    if (doc.type(current) === 'INSTANCE') return current;
    if (isScreen(doc, current)) return null;
    current = doc.parent(current);
  }
  return null;
}

/** Variants an interaction on `node` can switch to (FR-PRT-010 "Change to"): the other variants of its set. */
export function variantChoices(doc: Document, node: NodeId): NodeId[] {
  let main: NodeId | null = null;
  if (doc.type(node) === 'COMPONENT') main = node;
  else {
    const inst = nearestInstance(doc, node);
    if (inst) main = doc.get(inst, 'mainComponent');
  }
  if (!main || !doc.store.isAlive(main)) return [];
  const set = doc.parent(main);
  if (!set || doc.type(set) !== 'COMPONENT_SET') return [];
  return doc.children(set).filter((v) => doc.type(v) === 'COMPONENT');
}

function keyMatches(expected: string | undefined, actual: string | undefined): boolean {
  return !!expected && !!actual && expected.toLowerCase() === actual.toLowerCase();
}

/**
 * Only web and mail links open from a prototype: a link in a shared file must
 * not run script (javascript:) or reach local files.
 */
export function safeUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export const TRIGGER_LABELS: Record<TriggerType, string> = {
  ON_CLICK: tr('По нажатию'),
  ON_HOVER: tr('Пока наведено'),
  ON_PRESS: tr('Пока зажато'),
  MOUSE_ENTER: tr('При наведении'),
  MOUSE_LEAVE: tr('Когда курсор уходит'),
  AFTER_TIMEOUT: tr('Через время'),
  ON_KEY: tr('По клавише'),
};

export const ACTION_LABELS: Record<PrototypeAction['type'], string> = {
  NAVIGATE: tr('Перейти к'),
  BACK: tr('Назад'),
  SCROLL_TO: tr('Прокрутить к'),
  URL: tr('Открыть ссылку'),
  OPEN_OVERLAY: tr('Открыть оверлей'),
  SWAP_OVERLAY: tr('Заменить оверлей'),
  CLOSE_OVERLAY: tr('Закрыть оверлей'),
  CHANGE_TO: tr('Изменить на'),
  SET_VARIABLE: tr('Установить переменную'),
  CONDITIONAL: tr('Условие'),
};
