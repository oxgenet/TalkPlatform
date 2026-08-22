// AudioCallSession: LiveKit Room を「音声通話」に特化して薄く包むステートマシン。
// UI (React / Vanilla) から独立させ、Audio Lab と本番 UI が同じ実装を共有する。
//
//   idle ─connect()─▶ connecting ─▶ waiting ─(相手入室)─▶ talking
//                                      ▲                    │
//                                      └────(相手退室)───────┘
//   いずれも ─disconnect()/切断─▶ ended、失敗 ─▶ error

import {
  ConnectionState,
  ConnectionQuality,
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteParticipant,
  type LocalTrackPublication,
} from 'livekit-client';

export type CallPhase = 'idle' | 'connecting' | 'waiting' | 'talking' | 'ended' | 'error';

export interface CallStats {
  quality: 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';
  rtt?: number;             // ms
  packetsLost?: number;
  jitter?: number;          // s
  bitrate?: number;         // bps (送信)
}

export interface CallSessionState {
  phase: CallPhase;
  error: string | null;
  muted: boolean;
  talkingSince: number | null;
  remoteIdentity: string | null;
  remoteSpeaking: boolean;
  localSpeaking: boolean;
  reconnecting: boolean;
  stats: CallStats;
  log: string[];
}

export interface ConnectOptions {
  url: string;
  token: string;
  micDeviceId?: string;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  autoSubscribe?: boolean;
}

type Listener = (s: CallSessionState) => void;

export class AudioCallSession {
  private room: Room | null = null;
  private audioHost: HTMLElement;
  private listeners = new Set<Listener>();
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  state: CallSessionState = {
    phase: 'idle', error: null, muted: false, talkingSince: null, remoteIdentity: null,
    remoteSpeaking: false, localSpeaking: false, reconnecting: false, stats: { quality: 'unknown' }, log: [],
  };

  constructor(audioHost?: HTMLElement) {
    this.audioHost = audioHost ?? this.createHiddenHost();
  }

