// Files for a layout from a description (FEAT-172): a table of prices for a
// menu, a list of orders for a dashboard, a text for a landing page. The model
// reads only text, so every file becomes text here, in the browser: a
// spreadsheet — its sheets as tab-separated rows, a Word or PowerPoint file —
// its paragraphs and table rows, a plain text file — as it is.

import { tr } from '#core';
import { unzip } from '../fig/archive.ts';

export interface Attachment {
  name: string;
  text: string;
  /** Cut to fit: how much of it the model sees. */
  cut?: boolean;
}

/** One file's text at most… */
export const FILE_CHARS = 40_000;
/** …and all files together (the server checks the same). */
export const FILES_CHARS = 80_000;
/** Rows of one sheet: a layout shows a few dozen anyway. */
const SHEET_ROWS = 300;

const TEXT_EXT = /\.(csv|tsv|txt|md|markdown|json|xml|html?|ya?ml|log)$/i;

const unxml = (s: string) =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'amp') return '&';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });

/** Text of a file as is: UTF-8, or Windows-1251 (a CSV saved by Excel in Russian). */
export function decodeText(bytes: Uint8Array): string {
  const utf = new TextDecoder('utf-8').decode(bytes);
  if (!utf.includes('�')) return utf.replace(/^﻿/, '');
  try {
    return new TextDecoder('windows-1251').decode(bytes);
  } catch {
    return utf;
  }
}

/** All <t> texts inside a piece of XML, joined. */
const texts = (xml: string, tag: string) => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => unxml(m[1]!)).join('');

/** Column letters of a cell reference → 0-based index (B7 → 1). */
function column(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.toUpperCase().charCodeAt(0) - 64);
  return n - 1;
}

/** An .xlsx: every sheet as «Лист «name»» and tab-separated rows. */
export async function xlsxText(bytes: Uint8Array): Promise<string> {
  const files = await unzip(bytes, (n) => n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' || n === 'xl/sharedStrings.xml' || n.startsWith('xl/worksheets/sheet'));
  const str = (n: string) => (files.has(n) ? new TextDecoder().decode(files.get(n)) : '');
  const shared = [...str('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]!, 't'));
  const rels = new Map([...str('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map((m) => [/Id="([^"]+)"/.exec(m[0])?.[1] ?? '', /Target="([^"]+)"/.exec(m[0])?.[1] ?? '']));
  const sheets = [...str('xl/workbook.xml').matchAll(/<sheet\b[^>]*>/g)].map((m) => ({
    name: unxml(/name="([^"]*)"/.exec(m[0])?.[1] ?? ''),
    path: `xl/${(rels.get(/r:id="([^"]+)"/.exec(m[0])?.[1] ?? '') ?? '').replace(/^\/?xl\//, '')}`,
  }));
  const out: string[] = [];
  for (const sheet of sheets) {
    const xml = str(sheet.path);
    if (!xml) continue;
    const rows: string[] = [];
    let more = 0;
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of row[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1]!;
        const body = c[2] ?? '';
        const type = /\st="([^"]+)"/.exec(attrs)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        const value = type === 's' ? (shared[Number(v)] ?? '') : type === 'inlineStr' ? texts(body, 't') : type === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : unxml(v ?? '');
        const ref = /\sr="([A-Z]+\d+)"/.exec(attrs)?.[1];
        const at = ref ? column(ref) : cells.length;
        while (cells.length < at) cells.push('');
        cells[at] = value.replace(/[\t\r\n]+/g, ' ').trim();
      }
      if (!cells.some(Boolean)) continue;
      if (rows.length >= SHEET_ROWS) {
        more++;
        continue;
      }
      rows.push(cells.join('\t'));
    }
    if (!rows.length) continue;
    out.push(`${tr('Лист «{0}»', sheet.name)}\n${rows.join('\n')}${more ? `\n${tr('…и ещё строк: {0}', more)}` : ''}`);
  }
  return out.join('\n\n');
}

/** A .docx: paragraphs, table rows with cells by tabs. */
export async function docxText(bytes: Uint8Array): Promise<string> {
  const files = await unzip(bytes, (n) => n === 'word/document.xml');
  const xml = new TextDecoder().decode(files.get('word/document.xml') ?? new Uint8Array());
  const lines: string[] = [];
  for (const block of xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g)) {
    const b = block[0];
    if (b.startsWith('<w:tbl>')) {
      for (const row of b.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)) lines.push([...row[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((c) => texts(c[0], 'w:t').trim()).join('\t'));
    } else {
      const t = texts(b, 'w:t').trim();
      if (t) lines.push(t);
    }
  }
  return lines.join('\n');
}

/** A .pptx: each slide's texts. */
export async function pptxText(bytes: Uint8Array): Promise<string> {
  const files = await unzip(bytes, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const slides = [...files.keys()].sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  return slides
    .map((n, i) => {
      const xml = new TextDecoder().decode(files.get(n));
      const paras = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((p) => texts(p[1]!, 'a:t').trim()).filter(Boolean);
      return `${tr('Слайд {0}', i + 1)}\n${paras.join('\n')}`;
    })
    .join('\n\n');
}

/** A file as text for the model; throws with words for the person when it cannot be read. */
export async function readAttachment(name: string, bytes: Uint8Array): Promise<Attachment> {
  let text: string;
  try {
    if (/\.(xlsx|xlsm)$/i.test(name)) text = await xlsxText(bytes);
    else if (/\.docx$/i.test(name)) text = await docxText(bytes);
    else if (/\.pptx$/i.test(name)) text = await pptxText(bytes);
    else if (TEXT_EXT.test(name)) text = decodeText(bytes);
    else throw new Error('kind');
  } catch (error) {
    if (error instanceof Error && error.message === 'kind') {
      throw new Error(/\.(png|jpe?g|gif|webp|svg|heic)$/i.test(name) ? tr('«{0}»: картинки нейросеть не видит — опишите, что на ней, словами', name) : tr('«{0}»: такой файл не прочитать — подойдут .xlsx, .csv, .docx, .pptx, .txt, .json', name));
    }
    throw new Error(tr('«{0}» не открылся — возможно, файл повреждён', name));
  }
  text = text.trim();
  if (!text) throw new Error(tr('«{0}»: в файле нет текста', name));
  return text.length > FILE_CHARS ? { name, text: text.slice(0, FILE_CHARS), cut: true } : { name, text };
}
