import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // nginx / corp-direct проксирует с Host = публичный домен
    allowedHosts: [
      'localhost',
      '127.0.0.1',
      'pallink.fun',
      'www.pallink.fun',
      'api.pallink.fun',
      'taskatestovaya.ru',
      'www.taskatestovaya.ru',
      'api.taskatestovaya.ru',
      'minio.taskatestovaya.ru',
      'minio-console.taskatestovaya.ru',
      '.pallink.fun',
      '.taskatestovaya.ru',
    ],
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
