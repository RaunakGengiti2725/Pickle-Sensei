/** Real SQLite regressions for bounded, dependency-aware outbox delivery. */
import type { ShotAnalysis } from '@pickle/shared-types';
import { ApiError, createTransport } from '../src/data/api';
import {
  drainOutbox,
  OUTBOX_MAX_ATTEMPTS,
  type SyncTransport,
} from '../src/data/sync';
import { getShotOutboxStatus, retryShotSync } from '../src/data/repository';
import {
  captureDataOwnerContext,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import {
  createSqliteTestDb,
  closeSqliteTestDatabases,
} from '../testSupport/sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const session = {
  id: id(1),
  mode: 'practice_set',
  shotType: 'forehand_drive',
  focusCheckpoint: 'contact_position',
  startedAt: '2026-09-07T12:00:00.000Z',
};
const savedFetch = globalThis.fetch;
const temporaryDirectories: string[] = [];

function analysis(
  n: number,
  sessionId: string | null = null,
): ShotAnalysis & { analysisPermitId: string } {
  return {
    id: id(n),
    analysisPermitId: id(n + 10000),
    sessionId,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-09-07T12:00:01.000Z',
    timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: 7.4,
    analysisConfidence: 0.9,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
    source: 'real',
    versionVector: {
      appVersion: '1.0',
      modelBundleVersion: 'test-native-1',
      poseModelVersion: 'test-pose-1',
      paddleModelVersion: 'test-paddle-1',
      strokeDetectorVersion: 'test-stroke-1',
      phaseModelVersion: 'test-phase-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: 'forehand_drive@1',
    },
  };
}
function ids(shots: unknown[]): string[] {
  return shots.map(shot => {
    if (
      !shot ||
      typeof shot !== 'object' ||
      !('id' in shot) ||
      typeof shot.id !== 'string'
    )
      throw new Error('Production sync emitted an invalid shot identifier');
    return shot.id;
  });
}
function fixture(path?: string) {
  const store = createSqliteTestDb(path);
  const push = (kind: string, payload: unknown, owner = OWNER) => {
    store.native
      .prepare('INSERT INTO outbox (owner_key, kind, payload) VALUES (?, ?, ?)')
      .run(owner, kind, JSON.stringify(payload));
  };
  const rows = () =>
    store.native
      .prepare('SELECT * FROM outbox WHERE owner_key = ? ORDER BY id')
      .all(OWNER);
  const transport: SyncTransport = {
    syncShots: jest.fn(async shots => ({
      acceptedIds: ids(shots),
      rejected: [],
    })),
    createSession: jest.fn(async () => {}),
    finalizeSession: jest.fn(async () => {}),
  };
  return { store, push, rows, transport };
}

beforeEach(() => setActiveDataOwner(OWNER));
afterEach(() => {
  globalThis.fetch = savedFetch;
  closeSqliteTestDatabases();
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true });
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

function seedSession(
  store: ReturnType<typeof createSqliteTestDb>,
  owner = OWNER,
  startedAt = session.startedAt,
) {
  store.native
    .prepare(
      'INSERT INTO local_session (owner_key,id,mode,shot_type,focus_checkpoint,started_at) VALUES (?,?,?,?,?,?)',
    )
    .run(
      owner,
      session.id,
      session.mode,
      session.shotType,
      session.focusCheckpoint,
      startedAt,
    );
}

function missingSessionTransport(transport: SyncTransport) {
  transport.syncShots = jest.fn(async shots => ({
    acceptedIds: [],
    rejected: ids(shots).map(shotId => ({
      id: shotId,
      code: 'shot.session_not_found',
      message: 'Session not found',
    })),
  }));
}

it('reconstructs the original session after restart and explicit retry, then saves the same read once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pickle-sync-repair-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'product.sqlite');
  const before = fixture(path);
  before.push('shot.sync', analysis(100, session.id));
  missingSessionTransport(before.transport);
  await drainOutbox(before.store.db, before.transport);
  before.store.close();
  const after = fixture(path);
  expect(await getShotOutboxStatus(after.store.db, id(100))).toMatchObject({
    state: 'needs_repair',
    attempts: 0,
  });
  seedSession(after.store);
  seedSession(after.store, OTHER_OWNER, '2026-09-06T01:00:00.000Z');
  const payloadBefore = after.rows()[0]?.payload;
  expect(
    await retryShotSync(after.store.db, id(100), captureDataOwnerContext()),
  ).toBe(true);
  missingSessionTransport(after.transport);
  await drainOutbox(after.store.db, after.transport);
  expect(
    after.rows().filter(row => row.kind === 'session.create'),
  ).toHaveLength(1);
  expect(after.rows().find(row => row.kind === 'shot.sync')?.payload).toBe(
    payloadBefore,
  );
  after.transport.syncShots = jest.fn(async shots => ({
    acceptedIds: ids(shots),
    rejected: [],
  }));
  await drainOutbox(after.store.db, after.transport);
  expect(after.transport.createSession).toHaveBeenCalledWith({
    id: session.id,
    startedAt: session.startedAt,
  });
  expect(after.rows()).toEqual([]);
  expect(after.store.count('sync_receipt', OWNER)).toBe(1);
  expect(after.store.count('sync_receipt', OTHER_OWNER)).toBe(0);
  expect(after.store.count('local_session', OTHER_OWNER)).toBe(1);
});

