# セルフホスト LiveKit 構成

## 1 ノードで始める

```bash
cd infra/livekit
cp .env.example .env            # 値を設定
sed -i "s/REPLACE_WITH_API_KEY/$LIVEKIT_API_KEY/; s/REPLACE_WITH_API_SECRET/$LIVEKIT_API_SECRET/" livekit.yaml egress.yaml
sed -i "s/livekit.example.com/livekit.yourdomain.jp/" livekit.yaml Caddyfile
docker compose up -d
```

開けるポート: TCP 80/443 (Caddy)、UDP 7881 (メディア)、TCP 7882 (ICE-TCP)、UDP 3478 / TCP 5349 (TURN)。

Worker 側 (`wrangler.toml` / secrets):

| 変数 | 値 |
|---|---|
| `LIVEKIT_URL` | `wss://livekit.yourdomain.jp` |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | `.env` と同じ |
| `CALL_AGENT_SECRET` | `.env` と同じ |
| `RECORDING_S3_ENDPOINT` | Egress コンテナから見える MinIO の URL (同一ホストなら `http://127.0.0.1:9000`) |
| `RECORDING_S3_BUCKET` / `RECORDING_S3_ACCESS_KEY` / `RECORDING_S3_SECRET` | `.env` と同じ |

LiveKit の Webhook は `livekit.yaml` に追加:

```yaml
webhook:
  api_key: <LIVEKIT_API_KEY>
  urls:
    - https://your-worker.workers.dev/api/public/calls/livekit-webhook
```

## サイジングの目安 (1 対 1 音声 + AI エージェント)

| コンポーネント | 1 通話あたり | 1 ノード (4 vCPU / 8 GB) の目安 |
|---|---|---|
| SFU (livekit) | ~100 kbps ×3 参加者、CPU はごく小 | 数百通話 |
| TURN リレー | 通話の 15〜30% が該当、帯域 ×2 | 回線帯域で決まる |
| Egress (録音・音声のみ) | ~0.1 vCPU | 数十通話 |
| **Agent (VAD + STT/TTS ストリーム)** | **0.2〜0.5 vCPU、レイテンシは xAI API 依存** | **10〜20 通話/プロセス** |

→ 最初のボトルネックは **Agent**。`docker compose up -d --scale agent=N` で増やす。

## スケールアウト手順

1. **Agent を分離** (最初にやる): Agent だけ別ホストへ。`LIVEKIT_URL=wss://livekit.yourdomain.jp` に変えるだけ。台数を増やすと LiveKit が空きワーカーに job を配る。
2. **Egress を分離**: 録音比率が高ければ別ホスト (Redis を共有)。
3. **SFU をマルチノード**: `livekit.yaml` の `redis.address` を共有 Redis に向け、各ノードに公開 IP (`use_external_ip`)。前段に L4 LB (WebSocket のみ)。UDP は各ノード直結。ルームはノード固定なので 1 対 1 通話は自然に分散する。
4. **TURN を分離**: `turn.enabled: false` にして coturn を別ホストに (企業 FW 比率が高い場合)。
5. 監視: LiveKit は Prometheus メトリクス (`prometheus_port`) を出す。Agent は `livekit-agents` のメトリクスイベントを Worker へ送る拡張が可能。

単一障害点を許容する期間は、`docker compose` 一式と `.env` をバックアップし、**5 分で再構築**できる状態を維持するのが現実的。冗長化が要件になった時点で 3 へ進む。

## xAI 利用時の注意
- 音声データは xAI (STT/TTS) へ送られる。**外部送信があるのはこの 1 点だけ**。録音・文字起こし保存は自社側。
- xAI TTS WebSocket は「チームあたり 50 同時セッション」の上限がある (2026-08 時点の仕様)。同時通話が 50 を超える見込みなら xAI に上限引き上げを申請するか、TTS だけ別プロバイダ/セルフホストに切り替える (Agents のプラグイン差し替えで可能)。
