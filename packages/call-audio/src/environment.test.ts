import { describe, expect, test } from 'vitest';
import { detectEnvironment } from './environment.js';

function fakeWin(secure = true) {
  return { isSecureContext: secure, RTCPeerConnection: function () {}, AudioContext: function () {}, matchMedia: () => ({ matches: false }) } as unknown as Window;
}
function fakeNav(ua: string, gum = true) {
  return { userAgent: ua, mediaDevices: gum ? { getUserMedia: () => {} } : undefined } as unknown as Navigator;
}

describe('detectEnvironment', () => {
  test('iOS LINE in-app browser', () => {
    const e = detectEnvironment(fakeNav('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari Line/14.0.0'), fakeWin());
    expect(e.os).toBe('ios');
    expect(e.inLineApp).toBe(true);
    expect(e.browser).toBe('line');
    expect(e.warnings.some((w) => w.includes('LINE 内ブラウザ'))).toBe(true);
  });
  test('iOS Safari', () => {
    const e = detectEnvironment(fakeNav('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'), fakeWin());
    expect(e.browser).toBe('safari');
    expect(e.inLineApp).toBe(false);
  });
  test('Android Chrome', () => {
    const e = detectEnvironment(fakeNav('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36'), fakeWin());
    expect(e.os).toBe('android');
    expect(e.browser).toBe('chrome');
  });
  test('insecure context / no getUserMedia flagged', () => {
    const e = detectEnvironment(fakeNav('Mozilla/5.0 (Windows NT 10.0) Chrome/120.0', false), fakeWin(false));
    expect(e.secureContext).toBe(false);
    expect(e.hasGetUserMedia).toBe(false);
    expect(e.warnings.length).toBeGreaterThanOrEqual(2);
  });
});