  private createHiddenHost(): HTMLElement {
    const el = document.createElement('div');
    el.style.display = 'none';
    el.dataset.role = 'call-audio-host';
    document.body.appendChild(el);
    return el;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<CallSessionState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  private log(msg: string) {
    const line = `${new Date().toISOString().slice(11, 23)} ${msg}`;
    this.set({ log: [...this.state.log.slice(-199), line] });
  }

  get livekitRoom(): Room | null { return this.room; }

  // iOS/Safari: ユーザー操作のハンドラ内から呼ぶこと。
  async connect(opts: ConnectOptions): Promise<void> {
    if (this.room) await this.disconnect();
    this.set({ phase: 'connecting', error: null, talkingSince: null, remoteIdentity: null });
    const room = new Room({ adaptiveStream: false, dynacast: false });
    this.room = room;

    room
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, p: RemoteParticipant) => {
        if (track.kind !== Track.Kind.Audio) return;
        const el = track.attach();
        el.setAttribute('playsinline', 'true');
        this.audioHost.appendChild(el);
        this.log(`subscribed audio from ${p.identity}`);
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        track.detach().forEach((el) => el.remove());
      })
      .on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
        this.log(`participant connected: ${p.identity}`);
        this.set({ phase: 'talking', remoteIdentity: p.identity, talkingSince: this.state.talkingSince ?? Date.now() });
      })
      .on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
        this.log(`participant disconnected: ${p.identity}`);
        if (room.remoteParticipants.size === 0) this.set({ phase: 'waiting', remoteIdentity: null, remoteSpeaking: false });
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        const ids = new Set(speakers.map((s) => s.identity));
        this.set({
          localSpeaking: ids.has(room.localParticipant.identity),
          remoteSpeaking: [...room.remoteParticipants.keys()].some((id) => ids.has(id)),
        });
      })
      .on(RoomEvent.ConnectionStateChanged, (st: ConnectionState) => {
        this.log(`connection: ${st}`);
        this.set({ reconnecting: st === ConnectionState.Reconnecting });
      })
      .on(RoomEvent.ConnectionQualityChanged, (q: ConnectionQuality, p) => {
        if (p.identity !== room.localParticipant.identity) return;
        const map: Record<ConnectionQuality, CallStats['quality']> = {
          [ConnectionQuality.Excellent]: 'excellent',
          [ConnectionQuality.Good]: 'good',
          [ConnectionQuality.Poor]: 'poor',
          [ConnectionQuality.Lost]: 'lost',
          [ConnectionQuality.Unknown]: 'unknown',
        };
        this.set({ stats: { ...this.state.stats, quality: map[q] } });
      })
      .on(RoomEvent.MediaDevicesError, (e: Error) => {
        this.log(`media devices error: ${e.name}: ${e.message}`);
        this.set({ error: humanizeMediaError(e) });
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        this.log(`audio playback allowed: ${room.canPlaybackAudio}`);
        if (!room.canPlaybackAudio) this.set({ error: '音声の自動再生がブロックされています。画面をタップしてください。' });
      })
      .on(RoomEvent.Disconnected, (reason) => {
        this.log(`disconnected: ${String(reason)}`);
        this.stopStats();
        this.set({ phase: 'ended', reconnecting: false });
      });

    try {
      this.log(`connecting to ${opts.url}`);
      await room.connect(opts.url, opts.token, { autoSubscribe: opts.autoSubscribe ?? true });
      this.log(`connected as ${room.localParticipant.identity} (room ${room.name})`);
      await room.startAudio().catch((e) => this.log(`startAudio rejected: ${String(e)}`));
      await room.localParticipant.setMicrophoneEnabled(true, {
        deviceId: opts.micDeviceId,
        echoCancellation: opts.echoCancellation ?? true,
        noiseSuppression: opts.noiseSuppression ?? true,
        autoGainControl: opts.autoGainControl ?? true,
      });
      const pub = [...room.localParticipant.audioTrackPublications.values()][0] as LocalTrackPublication | undefined;
      this.log(`mic published: ${pub?.track?.mediaStreamTrack.label ?? '(none)'}`);
      const hasPeer = room.remoteParticipants.size > 0;
      const peer = hasPeer ? [...room.remoteParticipants.values()][0] : null;
      this.set({
        phase: hasPeer ? 'talking' : 'waiting',
        remoteIdentity: peer?.identity ?? null,
        talkingSince: hasPeer ? Date.now() : null,
      });
      this.startStats();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.log(`connect failed: ${err.name}: ${err.message}`);
      this.set({ phase: 'error', error: humanizeMediaError(err) });
      await room.disconnect();
      this.room = null;
    }
  }

  async setMuted(muted: boolean): Promise<void> {
    await this.room?.localParticipant.setMicrophoneEnabled(!muted);
    this.set({ muted });
    this.log(muted ? 'muted' : 'unmuted');
  }

  async switchMicrophone(deviceId: string): Promise<void> {
    await this.room?.switchActiveDevice('audioinput', deviceId);
    this.log(`switched mic → ${deviceId}`);
  }

  // 自動再生ブロック解除用 (ユーザー操作内で呼ぶ)
  async resumeAudio(): Promise<void> {
    await this.room?.startAudio();
  }

  async disconnect(): Promise<void> {
    this.stopStats();
    const r = this.room;
    this.room = null;
    if (r) await r.disconnect();
    if (this.state.phase !== 'ended') this.set({ phase: 'ended' });
  }

  private startStats() {
    this.stopStats();
    this.statsTimer = setInterval(() => void this.collectStats(), 2000);
  }
  private stopStats() {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
  }
  private async collectStats() {
    const room = this.room;
    if (!room) return;
    const pub = [...room.localParticipant.audioTrackPublications.values()][0] as LocalTrackPublication | undefined;
    const track = pub?.track;
    if (!track) return;
    try {
      const reports = await track.getRTCStatsReport();
      if (!reports) return;
      const next: CallStats = { ...this.state.stats };
      reports.forEach((r) => {
        if (r.type === 'outbound-rtp' && r.kind === 'audio') {
          if (typeof r.bytesSent === 'number' && typeof r.timestamp === 'number') {
            const prev = this.lastOut;
            if (prev) next.bitrate = Math.round(((r.bytesSent - prev.bytes) * 8) / ((r.timestamp - prev.ts) / 1000));
            this.lastOut = { bytes: r.bytesSent, ts: r.timestamp };
          }
        }
        if (r.type === 'remote-inbound-rtp' && r.kind === 'audio') {
          if (typeof r.roundTripTime === 'number') next.rtt = Math.round(r.roundTripTime * 1000);
          if (typeof r.packetsLost === 'number') next.packetsLost = r.packetsLost;
          if (typeof r.jitter === 'number') next.jitter = r.jitter;
        }
      });
      this.set({ stats: next });
    } catch {
      /* stats は best-effort */
    }
  }
  private lastOut: { bytes: number; ts: number } | null = null;
}

export function humanizeMediaError(e: Error): string {
  switch (e.name) {
    case 'NotAllowedError':
      return 'マイクの使用が許可されていません。ブラウザの設定でマイクを許可してください。';
    case 'NotFoundError':
      return 'マイクが見つかりません。';
    case 'NotReadableError':
      return 'マイクを他のアプリが使用中の可能性があります。';
    case 'OverconstrainedError':
      return '指定したマイクが利用できません。別のマイクを選んでください。';
    case 'SecurityError':
      return 'このページでは安全な接続 (https) が必要です。';
    default:
      return `${e.name}: ${e.message}`;
  }
}
