'use client'

// TalkPlatform: スタッフ側の通話室。制御ロジックは @talkplatform/call-audio。

import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/layout/header'
import { callApi, type CallState } from '@/lib/api'
import { useAudioCallSession, useElapsedSeconds, formatElapsed } from '@talkplatform/call-audio/react'

function jst(iso: string) {
  return new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export default function StaffCallPage() {
  const { bookingId } = useParams<{ bookingId: string }>()
  const [state, setState] = useState<CallState | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const { session, state: call } = useAudioCallSession()
  const elapsed = useElapsedSeconds(call.talkingSince)

  const refresh = useCallback(() => {
    callApi.state(bookingId).then(setState).catch((e) => setErr(String(e?.message ?? e)))
  }, [bookingId])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 30_000)
    return () => clearInterval(t)
  }, [refresh])

  useEffect(() => { if (call.phase === 'ended') refresh() }, [call.phase, refresh])

  async function join() {
    setErr(null)
    try {
      const { token, url } = await callApi.token(bookingId)
      await session.connect({ url, token })
    } catch (e) {
      const body = (e as { body?: { error?: string } }).body
      setErr(body?.error === 'not_open' ? 'まだ入室時間ではありません（開始10分前〜終了15分後）。' : String((e as Error)?.message ?? e))
    }
  }

  const c = state?.call
  const live = call.phase === 'connecting' || call.phase === 'waiting' || call.phase === 'talking'
  const headline =
    call.phase === 'talking' ? formatElapsed(elapsed)
      : call.phase === 'waiting' ? 'お客様を待っています…'
        : call.phase === 'connecting' ? '接続中…'
          : call.phase === 'ended' ? '通話終了' : ''

  return (
    <div>
      <Header title="通話室" description="お客様との音声通話（LiveKit）" />
      <div className="mx-auto max-w-lg space-y-4 p-4">
        <Link href="/booking/bookings" className="text-sm text-gray-500 hover:underline">← 予約一覧</Link>
        {(err || call.error) && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{err ?? call.error}</div>}
        {!state ? (
          <p className="text-sm text-gray-500">読み込み中...</p>
        ) : (
          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm space-y-4">
            <div className="text-sm text-gray-700 space-y-1">
              <div>お客様: <span className="font-semibold">{state.customer_name ?? '（名前なし）'}</span></div>
              <div>メニュー: {state.menu_name}</div>
              <div>担当: {state.staff_name}</div>
              <div>日時: {jst(state.starts_at)} 〜 {jst(state.ends_at).slice(-5)}</div>
              {c && <div>通話状態: <span className="font-mono">{c.status}</span>{c.billable_seconds != null && `（${Math.ceil(c.billable_seconds / 60)} 分）`}</div>}
            </div>
            <div className="text-center text-3xl font-mono tabular-nums">{headline}</div>
            {call.reconnecting && <div className="text-center text-sm text-yellow-600">再接続中…</div>}
            {(call.phase === 'idle' || call.phase === 'error') && (
              <button
                type="button"
                disabled={!c?.can_join}
                onClick={join}
                className="w-full rounded-full bg-emerald-600 py-3 text-lg font-bold text-white disabled:bg-gray-300"
              >
                {c?.can_join ? '通話室に入る' : c ? `入室可能: ${jst(c.open_from)} 〜` : '通話セッションなし'}
              </button>
            )}
            {live && (
              <div className="flex gap-3">
                <button type="button" onClick={() => void session.setMuted(!call.muted)} className={`flex-1 rounded-full py-3 font-bold ${call.muted ? 'bg-yellow-500 text-white' : 'bg-gray-200'}`}>
                  {call.muted ? 'ミュート解除' : 'ミュート'}
                </button>
                <button type="button" onClick={() => void session.disconnect()} className="flex-1 rounded-full bg-red-600 py-3 font-bold text-white">
                  通話を終える
                </button>
              </div>
            )}
            {call.phase === 'talking' && (
              <div className="text-center text-xs text-gray-400">
                回線: {call.stats.quality}{call.stats.rtt != null && ` / RTT ${call.stats.rtt}ms`}{call.stats.packetsLost != null && ` / lost ${call.stats.packetsLost}`}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
