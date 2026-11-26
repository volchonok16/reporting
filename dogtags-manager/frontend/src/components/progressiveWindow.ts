/** Transport pages stay at the server's 500-row bound; presentation never retains an entire file. */
export type DisplayRows = '500' | '1000' | 'all';
export type Cursor = string | number | undefined;
export function retainedPages(mode: DisplayRows): number { return mode === '500' ? 1 : mode === '1000' ? 2 : 3; }
export function windowIndices(indices: readonly number[], active: number, mode: DisplayRows): number[] {
  return [...new Set([...indices, active])].sort((a, b) => Math.abs(a - active) - Math.abs(b - active) || a - b)
    .slice(0, retainedPages(mode)).sort((a, b) => a - b);
}
export function pageCursor(ledger: readonly Cursor[], target: number, next: Cursor | null): { cursor: Cursor } | undefined {
  if (target < 0 || target > ledger.length) return undefined;
  if (target < ledger.length) return { cursor: ledger[target] };
  return next == null ? undefined : { cursor: next };
}
