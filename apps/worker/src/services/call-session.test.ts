import { describe, expect, test } from 'vitest';
import {
  appendTranscripts,
  setCallMode,
  ensureCallSession,
  isJoinWindowOpen,
  onParticipantJoined,
  onRoomFinished,
  parseIdentity,
  processCallNotifications,
  type CallSessionRow,
} from './call-session.js';

// 最小の SQL 再生 fake DB。first/all/run/batch をサポートし、発行 SQL を記録する。
function fakeDb(handlers: { first?: (sql: string, params: unknown[]) => unknown; all?: (sql: string) => unknown[] }) {
  const runs: { sql: string; params: unknown[] }[] = [];
  const mk = (sql: string, params: unknown[]) => ({
    sql,
    params,
    async first() {
      return handlers.first?.(sql, params) ?? null;
    },
    async all() {
      return { results: handlers.all?.(sql) ?? [] };
    },
    async run() {
      runs.push({ sql, params });
      return { meta: { changes: 1 } };
    },
  });
  const db = {
    prepare(sql: string) {
      return { bind: (...params: unknown[]) => mk(sql, params) };
    },
    async batch(stmts: Array<{ sql: string; params: unknown[] }>) {
      for (const s of stmts) runs.push({ sql: s.sql, params: s.params });
    },
  } as unknown as D1Database;
  return { db, runs };
}

const base: CallSessionRow = {
  id: 'cs1',
  booking_id: 'bk1',
  line_account_id: 'acc',
  room_name: 'call-bk1',
  status: 'scheduled',
  open_from: '2026-08-22T09:50:00.000Z',
  close_at: '2026-08-22T10:45:00.000Z',
  notify_at: '2026-08-22T09:50:00.000Z',
  notified_at: null,
  customer_joined_at: null,
  staff_joined_at: null,
  started_at: null,
  ended_at: null,
  billable_seconds: null,
  mode: 'ai',
  handoff_reason: null,
  ai_summary: null,
  recording_egress_id: null,
  agent_joined_at: null,
};

describe('ensureCallSession', () => {
  test('derives open/close window from booking', async () => {
    const { db, runs } = fakeDb({
      first: () => ({
        id: 'bk1',
        line_account_id: 'acc',
        starts_at: '2026-08-22T10:00:00.000Z',
        ends_at: '2026-08-22T10:30:00.000Z',
      }),
    });
    const r = await ensureCallSession(db, { bookingId: 'bk1', now: new Date('2026-08-20T00:00:00Z') });
    expect(r.created).toBe(true);
    const ins = runs.find((r) => r.sql.includes('INSERT OR IGNORE INTO call_sessions'))!;
    expect(ins.params[3]).toBe('call-bk1');
    expect(ins.params[4]).toBe('2026-08-22T09:50:00.000Z'); // open_from
    expect(ins.params[5]).toBe('2026-08-22T10:45:00.000Z'); // close_at
    expect(ins.params[6]).toBe('2026-08-22T09:50:00.000Z'); // notify_at
  });
  test('unknown booking is no-op', async () => {
    const { db, runs } = fakeDb({ first: () => null });
    expect((await ensureCallSession(db, { bookingId: 'x', now: new Date() })).created).toBe(false);
    expect(runs).toHaveLength(0);
  });
});

describe('isJoinWindowOpen', () => {
  test('inside window / outside / cancelled', () => {
    expect(isJoinWindowOpen(base, new Date('2026-08-22T09:49:59Z'))).toBe(false);
    expect(isJoinWindowOpen(base, new Date('2026-08-22T09:50:00Z'))).toBe(true);
    expect(isJoinWindowOpen(base, new Date('2026-08-22T10:45:00Z'))).toBe(true);
    expect(isJoinWindowOpen(base, new Date('2026-08-22T10:45:01Z'))).toBe(false);
    expect(isJoinWindowOpen({ ...base, status: 'cancelled' }, new Date('2026-08-22T10:00:00Z'))).toBe(false);
    expect(isJoinWindowOpen({ ...base, status: 'in_progress' }, new Date('2026-08-22T10:00:00Z'))).toBe(true);
  });
});

describe('parseIdentity', () => {
  test('roles', () => {
    expect(parseIdentity('customer:f1')).toEqual({ role: 'customer', id: 'f1' });
    expect(parseIdentity('staff:s1')).toEqual({ role: 'staff', id: 's1' });
    expect(parseIdentity('server')).toBeNull();
  });
});

