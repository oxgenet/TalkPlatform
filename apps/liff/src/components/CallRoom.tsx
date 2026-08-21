// TalkPlatform: LiveKit 音声通話室 (顧客・スタッフ共通)。
// 音声のみ。リモート音声トラックは <audio> に attach、自分のマイクは publish。
import { useEffect, useRef, useState } from 'react';
import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from 'livekit-client';

export interface CallRoomProps {
  url: string;
  token: string;
  peerLabel: string;   // 相手の表示名
  onEnded?: () => void;
}

type Phase = 'idle' | 'connecting' | 'waiting' | 'talking' | 'ended' | 'error';

function fmt(sec: number): string {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export default function CallRoom({ url, token, peerLabel, onEnded }: CallRoomProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const roomRef = useRef<Room | null>(null);
  const audioHost = useRef<HTMLDivElement>(null);
  const talkingSince = useRef<number | null>(null);

  useEffect(() => {
    if (phase !== 'talking') return;
    const t = setInterval(() => {
      if (talkingSince.current) setElapsed(Math.floor((Date.now() - talkingSince.current) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [phase]);

  useEffect(() => () => { roomRef.current?.disconnect(); }, []);

  // iOS Safari / LINE 内ブラウザは「ユーザー操作の中で」getUserMedia と AudioContext を
  // 開始する必要があるため、接続はボタン押下ハンドラから行う。
  async function join() {
    setPhase('connecting');
    setError(null);
    const room = new Room({ adaptiveStream: false, dynacast: false });
    roomRef.current = room;

    const attach = (track: RemoteTrack) => {
      if (track.kind !== Track.Kind.Audio) return;
      const el = track.attach();
      el.setAttribute('playsinline', 'true');
      audioHost.current?.appendChild(el);
    };
    room
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub: RemoteTrackPublication, _p: RemoteParticipant) => {
        attach(track);
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => { track.detach().forEach((el) => el.remove()); })
      .on(RoomEvent.ParticipantConnected, () => {
        talkingSince.current ??= Date.now();
        setPhase('talking');
      })
      .on(RoomEvent.ParticipantDisconnected, () => {
        if (room.remoteParticipants.size === 0) setPhase('waiting');
      })
      .on(RoomEvent.Disconnected, () => {
        setPhase('ended');
        onEnded?.();
      })
      .on(RoomEvent.ConnectionStateChanged, (st: ConnectionState) => {
        if (st === ConnectionState.Reconnecting) setError('再接続中…');
        if (st === ConnectionState.Connected) setError(null);
      });

    try {
      await room.connect(url, token, { autoSubscribe: true });
      await room.startAudio().catch(() => { /* 自動再生ブロック時は後述のボタンで再開 */ });
      await room.localParticipant.setMicrophoneEnabled(true, {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      if (room.remoteParticipants.size > 0) {
        talkingSince.current ??= Date.now();
        setPhase('talking');
      } else {
        setPhase('waiting');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
      await room.disconnect();
    }
  }

  async function toggleMute() {
    const r = roomRef.current;
    if (!r) return;
    const next = !muted;
    await r.localParticipant.setMicrophoneEnabled(!next);
    setMuted(next);
  }

  async function hangup() {
    await roomRef.current?.disconnect();
    setPhase('ended');
    onEnded?.();
  }

  return (
    <div className="max-w-md mx-auto p-6 text-center space-y-6">
      <div ref={audioHost} className="hidden" />
      <div className="text-sm text-gray-500">通話相手</div>
      <div className="text-2xl font-semibold">{peerLabel}</div>

      <div className="text-4xl font-mono tabular-nums">
        {phase === 'talking' ? fmt(elapsed) : phase === 'waiting' ? '相手を待っています…' : phase === 'connecting' ? '接続中…' : phase === 'ended' ? '通話終了' : ''}
      </div>

      {error && <div className="text-sm text-red-600">{error}</div>}

      {phase === 'idle' || phase === 'error' ? (
        <button
          onClick={join}
          className="w-full py-4 rounded-full bg-green-600 text-white text-lg font-semibold active:opacity-80"
        >
          通話を開始する
        </button>
      ) : phase === 'ended' ? (
        <p className="text-gray-500">ご利用ありがとうございました。この画面は閉じて構いません。</p>
      ) : (
        <div className="flex gap-4 justify-center">
          <button
            onClick={toggleMute}
            className={`flex-1 py-4 rounded-full text-lg font-semibold ${muted ? 'bg-yellow-500 text-white' : 'bg-gray-200'}`}
          >
            {muted ? 'ミュート解除' : 'ミュート'}
          </button>
          <button onClick={hangup} className="flex-1 py-4 rounded-full bg-red-600 text-white text-lg font-semibold">
            通話を終える
          </button>
        </div>
      )}

      {(phase === 'waiting' || phase === 'talking') && (
        <button
          onClick={() => roomRef.current?.startAudio()}
          className="text-xs text-gray-400 underline"
        >
          音が聞こえない場合はここをタップ
        </button>
      )}
    </div>
  );
}
