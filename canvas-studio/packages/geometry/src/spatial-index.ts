// Uniform-grid spatial hash for culling and hit-testing (FR-CNV-003).
// Insert/update/remove are O(cells covered); queries visit only cells in range.
// Very large items (bigger than MAX_CELLS cells) are kept in an overflow list
// instead of being spread over thousands of cells.

import { intersects, type Point, type Rect } from './rect.ts';

const MAX_CELLS = 64;

export class SpatialIndex<K> {
  private readonly cellSize: number;
  private readonly cells = new Map<string, Set<K>>();
  private readonly bounds = new Map<K, Rect>();
  private readonly cellKeys = new Map<K, string[]>();
  private readonly overflow = new Set<K>();

  constructor(cellSize = 512) {
    this.cellSize = cellSize;
  }

  get size(): number {
    return this.bounds.size;
  }

  boundsOf(key: K): Rect | undefined {
    return this.bounds.get(key);
  }

  set(key: K, r: Rect): void {
    this.delete(key);
    this.bounds.set(key, r);
    const range = this.range(r);
    const count = (range.x1 - range.x0 + 1) * (range.y1 - range.y0 + 1);
    if (count > MAX_CELLS) {
      this.overflow.add(key);
      return;
    }
    const keys: string[] = [];
    for (let cx = range.x0; cx <= range.x1; cx++) {
      for (let cy = range.y0; cy <= range.y1; cy++) {
        const cell = `${cx},${cy}`;
        let set = this.cells.get(cell);
        if (!set) {
          set = new Set();
          this.cells.set(cell, set);
        }
        set.add(key);
        keys.push(cell);
      }
    }
    this.cellKeys.set(key, keys);
  }

  delete(key: K): void {
    if (!this.bounds.delete(key)) return;
    this.overflow.delete(key);
    const keys = this.cellKeys.get(key);
    if (!keys) return;
    for (const cell of keys) {
      const set = this.cells.get(cell);
      if (!set) continue;
      set.delete(key);
      if (set.size === 0) this.cells.delete(cell);
    }
    this.cellKeys.delete(key);
  }

  clear(): void {
    this.cells.clear();
    this.bounds.clear();
    this.cellKeys.clear();
    this.overflow.clear();
  }

  /** Keys whose bounds intersect `r`. */
  query(r: Rect): K[] {
    const out = new Set<K>();
    const range = this.range(r);
    const count = (range.x1 - range.x0 + 1) * (range.y1 - range.y0 + 1);
    if (count > this.cells.size) {
      // The query covers more cells than exist: scanning all items is cheaper.
      for (const [key, b] of this.bounds) if (intersects(b, r)) out.add(key);
      return [...out];
    }
    for (let cx = range.x0; cx <= range.x1; cx++) {
      for (let cy = range.y0; cy <= range.y1; cy++) {
        const set = this.cells.get(`${cx},${cy}`);
        if (!set) continue;
        for (const key of set) {
          if (out.has(key)) continue;
          const b = this.bounds.get(key);
          if (b && intersects(b, r)) out.add(key);
        }
      }
    }
    for (const key of this.overflow) {
      const b = this.bounds.get(key);
      if (b && intersects(b, r)) out.add(key);
    }
    return [...out];
  }

  queryPoint(p: Point, tolerance = 0): K[] {
    return this.query({ x: p.x - tolerance, y: p.y - tolerance, width: tolerance * 2, height: tolerance * 2 });
  }

  private range(r: Rect) {
    const s = this.cellSize;
    return {
      x0: Math.floor(r.x / s),
      y0: Math.floor(r.y / s),
      x1: Math.floor((r.x + r.width) / s),
      y1: Math.floor((r.y + r.height) / s),
    };
  }
}
