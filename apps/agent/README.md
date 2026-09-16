# talk-agent — AI 音声エージェント

LiveKit Agents 上で動く、xAI Grok (STT / LLM / TTS) の音声エージェント。人間オペレーターとの切替に対応。

```bash
cd apps/agent
python -m venv .venv && . .venv/bin/activate
pip install -e . pytest
cp .env.example .env   # 値を設定
python -m pytest
talk-agent dev          # 開発 (ホットリロード) / 本番は `talk-agent start`
```

## 動作
- Room metadata に `talk: true` がある room にだけ参加する（Audio Lab の `lab-*` は `TALK_ALLOW_LAB_ROOMS=true` で許可）。
- `mode` は Worker が書く Room metadata が真実源。`ai` / `human_requested` / `human`。
- 入力は `customer:*` 参加者の音声のみ（オペレーターの声には反応しない）。
- 文字起こしは 2 秒ごとに Worker へバッチ送信（`POST /api/public/calls/agent-event`）。通話終了時に Grok で要約を作成して送信。
- LLM ツール `transfer_to_human(reason)` で引き継ぎ要請 → Worker が `human_requested` に更新 → 管理画面に表示。

## スケール
エージェントはワーカープール。`talk-agent start` を複数プロセス/複数ホストで起動すれば LiveKit が空いているワーカーへ job を配る。1 通話 = 1 job。CPU は VAD と音声処理で 1 通話あたり概ね 0.2〜0.5 vCPU、レイテンシは xAI API 往復が支配的。
