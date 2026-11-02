// The board's tools on the canvas (FEAT-083): sticky, shape, connector,
// marker, highlighter, eraser and stamp; the "+" handles that continue a
// diagram; connector ends that are dragged to other layers. The canvas view
// hands the pointer here first and draws this overlay over its own.

import { tr, type BoardRole, type ConnectorEnd, type NodeId } from '#core';
import { bendPoint, connectorMiddle, connectorPath, connectorRoute, obstaclesOf, resolveEnds, roleOf, sidePoint, worldBox } from '#components';
import type { Point, Rect } from '#geometry';
import {
  addNeighbour,
  boardObjectOf,
  createConnector,
  createMarkerStroke,
  createShape,
  createSticky,
  editableTextOf,
  isBoard,
  isConnector,
  eraseStrokes,
  addVote,
  removeVote,
  votable,
  votesOf,
  placeStamp,
  shapeSize,
  STICKY_COLORS,
  createTape,
  TAPE_WIDTH,
} from './board.ts';
import type { Editor, EditorGesture } from './editor.ts';
import { contentsHidden, hiddenLabel, lockedHolder } from './board-actions.ts';

const ACCENT = '#4F5BD5';
type Side = 'TOP' | 'RIGHT' | 'BOTTOM' | 'LEFT';
const SIDES: Side[] = ['TOP', 'RIGHT', 'BOTTOM', 'LEFT'];
/** Distance of a "+" handle from the object's edge, and its radius (screen px). */
const PLUS_OFFSET = 26;
const PLUS_RADIUS = 10;
const END_RADIUS = 6;
/** Half the size of the bend handle in the middle of a selected connector (screen px). */
const BEND_SIZE = 6;

type Drag =
  | { kind: 'shape'; start: Point; to: Point }
  | { kind: 'connector'; start: ConnectorEnd; to: Point; target: NodeId | null }
  | { kind: 'marker'; points: Point[]; highlighter: boolean }
  | { kind: 'tape'; start: Point; to: Point }
  | { kind: 'erase'; gesture: EditorGesture; at: Point }
  | { kind: 'end'; connector: NodeId; which: 'start' | 'end'; gesture: EditorGesture; target: NodeId | null }
  | { kind: 'bend'; connector: NodeId; gesture: EditorGesture; screen: Point; moved: boolean }
  | { kind: 'plus'; source: NodeId; dir: Side; screen: Point; to: Point; target: NodeId | null; moved: boolean };

export interface BoardHost {
  request(): void;
  focus(): void;
}

export class BoardView {
  private readonly editor: Editor;
  private readonly host: BoardHost;
  private drag: Drag | null = null;
  /** The object whose "+" handles are shown (hovered or selected sticky or shape). */
  private plusFor: NodeId | null = null;
  private pointer: Point | null = null;
  /** Runs before a sticky is put (the app asks a guest how to sign stickies, once). */
  beforeSticky: (() => Promise<void>) | null = null;

  constructor(editor: Editor, host: BoardHost) {
    this.editor = editor;
    this.host = host;
  }

  get active(): boolean {
    return this.drag !== null;
  }

  private screen(p: Point): Point {
    return this.editor.viewport.worldToScreen(p);
  }

  /** The object a connector end would attach to at a point (not connectors, labels or marker strokes). */
  private attachTarget(world: Point, exclude: NodeId | null = null): NodeId | null {
    const editor = this.editor;
    const d = editor.doc;
    for (const hit of editor.pickable(editor.scene.hitTest(world, { tolerance: 4 / editor.viewport.zoom }))) {
      const target = boardObjectOf(d, hit) ?? editor.selectableFor(hit, false);
      const kind = roleOf(d, target)?.kind;
      if (target === exclude || kind === 'CONNECTOR' || kind === 'CONNECTOR_LABEL' || kind === 'MARKER') continue;
      if (d.type(target) === 'SECTION') continue;
      return target;
    }
    return null;
  }

  private endAt(world: Point, exclude: NodeId | null = null): ConnectorEnd {
    const node = this.attachTarget(world, exclude);
    return { node, side: node ? this.sideAt(node, world) : 'AUTO', x: world.x, y: world.y };
  }

