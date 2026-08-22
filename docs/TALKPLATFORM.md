# TalkPlatform — LINE 予約 × セルフホスト音声通話 × AI/人間オペレーター切替

L Harness の予約機能 (`bookings`) に、LiveKit (WebRTC) による **1 対 1 音声通話** を紐付けた拡張です。
電話占い・オンライン相談など「LINE で予約 → 指定時刻にブラウザで通話」する業態を想定しています。

## 仕組み

```
予約確定 (bookings.status = confirmed)
  └─ call_sessions を 1 行作成 (room: call-<booking_id>, 入室可能: 開始10分前〜終了15分後)
毎分 cron
  ├─ 開始10分前: お客様へ LINE Push (Flex「通話室に入る」→ LIFF /call/<booking_id>)
  └─ 終了15分後までに通話が成立しなければ no_show に確定
LIFF /call/<booking_id>
  ├─ LINE 内ブラウザ: ワンタイムトークンで外部ブラウザ (/call-room?t=) へ引き継ぎ
  └─ 通常ブラウザ: その場で入室
管理画面 /booking/calls/<booking_id>
  └─ スタッフが入室
LiveKit Webhook (participant_joined / room_finished)
  └─ 双方入室で in_progress、退室で ended + billable_seconds、bookings.status = completed
```

追加したもの:

| 場所 | 内容 |
|---|---|
| `packages/db/migrations/071_call_sessions.sql`, `072_call_ai_agent.sql` | `call_sessions` (+mode/summary/recording), `call_handoff_tokens`, `call_transcripts` |
| `apps/agent/` | AI 音声エージェント (Python, LiveKit Agents + xAI) |
| `infra/livekit/` | セルフホスト一式 (livekit / redis / egress / minio / agent / caddy) |
| `apps/worker/src/services/livekit.ts` | HS256 JWT 発行/検証・Webhook 署名検証・RoomService (依存ゼロ・WebCrypto) |
| `apps/worker/src/services/call-session.ts` | セッション作成・入室可否・Webhook 反映・cron (通知/期限切れ) |
| `apps/worker/src/services/call-notifier.ts` | 通話リンク Flex Message |
| `apps/worker/src/routes/calls.ts` | LIFF / 管理 / 公開 (handoff, webhook) ルート |
| `apps/liff/src/pages/Call.tsx`, `CallRoomPage.tsx`, `components/CallRoom.tsx` | 顧客側 UI |
| `apps/web/src/app/booking/calls/[bookingId]/page.tsx` | スタッフ側 UI (予約一覧の「通話室へ」から) |

コア (上流) への変更は最小限: `routes/booking.ts` (ヘルパー export + フック 3 行)、`index.ts` (ルート登録・cron・Env)、`middleware/auth.ts` (公開パス 2 つ)、LIFF の `App.tsx` / `main.tsx` / `lib/api.ts`、管理画面の予約一覧リンクと `lib/api.ts`。

## セットアップ

1. `infra/livekit/` でセルフホスト LiveKit を起動 (README 参照)。API Key / Secret は自分で決める
2. Worker に設定
   ```bash
   # apps/worker/wrangler.toml の [vars]
   LIVEKIT_URL = "wss://livekit.yourdomain.jp"
   ```
   ```bash
   cd apps/worker
   npx wrangler secret put LIVEKIT_API_KEY
   npx wrangler secret put LIVEKIT_API_SECRET
   ```
3. マイグレーション適用
   ```bash
   npx wrangler d1 execute line-harness --remote --file ../../packages/db/migrations/071_call_sessions.sql
   ```
4. `livekit.yaml` の `webhook.urls` に `https://<worker>/api/public/calls/livekit-webhook` を登録
5. LINE Developers の LIFF エンドポイントはそのまま。`/call/*` と `/call-room` は LIFF アプリ内のルートです
6. 通話を使う予約メニュー (menus) を作成し、通常どおり予約 → 承認すると通話セッションが自動で付きます

