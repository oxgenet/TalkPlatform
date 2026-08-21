import { describe, expect, test } from 'vitest';
import { createAccessToken, signHs256, verifyHs256, verifyWebhook } from './livekit.js';

const cfg = { url: 'wss://x.livekit.cloud', apiKey: 'APIkey', apiSecret: 'secret-secret-secret' };

function decodePayload(jwt: string) {
  const b = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b + '='.repeat((4 - (b.length % 4)) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

describe('livekit jwt', () => {
  test('sign/verify roundtrip and tamper detection', async () => {
    const t = await signHs256({ a: 1, exp: Math.floor(Date.now() / 1000) + 60 }, cfg.apiSecret);
    expect(await verifyHs256(t, cfg.apiSecret)).toMatchObject({ a: 1 });
    expect(await verifyHs256(t, 'wrong')).toBeNull();
    expect(await verifyHs256(t.slice(0, -2) + 'xx', cfg.apiSecret)).toBeNull();
  });

  test('expired token rejected', async () => {
    const t = await signHs256({ exp: Math.floor(Date.now() / 1000) - 1 }, cfg.apiSecret);
    expect(await verifyHs256(t, cfg.apiSecret)).toBeNull();
  });

  test('access token carries LiveKit claims', async () => {
    const t = await createAccessToken(cfg, {
      identity: 'customer:f1',
      name: '太郎',
      ttlSeconds: 120,
      grant: { roomJoin: true, room: 'call-bk1', canPublish: true, canSubscribe: true },
    });
    const p = decodePayload(t);
    expect(p.iss).toBe('APIkey');
    expect(p.sub).toBe('customer:f1');
    expect(p.name).toBe('太郎');
    expect(p.video).toEqual({ roomJoin: true, room: 'call-bk1', canPublish: true, canSubscribe: true });
    expect(p.exp - p.iat).toBe(120);
  });
});

describe('livekit webhook', () => {
  async function sign(body: string, secret = cfg.apiSecret, iss = cfg.apiKey) {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
    const sha256 = btoa(String.fromCharCode(...new Uint8Array(d)));
    return signHs256({ iss, sha256, exp: Math.floor(Date.now() / 1000) + 60 }, secret);
  }

  test('valid signature returns parsed body', async () => {
    const body = JSON.stringify({ event: 'room_finished', room: { name: 'call-bk1' } });
    const r = await verifyWebhook(body, await sign(body), cfg);
    expect(r?.event).toBe('room_finished');
    expect(r?.room?.name).toBe('call-bk1');
  });

  test('body tamper / wrong secret / wrong issuer / missing header → null', async () => {
    const body = JSON.stringify({ event: 'room_finished', room: { name: 'call-bk1' } });
    const auth = await sign(body);
    expect(await verifyWebhook(body.replace('bk1', 'bk2'), auth, cfg)).toBeNull();
    expect(await verifyWebhook(body, await sign(body, 'other'), cfg)).toBeNull();
    expect(await verifyWebhook(body, await sign(body, cfg.apiSecret, 'someone'), cfg)).toBeNull();
    expect(await verifyWebhook(body, undefined, cfg)).toBeNull();
  });
});
