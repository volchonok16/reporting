// The macOS app (apps/macos, ServerLink.swift): a WebSocket of the page cannot
// reach the server from simmetrika://app, so the app opens it — with the
// sign-in it keeps — and passes the messages. AppSocket is the part of the
// WebSocket API live.ts uses: readyState, send, close, open/message/close events.

type Kind = 'open' | 'message' | 'close';

interface Bridge {
  postMessage(message: { op: 'open'; id: number; path: string } | { op: 'send'; id: number; data: string } | { op: 'close'; id: number }): void;
}

const bridge = (): Bridge | null => (globalThis as unknown as { webkit?: { messageHandlers?: { csSocket?: Bridge } } }).webkit?.messageHandlers?.csSocket ?? null;

const open = new Map<number, AppSocket>();
let next = 1;

(globalThis as unknown as { __csSocket: (id: number, kind: Kind, data: string | null) => void }).__csSocket = (id, kind, data) => {
  open.get(id)?.arrived(kind, data);
};

/**
 * Where a link to send leads: the site — in the macOS app its server (set by the app), not simmetrika://app,
 * which means nothing to the one who gets the link.
 */
export function publicOrigin(): string {
  const server = (globalThis as unknown as { __csServer?: string }).__csServer;
  if (server) {
    try {
      return new URL(server).origin;
    } catch {
      // not an address: the page's own
    }
  }
  return location.origin;
}

/** Whether the app can open sockets to a server (one is set). */
export const appSockets = (): boolean => bridge() !== null;

export class AppSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = AppSocket.CONNECTING;
  private readonly id = next++;

  /** `path`: /api/live/<file>?… of the server. */
  constructor(path: string) {
    super();
    open.set(this.id, this);
    const b = bridge();
    if (b) b.postMessage({ op: 'open', id: this.id, path });
    else queueMicrotask(() => this.arrived('close', null));
  }

  send(data: string): void {
    if (this.readyState !== AppSocket.OPEN) throw new DOMException('Not open', 'InvalidStateError');
    bridge()?.postMessage({ op: 'send', id: this.id, data });
  }

  close(): void {
    if (this.readyState === AppSocket.CLOSED) return;
    bridge()?.postMessage({ op: 'close', id: this.id });
    this.arrived('close', null);
  }

  /** From the app. */
  arrived(kind: Kind, data: string | null): void {
    if (this.readyState === AppSocket.CLOSED) return;
    if (kind === 'open') {
      this.readyState = AppSocket.OPEN;
      this.dispatchEvent(new Event('open'));
    } else if (kind === 'message') {
      this.dispatchEvent(new MessageEvent('message', { data: data ?? '' }));
    } else {
      this.readyState = AppSocket.CLOSED;
      open.delete(this.id);
      this.dispatchEvent(new CloseEvent('close'));
    }
  }
}
