// 通話セッション (call_sessions) のライフサイクル。
//
//   confirmed booking ──ensureCallSession──▶ scheduled
//     ─(cron notify)─▶ LINE Push「通話リンク」
//     ─(LiveKit webhook participant_joined)─▶ in_progress
//     ─(LiveKit webhook room_finished)─▶ ended (bookings.completed)
//     ─(cron close_at 経過・未接続)─▶ no_show (bookings.no_show)

import type { LiveKitConfig } from './livekit.js';
import { createAccessToken, createRoom, deleteRoom, startAudioRecording, updateRoomMetadata, type EgressS3 } from './livekit.js';

export const CALL_OPEN_BEFORE_MIN = 10;
export const CALL_CLOSE_AFTER_MIN = 15;
export const HANDOFF_TTL_SEC = 300;

export type CallRole = 'customer' | 'staff';

export interface CallSessionRow {
  id: string;
  booking_id: string;
  line_account_id: string;
  room_name: string;
  status: 'scheduled' | 'in_progress' | 'ended' | 'no_show' | 'cancelled';
  open_from: string;
  close_at: string;
  notify_at: string;
  notified_at: string | null;
  customer_joined_at: string | null;
  staff_joined_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  billable_seconds: number | null;
  mode: CallMode;
  handoff_reason: string | null;
  ai_summary: string | null;
  recording_egress_id: string | null;
  agent_joined_at: string | null;
}

export type CallMode = 'ai' | 'human_requested' | 'human';
export const AGENT_IDENTITY = 'agent';

// Room metadata (JSON)。エージェントはこれを見て参加可否・モードを決める。
export interface RoomMeta {
  talk: true;
  call_session_id: string;
  booking_id: string;
  mode: CallMode;
  customer_name: string | null;
  staff_name: string;
  menu_name: string;
  language: 'ja';
}

export function buildRoomMeta(s: CallSessionRow, b: { customer_name: string | null; staff_name: string; menu_name: string }): RoomMeta {
  return {
    talk: true,
    call_session_id: s.id,
    booking_id: s.booking_id,
    mode: s.mode ?? 'ai',
    customer_name: b.customer_name,
    staff_name: b.staff_name,
    menu_name: b.menu_name,
    language: 'ja',
  };
}

export function customerIdentity(friendId: string): string {
  return `customer:${friendId}`;
}
export function staffIdentity(staffId: string): string {
  return `staff:${staffId}`;
}
export function parseIdentity(identity: string): { role: CallRole | 'agent'; id: string } | null {
  if (identity === AGENT_IDENTITY) return { role: 'agent', id: AGENT_IDENTITY };
  const m = /^(customer|staff):(.+)$/.exec(identity);
  return m ? { role: m[1] as CallRole, id: m[2] } : null;
}

// bookings が confirmed になったときに 1 回だけ呼ぶ。既に存在すれば no-op。
export async function ensureCallSession(
  db: D1Database,
  args: { bookingId: string; now: Date },
): Promise<{ created: boolean }> {
  const b = await db
    .prepare(`SELECT id, line_account_id, starts_at, ends_at FROM bookings WHERE id = ?`)
    .bind(args.bookingId)
    .first<{ id: string; line_account_id: string; starts_at: string; ends_at: string }>();
  if (!b) return { created: false };
  const starts = new Date(b.starts_at).getTime();
  const ends = new Date(b.ends_at).getTime();
  const openFrom = new Date(starts - CALL_OPEN_BEFORE_MIN * 60_000).toISOString();
  const closeAt = new Date(ends + CALL_CLOSE_AFTER_MIN * 60_000).toISOString();
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO call_sessions
         (id, booking_id, line_account_id, room_name, open_from, close_at, notify_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), b.id, b.line_account_id, `call-${b.id}`, openFrom, closeAt, openFrom)
    .run();
  return { created: (res.meta?.changes ?? 0) > 0 };
}

