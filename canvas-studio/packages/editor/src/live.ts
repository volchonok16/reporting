// Live editing, the browser side (stage "Server", part 2): a WebSocket to the
// file's room. Local operations are sent in small batches and kept until the
// server confirms them; operations of others are applied as they come. When
// the connection drops, editing goes on: the batches wait, the session
// reconnects and catches up (the server sends what was missed, or the whole
// file). The document core resolves concurrent changes the same way everywhere.

import type { Document, Op } from '#core';
import type { ThreadChange } from './cloud.ts';

export interface Peer {
  id: string;
  userId: string | null;
  name: string;
  color: string;
  role: string;
}

/** What someone sees: centre of the visible part (world), zoom and screen size. */
export interface PeerView {
  x: number;
  y: number;
  zoom: number;
  width: number;
  height: number;
}

/**
 * Where someone is in the file: page, pointer (world coordinates), selection,
 * the visible part of the canvas (for those who follow) and a cursor chat message.
 */
export interface Presence {
  page: string | null;
  cursor: { x: number; y: number } | null;
  selection: string[];
  view: PeerView | null;
  chat: string | null;
}

/** A reaction flying from someone's pointer (step 10); `to` — the person a high five (✋) is given to. */
export interface Emote {
  emoji: string;
  x: number;
  y: number;
  page: string;
  to: string | null;
}

export type LiveState = 'connecting' | 'synced' | 'sending' | 'offline';

export interface LiveOptions {
  fileId: string;
  doc: Document;
  /** Viewers receive changes but never send (the role may change while the file is open). */
  canEdit: boolean;
  /** Version of the file the document was loaded at. */
  version: number | null;
  /** X-CS-Link value for a file opened by a share link. */
  link: string | null;
  /** A guest without an account: the name the others see (an animal's). */
  guest?: string;
  onState(state: LiveState): void;
  onPeers(peers: Peer[], you: string | null): void;
  /** The server sent the whole file: replace the document (returns the new one). */
  onSnapshot(snapshot: string): Document;
  onDeleted(): void;
  /** The owner changed this person's role while the file is open. */
  onRole(role: string): void;
  /** The owner took this person's access away: the session is over. */
  onRevoked(): void;
  /** This login session ended (signed out in another tab, a new password): the page starts over (BUG-162). */
  onSignedOut(): void;
  onPresence(from: string, presence: Presence): void;
  /** Someone asked everyone to follow them (null — the spotlight ended). */
  onSpotlight(from: string | null): void;
  /** A discussion was started, answered, resolved, moved or deleted. */
  onThread(change: ThreadChange): void;
  /** Someone sent an emote (never kept). */
  onEmote?(from: string, emote: Emote): void;
  /** Changes made earlier (another session, without a network) still to be sent. */
  pending?: Op[];
}

export class LiveSession {
  private readonly options: LiveOptions;
  private doc: Document;
  private ws: WebSocket | null = null;
  private seq: number | null = null;
  private you: string | null = null;
  private outbox: Op[] = [];
  private readonly unacked = new Map<number, Op[]>();
  private nextBatch = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retry = 0;
  private closed = false;
  private unsubscribe: () => void;
  private state: LiveState = 'connecting';
  private presence: Presence | null = null;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private presenceSentAt = 0;
  /** This person is in the spotlight (asked again after a reconnect). */
  private spotlightOn = false;
  private canEdit: boolean;

  constructor(options: LiveOptions) {
    this.options = options;
    this.canEdit = options.canEdit;
    this.doc = options.doc;
    this.unsubscribe = this.watch(this.doc);
    if (options.pending?.length && this.canEdit) this.outbox.push(...options.pending);
    this.connect();
  }

  /** Changes not confirmed by the server yet, in order (kept in the offline copy). */
  pendingOps(): Op[] {
    return [...[...this.unacked.values()].flat(), ...this.outbox];
  }

  /** Changes not yet confirmed by the server. */
  get pending(): boolean {
    return this.outbox.length > 0 || this.unacked.size > 0;
  }

  private watch(doc: Document): () => void {
    return doc.onLocalOps((ops) => {
      if (!this.canEdit || doc.readOnly) return;
      this.outbox.push(...ops);
      // A drag sends ~60 updates a second: group them.
      this.flushTimer ??= setTimeout(() => this.flush(), 40);
      this.setState(this.ws?.readyState === WebSocket.OPEN ? 'sending' : this.state);
    });
  }

