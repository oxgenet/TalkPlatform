# standalone — スタンドアローンプラットフォーム (アプリ層)

LINE を介さず、ブラウザだけで AI 音声相談を行う Web アプリの雛形。
サービス層 API (`/api/service/*`) と `@talkplatform/talk-client` SDK の参照実装でもある。

## 起動 (ローカル)

```bash
# 1) Worker (サービス層) — SERVICE_API_KEYS を設定して起動
cd apps/worker
SERVICE_API_KEYS="demo:sk_local-dev-key-0123" npx wrangler dev   # :8787

# 2) 本アプリ — 鍵は dev プロキシがサーバー側で付与 (ブラウザに出ない)
cd apps/standalone
SERVICE_API_KEY=sk_local-dev-key-0123 pnpm dev                    # :5175
```

LiveKit とエージェントはローカル検証と同じ (`docs/TALKPLATFORM.md`)。

## 他の Web アプリから使う

```ts
import { createTalkClient } from '@talkplatform/talk-client';
const talk = createTalkClient({ apiBase: 'https://worker.example' }); // 鍵は自サーバーで付与
const call = await talk.startCall({ displayName: '山田', onCaption: console.log });
```

公開 Web では `SERVICE_API_KEYS` の鍵をブラウザに埋め込まず、自サーバーで
`POST /api/service/sessions` を代理実行して `joinCall()` に渡すこと。
