// Live editing (stage "Server", part 2): one room per open file. The room keeps
// the document in memory, applies the operations editors send, passes them to
// everyone else in the file and saves the file to disk itself (a second after
// the last change, at least every five seconds, and when the last person
// leaves). The document core is a CRDT (Lamport times, last writer wins per
// property, ids unique per session), so operations applied twice or in a
// different order still give the same file everywhere.
//
// Protocol (JSON text messages):
//   client → server  hello {version, since}  ops {id, ops}  presence {page, cursor, selection, view, chat}
//                    spotlight {on}
//   server → client  welcome {you, seq}  snapshot {seq, snapshot}  ops {seq, ops, from}
//                    ack {id, seq}  peers {peers}  presence {from, page, cursor, selection, view, chat}
//                    spotlight {from}  role {role}  revoked  error {message}  deleted
//                    thread {thread} | thread {id, deleted}   (comments changed, sent by the API)
// Presence (pointer, selection, the visible part of the canvas for those who
// follow, a cursor chat message) is only passed on, never saved. Spotlight:
// one person at a time asks everyone to follow them; it ends when they stop or leave.
// Access is checked again whenever sharing changes: a new role applies at once,
// someone whose access was taken away is disconnected.
// Pictures live on disk next to the document (documents.ts), not in the
// room's memory (a 10 MB picture took about 60 MB there): the room keeps only
// their types, saves the document without them (so a save is small however
// heavy the file is), and puts them back only into a snapshot it sends to a
// newcomer or keeps as a version. The log of recent batches keeps no picture
// data either: someone who needs a batch with a picture gets the whole file.

import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { toSnapshot, type Document, type Op } from '../../core/src/index.ts';
import { atLeast, type Role } from './access.ts';
import { AUTO_EVERY } from './versions.ts';
import type { Api, FileMeta } from './api.ts';
import { Documents } from './documents.ts';
import type { BlobStore } from './storage.ts';
import { HttpError, parseCookies } from './http.ts';
import { HIDDEN_NAME, tokenHash } from './auth.ts';
import { acceptWebSocket, rejectUpgrade, VIEWER_MESSAGE, MAX_MESSAGE, type WebSocketConnection } from './websocket.ts';

const SAVE_AFTER = 1000;
const SAVE_AT_LEAST = 5000;
/** Batches kept for people who reconnect; older gaps are filled with a snapshot. */
const LOG_LIMIT = 5000;
/** Live connections from one address: a room per tab is plenty; thousands would only eat memory (BUG-160). */
export const CONNECTIONS_PER_IP = 40;
const COLORS = ['#f24e1e', '#9747ff', '#14ae5c', '#4f5bd5', '#ff7262', '#ffcd29', '#1bc4b4', '#e04fa0'];

interface Peer {
  id: string;
  conn: WebSocketConnection;
  userId: string | null;
  /** The login session the connection came with (its hash): signing out ends the connection too (BUG-162). */
  session: string | null;
  /** The name for people of the file (the address when there is no name)… */
  name: string;
  /** …and for those who have the file only by its link: never the address (BUG-159). */
  outsideName: string;
  /** Has the file as its owner, a member or through its team: sees the others' addresses. */
  insider: boolean;
  color: string;
  role: Role;
  /** Last presence, so a newcomer sees everyone's pointer at once. */
  presence: string | null;
  /** Page of the last presence (pointers go only to people on the same page). */
  page: string | null;
  /** Messages held while the newcomer is being sent the file (they come after it, in order). */
  queue: string[] | null;
  /** When this person's last emotes were sent (the limit). */
  emotes: number[];
  /** Checks this person's access again (role null — no access any more; insider absent — as it was). */
  recheck: () => Promise<{ role: Role | null; insider?: boolean }>;
}

/** Longest cursor chat message. */
export const CHAT_LIMIT = 100;
/** Emotes people may send (step 10): passed on at once, never kept. ✋ — a high five. */
export const EMOTES = ['👍', '❤️', '😂', '🎉', '🔥', '👏', '😮', '✋'] as const;
/** At most so many emotes a person sends in two seconds (a held key must not flood the room). */
const EMOTES_PER_2S = 8;

