// Editing prototypes (section 13): interactions on layers, flow entry points
// and the design/prototype mode of the right panel. Every change is one
// undoable step through Editor.commit.

import { tr } from '#core';
import type { FlowStart, NodeId, OverflowDirection, PrototypeAction, Reaction, ScrollBehavior, Trigger } from '#core';
import type { Editor } from '../editor.ts';
import { DEFAULT_OVERLAY, DEFAULT_TRANSITION, flows, isScreen, pageOf, screenOf, screens } from './model.ts';

/** Right panel tab: design, prototype, or code for developers (FR-DEV). */
export type PanelMode = 'design' | 'prototype' | 'code';

export class PrototypeController {
  private readonly editor: Editor;
  /** Right panel tab; in "prototype" the canvas shows connections and "+" handles (FR-PRT-001). */
  mode: PanelMode = 'design';

  constructor(editor: Editor) {
    this.editor = editor;
  }

  setMode(mode: PanelMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.editor.events.emit('mode', mode);
    this.editor.requestOverlay();
  }

  reactions(id: NodeId): Reaction[] {
    return this.editor.doc.get(id, 'reactions');
  }

  setReactions(id: NodeId, reactions: Reaction[], label = tr('Изменить взаимодействие')): void {
    this.editor.commit(label, (tx) => tx.set(id, 'reactions', reactions));
  }

  /** Whether `id` can have interactions: any scene layer except a section or a page. */
  canInteract(id: NodeId): boolean {
    const t = this.editor.doc.type(id);
    return t !== 'PAGE' && t !== 'SECTION' && t !== 'DOCUMENT' && t !== 'COMPONENT_SET';
  }

