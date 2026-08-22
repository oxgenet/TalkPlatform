// TalkPlatform: 予約 (bookings) に紐づく LiveKit 音声通話。
//
//   LIFF (顧客)   GET  /api/liff/calls/:bookingId            状態
//                 POST /api/liff/calls/:bookingId/token      参加トークン
//                 POST /api/liff/calls/:bookingId/handoff    外部ブラウザ引き継ぎ URL
//   公開 (引き継ぎ) POST /api/public/calls/handoff/:token    ワンタイム → 参加トークン
//   管理 (スタッフ) GET  /api/calls/:bookingId               状態
//                 POST /api/calls/:bookingId/token           参加トークン
//   LiveKit       POST /api/public/calls/livekit-webhook     署名付き Webhook
//
// 認証:
//   /api/liff/*   既存 booking ルートと同じ LIFF id_token 検証
//   /api/calls/*  既存 authMiddleware (Bearer API key / admin cookie)
//   /api/public/* authMiddleware はスキップされる前提 (index.ts の public 扱いに合わせる)

import { Hono, type Context } from 'hono';
import type { Env } from '../index.js';
import {
  resolveAccountIdFromLiff,
  resolveFriendId,
  verifyCallerLineUserId,
} from './booking.js';
import {
  appendTranscripts,
  buildRoomMeta,
  consumeHandoffToken,
  createHandoffToken,
  ensureRecording,
  getCallSessionByBooking,
  getCallSessionByRoom,
  isJoinWindowOpen,
  issueJoinToken,
  listTranscripts,
  onParticipantJoined,
  onRoomFinished,
  setCallMode,
  setSummary,
  type CallMode,
  type CallRole,
  type CallSessionRow,
  type TranscriptIn,
} from '../services/call-session.js';
import { createAccessToken, verifyWebhook, type EgressS3, type LiveKitConfig } from '../services/livekit.js';

const calls = new Hono<Env>();

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function livekitConfig(env: Env['Bindings']): LiveKitConfig | null {
  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) return null;
  return { url: env.LIVEKIT_URL, apiKey: env.LIVEKIT_API_KEY, apiSecret: env.LIVEKIT_API_SECRET };
}

export function recordingS3(env: Env['Bindings']): EgressS3 | null {
  if (!env.RECORDING_S3_BUCKET || !env.RECORDING_S3_ENDPOINT || !env.RECORDING_S3_ACCESS_KEY || !env.RECORDING_S3_SECRET) return null;
  return {
    bucket: env.RECORDING_S3_BUCKET,
    endpoint: env.RECORDING_S3_ENDPOINT,
    accessKey: env.RECORDING_S3_ACCESS_KEY,
    secret: env.RECORDING_S3_SECRET,
    region: env.RECORDING_S3_REGION,
  };
}

interface BookingCtx {
  id: string;
  line_account_id: string;
  friend_id: string;
  staff_id: string;
  status: string;
  starts_at: string;
  ends_at: string;
  menu_name: string;
  staff_name: string;
  customer_name: string | null;
}

async function loadBooking(db: D1Database, bookingId: string): Promise<BookingCtx | null> {
  return db
    .prepare(
      `SELECT b.id, b.line_account_id, b.friend_id, b.staff_id, b.status, b.starts_at, b.ends_at,
              m.name AS menu_name, s.display_name AS staff_name, f.display_name AS customer_name
         FROM bookings b
         INNER JOIN menus m ON m.id = b.menu_id
         INNER JOIN staff s ON s.id = b.staff_id
         INNER JOIN friends f ON f.id = b.friend_id
        WHERE b.id = ?`,
    )
    .bind(bookingId)
    .first<BookingCtx>();
}

function publicState(b: BookingCtx, s: CallSessionRow | null, now: Date) {
  return {
    booking_id: b.id,
    booking_status: b.status,
    starts_at: b.starts_at,
    ends_at: b.ends_at,
    menu_name: b.menu_name,
    staff_name: b.staff_name,
    customer_name: b.customer_name,
    call: s
      ? {
          status: s.status,
          open_from: s.open_from,
          close_at: s.close_at,
          can_join: isJoinWindowOpen(s, now),
          started_at: s.started_at,
          ended_at: s.ended_at,
          billable_seconds: s.billable_seconds,
          mode: s.mode ?? 'ai',
          handoff_reason: s.handoff_reason,
          ai_summary: s.ai_summary,
          agent_joined_at: s.agent_joined_at,
          recording: Boolean(s.recording_egress_id),
        }
      : null,
    now: now.toISOString(),
  };
}

