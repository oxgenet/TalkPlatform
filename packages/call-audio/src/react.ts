import { useEffect, useMemo, useState } from 'react';
import { AudioCallSession, type CallSessionState } from './session.js';

// セッションは Strict Mode の二重マウントでも 1 つに保つため useMemo で生成。
export function useAudioCallSession(): { session: AudioCallSession; state: CallSessionState } {
  const session = useMemo(() => new AudioCallSession(), []);
  const [state, setState] = useState<CallSessionState>(session.state);
  useEffect(() => {
    const off = session.subscribe(setState);
    return () => {
      off();
      void session.disconnect();
    };
  }, [session]);
  return { session, state };
}

export function useElapsedSeconds(since: number | null): number {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    if (!since) { setSec(0); return; }
    const t = setInterval(() => setSec(Math.floor((Date.now() - since) / 1000)), 1000);
    return () => clearInterval(t);
  }, [since]);
  return sec;
}

export function formatElapsed(sec: number): string {
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}
