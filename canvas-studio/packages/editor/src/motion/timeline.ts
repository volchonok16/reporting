// The open timeline of a frame (Motion, stage 2): the playhead, playing, and the pose the canvas shows at the
// playhead. Opening it shows the frame at its moment; closing it shows the document again. Any change of the
// document (keyframes set, a layer moved, undo) shows the moment anew.

import type { MotionProp, NodeId, Transaction } from '#core';
import type { Editor } from '../editor.ts';
import { DEFAULT_MOTION, fullPose, motionFrameOf, moveKeyframe, removeKeyframe, setKeyframe, setKeyframeEase, setMotion, shownValue, timelineCandidate } from './model.ts';
import { randomId, tr, type AnimationStyle } from '#core';
import { allStyles, applyStyle, deleteStyle, renameStyle, saveStyle, styleFromLayer } from './styles.ts';

export class Timeline {
  /** The frame whose timeline is open. */
  frame: NodeId | null = null;
  /** The playhead, ms. */
  time = 0;
  playing = false;
  /** Auto keyframing (stage 2c): a change of a layer while the playhead stands records a keyframe. */
  autokey = false;
  private raf = 0;
  private started = 0;
  private startTime = 0;

  private readonly editor: Editor;

  constructor(editor: Editor) {
    this.editor = editor;
    editor.events.on('change', () => {
      if (!this.frame) return;
      if (!editor.doc.store.isAlive(this.frame) || !editor.doc.get(this.frame, 'motion')) return this.close();
      this.show();
    });
    editor.events.on('page', () => this.close());
  }

  get duration(): number {
    return (this.frame && this.editor.doc.get(this.frame, 'motion')?.duration) || DEFAULT_MOTION.duration;
  }

  /** Opens the timeline of the selected layer's frame, giving the frame one if it has none. */
  openForSelection(): boolean {
    const id = this.editor.selection[0];
    const frame = id ? timelineCandidate(this.editor.doc, id) : null;
    if (!frame) {
      this.editor.toast(tr('Выделите фрейм или слой в нём, и у фрейма появится таймлайн'));
      return false;
    }
    if (!this.editor.doc.get(frame, 'motion')) this.editor.commit(tr('Таймлайн фрейма'), (tx) => setMotion(this.editor.doc, tx, frame, DEFAULT_MOTION));
    this.open(frame);
    return true;
  }

  open(frame: NodeId): void {
    this.pause();
    this.frame = frame;
    this.time = Math.min(this.time, this.duration);
    this.show();
  }

  close(): void {
    this.pause();
    this.frame = null;
    this.editor.scene.setPose(null);
    this.emit();
  }

  seek(t: number): void {
    this.time = Math.max(0, Math.min(this.duration, t));
    this.show();
  }

