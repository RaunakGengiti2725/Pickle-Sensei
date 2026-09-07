import { AppState, type AppStateStatus } from 'react-native';
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { CapturedClip } from '../src/camera/capture';
import {
  runCaptureAnalysis,
  type RunCaptureAnalysisRequest,
} from '../src/analysis/runCaptureAnalysis';
import { runJournal, RunJournalError } from '../src/analysis/runJournal';
import {
  clearApiSession,
  establishApiSession,
  getApiSession,
} from '../src/account/apiSession';
import { createAnalysisPermitClient } from '../src/data/api';
import { getDb } from '../src/data/db';
import { purgeOwnerData } from '../src/data/repository';
import {
  clearSyncRuntime,
  configureSyncRuntime,
} from '../src/data/syncRuntime';
import {
  captureDataOwnerContext,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import {
  closeSqliteTestDatabases,
  createSqliteTestDb,
  seedSqliteCapture,
} from '../testSupport/sqlite';

jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../src/camera/capture', () => ({
  ...jest.requireActual('../src/camera/capture'),
  readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
}));

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
const CAPTURE = '33333333-3333-4333-8333-333333333333';
const OPERATION = '44444444-4444-4444-8444-444444444444';
const SESSION = '55555555-5555-4555-8555-555555555555';
const API_ORIGIN = 'https://api.example.test/functions/v1/api';
const originalFetch = globalThis.fetch;
let mockReadArtifact: (uri: string) => Promise<string>;

function signIn(owner = OWNER_A, bearerToken = 'fresh-owner-token') {
  const session = {
    canonicalAppUserId: owner,
    apiBaseUrl: API_ORIGIN,
    bearerToken,
    provider: 'apple' as const,
  };
  setActiveDataOwner(owner);
  establishApiSession(session);
  return session;
}

function fixture() {
  const { sequence, window } = generateSwingSequence();
  const sidecar = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///private/captures/owned.mov',
    capturedAtIso: '2026-09-06T12:00:00.000Z',
    durationMs: window.endMs,
    width: 1080,
    height: 1080,
    fps: 60,
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///private/captures/owned.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecar),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
  };
  return { clip, sidecar };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => {
    resolve = yes;
  });
  return { promise, resolve };
}

function response(status: number, body: unknown): Response {
  return {
    ok: status < 400,
    status,
    statusText: String(status),
    json: async () => body,
  } as Response;
}

