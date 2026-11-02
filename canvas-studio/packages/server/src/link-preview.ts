// Link previews for boards (as in FigJam): a link pasted on a board becomes a
// card with the page's title, description and picture. Browsers cannot read
// other sites, so the server fetches the page and its picture.
//
// The server only goes to public addresses: every name is resolved and checked
// at the moment of connecting (a lookup the request itself uses, so a name
// cannot point elsewhere after the check), redirects are followed by hand and
// checked again, and the size and time of every answer are limited.

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

export interface LinkPreview {
  url: string;
  title: string;
  description: string;
  site: string;
  /** The page's picture, when there is one and it is small enough. */
  image: { mime: string; data: string } | null;
}

/** What one answer gives: status, headers, the first bytes of the body. */
export interface Fetched {
  status: number;
  type: string;
  location: string | null;
  body: Uint8Array;
}

export type Getter = (url: URL, maxBytes: number, accept: string) => Promise<Fetched>;

/** Big pages keep their tags far down the <head> (a YouTube video's at ~780 KB); reading stops at </head>. */
const PAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 6000;
const REDIRECTS = 4;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** An address a request may go to: no loopback, private, link-local, multicast or reserved ranges. */
export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b < 128) return false; // shared address space (CGNAT)
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b < 32) return false;
    if ((a === 192 && b === 168) || ip.startsWith('192.0.0.') || ip.startsWith('192.0.2.')) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (kind === 6) {
    const v = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPublicAddress(mapped[1]!);
    if (v === '::' || v === '::1') return false;
    // Only global unicast (2000::/3) is public — without documentation, 6to4 and Teredo, which carry IPv4 addresses inside (BUG-163).
    return /^[23][0-9a-f]{0,3}:/.test(v) && !v.startsWith('2001:db8:') && !v.startsWith('2002:') && !/^2001:(0{1,4})?:/.test(v);
  }
  return false;
}

/** The link to preview: http or https, no login inside, standard ports. Null — not one we go to. */
export function previewTarget(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== '80' && url.port !== '443') return null;
  if (raw.length > 2048) return null;
  url.hash = '';
  return url;
}

/** Resolves a name and refuses it unless every address is public. */
const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, list) => {
    if (error) return callback(error, '', 0);
    if (list.length === 0 || !list.every((a) => isPublicAddress(a.address))) return callback(Object.assign(new Error('not a public address'), { code: 'ENOTPUBLIC' }), '', 0);
    if (options.all) return callback(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
};

/** One GET over the network, through the checking lookup. */
export const netGet: Getter = (url, maxBytes, accept) =>
  new Promise((resolve, reject) => {
    if (isIP(url.hostname.replace(/^\[|\]$/g, '')) && !isPublicAddress(url.hostname.replace(/^\[|\]$/g, ''))) return reject(new Error('not a public address'));
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request(url, { method: 'GET', lookup: safeLookup, timeout: TIMEOUT_MS, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SimmetrikaBot/1.0; +https://simmetrika.online)', Accept: accept, 'Accept-Language': 'ru,en;q=0.8' } }, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const done = () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), location: typeof res.headers.location === 'string' ? res.headers.location : null, body: new Uint8Array(Buffer.concat(chunks)) });
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
          res.destroy();
          done();
          return;
        }
        chunks.push(chunk);
        // A page: what a card needs is in the <head>, the rest is not read.
        if (accept.startsWith('text/html') && /<\/head\s*>/i.test(chunk.toString('latin1'))) {
          res.destroy();
          done();
        }
      });
      res.on('end', done);
      res.on('close', done);
      res.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(new Error('timeout')), TIMEOUT_MS);
    req.on('close', () => clearTimeout(timer));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });

