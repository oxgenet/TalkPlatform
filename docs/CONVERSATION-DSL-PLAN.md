# 会話 DSL 設計プラン (Conversation DSL)

状態: プラン (未実装) / 起票済み: Kanboard「TalkPlatform」プロジェクト (task #793〜#801, 2026-09-01)
前提: apps/agent の TalkAgent は現在「単一システムプロンプト + transfer_to_human ツール」のハードコード。
目的: 業態 (電話占い / 予約受付 / 一次受付 / 汎用相談…) ごとの会話を **コードを触らず宣言的に定義**できるようにする。

---

## 1. 設計方針

**「完全ステートマシン」ではなく「LLM 主導 + 宣言的ガードレール」。**

- 発話の自然さ・言い換え耐性は LLM (Grok) に任せる。DSL は「何を達成するか・何をしてはいけないか・いつ人間に渡すか」を宣言する。
- ただし **決定論が必須の点だけ** はランタイムが機械的に強制する:
  - モード遷移 (ai / human_requested / human) — 既存の状態機械をそのまま使う
  - キーワード即時引き継ぎ (「担当者」「オペレーター」等) — LLM 判断を待たない backstop
  - 禁止事項 (断定的な医療・法律・投資助言等) — システムプロンプト + 出力後フィルタ
- 理由: 分岐を網羅するフローチャート型 DSL は音声の言い換えに弱く、保守コストが LLM 時代に見合わない。分岐を賢くするより分岐が要らない形にする (LEARNINGS の型)。

## 2. DSL の形 (YAML, JSON Schema で検証)

```yaml
# scenarios/uranai.yaml — 例: 電話占い
id: uranai-v1
version: 1
language: ja
persona:
  name: みらい
  voice: ara            # xAI TTS voice
  speed: 1.0
  style: 丁寧で落ち着いた口調。1 回の発話は 2〜3 文。
opening:
  text: お電話ありがとうございます。{menu_name} 担当のみらいです。通話は品質向上のため録音されます。ご用件をどうぞ。
  interruptible: true
goals:                   # LLM に渡す「この通話で達成すること」(順序は目安)
  - id: listen           # 相談内容を聞き取る
    description: 相談内容 (仕事・恋愛・健康など) と背景を聞き取る
    collect:             # スロット収集 (transcript とは別に構造化保存)
      - key: topic
        description: 相談ジャンル
        required: true
      - key: birth_date
        description: 生年月日 (占いに必要な場合のみ)
  - id: advise
    description: 聞き取った内容に沿って占い結果と助言を伝える
rules:
  always:
    - 相手の名前が分かる場合は適度に呼びかける
    - 分からないことは推測せず「担当者に確認します」と答える
  never:
    - 医療・法律・投資の断定的な助言
    - 料金・返金・契約内容の回答 (即 handoff)
handoff:
  announce: かしこまりました。担当者におつなぎしますので、そのままお待ちください。
  triggers:
    - type: keyword      # 決定論 backstop (STT 結果に対する正規表現)
      pattern: (担当者|オペレーター|人と話|人間と)
    - type: llm          # LLM 判断 (transfer_to_human ツールの呼び出し条件として展開)
      when: 強い不満・怒り・緊急性 / 料金・返金・契約・個人情報の変更 / 同じ質問に2回答えても未解決
tools:                   # シナリオ固有ツール (Worker API に委譲)
  - id: lookup_booking
    description: 予約内容を確認する
    endpoint: /api/public/calls/agent-tool/lookup_booking
closing:
  when: 用件が完了し相手が終話の意思を示した
  text: 本日はありがとうございました。またのご利用をお待ちしております。
limits:
  max_call_minutes: 30
  max_silence_seconds: 20   # 無音がこれを超えたら呼びかけ → さらに超えたら終話
tests:                   # §5 のシミュレーターが読む回帰テスト
  - name: 引き継ぎ要求
    user_says: [こんにちは, 人の担当者に代わってもらえますか]
    expect: { tool: transfer_to_human }
  - name: 運勢相談
    user_says: [今日の仕事運を教えてください]
    expect: { mentions_any: [仕事, 運], not_tool: transfer_to_human }
```

## 3. ランタイム (apps/agent)

- `talk_agent/dsl/`: `schema.json` (検証) / `loader.py` (YAML→dataclass) / `compiler.py`
- compiler の出力:
  1. システムプロンプト (persona + goals + rules + handoff.llm 条件を定型に展開)
  2. ツール群 (transfer_to_human + tools[] を function_tool に合成、collect[] は `save_slot` ツールに)
  3. 決定論フック (keyword trigger → on_user_turn_completed で正規表現マッチ時に即 handoff、limits → タイマー)
- シナリオの選択: Room metadata に `scenario_id` を追加 (Worker が menus/tenant 設定から解決)。無指定は既定シナリオ。
- スロット保存: `call_sessions` に `slots` (JSON) を追加、agent-event 経由で Worker に送る。

## 4. 保存と配布 (Worker / 管理画面)

- D1 `scenarios` テーブル (id, version, yaml, is_active, updated_by)。migration 073。
- Worker: `GET /api/public/calls/scenario/:id` (CALL_AGENT_SECRET) で agent が取得、5 分キャッシュ。
- 管理画面: シナリオ一覧 + YAML エディタ (検証エラー表示) + メニューへの割当。バージョンを残し 1 つ前に戻せる。

## 5. テストハーネス (DSL 駆動回帰)

- 既存の customer-sim (record_conv.py 系) を昇格: `apps/agent/tests/simulate.py`
  - `tests[]` を読み、`user_says` を xAI TTS→PCM (キャッシュ) または **テキスト直入れ** (STT を飛ばす高速モード) で流す
  - `expect` を transcript / ツール呼び出しログで判定
- CI: テキスト直入れモードのみ (音声モードは手動/夜間)。LLM の揺れは「must / must-not」だけを断言し、文言一致は使わない。

## 6. マイルストーン (Kanboard カード)

| # | カード | 内容 | 依存 |
|---|---|---|---|
| 1 | DSL スキーマ確定 | §2 の YAML を JSON Schema 化、例 3 本 (uranai / 予約受付 / 一次受付) | - |
| 2 | ランタイム compiler | prompt/tool/決定論フック生成、scenario_id 読み込み | 1 |
| 3 | keyword backstop + limits | 正規表現 handoff、無音・時間上限 | 2 |
| 4 | スロット収集 | save_slot ツール + call_sessions.slots + Worker 受口 | 2 |
| 5 | D1 保存 + Worker API | migration 073、scenario 配信、キャッシュ | 1 |
| 6 | 管理画面エディタ | YAML 編集・検証・メニュー割当・版戻し | 5 |
| 7 | シミュレーター | tests[] 実行 (テキスト/音声 2 モード)、CI 組み込み | 2 |
| 8 | 既存プロンプト移行 | system.ja.md を uranai-v1 シナリオへ、Lab で回帰 | 2,7 |

見積り感: 1〜3 で会話が DSL 化 (コア)。4〜6 は運用向け。7 は 1 と並行可。

## 7. 決めてもらうこと

- DSL の第一級ユーザーは誰か (開発者のみ → YAML でよい / 非エンジニアも → 管理画面フォーム化を 6 で厚めに)
- スロット (§2 collect) を予約データにどこまで書き戻すか (friends.metadata? 専用テーブル?)
- シナリオの多言語対応の要否 (当面 ja 固定でよいか)