  /**
   * The side of an object an end is dropped at: near an edge — that side
   * (its dot is shown), in the middle — whichever faces the other end.
   */
  private sideAt(id: NodeId, world: Point): ConnectorEnd['side'] {
    const b = worldBox(this.editor.doc, id);
    const nx = (world.x - (b.x + b.width / 2)) / Math.max(1e-6, b.width / 2);
    const ny = (world.y - (b.y + b.height / 2)) / Math.max(1e-6, b.height / 2);
    if (Math.abs(nx) < 0.45 && Math.abs(ny) < 0.45) return 'AUTO';
    return Math.abs(nx) > Math.abs(ny) ? (nx > 0 ? 'RIGHT' : 'LEFT') : ny > 0 ? 'BOTTOM' : 'TOP';
  }

  // ---------- "+" handles ----------

  private plusPoints(id: NodeId): { dir: Side; p: Point }[] {
    const b = worldBox(this.editor.doc, id);
    const tl = this.screen({ x: b.x, y: b.y });
    const br = this.screen({ x: b.x + b.width, y: b.y + b.height });
    const box: Rect = { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y };
    return SIDES.map((dir) => {
      const p = sidePoint(box, dir);
      const n = dir === 'TOP' ? { x: 0, y: -1 } : dir === 'RIGHT' ? { x: 1, y: 0 } : dir === 'BOTTOM' ? { x: 0, y: 1 } : { x: -1, y: 0 };
      return { dir, p: { x: p.x + n.x * PLUS_OFFSET, y: p.y + n.y * PLUS_OFFSET } };
    });
  }

  private plusAt(screen: Point): { id: NodeId; dir: Side } | null {
    const id = this.plusFor;
    if (!id || !this.editor.doc.store.isAlive(id)) return null;
    for (const { dir, p } of this.plusPoints(id)) if (Math.hypot(p.x - screen.x, p.y - screen.y) <= PLUS_RADIUS + 3) return { id, dir };
    return null;
  }

  /** Which object shows "+" handles: the one selected alone, else the hovered one. */
  private updatePlus(world: Point | null): void {
    const editor = this.editor;
    const d = editor.doc;
    let next: NodeId | null = null;
    const usable = (id: NodeId | null) => !!id && ['STICKY', 'SHAPE'].includes(roleOf(d, id)?.kind ?? '') && editor.canTransform(id);
    if (editor.tool === 'select' && !editor.editingText && !d.readOnly && editor.viewport.zoom >= 0.2) {
      const only = editor.selection.length === 1 ? editor.selection[0]! : null;
      if (usable(only)) next = only;
      else if (world) {
        const hit = editor.pickable(editor.scene.hitTest(world))[0];
        const object = hit ? boardObjectOf(d, hit) : null;
        if (usable(object)) next = object;
      }
      // Keep the handles of the last object while the pointer travels to them.
      if (!next && this.plusFor && this.pointer && this.plusAt(this.screen(this.pointer))) next = this.plusFor;
    }
    if (next !== this.plusFor) {
      this.plusFor = next;
      this.host.request();
    }
  }

  // ---------- connector ends ----------

  private selectedConnector(): NodeId | null {
    const sel = this.editor.selection;
    return sel.length === 1 && isConnector(this.editor.doc, sel[0]!) ? sel[0]! : null;
  }

  private endHandleAt(screen: Point): { id: NodeId; which: 'start' | 'end' } | null {
    const id = this.selectedConnector();
    if (!id || this.editor.doc.readOnly || lockedHolder(this.editor, id)) return null;
    const role = this.editor.doc.get(id, 'board') as Extract<BoardRole, { kind: 'CONNECTOR' }>;
    for (const which of ['end', 'start'] as const) {
      const p = this.screen({ x: role[which].x, y: role[which].y });
      if (Math.hypot(p.x - screen.x, p.y - screen.y) <= END_RADIUS + 4) return { id, which };
    }
    return null;
  }

