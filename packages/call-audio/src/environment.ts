// 実行環境の判定。音声トラブルの大半は「どの OS / ブラウザ / 内蔵ブラウザか」で
// 切り分けられるため、UI とログの両方で使えるよう純関数にしておく。

export interface AudioEnvironment {
  ua: string;
  os: 'ios' | 'android' | 'mac' | 'windows' | 'other';
  browser: 'safari' | 'chrome' | 'firefox' | 'edge' | 'line' | 'other';
  inLineApp: boolean;        // LINE 内ブラウザ (UA に "Line/")
  isStandalonePwa: boolean;
  hasGetUserMedia: boolean;
  hasRTCPeerConnection: boolean;
  hasAudioContext: boolean;
  secureContext: boolean;    // getUserMedia は https か localhost でのみ動く
  warnings: string[];        // 既知の落とし穴
}

export function detectEnvironment(nav: Navigator = navigator, win: Window = window): AudioEnvironment {
  const ua = nav.userAgent;
  const os: AudioEnvironment['os'] = /iPhone|iPad|iPod/.test(ua)
    ? 'ios'
    : /Android/.test(ua)
      ? 'android'
      : /Mac OS X/.test(ua)
        ? 'mac'
        : /Windows/.test(ua)
          ? 'windows'
          : 'other';
  const inLineApp = /\bLine\//i.test(ua);
  const browser: AudioEnvironment['browser'] = inLineApp
    ? 'line'
    : /Edg\//.test(ua)
      ? 'edge'
      : /Firefox\//.test(ua)
        ? 'firefox'
        : /Chrome\//.test(ua) || /CriOS\//.test(ua)
          ? 'chrome'
          : /Safari\//.test(ua)
            ? 'safari'
            : 'other';
  const hasGetUserMedia = Boolean(nav.mediaDevices?.getUserMedia);
  const hasRTCPeerConnection = typeof (win as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection === 'function';
  const hasAudioContext = typeof (win as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown }).AudioContext === 'function'
    || typeof (win as unknown as { webkitAudioContext?: unknown }).webkitAudioContext === 'function';
  const secureContext = Boolean(win.isSecureContext);
  const isStandalonePwa = Boolean((nav as unknown as { standalone?: boolean }).standalone) || win.matchMedia?.('(display-mode: standalone)').matches === true;

  const warnings: string[] = [];
  if (!secureContext) warnings.push('非 https コンテキストです。getUserMedia は動作しません (localhost は除く)。');
  if (!hasGetUserMedia) warnings.push('getUserMedia が利用できません。');
  if (!hasRTCPeerConnection) warnings.push('RTCPeerConnection が利用できません。');
  if (inLineApp) warnings.push('LINE 内ブラウザです。iOS では WebRTC 音声が不安定なため、外部ブラウザで開いてください。');
  if (os === 'ios' && browser !== 'safari' && !inLineApp) warnings.push('iOS の Safari 以外のブラウザは WebKit ラッパーです。挙動が Safari と異なる場合は Safari で再確認してください。');
  if (os === 'ios') warnings.push('iOS: マイク取得と音声再生はユーザー操作 (タップ) のハンドラ内で開始する必要があります。');
  return { ua, os, browser, inLineApp, isStandalonePwa, hasGetUserMedia, hasRTCPeerConnection, hasAudioContext, secureContext, warnings };
}
