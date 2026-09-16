import { defineConfig, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { createAccessToken } from '../worker/src/services/livekit.js';

// dev 専用: POST /lab/token で LiveKit の参加トークンを発行する (Worker 不要)。
//   env: LIVEKIT_API_KEY / LIVEKIT_API_SECRET (既定 devkey/secret = livekit-server --dev)
//        VITE_LIVEKIT_URL (ブラウザから見た LiveKit の URL)
// room は必ず "lab-" 接頭辞。本番ビルドには含まれない (apply: 'serve')。
function labTokenPlugin(): Plugin {
  return {
    name: 'lab-token',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/lab/token', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        let body = '';
        for await (const c of req) body += c;
        let j: { room?: string; identity?: string; name?: string } = {};
        try { j = JSON.parse(body || '{}'); } catch { /* empty */ }
        const apiKey = process.env.LIVEKIT_API_KEY ?? 'devkey';
        const apiSecret = process.env.LIVEKIT_API_SECRET ?? 'secret';
        const url = process.env.VITE_LIVEKIT_URL ?? 'ws://127.0.0.1:7880';
        const room = `lab-${String(j.room ?? '1').replace(/^lab-/, '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || '1'}`;
        const identity = String(j.identity ?? `dev-${Math.random().toString(36).slice(2, 8)}`).replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 64);
        const token = await createAccessToken(
          { url, apiKey, apiSecret },
          { identity, name: j.name ?? identity, ttlSeconds: 3600, grant: { roomJoin: true, room, canPublish: true, canSubscribe: true } },
        );
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ token, url, room, identity }));
      });
    },
  };
}

// getUserMedia は https か localhost で動く。Mac 上で試すなら http://localhost で十分
// (https ページから ws:// の LiveKit へは mixed content で繋げないため、ローカルは http を既定にする)。
// 実機 (LAN) から開くときは LAB_HTTPS=1 で自己署名 https を有効化する。
const useHttps = process.env.LAB_HTTPS === '1';

export default defineConfig({
  plugins: [labTokenPlugin(), ...(useHttps ? [basicSsl()] : [])],
  server: { https: useHttps ? {} : undefined, port: 5174, host: true },
});
