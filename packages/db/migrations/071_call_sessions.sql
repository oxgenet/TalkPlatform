-- call_sessions: 予約 (bookings) 1件に対する LiveKit 音声通話セッション。
--
-- bookings が confirmed になった時点で 1 行作成し、開始 10 分前〜終了 15 分後の
-- ウィンドウ内だけ参加トークンを発行する。LiveKit の Webhook (participant_joined /
-- room_finished) で joined_at / ended_at / billable_seconds を確定し、
-- bookings.status を completed / no_show に進める。
--
-- 通話リンクの LINE Push は booking_reminders (kind CHECK が固定) を触らず、
-- notify_at / notified_at をこのテーブルに持たせて毎分 cron (call-notifier) が拾う。
CREATE TABLE IF NOT EXISTS call_sessions (
  id                  TEXT PRIMARY KEY,
  booking_id          TEXT NOT NULL UNIQUE,
  line_account_id     TEXT NOT NULL,
  room_name           TEXT NOT NULL UNIQUE,              -- "call-<booking_id>"
  status              TEXT NOT NULL DEFAULT 'scheduled'
                      CHECK (status IN ('scheduled','in_progress','ended','no_show','cancelled')),
  open_from           TEXT NOT NULL,                     -- UTC ISO8601: starts_at - 10min
  close_at            TEXT NOT NULL,                     -- UTC ISO8601: ends_at + 15min
  notify_at           TEXT NOT NULL,                     -- UTC ISO8601: starts_at - 10min
  notified_at         TEXT,
  customer_joined_at  TEXT,
  staff_joined_at     TEXT,
  started_at          TEXT,                              -- 双方が揃った時刻
  ended_at            TEXT,
  billable_seconds    INTEGER,
  recording_url       TEXT,
  last_error          TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  FOREIGN KEY (booking_id) REFERENCES bookings(id),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id)
);
CREATE INDEX IF NOT EXISTS idx_call_sessions_notify ON call_sessions (status, notified_at, notify_at);
CREATE INDEX IF NOT EXISTS idx_call_sessions_close ON call_sessions (status, close_at);

-- 通話画面を LINE 内ブラウザから外部ブラウザへ引き継ぐためのワンタイムトークン。
-- 5 分で失効、1 回使ったら consumed_at を立てる。
CREATE TABLE IF NOT EXISTS call_handoff_tokens (
  token            TEXT PRIMARY KEY,
  call_session_id  TEXT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('customer','staff')),
  expires_at       TEXT NOT NULL,
  consumed_at      TEXT,
  FOREIGN KEY (call_session_id) REFERENCES call_sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_call_handoff_expires ON call_handoff_tokens (expires_at);
