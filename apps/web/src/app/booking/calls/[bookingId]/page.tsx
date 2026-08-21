'use client'

// TalkPlatform: スタッフ側の通話室。予約の open_from〜close_at の間だけ入室できる。

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/layout/header'
import { callApi, type CallState } from '@/lib/api'
import { ConnectionState, Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client'

function jst(iso: string) {
  return new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function fmt(sec: number) {
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`
}

type Phase = 'idle' | 'connecting' | 'waiting' | 'talking' | 'ended'

export default function StaffCallPage() {
  const { bookingId } = useParams<{ bookingId: string }>()
  const [state, setState] = useState<CallState | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [err, setErr] = useState<string | null>(null)
  const [muted, setMuted] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const roomRef = useRef<Room | null>(null)
  const audioHost = useRef<HTMLDivElement>(null)
  const since = useRef<number | null>(null)

  const refresh = useCallback(() => {
    callApi.state(bookingId).then(setState).catch((e) => setErr(String(e?.message ?? e)))
  }, [bookingId])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 30_000)
    return () => clearInterval(t)
  }, [refresh])

  useEffect(() => {
    if (phase !== 'talking') return
    const t = setInterval(() => since.current && setElapsed(Math.floor((Date.now() - since.current) / 1000)), 1000)
    return () => clearInterval(t)
  }, [phase])

  useEffect(() => () => { roomRef.current?.disconnect() }, [])

  async function join() {
    setErr(null)
    setPhase('connecting')
    try {
      const { token, url } = await callApi.token(bookingId)
      const room = new Room()
      roomRef.current = room
      room
        .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
          if (track.kind === Track.Kind.Audio) audioHost.current?.appendChild(track.attach())
        })
        .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => track.detach().forEach((el) => el.remove()))
        .on(RoomEvent.ParticipantConnected, () => { since.current ??= Date.now(); setPhase('talking') })
        .on(RoomEvent.ParticipantDisconnected, () => { if (room.remoteParticipants.size === 0) setPhase('waiting') })
        .on(RoomEvent.Disconnected, () => { setPhase('ended'); refresh() })
        .on(RoomEvent.ConnectionStateChanged, (st: ConnectionState) => setErr(st === ConnectionState.Reconnecting ? '再接続中…' : null))
      await room.connect(url, token)
      await room.startAudio().catch(() => {})
      await room.localParticipant.setMicrophoneEnabled(true, { echoCancellation: true, noiseSuppression: true })
      if (room.remoteParticipants.size > 0) { since.current ??= Date.now(); setPhase('talking') } else setPhase('waiting')
    } catch (e) {
      const body = (e as { body?: { error?: string } }).body
      setErr(body?.error === 'not_open' ? 'まだ入室時間ではありません（開始10分前〜終了15分後）。' : String((e as Error)?.message ?? e))
      setPhase('idle')
    }
  }

  async function toggleMute() {
    const next = !muted
    await roomRef.current?.localParticipant.setMicrophoneEnabled(!next)
    setMuted(next)
  }
  async function hangup() {
    await roomRef.current?.disconnect()
    setPhase('ended')
  }

  const c = state?.call

  return (
    <div>
      <Header title="通話室" description="お客様との音声通話（LiveKit）" />
      <div className="mx-auto max-w-lg space-y-4 p-4">
        <Link href="/booking/bookings" className="text-sm text-gray-500 hover:underline">← 予約一覧</Link>
        {err && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{err}</div>}
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
            <div ref={audioHost} className="hidden" />
            <div className="text-center text-3xl font-mono tabular-nums">
              {phase === 'talking' ? fmt(elapsed) : phase === 'waiting' ? 'お客様を待っています…' : phase === 'connecting' ? '接続中…' : phase === 'ended' ? '通話終了' : ''}
            </div>
            {phase === 'idle' && (
              <button
                type="button"
                disabled={!c?.can_join}
                onClick={join}
                className="w-full rounded-full bg-emerald-600 py-3 text-lg font-bold text-white disabled:bg-gray-300"
              >
                {c?.can_join ? '通話室に入る' : c ? `入室可能: ${jst(c.open_from)} 〜` : '通話セッションなし'}
              </button>
            )}
            {(phase === 'waiting' || phase === 'talking' || phase === 'connecting') && (
              <div className="flex gap-3">
                <button type="button" onClick={toggleMute} className={`flex-1 rounded-full py-3 font-bold ${muted ? 'bg-yellow-500 text-white' : 'bg-gray-200'}`}>
                  {muted ? 'ミュート解除' : 'ミュート'}
                </button>
                <button type="button" onClick={hangup} className="flex-1 rounded-full bg-red-600 py-3 font-bold text-white">
                  通話を終える
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