describe('onParticipantJoined', () => {
  test('writes role column and attempts in_progress promotion', async () => {
    const { db, runs } = fakeDb({});
    await onParticipantJoined(db, base, 'staff:s1', new Date('2026-08-22T09:55:00Z'));
    expect(runs[0].sql).toContain('staff_joined_at = COALESCE(staff_joined_at');
    expect(runs[1].sql).toContain("status = 'in_progress'");
  });
  test('agent identity writes agent_joined_at only', async () => {
    const { db, runs } = fakeDb({});
    await onParticipantJoined(db, base, 'agent', new Date());
    expect(runs).toHaveLength(1);
    expect(runs[0].sql).toContain('agent_joined_at');
  });
});

describe('onRoomFinished', () => {
  test('started session → ended with billable seconds and booking completed', async () => {
    const started = { ...base, status: 'in_progress' as const, started_at: '2026-08-22T10:00:00.000Z' };
    const { db, runs } = fakeDb({ first: () => started });
    const r = await onRoomFinished(db, started, new Date('2026-08-22T10:27:30Z'));
    expect(r.outcome).toBe('ended');
    const upd = runs.find((r) => r.sql.includes("status='ended'"))!;
    expect(upd.params[1]).toBe(1650);
    expect(runs.some((r) => r.sql.includes("status='completed'"))).toBe(true);
  });
  test('never started, before close_at → ignored (re-entry allowed)', async () => {
    const { db, runs } = fakeDb({ first: () => base });
    const r = await onRoomFinished(db, base, new Date('2026-08-22T10:10:00Z'));
    expect(r.outcome).toBe('ignored');
    expect(runs).toHaveLength(0);
  });
  test('never started, after close_at → no_show', async () => {
    const { db, runs } = fakeDb({ first: () => base });
    const r = await onRoomFinished(db, base, new Date('2026-08-22T10:46:00Z'));
    expect(r.outcome).toBe('no_show');
    expect(runs.some((r) => r.sql.includes("status='no_show'") && r.sql.includes('bookings'))).toBe(true);
  });
  test('already ended → ignored (idempotent)', async () => {
    const { db, runs } = fakeDb({ first: () => ({ ...base, status: 'ended' }) });
    expect((await onRoomFinished(db, base, new Date())).outcome).toBe('ignored');
    expect(runs).toHaveLength(0);
  });
});

describe('setCallMode', () => {
  test('valid and invalid transitions', async () => {
    const { db, runs } = fakeDb({});
    expect((await setCallMode(db, null, base, 'human', { by: 'operator' })).ok).toBe(true);
    expect(runs.some((r) => r.sql.includes('SET mode = ?') && r.params[0] === 'human')).toBe(true);
    expect(runs.some((r) => r.sql.includes('INSERT INTO call_transcripts') && r.params[3] === 'system')).toBe(true);
    const r = await setCallMode(db, null, { ...base, mode: 'human' }, 'human_requested', { by: 'agent' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid_transition/);
  });
});

describe('appendTranscripts', () => {
  test('batch insert with INSERT OR IGNORE for idempotency', async () => {
    const { db, runs } = fakeDb({});
    const n = await appendTranscripts(db, base, [
      { seq: 1, role: 'customer', text: 'こんにちは', at: '2026-08-22T10:00:01Z' },
      { seq: 2, role: 'assistant', text: 'お電話ありがとうございます', at: '2026-08-22T10:00:03Z' },
    ]);
    expect(n).toBe(2);
    expect(runs).toHaveLength(2);
    expect(runs[0].sql).toContain('INSERT OR IGNORE INTO call_transcripts');
    expect(runs[0].params[2]).toBe(1);
    expect(runs[1].params[3]).toBe('assistant');
  });
});

describe('processCallNotifications', () => {
  test('sends link and marks notified; failure records last_error', async () => {
    const rows = [
      { id: 'cs1', booking_id: 'bk1', starts_at: '2026-08-22T10:00:00.000Z', menu_name: 'M', staff_name: 'S', channel_access_token: 't', line_user_id: 'U1' },
      { id: 'cs2', booking_id: 'bk2', starts_at: '2026-08-22T10:00:00.000Z', menu_name: 'M', staff_name: 'S', channel_access_token: 't', line_user_id: 'U2' },
    ];
    const { db, runs } = fakeDb({ all: () => rows });
    const sent: string[] = [];
    const r = await processCallNotifications(db, {
      now: new Date('2026-08-22T09:50:00Z'),
      liffUrlBase: 'https://liff.example/',
      sender: async (p) => {
        if (p.toLineUserId === 'U2') throw new Error('boom');
        sent.push(p.callUrl);
        expect(p.ctx.startsAtJst).toBe('2026-08-22 19:00');
      },
    });
    expect(r).toEqual({ sent: 1, failed: 1 });
    expect(sent).toEqual(['https://liff.example/call/bk1']);
    expect(runs.some((x) => x.sql.includes('notified_at = ?') && x.params[1] === 'cs1')).toBe(true);
    expect(runs.some((x) => x.sql.includes('last_error') && x.params[1] === 'cs2')).toBe(true);
  });
});
