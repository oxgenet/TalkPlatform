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
  consumeHandoffToken,
  createHandoffToken,
  getCallSessionByBooking,
  getCallSessionByRoom,
  isJoinWindowOpen,
  issueJoinToken,
  onParticipantJoined,
  onRoomFinished,
  type CallRole,
  type CallSessionRow,
} from '../services/call-session.js';
import { verifyWebhook, type LiveKitConfig } from '../services/livekit.js';

const calls = new Hono<Env>();

export function livekitConfig(env: Env['Bindings']): LiveKitConfig | null {
  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) return null;
  return { url: env.LIVEKIT_URL, apiKey: env.LIVEKIT_API_KEY, apiSecret: env.LIVEKIT_API_SECRET };
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
  const join = await issueJoinToken(cfg, s, who, now);
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
  const join = await issueJoinToken(cfg, s, { role: 'staff', id: b.staff_id, displayName: b.staff_name }, now);
  return c.json(join);
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

export default calls;
