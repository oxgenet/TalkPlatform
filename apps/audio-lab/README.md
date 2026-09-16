# TalkPlatform Audio Lab

予約・LINE 認証なしで **音声まわりだけ** を単体検証するページ。本番 UI (LIFF / 管理画面) と同じ
`@talkplatform/call-audio` を使うため、ここで通れば本番でも通る（逆に、ここで落ちる端末は本番でも落ちる）。

## 起動

```bash
pnpm --filter audio-lab dev
```

`https://<MacのLAN IP>:5174` を実機 (iPhone / Android) で開く。自己署名証明書の警告は「続行」で進む
（getUserMedia は https 必須）。

## トークンの用意（どちらか）

**A. ローカル CLI**（Worker 不要）

```bash
LIVEKIT_URL=wss://livekit.yourdomain.jp LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... \
  pnpm --filter audio-lab token --room lab-1 --identity phone-a
```

**B. Worker の Lab API**（実機で貼り付けが面倒なとき）

```bash
cd apps/worker && npx wrangler secret put CALL_LAB_SECRET   # 16 文字以上。本番には設定しない
```

Lab ページの「トークンを Lab API で発行する」に Worker URL / secret / room / identity を入れる。
room は `lab-` 接頭辞に強制されるので本番の通話ルームには入れない。

## 切り分け手順（上から順に）

| # | 確認 | OK の目安 | NG のとき |
|---|---|---|---|
| 1 | 環境 | `secureContext: true`, `hasGetUserMedia: true`, `inLineApp: false` | LINE 内なら外部ブラウザで開く。http なら https にする |
| 2 | マイク権限 | badge が `granted`、レベルメーターが声に反応 | `NotAllowedError` → OS/ブラウザ設定でマイク許可。`NotReadableError` → 他アプリがマイク占有 |
| 2' | ループバック | 自分の声がイヤホンから聞こえる | 聞こえない → 出力デバイス/音量/サイレントスイッチ (iOS) |
| 3 | テストトーン | 音が鳴る | 鳴らない → 自動再生ブロック。タップ後に再実行。iOS はサイレントスイッチ確認 |
| 4 | LiveKit 接続 | phase が `waiting`、ログに `mic published: <label>` | `connect failed` → URL/トークン/ネットワーク (社内 FW で UDP 遮断なら TURN 経由になる) |
| 5 | 2 台で通話 | 双方 `talking`、`peer 🔊` が点灯、rtt 表示 | 片方しか聞こえない → 聞こえない側で「音が出ない→タップ」。lost が増える → 回線品質 |

「診断レポートをコピー」で環境・トラック設定・ログを JSON で取れるので、問題報告に貼り付ける。

## 既知の端末差

- **iOS Safari**: マイク取得・音声再生はタップハンドラ内で開始する必要がある（Lab も本番もボタン押下から接続）。バックグラウンドに回すと送信が止まることがある。
- **iOS LINE 内ブラウザ**: `getUserMedia` が不安定。本番では `liff.openWindow({external:true})` で Safari へ引き継ぐ。
- **Android Chrome**: 概ね安定。Bluetooth イヤホン切替時に track が `ended` になる場合あり（Lab の track 表示に `!! track ended` が出る）。
- **PC**: 複数マイクがある場合は select で明示的に選ぶ。