export async function cancelCallSession(db: D1Database, bookingId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE call_sessions SET status='cancelled', updated_at=strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')
        WHERE booking_id = ? AND status IN ('scheduled')`,
    )
    .bind(bookingId)
    .run();
}

export async function getCallSessionByBooking(db: D1Database, bookingId: string): Promise<CallSessionRow | null> {
  return db.prepare(`SELECT * FROM call_sessions WHERE booking_id = ?`).bind(bookingId).first<CallSessionRow>();
}

export async function getCallSessionByRoom(db: D1Database, room: string): Promise<CallSessionRow | null> {
  return db.prepare(`SELECT * FROM call_sessions WHERE room_name = ?`).bind(room).first<CallSessionRow>();
}

export function isJoinWindowOpen(s: CallSessionRow, now: Date): boolean {
  const t = now.getTime();
  return (
    (s.status === 'scheduled' || s.status === 'in_progress')
    && t >= new Date(s.open_from).getTime()
    && t <= new Date(s.close_at).getTime()
  );
}

// 参加トークン発行。room は冪等に作成 (max 2 人・空室 2 分で自動削除)。
export async function issueJoinToken(
  cfg: LiveKitConfig,
  s: CallSessionRow,
  who: { role: CallRole; id: string; displayName: string },
  now: Date,
  meta?: RoomMeta,
): Promise<{ token: string; url: string; room: string }> {
  // 3 人 = 顧客 + オペレーター + AI エージェント。metadata は初回作成時のみ反映される
  // (既存 room には CreateRoom は no-op)。モード変更は updateRoomMetadata で行う。
  await createRoom(cfg, {
    name: s.room_name,
    maxParticipants: 3,
    emptyTimeoutSec: 120,
    metadata: meta ? JSON.stringify(meta) : undefined,
  });
  const ttl = Math.max(60, Math.floor((new Date(s.close_at).getTime() - now.getTime()) / 1000));
  const identity = who.role === 'customer' ? customerIdentity(who.id) : staffIdentity(who.id);
  const token = await createAccessToken(cfg, {
    identity,
    name: who.displayName,
    ttlSeconds: ttl,
    grant: { roomJoin: true, room: s.room_name, canPublish: true, canSubscribe: true, canPublishData: false },
  });
  return { token, url: cfg.url, room: s.room_name };
}

// ---- Handoff token (LINE 内ブラウザ → 外部ブラウザ) -------------------------

export async function createHandoffToken(
  db: D1Database,
  args: { callSessionId: string; role: CallRole; now: Date },
): Promise<string> {
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const exp = new Date(args.now.getTime() + HANDOFF_TTL_SEC * 1000).toISOString();
  await db.batch([
    db.prepare(`DELETE FROM call_handoff_tokens WHERE expires_at <= ?`).bind(args.now.toISOString()),
    db
      .prepare(`INSERT INTO call_handoff_tokens (token, call_session_id, role, expires_at) VALUES (?,?,?,?)`)
      .bind(token, args.callSessionId, args.role, exp),
  ]);
  return token;
}

// 1 回限り消費。成功時にセッション ID と role を返す。
export async function consumeHandoffToken(
  db: D1Database,
  token: string,
  now: Date,
): Promise<{ callSessionId: string; role: CallRole } | null> {
  const res = await db
    .prepare(
      `UPDATE call_handoff_tokens SET consumed_at = ?
        WHERE token = ? AND consumed_at IS NULL AND expires_at > ?
        RETURNING call_session_id, role`,
    )
    .bind(now.toISOString(), token, now.toISOString())
    .first<{ call_session_id: string; role: CallRole }>();
  return res ? { callSessionId: res.call_session_id, role: res.role } : null;
}

// ---- Webhook 反映 ----------------------------------------------------------

const touch = `updated_at = strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')`;

export async function onParticipantJoined(
  db: D1Database,
  s: CallSessionRow,
  identity: string,
  at: Date,
): Promise<void> {
  const who = parseIdentity(identity);
  if (!who) return;
  if (who.role === 'agent') {
    await db
      .prepare(`UPDATE call_sessions SET agent_joined_at = COALESCE(agent_joined_at, ?), ${touch} WHERE id = ?`)
      .bind(at.toISOString(), s.id)
      .run();
    return;
  }
  const col = who.role === 'customer' ? 'customer_joined_at' : 'staff_joined_at';
  await db
    .prepare(`UPDATE call_sessions SET ${col} = COALESCE(${col}, ?), ${touch} WHERE id = ?`)
    .bind(at.toISOString(), s.id)
    .run();
  // 顧客 + (オペレーター or AI エージェント) が揃ったら in_progress + started_at。
  // AI 先行応対なので、エージェント入室でも通話開始とみなす (課金対象)。
  await db
    .prepare(
      `UPDATE call_sessions
          SET status = 'in_progress', started_at = COALESCE(started_at, ?), ${touch}
        WHERE id = ? AND status = 'scheduled'
          AND customer_joined_at IS NOT NULL
          AND (staff_joined_at IS NOT NULL OR agent_joined_at IS NOT NULL)`,
    )
    .bind(at.toISOString(), s.id)
    .run();
}

// room_finished: 課金時間を確定し bookings を completed / no_show に進める。
export async function onRoomFinished(
  db: D1Database,
  s: CallSessionRow,
  at: Date,
): Promise<{ outcome: 'ended' | 'no_show' | 'ignored' }> {
  const fresh = await db.prepare(`SELECT * FROM call_sessions WHERE id = ?`).bind(s.id).first<CallSessionRow>();
  if (!fresh || fresh.status === 'ended' || fresh.status === 'no_show' || fresh.status === 'cancelled') {
    return { outcome: 'ignored' };
  }
  // 通話が成立していない (片方しか来ていない) 状態で room が閉じた場合は、
  // まだ close_at 前なら再入室の余地を残すため何もしない。
  if (!fresh.started_at) {
    if (at.getTime() < new Date(fresh.close_at).getTime()) return { outcome: 'ignored' };
    await markNoShow(db, fresh);
    return { outcome: 'no_show' };
  }
  const billable = Math.max(0, Math.floor((at.getTime() - new Date(fresh.started_at).getTime()) / 1000));
  await db.batch([
    db
      .prepare(`UPDATE call_sessions SET status='ended', ended_at=?, billable_seconds=?, ${touch} WHERE id = ?`)
      .bind(at.toISOString(), billable, fresh.id),
    db
      .prepare(`UPDATE bookings SET status='completed', updated_at=strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')
                 WHERE id = ? AND status = 'confirmed'`)
      .bind(fresh.booking_id),
  ]);
  return { outcome: 'ended' };
}

async function markNoShow(db: D1Database, s: CallSessionRow): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE call_sessions SET status='no_show', ${touch} WHERE id = ? AND status='scheduled'`).bind(s.id),
    db
      .prepare(`UPDATE bookings SET status='no_show', updated_at=strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')
                 WHERE id = ? AND status = 'confirmed'`)
      .bind(s.booking_id),
  ]);
}

// ---- Cron -------------------------------------------------------------------

export interface CallNotifyRow {
  id: string;
  booking_id: string;
  starts_at: string;
  menu_name: string;
  staff_name: string;
  channel_access_token: string;
  line_user_id: string;
}

export type CallLinkSender = (p: {
  channelAccessToken: string;
  toLineUserId: string;
  callUrl: string;
  ctx: { menuName: string; staffName: string; startsAtJst: string };
}) => Promise<void>;

const JST_OFFSET_MS = 9 * 3600_000;
function startsAtJst(utcIso: string): string {
  const jst = new Date(new Date(utcIso).getTime() + JST_OFFSET_MS).toISOString();
  return `${jst.slice(0, 10)} ${jst.slice(11, 16)}`;
}

// 開始 10 分前に通話リンクを Push。LIFF URL は {liffUrlBase}/call/{booking_id}。
export async function processCallNotifications(
  db: D1Database,
  params: { now: Date; liffUrlBase: string; sender: CallLinkSender },
): Promise<{ sent: number; failed: number }> {
  const due = await db
    .prepare(
      `SELECT cs.id, cs.booking_id, b.starts_at,
              m.name AS menu_name, s.display_name AS staff_name,
              la.channel_access_token, f.line_user_id
         FROM call_sessions cs
         INNER JOIN bookings b ON b.id = cs.booking_id
         INNER JOIN menus m ON m.id = b.menu_id
         INNER JOIN staff s ON s.id = b.staff_id
         INNER JOIN line_accounts la ON la.id = cs.line_account_id
         INNER JOIN friends f ON f.id = b.friend_id
        WHERE cs.status = 'scheduled' AND cs.notified_at IS NULL
          AND cs.notify_at <= ? AND cs.close_at > ?
          AND b.status = 'confirmed'
        LIMIT 100`,
    )
    .bind(params.now.toISOString(), params.now.toISOString())
    .all<CallNotifyRow>();
  let sent = 0;
  let failed = 0;
  for (const row of due.results) {
    const callUrl = `${params.liffUrlBase.replace(/\/$/, '')}/call/${row.booking_id}`;
    try {
      await params.sender({
        channelAccessToken: row.channel_access_token,
        toLineUserId: row.line_user_id,
        callUrl,
        ctx: { menuName: row.menu_name, staffName: row.staff_name, startsAtJst: startsAtJst(row.starts_at) },
      });
      await db
        .prepare(`UPDATE call_sessions SET notified_at = ?, ${touch} WHERE id = ?`)
        .bind(params.now.toISOString(), row.id)
        .run();
      sent++;
    } catch (e) {
      failed++;
      await db
        .prepare(`UPDATE call_sessions SET last_error = ?, ${touch} WHERE id = ?`)
        .bind(String(e).slice(0, 500), row.id)
        .run();
    }
  }
  return { sent, failed };
}

// close_at を過ぎても通話が成立しなかったセッションを no_show に確定し、room を掃除。
export async function expireCallSessions(
  db: D1Database,
  params: { now: Date; livekit?: LiveKitConfig },
): Promise<{ noShow: number }> {
  const rows = await db
    .prepare(
      `SELECT * FROM call_sessions
        WHERE status IN ('scheduled','in_progress') AND close_at <= ?
        LIMIT 100`,
    )
    .bind(params.now.toISOString())
    .all<CallSessionRow>();
  let noShow = 0;
  for (const s of rows.results) {
    if (s.started_at) {
      // webhook 取りこぼし: 終了扱いにする
      await onRoomFinished(db, s, new Date(s.close_at));
    } else {
      await markNoShow(db, s);
      noShow++;
    }
    if (params.livekit) {
      await deleteRoom(params.livekit, s.room_name).catch((e) => console.error('[call-expirer] deleteRoom', e));
    }
  }
  return { noShow };
}

// ---- モード切替 (AI ⇄ 人間) ----------------------------------------------------

const MODE_TRANSITIONS: Record<CallMode, CallMode[]> = {
  ai: ['human_requested', 'human'],
  human_requested: ['human', 'ai'],
  human: ['ai'],
};

export async function setCallMode(
  db: D1Database,
  cfg: LiveKitConfig | null,
  s: CallSessionRow,
  next: CallMode,
  opts: { reason?: string; by: 'operator' | 'agent' | 'customer' | 'system'; meta?: RoomMeta },
): Promise<{ ok: boolean; error?: string }> {
  const cur = s.mode ?? 'ai';
  if (cur !== next && !MODE_TRANSITIONS[cur].includes(next)) return { ok: false, error: `invalid_transition:${cur}->${next}` };
  await db
    .prepare(`UPDATE call_sessions SET mode = ?, handoff_reason = ?, ${touch} WHERE id = ?`)
    .bind(next, opts.reason ?? null, s.id)
    .run();
  await db
    .prepare(`INSERT INTO call_transcripts (id, call_session_id, seq, role, text, mode, at) VALUES (?,?,?,?,?,?,?)`)
    .bind(crypto.randomUUID(), s.id, -Date.now(), 'system', `mode: ${cur} → ${next} (${opts.by}${opts.reason ? ': ' + opts.reason : ''})`, next, new Date().toISOString())
    .run();
  if (cfg && opts.meta) {
    try {
      await updateRoomMetadata(cfg, s.room_name, JSON.stringify({ ...opts.meta, mode: next }));
    } catch (e) {
      // room 未作成 (誰も入室前) は無視。入室時に createRoom が最新 mode を載せる。
      if (!String(e).includes('404')) throw e;
    }
  }
  return { ok: true };
}

export interface TranscriptIn {
  seq: number;
  role: 'customer' | 'assistant' | 'operator' | 'system';
  text: string;
  at: string;
}

export async function appendTranscripts(db: D1Database, s: CallSessionRow, items: TranscriptIn[]): Promise<number> {
  if (items.length === 0) return 0;
  const mode = s.mode ?? 'ai';
  await db.batch(
    items.map((t) =>
      db
        .prepare(`INSERT OR IGNORE INTO call_transcripts (id, call_session_id, seq, role, text, mode, at) VALUES (?,?,?,?,?,?,?)`)
        .bind(crypto.randomUUID(), s.id, t.seq, t.role, t.text.slice(0, 4000), mode, t.at),
    ),
  );
  return items.length;
}

export async function listTranscripts(db: D1Database, callSessionId: string, afterSeq = -Infinity) {
  const rows = await db
    .prepare(
      `SELECT seq, role, text, mode, at FROM call_transcripts
        WHERE call_session_id = ? ${Number.isFinite(afterSeq) ? 'AND seq > ?' : ''}
        ORDER BY at ASC, seq ASC LIMIT 500`,
    )
    .bind(...(Number.isFinite(afterSeq) ? [callSessionId, afterSeq] : [callSessionId]))
    .all<{ seq: number; role: string; text: string; mode: string; at: string }>();
  return rows.results;
}

export async function setSummary(db: D1Database, s: CallSessionRow, summary: string): Promise<void> {
  await db.prepare(`UPDATE call_sessions SET ai_summary = ?, ${touch} WHERE id = ?`).bind(summary.slice(0, 8000), s.id).run();
}

// ---- 録音 (Egress) ------------------------------------------------------------------

export async function ensureRecording(
  db: D1Database,
  cfg: LiveKitConfig,
  s3: EgressS3 | null,
  s: CallSessionRow,
): Promise<void> {
  if (!s3 || s.recording_egress_id) return;
  const filepath = `calls/${s.booking_id}/${s.id}.ogg`;
  const { egressId } = await startAudioRecording(cfg, { room: s.room_name, filepath, s3 });
  await db
    .prepare(`UPDATE call_sessions SET recording_egress_id = ?, ${touch} WHERE id = ? AND recording_egress_id IS NULL`)
    .bind(egressId, s.id)
    .run();
}
