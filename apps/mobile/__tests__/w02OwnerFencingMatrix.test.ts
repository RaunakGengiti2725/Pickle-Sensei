/**
 * W02-02: account switch A -> B (and A -> B -> A) while an analysis is in
 * flight, one probe per stage. Every probe asserts the same three things
 * against a real owner-keyed SQLite database and a fake edge API:
 *   1. no owner-scoped row is written under B (`rowsOwnedBy`);
 *   2. nothing of A's work is readable through the active-owner read paths
 *      while B is active, and B's bearer is never sent for A's work;
 *   3. A, once restored, recovers the pending result through the SAME durable
 *      operation identity (operation id / journal row), never a new one.
 *
 * Stage -> production fence exercised:
 *   capture     `OriginalAnalysisExecution` invalidation + `prepare()`'s
 *               owner-scoped capture lookup; `forDataOwner()` around
 *               `savePendingCapture()`.
 *   extraction  `runOriginalCaptureAnalysis()` re-asserting the execution
 *               after `extractImportedPoseSequence()` resolves.
 *   settlement  `runJournal` release_pending / committed states and
 *               `runCaptureAnalysis()` replay of a committed result.
 *   sync        `drainOutbox()` owner context + `syncRuntime` generation.
 *   delivery    `setActiveDataOwner()` reaching EVERY owner subscriber; the
 *               camera byte fence (capture.ts), the Analyze screen's abandon
 *               and the execution lease are all fenced only through
 *               `subscribeToDataOwner()`, so one failing subscriber must not
 *               starve the ones registered after it.
 */
import { AppState } from 'react-native';
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import {
  extractImportedPoseSequence,
  readCaptureArtifact,
  verifyCapturedClipCurrentBytes,
  type CapturedClip,
} from '../src/camera/capture';
import {
  prepareOriginalCaptureAnalysis,
  runCaptureAnalysis,
  runOriginalCaptureAnalysis,
  type RunCaptureAnalysisRequest,
} from '../src/analysis/runCaptureAnalysis';
import {
  OriginalAnalysisExecution,
  originalAnalysisOperations,
} from '../src/analysis/originalAnalysisOperations';
import { finalizeAcknowledgement } from '../__harness__/analysisPermitRoute';
import { runJournal } from '../src/analysis/runJournal';
import {
  clearApiSession,
  establishApiSession,
  getApiSession,
} from '../src/account/apiSession';
import { createAnalysisPermitClient } from '../src/data/api';
import { getDb } from '../src/data/db';
import {
  getAnalysis,
  getPendingCapture,
  hasShotSyncReceipt,
  listPendingCaptures,
  listShots,
  savePendingCapture,
} from '../src/data/repository';
import {
  clearSyncRuntime,
  configureSyncRuntime,
  triggerOutboxSync,
} from '../src/data/syncRuntime';
import { forDataOwner } from '../src/data/transactions';
import {
  captureDataOwnerContext,
  DataOwnerChangedError,
  getActiveDataOwner,
  getDataOwnerSnapshot,
  isDataOwnerContextCurrent,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
  subscribeToDataOwner,
} from '../src/data/accountScope';
import {
  closeSqliteTestDatabases,
  createSqliteTestDb,
  seedSqliteCapture,
} from '../testSupport/sqlite';

jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../src/camera/capture', () => ({
  ...jest.requireActual('../src/camera/capture'),
  verifyCapturedClipCurrentBytes: jest.fn(),
  readCaptureArtifact: jest.fn(),
  extractImportedPoseSequence: jest.fn(),
}));

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
const CAPTURE = '33333333-3333-4333-8333-333333333333';
const OPERATION = '44444444-4444-4444-8444-444444444444';
const SESSION = '55555555-5555-4555-8555-555555555555';
const API_ORIGIN = 'https://api.example.test/functions/v1/api';
const TOKEN_A = 'owner-a-token';
const TOKEN_A_RESTORED = 'owner-a-restored-token';
const TOKEN_B = 'owner-b-token';
const originalFetch = globalThis.fetch;
const leases: OriginalAnalysisExecution[] = [];
/** Either fence is acceptable: both reject before any row is written. */
const OWNER_FENCE_ERROR = expect.stringMatching(
  /^(DataOwnerChangedError|OriginalAnalysisHeldError)$/,
);

