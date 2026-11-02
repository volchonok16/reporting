// Smart symbols while typing (as Figma and the system text fields do): two
// hyphens become a dash, -> an arrow, ... an ellipsis, straight quotes curly
// ones — «ёлочки» in Russian text, “лапки” otherwise. Only what was just typed
// is looked at; Backspace right after a replacement brings the typed text back.

export interface SmartReplacement {
  /** How many characters before the caret (the typed one included) are replaced. */
  remove: number;
  insert: string;
}

/** Endings that turn into a symbol, longest first so «<->» wins over «->». */
const ENDINGS: [string, string][] = [
  ['←>', '↔'],
  ['(tm)', '™'],
  ['(TM)', '™'],
  ['...', '…'],
  ['(c)', '©'],
  ['(C)', '©'],
  ['(r)', '®'],
  ['(R)', '®'],
  ['--', '—'],
  ['->', '→'],
  ['<-', '←'],
  ['=>', '⇒'],
  ['>=', '≥'],
  ['<=', '≤'],
  ['!=', '≠'],
  ['+-', '±'],
];

const OPENING_BEFORE = /[\s([{«„“‘—–-]$/u;

/**
 * What to put instead of the end of `before` (the text up to the caret, the typed
 * character last); `text` is the whole text, for its language. Null — nothing.
 */
export function smartReplace(before: string, text: string): SmartReplacement | null {
  const typed = before.slice(-1);
  if (!typed) return null;
  // A hyphen between spaces is a dash in Russian typography: «слово - слово».
  if (typed === ' ' && /(^|\s)-\s$/u.test(before)) return { remove: 2, insert: '— ' };
  for (const [from, to] of ENDINGS) {
    if (before.endsWith(from)) return { remove: from.length, insert: to };
  }
  if (typed === '"' || typed === "'") {
    const prev = before.slice(0, -1);
    const opening = prev === '' || OPENING_BEFORE.test(prev);
    if (typed === "'") {
      // An apostrophe inside a word (don't, д'Артаньян), else single quotes.
      return { remove: 1, insert: opening ? '‘' : '’' };
    }
    const russian = /[а-яё]/iu.test(text);
    if (russian) {
      // Inner quotes inside «…» are „…“.
      const open = (prev.match(/«/gu) ?? []).length - (prev.match(/»/gu) ?? []).length;
      if (opening) return { remove: 1, insert: open > 0 ? '„' : '«' };
      const inner = (prev.match(/„/gu) ?? []).length - (prev.match(/“/gu) ?? []).length;
      return { remove: 1, insert: inner > 0 ? '“' : '»' };
    }
    return { remove: 1, insert: opening ? '“' : '”' };
  }
  return null;
}