function server(store: ReturnType<typeof createSqliteTestDb>) {
  const reservations = new Map<
    string,
    { id: string; outcome: string | null }
  >();
  const calls: Array<{
    url: string;
    bearer: string | undefined;
    body: Record<string, unknown>;
  }> = [];
  let onReserve: (() => Promise<void>) | null = null;
  let loseReserve = false;
  let releaseFailure = false;
  let releases = 0;
  const fetchPort = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<
        string,
        unknown
      >;
      const bearer = (init?.headers as Record<string, string> | undefined)
        ?.authorization;
      calls.push({ url, body, bearer });
      if (url.endsWith('/v1/analysis-permits')) {
        const key = String(body.idempotencyKey);
        const journal = store.native
          .prepare(
            'SELECT * FROM analysis_run_journal WHERE reservation_key = ?',
          )
          .get(key);
        expect(journal?.owner_key).toBe(OWNER_A);
        expect(journal?.state).toMatch(/reserve_pending|release_pending/);
        let permit = reservations.get(key);
        if (!permit) {
          permit = {
            id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(reservations.size + 1).padStart(12, '0')}`,
            outcome: null,
          };
          reservations.set(key, permit);
        }
        if (onReserve) await onReserve();
        if (loseReserve) throw new TypeError('Lost reserve response');
        return response(200, {
          permit: {
            id: permit.id,
            status: permit.outcome ? 'finalized' : 'reserved',
            accessSource: 'free',
            expiresAt: '2026-09-07T00:00:00.000Z',
          },
        });
      }
      if (url.endsWith('/finalize')) {
        if (releaseFailure)
          return response(503, {
            error: { code: 'server.unavailable', message: 'Retry later' },
          });
        const permit = [...reservations.values()].find(value =>
          url.includes(value.id),
        );
        if (!permit)
          return response(404, { error: { code: 'access.permit_not_found' } });
        if (permit.outcome && permit.outcome !== body.outcome)
          return response(409, {
            error: { code: 'access.permit_already_finalized' },
          });
        if (!permit.outcome) releases += 1;
        permit.outcome = String(body.outcome);
        return response(200, { permit });
      }
      if (url.endsWith('/v1/shots:sync')) {
        const shots = body.shots as Array<{
          id: string;
          analysisPermitId: string;
        }>;
        for (const shot of shots) {
          const permit = [...reservations.values()].find(
            value => value.id === shot.analysisPermitId,
          );
          expect([null, 'scored']).toContain(permit?.outcome);
          if (permit) permit.outcome = 'scored';
        }
        return response(200, {
          acceptedIds: shots.map(shot => shot.id),
          rejected: [],
        });
      }
      if (url.endsWith('/v1/sessions')) return response(200, {});
      throw new Error(`Unexpected test request ${url}`);
    },
  );
  return {
    calls,
    reservations,
    fetchPort,
    get releases() {
      return releases;
    },
    onReserve(callback: (() => Promise<void>) | null) {
      onReserve = callback;
    },
    loseReservationResponse(value: boolean) {
      loseReserve = value;
    },
    failRelease(value: boolean) {
      releaseFailure = value;
    },
  };
}

function setup(overrides: Partial<RunCaptureAnalysisRequest> = {}) {
  const store = createSqliteTestDb();
  const { clip, sidecar } = fixture();
  mockReadArtifact = async () => sidecar;
  seedSqliteCapture(store.db, OWNER_A, CAPTURE, clip);
  const http = server(store);
  globalThis.fetch = http.fetchPort;
  const request: RunCaptureAnalysisRequest = {
    db: store.db,
    ownerContext: captureDataOwnerContext(),
    operationId: OPERATION,
    captureId: CAPTURE,
    clip,
    declaredStroke: 'forehand_drive',
    declaredCanonical: 'FOREHAND_DRIVE',
    handedness: 'right',
    cameraView: 'side',
    apiConfig: { baseUrl: API_ORIGIN, token: 'stale-request-token' },
    appVersion: '0.1.0',
    ...overrides,
  };
  const scope = { ownerKey: OWNER_A, apiOrigin: API_ORIGIN };
  const ref = { ...scope, operationId: OPERATION };
  const permits = {
    ...scope,
    ...createAnalysisPermitClient({
      baseUrl: API_ORIGIN,
      get token() {
        return getApiSession()?.canonicalAppUserId === OWNER_A
          ? getApiSession()!.bearerToken
          : null;
      },
    }),
  };
  return { store, http, request, scope, ref, permits, sidecar };
}

beforeEach(() => {
  signIn();
});
afterEach(() => {
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
  jest.useRealTimers();
  closeSqliteTestDatabases();
});

it('uses the production schema and atomically commits record, capture, practice set, score, journal, and outbox', async () => {
  const { store, request, http, ref } = setup({
    sessionId: SESSION,
    practiceSet: {
      sessionId: SESSION,
      owner: OWNER_A,
      resumed: false,
      shotType: 'forehand_drive',
      startedAtIso: '2026-09-06T12:00:00.000Z',
      nowIso: '2026-09-06T12:00:00.000Z',
    },
  });
  const result = await runCaptureAnalysis(request);
  expect(result.kind).toBe('scored');
  const journal = await runJournal.read(store.db, ref);
  expect(journal).toMatchObject({
    state: 'committed',
    resultId: journal?.analysisId,
  });
  const marker = store.calls.find(call =>
    call.sql.includes("SET state = 'committed'"),
  );
  expect(marker).toBeDefined();
  const atomic = store.calls
    .filter(call => call.transaction === marker?.transaction)
    .map(call => call.sql)
    .join('\n');
  for (const table of [
    'local_analysis_record',
    'local_capture',
    'local_session',
    'local_shot',
    'outbox',
    'analysis_run_journal',
  ])
    expect(atomic).toContain(table);
  expect(store.count('outbox', OWNER_A)).toBe(2);
  expect(http.releases).toBe(0);
  expect(http.calls[0]?.bearer).toBe('Bearer fresh-owner-token');
  expect(JSON.stringify(journal)).not.toMatch(
    /stale-request-token|fresh-owner-token|file:|private/,
  );
});

it('replays the same explicit or default operation without another inference, key, score or outbox entry', async () => {
  const { store, request, http } = setup({ operationId: undefined });
  const first = await runCaptureAnalysis(request);
  const second = await runCaptureAnalysis(request);
  expect(second).toEqual({ ...first, replayed: true });
  expect(http.reservations.size).toBe(1);
  expect(
    http.calls.filter(call => call.url.endsWith('/v1/analysis-permits')),
  ).toHaveLength(1);
  expect(store.count('local_analysis_record', OWNER_A)).toBe(1);
  expect(store.count('outbox', OWNER_A)).toBe(1);
});

it('refuses a conflicting same-operation intent without replacing the journal or permit key', async () => {
  const { store, request, ref, http } = setup();
  await runCaptureAnalysis(request);
  const before = await runJournal.read(store.db, ref);
  await expect(
    runCaptureAnalysis({
      ...request,
      declaredCanonical: 'BACKHAND_DRIVE',
      declaredStroke: 'backhand_drive',
    }),
  ).rejects.toBeInstanceOf(RunJournalError);
  expect(await runJournal.read(store.db, ref)).toEqual(before);
  expect(http.reservations.size).toBe(1);
});

it.each([
  'INSERT INTO local_analysis_record',
  'UPDATE local_capture',
  'INSERT OR REPLACE INTO local_session',
  'INSERT OR REPLACE INTO local_shot',
  'INSERT INTO outbox',
  "SET state = 'committed'",
])(
  'rolls back actual pipeline writes and journals cleanup when %s fails',
  async fragment => {
    const { store, request, ref, http } = setup({
      sessionId: SESSION,
      practiceSet: {
        sessionId: SESSION,
        owner: OWNER_A,
        resumed: false,
        shotType: 'forehand_drive',
        startedAtIso: '2026-09-06T12:00:00.000Z',
        nowIso: '2026-09-06T12:00:00.000Z',
      },
    });
    store.failStatementOnce(fragment);
    await expect(runCaptureAnalysis(request)).rejects.toThrow(
      'SQLite write failed',
    );
    for (const table of [
      'local_analysis_record',
      'local_session',
      'local_shot',
      'outbox',
    ])
      expect(store.count(table, OWNER_A)).toBe(0);
    expect((await runJournal.read(store.db, ref))?.state).toBe('released');
    expect(http.releases).toBe(1);
  },
);

it('returns the original durable score when physical COMMIT succeeded but its acknowledgement threw', async () => {
  const { store, request, ref, http } = setup();
  store.failCommitOnce('after');
  const result = await runCaptureAnalysis(request);
  expect(result.kind).toBe('scored');
  expect((await runJournal.read(store.db, ref))?.state).toBe('committed');
  expect(store.count('outbox', OWNER_A)).toBe(1);
  expect(http.releases).toBe(0);
});

it('HOLDS an unknown commit outcome until a later durable read can replay it', async () => {
  const { store, request, ref, http, scope, permits } = setup();
  store.failCommitOnce('after');
  let sawMarker = false;
  let failedRead = false;
  store.observeStatements(call => {
    if (call.sql.includes("SET state = 'committed'")) sawMarker = true;
    if (sawMarker && !failedRead && call.sql === 'COMMIT') {
      failedRead = true;
      store.failStatementOnce('SELECT * FROM analysis_run_journal');
    }
  });
  const result = await runCaptureAnalysis(request);
  expect(result).toMatchObject({
    kind: 'unavailable',
    cause: 'recovery_pending',
  });
  expect(http.releases).toBe(0);
  expect((await runJournal.read(store.db, ref))?.state).toBe('committed');
  expect(await runJournal.recover(store.db, scope, permits)).toEqual([]);
  expect((await runCaptureAnalysis(request)).kind).toBe('scored');
  expect(http.reservations.size).toBe(1);
});

it('persists a lost reserve response and recovers it with the same key only', async () => {
  const { store, request, ref, http, scope, permits } = setup();
  http.loseReservationResponse(true);
  expect((await runCaptureAnalysis(request)).kind).toBe('unavailable');
  const journal = await runJournal.read(store.db, ref);
  expect(journal).toMatchObject({ state: 'release_pending', permitId: null });
  http.loseReservationResponse(false);
  await runJournal.recover(store.db, scope, permits);
  expect(http.reservations.size).toBe(1);
  expect(
    http.calls
      .filter(call => call.url.endsWith('/v1/analysis-permits'))
      .map(call => call.body.idempotencyKey),
  ).toEqual([journal?.reservationKey, journal?.reservationKey]);
  expect(http.releases).toBe(1);
  expect(store.count('local_shot', OWNER_A)).toBe(0);
});

it('keeps active work excluded from recovery and supports explicit cancellation without a view-lifetime flag', async () => {
  const controller = new AbortController();
  const { store, request, ref, http, scope, permits } = setup({
    signal: controller.signal,
  });
  const entered = deferred<void>();
  const gate = deferred<void>();
  http.onReserve(async () => {
    entered.resolve();
    await gate.promise;
  });
  const running = runCaptureAnalysis(request);
  await entered.promise;
  expect(await runJournal.recover(store.db, scope, permits)).toEqual([]);
  controller.abort();
  gate.resolve();
  expect(await running).toMatchObject({
    kind: 'unavailable',
    cause: 'cancelled',
  });
  expect((await runJournal.read(store.db, ref))?.state).toBe('released');
  expect(http.releases).toBe(1);
  expect(store.count('local_shot', OWNER_A)).toBe(0);
});

it('does not mint another key for a concurrent replay of an active operation', async () => {
  const { store, request, ref, http, scope } = setup();
  const entered = deferred<void>();
  const gate = deferred<void>();
  http.onReserve(async () => {
    entered.resolve();
    await gate.promise;
  });
  const first = runCaptureAnalysis(request);
  await entered.promise;
  expect(runJournal.activeOperationIds(scope)).toEqual([OPERATION]);
  expect(await runCaptureAnalysis(request)).toMatchObject({
    kind: 'unavailable',
    cause: 'recovery_pending',
  });
  gate.resolve();
  expect((await first).kind).toBe('scored');
  expect(runJournal.activeOperationIds(scope)).toEqual([]);
  expect((await runJournal.read(store.db, ref))?.state).toBe('committed');
  expect(http.reservations.size).toBe(1);
  expect(store.count('outbox', OWNER_A)).toBe(1);
});

it('leaves A cleanup pending after an A-to-B reservation callback and never sends B bearer for A', async () => {
  const { store, request, ref, http, scope, permits } = setup();
  http.onReserve(async () => {
    signIn(OWNER_B, 'owner-b-token');
  });
  expect(await runCaptureAnalysis(request)).toMatchObject({
    kind: 'unavailable',
    cause: 'account_changed',
  });
  expect(await runJournal.read(store.db, ref)).toMatchObject({
    state: 'release_pending',
    lastHttpStatus: 401,
  });
  expect(http.calls.some(call => call.bearer === 'Bearer owner-b-token')).toBe(
    false,
  );
  expect(store.count('local_shot', OWNER_B)).toBe(0);
  signIn(OWNER_A, 'restored-owner-a-token');
  await runJournal.recover(store.db, scope, permits);
  expect(http.releases).toBe(1);
  expect(http.calls.at(-1)?.bearer).toBe('Bearer restored-owner-a-token');
});

it('purges the original journal and billing namespace without resurrecting A or touching B', async () => {
  const { store, request, ref, http } = setup();
  seedSqliteCapture(store.db, OWNER_B, CAPTURE, request.clip);
  await store.db.execute('INSERT INTO kv (key, value) VALUES (?, ?), (?, ?)', [
    `billing.pending-fulfilment:${OWNER_A}`,
    'a',
    `billing.pending-fulfilment:${OWNER_B}`,
    'b',
  ]);
  http.onReserve(async () => {
    await purgeOwnerData(store.db, OWNER_A);
  });
  const result = await runCaptureAnalysis(request);
  expect(result.kind).toBe('unavailable');
  expect(await runJournal.read(store.db, ref)).toBeNull();
  expect(store.count('local_capture', OWNER_A)).toBe(0);
  expect(store.count('local_capture', OWNER_B)).toBe(1);
  expect(store.native.prepare('SELECT key FROM kv').all()).toEqual([
    { key: `billing.pending-fulfilment:${OWNER_B}` },
  ]);
});

it('recovers interrupted reservations on startup and retries a transient release on foreground', async () => {
  jest.useFakeTimers();
  const { store, request, ref, http } = setup();
  http.loseReservationResponse(true);
  await runCaptureAnalysis(request);
  http.loseReservationResponse(false);
  http.failRelease(true);
  (getDb as jest.Mock).mockReturnValue(store.db);
  let onState: ((state: AppStateStatus) => void) | null = null;
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      onState = listener;
      return { remove() {} };
    });
  configureSyncRuntime(getApiSession()!);
  await jest.advanceTimersByTimeAsync(0);
  expect((await runJournal.read(store.db, ref))?.state).toBe('release_pending');
  http.failRelease(false);
  (onState as ((state: AppStateStatus) => void) | null)?.('active');
  await jest.advanceTimersByTimeAsync(0);
  expect((await runJournal.read(store.db, ref))?.state).toBe('released');
  expect(http.releases).toBe(1);
  expect(http.reservations.size).toBe(1);
});

it('syncs an actual committed queued score on startup without releasing or reserving again', async () => {
  jest.useFakeTimers();
  const { store, request, ref, http } = setup();
  const result = await runCaptureAnalysis(request);
  expect(result.kind).toBe('scored');
  (getDb as jest.Mock).mockReturnValue(store.db);
  configureSyncRuntime(getApiSession()!);
  await jest.advanceTimersByTimeAsync(0);
  expect(store.count('outbox', OWNER_A)).toBe(0);
  expect(store.count('sync_receipt', OWNER_A)).toBe(1);
  expect((await runJournal.read(store.db, ref))?.state).toBe('committed');
  await jest.advanceTimersByTimeAsync(40_000);
  expect(http.releases).toBe(0);
  expect(
    http.calls.filter(call => call.url.endsWith('/v1/analysis-permits')),
  ).toHaveLength(1);
  expect(
    http.calls.filter(call => call.url.endsWith('/v1/shots:sync')),
  ).toHaveLength(1);
});

it('does not drain B outbox if A startup recovery switches accounts while awaiting reserve', async () => {
  jest.useFakeTimers();
  const { store, request, ref, http } = setup();
  http.loseReservationResponse(true);
  await runCaptureAnalysis(request);
  http.loseReservationResponse(false);
  await store.db.execute(
    "INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'session.create', ?)",
    [OWNER_B, JSON.stringify({ id: SESSION })],
  );
  http.onReserve(async () => {
    signIn(OWNER_B, 'owner-b-token');
  });
  (getDb as jest.Mock).mockReturnValue(store.db);
  configureSyncRuntime(getApiSession()!);
  await jest.advanceTimersByTimeAsync(0);
  expect(store.count('outbox', OWNER_B)).toBe(1);
  expect(http.calls.some(call => call.url.endsWith('/v1/sessions'))).toBe(
    false,
  );
  expect(http.calls.some(call => call.bearer === 'Bearer owner-b-token')).toBe(
    false,
  );
  expect((await runJournal.read(store.db, ref))?.state).toBe('release_pending');
});

it('snapshots a mutable caller owner context instead of allowing it to retarget in-flight work to B', async () => {
  const mutableOwner = { ...captureDataOwnerContext() };
  const { store, request, ref, http } = setup({ ownerContext: mutableOwner });
  http.onReserve(async () => {
    signIn(OWNER_B, 'owner-b-token');
    Object.assign(mutableOwner, captureDataOwnerContext());
  });
  expect(await runCaptureAnalysis(request)).toMatchObject({
    kind: 'unavailable',
    cause: 'account_changed',
  });
  expect(store.count('local_shot', OWNER_B)).toBe(0);
  expect(store.count('local_analysis_record', OWNER_B)).toBe(0);
  expect((await runJournal.read(store.db, ref))?.ownerKey).toBe(OWNER_A);
  expect(http.calls.some(call => call.bearer === 'Bearer owner-b-token')).toBe(
    false,
  );
});

it('resolves a fresh owner bearer after sidecar loading and keeps private path changes out of the operation hash', async () => {
  const { store, request, http, sidecar } = setup({ operationId: undefined });
  mockReadArtifact = async () => {
    signIn(OWNER_A, 'rotated-owner-token');
    return sidecar;
  };
  const first = await runCaptureAnalysis(request);
  const relocatedClip = {
    ...request.clip,
    uri: 'file:///different/private/container/owned.mov',
    poseSequence: {
      ...request.clip.poseSequence!,
      uri: 'file:///different/private/container/owned.pose.json',
    },
  } as CapturedClip;
  const second = await runCaptureAnalysis({ ...request, clip: relocatedClip });
  expect(second).toEqual({ ...first, replayed: true });
  expect(http.calls[0]?.bearer).toBe('Bearer rotated-owner-token');
  expect(http.reservations.size).toBe(1);
  expect(store.count('analysis_run_journal', OWNER_A)).toBe(1);
});

it('does not send the current bearer to a different public API deployment', async () => {
  const { store, request, http } = setup({
    apiConfig: {
      baseUrl: 'https://other.example.test',
      token: 'stale-request-token',
    },
  });
  expect((await runCaptureAnalysis(request)).kind).toBe('unavailable');
  expect(http.calls).toHaveLength(0);
  const row = store.native
    .prepare(
      'SELECT state, last_http_status, api_origin FROM analysis_run_journal',
    )
    .get();
  expect(row).toEqual({
    state: 'release_pending',
    last_http_status: 401,
    api_origin: 'https://other.example.test',
  });
});

it('rolls back a rejected physical commit and does not reinterpret it as a durable score', async () => {
  const { store, request, ref, http } = setup();
  store.failCommitOnce('before');
  await expect(runCaptureAnalysis(request)).rejects.toThrow(
    'SQLite commit failed before commit',
  );
  expect(store.count('local_shot', OWNER_A)).toBe(0);
  expect(store.count('outbox', OWNER_A)).toBe(0);
  expect((await runJournal.read(store.db, ref))?.state).toBe('released');
  expect(http.releases).toBe(1);
});

it.each(['owner_change', 'cancel'] as const)(
  'preserves a committed result when %s happens before publication',
  async action => {
    const controller = new AbortController();
    const { store, request, ref, http } = setup({ signal: controller.signal });
    let committing = false;
    store.observeStatements(call => {
      if (call.sql.includes("SET state = 'committed'")) committing = true;
      if (committing && call.sql === 'COMMIT') {
        committing = false;
        if (action === 'owner_change') signIn(OWNER_B, 'owner-b-token');
        else controller.abort();
      }
    });
    const outcome = await runCaptureAnalysis(request);
    expect(outcome).toMatchObject({
      kind: 'unavailable',
      cause: action === 'owner_change' ? 'account_changed' : 'recovery_pending',
    });
    expect((await runJournal.read(store.db, ref))?.state).toBe('committed');
    expect(store.count('outbox', OWNER_A)).toBe(1);
    expect(store.count('local_shot', OWNER_B)).toBe(0);
    expect(http.releases).toBe(0);
    signIn(OWNER_A);
    store.observeStatements(null);
    const replay = await runCaptureAnalysis({
      ...request,
      signal: undefined,
      ownerContext: captureDataOwnerContext(),
    });
    expect(replay).toMatchObject({ kind: 'scored', replayed: true });
    expect(http.reservations.size).toBe(1);
  },
);