type Store = ReturnType<typeof createSqliteTestDb>;

function signIn(owner: string, bearerToken: string) {
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

function switchToB() {
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  return signIn(OWNER_B, TOKEN_B);
}

function returnToA() {
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  return signIn(OWNER_A, TOKEN_A_RESTORED);
}

function execution() {
  const value = new OriginalAnalysisExecution(
    captureDataOwnerContext(),
    API_ORIGIN,
  );
  leases.push(value);
  return value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => {
    resolve = yes;
  });
  return { promise, resolve };
}

function fixture() {
  const { sequence, window } = generateSwingSequence();
  const sidecar = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///private/captures/owned.mov',
    captureMode: 'imported_video',
    capturedAtIso: '2026-09-06T12:00:00.000Z',
    durationMs: window.endMs,
    width: 1080,
    height: 1080,
    fps: 60,
    byteSize: 25,
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    nativeMediaIdentity: {
      schemaVersion: 1,
      format: 'pickle.native-media-identity.v1',
      receiptId: '66666666-6666-4666-8666-666666666666',
      operationId: '77777777-7777-4777-8777-777777777777',
      origin: 'import_copy',
      algorithm: 'sha256',
      videoFileName: 'owned.mov',
      byteSize: 25,
      sha256: sha256Hex('synthetic test movie bytes'),
    },
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

function response(status: number, body: unknown): Response {
  return {
    ok: status < 400,
    status,
    statusText: String(status),
    json: async () => body,
  } as Response;
}

/** Fake edge API. Every reservation must belong to A's durable journal. */
function server(store: Store) {
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
  let onSyncShots: (() => Promise<void>) | null = null;
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
            `SELECT owner_key, state FROM analysis_run_journal WHERE reservation_key = ?
             UNION ALL
             SELECT owner_key, state FROM analysis_execution_attempts WHERE reservation_key = ?`,
          )
          .get(key, key);
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
        return response(200, finalizeAcknowledgement(url, body));
      }
      if (url.endsWith('/v1/shots:sync')) {
        const shots = body.shots as Array<{
          id: string;
          analysisPermitId: string;
        }>;
        if (onSyncShots) await onSyncShots();
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
    onSyncShots(callback: (() => Promise<void>) | null) {
      onSyncShots = callback;
    },
    usedBearer(token: string) {
      return calls.some(call => call.bearer === `Bearer ${token}`);
    },
  };
}

function ownerScopedTables(store: Store): string[] {
  const tables = store.native
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map(row => String(row.name));
  return tables.filter(table =>
    store.native
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some(column => column.name === 'owner_key'),
  );
}

/** Every owner-scoped row that belongs to `owner`, keyed by table. */
function rowsOwnedBy(store: Store, owner: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of ownerScopedTables(store)) {
    const n = store.count(table, owner);
    if (n > 0) counts[table] = n;
  }
  return counts;
}

async function visibleToActiveOwner(store: Store, analysisId?: string) {
  return {
    pendingCaptures: (await listPendingCaptures(store.db)).map(c => c.id),
    capture: await getPendingCapture(store.db, CAPTURE),
    shots: await listShots(store.db),
    analysis: analysisId ? await getAnalysis(store.db, analysisId) : null,
  };
}

function legacySetup(overrides: Partial<RunCaptureAnalysisRequest> = {}) {
  const store = createSqliteTestDb();
  const { clip, sidecar } = fixture();
  jest.mocked(readCaptureArtifact).mockResolvedValue(sidecar);
  seedSqliteCapture(store.db, OWNER_A, CAPTURE, clip);
  expect(ownerScopedTables(store)).toEqual(
    expect.arrayContaining([
      'local_capture',
      'local_shot',
      'local_analysis_record',
      'outbox',
      'sync_receipt',
      'analysis_run_journal',
      'analysis_logical_operations',
      'analysis_execution_attempts',
    ]),
  );
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
        const session = getApiSession();
        return session?.canonicalAppUserId === OWNER_A
          ? session.bearerToken
          : null;
      },
    }),
  };
  return { store, http, request, scope, ref, permits, clip, sidecar };
}

