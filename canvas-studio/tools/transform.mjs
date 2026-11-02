// Source transform shared by the dev server and the build.
// TypeScript is turned into JavaScript with Node's built-in type stripper
// (node:module.stripTypeScriptTypes), so the project needs no compiler package.
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Strip types from a .ts module. With `rewriteExtensions`, relative `.ts` specifiers become `.js`. */
export function transformTs(source, { rewriteExtensions = false } = {}) {
  let code = stripTypeScriptTypes(source, { mode: 'strip' });
  if (rewriteExtensions) code = rewriteTsSpecifiers(code);
  return code;
}

/** Rewrites `from './x.ts'` and `import('./x.ts')` to `.js`. Only relative specifiers are touched. */
export function rewriteTsSpecifiers(code) {
  return code.replace(/(from\s*|import\s*\(\s*)(['"])(\.{1,2}\/[^'"]+?)\.ts\2/g, '$1$2$3.js$2');
}

/** Import map generated from the "imports" field of the root package.json. */
export function importMap({ extension = '.ts' } = {}) {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const imports = {};
  for (const [key, target] of Object.entries(pkg.imports ?? {})) {
    imports[key] = '/' + target.replace(/^\.\//, '').replace(/\.ts$/, extension);
  }
  return JSON.stringify({ imports }, null, 2);
}

/** Inserts the import map into the HTML entry and points scripts at the right extension. */
export function transformHtml(html, { extension = '.ts' } = {}) {
  const tag = `<script type="importmap">\n${importMap({ extension })}\n</script>`;
  let out = html.replace('<!-- importmap -->', tag);
  if (extension === '.js') out = out.replace(/(src="[^"]+)\.ts"/g, '$1.js"');
  return out;
}
