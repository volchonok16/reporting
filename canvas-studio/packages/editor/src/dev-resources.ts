// Links to resources on layers (step 7, Figma's Dev resources): a developer
// opens a component and finds its code on GitHub, its story in Storybook, the
// ticket, the doc — right in the «Код» tab. Kept in the file on the layer
// (`devResources`); an instance does not copy them but shows its component's
// (and the variant set's), as in Figma. Only http(s) links; at most 20 a layer.

import { safeLink, tr, type DevResource, type Document, type NodeId } from '#core';
import type { Editor } from './editor.ts';

export const MAX_RESOURCES = 20;
const MAX_NAME = 120;
const MAX_URL = 2000;

/** What a link is, by its address: shown beside its name. */
const KINDS: { kind: string; test: RegExp }[] = [
  { kind: 'GitHub', test: /(^|\.)github\.com$|(^|\.)githubusercontent\.com$/ },
  { kind: 'GitLab', test: /(^|\.)gitlab\./ },
  { kind: 'Bitbucket', test: /(^|\.)bitbucket\.org$/ },
  { kind: 'Storybook', test: /storybook|chromatic\.com$/ },
  { kind: 'Jira', test: /(^|\.)atlassian\.net$|(^|\.)jira\./ },
  { kind: 'Confluence', test: /confluence/ },
  { kind: 'Notion', test: /(^|\.)notion\.(so|site)$/ },
  { kind: 'Linear', test: /(^|\.)linear\.app$/ },
  { kind: 'YouTrack', test: /youtrack/ },
  { kind: 'Яндекс Трекер', test: /(^|\.)tracker\.yandex\./ },
  { kind: 'Figma', test: /(^|\.)figma\.com$/ },
  { kind: 'npm', test: /(^|\.)npmjs\.com$/ },
];

/** The kind of a link (GitHub, Storybook…) or its host. */
export function resourceKind(url: string): string {
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
  for (const k of KINDS) if (k.test.test(host) || (k.kind === 'Storybook' && /storybook/.test(url))) return k.kind;
  return host;
}

/** A name for a link nobody named: the last meaningful part of its path, else its host. */
export function defaultResourceName(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
    // Storybook keeps the story in ?path=/story/button--primary.
    const story = u.searchParams.get('path')?.split('/').filter(Boolean).at(-1);
    const last = story ?? parts.filter((p) => !['blob', 'tree', 'main', 'master', 'src', 'browse', 'issues', 'pull', 'wiki', 'docs'].includes(p)).at(-1);
    return (last ?? u.hostname.replace(/^www\./, '')).slice(0, MAX_NAME);
  } catch {
    return url.slice(0, MAX_NAME);
  }
}

/** Only http(s), as the browser will open it; null — not a link. */
export function cleanResourceUrl(raw: string): string | null {
  const v = safeLink(raw.trim());
  if (!v || !/^https?:\/\//i.test(v) || v.length > MAX_URL) return null;
  return v;
}

/** The layer's own links, whatever a file put there. */
export function resourcesOf(doc: Document, id: NodeId): DevResource[] {
  const raw = doc.store.isAlive(id) ? doc.get(id, 'devResources') : [];
  if (!Array.isArray(raw)) return [];
  const out: DevResource[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const url = typeof r.url === 'string' ? cleanResourceUrl(r.url) : null;
    if (!url) continue;
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, MAX_NAME) : defaultResourceName(url);
    out.push({ url, name });
    if (out.length >= MAX_RESOURCES) break;
  }
  return out;
}

/** Links a layer shows from elsewhere: an instance — its component's and that component's variant set's. */
export function inheritedResources(doc: Document, id: NodeId): { from: NodeId; name: string; list: DevResource[] }[] {
  const out: { from: NodeId; name: string; list: DevResource[] }[] = [];
  if (!doc.store.isAlive(id) || doc.type(id) !== 'INSTANCE') return out;
  const main = doc.get(id, 'mainComponent');
  if (typeof main !== 'string' || !doc.store.isAlive(main)) return out;
  const add = (from: NodeId) => {
    const list = resourcesOf(doc, from);
    if (list.length) out.push({ from, name: String(doc.get(from, 'name') ?? ''), list });
  };
  add(main);
  const set = doc.parent(main);
  if (set && doc.type(set) === 'COMPONENT_SET') add(set);
  return out;
}

/** Adds a link to a layer (one undo step); an error message when it cannot. */
export function addResource(editor: Editor, id: NodeId, rawUrl: string, rawName = ''): string | null {
  const doc = editor.doc;
  if (doc.readOnly) return tr('Файл открыт только для просмотра');
  const url = cleanResourceUrl(rawUrl);
  if (!url) return tr('Нужна ссылка вида https://…');
  const list = resourcesOf(doc, id);
  if (list.some((r) => r.url === url)) return tr('Эта ссылка уже есть у слоя');
  if (list.length >= MAX_RESOURCES) return tr('У слоя уже {0} ссылок — больше не добавить', MAX_RESOURCES);
  const name = rawName.trim().slice(0, MAX_NAME) || defaultResourceName(url);
  editor.commit(tr('Добавить ссылку на ресурс'), (tx) => tx.set(id, 'devResources', [...list, { url, name }]));
  return null;
}

export function removeResource(editor: Editor, id: NodeId, index: number): void {
  const list = resourcesOf(editor.doc, id);
  if (editor.doc.readOnly || !list[index]) return;
  editor.commit(tr('Удалить ссылку на ресурс'), (tx) => tx.set(id, 'devResources', list.filter((_, i) => i !== index)));
}

export function renameResource(editor: Editor, id: NodeId, index: number, name: string): void {
  const list = resourcesOf(editor.doc, id);
  const item = list[index];
  if (editor.doc.readOnly || !item) return;
  const next = name.trim().slice(0, MAX_NAME) || defaultResourceName(item.url);
  if (next === item.name) return;
  editor.commit(tr('Переименовать ссылку'), (tx) => tx.set(id, 'devResources', list.map((r, i) => (i === index ? { ...r, name: next } : r))));
}
