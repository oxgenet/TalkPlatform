// TalkPlatform: 外部ブラウザ用の通話室。?t=<handoff token> を 1 回だけ参加トークンに交換する。
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { redeemCallHandoff, type JoinInfo } from '../lib/api.js';
import CallRoom from '../components/CallRoom.js';

export default function CallRoomPage() {
  const [params] = useSearchParams();
  const [join, setJoin] = useState<JoinInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const t = params.get('t');
    if (!t) { setErr('リンクが不正です。'); return; }
    redeemCallHandoff(t)
      .then(setJoin)
      .catch((e) => {
        const body = (e as { body?: { error?: string } }).body;
        setErr(
          body?.error === 'invalid_or_expired'
            ? 'リンクの有効期限が切れています。LINE に戻って「ブラウザを開いて通話する」をもう一度押してください。'
            : body?.error === 'not_open'
              ? 'まだ入室時間ではありません。'
              : '接続情報を取得できませんでした。',
        );
      });
  }, [params]);

  if (err) return <div className="max-w-md mx-auto p-6 text-red-600">{err}</div>;
  if (!join) return <div className="p-6 text-gray-500">準備中...</div>;
  const peer = join.state?.staff_name ?? '担当者';
  return <CallRoom url={join.url} token={join.token} peerLabel={peer} />;
}
