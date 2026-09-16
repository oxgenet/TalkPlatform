'use client'

// TalkPlatform: スタッフ側の通話室。AI ⇄ 人間の切替、文字起こし、要約。
// 制御ロジックは @talkplatform/call-audio。

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/layout/header'
import { callApi, type CallMode, type CallState, type TranscriptItem } from '@/lib/api'
import { useAudioCallSession, useElapsedSeconds, formatElapsed } from '@talkplatform/call-audio/react'

function jst(iso: string) {
  return new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function hhmm(iso: string) {
  return new Date(iso).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const MODE_LABEL: Record<CallMode, string> = { ai: 'AI 応対中', human_requested: '引き継ぎ要請あり', human: 'オペレーター応対中' }
const MODE_COLOR: Record<CallMode, string> = {
  ai: 'bg-blue-100 text-blue-800',
  human_requested: 'bg-amber-100 text-amber-900 animate-pulse',
  human: 'bg-emerald-100 text-emerald-800',
}
const ROLE_LABEL: Record<TranscriptItem['role'], string> = { customer: 'お客様', assistant: 'AI', operator: '担当', system: '—' }

export default function StaffCallPage() {
  const { bookingId } = useParams<{ bookingId: string }>()
  const [state, setState] = useState<CallState | null>(null)
  const [items, setItems] = useState<TranscriptItem[]>([])
  const [summary, setSummary] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { session, state: call } = useAudioCallSession()
  const elapsed = useElapsedSeconds(call.talkingSince)
  const logRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    try {
      const [st, tr] = await Promise.all([callApi.state(bookingId), callApi.transcript(bookingId)])
      setState(st)
      setItems(tr.items)
      setSummary(tr.summary)
    } catch (e) {
      setErr(String((e as Error)?.message ?? e))
    }
  }, [bookingId])

  useEffect(() => {
    void refresh()
    const live = call.phase === 'waiting' || call.phase === 'talking' || call.phase === 'connecting'
    const t = setInterval(refresh, live ? 3_000 : 15_000)
    return () => clearInterval(t)
  }, [refresh, call.phase])

  useEffect(() => { if (call.phase === 'ended') void refresh() }, [call.phase, refresh])
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }) }, [items.length])

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

  async function setMode(mode: CallMode) {
    setBusy(true)
    try {
      await callApi.setMode(bookingId, mode)
      await refresh()
    } catch (e) {
      setErr(String((e as Error)?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  // 「引き継ぐ」= 入室していなければ入室してから human へ
  async function takeOver() {
    const live = call.phase === 'waiting' || call.phase === 'talking'
    if (!live) await join()
    await setMode('human')
  }

  const c = state?.call
  const mode = c?.mode ?? 'ai'
  const live = call.phase === 'connecting' || call.phase === 'waiting' || call.phase === 'talking'
  const headline =
    call.phase === 'talking' ? formatElapsed(elapsed)
      : call.phase === 'waiting' ? '接続済み（待機中）'
        : call.phase === 'connecting' ? '接続中…'
          : call.phase === 'ended' ? '退室しました' : ''

  return (
    <div>
      <Header title="通話室" description="AI アシスタントとオペレーターの切替・文字起こし" />
      <div className="mx-auto max-w-5xl space-y-4 p-4">
        <Link href="/booking/bookings" className="text-sm text-gray-500 hover:underline">← 予約一覧</Link>
        {(err || call.error) && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{err ?? call.error}</div>}
        {!state ? (
          <p className="text-sm text-gray-500">読み込み中...</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-5">
            {/* 左: 通話操作 */}
            <div className="space-y-4 lg:col-span-2">
              <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm space-y-4">
                <div className="flex items-center justify-between">
                  <span className={`rounded-full px-3 py-1 text-xs font-bold ${MODE_COLOR[mode]}`}>{MODE_LABEL[mode]}</span>
                  {c?.recording && <span className="text-xs text-red-600">● 録音中</span>}
                </div>
                {mode === 'human_requested' && c?.handoff_reason && (
                  <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                    引き継ぎ理由: {c.handoff_reason}
                  </div>
                )}
                <div className="text-sm text-gray-700 space-y-1">
                  <div>お客様: <span className="font-semibold">{state.customer_name ?? '（名前なし）'}</span></div>
                  <div>メニュー: {state.menu_name}</div>
                  <div>日時: {jst(state.starts_at)} 〜 {jst(state.ends_at).slice(-5)}</div>
                  {c && <div>通話状態: <span className="font-mono">{c.status}</span>{c.billable_seconds != null && `（${Math.ceil(c.billable_seconds / 60)} 分）`}</div>}
                  {c?.agent_joined_at && <div className="text-xs text-gray-500">AI 入室: {hhmm(c.agent_joined_at)}</div>}
                </div>
                <div className="text-center text-3xl font-mono tabular-nums">{headline}</div>
                {call.reconnecting && <div className="text-center text-sm text-yellow-600">再接続中…</div>}

                {/* 切替 */}
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={busy || !c || mode === 'human'}
                    onClick={takeOver}
                    className="rounded-full bg-emerald-600 py-3 text-sm font-bold text-white disabled:bg-gray-300"
                  >
                    {live ? '引き継ぐ（人間へ）' : '入室して引き継ぐ'}
                  </button>
                  <button
                    type="button"
                    disabled={busy || !c || mode === 'ai'}
                    onClick={() => setMode('ai')}
                    className="rounded-full bg-blue-600 py-3 text-sm font-bold text-white disabled:bg-gray-300"
                  >
                    AI に戻す
                  </button>
                </div>

                {(call.phase === 'idle' || call.phase === 'error') && (
                  <button
                    type="button"
                    disabled={!c?.can_join}
                    onClick={join}
                    className="w-full rounded-full border border-gray-300 py-2 text-sm font-medium disabled:text-gray-400"
                  >
                    {c?.can_join ? '聞き役として入室（AI 応対のまま）' : c ? `入室可能: ${jst(c.open_from)} 〜` : '通話セッションなし'}
                  </button>
                )}
                {live && (
                  <div className="flex gap-3">
                    <button type="button" onClick={() => void session.setMuted(!call.muted)} className={`flex-1 rounded-full py-2 text-sm font-bold ${call.muted ? 'bg-yellow-500 text-white' : 'bg-gray-200'}`}>
                      {call.muted ? 'ミュート解除' : 'ミュート'}
                    </button>
                    <button type="button" onClick={() => void session.disconnect()} className="flex-1 rounded-full bg-red-600 py-2 text-sm font-bold text-white">
                      退室
                    </button>
                  </div>
                )}
                {call.phase === 'talking' && (
                  <div className="text-center text-xs text-gray-400">
                    回線: {call.stats.quality}{call.stats.rtt != null && ` / RTT ${call.stats.rtt}ms`}
                  </div>
                )}
              </div>

              {summary && (
                <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                  <h3 className="mb-2 text-sm font-bold text-gray-700">AI 要約</h3>
                  <p className="whitespace-pre-wrap text-sm text-gray-800">{summary}</p>
                </div>
              )}
            </div>

            {/* 右: 文字起こし */}
            <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm lg:col-span-3">
              <h3 className="mb-2 text-sm font-bold text-gray-700">文字起こし（リアルタイム）</h3>
              <div ref={logRef} className="h-[32rem] space-y-2 overflow-y-auto pr-1">
                {items.length === 0 && <p className="text-sm text-gray-400">まだ発話がありません。</p>}
                {items.map((it) => (
                  <div key={`${it.seq}-${it.at}`} className={`text-sm ${it.role === 'system' ? 'text-center text-xs text-gray-400' : ''}`}>
                    {it.role !== 'system' && (
                      <span className={`mr-2 inline-block w-14 shrink-0 text-xs font-bold ${it.role === 'customer' ? 'text-gray-900' : it.role === 'assistant' ? 'text-blue-700' : 'text-emerald-700'}`}>
                        {ROLE_LABEL[it.role]}
                      </span>
                    )}
                    <span className={it.role === 'system' ? '' : 'text-gray-800'}>{it.text}</span>
                    <span className="ml-2 text-[10px] text-gray-400">{hhmm(it.at)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