/** An emote message, cleaned; null — not one we pass on. */
export function cleanEmote(msg: { emoji?: unknown; x?: unknown; y?: unknown; page?: unknown; to?: unknown }): { emoji: string; x: number; y: number; page: string; to: string | null } | null {
  if (typeof msg.emoji !== 'string' || !(EMOTES as readonly string[]).includes(msg.emoji)) return null;
  if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y) || typeof msg.page !== 'string' || msg.page.length >= 100) return null;
  const to = typeof msg.to === 'string' && /^p\d{1,9}$/.test(msg.to) ? msg.to : null;
  return { emoji: msg.emoji, x: Number(msg.x), y: Number(msg.y), page: msg.page, to };
}

type View = { x: number; y: number; zoom: number; width: number; height: number };

/** Keeps a presence message small and well-formed before passing it on. */
function cleanPresence(msg: { page?: unknown; cursor?: unknown; selection?: unknown; view?: unknown; chat?: unknown }): { page: string | null; cursor: { x: number; y: number } | null; selection: string[]; view: View | null; chat: string | null } {
  const c = msg.cursor as { x?: unknown; y?: unknown } | null | undefined;
  const cursor = c && Number.isFinite(c.x) && Number.isFinite(c.y) ? { x: Number(c.x), y: Number(c.y) } : null;
  const page = typeof msg.page === 'string' && msg.page.length < 100 ? msg.page : null;
  const selection = Array.isArray(msg.selection) ? msg.selection.filter((id): id is string => typeof id === 'string' && id.length < 100).slice(0, 200) : [];
  // Centre of the visible part (world), zoom and screen size: enough for a follower to see the same.
  const v = msg.view as Partial<Record<keyof View, unknown>> | null | undefined;
  const ok = v && (['x', 'y', 'zoom', 'width', 'height'] as const).every((k) => Number.isFinite(v[k]));
  const view = ok && Number(v.zoom) > 0 && Number(v.width) > 0 && Number(v.height) > 0 ? { x: Number(v.x), y: Number(v.y), zoom: Number(v.zoom), width: Math.min(10000, Number(v.width)), height: Math.min(10000, Number(v.height)) } : null;
  const chat = typeof msg.chat === 'string' ? msg.chat.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, CHAT_LIMIT) : null;
  return { page, cursor, selection, view, chat };
}

/** Pictures of an open file: written to the file's picture store, kept in memory only until written. */
export class RoomImages {
  private readonly docs: Documents;
  private readonly files: BlobStore;
  private readonly fileId: string;
  /** Pictures still being written (their data is kept until then). */
  private readonly writing = new Map<string, Promise<void>>();

  constructor(docs: Documents, files: BlobStore, fileId: string) {
    this.docs = docs;
    this.files = files;
    this.fileId = fileId;
  }

  /** Pictures that came inside an old snapshot go to disk (left-overs of the previous scheme are removed). */
  async stash(doc: Document, inline: [string, { mime: string; data: string }][]): Promise<void> {
    for (const name of await this.files.list(this.fileId)) {
      if (/^r[a-f0-9]{8}[a-f0-9]{64}$/.test(name)) await this.files.removeFile(this.fileId, name);
    }
    for (const [hash, blob] of inline) this.keep(doc, hash, blob.mime, blob.data);
    await this.idle();
  }

  /** A picture that came (with the file or in an operation): to disk, out of memory. */
  keep(doc: Document, hash: string, mime: string, data: string): void {
    if (!data || this.writing.has(hash)) return;
    const done = this.docs.putPicture(this.fileId, hash, data).then(
      () => {
        if (doc.store.blobs.has(hash)) doc.store.blobs.set(hash, { mime, data: '' });
        this.writing.delete(hash);
      },
      () => {
        // Not written: the data stays in memory.
        this.writing.delete(hash);
      },
    );
    this.writing.set(hash, done);
  }

  /** Every picture that came is on disk. */
  async idle(): Promise<void> {
    await Promise.all(this.writing.values());
  }

  /** The whole document with its pictures (taken at the call, finished from disk). */
  text(doc: Document): Promise<string> {
    const snap = toSnapshot(doc);
    const blobs = snap.blobs ?? {};
    delete snap.blobs;
    const head = JSON.stringify(snap);
    const pictures = Object.entries(blobs).map(([hash, b]) => ({ hash, mime: b.mime, data: b.data || null }));
    return this.idle().then(() => this.docs.withPictures(this.fileId, head, pictures));
  }
}

