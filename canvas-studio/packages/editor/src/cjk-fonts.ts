// Chinese, Japanese and Korean text falls back to Noto Sans SC, JP or KR (as in
// Figma), so it looks the same on every computer and for everyone in the file,
// whatever the system has. The faces come from our server (Google Fonts, OFL,
// fetched by the server once — browsers do not go to Google) and only when a
// text in the file needs them: they are a few megabytes each.

import type { Document } from '#core';
import { cjkScriptOf, type CjkScript } from '#layout';

const FAMILY: Record<CjkScript, string> = { SC: 'Noto Sans SC', JP: 'Noto Sans JP', KR: 'Noto Sans KR' };
/** Faces asked for (script and weight), loaded or not: each once. */
const asked = new Set<string>();

/** Which scripts and weights (regular or bold) the texts of the file use. */
function needed(doc: Document): Set<string> {
  const out = new Set<string>();
  for (const page of doc.pages()) {
    doc.store.walk(page, (id) => {
      if (doc.type(id) !== 'TEXT') return;
      const script = cjkScriptOf(doc.get(id, 'characters'));
      if (!script) return;
      const weights = [doc.get(id, 'fontWeight'), ...doc.get(id, 'textRuns').map((r) => r.style.fontWeight ?? 0)].filter((w) => w > 0);
      for (const w of weights) out.add(`${script}|${w >= 600 ? 700 : 400}`);
    });
  }
  return out;
}

/** Loads what the file's texts need and not yet asked; calls back with the families that became ready. */
export function loadCjkFonts(doc: Document, ready: (families: string[]) => void): void {
  if (typeof document === 'undefined' || !document.fonts || typeof FontFace === 'undefined') return;
  for (const key of needed(doc)) {
    if (asked.has(key)) continue;
    asked.add(key);
    const [script, weight] = key.split('|') as [CjkScript, string];
    const family = FAMILY[script];
    void fetch(`/api/fonts/google?family=${encodeURIComponent(family)}&weight=${weight}`, { headers: { 'X-CS': '1' } })
      .then((res) => (res.ok ? res.arrayBuffer() : null))
      .then(async (bytes) => {
        if (!bytes) return;
        const face = new FontFace(family, bytes, { weight });
        await face.load();
        document.fonts.add(face);
        ready([family]);
      })
      .catch(() => {
        // Offline or no such face: the system's fallback stays; asked again next time the editor opens.
        asked.delete(key);
      });
  }
}