it.each([
  'bad date',
  '2026-02-30T10:00:00.000Z',
  '2026-09-07',
  '1800-01-01T00:00:00Z',
])(
  'never reconstructs a session from corrupt original time %s',
  async startedAt => {
    const { store, push, transport } = fixture();
    seedSession(store, OWNER, startedAt);
    push('shot.sync', analysis(100, session.id));
    missingSessionTransport(transport);
    await drainOutbox(store.db, transport);
    expect(await getShotOutboxStatus(store.db, id(100))).toMatchObject({
      state: 'needs_repair',
    });
    expect(store.count('outbox', OWNER)).toBe(1);
    expect(transport.createSession).not.toHaveBeenCalled();
  },
);

it('orders finalization behind its parent outside the selected batch', async () => {
  const { store, push, transport } = fixture();
  push('session.finalize', { id: session.id });
  for (let n = 100; n < 149; n++) push('shot.sync', analysis(n));
  push('session.create', session);
  const calls: string[] = [];
  transport.createSession = jest.fn(async () => {
    calls.push('create');
  });
  transport.finalizeSession = jest.fn(async () => {
    calls.push('finalize');
  });
  await drainOutbox(store.db, transport);
  expect(calls).toEqual(['create', 'finalize']);
  expect(store.count('outbox', OWNER)).toBe(0);
});

it('recovers a missing original session for finalization without exhausting permanent retries', async () => {
  const { store, push, rows, transport } = fixture();
  seedSession(store);
  push('session.finalize', { id: session.id });
  transport.finalizeSession = jest
    .fn()
    .mockRejectedValueOnce(
      new ApiError(404, 'session.not_found', 'Session not found'),
    )
    .mockResolvedValue(undefined);
  await drainOutbox(store.db, transport);
  expect(rows().every(row => row.attempts === 0)).toBe(true);
  expect(rows().filter(row => row.kind === 'session.create')).toHaveLength(1);
  await drainOutbox(store.db, transport);
  expect(transport.createSession).toHaveBeenCalledTimes(1);
  expect(rows()).toEqual([]);
});

it.each(['before', 'after'] as const)(
  'receipt and outbox remain atomic across a failure %s commit',
  async when => {
    const { store, push, transport } = fixture();
    push('shot.sync', analysis(100));
    store.failCommitOnce(when, 'INTO sync_receipt');
    await drainOutbox(store.db, transport);
    expect(store.count('sync_receipt', OWNER)).toBe(when === 'before' ? 0 : 1);
    expect(store.count('outbox', OWNER)).toBe(when === 'before' ? 1 : 0);
    await drainOutbox(store.db, transport);
    expect(store.count('sync_receipt', OWNER)).toBe(1);
    expect(store.count('outbox', OWNER)).toBe(0);
    expect(transport.syncShots).toHaveBeenCalledTimes(
      when === 'before' ? 2 : 1,
    );
  },
);

it('an acknowledgement from a retired A→B→A owner generation cannot write a receipt or delete its queue', async () => {
  const { store, push, transport } = fixture();
  push('shot.sync', analysis(100));
  let finish!: (value: { acceptedIds: string[]; rejected: [] }) => void;
  let started!: () => void;
  const requestStarted = new Promise<void>(resolve => {
    started = resolve;
  });
  transport.syncShots = jest.fn(
    () =>
      new Promise(resolve => {
        finish = resolve;
        started();
      }),
  );
  const drain = drainOutbox(store.db, transport);
  await requestStarted;
  setActiveDataOwner(OTHER_OWNER);
  setActiveDataOwner(OWNER);
  finish({ acceptedIds: [id(100)], rejected: [] });
  await expect(drain).rejects.toThrow('account changed');
  expect(store.count('sync_receipt', OWNER)).toBe(0);
  expect(store.count('outbox', OWNER)).toBe(1);
  transport.syncShots = jest.fn(async shots => ({
    acceptedIds: ids(shots),
    rejected: [],
  }));
  await drainOutbox(store.db, transport);
  expect(store.count('sync_receipt', OWNER)).toBe(1);
});

