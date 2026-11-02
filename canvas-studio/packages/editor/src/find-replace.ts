// Find and replace (Figma users' complaint: replacing a word across a file is
// manual work). Searches the text of text layers and, optionally, layer names,
// in the whole file, the current page or the selection, in page and layer
// order. A replacement keeps the style of the text it replaces (bold, colour).

import type { Document, NodeId, Transaction } from '#core';
import { editListLevels, editRuns, runStyleAt } from '#layout';

export type FindScope = 'file' | 'page' | 'selection';

export interface FindOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  scope: FindScope;
  /** Also search layer names. */
  names: boolean;
}

export interface FindMatch {
  id: NodeId;
  page: NodeId;
  field: 'text' | 'name';
  start: number;
  end: number;
}

function pattern(o: FindOptions): RegExp | null {
  if (!o.query) return null;
  const escaped = o.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Letters of any alphabet count as a word (Cyrillic too).
  const body = o.wholeWord ? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])` : escaped;
  return new RegExp(body, o.caseSensitive ? 'gu' : 'giu');
}

/** Every match in document order. */
export function findMatches(doc: Document, o: FindOptions, ctx: { pageId: NodeId; selection: readonly NodeId[] }): FindMatch[] {
  const re = pattern(o);
  if (!re) return [];
  const out: FindMatch[] = [];
  const scan = (id: NodeId, page: NodeId, field: FindMatch['field'], text: string) => {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if (m[0].length === 0) continue;
      out.push({ id, page, field, start: m.index!, end: m.index! + m[0].length });
    }
  };
  const visit = (id: NodeId, page: NodeId) => {
    if (o.names) scan(id, page, 'name', String(doc.get(id, 'name') ?? ''));
    if (doc.type(id) === 'TEXT') scan(id, page, 'text', doc.get(id, 'characters'));
    for (const child of doc.children(id)) visit(child, page);
  };
  if (o.scope === 'selection') {
    for (const id of ctx.selection) if (doc.store.isAlive(id)) visit(id, doc.pageOf(id) ?? ctx.pageId);
  } else {
    const pages = o.scope === 'page' ? [ctx.pageId] : doc.pages();
    for (const page of pages) for (const child of doc.children(page)) visit(child, page);
  }
  return out;
}

/**
 * Replaces the given matches (from one search) inside a transaction. Each
 * layer is edited from its last match to its first, so offsets stay valid.
 * Returns the number of replacements.
 */
export function replaceMatches(doc: Document, tx: Transaction, matches: readonly FindMatch[], replacement: string): number {
  const byLayer = new Map<string, FindMatch[]>();
  for (const m of matches) {
    const key = `${m.id}\u0000${m.field}`;
    byLayer.set(key, [...(byLayer.get(key) ?? []), m]);
  }
  let count = 0;
  for (const list of byLayer.values()) {
    const { id, field } = list[0]!;
    if (!doc.store.isAlive(id)) continue;
    const sorted = [...list].sort((a, b) => b.start - a.start);
    if (field === 'name') {
      let name = String(doc.get(id, 'name') ?? '');
      for (const m of sorted) name = name.slice(0, m.start) + replacement + name.slice(m.end);
      tx.set(id, 'name', name);
      count += sorted.length;
      continue;
    }
    let text = doc.get(id, 'characters');
    let runs = doc.get(id, 'textRuns');
    let levels = doc.get(id, 'listLevels');
    for (const m of sorted) {
      if (text.slice(m.start, m.end).length !== m.end - m.start) continue;
      const style = runStyleAt(runs, m.start);
      const before = text;
      text = text.slice(0, m.start) + replacement + text.slice(m.end);
      runs = editRuns(runs, m.start, m.end - m.start, replacement.length, text.length, style);
      if (levels.length > 0) levels = editListLevels(levels, before, text, m.start, m.end - m.start, replacement.length);
      count++;
    }
    tx.set(id, 'characters', text);
    tx.set(id, 'textRuns', runs);
    if (levels.length > 0) tx.set(id, 'listLevels', levels);
  }
  return count;
}