async function originalFixture() {
  const store = createSqliteTestDb();
  const { clip, sidecar } = fixture();
  const pose = clip.poseSequence!;
  delete clip.poseSequence;
  seedSqliteCapture(store.db, OWNER_A, CAPTURE, clip);
  await store.db.execute(
    'UPDATE local_capture SET declared_stroke = ? WHERE owner_key = ? AND id = ?',
    ['forehand_drive', OWNER_A, CAPTURE],
  );
  jest.mocked(readCaptureArtifact).mockResolvedValue(sidecar);
  jest.mocked(extractImportedPoseSequence).mockResolvedValue({
    poseSequence: pose,
    framesWithPose: pose.frameCount,
    framesTotal: pose.frameCount,
  });
  const http = server(store);
  globalThis.fetch = http.fetchPort;
  const owner = execution();
  const request: RunCaptureAnalysisRequest = {
    db: store.db,
    ownerContext: owner.ownerContext,
    captureId: CAPTURE,
    clip,
    declaredStroke: 'forehand_drive',
    declaredCanonical: 'FOREHAND_DRIVE',
    handedness: 'right',
    cameraView: 'side',
    appVersion: '0.1.0',
    apiConfig: { baseUrl: API_ORIGIN, token: 'never-save-this-token' },
    sessionId: SESSION,
    practiceSet: {
      owner: OWNER_A,
      sessionId: SESSION,
      resumed: false,
      shotType: 'forehand_drive',
      startedAtIso: '2026-09-06T12:00:00.000Z',
      nowIso: '2026-09-06T12:00:00.000Z',
    },
  };
  /** Shapes the request the way the shipping screen would for `via`'s owner. */
  const prepare = (via: OriginalAnalysisExecution) =>
    prepareOriginalCaptureAnalysis(
      {
        ...request,
        ownerContext: via.ownerContext,
        practiceSet: {
          ...request.practiceSet!,
          owner: via.ownerContext.ownerKey,
        },
      },
      via,
      OPERATION,
    );
  const run = (via: OriginalAnalysisExecution) =>
    runOriginalCaptureAnalysis({
      db: store.db,
      execution: via,
      operationId: OPERATION,
    });
  return { store, http, owner, request, prepare, run, pose };
}

async function originalSetup() {
  const fixtureState = await originalFixture();
  const operation = await fixtureState.prepare(fixtureState.owner);
  return { ...fixtureState, operation };
}

beforeEach(() => {
  signIn(OWNER_A, TOKEN_A);
  jest.mocked(verifyCapturedClipCurrentBytes).mockReset();
  jest.mocked(readCaptureArtifact).mockReset();
  jest.mocked(extractImportedPoseSequence).mockReset();
  jest
    .mocked(verifyCapturedClipCurrentBytes)
    .mockImplementation(async clip => ({
      status: 'verified-current-bytes',
      comparedExpectation: (clip as CapturedClip).nativeMediaIdentity!,
    }));
});

afterEach(() => {
  for (const lease of leases.splice(0)) lease.dispose();
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
  jest.useRealTimers();
  closeSqliteTestDatabases();
});

