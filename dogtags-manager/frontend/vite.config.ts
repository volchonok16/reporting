import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync, mkdirSync } from 'node:fs';

const pdfAssets = new URL('./public/pdfjs/', import.meta.url);
mkdirSync(pdfAssets, { recursive: true });
for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
  cpSync(new URL(`./node_modules/pdfjs-dist/${directory}`, import.meta.url), new URL(directory, pdfAssets), { recursive: true });
}
cpSync(new URL('./node_modules/pdfjs-dist/LICENSE', import.meta.url), new URL('LICENSE', pdfAssets));

export default defineConfig({
  base: '/dogtags-manager/',
  plugins: [react()],
  server: { proxy: { '/api': 'http://127.0.0.1:8000' } },
});
