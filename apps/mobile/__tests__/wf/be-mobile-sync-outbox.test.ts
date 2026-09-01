/**
 * mobile-sync-outbox audit — focused reproductions over a fake LocalDb.
 *
 * Tests titled "REPRO:" pin CURRENTLY OBSERVED behaviour that the audit
 * reports as a defect (see the audit's `issues`); the rest certify the
 * durability properties that hold today (kill mid-flush, replay, isolation).
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from '../../src/data/db';
import { ApiError } from '../../src/data/api';
import {
  drainOutbox,
  OUTBOX_MAX_ATTEMPTS,
  type SyncTransport,
} from '../../src/data/sync';
import {
  clearSyncRuntime,
  configureSyncRuntime,
} from '../../src/data/syncRuntime';
import { hasShotSyncReceipt, saveAnalysis } from '../../src/data/repository';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));

import { getDb } from '../../src/data/db';

// Node built-ins for the static source scan. The mobile tsconfig excludes
// node typings (see importedRealFootageAnalysis.test.ts), so shims stay local.
declare const require: (id: string) => unknown;
declare const __dirname: string;
const { readdirSync, readFileSync, statSync } = require('fs') as {
  readdirSync: (path: string) => string[];
  readFileSync: (path: string, encoding: 'utf8') => string;
  statSync: (path: string) => { isDirectory(): boolean };
};
const { join } = require('path') as { join: (...parts: string[]) => string };

interface OutboxRow {
  id: number;
  owner_key: string;
  kind: string;
  payload: string;
  attempts: number;
  last_error: string | null;
}

interface Receipt {
  owner: string;
  entityId: string;
}

/**
 * Fake LocalDb with real-enough transaction semantics: BEGIN snapshots the
 * outbox + receipts, ROLLBACK restores them, so a statement failure inside
 * the accepted-shot transaction behaves like SQLite would.
 */
function fakeDb(options: { failDeleteOnce?: boolean } = {}) {
  let outbox: OutboxRow[] = [];
  let receipts: Receipt[] = [];
  let snapshot: { outbox: OutboxRow[]; receipts: Receipt[] } | null = null;
  let failDelete = options.failDeleteOnce ?? false;
  let nextId = 1;
  const statements: string[] = [];
  const db: LocalDb = {
    async execute(sql: string, params: unknown[] = []) {
      statements.push(sql);
      if (sql === 'BEGIN IMMEDIATE') {
        snapshot = {
          outbox: outbox.map(r => ({ ...r })),
          receipts: receipts.map(r => ({ ...r })),
        };
        return { rows: [] };
      }
      if (sql === 'COMMIT') {
        snapshot = null;
        return { rows: [] };
      }
      if (sql === 'ROLLBACK') {
        if (snapshot) {
          outbox = snapshot.outbox;
          receipts = snapshot.receipts;
        }
        snapshot = null;
        return { rows: [] };
      }
      if (sql.includes('INSERT OR REPLACE INTO sync_receipt')) {
        receipts.push({
          owner: String(params[0]),
          entityId: String(params[1]),
        });
        return { rows: [] };
      }
      if (sql.includes('INSERT OR REPLACE INTO local_shot')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO outbox')) {
        outbox.push({
          id: nextId++,
          owner_key: String(params[0]),
          kind: 'shot.sync',
          payload: String(params[params.length - 1]),
          attempts: 0,
          last_error: null,
        });
        return { rows: [] };
      }
      if (sql.startsWith('SELECT 1 FROM sync_receipt')) {
        return {
          rows: receipts
            .filter(
              r => r.owner === String(params[0]) && r.entityId === params[1],
            )
            .map(() => ({ '1': 1 })),
        };
      }
      if (sql.startsWith('SELECT id, kind, payload')) {
        return {
          rows: outbox
            .filter(
              r =>
                r.owner_key === String(params[0]) &&
                r.attempts < Number(params[1]),
            )
            .sort((a, b) => a.id - b.id)
            .slice(0, 50)
            .map(r => ({ ...r })),
        };
      }
      if (sql.startsWith('DELETE FROM outbox')) {
        if (failDelete) {
          failDelete = false;
          throw new Error('SQLITE_IOERR: process killed mid-flush');
        }
        const idx = outbox.findIndex(
          r => r.owner_key === params[0] && r.id === params[1],
        );
        if (idx >= 0) outbox.splice(idx, 1);
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE outbox')) {
        const row = outbox.find(
          r => r.owner_key === params[1] && r.id === params[2],
        );
        if (row) {
          if (sql.includes('attempts = attempts + 1')) row.attempts += 1;
          row.last_error = String(params[0]);
        }
        return { rows: [] };
      }
      if (sql.startsWith('SELECT count(*)')) {
        return {
          rows: [
            { n: outbox.filter(row => row.owner_key === params[0]).length },
          ],
        };
      }
      throw new Error(`fakeDb: unhandled sql ${sql}`);
    },
    close() {},
  };
  const push = (kind: string, payload: unknown, owner = GUEST_DATA_OWNER) => {
    outbox.push({
      id: nextId++,
      owner_key: owner,
      kind,
      payload: JSON.stringify(payload),
      attempts: 0,
      last_error: null,
    });
  };
  return {
    db,
    push,
    statements,
    get outbox() {
      return outbox;
    },
    get receipts() {
      return receipts;
    },
  };
}

