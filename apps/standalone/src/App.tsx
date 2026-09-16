// TalkPlatform スタンドアローンプラットフォーム (アプリ層)。
// LINE を介さず、ブラウザだけで AI 音声相談を行う最小の Web アプリ。
// サービス層 (/api/service/sessions) は vite の dev プロキシ経由 (鍵はサーバー側)。
import { useMemo, useRef, useState } from 'react';
import { createTalkClient, type ActiveCall } from '@talkplatform/talk-client';
import { useElapsedSeconds, formatElapsed } from '@talkplatform/call-audio/react';
import type { CallSessionState } from '@talkplatform/call-audio';

interface Caption { who: 'user' | 'assistant'; text: string; final: boolean }

export default function App() {
  const talk = useMemo(() => createTalkClient({ apiBase: '' }), []);
  const [name, setName] = useState('');
  const [call, setCall] = useState<ActiveCall | null>(null);
  const [state, setState] = useState<CallSessionState | null>(null);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const unsub = useRef<() => void>(() => {});
  const elapsed = useElapsedSeconds(state?.talkingSince ?? null);

  async function start() {
    setBusy(true);
    setErr(null);
    setCaptions([]);
    try {
      const c = await talk.startCall({
        displayName: name || 'ゲスト',
        onCaption: (who, text, final) =>
          setCaptions((prev) => {
            const next = prev.filter((x) => x.final);
            if (final) return [...next, { who, text, final }].slice(-20);
            return [...next, { who, text, final }];
          }),
      });
      unsub.current = c.session.subscribe(setState);
      setCall(c);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function end() {
    unsub.current();
    await call?.end();
    setCall(null);
  }

  const phase = state?.phase ?? 'idle';
  const live = phase === 'connecting' || phase === 'waiting' || phase === 'talking';

  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: 20, lineHeight: 1.6 }}>
      <h1 style={{ fontSize: '1.3rem' }}>オンライン相談</h1>
      {!call ? (
        <div style={{ display: 'grid', gap: 12 }}>
          <p>AI アシスタントと音声でご相談いただけます。通話は品質向上のため録音されます。</p>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="お名前 (任意)"
            style={{ fontSize: '1rem', padding: 10, borderRadius: 8, border: '1px solid #8886' }}
          />
          <button
            onClick={start}
            disabled={busy}
            style={{ fontSize: '1.1rem', padding: '14px 0', borderRadius: 999, border: 0, background: '#16a34a', color: '#fff', fontWeight: 700 }}
          >
            {busy ? '接続中…' : '相談をはじめる'}
          </button>
          {err && <p style={{ color: '#dc2626' }}>{err}</p>}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ textAlign: 'center', fontSize: '2rem', fontVariantNumeric: 'tabular-nums' }}>
            {phase === 'talking' ? formatElapsed(elapsed) : phase === 'waiting' ? 'アシスタントを待っています…' : phase === 'connecting' ? '接続中…' : '通話終了'}
          </div>
          {state?.reconnecting && <p style={{ textAlign: 'center', color: '#b45309' }}>再接続中…</p>}
          {state?.error && <p style={{ color: '#dc2626' }}>{state.error}</p>}
          <div style={{ minHeight: 180, maxHeight: 300, overflowY: 'auto', background: '#8881', borderRadius: 10, padding: 12, fontSize: '.95rem' }}>
            {captions.map((c, i) => (
              <div key={i} style={{ opacity: c.final ? 1 : 0.6 }}>
                <b style={{ color: c.who === 'assistant' ? '#2563eb' : 'inherit' }}>{c.who === 'assistant' ? 'AI' : 'あなた'}:</b> {c.text}
              </div>
            ))}
          </div>
          {live && (
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => call.session.setMuted(!state?.muted)} style={{ flex: 1, padding: '12px 0', borderRadius: 999, border: '1px solid #8886', background: state?.muted ? '#eab308' : 'transparent', fontWeight: 700 }}>
                {state?.muted ? 'ミュート解除' : 'ミュート'}
              </button>
              <button onClick={end} style={{ flex: 1, padding: '12px 0', borderRadius: 999, border: 0, background: '#dc2626', color: '#fff', fontWeight: 700 }}>
                通話を終える
              </button>
            </div>
          )}
          {phase === 'ended' && <button onClick={() => setCall(null)} style={{ padding: '10px 0', borderRadius: 999, border: '1px solid #8886' }}>最初に戻る</button>}
          <button onClick={() => call.session.resumeAudio()} style={{ fontSize: '.8rem', color: '#888', background: 'none', border: 0, textDecoration: 'underline' }}>
            音が聞こえない場合はここをタップ
          </button>
        </div>
      )}
    </div>
  );
}
