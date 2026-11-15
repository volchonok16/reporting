// View history (step 9, as Figma's): who opened a file and when. A visit is an opening after half an hour
// without one; the first and the last opening and the number of visits are kept per person, people who came by
// a link without signing in as one line. Kept in files/<id>/views.json; seen by the owner and editors.

export interface ViewEntry {
  /** Null — guests by a link, without an account. */
  userId: string | null;
  first: number;
  last: number;
  visits: number;
}

/** Openings closer than this are one visit. */
export const VISIT_GAP = 30 * 60_000;
export const VIEWS_PER_FILE = 1000;

export function parseViews(text: string | null): ViewEntry[] {
  if (!text) return [];
  try {
    const list = JSON.parse(text) as unknown;
    return Array.isArray(list) ? (list as ViewEntry[]).filter((v) => v && typeof v.last === 'number') : [];
  } catch {
    return [];
  }
}

/** The list after `userId` opened the file at `now`; the oldest go first when it grows too long. */
export function recordView(list: readonly ViewEntry[], userId: string | null, now: number): ViewEntry[] {
  const out = list.map((v) => ({ ...v }));
  const own = out.find((v) => v.userId === userId);
  if (own) {
    if (now - own.last > VISIT_GAP) own.visits++;
    own.last = Math.max(own.last, now);
  } else out.push({ userId, first: now, last: now, visits: 1 });
  return out.sort((a, b) => b.last - a.last).slice(0, VIEWS_PER_FILE);
}