  play(): void {
    if (!this.frame || this.playing) return;
    this.playing = true;
    if (this.time >= this.duration) this.time = 0;
    this.started = performance.now();
    this.startTime = this.time;
    const step = (now: number) => {
      if (!this.playing || !this.frame) return;
      const motion = this.editor.doc.get(this.frame, 'motion');
      let t = this.startTime + (now - this.started);
      if (t >= this.duration) {
        if (motion?.loop) {
          this.started = now;
          this.startTime = 0;
          t = 0;
        } else {
          this.time = this.duration;
          this.playing = false;
          this.show();
          return;
        }
      }
      this.time = t;
      this.show();
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
    this.emit();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.emit();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  // ---------- keyframes (each one undo step) ----------

  /** A keyframe of the value the layer shows now, at the playhead. */
  addKeyframe(id: NodeId, prop: MotionProp, value?: number): void {
    const v = value ?? shownValue(this.editor.doc, id, prop, this.time);
    this.editor.commit(tr('Ключевой кадр'), (tx) => setKeyframe(this.editor.doc, tx, id, prop, this.time, v));
  }

  removeKeyframe(id: NodeId, prop: MotionProp, t: number): void {
    this.editor.commit(tr('Убрать ключевой кадр'), (tx) => removeKeyframe(this.editor.doc, tx, id, prop, t));
  }

  moveKeyframe(id: NodeId, prop: MotionProp, from: number, to: number): void {
    this.editor.commit(tr('Сдвинуть ключевой кадр'), (tx) => moveKeyframe(this.editor.doc, tx, id, prop, from, Math.max(0, Math.min(this.duration, to))));
  }

  setEase(id: NodeId, prop: MotionProp, t: number, ease: { text?: string; variable?: string | null }): void {
    this.editor.commit(tr('Кривая ключевого кадра'), (tx) => setKeyframeEase(this.editor.doc, tx, id, prop, t, ease));
  }

  setSettings(settings: { duration?: number; loop?: boolean }): void {
    if (!this.frame) return;
    const frame = this.frame;
    const now = this.editor.doc.get(frame, 'motion') ?? DEFAULT_MOTION;
    this.editor.commit(tr('Таймлайн фрейма'), (tx) => setMotion(this.editor.doc, tx, frame, { ...now, ...settings }));
  }

  // ---------- animation styles (stage 3) ----------

  /** The selected layers of the open frame (not the frame itself). */
  layersForStyles(): NodeId[] {
    const d = this.editor.doc;
    return this.editor.selection.filter((id) => this.frame && id !== this.frame && d.store.isAlive(id) && motionFrameOf(d, id) === this.frame);
  }

  /** A style on the selected layers: at the playhead, or after each one's last keyframe. */
  applyStyle(styleId: string, after: boolean): boolean {
    const frame = this.frame;
    const style = allStyles(this.editor.doc).find((s) => s.id === styleId);
    const ids = this.layersForStyles();
    if (!frame || !style) return false;
    if (ids.length === 0) {
      this.editor.toast(tr('Выделите слой во фрейме, и стиль ляжет на него'));
      return false;
    }
    this.editor.commit(tr('Стиль анимации «{0}»', style.name), (tx) => applyStyle(this.editor.doc, tx, frame, ids, style, this.time, after));
    return true;
  }

  /** A style of the file's own from the selected layer's keyframes; its id, or null when it has fewer than two. */
  saveStyleFromSelection(name: string): string | null {
    const id = this.layersForStyles()[0];
    const style: AnimationStyle | null = id ? styleFromLayer(this.editor.doc, id, name.trim() || this.editor.doc.get(id, 'name'), `own:${randomId(8)}`) : null;
    if (!style) {
      this.editor.toast(tr('У выделенного слоя нужно хотя бы два ключевых кадра'));
      return null;
    }
    this.editor.commit(tr('Сохранить стиль анимации'), (tx) => saveStyle(this.editor.doc, tx, style));
    return style.id;
  }

  renameStyle(id: string, name: string): void {
    if (!name.trim()) return;
    this.editor.commit(tr('Переименовать стиль анимации'), (tx) => renameStyle(this.editor.doc, tx, id, name.trim()));
  }

  deleteStyle(id: string): void {
    this.editor.commit(tr('Удалить стиль анимации'), (tx) => deleteStyle(this.editor.doc, tx, id));
  }

  /** The frame loses its timeline and every keyframe in it. */
  removeTimeline(): void {
    if (!this.frame) return;
    const frame = this.frame;
    this.close();
    this.editor.commit(tr('Убрать таймлайн'), (tx) => setMotion(this.editor.doc, tx, frame, null));
  }

  /**
   * What a property panel shows for a layer: at the playhead while its frame's timeline is open and the property
   * has keyframes (a change there then records a keyframe), else the document's value.
   */
  shownProp(id: NodeId, key: string): number | null {
    if (!this.frame || !['x', 'y', 'rotation', 'opacity'].includes(key)) return null;
    const doc = this.editor.doc;
    if (id === this.frame || !doc.store.isAlive(id) || motionFrameOf(doc, id) !== this.frame) return null;
    if (!doc.get(id, 'keyframes')?.[key as MotionProp]?.length) return null;
    return shownValue(doc, id, key as MotionProp, this.time);
  }

  setAutokey(on: boolean): void {
    this.autokey = on;
    this.emit();
  }

  /**
   * A layer of the open frame moved, turned or faded by hand (stage 2c): the change becomes a keyframe at the
   * playhead, in the same undo step — always for a property that already has keyframes (else the canvas, which
   * shows the keyframes, would not follow), with auto keyframing on for any. A first keyframe away from the start
   * gets one at the start too, with the value before the change, so the motion is there at once. The frame itself
   * is not animated, only what is inside it. Called with the user's own changes, before anything else runs.
   */
  record(tx: Transaction): void {
    const frame = this.frame;
    if (!frame || this.playing) return;
    const doc = this.editor.doc;
    // Scale lives only on the timeline: a hand change is one of these.
    const todo: [NodeId, 'x' | 'y' | 'rotation' | 'opacity'][] = [];
    for (const [id, keys] of tx.changes.updated) {
      if (id === frame || !doc.store.isAlive(id) || motionFrameOf(doc, id) !== frame) continue;
      for (const prop of ['x', 'y', 'rotation', 'opacity'] as const) if (keys.has(prop)) todo.push([id, prop]);
    }
    for (const [id, prop] of todo) {
      const list = doc.get(id, 'keyframes')?.[prop];
      if (!list?.length && !this.autokey) continue;
      if (!list?.length && this.time > 0) {
        const step = tx.steps.find((s) => s.kind === 'set' && s.id === id && s.key === prop) as { before?: unknown } | undefined;
        if (typeof step?.before === 'number') setKeyframe(doc, tx, id, prop, 0, step.before);
      }
      setKeyframe(doc, tx, id, prop, this.time, doc.get(id, prop));
    }
  }

  /** The canvas shows the moment at the playhead. */
  private show(): void {
    if (!this.frame) return;
    const doc = this.editor.doc;
    const frame = this.frame;
    // Everything at the playhead: this frame's timeline, the animated components inside it on theirs, and — for a
    // component — its instances on the page, which play its timeline (stage 4).
    const played = () => this.time;
    const pose = fullPose(doc, frame, played);
    if (doc.type(frame) === 'COMPONENT') {
      doc.store.walk(this.editor.pageId, (id) => {
        if (doc.type(id) !== 'INSTANCE') return true;
        if (doc.get(id, 'mainComponent') === frame) fullPose(doc, id, played, pose, true);
        return true;
      });
    }
    this.editor.scene.setPose(pose);
    this.emit();
  }

  private emit(): void {
    this.editor.events.emit('motion', undefined);
  }
}