  /** Where the bend handle of a connector is: the point it is bent through, else the middle of its line (page coordinates). */
  private bendAt(id: NodeId): Point {
    const d = this.editor.doc;
    const role = d.get(id, 'board') as Extract<BoardRole, { kind: 'CONNECTOR' }>;
    const page = d.pageOf(id);
    const [a, b] = resolveEnds(d, role.start, role.end, page);
    return bendPoint(a, b, role.bend) ?? connectorMiddle(connectorRoute(a, b, role, () => obstaclesOf(d, page)));
  }

  private bendHandleAt(screen: Point): NodeId | null {
    const id = this.selectedConnector();
    if (!id || this.editor.doc.readOnly || lockedHolder(this.editor, id)) return null;
    const p = this.screen(this.bendAt(id));
    return Math.abs(p.x - screen.x) <= BEND_SIZE + 4 && Math.abs(p.y - screen.y) <= BEND_SIZE + 4 ? id : null;
  }

  // ---------- pointer ----------

  /** Hover with no button pressed: true when the pointer is over a board handle (the canvas leaves the cursor alone). */
  hover(world: Point, screen: Point): string | null {
    this.pointer = world;
    if (this.editor.tool === 'eraser') {
      this.host.request();
      return 'crosshair';
    }
    this.updatePlus(world);
    if (this.plusAt(screen)) return 'pointer';
    if (this.endHandleAt(screen) || this.bendHandleAt(screen)) return 'move';
    return null;
  }

  /** A press on the canvas: true when the board takes it. */
  pointerDown(world: Point, screen: Point, alt = false, shift = false): boolean {
    const editor = this.editor;
    this.pointer = world;
    if (editor.doc.readOnly) return false;
    switch (editor.tool) {
      case 'select': {
        const end = this.endHandleAt(screen);
        if (end) {
          this.drag = { kind: 'end', connector: end.id, which: end.which, gesture: editor.beginGesture(tr('Конец связи')), target: null };
          return true;
        }
        const bent = this.bendHandleAt(screen);
        if (bent) {
          this.drag = { kind: 'bend', connector: bent, gesture: editor.beginGesture(tr('Изгиб связи')), screen, moved: false };
          return true;
        }
        // A vote is on: a click on a sticky or a shape votes (Alt — takes a vote back).
        const voting = editor.doc.get(editor.doc.rootId, 'boardVoting');
        if (voting?.open) {
          const hit = editor.pickable(editor.scene.hitTest(world))[0];
          const object = hit ? boardObjectOf(editor.doc, hit) : null;
          if (object && votable(editor.doc, object)) {
            if (alt) removeVote(editor, object);
            else if (!addVote(editor, object)) editor.toast(tr('Голоса закончились. Alt+щелчок по стикеру забирает голос назад.'));
            this.host.request();
            return true;
          }
        }
        const plus = this.plusAt(screen);
        if (plus) {
          this.drag = { kind: 'plus', source: plus.id, dir: plus.dir, screen, to: world, target: null, moved: false };
          return true;
        }
        return false;
      }
      case 'sticky': {
        const put = () => {
          const id = createSticky(editor, world);
          editor.setTool('select');
          this.editText(id);
        };
        if (this.beforeSticky) void this.beforeSticky().then(put);
        else put();
        return true;
      }
      case 'stamp': {
        // One stamp, then back to selecting (else the next click on the sticky stamps it again
        // instead of picking it — BUG-074). Shift keeps the tool for several stamps.
        const id = placeStamp(editor, world);
        if (!shift) editor.setTool('select');
        editor.setSelection([id]);
        return true;
      }
      case 'shape':
        this.drag = { kind: 'shape', start: world, to: world };
        return true;
      case 'connector':
        this.drag = { kind: 'connector', start: this.endAt(world), to: world, target: null };
        return true;
      case 'marker':
      case 'highlighter':
        this.drag = { kind: 'marker', points: [world], highlighter: editor.tool === 'highlighter' };
        return true;
      case 'tape':
        this.drag = { kind: 'tape', start: world, to: world };
        return true;
      case 'eraser': {
        this.drag = { kind: 'erase', gesture: editor.beginGesture(tr('Ластик')), at: world };
        this.erase(world);
        return true;
      }
      default:
        return false;
    }
  }