## API

| Method | Path | 認証 | 用途 |
|---|---|---|---|
| GET | `/api/liff/calls/:bookingId` | LIFF id_token | 通話状態 |
| POST | `/api/liff/calls/:bookingId/token` | LIFF id_token | 参加トークン (入室可能時間内のみ) |
| POST | `/api/liff/calls/:bookingId/handoff` | LIFF id_token | 外部ブラウザ引き継ぎ用ワンタイムトークン (5 分) |
| POST | `/api/public/calls/handoff/:token` | ワンタイム | トークン → 参加トークン |
| GET | `/api/calls/:bookingId` | 管理 API key / cookie | 通話状態 |
| POST | `/api/calls/:bookingId/token` | 管理 API key / cookie | スタッフ参加トークン |
| POST | `/api/calls/:bookingId/mode` | 管理 API key / cookie | AI ⇄ 人間 切替 |
| GET | `/api/calls/:bookingId/transcript` | 管理 API key / cookie | 文字起こし・要約 |
| POST | `/api/public/calls/agent-event` | `CALL_AGENT_SECRET` | エージェント → 文字起こし / 引き継ぎ要請 / 要約 |
| POST | `/api/public/calls/livekit-webhook` | LiveKit 署名 | Webhook (録音開始・入退室・終了) |

## 設計メモ

- **課金時間の真実源は LiveKit Webhook** (`started_at`〜`room_finished`)。クライアント申告は使わない。
- 片方だけ入室して退室した場合、`close_at` までは再入室可能 (room_finished を無視)。`close_at` 経過で no_show。
- LINE 内ブラウザ (iOS) は `getUserMedia` が不安定なため、必ず `liff.openWindow({external: true})` で外へ出す。
- 録音が必要なら LiveKit Egress (audio only) を有効化し、`egress_ended` Webhook で `recording_url` が入る。
- `booking_reminders.kind` の CHECK 制約を触らず、通知状態は `call_sessions.notified_at` で管理 (上流追従を優先)。

## AI エージェントと人間オペレーターの切替

```
顧客 ──┐
      ├── LiveKit SFU (セルフホスト) ──┬── AI エージェント (apps/agent: xAI STT → Grok → xAI TTS)
担当 ──┘                              └── Egress 録音 → MinIO
```

- 予約確定後の通話は **AI が先に応対** (`mode = ai`)。冒頭で録音と引き継ぎ可能である旨を TTS で案内。
- 切替トリガー: (1) 担当者が管理画面で「引き継ぐ」 (2) AI がツール `transfer_to_human` を呼ぶ (顧客の要望・AI が扱うべきでない内容・強い不満) → `human_requested` として管理画面に理由付きで表示 → 担当者が「引き継ぐ」で `human`。
- `human` 中も AI は room に残り、顧客の発話を文字起こしし続ける (発話はしない)。「AI に戻す」で `ai` に復帰。
- モードの真実源は `call_sessions.mode` と LiveKit Room metadata。Worker が両方を更新し、エージェントは metadata 変更に追従する。
- 文字起こしは `call_transcripts`、終了時に Grok で要約を `call_sessions.ai_summary` に保存。録音は Egress (音声のみ OGG) で S3 互換へ。
- 外部に出るデータは **xAI への音声/テキストのみ**。SFU・録音・文字起こし保存はすべて自社側。

構成の詳細: `infra/livekit/README.md`、エージェント: `apps/agent/README.md`。

## 音声の単体検証 (Audio Lab)

音声はデバイス / OS / ブラウザ依存の問題が多いため、予約・LINE から切り離して検証できる
`apps/audio-lab` を用意しています。制御ロジックは `packages/call-audio` に切り出し、
LIFF・管理画面・Lab の 3 者が同じ実装を共有します。手順は `apps/audio-lab/README.md`。

## テスト

```bash
cd apps/worker && npx vitest run src/services/livekit.test.ts src/services/call-session.test.ts
```
