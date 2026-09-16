# 他社技術情報 — LINE 音声サービスの実現手段

調査日: 2026-09-03 / 対象: 「LINE 上でユーザーと音声で会話するサービス」を他社がどう実現しているか。
目的: 我々 (TalkPlatform: LIFF + セルフホスト LiveKit + AI エージェント) の設計が競合とどう違うかを把握する。

---

## 要点 (3 行)

- LINE 内で通話している電話占い等の大手は **LINE 純正の通話機能 (LINE Call) を使っており、LIFF 上の自作 WebRTC ではない**。これは LINE 自身/運営側の立場でのみ使える経路で、第三者には開放されていない。
- **「LIFF 上で SkyWay/Agora 等の WebRTC を動かして音声サービス」という第三者の明確な導入事例は、公開情報ではほぼ見当たらない** (技術検証記事・SDK ベンダーの How-to は存在)。
- WebRTC 自作の実サービス (オンライン診療 CLINICS 等) は存在するが、**LIFF ではなく自社アプリ/Web** で提供している。

---

## A. LINE 純正通話を使っている例 (= 我々の方式とは別物)

| サービス / 主体 | 方式 | 備考 |
|---|---|---|
| LINE トーク占い「電話占い」 | LINE の通話機能 | 「電話番号を知られず相談」「1 分 130 円〜」。運営は LINE ヤフー系で **LINE Call をそのまま使える立場**。第三者は同じことができない。 |
| LINE 公式アカウントの LINE Call | 純正機能 | ユーザー→運営者へ LINE アプリ内で発信。**自作アプリから発着信を制御することはできない** (Messaging API に通話 API は無い)。 |

出典: LINE 公式ブログ (electron 電話占い告知) https://line-ja.officialblog.jp/archives/72325726.html ・ LINE占い https://fortune.line.me/talk ・ LINEヤフー for Business (LINEコール) https://lme.jp/media/line/linecall/ ・ LINEヘルプ https://help.line.me/line/?contentId=20017541

## B. LIFF × 自作 WebRTC の可否 (事例ではなく検証・実装ガイド)

| ソース | 内容 |
|---|---|
| Qiita「LIFFでWebRTCが動くかを検証」 | 動作するが iOS 等で制約あり、という我々と同じ結論。 https://qiita.com/tetrapod117/items/c958da63e1d1300d3f68 |
| ブイキューブ「LIFFでビデオ通話の実装」 | LIFF に Agora を組み込む How-to。**導入事例ではなく SDK ベンダーの実装ガイド**。 https://jp.vcube.com/sdk/blog/liff |
| モンスターラボ「LIFFとは」 | LIFF の一般解説 (通話事例は無し)。 https://monstar-lab.com/dx/about/about-liff/ |

## C. WebRTC 自作の実サービス (ただし LINE ではなく独自 Web/アプリ)

| サービス | 技術 | 提供形態 |
|---|---|---|
| CLINICS (オンライン診療) | SkyWay (NTT) の WebRTC、500+ 医療機関 | **自社アプリ/Web** (LIFF ではない)。 https://skyway.ntt.com/blog/entry/onlinemedicaltreatment |

## 主要 WebRTC 商用 SDK (選定の参考)

Agora / Twilio / SkyWay / Sora (時雨堂) / Vonage / Amazon Chime / LiveKit。国産は SkyWay (NTT)・Sora。我々はセルフホスト要件から **LiveKit (OSS) セルフホスト** を採用済み。
出典: ブイキューブ「WebRTC商用サービス比まとめ (2025)」 https://jp.vcube.com/sdk/blog/summary-of-webrtc-commercial-services.-twilio-skyway-sora-agora.io-etc.html

---

## 我々の設計への含意

- **大手の「LINE 内で純正通話」を競合ベンチマークにしない。** 彼らは第三者非開放の LINE Call を使っており、同じ体験 (LINE アプリ内でそのまま通話) は自作では再現できない。
- **同じ土俵 (LIFF + 自作 WebRTC + AI 音声) の他社事例が乏しい** = 差別化余地。一方で「なぜ皆やらないか」の壁も実在する:
  - iOS の LINE 内ブラウザ (in-app browser) での WebRTC/getUserMedia 制約
  - 外部ブラウザ誘導の UX 摩擦
  - → 我々は `liff.openWindow({external:true})` + ワンタイム引き継ぎトークンで既に回避策を実装済み。
- **AI 音声エージェント × LIFF は前例が薄い新領域**。競合が少ない反面、前例のない UX 検証 (実機・LINE 内ブラウザ) を自前で積む必要がある。

## 未調査 (次に当たるなら)

- SkyWay / Agora / ブイキューブの「導入事例ページ」に LIFF 明記の相談系があるか
- 英語圏の「LINE LIFF voice agent / voicebot」事例 (AI 音声 × LIFF)

## 注意

上記の URL・数値は 2026-09-03 時点の検索結果に基づく。料金・事例は各社ページで最新を確認すること。
