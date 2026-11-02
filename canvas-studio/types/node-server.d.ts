// Minimal ambient declarations for the Node built-ins the server uses.
// The project deliberately avoids @types/node (no external dependencies), so
// only what the code calls is declared here — extend it as the server grows.

declare class Buffer extends Uint8Array {
  static from(data: string | ArrayBuffer | Uint8Array | readonly number[], encoding?: string): Buffer;
  static concat(list: readonly Uint8Array[], totalLength?: number): Buffer;
  static alloc(size: number, fill?: number): Buffer;
  static byteLength(text: string, encoding?: string): number;
  static isBuffer(value: unknown): value is Buffer;
  toString(encoding?: string, start?: number, end?: number): string;
  subarray(start?: number, end?: number): Buffer;
  readUInt16BE(offset: number): number;
  readUInt32BE(offset: number): number;
  writeUInt16BE(value: number, offset: number): number;
  writeUInt32BE(value: number, offset: number): number;
  equals(other: Uint8Array): boolean;
}

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exit(code?: number): never;
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): void;
  cwd(): string;
  platform: string;
};

declare module 'node:events' {
  export class EventEmitter {
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
    emit(event: string, ...args: unknown[]): boolean;
  }
}

declare module 'node:net' {
  import { EventEmitter } from 'node:events';
  export class Socket extends EventEmitter {
    remoteAddress?: string;
    write(data: Uint8Array | string, cb?: (err?: Error) => void): boolean;
    end(data?: Uint8Array | string): this;
    destroy(error?: Error): this;
    setNoDelay(noDelay?: boolean): this;
    setTimeout(ms: number, cb?: () => void): this;
    setEncoding(encoding: 'utf8'): this;
    readonly destroyed: boolean;
    readonly writableLength: number;
  }
  export interface AddressInfo {
    port: number;
    address: string;
  }
  export function connect(options: { host: string; port: number }, onConnect?: () => void): Socket;
  export class Server extends EventEmitter {
    listen(port: number, host: string, cb?: () => void): this;
    close(cb?: (err?: Error) => void): this;
    address(): AddressInfo | string | null;
  }
  export function createServer(onConnection: (socket: Socket) => void): Server;
  export function isIP(input: string): 0 | 4 | 6;
  export type LookupFunction = (hostname: string, options: { family?: number; all?: boolean; [key: string]: unknown }, callback: (error: Error | null, address: string | { address: string; family: number }[], family?: number) => void) => void;
}

declare module 'node:dns' {
  export interface LookupAddress {
    address: string;
    family: number;
  }
  export function lookup(hostname: string, options: { all: true; family?: number; [key: string]: unknown }, callback: (error: Error | null, addresses: LookupAddress[]) => void): void;
}

declare module 'node:tls' {
  import type { Socket } from 'node:net';
  export class TLSSocket extends Socket {}
  export function connect(options: { host?: string; port?: number; socket?: Socket; servername?: string }, onSecure?: () => void): TLSSocket;
}

declare module 'node:http' {
  import { EventEmitter } from 'node:events';
  import type { AddressInfo, Socket } from 'node:net';
  export interface IncomingHttpHeaders {
    [name: string]: string | string[] | undefined;
  }
  export class IncomingMessage extends EventEmitter {
    method?: string;
    url?: string;
    headers: IncomingHttpHeaders;
    socket: Socket;
    [Symbol.asyncIterator](): AsyncIterableIterator<Buffer>;
    destroy(error?: Error): this;
    /** Answers to our own requests (link previews). */
    statusCode?: number;
  }
  export class ClientRequest extends EventEmitter {
    end(): this;
    destroy(error?: Error): this;
  }
  export interface RequestOptions {
    method?: string;
    headers?: Record<string, string>;
    timeout?: number;
    lookup?: import('node:net').LookupFunction;
  }
  export function request(url: URL, options: RequestOptions, callback: (res: IncomingMessage) => void): ClientRequest;
  export class ServerResponse extends EventEmitter {
    statusCode: number;
    readonly headersSent: boolean;
    setHeader(name: string, value: string | number | readonly string[]): this;
    getHeader(name: string): string | number | string[] | undefined;
    writeHead(status: number, headers?: Record<string, string | number | readonly string[]>): this;
    write(chunk: Uint8Array | string): boolean;
    end(chunk?: Uint8Array | string): this;
    destroy(error?: Error): this;
  }
  export class Server extends EventEmitter {
    listen(port: number, host: string, cb?: () => void): this;
    close(cb?: (err?: Error) => void): this;
    closeAllConnections(): void;
    address(): AddressInfo | string | null;
  }
  export function createServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Server;
}