class Room {
  readonly fileId: string;
  readonly images: RoomImages;
  doc: Document;
  /** Number of the last batch of operations; the log holds the latest ones. */
  seq = 0;
  private log: { seq: number; ops: Op[] }[] = [];
  /** Which batch each saved version of the file contains up to (for people who loaded that version). */
  private readonly versions = new Map<number, number>();
  readonly peers = new Map<string, Peer>();
  private dirtySince = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private nextPeer = 0;
  /** Who asked everyone to follow them now. */
  private spotlight: string | null = null;
  /** Who changed the file since the last version (for the version history). */
  readonly authors = new Set<string>();
  /** When a version was last tried (an automatic one is due ten minutes later). */
  private checkpointAt = 0;

  private readonly hub: LiveHub;

  constructor(fileId: string, doc: Document, version: number, hub: LiveHub, images: RoomImages) {
    this.hub = hub;
    this.fileId = fileId;
    this.doc = doc;
    this.images = images;
    this.versions.set(version, 0);
  }

  join(conn: WebSocketConnection, who: Pick<Peer, 'userId' | 'session' | 'name' | 'outsideName' | 'insider' | 'role' | 'recheck'>): void {
    const used = new Set([...this.peers.values()].map((p) => p.color));
    const color = COLORS.find((c) => !used.has(c)) ?? COLORS[this.nextPeer % COLORS.length]!;
    const peer: Peer = { id: `p${++this.nextPeer}`, conn, color, presence: null, page: null, queue: null, emotes: [], ...who };
    // Only editors send pictures; anyone else sends pointers and chat — a small message is enough (BUG-160).
    conn.maxMessage = atLeast(peer.role, 'editor') ? MAX_MESSAGE : VIEWER_MESSAGE;
    let greeted = false;
    conn.onMessage = (text) => {
      let msg: { type?: string; version?: unknown; since?: unknown; rawSnapshot?: unknown; id?: unknown; ops?: unknown; page?: unknown; cursor?: unknown; selection?: unknown; view?: unknown; chat?: unknown; on?: unknown; emoji?: unknown; x?: unknown; y?: unknown; to?: unknown };
      try {
        msg = JSON.parse(text) as typeof msg;
      } catch {
        return conn.close(1003, 'bad json');
      }
      if (msg.type === 'hello' && !greeted) {
        greeted = true;
        this.peers.set(peer.id, peer);
        void this.greet(peer, typeof msg.version === 'number' ? msg.version : null, typeof msg.since === 'number' ? msg.since : null, msg.rawSnapshot === true);
        this.sendPeers();
        for (const p of this.peers.values()) if (p.id !== peer.id && p.presence) this.out(peer, p.presence);
        if (this.spotlight) this.out(peer, JSON.stringify({ type: 'spotlight', from: this.spotlight }));
      } else if (msg.type === 'ops' && greeted) {
        this.receive(peer, msg.id, msg.ops);
      } else if (msg.type === 'presence' && greeted) {
        const presence = cleanPresence(msg);
        peer.presence = JSON.stringify({ type: 'presence', from: peer.id, ...presence });
        this.relayPresence(peer, presence.page);
      } else if (msg.type === 'emote' && greeted) {
        // A reaction at one's pointer, or a high five to someone: everyone else sees it fly; nothing is kept.
        const emote = cleanEmote(msg);
        const now = Date.now();
        peer.emotes = peer.emotes.filter((t) => now - t < 2000);
        if (!emote || peer.emotes.length >= EMOTES_PER_2S) return;
        peer.emotes.push(now);
        const text = JSON.stringify({ type: 'emote', from: peer.id, ...emote });
        for (const p of this.peers.values()) if (p.id !== peer.id) this.out(p, text);
      } else if (msg.type === 'spotlight' && greeted) {
        // Anyone in the file may ask the others to follow; a new spotlight replaces the old one.
        if (msg.on === true) this.setSpotlight(peer.id);
        else if (this.spotlight === peer.id) this.setSpotlight(null);
      }
    };
    conn.onClose = () => {
      this.peers.delete(peer.id);
      this.sendPeers();
      if (this.spotlight === peer.id) this.setSpotlight(null);
      if (this.peers.size === 0) void this.hub.release(this);
    };
  }