// ---- 顧客 (LIFF) ------------------------------------------------------------

type CustomerAuth =
  | { error: { code: string; status: 401 | 404 } }
  | { booking: BookingCtx };

async function authCustomer(c: Context<Env>, bookingId: string): Promise<CustomerAuth> {
  const accountId = await resolveAccountIdFromLiff(c);
  if (!accountId) return { error: { code: 'unknown_liff', status: 404 } };
  const lineUserId = await verifyCallerLineUserId(c);
  if (!lineUserId) return { error: { code: 'unauthorized', status: 401 } };
  const friendId = await resolveFriendId(c, lineUserId, accountId);
  if (!friendId) return { error: { code: 'friend_not_found', status: 404 } };
  const b = await loadBooking(c.env.DB, bookingId);
  if (!b || b.line_account_id !== accountId || b.friend_id !== friendId) {
    return { error: { code: 'not_found', status: 404 } };
  }
  return { booking: b };
}

calls.get('/api/liff/calls/:bookingId', async (c) => {
  const r = await authCustomer(c, c.req.param('bookingId'));
  if ('error' in r) return c.json({ error: r.error.code }, r.error.status);
  const s = await getCallSessionByBooking(c.env.DB, r.booking.id);
  return c.json(publicState(r.booking, s, new Date()));
});

calls.post('/api/liff/calls/:bookingId/token', async (c) => {
  const cfg = livekitConfig(c.env);
  if (!cfg) return c.json({ error: 'livekit_not_configured' }, 503);
  const r = await authCustomer(c, c.req.param('bookingId'));
  if ('error' in r) return c.json({ error: r.error.code }, r.error.status);
  const now = new Date();
  const s = await getCallSessionByBooking(c.env.DB, r.booking.id);
  if (!s) return c.json({ error: 'no_call_session' }, 404);
  if (!isJoinWindowOpen(s, now)) return c.json({ error: 'not_open', ...publicState(r.booking, s, now) }, 409);
  const join = await issueJoinToken(
    cfg, s,
    { role: 'customer', id: r.booking.friend_id, displayName: r.booking.customer_name ?? 'お客様' },
    now,
    buildRoomMeta(s, r.booking),
  );
  return c.json(join);
});

calls.post('/api/liff/calls/:bookingId/handoff', async (c) => {
  const r = await authCustomer(c, c.req.param('bookingId'));
  if ('error' in r) return c.json({ error: r.error.code }, r.error.status);
  const s = await getCallSessionByBooking(c.env.DB, r.booking.id);
  if (!s) return c.json({ error: 'no_call_session' }, 404);
  const token = await createHandoffToken(c.env.DB, { callSessionId: s.id, role: 'customer', now: new Date() });
  return c.json({ handoff_token: token, expires_in: 300 });
});

// ---- 引き継ぎ (外部ブラウザ・無認証、ワンタイムトークンで担保) -----------------

calls.post('/api/public/calls/handoff/:token', async (c) => {
  const cfg = livekitConfig(c.env);
  if (!cfg) return c.json({ error: 'livekit_not_configured' }, 503);
  const now = new Date();
  const h = await consumeHandoffToken(c.env.DB, c.req.param('token'), now);
  if (!h) return c.json({ error: 'invalid_or_expired' }, 401);
  const s = await c.env.DB
    .prepare(`SELECT * FROM call_sessions WHERE id = ?`)
    .bind(h.callSessionId)
    .first<CallSessionRow>();
  if (!s) return c.json({ error: 'not_found' }, 404);
  const b = await loadBooking(c.env.DB, s.booking_id);
  if (!b) return c.json({ error: 'not_found' }, 404);
  if (!isJoinWindowOpen(s, now)) return c.json({ error: 'not_open', ...publicState(b, s, now) }, 409);
  const who =
    h.role === 'customer'
      ? { role: 'customer' as CallRole, id: b.friend_id, displayName: b.customer_name ?? 'お客様' }
      : { role: 'staff' as CallRole, id: b.staff_id, displayName: b.staff_name };
  const join = await issueJoinToken(cfg, s, who, now, buildRoomMeta(s, b));
  return c.json({ ...join, state: publicState(b, s, now) });
});