declare module 'node:https' {
  import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
  export function request(url: URL, options: RequestOptions, callback: (res: IncomingMessage) => void): ClientRequest;
}

declare module 'node:crypto' {
  export function randomBytes(size: number): Buffer;
  export function randomUUID(): string;
  export function randomInt(min: number, max: number): number;
  export function scrypt(password: string | Uint8Array, salt: string | Uint8Array, keylen: number, options: { N: number; r: number; p: number; maxmem?: number }, cb: (err: Error | null, key: Buffer) => void): void;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  interface Hash {
    update(data: string | Uint8Array, encoding?: string): Hash;
    digest(encoding: 'hex' | 'base64' | 'base64url'): string;
    digest(): Buffer;
  }
  export function createHash(algorithm: 'sha256' | 'sha1' | 'sha512'): Hash;
  export function createHmac(algorithm: 'sha256', key: Uint8Array | string): Hash;
}

declare module 'node:fs' {
  import { EventEmitter } from 'node:events';
  /** A file read piece by piece (the heavy files are streamed, never read whole). */
  export class ReadStream extends EventEmitter {
    pipe<T>(destination: T): T;
  }
  export function createReadStream(path: string): ReadStream;
}

declare module 'node:fs/promises' {
  interface FileHandle {
    writeFile(data: string | Uint8Array): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }
  interface Stats {
    isFile(): boolean;
    isDirectory(): boolean;
    size: number;
    mtimeMs: number;
  }
  interface Dirent {
    name: string;
    isFile(): boolean;
    isDirectory(): boolean;
  }
  export function readFile(path: string): Promise<Buffer>;
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
  export function writeFile(path: string, data: string | Uint8Array): Promise<void>;
  export function appendFile(path: string, data: string | Uint8Array): Promise<void>;
  export function open(path: string, flags: string): Promise<FileHandle>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function rename(from: string, to: string): Promise<void>;
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean; maxRetries?: number; retryDelay?: number }): Promise<void>;
  export function stat(path: string): Promise<Stats>;
  export function readdir(path: string): Promise<string[]>;
  export function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  /** Free space of the file system holding `path` (Node 18.15+). */
  export function statfs(path: string): Promise<{ bsize: number; bavail: number; blocks: number }>;
}

declare module 'node:zlib' {
  export function gzipSync(data: string | Uint8Array, options?: { level?: number }): Buffer;
  export function gunzipSync(data: Uint8Array): Buffer;
  export function deflateRawSync(data: string | Uint8Array): Buffer;
  /** Node 23.8+; the tests check our own zstd decoder against it. */
  export function zstdCompressSync(data: string | Uint8Array, options?: { params?: Record<number, number> }): Buffer;
  export function zstdDecompressSync(data: Uint8Array): Buffer;
  export const constants: { ZSTD_c_compressionLevel: number; ZSTD_c_checksumFlag: number };
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function normalize(path: string): string;
  export function dirname(path: string): string;
  export function basename(path: string, ext?: string): string;
  export function extname(path: string): string;
  export function relative(from: string, to: string): string;
  export const sep: string;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}

interface ImportMeta {
  url: string;
  dirname?: string;
}
