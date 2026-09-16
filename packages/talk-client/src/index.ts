// TalkPlatform アプリ層 SDK。
// 任意の Web アプリから 2 行で AI 音声通話を開始できるようにする薄いクライアント:
//
//   const talk = createTalkClient({ apiBase: 'https://worker.example', apiKey: 'sk_...' });
//   const call = await talk.startCall({ displayName: '山田' });   // 接続してマイク開始
//   call.session.subscribe((s) => render(s));                      // phase / stats / 字幕
//   await call.end();
//
// 注意: apiKey は組織のサーバー秘密。ブラウザ直埋めは自組織の閉じた環境のみとし、
// 公開 Web では自サーバー経由で /sessions を叩いてから joinCall() を使うこと。

import { AudioCallSession, type ConnectOptions } from '@talkplatform/call-audio';

export interface TalkClientOptions {
  apiBase: string;          // Worker のベース URL
  apiKey?: string;          // SERVICE_API_KEYS の鍵 (サーバーサイド推奨)
  fetchImpl?: typeof fetch; // テスト用
}

export interface SessionInfo {
  session_id: string;
  room: string;
  token: string;
  url: string;
  expires_at: string;
}

export interface StartCallOptions {
  displayName?: string;
  scenarioId?: string;
  audio?: Pick<ConnectOptions, 'micDeviceId' | 'echoCancellation' | 'noiseSuppression' | 'autoGainControl'>;
  onCaption?: (who: 'user' | 'assistant', text: string, final: boolean) => void;
}

export interface ActiveCall {
  info: SessionInfo;
  session: AudioCallSession;
  end: () => Promise<void>;
}

export function createTalkClient(opts: TalkClientOptions) {
  const f = opts.fetchImpl ?? fetch;
  const base = opts.apiBase.replace(/\/$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

  async function createSession(o: { displayName?: string; scenarioId?: string } = {}): Promise<SessionInfo> {
    const res = await f(`${base}/api/service/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ display_name: o.displayName, scenario_id: o.scenarioId }),
    });
    if (!res.ok) throw new Error(`TalkPlatform session create failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async function joinCall(info: SessionInfo, o: StartCallOptions = {}): Promise<ActiveCall> {
    const session = new AudioCallSession();
    await session.connect({ url: info.url, token: info.token, ...o.audio });
    if (o.onCaption) attachCaptions(session, o.onCaption);
    return {
      info,
      session,
      end: async () => {
        await session.disconnect();
        await f(`${base}/api/service/sessions/${info.session_id}/end`, { method: 'POST', headers }).catch(() => {});
      },
    };
  }

  async function startCall(o: StartCallOptions = {}): Promise<ActiveCall> {
    const info = await createSession({ displayName: o.displayName, scenarioId: o.scenarioId });
    return joinCall(info, o);
  }

  return { createSession, joinCall, startCall };
}

// エージェントが流す字幕 (lk.transcription) を購読する
export function attachCaptions(
  session: AudioCallSession,
  onCaption: (who: 'user' | 'assistant', text: string, final: boolean) => void,
): void {
  const room = session.livekitRoom;
  room?.registerTextStreamHandler('lk.transcription', async (reader, participant) => {
    const who = participant?.identity?.startsWith('customer:') ? 'user' : 'assistant';
    let text = '';
    for await (const chunk of reader) {
      text += chunk;
      onCaption(who, text, false);
    }
    onCaption(who, text, true);
  });
}
