// A layer as a standalone HTML file (export format "HTML"): the same HTML and
// CSS as the "Code" tab gives, but with everything inside one file — pictures
// as data URLs, vectors as inline SVG, and the fonts: the file's own fonts as
// @font-face, the others from Google Fonts (a family it does not have simply
// falls back). Without the fonts the page showed the browser's default.

import type { Document, NodeId } from '#core';
import { exportSvg, layerPicture, type Canvas2DRenderer } from '#render';
import { htmlTree, withInlineAssets } from './dev-code.ts';
import type { Editor } from './editor.ts';
import { embeddedFonts } from './fonts.ts';

/** Families every computer has (or that Google Fonts has not): no request for them. */
const SYSTEM_FONTS = new Set(['system-ui', '-apple-system', 'sf pro', 'sf pro text', 'sf pro display', 'helvetica', 'helvetica neue', 'arial', 'times new roman', 'times', 'georgia', 'verdana', 'tahoma', 'trebuchet ms', 'courier new', 'segoe ui', 'menlo', 'monaco', 'consolas']);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Every font face the texts inside a layer use: family → "italic,weight" pairs. */
function usedFonts(doc: Document, id: NodeId): Map<string, Set<string>> {
  const used = new Map<string, Set<string>>();
  const add = (family: string, weight: number, italic: boolean) => {
    if (!family) return;
    if (!used.has(family)) used.set(family, new Set());
    used.get(family)!.add(`${italic ? 1 : 0},${Math.round(weight / 100) * 100 || 400}`);
  };
  doc.store.walk(id, (n) => {
    if (doc.type(n) !== 'TEXT' || doc.get(n, 'visible') === false) return;
    const family = doc.get(n, 'fontFamily');
    const weight = doc.get(n, 'fontWeight');
    const italic = doc.get(n, 'italic');
    add(family, weight, italic);
    for (const r of doc.get(n, 'textRuns')) add(r.style.fontFamily ?? family, r.style.fontWeight ?? weight, r.style.italic ?? italic);
  });
  return used;
}

/** The <head> part bringing the fonts in. */
function fontsHead(doc: Document, used: Map<string, Set<string>>): string {
  const own = embeddedFonts(doc);
  const faces: string[] = [];
  const links: string[] = [];
  for (const [family, faceSet] of used) {
    const mine = own.filter((f) => f.family === family);
    if (mine.length) {
      for (const f of mine) {
        const blob = doc.store.blobs.get(f.hash);
        if (!blob) continue;
        faces.push(`@font-face { font-family: "${family}"; src: url("data:${blob.mime};base64,${blob.data}"); font-weight: ${f.weight === 0 ? '1 1000' : f.weight}; font-style: ${f.italic ? 'italic' : 'normal'}; font-display: swap; }`);
      }
      continue;
    }
    if (SYSTEM_FONTS.has(family.toLowerCase())) continue;
    const pairs = [...faceSet].sort((a, b) => (a < b ? -1 : 1)).join(';');
    links.push(`<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:ital,wght@${pairs}&amp;display=swap">`);
  }
  if (links.length) links.unshift('<link rel="preconnect" href="https://fonts.googleapis.com">', '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>');
  return [...links, faces.length ? `<style>\n${faces.join('\n')}\n</style>` : ''].filter(Boolean).join('\n');
}

/** The layer as one HTML page; `bare` — the layer is the page itself, edge to edge (to change it by a description, FEAT-172). */
export function htmlDocument(editor: Editor, renderer: Canvas2DRenderer, id: NodeId, bare = false): string {
  const doc = editor.doc;
  const body = withInlineAssets(
    {
      image: (hash) => {
        const blob = doc.store.blobs.get(hash);
        return blob ? `data:${blob.mime};base64,${blob.data}` : null;
      },
      vector: (n) => {
        const { svg } = exportSvg(editor.scene, editor.measurer, [n], renderer.images, { picture: (p) => layerPicture(renderer, editor.scene, p) });
        // The element of the layer gives the place and the size; the drawing fills it.
        return svg.replace(/^<\?xml[^>]*>\s*/, '').replace(/<svg\b/, '<svg style="display:block;width:100%;height:100%;overflow:visible"');
      },
    },
    // A page is the whole layer: the panel's cut of deep trees would leave holes in it (and the model would change half a layout).
    () => htmlTree(doc, id, undefined, { depth: Infinity, layers: Infinity }, bare),
  );
  const title = esc(String(doc.get(id, 'name')));
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${fontsHead(doc, usedFonts(doc, id))}
<style>
html, body { margin: 0; }
/* Sizes are the layers' own, padding and border inside (as in the editor and in Figma): without it a 1920 px block with 120 px padding came out 2160 wide. */
*, *::before, *::after { box-sizing: border-box; }
${bare ? 'body > * { margin: 0 !important; }' : 'body { display: flex; justify-content: center; align-items: flex-start; min-height: 100vh; padding: 40px 16px; box-sizing: border-box; background: #f5f5f5; }'}
</style>
</head>
<body>
${body}
</body>
</html>
`;
}