  /**
   * Passes a pointer on. Pointers move 20 times a second and are drawn only on
   * the page they are on: they go to people on the same page (and to those
   * whose page is not known yet). A change of page goes to everyone — avatars,
   * following and the spotlight need to know where a person is — and the one
   * who came gets the pointers of those already on that page.
   */
  private relayPresence(peer: Peer, page: string | null): void {
    const moved = page !== peer.page;
    peer.page = page;
    for (const p of this.peers.values()) {
      if (p.id === peer.id) continue;
      if (moved || this.spotlight === peer.id || p.page === null || page === null || p.page === page) this.out(p, peer.presence!);
      if (moved && page !== null && p.page === page && p.presence) this.out(peer, p.presence);
    }
  }

  /** Sends to one person; held while they are being sent the file. */
  private out(peer: Peer, text: string): void {
    if (peer.queue) peer.queue.push(text);
    else peer.conn.send(text);
  }

  /** The document as a snapshot text with its pictures. */
  text(): Promise<string> {
    return this.images.text(this.doc);
  }

  /** The whole file, put together once for everyone who comes in while nothing changes. */
  private shared: { seq: number; raw: boolean; message: Promise<string> }[] = [];

  /**
   * The "snapshot" message. `raw` (clients that ask for it): the document goes
   * into the message as JSON itself, not as an escaped string inside it — one
   * copy of a heavy file less, for the server and for the browser.
   */
  private snapshotMessage(raw: boolean): Promise<string> {
    const seq = this.seq;
    const found = this.shared.find((s) => s.seq === seq && s.raw === raw);
    if (found) return found.message;
    const clock = this.doc.clock.now;
    const message = this.text().then((text) => (raw ? `{"type":"snapshot","seq":${seq},"clock":${clock},"snapshot":${text}}` : JSON.stringify({ type: 'snapshot', seq, snapshot: text, clock })));
    const entry = { seq, raw, message };
    this.shared.push(entry);
    // Shared only while it is being put together: a ready message is not kept in memory.
    const drop = () => {
      this.shared = this.shared.filter((s) => s !== entry);
    };
    message.then(drop, drop);
    return message;
  }

  /**
   * Brings a newcomer up to date: the batches they have not seen, or the whole
   * file (also when one of those batches carried a picture: the log keeps none).
   * Whatever happens meanwhile reaches them after it, in order.
   */
  private async greet(peer: Peer, version: number | null, since: number | null, raw: boolean): Promise<void> {
    const from = since ?? (version !== null ? this.versions.get(version) : undefined);
    const first = this.log[0]?.seq ?? this.seq + 1;
    // The clock goes too: a snapshot carries no times, and a newcomer's edits must be newer than what the room has seen.
    peer.conn.send(JSON.stringify({ type: 'welcome', you: peer.id, color: peer.color, seq: this.seq, clock: this.doc.clock.now }));
    const missed = from !== undefined && from >= first - 1 && from <= this.seq ? this.log.filter((entry) => entry.seq > from) : null;
    if (missed && !missed.some((entry) => entry.ops.some((op) => op.kind === 'blob'))) {
      for (const entry of missed) peer.conn.send(JSON.stringify({ type: 'ops', seq: entry.seq, ops: entry.ops }));
      return;
    }
    peer.queue = [];
    try {
      peer.conn.send(await this.snapshotMessage(raw));
    } catch (error) {
      this.hub.log(`live: файл не отправлен ${this.fileId}: ${error instanceof Error ? error.message : String(error)}`);
      peer.conn.close(1011, 'error');
    } finally {
      const held = peer.queue ?? [];
      peer.queue = null;
      for (const text of held) peer.conn.send(text);
    }
  }

