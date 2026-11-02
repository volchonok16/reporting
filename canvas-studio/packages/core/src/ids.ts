// Node identifiers (FR-DOC-005): unique within a file and never reused.
// Format: "<sessionId>:<counter>". Every editing session gets a fresh random
// session id, so two sessions can never mint the same identifier.

export type NodeId = string;

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Random identifier of `length` characters from [0-9a-z], using the platform CSPRNG. */
export function randomId(length = 10): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

export class IdGenerator {
  readonly sessionId: string;
  private counter: number;

  constructor(sessionId: string = randomId(), start = 0) {
    if (!/^[0-9a-z]+$/.test(sessionId)) throw new Error(`Invalid session id: ${sessionId}`);
    this.sessionId = sessionId;
    this.counter = start;
  }

  next(): NodeId {
    this.counter += 1;
    return `${this.sessionId}:${this.counter}`;
  }
}