describe('W02-02 owner fencing matrix: capture stage', () => {
  it.each([
    ['before the operation is saved', 'before_prepare'],
    ['while the operation row is being saved', 'during_prepare'],
  ] as const)(
    'switching to B %s keeps the saved capture under A, saves no operation for B, and A prepares the same operation later',
    async (_label, timing) => {
      const { store, http, owner, prepare, run } = await originalFixture();
      const ownerContext = captureDataOwnerContext();
      expect(rowsOwnedBy(store, OWNER_A)).toEqual({ local_capture: 1 });

      if (timing === 'before_prepare') {
        switchToB();
        expect(isDataOwnerContextCurrent(ownerContext)).toBe(false);
        expect(() => forDataOwner(store.db, ownerContext)).toThrow(
          DataOwnerChangedError,
        );
      } else {
        store.observeStatements(call => {
          if (call.sql.includes('INSERT INTO analysis_logical_operations')) {
            store.observeStatements(null);
            switchToB();
          }
        });
      }
      await expect(prepare(owner)).rejects.toMatchObject({
        name: OWNER_FENCE_ERROR,
      });
      store.observeStatements(null);
      expect(owner.signal.aborted).toBe(true);

      expect(rowsOwnedBy(store, OWNER_B)).toEqual({});
      expect(rowsOwnedBy(store, OWNER_A)).toEqual({ local_capture: 1 });
      expect(await visibleToActiveOwner(store)).toMatchObject({
        pendingCaptures: [],
        capture: null,
        shots: [],
      });
      const asB = execution();
      expect(
        await originalAnalysisOperations.read(store.db, asB, OPERATION),
      ).toBeNull();
      await expect(prepare(asB)).rejects.toMatchObject({
        name: 'OriginalAnalysisHeldError',
      });
      expect(rowsOwnedBy(store, OWNER_B)).toEqual({});
      expect(http.fetchPort).not.toHaveBeenCalled();

      returnToA();
      expect((await listPendingCaptures(store.db)).map(c => c.id)).toEqual([
        CAPTURE,
      ]);
      const restored = execution();
      const operation = await prepare(restored);
      expect(operation.operationId).toBe(OPERATION);
      expect(await run(restored)).toMatchObject({
        kind: 'scored',
        analysisId: operation.analysisId,
      });
      expect(http.reservations.size).toBe(1);
      expect(http.usedBearer(TOKEN_B)).toBe(false);
      expect(http.usedBearer(TOKEN_A_RESTORED)).toBe(true);
      expect(rowsOwnedBy(store, OWNER_B)).toEqual({});
      expect(store.count('local_shot', OWNER_A)).toBe(1);
    },
  );

  it('a switch while SQLite acknowledges the capture write keeps the row under A, hidden from B, and A recovers and scores it', async () => {
    const { store, http, request } = legacySetup();
    store.native
      .prepare('DELETE FROM local_capture WHERE owner_key = ?')
      .run(OWNER_A);
    const ownerContext = captureDataOwnerContext();
    const db = forDataOwner(store.db, ownerContext);
    store.observeStatements(call => {
      if (call.sql === 'BEGIN IMMEDIATE') {
        store.observeStatements(null);
        switchToB();
      }
    });
    await expect(
      savePendingCapture(
        db,
        CAPTURE,
        'forehand_drive',
        request.clip,
        'forehand_drive',
      ),
    ).rejects.toBeInstanceOf(DataOwnerChangedError);
    store.observeStatements(null);

    expect(rowsOwnedBy(store, OWNER_B)).toEqual({});
    expect(rowsOwnedBy(store, OWNER_A)).toEqual({ local_capture: 1 });
    expect(await visibleToActiveOwner(store)).toMatchObject({
      pendingCaptures: [],
      capture: null,
      shots: [],
    });
    await expect(
      savePendingCapture(db, CAPTURE, 'forehand_drive', request.clip),
    ).rejects.toBeInstanceOf(DataOwnerChangedError);
    expect(rowsOwnedBy(store, OWNER_B)).toEqual({});

    returnToA();
    expect((await listPendingCaptures(store.db)).map(c => c.id)).toEqual([
      CAPTURE,
    ]);
    expect(await getPendingCapture(store.db, CAPTURE)).toMatchObject({
      id: CAPTURE,
      clip: { uri: request.clip.uri },
    });
    const outcome = await runCaptureAnalysis({
      ...request,
      ownerContext: captureDataOwnerContext(),
    });
    expect(outcome.kind).toBe('scored');
    expect(rowsOwnedBy(store, OWNER_B)).toEqual({});
    expect(http.usedBearer(TOKEN_B)).toBe(false);
    expect(http.usedBearer(TOKEN_A_RESTORED)).toBe(true);
    expect(store.count('local_shot', OWNER_A)).toBe(1);
  });
});