it('repair retries are fenced at commit and never reset another account or unrelated parent', async () => {
  const { store, push } = fixture();
  push('shot.sync', analysis(100, session.id));
  push('session.create', session);
  push('shot.sync', analysis(100, session.id), OTHER_OWNER);
  push('session.create', session, OTHER_OWNER);
  push('session.create', { ...session, id: id(2) });
  store.native.exec(
    "UPDATE outbox SET repair_reason = 'session.missing', attempts = 8",
  );
  const context = captureDataOwnerContext();
  store.observeStatements(call => {
    if (call.sql.includes('SET repair_reason = NULL')) {
      store.observeStatements(null);
      setActiveDataOwner(OTHER_OWNER);
      setActiveDataOwner(OWNER);
    }
  });
  await expect(retryShotSync(store.db, id(100), context)).rejects.toThrow(
    'account changed',
  );
  expect(
    store.native
      .prepare('SELECT * FROM outbox')
      .all()
      .every(row => row.attempts === 8),
  ).toBe(true);
  expect(
    await retryShotSync(store.db, id(100), captureDataOwnerContext()),
  ).toBe(true);
  expect(
    store.native
      .prepare('SELECT * FROM outbox WHERE owner_key = ?')
      .all(OTHER_OWNER)
      .every(row => row.attempts === 8),
  ).toBe(true);
  expect(
    store.native
      .prepare(
        "SELECT * FROM outbox WHERE kind = 'session.create' AND json_extract(payload,'$.id') = ?",
      )
      .get(id(2))?.attempts,
  ).toBe(8);
});

it('submits identical duplicate saved shots once and removes both rows only on their matching receipt', async () => {
  const { store, push, transport } = fixture();
  push('shot.sync', analysis(100));
  push('shot.sync', analysis(100));
  await drainOutbox(store.db, transport);
  expect(jest.mocked(transport.syncShots).mock.calls[0]?.[0]).toHaveLength(1);
  expect(store.count('sync_receipt', OWNER)).toBe(1);
  expect(store.count('outbox', OWNER)).toBe(0);
});

it('holds conflicting saved shot identifiers for repair while an independent read still syncs', async () => {
  const { store, push, transport } = fixture();
  push('shot.sync', analysis(100));
  push('shot.sync', { ...analysis(100), overallScore: 3.1 });
  push('shot.sync', analysis(101));
  await drainOutbox(store.db, transport);
  expect(
    ids(jest.mocked(transport.syncShots).mock.calls[0]?.[0] ?? []),
  ).toEqual([id(101)]);
  expect(await getShotOutboxStatus(store.db, id(100))).toMatchObject({
    state: 'needs_repair',
  });
  expect(store.count('outbox', OWNER)).toBe(2);
  expect(store.count('sync_receipt', OWNER)).toBe(1);
});

it('detects a conflicting duplicate beyond the batch boundary before acknowledging either copy', async () => {
  const { store, push, transport } = fixture();
  for (let n = 100; n < 150; n++) push('shot.sync', analysis(n));
  push('shot.sync', { ...analysis(100), overallScore: 3.1 });
  await drainOutbox(store.db, transport);
  expect(
    ids(jest.mocked(transport.syncShots).mock.calls[0]?.[0] ?? []),
  ).not.toContain(id(100));
  await drainOutbox(store.db, transport);
  expect(store.count('outbox', OWNER)).toBe(2);
  expect(
    store.native
      .prepare('SELECT entity_id FROM sync_receipt')
      .all()
      .map(row => row.entity_id),
  ).not.toContain(id(100));
});

it('deduplicates trial payloads with different object key order without withholding valid evidence', async () => {
  const { store, push, rows, transport } = fixture();
  push('evaluation.trial', {
    trialId: id(100),
    facts: { camera: 'side', measured: true },
  });
  push('evaluation.trial', {
    facts: { measured: true, camera: 'side' },
    trialId: id(100),
  });
  transport.uploadEvaluationTrials = jest.fn(async trials => {
    expect(trials).toHaveLength(1);
    return { acceptedTrialIds: [id(100)], rejected: [] };
  });
  await drainOutbox(store.db, transport);
  expect(rows()).toEqual([]);
});

