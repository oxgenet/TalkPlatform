// LiveKit 連携 (Workers 互換・依存ゼロ)。
//
// livekit-server-sdk は Node API に依存する箇所があるため、Workers では
// WebCrypto で HS256 JWT を自前署名する。仕様は LiveKit の access token
// (https://docs.livekit.io/home/get-started/authentication/) と
// webhook (Authorization: <JWT> / claim sha256 = base64(SHA-256(body))) に従う。

export interface LiveKitConfig {
  url: string; // wss://xxx.livekit.cloud
  apiKey: string;
  apiSecret: string;
}

export interface VideoGrant {
  roomJoin?: boolean;
  room?: string;
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
  roomCreate?: boolean;
  roomAdmin?: boolean;
}

export interface AccessTokenOptions {
  identity: string;
  name?: string;
  ttlSeconds?: number;
  grant: VideoGrant;
  metadata?: string;
}

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string, usages: Array<'sign' | 'verify'>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

export async function signHs256(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(sig)}`;
}

export async function verifyHs256(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const key = await hmacKey(secret, ['verify']);
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    b64urlDecode(parts[2]),
    enc.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
    if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function createAccessToken(cfg: LiveKitConfig, opts: AccessTokenOptions): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSeconds ?? 3600;
  const payload: Record<string, unknown> = {
    iss: cfg.apiKey,
    sub: opts.identity,
    nbf: now - 10,
    iat: now,
    exp: now + ttl,
    video: opts.grant,
  };
  if (opts.name) payload.name = opts.name;
  if (opts.metadata) payload.metadata = opts.metadata;
  return signHs256(payload, cfg.apiSecret);
}

// ---- Webhook ---------------------------------------------------------------

export type LiveKitWebhookEvent =
  | 'room_started'
  | 'room_finished'
  | 'participant_joined'
  | 'participant_left'
  | 'egress_started'
  | 'egress_ended'
  | (string & {});

export interface LiveKitWebhookBody {
  event: LiveKitWebhookEvent;
  id?: string;
  createdAt?: number;
  room?: { name: string; sid?: string; creationTime?: number };
  participant?: { identity: string; sid?: string; joinedAt?: number; name?: string };
  egressInfo?: { egressId?: string; roomName?: string; fileResults?: Array<{ location?: string; filename?: string }> };
}

// 署名検証に成功したら body を返す。失敗は null。
export async function verifyWebhook(
  rawBody: string,
  authorization: string | undefined,
  cfg: Pick<LiveKitConfig, 'apiKey' | 'apiSecret'>,
): Promise<LiveKitWebhookBody | null> {
  if (!authorization) return null;
  const token = authorization.replace(/^Bearer\s+/i, '').trim();
  const claims = await verifyHs256(token, cfg.apiSecret);
  if (!claims || claims.iss !== cfg.apiKey) return null;
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(digest)));
  if (claims.sha256 !== expected) return null;
  try {
    return JSON.parse(rawBody) as LiveKitWebhookBody;
  } catch {
    return null;
  }
}

// ---- Room service (Twirp over HTTPS) --------------------------------------

function httpBase(url: string): string {
  return url.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://').replace(/\/$/, '');
}

async function twirp<T>(cfg: LiveKitConfig, method: string, body: unknown, grant: VideoGrant): Promise<T> {
  const token = await createAccessToken(cfg, { identity: 'server', ttlSeconds: 60, grant });
  const res = await fetch(`${httpBase(cfg.url)}/twirp/livekit.RoomService/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LiveKit ${method} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export async function createRoom(
  cfg: LiveKitConfig,
  opts: { name: string; emptyTimeoutSec?: number; maxParticipants?: number },
): Promise<void> {
  await twirp(
    cfg,
    'CreateRoom',
    { name: opts.name, empty_timeout: opts.emptyTimeoutSec ?? 120, max_participants: opts.maxParticipants ?? 2 },
    { roomCreate: true },
  );
}

export async function deleteRoom(cfg: LiveKitConfig, room: string): Promise<void> {
  try {
    await twirp(cfg, 'DeleteRoom', { room }, { roomCreate: true, roomAdmin: true, room });
  } catch (e) {
    // 既に存在しない room は無視
    if (!String(e).includes('404')) throw e;
  }
}
