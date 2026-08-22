// TalkPlatform: LiveKit 音声通話室 (顧客側)。制御ロジックは @talkplatform/call-audio。
import { useEffect } from 'react';
import { useAudioCallSession, useElapsedSeconds, formatElapsed } from '@talkplatform/call-audio/react';
import { detectEnvironment } from '@talkplatform/call-audio';

export interface CallRoomProps {
  url: string;
  token: string;
  peerLabel: string;
  onEnded?: () => void;
}

export default function CallRoom({ url, token, peerLabel, onEnded }: CallRoomProps) {
  const { session, state } = useAudioCallSession();
  const elapsed = useElapsedSeconds(state.talkingSince);
  const env = detectEnvironment();

  useEffect(() => {
    if (state.phase === 'ended') onEnded?.();
  }, [state.phase, onEnded]);

  const live = state.phase === 'connecting' || state.phase === 'waiting' || state.phase === 'talking';
  const headline =
    state.phase === 'talking' ? formatElapsed(elapsed)
      : state.phase === 'waiting' ? '相手を待っています…'
        : state.phase === 'connecting' ? '接続中…'
          : state.phase === 'ended' ? '通話終了' : '';

  return (
    <div className="max-w-md mx-auto p-6 text-center space-y-6">
      <div className="text-sm text-gray-500">通話相手</div>
      <div className="text-2xl font-semibold">{peerLabel}</div>
      <div className="text-4xl font-mono tabular-nums">{headline}</div>
      {state.reconnecting && <div className="text-sm text-yellow-600">再接続中…</div>}
      {state.error && <div className="text-sm text-red-600">{state.error}</div>}
      {env.inLineApp && state.phase === 'idle' && (
        <div className="text-xs text-yellow-700">LINE 内ブラウザでは音声が不安定な場合があります。</div>
      )}

      {state.phase === 'idle' || state.phase === 'error' ? (
        <button
          onClick={() => void session.connect({ url, token })}
          className="w-full py-4 rounded-full bg-green-600 text-white text-lg font-semibold active:opacity-80"
        >
          通話を開始する
        </button>
      ) : state.phase === 'ended' ? (
        <p className="text-gray-500">ご利用ありがとうございました。この画面は閉じて構いません。</p>
      ) : (
        <div className="flex gap-4 justify-center">
          <button
            onClick={() => void session.setMuted(!state.muted)}
            className={`flex-1 py-4 rounded-full text-lg font-semibold ${state.muted ? 'bg-yellow-500 text-white' : 'bg-gray-200'}`}
          >
            {state.muted ? 'ミュート解除' : 'ミュート'}
          </button>
          <button onClick={() => void session.disconnect()} className="flex-1 py-4 rounded-full bg-red-600 text-white text-lg font-semibold">
            通話を終える
          </button>
        </div>
      )}

      {live && (
        <button onClick={() => void session.resumeAudio()} className="text-xs text-gray-400 underline">
          音が聞こえない場合はここをタップ
        </button>
      )}
      {state.phase === 'talking' && (
        <div className="text-xs text-gray-400">
          回線: {state.stats.quality}{state.stats.rtt != null && ` / ${state.stats.rtt}ms`}
        </div>
      )}
    </div>
  );
}