it('a valid mixed acknowledgement commits accepted work and retains each rejected row with its own retry semantics', async () => {
  const { store, push, rows, transport } = fixture();
  for (const n of [100, 101, 102]) push('shot.sync', analysis(n));
  transport.syncShots = jest.fn(async () => ({
    acceptedIds: [id(101)],
    rejected: [
      { id: id(102), code: 'validation.shot', message: 'Invalid shot' },
      { id: id(100), code: 'shot.write_failed', message: 'Retry' },
    ],
  }));
  await drainOutbox(store.db, transport);
  expect(rows().map(row => row.attempts)).toEqual([0, 1]);
  expect(store.count('sync_receipt', OWNER)).toBe(1);
});

it('trial sync rejects a contradictory ACK without deleting evidence or consuming the attempt budget', async () => {
  const { store, push, rows, transport } = fixture();
  push('evaluation.trial', { trialId: id(100), measured: true });
  transport.uploadEvaluationTrials = jest.fn(async () => ({
    acceptedTrialIds: [id(100)],
    rejected: [
      {
        trialId: id(100),
        code: 'evaluation.trial_write_failed',
        message: 'Retry',
      },
    ],
  }));
  for (let n = 0; n < OUTBOX_MAX_ATTEMPTS + 2; n++)
    await drainOutbox(store.db, transport);
  expect(rows()).toHaveLength(1);
  expect(rows()[0]?.attempts).toBe(0);
  transport.uploadEvaluationTrials = jest.fn(async () => ({
    acceptedTrialIds: [id(100)],
    rejected: [],
  }));
  await drainOutbox(store.db, transport);
  expect(rows()).toEqual([]);
});

it('an upgrade adds scheduling and repair columns without replacing queued payloads, failures or receipts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pickle-sync-upgrade-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'product.sqlite');
  const before = fixture(path);
  before.push('shot.sync', analysis(100));
  before.store.native.exec(
    "UPDATE outbox SET attempts = 3, last_error = 'validation.shot'; DROP INDEX idx_outbox_owner_drain; ALTER TABLE outbox DROP COLUMN repair_reason; ALTER TABLE outbox DROP COLUMN last_attempt_order;",
  );
  before.store.native
    .prepare(
      "INSERT INTO sync_receipt (owner_key,kind,entity_id) VALUES (?,'shot.sync',?)",
    )
    .run(OWNER, id(99));
  const saved = before.rows()[0]?.payload;
  before.store.close();
  const after = fixture(path);
  expect(after.rows()[0]).toMatchObject({
    payload: saved,
    attempts: 3,
    last_error: 'validation.shot',
    repair_reason: null,
    last_attempt_order: 0,
  });
  expect(after.store.count('sync_receipt', OWNER)).toBe(1);
  await drainOutbox(after.store.db, after.transport);
  expect(after.rows()).toEqual([]);
  expect(after.store.count('sync_receipt', OWNER)).toBe(2);
});

it('fair scheduling survives reopening so a blocked first batch cannot starve later work', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pickle-sync-fairness-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'product.sqlite');
  const before = fixture(path);
  for (let n = 100; n < 150; n++)
    before.push('shot.sync', analysis(n, session.id));
  before.push('session.create', session);
  before.push('shot.sync', analysis(500));
  before.transport.createSession = jest.fn(async () => {
    throw new ApiError(503, 'unavailable', 'Unavailable');
  });
  await drainOutbox(before.store.db, before.transport);
  before.store.close();
  const after = fixture(path);
  after.transport.createSession = before.transport.createSession;
  await drainOutbox(after.store.db, after.transport);
  expect(
    ids(jest.mocked(after.transport.syncShots).mock.calls[0]?.[0] ?? []),
  ).toEqual([id(500)]);
  expect(after.store.count('sync_receipt', OWNER)).toBe(1);
  expect(after.rows()).toHaveLength(51);
});

it('finds the exact session.create beyond a full fifty-shot batch before sending dependent shots', async () => {
  const { store, push, rows, transport } = fixture();
  for (let n = 100; n < 150; n++) push('shot.sync', analysis(n, session.id));
  push('session.create', session);
  let created = false;
  transport.createSession = jest.fn(async payload => {
    expect(payload).toEqual(session);
    created = true;
  });
  transport.syncShots = jest.fn(async shots => {
    expect(created).toBe(true);
    return { acceptedIds: ids(shots), rejected: [] };
  });
  await drainOutbox(store.db, transport);
  await drainOutbox(store.db, transport);
  expect(rows()).toEqual([]);
  expect(transport.createSession).toHaveBeenCalledTimes(1);
  expect(store.count('sync_receipt', OWNER)).toBe(50);
});

