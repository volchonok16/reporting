// Shrinks the JavaScript of the build without a package: comments go,
// indentation and runs of spaces go, strings, templates and regular
// expressions stay exactly as written. Line breaks are kept (one per run), so
// automatic semicolon insertion means the same as before. Names are not
// renamed: the code stays debuggable from the browser.
//
// Safety: the result is split into tokens again and compared with the
// tokens of the original; if they differ in anything, the original is used.

const KEYWORDS_BEFORE_EXPRESSION = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const WORD = /[A-Za-z0-9_$\u0080-￿]/;

/**
 * Splits JavaScript into tokens: {t: 'ws' | 'nl' | 'comment' | 'str' | 'tpl' | 're' | 'word' | 'num' | 'punct', v}.
 * Template literals are kept whole, with what is inside `${}` tokenised in place.
 */
export function tokenize(src) {
  const out = [];
  let i = 0;
  /** Stack of brace depths: an entry per open template `${`, to know which `}` ends it. */
  const templates = [];
  let depth = 0;
  const lastSignificant = () => {
    for (let k = out.length - 1; k >= 0; k--) if (out[k].t !== 'ws' && out[k].t !== 'nl' && out[k].t !== 'comment') return out[k];
    return null;
  };
  const regexAllowed = () => {
    const prev = lastSignificant();
    if (!prev) return true;
    if (prev.t === 'word') return KEYWORDS_BEFORE_EXPRESSION.has(prev.v);
    if (prev.t === 'num' || prev.t === 'str' || prev.t === 'tpl' || prev.t === 're') return false;
    if (prev.t === 'punct') return !(prev.v === ')' || prev.v === ']' || prev.v === '}' || prev.v === '++' || prev.v === '--');
    return true;
  };
  // Reads a template from `start` (at a backtick or a `}` closing `${`) up to the next `${` or the closing backtick.
  const templatePart = (start) => {
    let j = start + 1;
    while (j < src.length) {
      const c = src[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '`') return { end: j + 1, open: false };
      if (c === '$' && src[j + 1] === '{') return { end: j + 2, open: true };
      j++;
    }
    throw new Error('unterminated template');
  };
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '\n' || c === '\r') {
      let j = i;
      while (j < src.length && /\s/.test(src[j])) j++;
      out.push({ t: 'nl', v: src.slice(i, j) });
      i = j;
    } else if (/\s/.test(c)) {
      let j = i;
      while (j < src.length && /[^\S\r\n]/.test(src[j])) j++;
      // Whitespace running into a line break belongs to the line break.
      if (src[j] === '\n' || src[j] === '\r') {
        let k = j;
        while (k < src.length && /\s/.test(src[k])) k++;
        out.push({ t: 'nl', v: src.slice(i, k) });
        i = k;
      } else {
        out.push({ t: 'ws', v: src.slice(i, j) });
        i = j;
      }
    } else if (c === '/' && next === '/') {
      let j = i;
      while (j < src.length && src[j] !== '\n' && src[j] !== '\r') j++;
      out.push({ t: 'comment', v: src.slice(i, j), line: true });
      i = j;
    } else if (c === '/' && next === '*') {
      const j = src.indexOf('*/', i + 2);
      if (j < 0) throw new Error('unterminated comment');
      out.push({ t: 'comment', v: src.slice(i, j + 2), line: /[\r\n]/.test(src.slice(i, j)) });
      i = j + 2;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (src[j] === '\n') throw new Error('newline in string');
        j++;
      }
      out.push({ t: 'str', v: src.slice(i, j + 1) });
      i = j + 1;
    } else if (c === '`') {
      const part = templatePart(i);
      out.push({ t: 'tpl', v: src.slice(i, part.end) });
      if (part.open) templates.push(depth);
      i = part.end;
    } else if (c === '}' && templates.length && templates[templates.length - 1] === depth) {
      templates.pop();
      const part = templatePart(i);
      out.push({ t: 'tpl', v: src.slice(i, part.end) });
      if (part.open) templates.push(depth);
      i = part.end;
    } else if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const d = src[j];
        if (d === '\\') j++;
        else if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        else if (d === '\n') throw new Error('newline in regular expression');
        j++;
      }
      j++;
      while (j < src.length && /[a-z]/i.test(src[j])) j++;
      out.push({ t: 're', v: src.slice(i, j) });
      i = j;
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(next ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9A-Za-z_.]/.test(src[j])) {
        // exponent sign: 1e-5
        if ((src[j] === 'e' || src[j] === 'E') && (src[j + 1] === '+' || src[j + 1] === '-') && !/^0[xX]/.test(src.slice(i, j + 1))) j++;
        j++;
      }
      out.push({ t: 'num', v: src.slice(i, j) });
      i = j;
    } else if (WORD.test(c) || c === '#' || c === '\\') {
      let j = i + 1;
      while (j < src.length && (WORD.test(src[j]) || src[j] === '\\')) j++;
      out.push({ t: 'word', v: src.slice(i, j) });
      i = j;
    } else {
      // Longest punctuator first.
      const puncts = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'];
      const p = puncts.find((x) => src.startsWith(x, i)) ?? c;
      if (p === '{' || p === '${') depth++;
      if (p === '}') depth--;
      out.push({ t: 'punct', v: p });
      i += p.length;
    }
  }
  return out;
}

const significant = (tokens) => tokens.filter((t) => t.t !== 'ws' && t.t !== 'nl' && t.t !== 'comment').map((t) => `${t.t}:${t.v}`);

/** Whether two tokens would run together without a space between them. */
function needsSpace(a, b) {
  const x = a.v[a.v.length - 1];
  const y = b.v[0];
  if (WORD.test(x) && WORD.test(y)) return true;
  if ((x === '+' || x === '-') && x === y) return true; // a + +b, a - -b
  if (x === '/' && (y === '/' || y === '*')) return true; // would start a comment
  if (a.t === 'num' && y === '.') return true; // 1 .toString()
  if (WORD.test(x) && y === '#') return true;
  return false;
}

/** Minified source, or the source itself when the check fails. Returns {code, ok}. */
export function minify(src) {
  let tokens;
  try {
    tokens = tokenize(src);
  } catch {
    return { code: src, ok: false };
  }
  let out = '';
  let prev = null;
  let pendingLine = false;
  let pendingSpace = false;
  let atStart = true;
  for (const tok of tokens) {
    if (tok.t === 'nl' || (tok.t === 'comment' && tok.line)) {
      pendingLine = true;
      continue;
    }
    if (tok.t === 'ws' || tok.t === 'comment') {
      pendingSpace = true;
      continue;
    }
    if (!atStart && prev) {
      if (pendingLine) out += '\n';
      else if (pendingSpace && needsSpace(prev, tok)) out += ' ';
      else if (needsSpace(prev, tok)) out += ' ';
    }
    out += tok.v;
    prev = tok;
    atStart = false;
    pendingLine = false;
    pendingSpace = false;
  }
  out += '\n';
  // Check: the same tokens, in the same order.
  try {
    const a = significant(tokens);
    const b = significant(tokenize(out));
    if (a.length !== b.length || a.some((v, k) => v !== b[k])) return { code: src, ok: false };
  } catch {
    return { code: src, ok: false };
  }
  return { code: out, ok: true };
}