const analysis: ShotAnalysis = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  sessionId: null,
  shotType: 'forehand_drive',
  cameraView: 'side',
  handedness: 'right',
  capturedAtIso: '2026-08-26T18:00:00.000Z',
  timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
  phases: [],
  measurements: [],
  checkpoints: [],
  overallScore: 7.4,
  analysisConfidence: 0.9,
  resultKind: 'scored',
  guidance: null,
  priorityFix: null,
  versionVector: {
    appVersion: '0.1.0',
    modelBundleVersion: 'test-native-1',
    poseModelVersion: 'test-pose-1',
    paddleModelVersion: 'test-paddle-1',
    strokeDetectorVersion: 'test-stroke-1',
    phaseModelVersion: 'test-phase-1',
    scoringModelVersion: 'sm-v1',
    shotConfigVersion: 'forehand_drive@1',
  },
  source: 'real',
};

const analysisPermitId = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const permittedAnalysis = { ...analysis, analysisPermitId };
const trial = { trialId: 'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee' };

const noopSessions = {
  createSession: async () => {},
  finalizeSession: async () => {},
};

const acceptAll: SyncTransport = {
  syncShots: async shots => ({
    acceptedIds: shots.map(shot => (shot as { id: string }).id),
    rejected: [],
  }),
  ...noopSessions,
};

function flushMicrotasks(): Promise<void> {
  return new Promise<void>(resolve => {
    setImmediate(resolve);
  });
}

describe('mobile-sync-outbox — per-item rejection classification', () => {
  beforeEach(() => setActiveDataOwner(GUEST_DATA_OWNER));
  afterAll(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  it('REPRO: a server-declared transient "shot.write_failed" rejection consumes the bounded attempt budget and abandons the shot', async () => {
    const { db, push, outbox, receipts } = fakeDb();
    push('shot.sync', permittedAnalysis);
    const syncShots = jest.fn(async () => ({
      acceptedIds: [] as string[],
      rejected: [
        {
          id: analysis.id,
          code: 'shot.write_failed',
          message:
            'The analysis could not be saved right now. It stays on this device and will retry.',
        },
      ],
    }));
    const transport: SyncTransport = { syncShots, ...noopSessions };
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++) {
      await drainOutbox(db, transport);
    }
    expect(outbox[0]!.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(outbox[0]!.last_error).toContain('will retry');

    // The server has recovered, but the row is no longer eligible: it is never
    // sent again, and the UI's only signal (the receipt) stays "pending".
    syncShots.mockClear();
    const after = await drainOutbox(db, acceptAll);
    expect(syncShots).not.toHaveBeenCalled();
    expect(after).toMatchObject({ synced: 0, failed: 0, remaining: 1 });
    expect(receipts).toHaveLength(0);
    expect(await hasShotSyncReceipt(db, analysis.id)).toBe(false);
  });

  it('a transport-level 5xx on the same batch keeps attempts at 0 (the documented transient path)', async () => {
    const { db, push, outbox } = fakeDb();
    push('shot.sync', permittedAnalysis);
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++) {
      await drainOutbox(db, {
        syncShots: async () => {
          throw new ApiError(503, 'unavailable', 'db pool exhausted');
        },
        ...noopSessions,
      });
    }
    expect(outbox[0]!.attempts).toBe(0);
    const recovered = await drainOutbox(db, acceptAll);
    expect(recovered).toMatchObject({ synced: 1, remaining: 0 });
  });
});

