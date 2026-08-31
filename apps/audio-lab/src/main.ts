// TalkPlatform Audio Lab — 段階的に切り分けるための単体検証ページ。
//
//  STEP 1 環境     : OS / ブラウザ / secure context / API 有無 (接続不要)
//  STEP 2 マイク   : 権限 → デバイス列挙 → レベルメーター → ループバック (接続不要)
//  STEP 3 スピーカー: テストトーン (自動再生ポリシー確認、接続不要)
//  STEP 4 LiveKit  : トークン貼り付け or Lab API で発行 → 接続 → 2 台で通話
//
// 本番 UI と同じ @talkplatform/call-audio を使うので、ここで通れば本番でも通る。

import {
  AudioCallSession,
  describeTrack,
  detectEnvironment,
  listMicrophones,
  openMicrophone,
  playTestTone,
  queryMicPermission,
  startLevelMeter,
  startLoopback,
  type CallSessionState,
} from '@talkplatform/call-audio';

const app = document.getElementById('app')!;
const qs = new URLSearchParams(location.search);
const saved = (k: string, d = '') => localStorage.getItem(`lab:${k}`) ?? qs.get(k) ?? d;
const save = (k: string, v: string) => localStorage.setItem(`lab:${k}`, v);

app.innerHTML = `
  <h1>TalkPlatform Audio Lab</h1>
  <p>予約・LINE 不要で音声だけを検証します。上から順に試してください。</p>

  <h2>1. 環境</h2>
  <pre id="env"></pre>
  <div id="envWarn"></div>

  <h2>2. マイク</h2>
  <div class="row">
    <button id="btnPerm">マイク権限を取得</button>
    <span id="perm" class="badge">unknown</span>
  </div>
  <select id="mics"></select>
  <label><input type="checkbox" id="ec" checked> echoCancellation</label>
  <label><input type="checkbox" id="ns" checked> noiseSuppression</label>
  <label><input type="checkbox" id="agc" checked> autoGainControl</label>
  <div class="meter"><div id="level"></div></div>
  <div class="row">
    <button id="btnLoop" class="secondary" disabled>ループバック (イヤホン推奨)</button>
    <button id="btnStopMic" class="secondary" disabled>マイク停止</button>
  </div>
  <pre id="track"></pre>

  <h2>3. スピーカー</h2>
  <button id="btnTone" class="secondary">テストトーン再生</button>
  <span id="toneRes"></span>

  <h2>4. AI と会話 (ワンタップ)</h2>
  <p>ローカルの LiveKit + AI エージェントに <code>customer:</code> として入室します。エージェントが起動していれば冒頭案内が流れます。</p>
  <div class="row">
    <input id="myname" placeholder="あなたの名前 (例: taka)" style="max-width: 200px" />
    <button id="btnAi">AI と会話を始める</button>
  </div>
  <div id="captions" style="margin-top:.5rem"></div>

  <h2>5. LiveKit 接続 (手動)</h2>
  <input id="url" placeholder="wss://livekit.yourdomain.jp" />
  <details>
    <summary>トークンを Worker の Lab API で発行する (CALL_LAB_SECRET 設定時)</summary>
    <input id="api" placeholder="https://your-worker.workers.dev" />
    <input id="secret" placeholder="CALL_LAB_SECRET" type="password" />
    <input id="room" placeholder="room (例: lab-1)" />
    <input id="identity" placeholder="identity (例: phone-a)" />
    <button id="btnMint" class="secondary">トークン発行</button>
  </details>
  <input id="token" placeholder="LiveKit access token (貼り付け)" />
  <div class="row">
    <button id="btnConnect">接続</button>
    <button id="btnMute" class="secondary" disabled>ミュート</button>
    <button id="btnResume" class="secondary" disabled>音が出ない→タップ</button>
    <button id="btnHangup" class="secondary" disabled>切断</button>
  </div>
  <div class="big" id="phase">idle</div>
  <div id="err" class="err"></div>
  <div id="stats"></div>
  <pre id="log"></pre>
  <button id="btnCopy" class="secondary">診断レポートをコピー</button>
`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- 1. 環境 ----
const env = detectEnvironment();
$('env').textContent = JSON.stringify({ ...env, ua: undefined, warnings: undefined }, null, 1) + '\nUA: ' + env.ua;
$('envWarn').innerHTML = env.warnings.map((w) => `<div class="warn">⚠ ${w}</div>`).join('');