  private receive(peer: Peer, id: unknown, ops: unknown): void {
    if (!atLeast(peer.role, 'editor')) {
      this.out(peer, JSON.stringify({ type: 'error', id, message: 'У вас доступ только на просмотр' }));
      return;
    }
    if (!Array.isArray(ops) || ops.some((op) => !op || typeof op !== 'object' || typeof (op as { kind?: unknown }).kind !== 'string')) {
      this.out(peer, JSON.stringify({ type: 'error', id, message: 'Неверные операции' }));
      return;
    }
    this.apply(ops as Op[], peer.id);
    if (peer.userId) this.authors.add(peer.userId);
    this.out(peer, JSON.stringify({ type: 'ack', id, seq: this.seq }));
  }

  /** Applies a batch, passes it to everyone else and schedules the save. */
  apply(ops: Op[], from: string | null): void {
    this.doc.applyRemote(ops);
    this.seq += 1;
    // Pictures go to disk; the log keeps the batch without their data.
    const blobs = ops.filter((op) => op.kind === 'blob');
    for (const op of blobs) if (op.kind === 'blob') this.images.keep(this.doc, op.hash, op.mime, op.data);
    this.log.push({ seq: this.seq, ops: blobs.length ? ops.map((op) => (op.kind === 'blob' ? { ...op, data: '' } : op)) : ops });
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
    const text = JSON.stringify({ type: 'ops', seq: this.seq, ops, from });
    for (const p of this.peers.values()) if (p.id !== from) this.out(p, text);
    this.scheduleSave();
  }

  private scheduleSave(): void {
    const now = Date.now();
    if (!this.dirtySince) this.dirtySince = now;
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.min(SAVE_AFTER, Math.max(0, this.dirtySince + SAVE_AT_LEAST - now));
    this.timer = setTimeout(() => void this.save(), wait);
  }

  /** Writes the document to disk as a new version of the file. */
  save(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirtySince) return this.saving;
    this.dirtySince = 0;
    const seq = this.seq;
    // The document as it is now, without picture data: small whatever the pictures weigh.
    const stored = Documents.stored(this.doc);
    const name = String(this.doc.get(this.doc.rootId, 'name') ?? '') || 'Без названия';
    this.saving = this.saving
      .then(async () => {
        // Pictures first: the saved document must never point to a picture not on disk.
        await this.images.idle();
        await this.hub.api.blobs.write(this.fileId, 'snapshot.json', stored);
        const meta = await this.hub.api.files.update(this.fileId, (cur) => (cur ? { ...cur, name, updatedAt: Date.now(), version: cur.version + 1 } : undefined));
        if (meta) this.versions.set(meta.version, seq);
        // A version at most every ten minutes: the whole file (with pictures) is put together only then.
        // A failed version must not fail the save (it would be retried forever).
        if (this.authors.size > 0 && Date.now() - this.checkpointAt >= AUTO_EVERY) {
          await this.text()
            .then((text) => this.checkpoint(text, false))
            .catch((error: unknown) => this.hub.log(`live: версия не сохранена ${this.fileId}: ${error instanceof Error ? error.message : String(error)}`));
        }
      })
      .catch((error: unknown) => {
        this.hub.log(`live: не удалось сохранить ${this.fileId}: ${error instanceof Error ? error.message : String(error)}`);
        this.dirtySince = Date.now();
        this.scheduleSave();
      });
    return this.saving;
  }

  /** A version for the history: at most every ten minutes while people work, always when they leave. */
  async checkpoint(snapshot: string, force: boolean): Promise<void> {
    if (this.authors.size === 0) return;
    this.checkpointAt = Date.now();
    const kept = await this.hub.api.versions.add(this.fileId, snapshot, { authors: [...this.authors], force });
    if (kept) this.authors.clear();
  }

  private setSpotlight(id: string | null): void {
    if (this.spotlight === id) return;
    this.spotlight = id;
    const text = JSON.stringify({ type: 'spotlight', from: id });
    for (const p of this.peers.values()) this.out(p, text);
  }

  /** Sharing changed: everyone's role is checked again; who lost access is disconnected. */
  async recheckAccess(): Promise<void> {
    let changed = false;
    await Promise.all(
      [...this.peers.values()].map(async (p) => {
        const { role, insider } = await p.recheck();
        if (insider !== undefined && insider !== p.insider) {
          p.insider = insider;
          changed = true;
        }
        if (role === p.role) return;
        changed = true;
        if (!role) {
          this.drop(p, 'revoked');
          return;
        }
        p.role = role;
        p.conn.maxMessage = atLeast(role, 'editor') ? MAX_MESSAGE : VIEWER_MESSAGE;
        this.out(p, JSON.stringify({ type: 'role', role }));
      }),
    );
    if (changed) this.sendPeers();
  }

  /** Takes someone out of the file: access taken away (`revoked`) or signed out (`signedOut`). */
  drop(p: Peer, reason: 'revoked' | 'signedOut'): void {
    this.peers.delete(p.id);
    p.queue = null;
    p.conn.send(JSON.stringify({ type: reason }));
    p.conn.close(1000, reason);
  }

  sendPeers(): void {
    const list = (insider: boolean) => JSON.stringify({ type: 'peers', peers: [...this.peers.values()].map((p) => ({ id: p.id, userId: p.userId, name: insider ? p.name : p.outsideName, color: p.color, role: p.role })) });
    const inside = list(true);
    const outside = list(false);
    for (const p of this.peers.values()) this.out(p, p.insider ? inside : outside);
  }

  /** To everyone in the file; a function gives people of the file and the others their own message (names). */
  send(message: object | ((insider: boolean) => object)): void {
    const inside = JSON.stringify(typeof message === 'function' ? message(true) : message);
    const outside = typeof message === 'function' ? JSON.stringify(message(false)) : inside;
    for (const p of this.peers.values()) this.out(p, p.insider ? inside : outside);
  }

  closeAll(message: object): void {
    const text = JSON.stringify(message);
    for (const p of this.peers.values()) {
      p.conn.send(text);
      p.conn.close(1000, 'closed');
    }
  }
}