// ---- スタッフ (管理画面・authMiddleware 経由) -----------------------------------

calls.get('/api/calls/:bookingId', async (c) => {
  const b = await loadBooking(c.env.DB, c.req.param('bookingId'));
  if (!b) return c.json({ error: 'not_found' }, 404);
  const s = await getCallSessionByBooking(c.env.DB, b.id);
  return c.json(publicState(b, s, new Date()));
});

calls.post('/api/calls/:bookingId/token', async (c) => {
  const cfg = livekitConfig(c.env);
  if (!cfg) return c.json({ error: 'livekit_not_configured' }, 503);
  const now = new Date();
  const b = await loadBooking(c.env.DB, c.req.param('bookingId'));
  if (!b) return c.json({ error: 'not_found' }, 404);
  const s = await getCallSessionByBooking(c.env.DB, b.id);
  if (!s) return c.json({ error: 'no_call_session' }, 404);
  if (!isJoinWindowOpen(s, now)) return c.json({ error: 'not_open', ...publicState(b, s, now) }, 409);
  const join = await issueJoinToken(cfg, s, { role: 'staff', id: b.staff_id, displayName: b.staff_name }, now, buildRoomMeta(s, b));
  return c.json(join);
});

// ---- モード切替・文字起こし (管理画面) ------------------------------------------

calls.post('/api/calls/:bookingId/mode', async (c) => {
  const b = await loadBooking(c.env.DB, c.req.param('bookingId'));
  if (!b) return c.json({ error: 'not_found' }, 404);
  const s = await getCallSessionByBooking(c.env.DB, b.id);
  if (!s) return c.json({ error: 'no_call_session' }, 404);
  const body = await c.req.json<{ mode?: CallMode; reason?: string }>().catch(() => ({} as { mode?: CallMode; reason?: string }));
  if (body.mode !== 'ai' && body.mode !== 'human' && body.mode !== 'human_requested') return c.json({ error: 'bad_mode' }, 400);
  const r = await setCallMode(c.env.DB, livekitConfig(c.env), s, body.mode, { by: 'operator', reason: body.reason, meta: buildRoomMeta(s, b) });
  if (!r.ok) return c.json({ error: r.error }, 409);
  return c.json({ ok: true, mode: body.mode });
});

calls.get('/api/calls/:bookingId/transcript', async (c) => {
  const b = await loadBooking(c.env.DB, c.req.param('bookingId'));
  if (!b) return c.json({ error: 'not_found' }, 404);
  const s = await getCallSessionByBooking(c.env.DB, b.id);
  if (!s) return c.json({ items: [], summary: null, mode: 'ai' });
  const after = Number(c.req.query('after') ?? '');
  const items = await listTranscripts(c.env.DB, s.id, Number.isFinite(after) ? after : -Infinity);
  return c.json({ items, summary: s.ai_summary, mode: s.mode ?? 'ai', handoff_reason: s.handoff_reason });
});

// ---- エージェント → Worker (CALL_AGENT_SECRET で認証) -----------------------------
// エージェントは room 名 (call-<booking_id>) で自分のセッションを特定する。

type AgentEvent =
  | { type: 'transcript'; items: TranscriptIn[] }
  | { type: 'handoff_request'; reason?: string; by?: 'agent' | 'customer' }
  | { type: 'summary'; text: string }
  | { type: 'resume_ai' };

