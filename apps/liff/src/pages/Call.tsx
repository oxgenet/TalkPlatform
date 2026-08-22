// TalkPlatform: 予約に紐づく通話の入口 (LIFF 認証済み)。
// LINE 内ブラウザでは WebRTC が不安定なため、外部ブラウザへワンタイムトークンで引き継ぐ。
import liff from '@line/liff';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type CallState, type JoinInfo } from '../lib/api.js';
import CallRoom from '../components/CallRoom.js';

function jst(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function Call() {
  const { bookingId = '' } = useParams();
  const [state, setState] = useState<CallState | null>(null);
  const [join, setJoin] = useState<JoinInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    api.callState(bookingId).then(setState).catch((e) => setErr(String(e.message ?? e)));
  }, [bookingId]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  async function enter() {
    setBusy(true);
    setErr(null);
    try {
      if (liff.isInClient()) {
        const { handoff_token } = await api.callHandoff(bookingId);
        const target = new URL('/call-room', window.location.origin);
        target.searchParams.set('t', handoff_token);
        liff.openWindow({ url: target.toString(), external: true });
      } else {
        setJoin(await api.callToken(bookingId));
      }
    } catch (e) {
      const body = (e as { body?: { error?: string } }).body;
      setErr(body?.error === 'not_open' ? 'まだ入室時間ではありません。' : body?.error === 'livekit_not_configured' ? '通話機能が未設定です。' : String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  if (err && !state) return <div className="p-4 text-red-600">{err}</div>;
  if (!state) return <div className="p-4 text-gray-500">読み込み中...</div>;

  if (join) {
    return <CallRoom url={join.url} token={join.token} peerLabel={state.staff_name} onEnded={refresh} />;
  }

  const c = state.call;
  return (
    <div className="max-w-md mx-auto p-4 space-y-4">
      <h1 className="text-xl font-semibold">お電話のご予約</h1>
      <div className="rounded-lg border p-4 space-y-1 text-sm">
        <div>メニュー: {state.menu_name}</div>
        <div>担当: {state.staff_name}</div>
        <div>日時: {jst(state.starts_at)} 〜 {jst(state.ends_at).slice(-5)}</div>
      </div>

      {!c && <p className="text-gray-500">通話の準備ができていません。予約が確定するとこちらに入室ボタンが表示されます。</p>}
      {c && (c.status === 'scheduled' || c.status === 'in_progress') && (
        <>
          <p className="text-sm text-gray-600">
            入室可能時間: {jst(c.open_from)} 〜 {jst(c.close_at).slice(-5)}
          </p>
          <button
            disabled={!c.can_join || busy}
            onClick={enter}
            className="w-full py-4 rounded-full bg-green-600 text-white text-lg font-semibold disabled:bg-gray-300"
          >
            {c.can_join ? (liff.isInClient() ? 'ブラウザを開いて通話する' : '通話室に入る') : '開始10分前から入室できます'}
          </button>
          <p className="text-xs text-gray-500">
            通話は品質向上と内容確認のため録音されます。はじめに AI アシスタントが応対し、ご希望の場合はいつでも担当者におつなぎします（「担当者に代わって」とお伝えください）。
          </p>
          {liff.isInClient() && (
            <p className="text-xs text-gray-500">
              安定した通話のため、LINE の外のブラウザ（Safari / Chrome）で通話室を開きます。マイクの使用を許可してください。
            </p>
          )}
        </>
      )}
      {c && c.status === 'ended' && (
        <p className="text-gray-700">通話は終了しました（{Math.ceil((c.billable_seconds ?? 0) / 60)} 分）。ありがとうございました。</p>
      )}
      {c && c.status === 'no_show' && <p className="text-gray-700">通話時間を過ぎたため終了しました。再予約はお店へご連絡ください。</p>}
      {c && c.status === 'cancelled' && <p className="text-gray-700">この予約はキャンセルされています。</p>}
      {err && <div className="text-sm text-red-600">{err}</div>}
    </div>
  );
}