describe('W02-02 owner fencing matrix: extraction stage', () => {
  it.each([
    ['A -> B', false],
    ['A -> B -> A', true],
  ])(
    'switching %s while imported pose extraction is pending writes nothing for B and A resumes the same saved operation',
    async (_label, returnBeforeResume) => {
      const { store, http, owner, operation, run, pose } =
        await originalSetup();
      const entered = deferred<void>();
      const resume = deferred<{
        poseSequence: typeof pose;
        framesWithPose: number;
        framesTotal: number;
      }>();
      jest.mocked(extractImportedPoseSequence).mockImplementationOnce(() => {
        entered.resolve();
        return resume.promise;
      });
      const pending = run(owner);
      await entered.promise;
      const before = rowsOwnedBy(store, OWNER_A);
      expect(before).toEqual({
        local_capture: 1,
        analysis_logical_operations: 1,
      });

      switchToB();
      expect(owner.signal.aborted).toBe(true);
      const asB = execution();
      expect(
        await originalAnalysisOperations.read(store.db, asB, OPERATION),
      ).toBeNull();
      expect(await visibleToActiveOwner(store)).toMatchObject({
        pendingCaptures: [],
        capture: null,
        shots: [],
      });
      if (returnBeforeResume) returnToA();
      resume.resolve({
        poseSequence: pose,
        framesWithPose: pose.frameCount,
        framesTotal: pose.frameCount,
      });
      expect(await pending).toMatchObject({
        kind: 'unavailable',
        cause: 'account_changed',
      });

      expect(rowsOwnedBy(store, OWNER_B)).toEqual({});
      expect(rowsOwnedBy(store, OWNER_A)).toEqual(before);
      expect(http.fetchPort).not.toHaveBeenCalled();
      const savedA = store.native
        .prepare(
          'SELECT payload FROM local_capture WHERE owner_key = ? AND id = ?',
        )
        .get(OWNER_A, CAPTURE);
      expect(
        (JSON.parse(String(savedA?.payload)) as CapturedClip).poseSequence,
      ).toBeUndefined();

      if (!returnBeforeResume) returnToA();
      const restored = execution();
      const saved = await originalAnalysisOperations.read(
        store.db,
        restored,
        OPERATION,
      );
      expect(saved?.analysisId).toBe(operation.analysisId);
      expect(saved?.observation).toBeNull();
      expect((await listPendingCaptures(store.db)).map(c => c.id)).toEqual([
        CAPTURE,
      ]);
      const recovered = await run(restored);
      expect(recovered).toMatchObject({
        kind: 'scored',
        analysisId: operation.analysisId,
      });
      expect(jest.mocked(extractImportedPoseSequence)).toHaveBeenCalledTimes(2);
      expect(http.reservations.size).toBe(1);
      expect(http.usedBearer(TOKEN_B)).toBe(false);
      expect(http.usedBearer(TOKEN_A_RESTORED)).toBe(true);
      expect(rowsOwnedBy(store, OWNER_B)).toEqual({});
      expect(store.count('local_shot', OWNER_A)).toBe(1);
      expect(
        (await visibleToActiveOwner(store, operation.analysisId)).analysis?.id,
      ).toBe(operation.analysisId);
    },
  );
});