calls.post('/api/public/calls/agent-event', async (c) => {
  const secret = c.env.CALL_AGENT_SECRET;
  if (!secret || secret.length < 16) return c.json({ error: 'not_found' }, 404);
  const auth = (c.req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!timingSafeEqual(auth, secret)) return c.json({ error: 'unauthorized' }, 401);
  const body = await c.req.json<{ room: string; event: AgentEvent }>().catch(() => null);
  if (!body?.room || !body.event) return c.json({ error: 'bad_request' }, 400);
  const s = await getCallSessionByRoom(c.env.DB, body.room);
  if (!s) return c.json({ error: 'unknown_room' }, 404);
  const b = await loadBooking(c.env.DB, s.booking_id);
  if (!b) return c.json({ error: 'not_found' }, 404);
  const ev = body.event;
  switch (ev.type) {
    case 'transcript': {
      const n = await appendTranscripts(c.env.DB, s, (ev.items ?? []).slice(0, 200));
      return c.json({ ok: true, inserted: n });
    }
    case 'handoff_request': {
      const r = await setCallMode(c.env.DB, livekitConfig(c.env), s, 'human_requested', { by: ev.by ?? 'agent', reason: ev.reason, meta: buildRoomMeta(s, b) });
      return c.json({ ok: r.ok, error: r.error });
    }
    case 'resume_ai': {
      const r = await setCallMode(c.env.DB, livekitConfig(c.env), s, 'ai', { by: 'agent', meta: buildRoomMeta(s, b) });
      return c.json({ ok: r.ok, error: r.error });
    }
    case 'summary':
      await setSummary(c.env.DB, s, String(ev.text ?? ''));
      return c.json({ ok: true });
    default:
      return c.json({ error: 'unknown_event' }, 400);
  }
});

// ---- LiveKit Webhook -------------------------------------------------------------

calls.post('/api/public/calls/livekit-webhook', async (c) => {
  const cfg = livekitConfig(c.env);
  if (!cfg) return c.json({ error: 'livekit_not_configured' }, 503);
  const raw = await c.req.text();
  const body = await verifyWebhook(raw, c.req.header('Authorization'), cfg);
  if (!body) return c.json({ error: 'bad_signature' }, 401);
  const room = body.room?.name;
  if (!room) return c.json({ ok: true, ignored: 'no_room' });
  const s = await getCallSessionByRoom(c.env.DB, room);
  if (!s) return c.json({ ok: true, ignored: 'unknown_room' });
  const at = body.createdAt ? new Date(body.createdAt * 1000) : new Date();
  switch (body.event) {
    case 'room_started': {
      const lk = cfg;
      try {
        await ensureRecording(c.env.DB, lk, recordingS3(c.env), s);
      } catch (e) {
        console.error('[calls] start recording failed:', e);
      }
      break;
    }
    case 'participant_joined':
      if (body.participant?.identity) await onParticipantJoined(c.env.DB, s, body.participant.identity, at);
      break;
    case 'room_finished':
      await onRoomFinished(c.env.DB, s, at);
      break;
    case 'egress_ended': {
      const loc = body.egressInfo?.fileResults?.[0]?.location;
      if (loc) {
        await c.env.DB
          .prepare(`UPDATE call_sessions SET recording_url = ? WHERE id = ?`)
          .bind(loc, s.id)
          .run();
      }
      break;
    }
    default:
      break;
  }
  return c.json({ ok: true });
});

// ---- Audio Lab 用トークン発行 (CALL_LAB_SECRET 設定時のみ有効) ------------------
// 予約・LINE 認証なしで実機の音声検証をするための開発者向け口。room は "lab-" 接頭辞に
// 強制し、本番の call-<booking_id> ルームには入れない。本番では secret を設定しない。

calls.post('/api/public/calls/lab-token', async (c) => {
  const secret = c.env.CALL_LAB_SECRET;
  if (!secret || secret.length < 16) return c.json({ error: 'not_found' }, 404);
  const cfg = livekitConfig(c.env);
  if (!cfg) return c.json({ error: 'livekit_not_configured' }, 503);
  const auth = (c.req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!timingSafeEqual(auth, secret)) return c.json({ error: 'unauthorized' }, 401);
  type LabBody = { room?: string; identity?: string; name?: string };
  const body: LabBody = await c.req.json<LabBody>().catch(() => ({}) as LabBody);
  const room = `lab-${String(body.room ?? '1').replace(/^lab-/, '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || '1'}`;
  const identity = String(body.identity ?? `dev-${crypto.randomUUID().slice(0, 6)}`).replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 64);
  const token = await createAccessToken(cfg, {
    identity,
    name: body.name ?? identity,
    ttlSeconds: 3600,
    grant: { roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: false },
  });
  return c.json({ token, url: cfg.url, room, identity });
});

export default calls;
