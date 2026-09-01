-- TalkPlatform アプリ層「スタンドアローンプラットフォーム」:
-- LINE 予約 (bookings) を経由しない、外部 Web アプリ / 自前 Web からの通話セッション。
-- サービス層 API (/api/service/*) が組織別 API キーで発行する。
CREATE TABLE IF NOT EXISTS standalone_sessions (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,                     -- SERVICE_API_KEYS の組織 ID
  room_name     TEXT NOT NULL UNIQUE,              -- "sa-<id>"
  display_name  TEXT,
  scenario_id   TEXT,                              -- 会話 DSL (将来)。NULL = 既定
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','ended','expired')),
  expires_at    TEXT NOT NULL,                     -- UTC ISO8601: 発行から 2h
  started_at    TEXT,
  ended_at      TEXT,
  billable_seconds INTEGER,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_standalone_org ON standalone_sessions (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_standalone_expires ON standalone_sessions (status, expires_at);
