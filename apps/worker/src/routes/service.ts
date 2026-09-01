// TalkPlatform サービス層 API (アプリ層向け)。
//
// アプリ層 (LINE / スタンドアローン Web / 他プラットフォーム) はこの API だけを使い、
// LiveKit・エージェント・課金の詳細を知らない。認証は組織別 API キー:
//   SERVICE_API_KEYS="orgA:sk_xxxxxxxxxxxxxxxx,orgB:sk_yyyy..."
//
//   POST /api/service/sessions        { display_name?, scenario_id? } → 通話セッション発行
//   GET  /api/service/sessions/:id    状態取得
//   POST /api/service/sessions/:id/end 明示終了
//
// CORS: SERVICE_CORS_ORIGINS (カンマ区切り) に列挙した Web アプリの origin を許可。

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from '../index.js';
import { createAccessToken, createRoom } from '../services/livekit.js';
import { livekitConfig } from './calls.js';

const service = new Hono<Env>();

function parseOrgKeys(raw: string | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const item of (raw ?? '').split(',')) {
    const [org, key] = item.trim().split(':');
    if (org && key && key.length >= 16) m.set(key, org);
  }
  return m;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function authenticateOrg(env: Env['Bindings'], authorization: string | undefined): string | null {
  const keys = parseOrgKeys(env.SERVICE_API_KEYS);
  if (keys.size === 0) return null;
  const token = (authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  for (const [key, org] of keys) if (timingSafeEqual(token, key)) return org;
  return null;
}

service.use('/api/service/*', async (c, next) => {
  const origins = (c.env.SERVICE_CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return cors({ origin: origins.length ? origins : '*', allowHeaders: ['Authorization', 'Content-Type'] })(c, next);
});

service.use('/api/service/*', async (c, next) => {
  if (c.req.method === 'OPTIONS') return next();
  const org = authenticateOrg(c.env, c.req.header('Authorization'));
  if (!org) return c.json({ error: 'unauthorized' }, 401);
  c.set('serviceOrg' as never, org as never);
  return next();
});

const SESSION_TTL_MS = 2 * 3600_000;

service.post('/api/service/sessions', async (c) => {
  const cfg = livekitConfig(c.env);
  if (!cfg) return c.json({ error: 'livekit_not_configured' }, 503);
  const org = c.get('serviceOrg' as never) as string;
  type SessionBody = { display_name?: string; scenario_id?: string };
  const body: SessionBody = await c.req.json<SessionBody>().catch(() => ({}) as SessionBody);
  const id = crypto.randomUUID();
  const room = `sa-${id}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  await c.env.DB
    .prepare(`INSERT INTO standalone_sessions (id, org_id, room_name, display_name, scenario_id, expires_at) VALUES (?,?,?,?,?,?)`)
    .bind(id, org, room, body.display_name ?? null, body.scenario_id ?? null, expiresAt)
    .run();
  await createRoom(cfg, {
    name: room,
    maxParticipants: 3,
    emptyTimeoutSec: 300,
    metadata: JSON.stringify({
      talk: true,
      standalone: true,
      org_id: org,
      session_id: id,
      mode: 'ai',
      scenario_id: body.scenario_id ?? null,
      customer_name: body.display_name ?? null,
      staff_name: 'アシスタント',
      menu_name: 'オンライン相談',
      language: 'ja',
    }),
  });
  const token = await createAccessToken(cfg, {
    identity: `customer:sa-${id.slice(0, 8)}`,
    name: body.display_name ?? 'ゲスト',
    ttlSeconds: SESSION_TTL_MS / 1000,
    grant: { roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: false },
  });
  return c.json({ session_id: id, room, token, url: cfg.url, expires_at: expiresAt });
});

service.get('/api/service/sessions/:id', async (c) => {
  const org = c.get('serviceOrg' as never) as string;
  const row = await c.env.DB
    .prepare(`SELECT id, org_id, status, display_name, scenario_id, started_at, ended_at, billable_seconds, expires_at FROM standalone_sessions WHERE id = ?`)
    .bind(c.req.param('id'))
    .first<{ org_id: string } & Record<string, unknown>>();
  if (!row || row.org_id !== org) return c.json({ error: 'not_found' }, 404);
  return c.json(row);
});

service.post('/api/service/sessions/:id/end', async (c) => {
  const org = c.get('serviceOrg' as never) as string;
  const row = await c.env.DB
    .prepare(`UPDATE standalone_sessions SET status='ended', ended_at=COALESCE(ended_at, ?) WHERE id = ? AND org_id = ? RETURNING id`)
    .bind(new Date().toISOString(), c.req.param('id'), org)
    .first();
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

export default service;
