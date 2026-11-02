// Help article model: plain data, one file per language.

export type Block =
  | { p: string }
  | { h: string }
  | { list: string[] }
  | { steps: string[] }
  | { tip: string }
  /** The live table of all keyboard shortcuts (built from the commands). */
  | { shortcuts: true }
  /** Ready HTML of our own (the diagrams' reference with coloured examples, generated from the engine). */
  | { html: string };

export interface Article {
  /** Stable id: the properties panel links to it. */
  id: string;
  section: string;
  title: string;
  /** Extra words people may search with (synonyms, English terms). */
  keywords?: string;
  blocks: Block[];
  related?: string[];
}