/** GET with redirects followed by hand: each new address is checked as the first one. */
async function follow(get: Getter, url: URL, maxBytes: number, accept: string): Promise<{ url: URL; res: Fetched }> {
  let current = url;
  for (let i = 0; i <= REDIRECTS; i++) {
    const res = await get(current, maxBytes, accept);
    if (res.status >= 300 && res.status < 400 && res.location) {
      const next = previewTarget(new URL(res.location, current).href);
      if (!next) throw new Error('bad redirect');
      current = next;
      continue;
    }
    return { url: current, res };
  }
  throw new Error('too many redirects');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const clean = (s: string | undefined, max: number): string => {
  const t = decodeEntities(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/** The page's text in its own encoding (header, then <meta charset>, then UTF-8). */
function decodePage(body: Uint8Array, type: string): string {
  const head = new TextDecoder('latin1').decode(body.subarray(0, 4096));
  const charset = /charset=["']?([\w-]+)/i.exec(type)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset.toLowerCase()).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

/** Title, description, picture and site name from a page's <head>. */
export function parsePage(html: string, base: URL): { title: string; description: string; site: string; image: string | null } {
  const head = html.slice(0, (html.search(/<\/head>/i) + 1 || html.length) + 7);
  const meta = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
    const key = attr('property') ?? attr('name') ?? attr('itemprop');
    const content = attr('content');
    if (!key || !content) continue;
    const k = (key[1] ?? key[2] ?? key[3] ?? '').toLowerCase();
    if (k && !meta.has(k)) meta.set(k, content[1] ?? content[2] ?? content[3] ?? '');
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const host = base.hostname.replace(/^www\./, '');
  const title = clean(meta.get('og:title') ?? meta.get('twitter:title') ?? titleTag, 140) || host;
  const description = clean(meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description'), 300);
  const site = clean(meta.get('og:site_name'), 60) || host;
  const rawImage = meta.get('og:image:secure_url') ?? meta.get('og:image') ?? meta.get('og:image:url') ?? meta.get('twitter:image') ?? meta.get('twitter:image:src') ?? null;
  let image: string | null = null;
  if (rawImage) {
    try {
      image = previewTarget(new URL(decodeEntities(rawImage.trim()), base).href)?.href ?? null;
    } catch {
      image = null;
    }
  }
  return { title, description, site, image };
}

/** Pictures by their first bytes (a server may call any of them octet-stream). */
function sniff(bytes: Uint8Array, type: string): string | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  const t = type.split(';')[0]!.trim().toLowerCase();
  return IMAGE_TYPES.has(t) ? t : null;
}

/** Fetches and reads a page. Throws when it cannot be reached or is not a page. */
export async function fetchPreview(target: URL, get: Getter = netGet): Promise<LinkPreview> {
  const { url, res } = await follow(get, target, PAGE_BYTES, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5');
  if (res.status < 200 || res.status >= 300) throw new Error(`status ${res.status}`);
  const host = url.hostname.replace(/^www\./, '');
  // A link straight to a picture: the picture is the card.
  const direct = sniff(res.body, res.type);
  if (direct) return { url: target.href, title: decodeURIComponent(url.pathname.split('/').pop() || host), description: '', site: host, image: res.body.length < PAGE_BYTES ? { mime: direct, data: Buffer.from(res.body).toString('base64') } : null };
  if (!/html|xml/i.test(res.type) && res.type) return { url: target.href, title: host, description: '', site: host, image: null };
  const page = parsePage(decodePage(res.body, res.type), url);
  let image: LinkPreview['image'] = null;
  if (page.image) {
    try {
      const pic = await follow(get, new URL(page.image), IMAGE_BYTES + 1, 'image/webp,image/png,image/jpeg,image/gif;q=0.9');
      const mime = pic.res.status === 200 && pic.res.body.length <= IMAGE_BYTES ? sniff(pic.res.body, pic.res.type) : null;
      if (mime) image = { mime, data: Buffer.from(pic.res.body).toString('base64') };
    } catch {
      image = null;
    }
  }
  return { url: target.href, title: page.title, description: page.description, site: page.site, image };
}

/** Previews already made: the same link pasted again (or by a colleague) is not fetched twice. */
export class LinkPreviews {
  private readonly cache = new Map<string, { at: number; value: LinkPreview }>();
  private readonly get: Getter;
  constructor(get: Getter = netGet) {
    this.get = get;
  }

  async preview(target: URL): Promise<LinkPreview> {
    const key = target.href;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 3600_000) return hit.value;
    const value = await fetchPreview(target, this.get);
    this.cache.set(key, { at: Date.now(), value });
    if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }
}
