#!/usr/bin/env tsx
// ローカルで LiveKit アクセストークンを発行する (Worker 不要)。
//   LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... pnpm --filter audio-lab token --room lab-1 --identity phone-a
// Worker と同じ実装 (WebCrypto) を使うので、署名の互換性検証にもなる。
import { createAccessToken } from '../../worker/src/services/livekit.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a: string, i: number, arr: string[]) => (a.startsWith('--') ? [a.slice(2), arr[i + 1] ?? 'true'] : [])).filter((x: string[]) => x.length),
) as Record<string, string>;

const apiKey = process.env.LIVEKIT_API_KEY;
const apiSecret = process.env.LIVEKIT_API_SECRET;
if (!apiKey || !apiSecret) {
  console.error('LIVEKIT_API_KEY / LIVEKIT_API_SECRET を環境変数で指定してください');
  process.exit(1);
}
const room = args.room ?? 'lab-1';
const identity = args.identity ?? `dev-${Date.now().toString(36)}`;
const ttl = Number(args.ttl ?? 3600);

const token = await createAccessToken(
  { url: process.env.LIVEKIT_URL ?? '', apiKey, apiSecret },
  { identity, name: args.name ?? identity, ttlSeconds: ttl, grant: { roomJoin: true, room, canPublish: true, canSubscribe: true } },
);
console.log(token);