describe('mobile-sync-outbox — evaluation.trial transport faults', () => {
  beforeEach(() => setActiveDataOwner(GUEST_DATA_OWNER));
  afterAll(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  it('REPRO: an offline network fault burns the trial attempt budget while the shot in the same drain keeps attempts=0', async () => {
    const { db, push, outbox } = fakeDb();
    push('shot.sync', permittedAnalysis);
    push('evaluation.trial', trial);
    const offline = async () => {
      throw new TypeError('Network request failed');
    };
    const uploadEvaluationTrials = jest.fn(offline);
    const transport: SyncTransport = {
      syncShots: offline,
      uploadEvaluationTrials,
      ...noopSessions,
    };
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++) {
      await drainOutbox(db, transport);
    }
    const shotRow = outbox.find(r => r.kind === 'shot.sync')!;
    const trialRow = outbox.find(r => r.kind === 'evaluation.trial')!;
    expect(shotRow.attempts).toBe(0);
    expect(trialRow.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(trialRow.last_error).toContain('Network request failed');

    // Connectivity returns: the trial is never uploaded again.
    uploadEvaluationTrials.mockClear();
    const online: SyncTransport = {
      ...acceptAll,
      uploadEvaluationTrials,
    };
    await drainOutbox(db, online);
    expect(uploadEvaluationTrials).not.toHaveBeenCalled();
    expect(outbox.some(r => r.kind === 'evaluation.trial')).toBe(true);
  });

  it('REPRO: a 5xx / 429 from the trial endpoint is also counted as a permanent attempt', async () => {
    const { db, push, outbox } = fakeDb();
    push('evaluation.trial', trial);
    await drainOutbox(db, {
      ...acceptAll,
      uploadEvaluationTrials: async () => {
        throw new ApiError(503, 'unavailable', 'deploying');
      },
    });
    await drainOutbox(db, {
      ...acceptAll,
      uploadEvaluationTrials: async () => {
        throw new ApiError(429, 'rate_limited', 'slow down');
      },
    });
    expect(outbox[0]!.attempts).toBe(2);
  });
});

describe('mobile-sync-outbox — kill mid-flush and replay', () => {
  beforeEach(() => setActiveDataOwner(GUEST_DATA_OWNER));
  afterAll(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  it('a failure between server acceptance and the local receipt commit rolls back atomically and the replay acknowledgement completes it', async () => {
    const fake = fakeDb({ failDeleteOnce: true });
    fake.push('shot.sync', permittedAnalysis);
    const syncShots = jest.fn(acceptAll.syncShots);
    const transport: SyncTransport = { syncShots, ...noopSessions };

    const first = await drainOutbox(fake.db, transport);
    // Server accepted, local commit failed: no half-state — receipt and row
    // are both as they were before the transaction.
    expect(first.synced).toBe(0);
    expect(fake.receipts).toHaveLength(0);
    expect(fake.outbox).toHaveLength(1);
    expect(fake.outbox[0]!.attempts).toBe(0);
    expect(fake.statements).toContain('ROLLBACK');

    // Next launch: the same shot id is re-sent and the server's idempotent
    // replay path acknowledges it; the receipt lands exactly once.
    const second = await drainOutbox(fake.db, transport);
    expect(syncShots).toHaveBeenCalledTimes(2);
    expect((syncShots.mock.calls[1]![0] as Array<{ id: string }>)[0]!.id).toBe(
      analysis.id,
    );
    expect(second).toMatchObject({ synced: 1, remaining: 0 });
    expect(fake.receipts).toEqual([
      { owner: GUEST_DATA_OWNER, entityId: analysis.id },
    ]);
    expect(await hasShotSyncReceipt(fake.db, analysis.id)).toBe(true);
  });

  it('the receipt write and the outbox delete are issued inside one BEGIN IMMEDIATE … COMMIT', async () => {
    const fake = fakeDb();
    fake.push('shot.sync', permittedAnalysis);
    await drainOutbox(fake.db, acceptAll);
    const begin = fake.statements.indexOf('BEGIN IMMEDIATE');
    const commit = fake.statements.indexOf('COMMIT');
    const receipt = fake.statements.findIndex(s =>
      s.includes('INSERT OR REPLACE INTO sync_receipt'),
    );
    const del = fake.statements.findIndex(s =>
      s.startsWith('DELETE FROM outbox'),
    );
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(receipt).toBeGreaterThan(begin);
    expect(del).toBeGreaterThan(receipt);
    expect(commit).toBeGreaterThan(del);
  });
});

describe('mobile-sync-outbox — runtime triggers, cadence, Retry-After, bearer', () => {
  const session = {
    canonicalAppUserId: '33333333-3333-4333-8333-333333333333',
    apiBaseUrl: 'https://api.test',
    bearerToken: 'provider-id-token-v1',
  } as Parameters<typeof configureSyncRuntime>[0];
  const owner = canonicalDataOwner(session.canonicalAppUserId);

  interface FetchCall {
    atMs: number;
    url: string;
    authorization: string | undefined;
  }
  let calls: FetchCall[];
  let respond: () => {
    ok: boolean;
    status: number;
    statusText: string;
    headers: { get(name: string): string | null };
    json(): Promise<unknown>;
  };

  beforeEach(() => {
    // setImmediate stays real so `settle()` can flush the drain's promise
    // chain while setInterval/setTimeout/Date run on the fake clock.
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    calls = [];
    respond = () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      json: async () => ({ acceptedIds: [], rejected: [] }),
    });
    (globalThis as { fetch?: unknown }).fetch = jest.fn(
      (url: string, init: { headers: Record<string, string> }) => {
        calls.push({
          atMs: Date.now(),
          url,
          authorization: init.headers['authorization'],
        });
        return Promise.resolve(respond());
      },
    );
    setActiveDataOwner(owner);
  });

  afterEach(() => {
    clearSyncRuntime();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    delete (globalThis as { fetch?: unknown }).fetch;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await flushMicrotasks();
  }

  it('REPRO: triggerOutboxSync has no caller in the app — nothing under src/ except syncRuntime.ts references it', () => {
    const root = join(__dirname, '..', '..', 'src');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name)) continue;
        if (readFileSync(full, 'utf8').includes('triggerOutboxSync')) {
          hits.push(full.slice(root.length + 1));
        }
      }
    };
    walk(root);
    expect(hits).toEqual(['data/syncRuntime.ts']);
  });

  it('REPRO: a rating persisted right after the initial drain waits the full 30 s timer before it is sent', async () => {
    const fake = fakeDb();
    (getDb as jest.Mock).mockReturnValue(fake.db);
    configureSyncRuntime(session);
    await settle();
    // Initial drain over an empty outbox issues no request.
    expect(calls).toHaveLength(0);

    await saveAnalysis(fake.db, analysis, analysisPermitId);
    expect(fake.outbox).toHaveLength(1);
    await settle();
    expect(calls).toHaveLength(0);

    jest.advanceTimersByTime(29_999);
    await settle();
    expect(calls).toHaveLength(0);

    jest.advanceTimersByTime(1);
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.test/v1/shots:sync');
  });

  it('REPRO: after repeated 5xx the retry cadence is a fixed 30 s — no exponential backoff, no jitter', async () => {
    const fake = fakeDb();
    fake.push('shot.sync', permittedAnalysis, owner);
    (getDb as jest.Mock).mockReturnValue(fake.db);
    respond = () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      headers: { get: () => null },
      json: async () => ({
        error: { code: 'unavailable', message: 'down' },
      }),
    });
    configureSyncRuntime(session);
    await settle();
    for (let i = 0; i < 10; i++) {
      jest.advanceTimersByTime(30_000);
      await settle();
    }
    expect(calls).toHaveLength(11);
    const gaps = calls.slice(1).map((c, i) => c.atMs - calls[i]!.atMs);
    expect(new Set(gaps)).toEqual(new Set([30_000]));
    expect(fake.outbox[0]!.attempts).toBe(0);
  });

  it('REPRO: a 429 Retry-After header is discarded — the next attempt fires at 30 s, inside the server-announced window', async () => {
    const fake = fakeDb();
    fake.push('shot.sync', permittedAnalysis, owner);
    (getDb as jest.Mock).mockReturnValue(fake.db);
    respond = () => ({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers: { get: name => (name === 'Retry-After' ? '55' : null) },
      json: async () => ({
        error: { code: 'rate_limited', message: 'Too many requests.' },
      }),
    });
    configureSyncRuntime(session);
    await settle();
    expect(calls).toHaveLength(1);
    expect(fake.outbox[0]!.last_error).toContain('Too many requests');

    jest.advanceTimersByTime(30_000);
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.atMs - calls[0]!.atMs).toBeLessThan(55_000);
  });

  it('REPRO: the bearer captured at configure time is replayed on every drain — a 401 never refreshes it and rows stay queued forever', async () => {
    const fake = fakeDb();
    fake.push('shot.sync', permittedAnalysis, owner);
    (getDb as jest.Mock).mockReturnValue(fake.db);
    respond = () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      headers: { get: () => null },
      json: async () => ({
        error: {
          code: 'auth.invalid',
          message: 'The identity token could not be verified.',
        },
      }),
    });
    configureSyncRuntime(session);
    await settle();
    for (let i = 0; i < 4; i++) {
      jest.advanceTimersByTime(30_000);
      await settle();
    }
    expect(calls).toHaveLength(5);
    expect(new Set(calls.map(c => c.authorization))).toEqual(
      new Set(['Bearer provider-id-token-v1']),
    );
    expect(fake.outbox).toHaveLength(1);
    expect(fake.outbox[0]!.attempts).toBe(0);
    expect(fake.outbox[0]!.last_error).toContain('could not be verified');
  });
});