describe('W02-02 owner fencing matrix: settlement stage', () => {
  it('switching to B while the permit reservation is in flight leaves A a recoverable journal and B nothing', async () => {
    const { store, http, request, ref, scope, permits } = legacySetup();
    http.onReserve(async () => {
      switchToB();
    });
    expect(await runCaptureAnalysis(request)).toMatchObject({
      kind: 'unavailable',
      cause: 'account_changed',
    });
    http.onReserve(null);

    expect(rowsOwnedBy(store, OWNER_B)).toEqual({});
    expect(await runJournal.read(store.db, ref)).toMatchObject({
      ownerKey: OWNER_A,
      state: 'release_pending',
    });
    expect(http.usedBearer(TOKEN_B)).toBe(false);
    expect(await visibleToActiveOwner(store)).toMatchObject({
      pendingCaptures: [],
      capture: null,
      shots: [],
    });
    expect(store.count('local_shot', OWNER_A)).toBe(0);
    expect(store.count('outbox', OWNER_A)).toBe(0);

    returnToA();
    await runJournal.recover(store.db, scope, permits);
    expect(http.releases).toBe(1);
    expect(http.calls.at(-1)?.bearer).toBe(`Bearer ${TOKEN_A_RESTORED}`);
    expect((await runJournal.read(store.db, ref))?.state).toBe('released');
    expect((await listPendingCaptures(store.db)).map(c => c.id)).toEqual([
      CAPTURE,
    ]);
    const rerun = await runCaptureAnalysis({
      ...request,
      operationId: undefined,
      ownerContext: captureDataOwnerContext(),
    });
    expect(rerun.kind).toBe('scored');
    expect(rowsOwnedBy(store, OWNER_B)).toEqual({});
    expect(store.count('local_shot', OWNER_A)).toBe(1);
  });

  it.each([
    ['A -> B', false],
    ['A -> B -> A', true],
  ])(
    'switching %s between the durable commit and publication withholds the result from B and A replays it under the same operation',
    async (_label, returnImmediately) => {
      const { store, http, request, ref } = legacySetup();
      let committing = false;
      store.observeStatements(call => {
        if (call.sql.includes("SET state = 'committed'")) committing = true;
        if (committing && call.sql === 'COMMIT') {
          committing = false;
          store.observeStatements(null);
          switchToB();
          if (returnImmediately) returnToA();
        }
      });
      const outcome = await runCaptureAnalysis(request);
      store.observeStatements(null);
      expect(outcome).toMatchObject({
        kind: 'unavailable',
        cause: 'account_changed',
      });
      const journal = await runJournal.read(store.db, ref);
      expect(journal).toMatchObject({ ownerKey: OWNER_A, state: 'committed' });
      expect(store.count('outbox', OWNER_A)).toBe(1);
      expect(store.count('local_shot', OWNER_A)).toBe(1);
      expect(rowsOwnedBy(store, OWNER_B)).toEqual({});
      expect(http.releases).toBe(0);
      expect(http.usedBearer(TOKEN_B)).toBe(false);

      if (!returnImmediately) {
        expect(await visibleToActiveOwner(store, journal!.analysisId)).toEqual({
          pendingCaptures: [],
          capture: null,
          shots: [],
          analysis: null,
        });
        expect(await hasShotSyncReceipt(store.db, journal!.analysisId)).toBe(
          false,
        );
        returnToA();
      }
      const replay = await runCaptureAnalysis({
        ...request,
        ownerContext: captureDataOwnerContext(),
      });
      expect(replay).toMatchObject({
        kind: 'scored',
        analysisId: journal!.analysisId,
        replayed: true,
      });
      expect(http.reservations.size).toBe(1);
      expect(store.count('local_shot', OWNER_A)).toBe(1);
      expect(store.count('outbox', OWNER_A)).toBe(1);
      expect(rowsOwnedBy(store, OWNER_B)).toEqual({});
      expect(
        (await visibleToActiveOwner(store, journal!.analysisId)).analysis?.id,
      ).toBe(journal!.analysisId);
    },
  );
});

