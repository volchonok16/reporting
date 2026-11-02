// WebSocket (RFC 6455), server side, on Node's own sockets — no packages.
// Only what the live editing needs: the handshake, text messages (fragmented
// or not), ping/pong to notice dead connections, close. Client frames must be
// masked (the standard requires it); a message is limited in size.

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Images travel inside operations: a message may be large, but not unbounded. */
export const MAX_MESSAGE = 64 * 1024 * 1024;
/** Someone who cannot edit sends only pointers, selections and chat (BUG-160). */
export const VIEWER_MESSAGE = 256 * 1024;
const PING_EVERY = 25_000;

export class WebSocketConnection {
  private readonly socket: Socket;
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentsSize = 0;
  private closed = false;
  private alive = true;
  private readonly timer: ReturnType<typeof setInterval>;
  /** Largest message accepted now: the room raises it for editors (pictures travel in their operations). */
  maxMessage = VIEWER_MESSAGE;
  onMessage: (text: string) => void = () => {};
  onClose: () => void = () => {};
  /** Called once when the connection ends, whoever else listens (the per-address count). */
  onEnd: () => void = () => {};

  constructor(socket: Socket) {
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
    // Proxies and sleeping laptops drop connections silently: ping, and give up without a pong.
    this.timer = setInterval(() => {
      if (!this.alive) {
        this.socket.destroy();
        return;
      }
      this.alive = false;
      this.frame(0x9, Buffer.alloc(0));
    }, PING_EVERY);
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  send(text: string): void {
    if (!this.closed) this.frame(0x1, Buffer.from(text, 'utf8'));
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    const head = Buffer.alloc(2);
    head.writeUInt16BE(code, 0);
    const payload = Buffer.concat([head, Buffer.from(reason, 'utf8')]);
    this.frame(0x8, payload);
    this.socket.end();
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.onClose();
    this.onEnd();
  }

  private frame(opcode: number, payload: Buffer): void {
    const n = payload.length;
    const head = n < 126 ? Buffer.alloc(2) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    if (n < 126) head[1] = n;
    else if (n < 65536) {
      head[1] = 126;
      head.writeUInt16BE(n, 2);
    } else {
      head[1] = 127;
      head.writeUInt32BE(Math.floor(n / 2 ** 32), 2);
      head.writeUInt32BE(n >>> 0, 6);
    }
    this.socket.write(Buffer.concat([head, payload]));
  }

  private receive(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.closed || this.buffer.length < 2) return;
      const b0 = this.buffer[0]!;
      const b1 = this.buffer[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      if ((b1 & 0x80) === 0) return this.close(1002, 'unmasked frame');
      let length = b1 & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = this.buffer.readUInt32BE(2) * 2 ** 32 + this.buffer.readUInt32BE(6);
        offset = 10;
      }
      if (length > this.maxMessage) return this.close(1009, 'message too big');
      if (this.buffer.length < offset + 4 + length) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i & 3]!;
      this.buffer = this.buffer.subarray(offset + 4 + length);
      this.alive = true;
      if (opcode === 0x8) return this.close();
      if (opcode === 0x9) {
        this.frame(0xa, payload);
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x2) return this.close(1003, 'text only');
      if (opcode === 0x1 || opcode === 0x0) {
        this.fragmentsSize += payload.length;
        if (this.fragmentsSize > this.maxMessage) return this.close(1009, 'message too big');
        this.fragments.push(payload);
        if (fin) {
          const text = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          this.fragmentsSize = 0;
          this.onMessage(text);
        }
      }
    }
  }
}

/** Completes the handshake of an upgrade request; null — not a WebSocket request (the socket is closed). */
export function acceptWebSocket(req: IncomingMessage, socket: Socket): WebSocketConnection | null {
  const key = req.headers['sec-websocket-key'];
  if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || typeof key !== 'string' || req.headers['sec-websocket-version'] !== '13') {
    rejectUpgrade(socket, 400, 'Bad Request');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return new WebSocketConnection(socket);
}

export function rejectUpgrade(socket: Socket, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}
