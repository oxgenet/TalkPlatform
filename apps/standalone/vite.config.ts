import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// dev では /api/service/* を Worker (wrangler dev :8787) にプロキシし、
// API キーは dev サーバー側で付与する (ブラウザに鍵を出さない)。
const API = process.env.SERVICE_API_BASE ?? 'http://127.0.0.1:8787';
const KEY = process.env.SERVICE_API_KEY ?? '';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/service': {
        target: API,
        changeOrigin: true,
        headers: KEY ? { Authorization: `Bearer ${KEY}` } : {},
      },
    },
  },
});
