-- TalkPlatform: AI エージェント (Grok STT/LLM/TTS) と人間オペレーターの切替、文字起こし、録音。
--
-- mode:
--   ai              AI が応対中 (既定)
--   human_requested AI またはユーザーが引き継ぎを要請、オペレーター待ち
--   human           オペレーターが応対中 (AI は聞き役として文字起こしを継続)
ALTER TABLE call_sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'ai';
ALTER TABLE call_sessions ADD COLUMN handoff_reason TEXT;
ALTER TABLE call_sessions ADD COLUMN ai_summary TEXT;
ALTER TABLE call_sessions ADD COLUMN recording_egress_id TEXT;
ALTER TABLE call_sessions ADD COLUMN agent_joined_at TEXT;

CREATE TABLE IF NOT EXISTS call_transcripts (
  id               TEXT PRIMARY KEY,
  call_session_id  TEXT NOT NULL,
  seq              INTEGER NOT NULL,                 -- エージェント側の通し番号 (冪等化)
  role             TEXT NOT NULL CHECK (role IN ('customer','assistant','operator','system')),
  text             TEXT NOT NULL,
  mode             TEXT NOT NULL,                    -- 発話時点の mode
  at               TEXT NOT NULL,                    -- UTC ISO8601
  FOREIGN KEY (call_session_id) REFERENCES call_sessions(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_call_transcripts_seq ON call_transcripts (call_session_id, seq);
CREATE INDEX IF NOT EXISTS idx_call_transcripts_session ON call_transcripts (call_session_id, at);
