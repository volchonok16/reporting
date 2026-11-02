// Lamport timestamps order every write so that replicas resolve concurrent
// edits of the same property the same way ("last writer wins", FR-DOC-008).

export interface Timestamp {
  readonly counter: number;
  readonly session: string;
}

export const ZERO_TIME: Timestamp = { counter: 0, session: '' };

/** Negative if a happened before b; ties are broken by session id. */
export function compareTime(a: Timestamp, b: Timestamp): number {
  if (a.counter !== b.counter) return a.counter - b.counter;
  if (a.session === b.session) return 0;
  return a.session < b.session ? -1 : 1;
}

export class LamportClock {
  readonly session: string;
  private counter = 0;

  constructor(session: string) {
    this.session = session;
  }

  /** Timestamp for a new local write. */
  tick(): Timestamp {
    this.counter += 1;
    return { counter: this.counter, session: this.session };
  }

  /** The latest counter this replica has seen or written (sent to newcomers with the file). */
  get now(): number {
    return this.counter;
  }

  /** Advance past a timestamp received from another replica. */
  observe(time: Timestamp): void {
    if (time.counter > this.counter) this.counter = time.counter;
  }
}
