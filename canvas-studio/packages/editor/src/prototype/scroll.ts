// Scrolling inside prototype screens (FR-PRT-030–032). A frame with an
// overflow direction scrolls its children; a child can scroll with it, stay
// fixed, or stick to the top/left edge once it reaches it. The viewer works on
// its private copy of the document, so scrolling simply moves the children
// there: rendering, hit-testing and smart animate then need no special case.
// The unscrolled ("base") position of every child is remembered so any scroll
// offset can be applied exactly, and nested containers hand a gesture to their
// parent once they reach an edge.

import { isFrameLike, type Document, type NodeId, type Vec } from '#core';

export class ScrollState {
  private readonly doc: Document;
  private readonly offsets = new Map<NodeId, Vec>();
  private readonly base = new Map<NodeId, Vec>();

  constructor(doc: Document) {
    this.doc = doc;
  }

  /** Whether a layer scrolls its content, and in which directions. */
  axes(id: NodeId): { x: boolean; y: boolean } {
    const d = this.doc;
    if (!d.store.isAlive(id) || !isFrameLike(d.type(id))) return { x: false, y: false };
    const o = d.get(id, 'overflowDirection');
    return { x: o === 'HORIZONTAL' || o === 'BOTH', y: o === 'VERTICAL' || o === 'BOTH' };
  }

  isContainer(id: NodeId): boolean {
    const a = this.axes(id);
    return a.x || a.y;
  }

  offset(id: NodeId): Vec {
    return this.offsets.get(id) ?? { x: 0, y: 0 };
  }

  /** Unscrolled position of a child of a container. */
  basePosition(child: NodeId): Vec {
    return this.base.get(child) ?? { x: this.doc.get(child, 'x'), y: this.doc.get(child, 'y') };
  }

  private remember(container: NodeId): void {
    for (const c of this.doc.children(container)) if (!this.base.has(c)) this.base.set(c, { x: this.doc.get(c, 'x'), y: this.doc.get(c, 'y') });
  }

  /** How far a container can scroll: its content (fixed layers excluded) beyond its own box. */
  limits(container: NodeId): Vec {
    const d = this.doc;
    let right = 0;
    let bottom = 0;
    for (const c of d.children(container)) {
      if (!d.get(c, 'visible') || d.get(c, 'scrollBehavior') === 'FIXED') continue;
      const p = this.basePosition(c);
      right = Math.max(right, p.x + d.get(c, 'width'));
      bottom = Math.max(bottom, p.y + d.get(c, 'height'));
    }
    // Auto layout frames keep their end padding below the last item.
    if (d.get(container, 'layoutMode') !== 'NONE') {
      right += d.get(container, 'paddingRight');
      bottom += d.get(container, 'paddingBottom');
    }
    const a = this.axes(container);
    return { x: a.x ? Math.max(0, right - d.get(container, 'width')) : 0, y: a.y ? Math.max(0, bottom - d.get(container, 'height')) : 0 };
  }

  /** Sets a container's scroll offset (clamped) and moves its children. Returns the offset applied. */
  set(container: NodeId, x: number, y: number): Vec {
    this.remember(container);
    const max = this.limits(container);
    const next = { x: Math.max(0, Math.min(max.x, x)), y: Math.max(0, Math.min(max.y, y)) };
    const prev = this.offset(container);
    if (prev.x === next.x && prev.y === next.y && this.offsets.has(container)) return next;
    this.offsets.set(container, next);
    this.write(container);
    return next;
  }

  private write(container: NodeId): void {
    const d = this.doc;
    const s = this.offset(container);
    d.transact(
      (tx) => {
        for (const c of d.children(container)) {
          const b = this.basePosition(c);
          const behaviour = d.get(c, 'scrollBehavior');
          let x = b.x - s.x;
          let y = b.y - s.y;
          if (behaviour === 'FIXED') {
            x = b.x;
            y = b.y;
          } else if (behaviour === 'STICKY') {
            // Scrolls until it reaches the container's top (left) edge, then stays there.
            x = b.x >= 0 ? Math.max(x, 0) : x;
            y = b.y >= 0 ? Math.max(y, 0) : y;
          }
          if (d.get(c, 'x') !== x || d.get(c, 'y') !== y) tx.update(c, { x, y });
        }
      },
      { undoable: false },
    );
  }

  /**
   * Scrolls by a delta, starting at the innermost container of `chain` and
   * handing what is left over to the outer ones (FR-PRT-030: nested scrolling).
   * Returns the part of the delta nobody could use.
   */
  scrollBy(chain: readonly NodeId[], dx: number, dy: number): Vec {
    let rx = dx;
    let ry = dy;
    for (const c of chain) {
      if (rx === 0 && ry === 0) break;
      const a = this.axes(c);
      if (!a.x && !a.y) continue;
      const before = this.offset(c);
      const after = this.set(c, before.x + (a.x ? rx : 0), before.y + (a.y ? ry : 0));
      if (a.x) rx -= after.x - before.x;
      if (a.y) ry -= after.y - before.y;
    }
    return { x: rx, y: ry };
  }

  /** Scroll containers from a layer up to (and including) its screen, innermost first. */
  chain(id: NodeId, screen: NodeId): NodeId[] {
    const out: NodeId[] = [];
    let current: NodeId | null = id;
    while (current !== null) {
      if (this.isContainer(current)) out.push(current);
      if (current === screen) break;
      current = this.doc.parent(current);
    }
    return out;
  }

  /**
   * Offset that brings `target` to `offset` from the top-left of its nearest
   * scrolling ancestor ("Scroll to", FR-PRT-010).
   */
  targetOffset(target: NodeId, screen: NodeId, offset: Vec): { container: NodeId; to: Vec } | null {
    const d = this.doc;
    let child = target;
    let parent = d.parent(target);
    // Position of the target inside the content of each ancestor until a scroll container.
    let x = 0;
    let y = 0;
    while (parent !== null) {
      const p = this.isContainer(parent) ? this.basePosition(child) : { x: d.get(child, 'x'), y: d.get(child, 'y') };
      x += p.x;
      y += p.y;
      if (this.isContainer(parent)) {
        const a = this.axes(parent);
        const now = this.offset(parent);
        return { container: parent, to: { x: a.x ? x - offset.x : now.x, y: a.y ? y - offset.y : now.y } };
      }
      if (parent === screen) return null;
      child = parent;
      parent = d.parent(parent);
    }
    return null;
  }

  /** Back to the top of every container inside `screen` (a fresh visit). */
  reset(screen: NodeId): void {
    for (const c of [...this.offsets.keys()]) {
      if (this.doc.store.isAlive(c) && this.doc.store.isAncestorOrSelf(screen, c)) this.set(c, 0, 0);
    }
  }

  /**
   * Runs a structural change (a variant swap) with every container unscrolled,
   * then re-reads the base positions and scrolls back: layout may move children.
   */
  unscrolled(fn: () => void): void {
    const saved = [...this.offsets.entries()].filter(([c]) => this.doc.store.isAlive(c));
    for (const [c] of saved) this.set(c, 0, 0);
    fn();
    this.base.clear();
    for (const [c, o] of saved) {
      if (!this.doc.store.isAlive(c)) continue;
      this.offsets.delete(c);
      this.set(c, o.x, o.y);
    }
  }
}