  pointerMove(world: Point, screen: Point, shift: boolean): void {
    const drag = this.drag;
    this.pointer = world;
    if (!drag) return;
    switch (drag.kind) {
      case 'shape':
        drag.to = shift ? square(drag.start, world) : world;
        break;
      case 'connector':
        drag.to = world;
        drag.target = this.attachTarget(world, drag.start.node);
        break;
      case 'tape':
        drag.to = world;
        break;
      case 'marker': {
        const last = drag.points[drag.points.length - 1]!;
        if (Math.hypot(world.x - last.x, world.y - last.y) * this.editor.viewport.zoom >= 1.5) drag.points.push(world);
        break;
      }
      case 'erase': {
        const from = drag.at;
        drag.at = world;
        this.erase(world, from);
        break;
      }
      case 'end': {
        const role = this.editor.doc.get(drag.connector, 'board') as Extract<BoardRole, { kind: 'CONNECTOR' }>;
        const end = this.endAt(world, drag.connector);
        drag.target = end.node;
        drag.gesture.update((tx) => tx.set(drag.connector, 'board', { ...role, [drag.which]: end }));
        break;
      }
      case 'bend': {
        if (!drag.moved && Math.hypot(screen.x - drag.screen.x, screen.y - drag.screen.y) <= 3) break;
        drag.moved = true;
        const d = this.editor.doc;
        const role = d.get(drag.connector, 'board') as Extract<BoardRole, { kind: 'CONNECTOR' }>;
        const [a, b] = resolveEnds(d, role.start, role.end, d.pageOf(drag.connector));
        const bend = { x: Math.round(world.x - (a.point.x + b.point.x) / 2), y: Math.round(world.y - (a.point.y + b.point.y) / 2) };
        drag.gesture.update((tx) => tx.set(drag.connector, 'board', { ...role, bend }));
        break;
      }
      case 'plus':
        drag.to = world;
        if (Math.hypot(screen.x - drag.screen.x, screen.y - drag.screen.y) > 4) drag.moved = true;
        drag.target = drag.moved ? this.attachTarget(world, drag.source) : null;
        break;
    }
    this.host.request();
  }

  pointerUp(world: Point, screen: Point): void {
    const drag = this.drag;
    this.drag = null;
    const editor = this.editor;
    if (!drag) return;
    switch (drag.kind) {
      case 'shape': {
        const a = this.screen(drag.start);
        const b = this.screen(drag.to);
        const tiny = Math.abs(a.x - b.x) < 4 && Math.abs(a.y - b.y) < 4;
        const size = shapeSize(editor.boardPrefs.shape);
        const box = tiny
          ? { x: drag.start.x - size.width / 2, y: drag.start.y - size.height / 2, ...size }
          : { x: Math.min(drag.start.x, drag.to.x), y: Math.min(drag.start.y, drag.to.y), width: Math.abs(drag.to.x - drag.start.x), height: Math.abs(drag.to.y - drag.start.y) };
        const id = createShape(editor, box);
        editor.setTool('select');
        this.editText(id);
        break;
      }
      case 'connector': {
        const a = this.screen({ x: drag.start.x, y: drag.start.y });
        if (Math.hypot(a.x - screen.x, a.y - screen.y) < 6 && !drag.target) break;
        const id = createConnector(editor, drag.start, this.endAt(world, drag.start.node));
        editor.setTool('select');
        editor.setSelection([id]);
        break;
      }
      case 'tape': {
        // The tool stays on: tape usually goes on several things in a row.
        const id = createTape(editor, drag.start, drag.to);
        editor.setSelection([id]);
        break;
      }
      case 'marker': {
        const points = drag.points.length === 1 ? [drag.points[0]!, { x: drag.points[0]!.x + 0.5, y: drag.points[0]!.y + 0.5 }] : drag.points;
        createMarkerStroke(editor, points, drag.highlighter);
        break;
      }
      case 'erase':
        drag.gesture.commit();
        break;
      case 'end':
        drag.gesture.commit();
        break;
      case 'bend':
        // A click without moving changes nothing (a double click there types the label, as anywhere on the line).
        if (drag.moved) drag.gesture.commit();
        else drag.gesture.cancel();
        break;
      case 'plus': {
        if (!drag.moved) {
          const next = addNeighbour(editor, drag.source, drag.dir);
          if (next) this.editText(next);
          break;
        }
        const d = editor.doc;
        const role = roleOf(d, drag.source);
        let end: ConnectorEnd = { node: drag.target, side: drag.target ? this.sideAt(drag.target, world) : 'AUTO', x: world.x, y: world.y };
        if (!drag.target && role?.kind === 'SHAPE') {
          // Dropped on empty canvas: the same shape there, connected.
          const box = worldBox(d, drag.source);
          const next = createShape(editor, { x: world.x - box.width / 2, y: world.y - box.height / 2, width: box.width, height: box.height }, role.shape, outlineHex(editor, drag.source));
          end = { node: next, side: 'AUTO', x: world.x, y: world.y };
        }
        const id = createConnector(editor, { node: drag.source, side: drag.dir, x: 0, y: 0 }, end);
        editor.setSelection([end.node ?? id]);
        break;
      }
    }
    this.host.request();
  }