describe('W02-02 owner fencing matrix: sync stage', () => {
  it.each([
    ['A -> B', false],
    ['A -> B -> A', true],
  ])(
    'switching %s while the outbox upload is in flight writes no receipt for B and A finishes its own sync later',
    async (_label, returnBeforeResume) => {
      jest.useFakeTimers();
      jest.spyOn(AppState, 'addEventListener').mockReturnValue({
        remove() {},
      });
      const { store, http, request } = legacySetup();
      const scored = await runCaptureAnalysis(request);
      expect(scored.kind).toBe('scored');
      const analysisId = (scored as { analysisId: string }).analysisId;
      expect(store.count('outbox', OWNER_A)).toBe(1);
      expect(store.count('sync_receipt', OWNER_A)).toBe(0);
      await store.db.execute(
        "INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'session.create', ?)",
        [OWNER_B, JSON.stringify({ id: SESSION })],
      );
      (getDb as jest.Mock).mockReturnValue(store.db);

      const entered = deferred<void>();
      const resume = deferred<void>();
      http.onSyncShots(async () => {
        entered.resolve();
        await resume.promise;
      });
      configureSyncRuntime(getApiSession()!);
      const runtimeA = triggerOutboxSync();
      await entered.promise;
      expect(http.calls.at(-1)?.bearer).toBe(`Bearer ${TOKEN_A}`);

      switchToB();
      if (returnBeforeResume) returnToA();
      resume.resolve();
      http.onSyncShots(null);
      await runtimeA;
      await jest.advanceTimersByTimeAsync(0);

      expect(store.count('sync_receipt', OWNER_A)).toBe(0);
      expect(store.count('outbox', OWNER_A)).toBe(1);
      expect(rowsOwnedBy(store, OWNER_B)).toEqual({ outbox: 1 });
      expect(
        http.calls.filter(call => call.url.endsWith('/v1/sessions')),
      ).toHaveLength(0);
      expect(http.usedBearer(TOKEN_B)).toBe(false);
      if (!returnBeforeResume) {
        expect(await visibleToActiveOwner(store, analysisId)).toEqual({
          pendingCaptures: [],
          capture: null,
          shots: [],
          analysis: null,
        });
        expect(await hasShotSyncReceipt(store.db, analysisId)).toBe(false);
        returnToA();
      }

      expect(await hasShotSyncReceipt(store.db, analysisId)).toBe(false);
      expect((await listShots(store.db)).map(shot => shot.id)).toEqual([
        analysisId,
      ]);
      configureSyncRuntime(getApiSession()!);
      await triggerOutboxSync();
      expect(store.count('outbox', OWNER_A)).toBe(0);
      expect(store.count('sync_receipt', OWNER_A)).toBe(1);
      expect(await hasShotSyncReceipt(store.db, analysisId)).toBe(true);
      expect(rowsOwnedBy(store, OWNER_B)).toEqual({ outbox: 1 });
      expect(
        http.calls.filter(call => call.url.endsWith('/v1/shots:sync')),
      ).toHaveLength(2);
      expect(http.calls.at(-1)?.bearer).toBe(`Bearer ${TOKEN_A_RESTORED}`);
      expect(http.releases).toBe(0);
      expect(http.reservations.size).toBe(1);
      expect(http.usedBearer(TOKEN_B)).toBe(false);
    },
  );
});

describe('W02-02 owner fencing matrix: owner epoch primitive', () => {
  it('A -> B -> A produces a new generation so every context captured before the round trip is stale', () => {
    const before = captureDataOwnerContext();
    const snapshotBefore = getDataOwnerSnapshot();
    switchToB();
    expect(isDataOwnerContextCurrent(before)).toBe(false);
    returnToA();
    expect(getDataOwnerSnapshot()).not.toBe(snapshotBefore);
    expect(getDataOwnerSnapshot().ownerKey).toBe(OWNER_A);
    expect(getDataOwnerSnapshot().generation).toBeGreaterThan(
      before.generation,
    );
    expect(isDataOwnerContextCurrent(before)).toBe(false);
    expect(() => {
      const db = forDataOwner(createSqliteTestDb().db, before);
      void db;
    }).toThrow(DataOwnerChangedError);
    expect(isDataOwnerContextCurrent(captureDataOwnerContext())).toBe(true);
  });
});

