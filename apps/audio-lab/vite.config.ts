import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// getUserMedia は https 必須 (localhost 以外)。実機 (iPhone/Android) から LAN 経由で
// 開けるよう自己署名証明書で https を有効化する。
export default defineConfig({
  plugins: [basicSsl()],
  server: { https: {}, port: 5174 },
});
