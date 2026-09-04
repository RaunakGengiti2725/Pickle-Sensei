/**
 * Adversarial pass 3 / self-assigned extras on the outbox drain.
 *
 *  E1 (OBSERVED) orphaned-session zombie: a `session.create` row the server
 *     refuses permanently parks after 8 attempts, but every shot bound to that
 *     session is rejected with `shot.session_not_found` — a TRANSIENT code —
 *     on EVERY drain, forever: attempts never move, the row is never parked,
 *     the shot is re-POSTed on every timer tick and the Result breakdown
 *     status stays `queued` indefinitely.
 *  E2 (OBSERVED) head-of-line starvation: `LIMIT 50` selects the OLDEST
 *     eligible rows; fifty such zombies (or fifty transiently failing rows)
 *     in front of a brand-new scored shot mean the new shot is never offered
 *     to the transport.
 *  E3 (HELD) corrupt JSON / missing permit / unknown kind rows fail alone and
 *     permanently; a multi-megabyte payload and a Unicode (emoji, RTL, NUL,
 *     lone surrogate) shot id round-trip through the outbox unchanged.
 *  E4 (HELD) whole-request status classification matrix.
 */
import type { LocalDb } from '../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { ApiError } from '../../src/data/api';
import {
  OUTBOX_MAX_ATTEMPTS,
  SESSION_NOT_FOUND_REJECTION,
  drainOutbox,
  isPermanentSyncFailure,
  isTransientSyncRejection,
  type SyncTransport,
} from '../../src/data/sync';
import { getShotOutboxStatus } from '../../src/data/repository';

const owner = canonicalDataOwner('55555555-5555-4555-8555-555555555555');

interface OutboxRow {
  id: number;
  owner_key: string;
  kind: string;
  payload: string;
  attempts: number;
  last_error: string | null;
}

function jsonId(payload: string): string | null {
  try {
    const p = JSON.parse(payload) as { id?: unknown };
    return typeof p.id === 'string' ? p.id : null;
  } catch {
    return null;
  }
}