  cancel(): boolean {
    const drag = this.drag;
    if (!drag) return false;
    if (drag.kind === 'erase' || drag.kind === 'end' || drag.kind === 'bend') drag.gesture.cancel();
    this.drag = null;
    this.host.request();
    return true;
  }

  private erase(world: Point, from: Point = world): void {
    const drag = this.drag;
    if (drag?.kind !== 'erase') return;
    const radius = this.editor.boardPrefs.eraserSize / this.editor.viewport.zoom;
    drag.gesture.update((tx) => {
      eraseStrokes(this.editor, tx, world, radius, from);
    });
  }

  /** Selects an object and starts typing into its text. */
  editText(id: NodeId): void {
    const text = editableTextOf(this.editor, id);
    if (text) this.editor.startTextEditing(text);
    else this.editor.setSelection([id]);
  }

  // ---------- overlay ----------

  draw(ctx: CanvasRenderingContext2D): void {
    const editor = this.editor;
    const d = editor.doc;
    const zoom = editor.viewport.zoom;
    ctx.save();
    // Selected connectors: the line itself, and its ends.
    const selected = editor.selection.filter((id) => isConnector(d, id));
    for (const id of selected) {
      const role = d.get(id, 'board') as Extract<BoardRole, { kind: 'CONNECTOR' }>;
      const [a, b] = resolveEnds(d, role.start, role.end, d.pageOf(id));
      this.strokeRoute(ctx, connectorRoute(a, b, role, () => obstaclesOf(d, d.pageOf(id))), ACCENT, 1.5);
      if (selected.length === 1 && !d.readOnly && !lockedHolder(editor, id)) {
        // The bend handle: drag it to lead the line (around an object or through it); filled when the line is bent.
        const m = this.screen(this.bendAt(id));
        ctx.beginPath();
        ctx.moveTo(m.x, m.y - BEND_SIZE);
        ctx.lineTo(m.x + BEND_SIZE, m.y);
        ctx.lineTo(m.x, m.y + BEND_SIZE);
        ctx.lineTo(m.x - BEND_SIZE, m.y);
        ctx.closePath();
        ctx.fillStyle = role.bend ? ACCENT : '#FFFFFF';
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 2;
        ctx.fill();
        ctx.stroke();
      }
      if (selected.length === 1 && !d.readOnly) {
        for (const end of [role.start, role.end]) {
          const p = this.screen({ x: end.x, y: end.y });
          ctx.beginPath();
          ctx.arc(p.x, p.y, END_RADIUS, 0, Math.PI * 2);
          ctx.fillStyle = end.node ? ACCENT : '#FFFFFF';
          ctx.strokeStyle = ACCENT;
          ctx.lineWidth = 2;
          ctx.fill();
          ctx.stroke();
        }
      }
    }
    const drag = this.drag;
    const outline = (id: NodeId | null) => {
      if (!id || !d.store.isAlive(id)) return;
      const b = worldBox(d, id);
      const p = this.screen({ x: b.x, y: b.y });
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2;
      ctx.strokeRect(p.x, p.y, b.width * zoom, b.height * zoom);
    };
    // The object an end would hold: its outline and the four side dots, the one it would take filled.
    const anchors = (id: NodeId | null, at: Point) => {
      if (!id || !d.store.isAlive(id)) return;
      outline(id);
      const b = worldBox(d, id);
      const tl = this.screen({ x: b.x, y: b.y });
      const box: Rect = { x: tl.x, y: tl.y, width: b.width * zoom, height: b.height * zoom };
      const chosen = this.sideAt(id, at);
      for (const side of SIDES) {
        const p = sidePoint(box, side);
        ctx.beginPath();
        ctx.arc(p.x, p.y, side === chosen ? 6 : 4.5, 0, Math.PI * 2);
        ctx.fillStyle = side === chosen ? ACCENT : '#FFFFFF';
        ctx.fill();
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    };
    if (drag?.kind === 'connector' || drag?.kind === 'plus') anchors(drag.target, drag.to);
    if (drag?.kind === 'end' && drag.target && this.pointer) anchors(drag.target, this.pointer);
    if (drag?.kind === 'connector' || (drag?.kind === 'plus' && drag.moved)) {
      const start: ConnectorEnd = drag.kind === 'connector' ? drag.start : { node: drag.source, side: drag.dir, x: 0, y: 0 };
      const end: ConnectorEnd = { node: drag.target, side: drag.target ? this.sideAt(drag.target, drag.to) : 'AUTO', x: drag.to.x, y: drag.to.y };
      const [a, b] = resolveEnds(d, start, end, editor.pageId);
      this.strokeRoute(ctx, connectorPath(a, b, editor.boardPrefs.route, editor.boardPrefs.route === 'ELBOW' ? obstaclesOf(d, editor.pageId) : []), ACCENT, 2);
    }
    if (drag?.kind === 'shape') {
      const a = this.screen(drag.start);
      const b = this.screen(drag.to);
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.setLineDash([]);
    }
    if (drag?.kind === 'tape' && Math.hypot(drag.to.x - drag.start.x, drag.to.y - drag.start.y) * zoom > 4) {
      // The strip as it will lie: from where the drag began to the pointer.
      const a = this.screen(drag.start);
      const b = this.screen(drag.to);
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      ctx.save();
      ctx.translate(a.x, a.y);
      ctx.rotate(angle);
      ctx.globalAlpha = 0.78;
      ctx.fillStyle = editor.boardPrefs.tapeColor;
      ctx.fillRect(0, (-TAPE_WIDTH / 2) * zoom, Math.hypot(b.x - a.x, b.y - a.y), TAPE_WIDTH * zoom);
      ctx.restore();
    }
    if (drag?.kind === 'marker' && drag.points.length > 0) {
      const ink = drag.highlighter ? editor.boardPrefs.highlightInk : editor.boardPrefs.ink;
      ctx.globalAlpha = drag.highlighter ? 0.4 : 1;
      ctx.strokeStyle = ink;
      ctx.lineWidth = (drag.highlighter ? editor.boardPrefs.highlighterSize : editor.boardPrefs.markerSize) * zoom;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      drag.points.forEach((q, i) => {
        const p = this.screen(q);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (editor.tool === 'eraser' && this.pointer) {
      const p = this.screen(this.pointer);
      ctx.beginPath();
      ctx.arc(p.x, p.y, editor.boardPrefs.eraserSize, 0, Math.PI * 2);
      ctx.strokeStyle = '#8A8A8A';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    // Votes: one's own while the vote is on (the others stay hidden), everyone's counts once it is over.
    const voting = d.get(d.rootId, 'boardVoting');
    if (voting) {
      for (const [id, n] of votesOf(d, voting.id, editor.boardPrefs.voter)) {
        if (!d.store.isAlive(id) || d.pageOf(id) !== editor.pageId) continue;
        const count = voting.open ? n.mine : n.total;
        if (count === 0) continue;
        const b = worldBox(d, id);
        const p = this.screen({ x: b.x + b.width, y: b.y });
        const r = 13;
        ctx.beginPath();
        ctx.arc(p.x - 4, p.y + 4, r, 0, Math.PI * 2);
        ctx.fillStyle = voting.open ? ACCENT : '#E5484D';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#FFFFFF';
        ctx.stroke();
        ctx.fillStyle = '#FFFFFF';
        ctx.font = '600 13px system-ui, -apple-system, "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(count), p.x - 4, p.y + 4.5);
        ctx.textAlign = 'start';
      }
    }
    // Sections with their content hidden say so (an empty-looking section is not empty).
    for (const id of d.children(editor.pageId)) {
      if (d.type(id) !== 'SECTION' || !d.get(id, 'visible') || !contentsHidden(editor, id)) continue;
      const b = worldBox(d, id);
      const c = this.screen({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
      if (b.width * zoom < 80 || b.height * zoom < 40) continue;
      ctx.font = '500 13px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.fillText(hiddenLabel(editor, id), c.x, c.y);
      ctx.textAlign = 'start';
    }
    // Locked objects in the selection: a lock at the corner (they do not move, so there are no handles to drag).
    for (const id of editor.selection) {
      if (!d.store.isAlive(id) || !lockedHolder(editor, id)) continue;
      const b = worldBox(d, id);
      const p = this.screen({ x: b.x + b.width, y: b.y });
      ctx.beginPath();
      ctx.roundRect(p.x - 10, p.y - 10, 20, 20, 6);
      ctx.fillStyle = ACCENT;
      ctx.fill();
      // A padlock: shackle and body.
      ctx.strokeStyle = '#FFFFFF';
      ctx.fillStyle = '#FFFFFF';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y - 2, 3, Math.PI, 0);
      ctx.stroke();
      ctx.fillRect(p.x - 4.5, p.y - 1.5, 9, 6.5);
    }
    // "+" handles.
    if (this.plusFor && !drag && d.store.isAlive(this.plusFor) && editor.tool === 'select' && !editor.editingText) {
      for (const { p } of this.plusPoints(this.plusFor)) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, PLUS_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = '#FFFFFF';
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1.5;
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(p.x - 4, p.y);
        ctx.lineTo(p.x + 4, p.y);
        ctx.moveTo(p.x, p.y - 4);
        ctx.lineTo(p.x, p.y + 4);
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private strokeRoute(ctx: CanvasRenderingContext2D, points: ReturnType<typeof connectorPath>, color: string, width: number): void {
    if (points.length < 2) return;
    ctx.beginPath();
    const p0 = this.screen(points[0]!);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1]!;
      const q = points[i]!;
      const p = this.screen(q);
      if (prev.out || q.in) {
        const c1 = this.screen(prev.out ?? prev);
        const c2 = this.screen(q.in ?? q);
        ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p.x, p.y);
      } else ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  /** Dots of a board under the content: every 24 px, sparser when zoomed out. */
  static pattern(editor: Editor): (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, visible: Rect, zoom: number) => void {
    return (ctx, visible, zoom) => {
      if (!isBoard(editor.doc)) return;
      let step = 24;
      while (step * zoom < 12) step *= 5;
      if (step > 3000) return;
      const r = Math.max(0.6, Math.min(1.4, 1.1 * Math.sqrt(zoom))) / zoom;
      const dark = typeof matchMedia === 'function' && document.documentElement.dataset.theme !== 'light' && (document.documentElement.dataset.theme === 'dark' || matchMedia('(prefers-color-scheme: dark)').matches);
      ctx.fillStyle = dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.17)';
      const x0 = Math.floor(visible.x / step) * step;
      const y0 = Math.floor(visible.y / step) * step;
      for (let y = y0; y <= visible.y + visible.height + step; y += step) {
        for (let x = x0; x <= visible.x + visible.width + step; x += step) ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
    };
  }
}

function square(a: Point, b: Point): Point {
  const s = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  return { x: a.x + Math.sign(b.x - a.x || 1) * s, y: a.y + Math.sign(b.y - a.y || 1) * s };
}

function outlineHex(editor: Editor, shape: NodeId): string {
  const d = editor.doc;
  const outline = d.children(shape).find((c) => roleOf(d, c)?.kind === 'SHAPE_OUTLINE');
  const fill = outline ? d.get(outline, 'fills')[0] : undefined;
  if (fill?.type !== 'SOLID') return editor.boardPrefs.shapeColor;
  const p = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${p(fill.color.r)}${p(fill.color.g)}${p(fill.color.b)}`.toUpperCase();
}

export { STICKY_COLORS };