export class LiveHub {
  readonly api: Api;
  readonly log: (line: string) => void;
  private readonly rooms = new Map<string, Promise<Room | null>>();
  /** Open live connections per address. */
  private readonly perIp = new Map<string, number>();

  constructor(api: Api, log: (line: string) => void) {
    this.api = api;
    this.log = log;
  }

  /** `GET /api/live/<file>?link=…` with Upgrade: websocket. */
  async handleUpgrade(req: IncomingMessage, socket: Socket, host: string, ip = req.socket.remoteAddress ?? 'unknown'): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${host}`);
    const m = /^\/api\/live\/([A-Za-z0-9_-]{6,128})$/.exec(url.pathname);
    if (!m) return rejectUpgrade(socket, 404, 'Not Found');
    // Another site cannot open a connection with this person's cookies.
    const origin = req.headers.origin;
    if (typeof origin === 'string') {
      let ok = false;
      try {
        ok = new URL(origin).host === host;
      } catch {
        ok = false;
      }
      if (!ok) return rejectUpgrade(socket, 403, 'Forbidden');
    }
    if ((this.perIp.get(ip) ?? 0) >= CONNECTIONS_PER_IP) return rejectUpgrade(socket, 429, 'Too Many Requests');
    const fileId = m[1]!;
    let access: { meta: FileMeta; user: { id: string; name: string; email: string } | null; role: Role };
    try {
      access = await this.api.accessTo(req, fileId, 'viewer', url.searchParams.get('link') ?? undefined);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      return rejectUpgrade(socket, status, status === 404 ? 'Not Found' : status === 401 ? 'Unauthorized' : 'Error');
    }
    const room = await this.room(fileId);
    if (!room) return rejectUpgrade(socket, 404, 'Not Found');
    const { user, role } = access;
    const insider = await this.api.isInsider(access.meta, user?.id);
    const conn = acceptWebSocket(req, socket);
    if (!conn) return;
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
    conn.onEnd = () => {
      const n = (this.perIp.get(ip) ?? 1) - 1;
      if (n > 0) this.perIp.set(ip, n);
      else this.perIp.delete(ip);
    };
    const link = url.searchParams.get('link') ?? undefined;
    const token = user ? parseCookies(req.headers.cookie).cs_session : undefined;
    let last = role;
    const recheck = () =>
      this.api.accessTo(req, fileId, 'viewer', link).then(
        async (a) => ({ role: (last = a.role), insider: await this.api.isInsider(a.meta, user?.id) }),
        // No access any more; a passing failure (disk, network) keeps the role as it was.
        (error: unknown) => ({ role: error instanceof HttpError && error.status < 500 ? null : last }),
      );
    // A guest names themselves (an animal, picked in their browser): only letters, spaces and brackets, short.
    const guest = (url.searchParams.get('guest') ?? '').replace(/[^\p{L}\p{N} ()-]/gu, '').trim().slice(0, 40);
    room.join(conn, {
      userId: user?.id ?? null,
      session: token ? tokenHash(token) : null,
      name: user ? user.name || user.email : guest || 'Гость',
      outsideName: user ? user.name || HIDDEN_NAME : guest || 'Гость',
      insider,
      role,
      recheck,
    });
  }

  private room(fileId: string): Promise<Room | null> {
    let room = this.rooms.get(fileId);
    if (!room) {
      room = (async () => {
        const meta = await this.api.files.get(fileId);
        const opened = meta ? await this.api.documents.open(fileId) : null;
        if (!meta || !opened) return null;
        const images = new RoomImages(this.api.documents, this.api.blobs, fileId);
        await images.stash(opened.doc, opened.inline);
        return new Room(fileId, opened.doc, meta.version, this, images);
      })().catch((error: unknown) => {
        this.log(`live: не удалось открыть ${fileId}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      this.rooms.set(fileId, room);
      void room.then((r) => {
        if (!r && this.rooms.get(fileId) === room) this.rooms.delete(fileId);
      });
    }
    return room;
  }

  /** The last person left: save and forget the room (a newcomer opens a fresh one from disk). */
  async release(room: Room): Promise<void> {
    await room.save();
    // Everyone left: what they did becomes a version.
    await room
      .text()
      .then((text) => room.checkpoint(text, true))
      .catch((error: unknown) => this.log(`live: версия не сохранена ${room.fileId}: ${error instanceof Error ? error.message : String(error)}`));
    if (room.peers.size === 0 && (await this.rooms.get(room.fileId)) === room) this.rooms.delete(room.fileId);
  }

  /** Whether people are in the file now (then saves by HTTP would overwrite their work). */
  async isLive(fileId: string): Promise<boolean> {
    const room = await this.rooms.get(fileId);
    return !!room && room.peers.size > 0;
  }

  /** Renaming from the file list while the file is open: goes in as an operation, so nobody's copy overwrites it. */
  async rename(fileId: string, name: string): Promise<boolean> {
    const room = await this.rooms.get(fileId);
    if (!room || room.peers.size === 0) return false;
    const op: Op = { kind: 'set', id: room.doc.rootId, key: 'name', value: name, time: room.doc.clock.tick() };
    room.apply([op], null);
    await room.save();
    return true;
  }

  /** Sharing of a file changed: people in it get their new role, or are disconnected. */
  async accessChanged(fileId: string): Promise<void> {
    const room = await this.rooms.get(fileId);
    await room?.recheckAccess();
  }

  /** Passes a message to everyone in the file (comments are kept by the API, not the room). */
  async broadcast(fileId: string, message: object | ((insider: boolean) => object)): Promise<void> {
    const room = await this.rooms.get(fileId);
    room?.send(message);
  }

  /** Signed out (`session`) or every session ended (`userId`: a new password, the account deleted): their live connections end too (BUG-162). */
  async signedOut(who: { session?: string; userId?: string }): Promise<void> {
    for (const pending of this.rooms.values()) {
      const room = await pending;
      if (!room) continue;
      // Closing a connection tells the others and, the last one gone, releases the room (join's onClose).
      for (const p of [...room.peers.values()]) {
        if ((who.session && p.session === who.session) || (who.userId && p.userId === who.userId)) room.drop(p, 'signedOut');
      }
    }
  }

  /** Writes the open file to disk now (before a version is saved on purpose). */
  async flush(fileId: string): Promise<void> {
    const room = await this.rooms.get(fileId);
    await room?.save();
  }

  /** The file was deleted: tell everyone in it and close the room. */
  async deleted(fileId: string): Promise<void> {
    const room = await this.rooms.get(fileId);
    if (!room) return;
    this.rooms.delete(fileId);
    room.closeAll({ type: 'deleted' });
  }

  /** Server stopping: save every open file. */
  async flushAll(): Promise<void> {
    await Promise.all([...this.rooms.values()].map(async (r) => (await r)?.save()));
  }
}
