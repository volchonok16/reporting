import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { extractPhoneNumbers } from './phoneNumbers';

export type PdfPhoneResult = { numbers: string[]; pages: number; pagesWithoutText: number[] };

export async function readPdfPhones(file: File, signal: AbortSignal, progress: (page: number, total: number) => void): Promise<PdfPhoneResult> {
  signal.throwIfAborted();
  const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  signal.throwIfAborted();
  GlobalWorkerOptions.workerSrc = workerUrl;
  const data = new Uint8Array(await file.arrayBuffer());
  signal.throwIfAborted();
  if (!new TextDecoder().decode(data.subarray(0, 1024)).includes('%PDF-')) throw new Error('Выбранный файл не является PDF.');
  const task = getDocument({ data, useSystemFonts: true, cMapUrl: `${import.meta.env.BASE_URL}pdfjs/cmaps/`, cMapPacked: true,
    standardFontDataUrl: `${import.meta.env.BASE_URL}pdfjs/standard_fonts/`, wasmUrl: `${import.meta.env.BASE_URL}pdfjs/wasm/` });
  const cancel = () => { void task.destroy(); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const pdf = await task.promise;
    const result: PdfPhoneResult = { numbers: [], pages: pdf.numPages, pagesWithoutText: [] };
    progress(0, pdf.numPages);
    for (let index = 1; index <= pdf.numPages; index++) {
      signal.throwIfAborted();
      const page = await pdf.getPage(index);
      const content = await page.getTextContent();
      signal.throwIfAborted();
      const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
      if (!text.trim()) result.pagesWithoutText.push(index);
      for (const number of extractPhoneNumbers(text)) result.numbers.push(number);
      page.cleanup();
      progress(index, pdf.numPages);
    }
    return result;
  } finally {
    signal.removeEventListener('abort', cancel);
    await task.destroy();
  }
}