  private connect(): void {
    if (this.closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const params = [this.options.link ? `link=${encodeURIComponent(this.options.link)}` : '', this.options.guest ? `guest=${encodeURIComponent(this.options.guest)}` : ''].filter(Boolean);
    const link = params.length ? `?${params.join('&')}` : '';
    const ws = new WebSocket(`${proto}://${location.host}/api/live/${encodeURIComponent(this.options.fileId)}${link}`);
    this.ws = ws;
    this.setState(this.seq === null ? 'connecting' : 'offline');
    ws.addEventListener('open', () => {
      this.retry = 0;
      ws.send(JSON.stringify({ type: 'hello', version: this.seq === null ? this.options.version : null, since: this.seq, rawSnapshot: true }));
    });
    ws.addEventListener('message', (e) => this.receive(String(e.data)));
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closed) return;
      this.setState('offline');
      // Back off: 0.5 s, 1 s, 2 s … up to 15 s.
      const wait = Math.min(15_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), wait);
    });
  }

  private receive(text: string): void {
    let msg: { type: string; [key: string]: unknown };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'welcome':
        this.you = msg.you as string;
        // Own edits must be newer than everything the room has seen (a loaded file carries no times).
        if (typeof msg.clock === 'number') this.doc.clock.observe({ counter: msg.clock, session: '' });
        if (this.seq === null) this.seq = msg.seq as number;
        // Batches sent before the connection dropped may not have arrived: send them again
        // (the core ignores what it already has).
        for (const ops of this.unacked.values()) this.outbox.unshift(...ops);
        this.unacked.clear();
        this.flush();
        if (!this.pending) this.setState('synced');
        if (this.presence) this.sendPresenceNow();
        if (this.spotlightOn) this.ws?.send(JSON.stringify({ type: 'spotlight', on: true }));
        break;
      case 'snapshot': {
        // Too far behind for a list of changes: take the whole file, keep own unsent work.
        const mine = [...this.outbox];
        this.unsubscribe();
        // A server that knows "rawSnapshot" puts the document itself in the message (no second escaping).
        this.doc = this.options.onSnapshot(typeof msg.snapshot === 'string' ? msg.snapshot : JSON.stringify(msg.snapshot));
        if (typeof msg.clock === 'number') this.doc.clock.observe({ counter: msg.clock, session: '' });
        if (mine.length > 0) this.doc.applyRemote(mine);
        this.unsubscribe = this.watch(this.doc);
        this.seq = msg.seq as number;
        break;
      }
      case 'ops':
        this.doc.applyRemote(msg.ops as Op[]);
        this.seq = Math.max(this.seq ?? 0, msg.seq as number);
        break;
      case 'ack':
        this.unacked.delete(msg.id as number);
        this.seq = Math.max(this.seq ?? 0, msg.seq as number);
        if (!this.pending) this.setState('synced');
        break;
      case 'presence':
        this.options.onPresence(msg.from as string, {
          page: (msg.page as string) ?? null,
          cursor: (msg.cursor as Presence['cursor']) ?? null,
          selection: (msg.selection as string[]) ?? [],
          view: (msg.view as PeerView) ?? null,
          chat: typeof msg.chat === 'string' && msg.chat ? msg.chat : null,
        });
        break;
      case 'emote':
        this.options.onEmote?.(msg.from as string, { emoji: String(msg.emoji), x: Number(msg.x), y: Number(msg.y), page: String(msg.page), to: typeof msg.to === 'string' ? msg.to : null });
        break;
      case 'spotlight':
        // Someone else took the spotlight: ours is over.
        if (msg.from !== this.you) this.spotlightOn = false;
        this.options.onSpotlight((msg.from as string) ?? null);
        break;
      case 'thread':
        this.options.onThread(msg as unknown as ThreadChange);
        break;
      case 'peers':
        this.options.onPeers(msg.peers as Peer[], this.you);
        break;
      case 'error':
        this.unacked.delete(msg.id as number);
        break;
      case 'deleted':
        this.closed = true;
        this.options.onDeleted();
        break;
      case 'role':
        this.canEdit = msg.role === 'owner' || msg.role === 'editor';
        // The server refuses what a viewer sends: unsent changes are dropped.
        if (!this.canEdit) {
          this.outbox = [];
          this.unacked.clear();
          if (this.state === 'sending') this.setState('synced');
        }
        this.options.onRole(msg.role as string);
        break;
      case 'revoked':
        this.closed = true;
        this.options.onRevoked();
        break;
      case 'signedOut':
        this.closed = true;
        this.options.onSignedOut();
        break;
    }
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.outbox.length === 0 || this.ws?.readyState !== WebSocket.OPEN || this.you === null) return;
    const id = ++this.nextBatch;
    const ops = this.outbox;
    this.outbox = [];
    this.unacked.set(id, ops);
    this.ws.send(JSON.stringify({ type: 'ops', id, ops }));
    this.setState('sending');
  }

  /** Tells the others where this person is; at most 20 times a second, the latest always goes. */
  sendPresence(presence: Presence): void {
    this.presence = presence;
    if (this.presenceTimer) return;
    const wait = Math.max(0, 50 - (Date.now() - this.presenceSentAt));
    this.presenceTimer = setTimeout(() => this.sendPresenceNow(), wait);
  }

  private sendPresenceNow(): void {
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.presenceTimer = null;
    if (!this.presence || this.ws?.readyState !== WebSocket.OPEN || this.you === null) return;
    this.presenceSentAt = Date.now();
    this.ws.send(JSON.stringify({ type: 'presence', ...this.presence }));
  }

  /** Sends an emote to everyone in the file (false — not connected). */
  sendEmote(emote: Emote): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN || this.you === null) return false;
    this.ws.send(JSON.stringify({ type: 'emote', ...emote }));
    return true;
  }

  /** Asks everyone in the file to follow this person, or ends it. */
  spotlight(on: boolean): void {
    this.spotlightOn = on;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'spotlight', on }));
  }

  /** This person's id in the room (null until connected). */
  get self(): string | null {
    return this.you;
  }

  /** Waits (a little) until everything is confirmed — before leaving the file. */
  async drain(timeoutMs = 3000): Promise<boolean> {
    this.flush();
    const until = Date.now() + timeoutMs;
    while (this.pending && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    return !this.pending;
  }

  close(): void {
    this.closed = true;
    this.unsubscribe();
    this.ws?.close();
    this.ws = null;
  }

  private setState(state: LiveState): void {
    if (state === this.state) return;
    this.state = state;
    this.options.onState(state);
  }
}