// ---- 2. マイク ----
let micStream: MediaStream | null = null;
let meter: { stop: () => void } | null = null;
let loop: { stop: () => void } | null = null;

async function refreshMics() {
  const mics = await listMicrophones();
  const sel = $<HTMLSelectElement>('mics');
  const cur = sel.value || saved('mic');
  sel.innerHTML = mics.map((m) => `<option value="${m.deviceId}">${m.label}${m.isDefault ? ' (default)' : ''}</option>`).join('');
  if (cur && mics.some((m) => m.deviceId === cur)) sel.value = cur;
}
void queryMicPermission().then((p) => ($('perm').textContent = p));
void refreshMics();
navigator.mediaDevices?.addEventListener?.('devicechange', () => void refreshMics());

async function openMic() {
  stopMic();
  const deviceId = $<HTMLSelectElement>('mics').value || undefined;
  micStream = await openMicrophone({
    deviceId,
    echoCancellation: $<HTMLInputElement>('ec').checked,
    noiseSuppression: $<HTMLInputElement>('ns').checked,
    autoGainControl: $<HTMLInputElement>('agc').checked,
  });
  if (deviceId) save('mic', deviceId);
  const track = micStream.getAudioTracks()[0];
  $('track').textContent = JSON.stringify(describeTrack(track), null, 1);
  meter = startLevelMeter(micStream, (lv) => ($('level').style.width = `${Math.round(lv * 100)}%`));
  track.addEventListener('ended', () => ($('track').textContent += '\n!! track ended (OS に奪われた可能性)'));
  $<HTMLButtonElement>('btnLoop').disabled = false;
  $<HTMLButtonElement>('btnStopMic').disabled = false;
  $('perm').textContent = await queryMicPermission();
  await refreshMics();
}
function stopMic() {
  loop?.stop(); loop = null;
  meter?.stop(); meter = null;
  micStream?.getTracks().forEach((t) => t.stop()); micStream = null;
  $('level').style.width = '0';
  $<HTMLButtonElement>('btnLoop').disabled = true;
  $<HTMLButtonElement>('btnStopMic').disabled = true;
}
$('btnPerm').onclick = () => openMic().catch((e) => ($('track').textContent = `${e.name}: ${e.message}`));
$('btnStopMic').onclick = stopMic;
$('btnLoop').onclick = () => {
  if (!micStream) return;
  if (loop) { loop.stop(); loop = null; $('btnLoop').textContent = 'ループバック (イヤホン推奨)'; return; }
  loop = startLoopback(micStream);
  $('btnLoop').textContent = 'ループバック停止';
};

// ---- 3. スピーカー ----
$('btnTone').onclick = () => playTestTone().then(() => ($('toneRes').textContent = '再生しました (聞こえましたか?)')).catch((e) => ($('toneRes').textContent = `NG: ${e}`));

// ---- 4. LiveKit ----
for (const k of ['url', 'api', 'secret', 'room', 'identity', 'token']) {
  const el = $<HTMLInputElement>(k);
  el.value = saved(k);
  el.addEventListener('change', () => save(k, el.value));
}
if (!$<HTMLInputElement>('identity').value) $<HTMLInputElement>('identity').value = `dev-${Math.random().toString(36).slice(2, 6)}`;

$('btnMint').onclick = async () => {
  const api = $<HTMLInputElement>('api').value.replace(/\/$/, '');
  const res = await fetch(`${api}/api/public/calls/lab-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${$<HTMLInputElement>('secret').value}` },
    body: JSON.stringify({ room: $<HTMLInputElement>('room').value || 'lab-1', identity: $<HTMLInputElement>('identity').value }),
  });
  if (!res.ok) { $('err').textContent = `lab-token ${res.status}: ${await res.text()}`; return; }
  const j = await res.json();
  $<HTMLInputElement>('token').value = j.token; save('token', j.token);
  if (j.url) { $<HTMLInputElement>('url').value = j.url; save('url', j.url); }
  $('err').textContent = '';
};

