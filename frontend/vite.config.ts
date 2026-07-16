import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { transform } from 'esbuild'

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:8000'

/**
 * Vite 8 (oxc) не даунгрейдит mermaid (static{} / catch{}) → Unexpected token '{' в старых браузерах.
 * Финальный проход через esbuild target es2018.
 */
function downlevelChunks(target = 'es2018') {
  return {
    name: 'downlevel-chunks-esbuild',
    async renderChunk(code: string, chunk: { fileName: string }) {
      if (!chunk.fileName.endsWith('.js')) return null
      const result = await transform(code, {
        loader: 'js',
        target,
        sourcemap: false,
        legalComments: 'none',
      })
      return { code: result.code, map: null }
    },
  }
}

export default defineConfig({
  plugins: [react(), downlevelChunks('es2018')],
  build: {
    target: 'es2018',
    cssTarget: 'chrome80',
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