  /**
   * Connects a layer to a screen by click, as dragging the "+" handle does
   * (FR-PRT-001). An existing click-to-navigate on the layer is retargeted,
   * so dragging the handle again moves the arrow instead of adding a second one.
   */
  connect(source: NodeId, destination: NodeId): void {
    const d = this.editor.doc;
    if (!this.canInteract(source) || !isScreen(d, destination) || screenOf(d, source) === destination) return;
    const reactions = structuredClone(d.get(source, 'reactions'));
    const click = reactions.find((r) => r.trigger.type === 'ON_CLICK' && r.actions.some((a) => a.type === 'NAVIGATE'));
    if (click) {
      const action = click.actions.find((a) => a.type === 'NAVIGATE')!;
      if (action.type === 'NAVIGATE') action.destinationId = destination;
    } else {
      reactions.push({ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NAVIGATE', destinationId: destination, transition: { ...DEFAULT_TRANSITION } }] });
    }
    this.editor.commit(tr('Связать с экраном'), (tx) => {
      tx.set(source, 'reactions', reactions);
      // The first connection on a page with no flows starts one, as in Figma.
      const page = pageOf(d, source);
      const from = screenOf(d, source);
      if (page && from && flows(d, page).length === 0) {
        tx.set(page, 'flowStartingPoints', [{ nodeId: from, name: tr('Поток 1'), description: '' }]);
      }
    });
  }

  /** Removes one navigate action (the arrow); the interaction goes when it has no actions left. */
  disconnect(source: NodeId, reaction: number, action: number): void {
    if (action < 0) return;
    const reactions = structuredClone(this.reactions(source));
    const r = reactions[reaction];
    if (!r) return;
    r.actions.splice(action, 1);
    if (r.actions.length === 0) reactions.splice(reaction, 1);
    this.setReactions(source, reactions, tr('Удалить связь'));
  }

  addReaction(id: NodeId): void {
    const reactions = structuredClone(this.reactions(id));
    const used = new Set(reactions.map((r) => r.trigger.type));
    const trigger: Trigger = { type: used.has('ON_CLICK') && this.editor.doc.type(id) !== 'PAGE' ? (isScreen(this.editor.doc, id) ? 'AFTER_TIMEOUT' : 'MOUSE_ENTER') : 'ON_CLICK' };
    if (trigger.type === 'AFTER_TIMEOUT') trigger.timeout = 800;
    reactions.push({ trigger, actions: [{ type: 'NAVIGATE', destinationId: null, transition: { ...DEFAULT_TRANSITION } }] });
    this.setReactions(id, reactions, tr('Добавить взаимодействие'));
  }

  removeReaction(id: NodeId, index: number): void {
    const reactions = structuredClone(this.reactions(id));
    reactions.splice(index, 1);
    this.setReactions(id, reactions, tr('Удалить взаимодействие'));
  }

  updateReaction(id: NodeId, index: number, fn: (r: Reaction) => void, label?: string): void {
    const reactions = structuredClone(this.reactions(id));
    const r = reactions[index];
    if (!r) return;
    fn(r);
    this.setReactions(id, reactions, label);
  }

  /** A fresh action of a type, keeping what still applies (the destination when switching between kinds). */
  static makeAction(type: PrototypeAction['type'], previous?: PrototypeAction): PrototypeAction {
    const prevDest = previous && 'destinationId' in previous ? previous.destinationId : null;
    const prevTransition = previous && 'transition' in previous ? previous.transition : null;
    const screenDest = previous && (previous.type === 'NAVIGATE' || previous.type === 'OPEN_OVERLAY' || previous.type === 'SWAP_OVERLAY') ? prevDest : null;
    switch (type) {
      case 'NAVIGATE':
        return { type, destinationId: screenDest, transition: prevTransition ?? { ...DEFAULT_TRANSITION } };
      case 'OPEN_OVERLAY':
      case 'SWAP_OVERLAY':
        return { type, destinationId: screenDest, transition: prevTransition ?? { ...DEFAULT_TRANSITION }, overlay: previous && 'overlay' in previous ? previous.overlay : structuredClone(DEFAULT_OVERLAY) };
      case 'SCROLL_TO':
        return { type, destinationId: null, offset: { x: 0, y: 0 }, transition: { type: 'SMART_ANIMATE', duration: 300, easing: { type: 'EASE_OUT' } } };
      case 'CHANGE_TO':
        return { type, destinationId: null, transition: { type: 'SMART_ANIMATE', duration: 200, easing: { type: 'EASE_OUT' } } };
      case 'URL':
        return { type, url: previous?.type === 'URL' ? previous.url : '', newTab: true };
      case 'CLOSE_OVERLAY':
        return { type };
      case 'SET_VARIABLE':
        return { type, variableId: previous?.type === 'SET_VARIABLE' ? previous.variableId : null, expression: previous?.type === 'SET_VARIABLE' ? previous.expression : '' };
      case 'CONDITIONAL':
        return { type, branches: [{ condition: '', actions: [] }, { condition: null, actions: [] }] };
      default:
        return { type: 'BACK' };
    }
  }

  // ---------- scrolling (FR-PRT-030, 031) ----------

  setOverflow(ids: readonly NodeId[], value: OverflowDirection): void {
    this.editor.commit(tr('Прокрутка'), (tx) => ids.forEach((id) => tx.set(id, 'overflowDirection', value)));
  }

  setScrollBehavior(ids: readonly NodeId[], value: ScrollBehavior): void {
    this.editor.commit(tr('Поведение при прокрутке'), (tx) => ids.forEach((id) => tx.set(id, 'scrollBehavior', value)));
  }

  // ---------- flows (FR-PRT-002) ----------

  flows(pageId = this.editor.pageId): FlowStart[] {
    return flows(this.editor.doc, pageId);
  }

  isFlowStart(screen: NodeId): boolean {
    const page = pageOf(this.editor.doc, screen);
    return !!page && this.flows(page).some((f) => f.nodeId === screen);
  }

  addFlow(screen: NodeId): void {
    const d = this.editor.doc;
    const page = pageOf(d, screen);
    if (!page || !isScreen(d, screen) || this.isFlowStart(screen)) return;
    const list = this.flows(page);
    let n = list.length + 1;
    while (list.some((f) => f.name === tr('Поток {0}', n))) n++;
    this.editor.commit(tr('Начало потока'), (tx) => tx.set(page, 'flowStartingPoints', [...list, { nodeId: screen, name: tr('Поток {0}', n), description: '' }]));
  }

  removeFlow(screen: NodeId): void {
    const page = pageOf(this.editor.doc, screen);
    if (!page) return;
    this.editor.commit(tr('Убрать начало потока'), (tx) => tx.set(page, 'flowStartingPoints', this.flows(page).filter((f) => f.nodeId !== screen)));
  }

  updateFlow(screen: NodeId, patch: Partial<Pick<FlowStart, 'name' | 'description'>>): void {
    const page = pageOf(this.editor.doc, screen);
    if (!page) return;
    this.editor.commit(tr('Изменить поток'), (tx) => tx.set(page, 'flowStartingPoints', this.flows(page).map((f) => (f.nodeId === screen ? { ...f, ...patch } : f))));
  }

  /** Where presenting starts: the selected screen, else the first flow, else the first screen of the page. */
  startScreen(): NodeId | null {
    const d = this.editor.doc;
    const page = this.editor.pageId;
    const selected = this.editor.selection.map((id) => screenOf(d, id)).find((s): s is NodeId => s !== null);
    return selected ?? this.flows(page)[0]?.nodeId ?? screens(d, page)[0] ?? null;
  }
}