const session = new AudioCallSession();
session.subscribe(render);
function render(s: CallSessionState) {
  $('phase').textContent = s.phase + (s.reconnecting ? ' (reconnecting)' : '') + (s.remoteIdentity ? ` ↔ ${s.remoteIdentity}` : '');
  $('err').textContent = s.error ?? '';
  $('stats').innerHTML = `<span class="badge">quality: ${s.stats.quality}</span> <span class="badge">rtt: ${s.stats.rtt ?? '-'}ms</span> <span class="badge">lost: ${s.stats.packetsLost ?? '-'}</span> <span class="badge">jitter: ${s.stats.jitter != null ? (s.stats.jitter * 1000).toFixed(0) + 'ms' : '-'}</span> <span class="badge">up: ${s.stats.bitrate != null ? Math.round(s.stats.bitrate / 1000) + 'kbps' : '-'}</span> <span class="badge ${s.localSpeaking ? 'ok' : ''}">me ${s.localSpeaking ? '🔊' : '·'}</span> <span class="badge ${s.remoteSpeaking ? 'ok' : ''}">peer ${s.remoteSpeaking ? '🔊' : '·'}</span>`;
  $('log').textContent = s.log.join('\n');
  $('log').scrollTop = $('log').scrollHeight;
  const live = s.phase === 'connecting' || s.phase === 'waiting' || s.phase === 'talking';
  $<HTMLButtonElement>('btnConnect').disabled = live;
  $<HTMLButtonElement>('btnMute').disabled = !live;
  $<HTMLButtonElement>('btnResume').disabled = !live;
  $<HTMLButtonElement>('btnHangup').disabled = !live;
  $('btnMute').textContent = s.muted ? 'ミュート解除' : 'ミュート';
}
$('btnConnect').onclick = () => {
  stopMic(); // 同一デバイスの二重取得を避ける
  void session.connect({
    url: $<HTMLInputElement>('url').value.trim(),
    token: $<HTMLInputElement>('token').value.trim(),
    micDeviceId: $<HTMLSelectElement>('mics').value || undefined,
    echoCancellation: $<HTMLInputElement>('ec').checked,
    noiseSuppression: $<HTMLInputElement>('ns').checked,
    autoGainControl: $<HTMLInputElement>('agc').checked,
  });
};
$('btnMute').onclick = () => void session.setMuted(!session.state.muted);
$('btnResume').onclick = () => void session.resumeAudio();
$('btnHangup').onclick = () => void session.disconnect();
// ---- AI と会話 ----
const captions: string[] = [];
function addCaption(who: string, text: string, final: boolean) {
  const line = `${who}: ${text}`;
  if (final) captions.push(line);
  $('captions').innerHTML = captions.slice(-8).map((l) => `<div>${l}</div>`).join('') + (final ? '' : `<div style="opacity:.6">${line}</div>`);
}
$('btnAi').onclick = async () => {
  stopMic();
  const name = ($<HTMLInputElement>('myname').value || 'guest').trim();
  const identity = `customer:${name.replace(/[^a-zA-Z0-9_.-]/g, '') || 'guest'}`;
  const roomId = Math.random().toString(36).slice(2, 6);
  const res = await fetch('/lab/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: roomId, identity, name }) });
  if (!res.ok) { $('err').textContent = `/lab/token ${res.status}`; return; }
  const j = await res.json();
  $<HTMLInputElement>('url').value = j.url; $<HTMLInputElement>('token').value = j.token;
  captions.length = 0; $('captions').textContent = '';
  await session.connect({
    url: j.url, token: j.token,
    micDeviceId: $<HTMLSelectElement>('mics').value || undefined,
    echoCancellation: $<HTMLInputElement>('ec').checked,
    noiseSuppression: $<HTMLInputElement>('ns').checked,
    autoGainControl: $<HTMLInputElement>('agc').checked,
  });
  // エージェントが流す字幕 (lk.transcription テキストストリーム) を表示
  const room = session.livekitRoom;
  room?.registerTextStreamHandler('lk.transcription', async (reader, participant) => {
    const who = participant?.identity?.startsWith('customer:') ? 'あなた' : 'AI';
    let text = '';
    for await (const chunk of reader) { text += chunk; addCaption(who, text, false); }
    addCaption(who, text, true);
  });
};

$('btnCopy').onclick = () => {
  const report = { env, perm: $('perm').textContent, track: $('track').textContent, state: { ...session.state, log: undefined }, log: session.state.log };
  void navigator.clipboard.writeText(JSON.stringify(report, null, 1)).then(() => alert('コピーしました'));
};