it('a failing parent holds its shots without blocking independent work behind that batch', async () => {
  const { store, push, rows, transport } = fixture();
  for (let n = 100; n < 150; n++) push('shot.sync', analysis(n, session.id));
  push('session.create', session);
  push('shot.sync', analysis(500));
  transport.createSession = jest.fn(async () => {
    throw new ApiError(503, 'unavailable', 'Unavailable');
  });
  const sent: string[] = [];
  transport.syncShots = jest.fn(async shots => {
    const batch = ids(shots);
    sent.push(...batch);
    expect(batch).toEqual([id(500)]);
    return { acceptedIds: batch, rejected: [] };
  });
  for (let attempt = 0; attempt < 3; attempt++)
    await drainOutbox(store.db, transport);
  expect(sent).toEqual([id(500)]);
  expect(rows()).toHaveLength(51);
  expect(rows().every(row => row.attempts === 0)).toBe(true);
});

it('an unrecoverable session is a visible repair state instead of endless sends or cross-owner reconstruction', async () => {
  const { store, push, transport } = fixture();
  store.native
    .prepare(
      'INSERT INTO local_session (owner_key,id,mode,shot_type,focus_checkpoint,started_at) VALUES (?,?,?,?,?,?)',
    )
    .run(
      OTHER_OWNER,
      session.id,
      session.mode,
      session.shotType,
      session.focusCheckpoint,
      session.startedAt,
    );
  push('shot.sync', analysis(100, session.id));
  transport.syncShots = jest.fn(async shots => ({
    acceptedIds: [],
    rejected: ids(shots).map(shotId => ({
      id: shotId,
      code: 'shot.session_not_found',
      message: 'Session not found',
    })),
  }));
  await drainOutbox(store.db, transport);
  expect(await getShotOutboxStatus(store.db, id(100))).toMatchObject({
    state: 'needs_repair',
    attempts: 0,
  });
  const calls = jest.mocked(transport.syncShots).mock.calls.length;
  for (let attempt = 0; attempt < 3; attempt++)
    await drainOutbox(store.db, transport);
  expect(transport.syncShots).toHaveBeenCalledTimes(calls);
  expect(transport.createSession).not.toHaveBeenCalled();
  expect(store.count('outbox', OWNER)).toBe(1);
  expect(store.count('local_session', OTHER_OWNER)).toBe(1);
});

const ambiguous: Array<[string, unknown]> = [
  ['null', null],
  ['empty body', {}],
  ['empty verdicts', { acceptedIds: [], rejected: [] }],
  ['foreign identifiers', { acceptedIds: [id(900)], rejected: [] }],
  ['partial verdict', { acceptedIds: [id(100)], rejected: [] }],
  [
    'duplicate acceptance',
    { acceptedIds: [id(100), id(100), id(101)], rejected: [] },
  ],
  [
    'contradictory verdict',
    {
      acceptedIds: [id(100), id(101)],
      rejected: [{ id: id(100), code: 'shot.write_failed', message: 'retry' }],
    },
  ],
  [
    'malformed rejection',
    {
      acceptedIds: [id(100)],
      rejected: [{ id: id(101), code: 4, message: null }],
    },
  ],
];
it.each(ambiguous)(
  '%s ACK never creates a receipt, deletes a row or exhausts retries',
  async (_name, responseBody) => {
    const { store, push, rows } = fixture();
    push('shot.sync', analysis(100));
    push('shot.sync', analysis(101));
    globalThis.fetch = jest.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => responseBody,
        }) as Response,
    );
    const transport = createTransport({
      baseUrl: 'https://invalid.test',
      token: 'test-token',
    });
    for (let attempt = 0; attempt < OUTBOX_MAX_ATTEMPTS + 2; attempt++)
      await drainOutbox(store.db, transport);
    expect(rows()).toHaveLength(2);
    expect(rows().every(row => row.attempts === 0)).toBe(true);
    expect(store.count('sync_receipt', OWNER)).toBe(0);
    expect(globalThis.fetch).toHaveBeenCalledTimes(OUTBOX_MAX_ATTEMPTS + 2);
  },
);

it('a malformed neighboring row cannot hide status of a valid saved shot', async () => {
  const { store, push } = fixture();
  store.native
    .prepare('INSERT INTO outbox (owner_key,kind,payload) VALUES (?,?,?)')
    .run(OWNER, 'shot.sync', '{broken');
  push('shot.sync', analysis(100));
  expect(await getShotOutboxStatus(store.db, id(100))).toMatchObject({
    state: 'queued',
    attempts: 0,
  });
});