describe('W02-02 owner fencing matrix: owner-change delivery', () => {
  it('switching away from A while extraction is pending reaches every owner fence even when an earlier subscriber throws, and A resumes the same operation', async () => {
    const failure = new Error('owner subscriber failed');
    const faulty = jest.fn(() => {
      throw failure;
    });
    const stopFaulty = subscribeToDataOwner(faulty);
    let stopFence = () => {};
    try {
      const { store, http, owner, operation, run, pose } =
        await originalSetup();
      // A native operation fenced exactly like capture.ts fences the byte
      // comparison: only through the owner subscription.
      const nativeOperation = new AbortController();
      stopFence = subscribeToDataOwner(() => {
        if (!isDataOwnerContextCurrent(owner.ownerContext))
          nativeOperation.abort();
      });
      const entered = deferred<void>();
      const resume = deferred<{
        poseSequence: typeof pose;
        framesWithPose: number;
        framesTotal: number;
      }>();
      jest.mocked(extractImportedPoseSequence).mockImplementationOnce(() => {
        entered.resolve();
        return resume.promise;
      });
      const pending = run(owner);
      await entered.promise;
      const before = rowsOwnedBy(store, OWNER_A);
      expect(before).toEqual({
        local_capture: 1,
        analysis_logical_operations: 1,
      });
      expect(nativeOperation.signal.aborted).toBe(false);

      clearSyncRuntime();
      expect(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER)).toThrow(failure);
      expect(faulty).toHaveBeenCalledTimes(1);
      expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
      expect(isDataOwnerContextCurrent(owner.ownerContext)).toBe(false);
      expect(nativeOperation.signal.aborted).toBe(true);
      expect(owner.signal.aborted).toBe(true);
      stopFaulty();
      stopFence();
      clearApiSession();
      signIn(OWNER_B, TOKEN_B);

      const asB = execution();
      expect(
        await originalAnalysisOperations.read(store.db, asB, OPERATION),
      ).toBeNull();
      expect(await visibleToActiveOwner(store)).toMatchObject({
        pendingCaptures: [],
        capture: null,
        shots: [],
      });
      resume.resolve({
        poseSequence: pose,
        framesWithPose: pose.frameCount,
        framesTotal: pose.frameCount,
      });
      expect(await pending).toMatchObject({
        kind: 'unavailable',
        cause: 'account_changed',
      });
      expect(rowsOwnedBy(store, OWNER_B)).toEqual({});
      expect(rowsOwnedBy(store, OWNER_A)).toEqual(before);
      expect(http.fetchPort).not.toHaveBeenCalled();

      returnToA();
      const restored = execution();
      const saved = await originalAnalysisOperations.read(
        store.db,
        restored,
        OPERATION,
      );
      expect(saved?.analysisId).toBe(operation.analysisId);
      expect(await run(restored)).toMatchObject({
        kind: 'scored',
        analysisId: operation.analysisId,
      });
      expect(http.reservations.size).toBe(1);
      expect(http.usedBearer(TOKEN_B)).toBe(false);
      expect(http.usedBearer(TOKEN_A_RESTORED)).toBe(true);
      expect(rowsOwnedBy(store, OWNER_B)).toEqual({});
      expect(store.count('local_shot', OWNER_A)).toBe(1);
    } finally {
      stopFaulty();
      stopFence();
    }
  });

  it('delivers one switch to every subscriber in registration order, applies it fully, and surfaces the first subscriber failure once', () => {
    const seen: string[] = [];
    const observe = (name: string) => () => {
      seen.push(`${name}:${getDataOwnerSnapshot().ownerKey}`);
    };
    const stops = [
      subscribeToDataOwner(() => {
        observe('first')();
        throw new Error('first subscriber failed');
      }),
      subscribeToDataOwner(() => {
        observe('second')();
        throw new Error('second subscriber failed');
      }),
      subscribeToDataOwner(observe('third')),
    ];
    try {
      const before = captureDataOwnerContext();
      expect(() => setActiveDataOwner(OWNER_B)).toThrow(
        'first subscriber failed',
      );
      expect(seen).toEqual([
        `first:${OWNER_B}`,
        `second:${OWNER_B}`,
        `third:${OWNER_B}`,
      ]);
      expect(getDataOwnerSnapshot()).toEqual({
        ownerKey: OWNER_B,
        generation: before.generation + 1,
      });
      expect(isDataOwnerContextCurrent(before)).toBe(false);
      expect(isDataOwnerContextCurrent(captureDataOwnerContext())).toBe(true);

      seen.length = 0;
      expect(() => setActiveDataOwner(OWNER_B)).not.toThrow();
      expect(seen).toEqual([]);
      expect(getDataOwnerSnapshot().generation).toBe(before.generation + 1);
    } finally {
      for (const stop of stops) stop();
    }
  });
});
