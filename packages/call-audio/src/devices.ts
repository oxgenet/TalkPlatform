// マイク権限・デバイス列挙・入力レベル計測 (LiveKit 非依存)。
// 「そもそもマイクが取れるか」「どのデバイスが選ばれているか」「声が入っているか」を
// 接続前に単体で確認できるようにする。

export interface MicDevice {
  deviceId: string;
  label: string;
  isDefault: boolean;
}

export type PermissionState = 'granted' | 'denied' | 'prompt' | 'unknown';

export async function queryMicPermission(): Promise<PermissionState> {
  try {
    // Safari は 'microphone' を未サポート → 例外 → unknown
    const st = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    return st.state as PermissionState;
  } catch {
    return 'unknown';
  }
}

// ラベルは権限取得後でないと空になる。
export async function listMicrophones(): Promise<MicDevice[]> {
  const devs = await navigator.mediaDevices.enumerateDevices();
  return devs
    .filter((d) => d.kind === 'audioinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `マイク ${i + 1}`, isDefault: d.deviceId === 'default' }));
}

export interface MicStreamOptions {
  deviceId?: string;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
}

export async function openMicrophone(opts: MicStreamOptions = {}): Promise<MediaStream> {
  const audio: MediaTrackConstraints = {
    echoCancellation: opts.echoCancellation ?? true,
    noiseSuppression: opts.noiseSuppression ?? true,
    autoGainControl: opts.autoGainControl ?? true,
  };
  if (opts.deviceId) audio.deviceId = { exact: opts.deviceId };
  return navigator.mediaDevices.getUserMedia({ audio, video: false });
}

export function describeTrack(track: MediaStreamTrack): Record<string, unknown> {
  const s = track.getSettings();
  return {
    label: track.label,
    enabled: track.enabled,
    muted: track.muted,
    readyState: track.readyState,
    sampleRate: s.sampleRate,
    channelCount: s.channelCount,
    echoCancellation: s.echoCancellation,
    noiseSuppression: s.noiseSuppression,
    autoGainControl: s.autoGainControl,
    deviceId: s.deviceId,
  };
}

// RMS レベルメーター。0..1 を onLevel に ~20fps で通知。stop() で解放。
export function startLevelMeter(stream: MediaStream, onLevel: (level: number) => void): { stop: () => void; ctx: AudioContext } {
  const AC = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
  const ctx = new AC();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let raf = 0;
  let last = 0;
  const tick = (t: number) => {
    raf = requestAnimationFrame(tick);
    if (t - last < 50) return;
    last = t;
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
  };
  raf = requestAnimationFrame(tick);
  return {
    ctx,
    stop: () => {
      cancelAnimationFrame(raf);
      src.disconnect();
      void ctx.close();
    },
  };
}

// ループバック: 自分のマイクを自分のスピーカーに返す (ハウリング注意、イヤホン推奨)。
export function startLoopback(stream: MediaStream): { stop: () => void } {
  const el = document.createElement('audio');
  el.srcObject = stream;
  el.autoplay = true;
  el.setAttribute('playsinline', 'true');
  document.body.appendChild(el);
  void el.play().catch(() => {});
  return { stop: () => { el.pause(); el.srcObject = null; el.remove(); } };
}

// テストトーン再生 (スピーカー出力・自動再生ポリシーの確認)。
export async function playTestTone(durationMs = 600, freq = 440): Promise<void> {
  const AC = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
  const ctx = new AC();
  await ctx.resume();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  gain.gain.value = 0.1;
  osc.frequency.value = freq;
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  await new Promise((r) => setTimeout(r, durationMs));
  osc.stop();
  await ctx.close();
}
