// Variables as code (FR-VAR-041): CSS custom properties, SCSS, a JS / TS
// object, a Tailwind config, Swift (SwiftUI), Kotlin (Compose) and Android XML
// resources, with a name template of one's own.
//
// Every format carries every mode and every extended collection (FR-VAR-013):
// CSS as `[data-…]` blocks with only what differs, SCSS as maps, JS / TS as an
// object per mode, Swift and Kotlin as one value of a tokens type per mode,
// Android as a resources file per mode (`values-night` for a dark one). An alias
// stays a reference where the language has one (CSS `var()`, SCSS `$`);
// elsewhere, and for expressions, the computed value is written.

import { allVariables, baseCollection, extensionsOf, isExtension, resolveInMode, rawValue } from '#components';
import { isAlias, isColorValue, tr, type Color, type Document, type NodeId, type VariableLiteral, type VariableScope, type VariableType } from '#core';

export type TokenFormat = 'css' | 'scss' | 'js' | 'ts' | 'tailwind' | 'swift' | 'kotlin' | 'android';
export type NameCase = 'kebab' | 'snake' | 'camel' | 'pascal' | 'constant';

export interface TokenCodeOptions {
  format: TokenFormat;
  /** `{collection}`, `{group}`, `{name}` (the last part), `{path}` (group and name). */
  template: string;
  nameCase: NameCase;
  /** Cyrillic and other letters spelled in Latin (Android resource names need it). */
  latin: boolean;
  /** Names in code set on a variable (CSS, iOS, Android) win over the template. */
  useCodeNames: boolean;
  /** Collections to write; null — all. */
  collections: readonly NodeId[] | null;
}

export const TOKEN_FORMATS: { id: TokenFormat; label: string; file: string; nameCase: NameCase; latin: boolean }[] = [
  { id: 'css', label: 'CSS', file: 'tokens.css', nameCase: 'kebab', latin: false },
  { id: 'scss', label: 'SCSS', file: '_tokens.scss', nameCase: 'kebab', latin: false },
  { id: 'js', label: 'JavaScript', file: 'tokens.js', nameCase: 'camel', latin: true },
  { id: 'ts', label: 'TypeScript', file: 'tokens.ts', nameCase: 'camel', latin: true },
  { id: 'tailwind', label: 'Tailwind', file: 'tailwind.tokens.js', nameCase: 'kebab', latin: true },
  { id: 'swift', label: 'Swift (SwiftUI)', file: 'Tokens.swift', nameCase: 'camel', latin: true },
  { id: 'kotlin', label: 'Kotlin (Compose)', file: 'Tokens.kt', nameCase: 'camel', latin: true },
  { id: 'android', label: 'Android XML', file: 'tokens.xml', nameCase: 'snake', latin: true },
];

export function defaultTokenOptions(format: TokenFormat = 'css'): TokenCodeOptions {
  const f = TOKEN_FORMATS.find((x) => x.id === format)!;
  return { format, template: '{path}', nameCase: f.nameCase, latin: f.latin, useCodeNames: true, collections: null };
}

// ---------- names ----------

const LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function toLatin(s: string): string {
  return [...s].map((ch) => {
    const low = ch.toLowerCase();
    const t = LATIN[low];
    if (t === undefined) return ch;
    return ch === low ? t : t.charAt(0).toUpperCase() + t.slice(1);
  }).join('').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Words of a name: split at anything but letters and digits, and at camelCase humps. */
function words(s: string): string[] {
  return s
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

function applyCase(ws: string[], c: NameCase): string {
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  switch (c) {
    case 'kebab':
      return ws.join('-');
    case 'snake':
      return ws.join('_');
    case 'constant':
      return ws.join('_').toUpperCase();
    case 'pascal':
      return ws.map(cap).join('');
    case 'camel':
      return ws.map((w, i) => (i === 0 ? w : cap(w))).join('');
  }
}

/** A name by the template; an identifier never starts with a digit. */
export function tokenName(o: TokenCodeOptions, collection: string, variable: string): string {
  const parts = variable.split('/').map((p) => p.trim()).filter(Boolean);
  const leaf = parts.pop() ?? variable;
  const text = (o.template || '{path}')
    .replace(/\{collection\}/g, ` ${collection} `)
    .replace(/\{group\}/g, ` ${parts.join(' ')} `)
    .replace(/\{name\}/g, ` ${leaf} `)
    .replace(/\{path\}/g, ` ${[...parts, leaf].join(' ')} `);
  const name = applyCase(words(o.latin ? toLatin(text) : text), o.nameCase) || 'token';
  return /^\p{N}/u.test(name) ? `_${name}` : name;
}

// ---------- the model: collections, columns (modes and extensions), values ----------

interface Column {
  /** The extension this column shows, or null for the collection itself. */
  scope: NodeId | null;
  mode: string;
  modeName: string;
  extName: string | null;
  isDefaultMode: boolean;
}

interface Token {
  v: NodeId;
  type: VariableType;
  name: string;
  dimension: boolean;
  /** A text size (sp on Android). */
  fontSize: boolean;
  /** Per column: the computed value (undefined for an error) and an alias target worth keeping. */
  values: { value: VariableLiteral | undefined; alias: NodeId | null }[];
}

interface Group {
  collection: NodeId;
  name: string;
  columns: Column[];
  tokens: Token[];
}

const SIZE_SCOPES: ReadonlySet<VariableScope> = new Set(['WIDTH_HEIGHT', 'CORNER_RADIUS', 'GAP', 'STROKE_WIDTH', 'FONT_SIZE', 'LINE_HEIGHT', 'LETTER_SPACING', 'PARAGRAPH_SPACING']);
const SIZE_WORDS = /(size|space|spacing|gap|radius|radii|padding|margin|width|height|inset|offset|stroke|border|indent|line-?height|letter|blur|spread|shadow|gutter|отступ|размер|радиус|скругл|ширин|высот|промежут|зазор|обводк)/i;

/** Whether a number is a length (px, pt, dp) rather than a count, weight or percent. */
function isDimension(doc: Document, v: NodeId): boolean {
  const scopes = doc.get(v, 'scopes');
  if (scopes.length > 0) return scopes.every((s) => SIZE_SCOPES.has(s));
  return SIZE_WORDS.test(doc.get(v, 'name'));
}

function modelOf(doc: Document, o: TokenCodeOptions): Group[] {
  const chosen = o.collections ? new Set(o.collections) : null;
  const groups: Group[] = [];
  const used = new Set<string>();
  for (const c of doc.collections()) {
    if (isExtension(doc, c) || (chosen && !chosen.has(c))) continue;
    const vars = doc.children(c).filter((v) => doc.type(v) === 'VARIABLE');
    if (vars.length === 0) continue;
    const modes = doc.get(c, 'modes');
    const columns: Column[] = modes.map((m, i) => ({ scope: null, mode: m.id, modeName: m.name, extName: null, isDefaultMode: i === 0 }));
    for (const e of extensionsOf(doc, c)) {
      modes.forEach((m, i) => columns.push({ scope: e, mode: m.id, modeName: m.name, extName: doc.get(e, 'name'), isDefaultMode: i === 0 }));
    }
    const tokens: Token[] = vars.map((v) => {
      let name = codeName(doc, v, o) ?? tokenName(o, doc.get(c, 'name'), doc.get(v, 'name'));
      for (let k = 2; used.has(name); k++) name = `${codeName(doc, v, o) ?? tokenName(o, doc.get(c, 'name'), doc.get(v, 'name'))}${o.nameCase === 'kebab' ? '-' : '_'}${k}`;
      used.add(name);
      return {
        v,
        type: doc.get(v, 'varType'),
        name,
        dimension: doc.get(v, 'varType') === 'FLOAT' && isDimension(doc, v),
        fontSize: doc.get(v, 'scopes').includes('FONT_SIZE') || /font-?size|размер-?шрифт/i.test(doc.get(v, 'name')),
        values: columns.map((col) => {
          const raw = rawValue(doc, v, col.mode, col.scope ?? undefined);
          const alias = isAlias(raw) && raw.opacity === undefined && allVariables(doc).includes(raw.id) ? raw.id : null;
          return { value: resolveInMode(doc, v, col.mode, col.scope ?? undefined), alias };
        }),
      };
    });
    groups.push({ collection: c, name: doc.get(c, 'name'), columns, tokens });
  }
  return groups;
}

/** A name set on the variable for this language (FR-VAR-023), when the options allow. */
function codeName(doc: Document, v: NodeId, o: TokenCodeOptions): string | null {
  if (!o.useCodeNames) return null;
  const syntax = doc.get(v, 'codeSyntax');
  if (o.format === 'css' || o.format === 'scss' || o.format === 'tailwind') {
    const web = syntax.WEB?.trim();
    if (!web) return null;
    const inner = /^var\(\s*--([^,\s)]+)/.exec(web)?.[1] ?? web.replace(/^--/, '');
    return inner || null;
  }
  if (o.format === 'swift') return syntax.IOS?.trim().split('.').pop() || null;
  if (o.format === 'kotlin' || o.format === 'android') return syntax.ANDROID?.trim().split('.').pop() || null;
  return null;
}

// ---------- values per language ----------

const hex2 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0').toUpperCase();
const num = (v: number) => String(Math.round(v * 10000) / 10000);
const rgbHex = (c: Color) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;

function cssColor(c: Color): string {
  if (c.a >= 1) return rgbHex(c);
  return `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${num(c.a)})`;
}

const jsString = (s: string) => JSON.stringify(s);

function cssValue(t: Token, value: VariableLiteral): string {
  if (isColorValue(value)) return cssColor(value);
  if (typeof value === 'number') return t.dimension && value !== 0 ? `${num(value)}px` : num(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return jsString(value);
}

function jsValue(t: Token, value: VariableLiteral): string {
  if (isColorValue(value)) return jsString(cssColor(value));
  if (typeof value === 'number') return num(value);
  if (typeof value === 'boolean') return String(value);
  return jsString(value);
}

const slugOf = (s: string) => applyCase(words(toLatin(s)), 'kebab') || 'mode';

// ---------- formats ----------

function css(groups: Group[]): string {
  const root: string[] = [];
  const blocks: string[] = [];
  for (const g of groups) {
    const attr = `data-${slugOf(g.name)}`;
    root.push(`  /* ${g.name} */`);
    const base = g.columns.findIndex((c) => c.scope === null && c.isDefaultMode);
    const line = (t: Token, i: number) => {
      const x = t.values[i]!;
      if (x.alias) {
        const target = groups.flatMap((gg) => gg.tokens).find((tt) => tt.v === x.alias);
        if (target) return `  --${t.name}: var(--${target.name});`;
      }
      return x.value === undefined ? null : `  --${t.name}: ${cssValue(t, x.value)};`;
    };
    for (const t of g.tokens) {
      const l = line(t, base);
      if (l) root.push(l);
    }
    // Blocks in cascade order: modes, an extension, an extension in a mode (two attributes win).
    // Each holds only what differs from what the earlier blocks already give there.
    const cascade = (t: Token, col: Column): string | null => {
      const baseMode = g.columns.findIndex((c) => c.scope === null && c.mode === col.mode);
      if (col.scope === null || col.isDefaultMode) return line(t, base);
      const extDefault = g.columns.findIndex((c) => c.scope === col.scope && c.isDefaultMode);
      const fromExt = line(t, extDefault);
      return fromExt !== line(t, base) ? fromExt : line(t, baseMode);
    };
    const order = g.columns.map((col, i) => ({ col, i })).sort((a, b) => rank(a.col) - rank(b.col));
    function rank(c: Column): number {
      return c.scope === null ? 0 : c.isDefaultMode ? 1 : 2;
    }
    order.forEach(({ col, i }) => {
      if (i === base) return;
      const lines = g.tokens.map((t) => {
        const own = line(t, i);
        return own !== null && own !== cascade(t, col) ? own : null;
      }).filter((l): l is string => l !== null);
      if (lines.length === 0) return;
      const mode = col.isDefaultMode ? '' : `[${attr}="${slugOf(col.modeName)}"]`;
      const selector = col.scope === null ? mode : `[${attr}-extension="${slugOf(col.extName!)}"]${mode}`;
      blocks.push(`/* ${g.name}${col.extName ? ` · ${col.extName}` : ''} · ${col.modeName} */\n${selector} {\n${lines.join('\n')}\n}`);
    });
  }
  return [`:root {\n${root.join('\n')}\n}`, ...blocks].join('\n\n') + '\n';
}

function scss(groups: Group[]): string {
  const out: string[] = [];
  for (const g of groups) {
    out.push(`// ${g.name}`);
    const base = g.columns.findIndex((c) => c.scope === null && c.isDefaultMode);
    for (const t of g.tokens) {
      const x = t.values[base]!;
      const target = x.alias ? groups.flatMap((gg) => gg.tokens).find((tt) => tt.v === x.alias) : null;
      if (target) out.push(`$${t.name}: $${target.name};`);
      else if (x.value !== undefined) out.push(`$${t.name}: ${cssValue(t, x.value)};`);
    }
    if (g.columns.length > 1) {
      // Every mode (and extension) as a map: map.get($theme-modes, dark, color-bg).
      const entries = g.columns.map((col) => {
        const key = slugOf(col.extName ? `${col.extName} ${col.modeName}` : col.modeName);
        const pairs = g.tokens.map((t) => {
          const v = t.values[g.columns.indexOf(col)]!.value;
          return v === undefined ? null : `    ${t.name}: ${cssValue(t, v)},`;
        }).filter(Boolean);
        return `  ${key}: (\n${pairs.join('\n')}\n  ),`;
      });
      out.push(`\n$${slugOf(g.name)}-modes: (\n${entries.join('\n')}\n);`);
    }
    out.push('');
  }
  return out.join('\n');
}

function jsLike(groups: Group[], ts: boolean): string {
  const out: string[] = [];
  for (const g of groups) {
    const name = applyCase(words(toLatin(g.name)), 'camel') || 'tokens';
    out.push(`/** ${g.name} */`);
    out.push(`export const ${/^\d/.test(name) ? `_${name}` : name} = {`);
    g.columns.forEach((col, i) => {
      const key = applyCase(words(toLatin(col.extName ? `${col.extName} ${col.modeName}` : col.modeName)), 'camel') || `mode${i + 1}`;
      out.push(`  ${/^[A-Za-z_$][\w$]*$/.test(key) ? key : jsString(key)}: {`);
      for (const t of g.tokens) {
        const v = t.values[i]!.value;
        if (v !== undefined) out.push(`    ${/^[A-Za-z_$][\w$]*$/.test(t.name) ? t.name : jsString(t.name)}: ${jsValue(t, v)},`);
      }
      out.push('  },');
    });
    out.push(ts ? '} as const;' : '};');
    if (ts) {
      const first = applyCase(words(toLatin(g.columns[0]!.modeName)), 'camel') || 'mode1';
      out.push(`export type ${applyCase(words(toLatin(g.name)), 'pascal') || 'Tokens'}Tokens = { [K in keyof typeof ${name}.${first}]: (typeof ${name}.${first})[K] extends string ? string : (typeof ${name}.${first})[K] extends number ? number : boolean };`);
    }
    out.push('');
  }
  return out.join('\n');
}

/** Tailwind theme sections by what a variable is for. */
function tailwindSection(doc: Document, t: Token): string | null {
  const scopes = doc.get(t.v, 'scopes');
  const has = (s: VariableScope) => scopes.includes(s);
  const name = doc.get(t.v, 'name').toLowerCase();
  if (t.type === 'COLOR') return 'colors';
  if (t.type === 'STRING') return has('FONT_FAMILY') || /font|шрифт/.test(name) ? 'fontFamily' : null;
  if (t.type !== 'FLOAT') return null;
  if (has('CORNER_RADIUS') || /radius|скругл|радиус/.test(name)) return 'borderRadius';
  if (has('FONT_SIZE') || /font-?size|размер.*шрифт/.test(name)) return 'fontSize';
  if (has('FONT_WEIGHT') || /weight|начертан/.test(name)) return 'fontWeight';
  if (has('LINE_HEIGHT') || /line-?height|межстроч/.test(name)) return 'lineHeight';
  if (has('LETTER_SPACING') || /letter|tracking/.test(name)) return 'letterSpacing';
  if (has('OPACITY') || /opacity|непрозр/.test(name)) return 'opacity';
  if (t.dimension) return 'spacing';
  return null;
}

function tailwind(doc: Document, groups: Group[]): string {
  const cssNames = new Map(modelOf(doc, defaultTokenOptions('css')).flatMap((g) => g.tokens.map((t) => [t.v, t.name] as const)));
  // With several modes the values are CSS variables: the CSS file switches them.
  const viaCss = groups.some((g) => g.columns.length > 1);
  const sections = new Map<string, string[]>();
  let skipped = 0;
  for (const g of groups) {
    const base = g.columns.findIndex((c) => c.scope === null && c.isDefaultMode);
    for (const t of g.tokens) {
      const section = tailwindSection(doc, t);
      const v = t.values[base]!.value;
      if (!section || v === undefined) {
        skipped++;
        continue;
      }
      let value: string;
      // The CSS variable as the CSS format names it by default (the file that switches the modes).
      if (viaCss) value = jsString(`var(--${cssNames.get(t.v) ?? t.name})`);
      else if (section === 'opacity' && typeof v === 'number') value = jsString(num(v / 100));
      else if (section === 'fontFamily' && typeof v === 'string') value = `[${jsString(v)}]`;
      else value = jsString(cssValue(t, v));
      const list = sections.get(section) ?? [];
      list.push(`        ${jsString(t.name)}: ${value},`);
      sections.set(section, list);
    }
  }
  const body = [...sections].map(([s, lines]) => `      ${s}: {\n${lines.join('\n')}\n      },`).join('\n');
  return [
    viaCss ? `// ${tr('Значения — CSS-переменные: подключите файл переменных в формате CSS, он переключает режимы.')}` : '',
    skipped ? `// ${tr('Пропущено переменных без подходящего раздела Tailwind: {0} (логические, строки не шрифтов, числа без области).', skipped)}` : '',
    `/** @type {import('tailwindcss').Config} */`,
    `module.exports = {\n  theme: {\n    extend: {\n${body}\n    },\n  },\n};\n`,
  ].filter(Boolean).join('\n');
}

const typeNamePascal = (g: Group) => (applyCase(words(toLatin(g.name)), 'pascal') || 'Theme') + 'Tokens';
const columnIdent = (col: Column, i: number) => applyCase(words(toLatin(col.extName ? `${col.extName} ${col.modeName}` : col.modeName)), 'camel') || `mode${i + 1}`;
const ident = (s: string) => (/^[\p{L}_][\p{L}\p{N}_]*$/u.test(s) ? s : `\`${s}\``);

function swift(groups: Group[]): string {
  const swiftType = (t: Token) => (t.type === 'COLOR' ? 'Color' : t.type === 'FLOAT' ? 'CGFloat' : t.type === 'STRING' ? 'String' : 'Bool');
  const swiftValue = (v: VariableLiteral) =>
    isColorValue(v) ? `Color(red: ${num(v.r)}, green: ${num(v.g)}, blue: ${num(v.b)}, opacity: ${num(v.a)})` : typeof v === 'number' ? num(v) : typeof v === 'boolean' ? String(v) : jsString(v);
  const out = ['import SwiftUI', ''];
  for (const g of groups) {
    const type = typeNamePascal(g);
    out.push(`/// ${g.name}`, `public struct ${type} {`);
    for (const t of g.tokens) out.push(`    public let ${ident(t.name)}: ${swiftType(t)}`);
    out.push('}', '', `public extension ${type} {`);
    g.columns.forEach((col, i) => {
      out.push(`    /// ${col.extName ? `${col.extName} · ` : ''}${col.modeName}`, `    static let ${ident(columnIdent(col, i))} = ${type}(`);
      const args = g.tokens.map((t) => {
        const v = t.values[i]!.value;
        return `        ${t.name}: ${v === undefined ? (t.type === 'COLOR' ? '.clear' : t.type === 'FLOAT' ? '0' : t.type === 'STRING' ? '""' : 'false') : swiftValue(v)}`;
      });
      out.push(args.join(',\n'), '    )');
    });
    out.push('}', '');
  }
  return out.join('\n');
}

function kotlin(doc: Document, groups: Group[]): string {
  const isFontSize = (t: Token) => doc.get(t.v, 'scopes').includes('FONT_SIZE') || /font-?size/i.test(doc.get(t.v, 'name'));
  const ktType = (t: Token) => (t.type === 'COLOR' ? 'Color' : t.type === 'FLOAT' ? (isFontSize(t) ? 'TextUnit' : t.dimension ? 'Dp' : 'Float') : t.type === 'STRING' ? 'String' : 'Boolean');
  const ktValue = (t: Token, v: VariableLiteral) => {
    if (isColorValue(v)) return `Color(0x${hex2(v.a)}${hex2(v.r)}${hex2(v.g)}${hex2(v.b)})`;
    if (typeof v === 'number') return isFontSize(t) ? `${num(v)}.sp` : t.dimension ? `${num(v)}.dp` : `${num(v)}f`;
    if (typeof v === 'boolean') return String(v);
    return jsString(v);
  };
  const out = ['import androidx.compose.ui.graphics.Color', 'import androidx.compose.ui.unit.Dp', 'import androidx.compose.ui.unit.TextUnit', 'import androidx.compose.ui.unit.dp', 'import androidx.compose.ui.unit.sp', ''];
  for (const g of groups) {
    const type = typeNamePascal(g);
    out.push(`/** ${g.name} */`, `data class ${type}(`);
    for (const t of g.tokens) out.push(`    val ${ident(t.name)}: ${ktType(t)},`);
    out.push(')', '');
    g.columns.forEach((col, i) => {
      const name = applyCase(words(toLatin(`${col.extName ?? ''} ${col.modeName}`)), 'pascal') + type;
      out.push(`/** ${col.extName ? `${col.extName} · ` : ''}${col.modeName} */`, `val ${ident(name)} = ${type}(`);
      for (const t of g.tokens) {
        const v = t.values[i]!.value;
        out.push(`    ${ident(t.name)} = ${v === undefined ? (t.type === 'COLOR' ? 'Color.Unspecified' : t.type === 'FLOAT' ? (isFontSize(t) ? 'TextUnit.Unspecified' : t.dimension ? '0.dp' : '0f') : t.type === 'STRING' ? '""' : 'false') : ktValue(t, v)},`);
      }
      out.push(')', '');
    });
  }
  return out.join('\n');
}

function android(groups: Group[]): string {
  const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '\\"').replace(/'/g, "\\'");
  // A file per column: the default mode in values/, a dark one in values-night/ (Android
  // switches it), any other mode in its own file with the mode in the names; an
  // extended collection is a product flavour (src/<flavour>/res).
  const files = new Map<string, { title: string; lines: string[] }>();
  for (const g of groups) {
    g.columns.forEach((col, i) => {
      const dark = /тёмн|темн|dark|night|ночн/i.test(col.modeName);
      const source = col.extName ? applyCase(words(toLatin(col.extName)), 'camel') || 'flavour' : 'main';
      const other = !col.isDefaultMode && !dark ? applyCase(words(toLatin(col.modeName)), 'snake') || `mode_${i + 1}` : '';
      const path = `src/${source}/res/${dark && !col.isDefaultMode ? 'values-night' : 'values'}/${other ? `tokens_${other}` : 'tokens'}.xml`;
      const file = files.get(path) ?? { title: `${g.name}${col.extName ? ` · ${col.extName}` : ''} · ${col.modeName}`, lines: [] };
      for (const t of g.tokens) {
        const v = t.values[i]!.value;
        if (v === undefined) continue;
        const n = other ? `${t.name}_${other}` : t.name;
        if (isColorValue(v)) file.lines.push(`    <color name="${n}">#${hex2(v.a)}${hex2(v.r)}${hex2(v.g)}${hex2(v.b)}</color>`);
        else if (typeof v === 'number') file.lines.push(t.dimension ? `    <dimen name="${n}">${num(v)}${t.fontSize ? 'sp' : 'dp'}</dimen>` : `    <item name="${n}" format="float" type="dimen">${num(v)}</item>`);
        else if (typeof v === 'boolean') file.lines.push(`    <bool name="${n}">${v}</bool>`);
        else file.lines.push(`    <string name="${n}">${xml(v)}</string>`);
      }
      files.set(path, file);
    });
  }
  return [...files].map(([path, f]) => `<?xml version="1.0" encoding="utf-8"?>\n<!-- ${path} — ${f.title} -->\n<resources>\n${f.lines.join('\n')}\n</resources>\n`).join('\n');
}

/** The variables of the file in a language; `count` — how many variables went in. */
export function tokensToCode(doc: Document, o: TokenCodeOptions): { text: string; file: string; count: number } {
  const groups = modelOf(doc, o);
  const count = groups.reduce((n, g) => n + g.tokens.length, 0);
  const file = TOKEN_FORMATS.find((f) => f.id === o.format)!.file;
  if (count === 0) return { text: '', file, count };
  const text =
    o.format === 'css' ? css(groups)
    : o.format === 'scss' ? scss(groups)
    : o.format === 'js' ? jsLike(groups, false)
    : o.format === 'ts' ? jsLike(groups, true)
    : o.format === 'tailwind' ? tailwind(doc, groups)
    : o.format === 'swift' ? swift(groups)
    : o.format === 'kotlin' ? kotlin(doc, groups)
    : android(groups);
  return { text, file, count };
}

/** Collections that can be chosen (extensions travel with their parent). */
export function exportableCollections(doc: Document): NodeId[] {
  return doc.collections().filter((c) => !isExtension(doc, c) && baseCollection(doc, c) === c && doc.children(c).length > 0);
}