function fakeDb() {
  const outbox: OutboxRow[] = [];
  const receipts: string[] = [];
  let nextId = 1;
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const db: LocalDb = {
    async execute(rawSql, params = []) {
      const sql = norm(rawSql);
      if (sql === 'BEGIN IMMEDIATE' || sql === 'COMMIT' || sql === 'ROLLBACK')
        return { rows: [] };
      if (sql.startsWith('SELECT id, kind, payload, attempts FROM outbox')) {
        const [o, cap] = params as [string, number];
        return {
          rows: outbox
            .filter(r => r.owner_key === o && r.attempts < cap)
            .sort((a, b) => a.id - b.id)
            .slice(0, 50)
            .map(r => ({
              id: r.id,
              kind: r.kind,
              payload: r.payload,
              attempts: r.attempts,
            })),
        };
      }
      if (
        sql.startsWith(
          'UPDATE outbox SET attempts = attempts + 1, last_error = ?',
        )
      ) {
        const [err, o, id] = params as [string, string, number];
        for (const r of outbox) {
          if (r.owner_key === o && r.id === id) {
            r.attempts += 1;
            r.last_error = err;
          }
        }
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE outbox SET last_error = ?')) {
        const [err, o, id] = params as [string, string, number];
        for (const r of outbox)
          if (r.owner_key === o && r.id === id) r.last_error = err;
        return { rows: [] };
      }
      if (sql.startsWith('DELETE FROM outbox')) {
        const [o, id] = params as [string, number];
        const idx = outbox.findIndex(r => r.owner_key === o && r.id === id);
        if (idx >= 0) outbox.splice(idx, 1);
        return { rows: [] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO sync_receipt')) {
        receipts.push(String(params[1]));
        return { rows: [] };
      }
      if (sql.startsWith('SELECT count(*) AS n FROM outbox')) {
        const [o] = params as [string];
        return { rows: [{ n: outbox.filter(r => r.owner_key === o).length }] };
      }
      if (sql.startsWith('SELECT attempts, last_error FROM outbox')) {
        const [o, shotId] = params as [string, string];
        const rows = outbox
          .filter(
            r =>
              r.owner_key === o &&
              r.kind === 'shot.sync' &&
              jsonId(r.payload) === shotId,
          )
          .sort((a, b) => b.id - a.id)
          .slice(0, 1)
          .map(r => ({ attempts: r.attempts, last_error: r.last_error }));
        return { rows };
      }
      throw new Error(`fakeDb: unhandled sql ${sql}`);
    },
    close() {},
  };
  const seed = (kind: string, payload: string) => {
    const id = nextId++;
    outbox.push({
      id,
      owner_key: owner,
      kind,
      payload,
      attempts: 0,
      last_error: null,
    });
    return id;
  };
  return { db, outbox, receipts, seed };
}

function shot(
  id: string,
  sessionId: string | null = null,
  extra: Record<string, unknown> = {},
) {
  return JSON.stringify({
    id,
    sessionId,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-08-30T10:00:00.000Z',
    timestamps: { startMs: 0, contactMs: 1, endMs: 2 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: 7,
    analysisConfidence: 0.8,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'm',
      poseModelVersion: 'p',
      paddleModelVersion: 'none',
      strokeDetectorVersion: 's',
      phaseModelVersion: 'ph',
      scoringModelVersion: 'sc',
      shotConfigVersion: 'c',
    },
    source: 'real',
    analysisPermitId: `permit-${id}`,
    ...extra,
  });
}

type ShotsResponse = Awaited<ReturnType<SyncTransport['syncShots']>>;

function transport(opts: {
  onShots: (
    shots: Array<{ id: string; sessionId: string | null }>,
  ) => ShotsResponse | Promise<ShotsResponse>;
  onSession?: (session: unknown) => Promise<void>;
}) {
  const shotCalls: Array<Array<{ id: string; sessionId: string | null }>> = [];
  const sessionCalls: unknown[] = [];
  const t: SyncTransport = {
    async syncShots(shots) {
      const typed = shots as Array<{ id: string; sessionId: string | null }>;
      shotCalls.push(typed);
      return opts.onShots(typed);
    },
    async createSession(session) {
      sessionCalls.push(session);
      if (opts.onSession) await opts.onSession(session);
    },
    async finalizeSession() {},
  };
  return { t, shotCalls, sessionCalls };
}

beforeEach(() => setActiveDataOwner(owner));
afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

describe('extra E1 — orphaned-session zombie', () => {
  it('a shot whose session.create was permanently refused is re-POSTed on every drain forever and reads as queued', async () => {
    const { db, outbox, seed } = fakeDb();
    seed('session.create', JSON.stringify({ id: 'sess-dead', startedAt: 'x' }));
    seed('shot.sync', shot('shot-orphan', 'sess-dead'));
    const { t, shotCalls, sessionCalls } = transport({
      onSession: async () => {
        throw new ApiError(
          422,
          'session.invalid',
          'startedAt must be ISO-8601',
        );
      },
      onShots: shots => ({
        acceptedIds: [],
        rejected: shots.map(s => ({
          id: s.id,
          code: SESSION_NOT_FOUND_REJECTION,
          message: 'Session not found',
        })),
      }),
    });
    expect(isTransientSyncRejection(SESSION_NOT_FOUND_REJECTION)).toBe(true);

    const DRAINS = 40;
    for (let i = 0; i < DRAINS; i += 1) await drainOutbox(db, t);

    // The session row parks after 8 attempts …
    expect(sessionCalls).toHaveLength(OUTBOX_MAX_ATTEMPTS);
    const sessionRow = outbox.find(r => r.kind === 'session.create')!;
    expect(sessionRow.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    // … but the orphaned shot was POSTed on EVERY one of the 40 drains, never
    // burned an attempt, and will keep going on every future tick.
    expect(shotCalls).toHaveLength(DRAINS);
    const shotRow = outbox.find(r => r.kind === 'shot.sync')!;
    expect(shotRow.attempts).toBe(0);
    expect(shotRow.last_error).toBe(
      `${SESSION_NOT_FOUND_REJECTION}: Session not found`,
    );
    // Result breakdown reads it as still queued ("pending" copy) forever.
    await expect(getShotOutboxStatus(db, 'shot-orphan')).resolves.toEqual({
      state: 'queued',
      attempts: 0,
      lastError: `${SESSION_NOT_FOUND_REJECTION}: Session not found`,
    });
  });
});

describe('extra E2 — LIMIT 50 head-of-line starvation', () => {
  it('fifty transiently-rejected older rows starve a brand-new shot from ever reaching the transport', async () => {
    const { db, seed } = fakeDb();
    for (let i = 0; i < 50; i += 1)
      seed('shot.sync', shot(`old-${i}`, 'sess-dead'));
    seed('shot.sync', shot('fresh-shot'));
    const { t, shotCalls } = transport({
      onShots: shots => ({
        acceptedIds: shots.filter(s => s.sessionId === null).map(s => s.id),
        rejected: shots
          .filter(s => s.sessionId !== null)
          .map(s => ({
            id: s.id,
            code: SESSION_NOT_FOUND_REJECTION,
            message: 'nf',
          })),
      }),
    });
    for (let i = 0; i < 25; i += 1) {
      const result = await drainOutbox(db, t);
      expect(result).toEqual({ synced: 0, failed: 50, remaining: 51 });
    }
    // 25 drains, 1250 shot submissions — the fresh shot was in NONE of them.
    const offered = new Set(shotCalls.flat().map(s => s.id));
    expect(offered.has('fresh-shot')).toBe(false);
    expect(offered.size).toBe(50);
    await expect(getShotOutboxStatus(db, 'fresh-shot')).resolves.toEqual({
      state: 'queued',
      attempts: 0,
      lastError: null,
    });
  });

  it('control: fifty PERMANENTLY rejected rows release the window after 8 drains and the fresh shot then syncs', async () => {
    const { db, seed, receipts } = fakeDb();
    for (let i = 0; i < 50; i += 1)
      seed('shot.sync', shot(`old-${i}`, 'sess-dead'));
    seed('shot.sync', shot('fresh-shot'));
    const { t } = transport({
      onShots: shots => ({
        acceptedIds: shots.filter(s => s.sessionId === null).map(s => s.id),
        rejected: shots
          .filter(s => s.sessionId !== null)
          .map(s => ({ id: s.id, code: 'shot.id_conflict', message: 'c' })),
      }),
    });
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i += 1) await drainOutbox(db, t);
    expect(receipts).toEqual([]);
    const ninth = await drainOutbox(db, t);
    expect(ninth).toEqual({ synced: 1, failed: 0, remaining: 50 });
    expect(receipts).toEqual(['fresh-shot']);
  });
});

describe('extra E3 — corrupt, unknown, huge and Unicode payloads', () => {
  it('corrupt JSON, a missing permit and an unknown kind fail alone and permanently; valid siblings still sync', async () => {
    const { db, outbox, seed, receipts } = fakeDb();
    const corruptId = seed('shot.sync', '{"id": "half-');
    const noPermit = seed(
      'shot.sync',
      shot('no-permit', null, { analysisPermitId: undefined }),
    );
    const blankPermit = seed(
      'shot.sync',
      shot('blank-permit', null, { analysisPermitId: '   ' }),
    );
    const numericPermit = seed(
      'shot.sync',
      shot('num-permit', null, { analysisPermitId: 12 }),
    );
    const unknownKind = seed('shot.delete', JSON.stringify({ id: 'x' }));
    const badSession = seed('session.create', 'not json');
    seed('shot.sync', shot('good'));
    const { t, shotCalls, sessionCalls } = transport({
      onShots: shots => ({ acceptedIds: shots.map(s => s.id), rejected: [] }),
    });
    const result = await drainOutbox(db, t);
    expect(result).toEqual({ synced: 1, failed: 6, remaining: 6 });
    expect(shotCalls).toEqual([[expect.objectContaining({ id: 'good' })]]);
    expect(sessionCalls).toEqual([]);
    expect(receipts).toEqual(['good']);
    const byId = new Map(outbox.map(r => [r.id, r]));
    for (const id of [
      corruptId,
      noPermit,
      blankPermit,
      numericPermit,
      unknownKind,
      badSession,
    ]) {
      expect(byId.get(id)!.attempts).toBe(1);
    }
    expect(byId.get(corruptId)!.last_error).toMatch(/JSON/);
    expect(byId.get(noPermit)!.last_error).toBe(
      'Error: shot.sync_missing_analysis_permit',
    );
    expect(byId.get(blankPermit)!.last_error).toBe(
      'Error: shot.sync_missing_analysis_permit',
    );
    expect(byId.get(numericPermit)!.last_error).toBe(
      'Error: shot.sync_missing_analysis_permit',
    );
    expect(byId.get(unknownKind)!.last_error).toBe(
      'Error: unknown outbox kind shot.delete',
    );
    expect(byId.get(badSession)!.last_error).toMatch(/JSON/);
  });

  it('Unicode shot ids (emoji, RTL, NUL, lone surrogate) and a 4 MB payload round-trip unchanged and are matched by id', async () => {
    const { db, seed, receipts, outbox } = fakeDb();
    const ids = [
      'shot-🏓-\u200F\u05D0\u05D1-\u0000-nul',
      'shot-\uD800-lone-surrogate',
      'shot-' + 'ü'.repeat(500),
    ];
    for (const id of ids) seed('shot.sync', shot(id));
    const hugeId = 'shot-huge';
    seed(
      'shot.sync',
      shot(hugeId, null, { phases: [{ blob: 'x'.repeat(4 * 1024 * 1024) }] }),
    );
    const { t, shotCalls } = transport({
      onShots: shots => ({ acceptedIds: shots.map(s => s.id), rejected: [] }),
    });
    const result = await drainOutbox(db, t);
    expect(result).toEqual({ synced: 4, failed: 0, remaining: 0 });
    const sent = shotCalls[0]!.map(s => s.id);
    // JSON.stringify → JSON.parse round-trip: the lone surrogate is preserved
    // as-is by JSON.parse of the escaped form, every other id is identical.
    expect(sent).toEqual([...ids, hugeId]);
    expect(receipts).toEqual([...ids, hugeId]);
    expect(outbox).toEqual([]);
    const huge = shotCalls[0]![3] as unknown as {
      phases: Array<{ blob: string }>;
    };
    expect(huge.phases[0]!.blob.length).toBe(4 * 1024 * 1024);
  });

  it('a Unicode id that the server rejects is looked up by id for the Result breakdown status', async () => {
    const { db, seed } = fakeDb();
    const id = 'shot-🏓-\u200Fабв';
    seed('shot.sync', shot(id));
    const { t } = transport({
      onShots: shots => ({
        acceptedIds: [],
        rejected: shots.map(s => ({
          id: s.id,
          code: 'shot.id_conflict',
          message: '✗',
        })),
      }),
    });
    await drainOutbox(db, t);
    await expect(getShotOutboxStatus(db, id)).resolves.toEqual({
      state: 'rejected',
      attempts: 1,
      lastError: 'shot.id_conflict: ✗',
    });
  });
});

describe('extra E4 — whole-request status classification', () => {
  it.each([
    [400, true],
    [401, false],
    [402, true],
    [403, true],
    [404, true],
    [408, false],
    [409, true],
    [413, true],
    [422, true],
    [429, false],
    [499, true],
    [500, false],
    [502, false],
    [503, false],
    [0, false],
  ])('ApiError %i → permanent=%s', (status, permanent) => {
    expect(isPermanentSyncFailure(new ApiError(status, 'c', 'm'))).toBe(
      permanent,
    );
  });

  it('non-ApiError throwables (TypeError, string, null, AbortError) are transient', () => {
    for (const e of [
      new TypeError('Network request failed'),
      'boom',
      null,
      undefined,
      { status: 400 },
    ]) {
      expect(isPermanentSyncFailure(e)).toBe(false);
    }
  });

  it('a whole-request 429 leaves attempts untouched across 30 drains; a 413 (payload too large) burns the batch permanently', async () => {
    const { db, outbox, seed } = fakeDb();
    seed('shot.sync', shot('a'));
    seed('shot.sync', shot('b'));
    let status = 429;
    const { t } = transport({
      onShots: () => {
        throw new ApiError(status, 'rate.limited', 'slow down');
      },
    });
    for (let i = 0; i < 30; i += 1) await drainOutbox(db, t);
    expect(outbox.map(r => r.attempts)).toEqual([0, 0]);
    expect(outbox.map(r => r.last_error)).toEqual([
      'Error: slow down',
      'Error: slow down',
    ]);
    status = 413;
    await drainOutbox(db, t);
    expect(outbox.map(r => r.attempts)).toEqual([1, 1]);
  });
});
