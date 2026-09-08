/**
 * W02-02 adversarial matrix against candidate 7c06c0b6 (owner-change delivery
 * fix in accountScope.ts). Every probe is a boundary the shipped matrix does
 * not exercise: re-entrant and self-modifying subscriber sets, duplicate
 * registrations, an owner switch while the local permit record is being
 * acknowledged, transport failures during the restored owner's recovery,
 * another account replaying the same operation identity, a crash with a
 * reserved permit followed by a different account's restart, a switch between
 * two receipt transactions of one accepted batch, corrupt journal identity,
 * and invalid owner keys. The invariants asserted are the package's:
 *   - no owner-scoped row is written under the other owner;
 *   - no bearer of one owner is ever sent for the other owner's work;
 *   - a permit is settled exactly once, under its own owner, never charged
 *     for a result that was withheld;
 *   - the original owner recovers through the SAME operation identity.
 */
import { AppState } from 'react-native';
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import {
  readCaptureArtifact,
  verifyCapturedClipCurrentBytes,
  type CapturedClip,
} from '../src/camera/capture';
import {
  runCaptureAnalysis,
  type RunCaptureAnalysisRequest,
} from '../src/analysis/runCaptureAnalysis';
import { OriginalAnalysisExecution } from '../src/analysis/originalAnalysisOperations';
import { runJournal, RunJournalError } from '../src/analysis/runJournal';
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
  listPendingCaptures,
  listShots,
} from '../src/data/repository';
import {
  clearSyncRuntime,
  configureSyncRuntime,
  triggerOutboxSync,
} from '../src/data/syncRuntime';
import {
  captureDataOwnerContext,
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
const CAPTURE_2 = '33333333-3333-4333-8333-333333333334';
const OPERATION = '44444444-4444-4444-8444-444444444444';
const OPERATION_2 = '44444444-4444-4444-8444-444444444445';
const API_ORIGIN = 'https://api.example.test/functions/v1/api';
const TOKEN_A = 'owner-a-token';
const TOKEN_A_RESTORED = 'owner-a-restored-token';
const TOKEN_B = 'owner-b-token';
const BEARER_OWNER: Record<string, string> = {
  [`Bearer ${TOKEN_A}`]: OWNER_A,
  [`Bearer ${TOKEN_A_RESTORED}`]: OWNER_A,
  [`Bearer ${TOKEN_B}`]: OWNER_B,
};
const originalFetch = globalThis.fetch;
const leases: OriginalAnalysisExecution[] = [];

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

function fixture(uri = 'file:///private/captures/owned.mov') {
  const { sequence, window } = generateSwingSequence();
  const sidecar = serializePoseSequence(sequence);
  const fileName = uri.slice(uri.lastIndexOf('/') + 1);
  const clip: CapturedClip = {
    uri,
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
      videoFileName: fileName,
      byteSize: 25,
      sha256: sha256Hex(`synthetic test movie bytes ${fileName}`),
    },
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: `${uri}.pose.json`,
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

/**
 * Fake edge API that behaves like the real one on ownership: a reservation is
 * looked up in the journal of the OWNER THE BEARER BELONGS TO, and every call
 * is recorded with the owner its bearer resolves to. `failFinalize` queues
 * transport failures for the next finalize calls (5xx / 429 + Retry-After).
 */
function server(store: Store) {
  const reservations = new Map<
    string,
    { id: string; owner: string; outcome: string | null }
  >();
  const calls: Array<{
    url: string;
    bearer: string | undefined;
    owner: string | null;
    body: Record<string, unknown>;
  }> = [];
  const finalizeFailures: number[] = [];
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
      const owner = bearer ? (BEARER_OWNER[bearer] ?? null) : null;
      calls.push({ url, body, bearer, owner });
      if (!owner) return response(401, { error: { code: 'auth.required' } });
      if (url.endsWith('/v1/analysis-permits')) {
        const key = String(body.idempotencyKey);
        const journal = store.native
          .prepare(
            `SELECT owner_key, state FROM analysis_run_journal WHERE reservation_key = ?
             UNION ALL
             SELECT owner_key, state FROM analysis_execution_attempts WHERE reservation_key = ?`,
          )
          .get(key, key);
        expect(journal?.owner_key).toBe(owner);
        expect(journal?.state).toMatch(/reserve_pending|release_pending/);
        let permit = reservations.get(key);
        if (!permit) {
          permit = {
            id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(reservations.size + 1).padStart(12, '0')}`,
            owner,
            outcome: null,
          };
          reservations.set(key, permit);
        }
        expect(permit.owner).toBe(owner);
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
        const failure = finalizeFailures.shift();
        if (failure !== undefined)
          return response(failure, { error: { code: 'transport.failure' } });
        const permit = [...reservations.values()].find(value =>
          url.includes(value.id),
        );
        if (!permit)
          return response(404, { error: { code: 'access.permit_not_found' } });
        expect(permit.owner).toBe(owner);
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
          expect(permit?.owner).toBe(owner);
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
    failFinalize(...statuses: number[]) {
      finalizeFailures.push(...statuses);
    },
    usedBearer(token: string) {
      return calls.some(call => call.bearer === `Bearer ${token}`);
    },
    callsFor(owner: string) {
      return calls.filter(call => call.owner === owner);
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

function rowsOwnedBy(store: Store, owner: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of ownerScopedTables(store)) {
    const n = store.count(table, owner);
    if (n > 0) counts[table] = n;
  }
  return counts;
}

function journalRow(store: Store, owner: string, operationId: string) {
  return store.native
    .prepare(
      'SELECT * FROM analysis_run_journal WHERE owner_key = ? AND operation_id = ?',
    )
    .get(owner, operationId);
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
  const permitsFor = (owner: string) => ({
    ownerKey: owner,
    apiOrigin: API_ORIGIN,
    ...createAnalysisPermitClient({
      baseUrl: API_ORIGIN,
      get token() {
        const session = getApiSession();
        return session?.canonicalAppUserId === owner
          ? session.bearerToken
          : null;
      },
    }),
  });
  return {
    store,
    http,
    request,
    scope,
    ref,
    permits: permitsFor(OWNER_A),
    permitsFor,
    clip,
    sidecar,
  };
}

function runtimeSetup() {
  jest.useFakeTimers();
  jest.spyOn(AppState, 'addEventListener').mockReturnValue({
    remove() {},
  });
  const state = legacySetup();
  (getDb as jest.Mock).mockReturnValue(state.store.db);
  return state;
}

beforeEach(() => {
  signIn(OWNER_A, TOKEN_A);
  jest.mocked(verifyCapturedClipCurrentBytes).mockReset();
  jest.mocked(readCaptureArtifact).mockReset();
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

describe('ATK-1 reentrancy: a subscriber switches the owner again during delivery', () => {
  it('settles on the last owner, bumps the generation once per switch, and every fence observes the settled owner', () => {
    const lease = execution();
    const nativeOperation = new AbortController();
    const observed: Array<[string, string]> = [];
    let reentered = 0;
    const stops = [
      subscribeToDataOwner(() =>
        observed.push(['first', getActiveDataOwner()]),
      ),
      subscribeToDataOwner(() => {
        // Sign-out handler that immediately installs the next account.
        if (getActiveDataOwner() === SIGNED_OUT_DATA_OWNER && reentered === 0) {
          reentered += 1;
          setActiveDataOwner(OWNER_B);
        }
      }),
      subscribeToDataOwner(() => {
        if (!isDataOwnerContextCurrent(lease.ownerContext))
          nativeOperation.abort();
      }),
      subscribeToDataOwner(() => observed.push(['last', getActiveDataOwner()])),
    ];
    try {
      const before = captureDataOwnerContext();
      clearApiSession();
      expect(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER)).not.toThrow();
      expect(reentered).toBe(1);
      expect(getActiveDataOwner()).toBe(OWNER_B);
      expect(getDataOwnerSnapshot()).toEqual({
        ownerKey: OWNER_B,
        generation: before.generation + 2,
      });
      // The final observation of every recording subscriber is the settled
      // owner, never the transient one.
      const lastByName = new Map<string, string>();
      for (const [name, owner] of observed) lastByName.set(name, owner);
      expect(lastByName.get('first')).toBe(OWNER_B);
      expect(lastByName.get('last')).toBe(OWNER_B);
      expect(observed.length).toBeLessThanOrEqual(8);
      expect(lease.signal.aborted).toBe(true);
      expect(nativeOperation.signal.aborted).toBe(true);
      expect(isDataOwnerContextCurrent(before)).toBe(false);
      expect(isDataOwnerContextCurrent(captureDataOwnerContext())).toBe(true);
    } finally {
      for (const stop of stops) stop();
    }
  });
});

describe('ATK-2 reentrancy: subscribers register and unregister other fences during delivery', () => {
  it('a fence disposed by an earlier subscriber is still invalidated; a fence registered during delivery sees a current context; a self-removing fence is delivered exactly once', () => {
    const seen: string[] = [];
    let stopLater = () => {};
    let stopRegistered = () => {};
    const registeredDuring = jest.fn(() => {
      const context = captureDataOwnerContext();
      seen.push(`registered:${context.ownerKey}`);
      expect(isDataOwnerContextCurrent(context)).toBe(true);
    });
    const stopSelf = subscribeToDataOwner(function selfRemoving() {
      seen.push('self');
      stopSelf();
    });
    const stopAbandon = subscribeToDataOwner(() => {
      seen.push('abandon');
      // AnalyzeScreen.abandon(): disposes the execution registered AFTER it
      // and (through React) can mount a fresh subscriber for the new owner.
      stopLater();
      stopRegistered = subscribeToDataOwner(registeredDuring);
    });
    const later = jest.fn(() => seen.push('later'));
    stopLater = subscribeToDataOwner(later);
    const lease = execution();
    try {
      clearApiSession();
      setActiveDataOwner(OWNER_B);
      expect(seen.filter(name => name === 'self')).toHaveLength(1);
      expect(seen).toContain('abandon');
      expect(later).not.toHaveBeenCalled();
      expect(registeredDuring.mock.calls.length).toBeLessThanOrEqual(1);
      expect(lease.signal.aborted).toBe(true);
      expect(isDataOwnerContextCurrent(lease.ownerContext)).toBe(false);

      seen.length = 0;
      registeredDuring.mockClear();
      setActiveDataOwner(OWNER_A);
      expect(seen).not.toContain('self');
      expect(later).not.toHaveBeenCalled();
      expect(registeredDuring).toHaveBeenCalledTimes(1);
      expect(getActiveDataOwner()).toBe(OWNER_A);
    } finally {
      stopSelf();
      stopAbandon();
      stopLater();
      stopRegistered();
    }
  });
});

describe('ATK-3 duplicate identities: one fence function registered twice', () => {
  it('unsubscribing one registration must not detach the other registration of the same fence', () => {
    const fence = jest.fn();
    const stopFirst = subscribeToDataOwner(fence);
    const stopSecond = subscribeToDataOwner(fence);
    try {
      stopFirst();
      clearApiSession();
      setActiveDataOwner(OWNER_B);
      expect(fence).toHaveBeenCalledTimes(1);
    } finally {
      stopFirst();
      stopSecond();
    }
  });
});

describe('ATK-4 settlement: switch while the local permit record is acknowledged', () => {
  it('permit reserved server-side, switch during the local reserved write: A keeps a recoverable release_pending journal with the permit id, nothing is written for B, and A settles it once', async () => {
    const { store, http, request, ref, scope, permits } = legacySetup();
    store.observeStatements(call => {
      if (call.sql.includes('SET permit_id = ?')) {
        store.observeStatements(null);
        switchToB();
      }
    });
    expect(await runCaptureAnalysis(request)).toMatchObject({
      kind: 'unavailable',
      cause: 'account_changed',
    });
    store.observeStatements(null);

    expect(rowsOwnedBy(store, OWNER_B)).toEqual({});
    expect(rowsOwnedBy(store, OWNER_A)).toEqual({
      local_capture: 1,
      analysis_run_journal: 1,
    });
    const journal = await runJournal.read(store.db, ref);
    expect(journal).toMatchObject({
      ownerKey: OWNER_A,
      state: 'release_pending',
      releaseOutcome: 'cancelled',
    });
    expect(journal?.permitId).not.toBeNull();
    expect(http.reservations.size).toBe(1);
    expect(http.releases).toBe(0);
    expect(http.callsFor(OWNER_B)).toEqual([]);
    expect(http.calls.filter(call => call.owner === null)).toEqual([]);
    expect(http.usedBearer(TOKEN_B)).toBe(false);
    expect(await visibleToActiveOwner(store)).toMatchObject({
      pendingCaptures: [],
      capture: null,
      shots: [],
    });

    returnToA();
    await runJournal.recover(store.db, scope, permits);
    expect(http.releases).toBe(1);
    expect([...http.reservations.values()][0]).toMatchObject({
      owner: OWNER_A,
      outcome: 'cancelled',
    });
    expect(http.calls.at(-1)?.bearer).toBe(`Bearer ${TOKEN_A_RESTORED}`);
    expect((await runJournal.read(store.db, ref))?.state).toBe('released');
    expect(store.count('local_shot', OWNER_A)).toBe(0);
    expect(rowsOwnedBy(store, OWNER_B)).toEqual({});
  });
});

describe('ATK-5 network failure during the restored owner recovery', () => {
  it('5xx then 429 on finalize keep the journal pending without a second reservation; the eventual release settles the permit exactly once as cancelled', async () => {
    const { store, http, request, ref, scope, permits } = legacySetup();
    store.observeStatements(call => {
      if (call.sql.includes('SET permit_id = ?')) {
        store.observeStatements(null);
        switchToB();
      }
    });
    expect(await runCaptureAnalysis(request)).toMatchObject({
      kind: 'unavailable',
      cause: 'account_changed',
    });
    store.observeStatements(null);
    returnToA();

    http.failFinalize(503, 429);
    await runJournal.recover(store.db, scope, permits);
    expect((await runJournal.read(store.db, ref))?.state).toBe(
      'release_pending',
    );
    await runJournal.recover(store.db, scope, permits);
    expect((await runJournal.read(store.db, ref))?.state).toBe(
      'release_pending',
    );
    expect(http.releases).toBe(0);
    await runJournal.recover(store.db, scope, permits);
    expect((await runJournal.read(store.db, ref))?.state).toBe('released');
    expect(http.releases).toBe(1);
    expect(http.reservations.size).toBe(1);
    expect([...http.reservations.values()][0]?.outcome).toBe('cancelled');
    expect(
      http.calls.filter(call => call.url.endsWith('/finalize')),
    ).toHaveLength(3);
    expect(http.usedBearer(TOKEN_B)).toBe(false);
    expect(rowsOwnedBy(store, OWNER_B)).toEqual({});
    expect(store.count('local_shot', OWNER_A)).toBe(0);

    // A can score the capture again under a NEW operation; the released one
    // is never revived.
    const rerun = await runCaptureAnalysis({
      ...request,
      operationId: undefined,
      ownerContext: captureDataOwnerContext(),
    });
    expect(rerun.kind).toBe('scored');
    expect(http.reservations.size).toBe(2);
    expect((await runJournal.read(store.db, ref))?.state).toBe('released');
  });
});

describe('ATK-6 replay / duplicate identity: B replays A operation id', () => {
  it('B without the capture: no row for B, no network, A journal untouched', async () => {
    const { store, http, request } = legacySetup();
    const scored = await runCaptureAnalysis(request);
    expect(scored.kind).toBe('scored');
    const before = journalRow(store, OWNER_A, OPERATION);
    const callsBefore = http.calls.length;

    switchToB();
    const asB = runCaptureAnalysis({
      ...request,
      ownerContext: captureDataOwnerContext(),
    });
    const settled = await asB.then(
      outcome => ({ outcome, error: null as unknown }),
      (error: unknown) => ({ outcome: null, error }),
    );
    if (settled.outcome) expect(settled.outcome.kind).toBe('unavailable');
    else expect(settled.error).toBeInstanceOf(RunJournalError);
    expect(rowsOwnedBy(store, OWNER_B)).toEqual({});
    expect(http.calls.length).toBe(callsBefore);
    expect(journalRow(store, OWNER_A, OPERATION)).toEqual(before);
    expect(await visibleToActiveOwner(store)).toMatchObject({
      pendingCaptures: [],
      capture: null,
      shots: [],
    });
  });

  it('B with its own capture of the same id: B gets its own permit under its own bearer, A journal is untouched, and A replays its own result', async () => {
    const { store, http, request, clip } = legacySetup();
    const scoredA = await runCaptureAnalysis(request);
    expect(scoredA.kind).toBe('scored');
    const analysisA = (scoredA as { analysisId: string }).analysisId;
    const beforeA = journalRow(store, OWNER_A, OPERATION);

    switchToB();
    seedSqliteCapture(store.db, OWNER_B, CAPTURE, clip);
    const scoredB = await runCaptureAnalysis({
      ...request,
      ownerContext: captureDataOwnerContext(),
    });
    expect(scoredB.kind).toBe('scored');
    const analysisB = (scoredB as { analysisId: string }).analysisId;
    expect(analysisB).not.toBe(analysisA);
    expect(journalRow(store, OWNER_A, OPERATION)).toEqual(beforeA);
    const rowB = journalRow(store, OWNER_B, OPERATION);
    expect(rowB).toMatchObject({ owner_key: OWNER_B, state: 'committed' });
    expect(rowB?.reservation_key).not.toBe(beforeA?.reservation_key);
    expect(rowB?.permit_id).not.toBe(beforeA?.permit_id);
    expect(http.reservations.size).toBe(2);
    expect(
      [...http.reservations.values()].map(permit => permit.owner).sort(),
    ).toEqual([OWNER_A, OWNER_B]);
    expect(http.callsFor(OWNER_B).every(call => call.owner === OWNER_B)).toBe(
      true,
    );
    expect((await listShots(store.db)).map(shot => shot.id)).toEqual([
      analysisB,
    ]);
    expect(await getAnalysis(store.db, analysisA)).toBeNull();

    returnToA();
    const replay = await runCaptureAnalysis({
      ...request,
      ownerContext: captureDataOwnerContext(),
    });
    expect(replay).toMatchObject({
      kind: 'scored',
      analysisId: analysisA,
      replayed: true,
    });
    expect(http.reservations.size).toBe(2);
    expect((await listShots(store.db)).map(shot => shot.id)).toEqual([
      analysisA,
    ]);
    expect(await getAnalysis(store.db, analysisB)).toBeNull();
    expect(store.count('local_shot', OWNER_A)).toBe(1);
    expect(store.count('local_shot', OWNER_B)).toBe(1);
  });
});

describe('ATK-7 process death with a reserved permit, restart under another account', () => {
  it('B sync runtime never touches A reserved journal; A restart releases it once as cancelled with A bearer', async () => {
    const { store, http, ref, permits } = runtimeSetup();
    // Crash after the permit was reserved and recorded, before inference
    // committed anything: leave the journal exactly as the process died.
    const identity = {
      ...ref,
      ownerGeneration: captureDataOwnerContext().generation,
      captureId: CAPTURE,
      analysisId: '88888888-8888-4888-8888-888888888888',
      reservationKey: '99999999-9999-4999-8999-999999999999',
      requestHash: sha256Hex('request'),
    };
    const begun = await runJournal.begin(store.db, identity);
    expect(begun.created).toBe(true);
    const reserved = await permits.reserve(identity.reservationKey);
    await runJournal.reserved(store.db, identity, reserved.permit.id);
    expect((await runJournal.read(store.db, ref))?.state).toBe('reserved');
    expect(http.releases).toBe(0);

    // Process restart: nothing in memory survives; B signs in first.
    switchToB();
    configureSyncRuntime(getApiSession()!);
    await triggerOutboxSync();
    await jest.advanceTimersByTimeAsync(0);
    expect((await runJournal.read(store.db, ref))?.state).toBe('reserved');
    expect(http.callsFor(OWNER_B)).toEqual([]);
    expect(http.calls.filter(call => call.url.endsWith('/finalize'))).toEqual(
      [],
    );
    expect(rowsOwnedBy(store, OWNER_B)).toEqual({});

    returnToA();
    configureSyncRuntime(getApiSession()!);
    await triggerOutboxSync();
    await jest.advanceTimersByTimeAsync(0);
    expect((await runJournal.read(store.db, ref))?.state).toBe('released');
    expect(http.releases).toBe(1);
    expect([...http.reservations.values()][0]).toMatchObject({
      owner: OWNER_A,
      outcome: 'cancelled',
    });
    expect(http.calls.at(-1)?.bearer).toBe(`Bearer ${TOKEN_A_RESTORED}`);
    expect(http.usedBearer(TOKEN_B)).toBe(false);
    expect(store.count('local_shot', OWNER_A)).toBe(0);
  });
});

describe('ATK-8 sync: switch between two receipt transactions of one accepted batch', () => {
  it('the first accepted receipt stays under A, the second row stays in the outbox, nothing is written for B, and A finishes the batch later without a second charge', async () => {
    const { store, http, request, sidecar } = runtimeSetup();
    const secondClip = fixture('file:///private/captures/second.mov');
    seedSqliteCapture(store.db, OWNER_A, CAPTURE_2, secondClip.clip);
    jest
      .mocked(readCaptureArtifact)
      .mockImplementation(async uri =>
        uri.includes('second.mov') ? secondClip.sidecar : sidecar,
      );
    const first = await runCaptureAnalysis(request);
    const second = await runCaptureAnalysis({
      ...request,
      operationId: OPERATION_2,
      captureId: CAPTURE_2,
      clip: secondClip.clip,
      ownerContext: captureDataOwnerContext(),
    });
    expect(first.kind).toBe('scored');
    expect(second.kind).toBe('scored');
    expect(store.count('outbox', OWNER_A)).toBe(2);
    expect(store.count('sync_receipt', OWNER_A)).toBe(0);

    let receiptCommits = 0;
    let receiptOpen = false;
    store.observeStatements(call => {
      if (call.sql.includes('INSERT OR REPLACE INTO sync_receipt'))
        receiptOpen = true;
      if (receiptOpen && call.sql === 'COMMIT') {
        receiptOpen = false;
        receiptCommits += 1;
        if (receiptCommits === 1) {
          store.observeStatements(null);
          switchToB();
        }
      }
    });
    configureSyncRuntime(getApiSession()!);
    await triggerOutboxSync();
    await jest.advanceTimersByTimeAsync(0);
    store.observeStatements(null);

    expect(store.count('sync_receipt', OWNER_A)).toBe(1);
    expect(store.count('outbox', OWNER_A)).toBe(1);
    expect(rowsOwnedBy(store, OWNER_B)).toEqual({});
    expect(http.callsFor(OWNER_B)).toEqual([]);
    expect(
      http.calls.filter(call => call.url.endsWith('/v1/shots:sync')),
    ).toHaveLength(1);
    expect(await visibleToActiveOwner(store)).toMatchObject({
      pendingCaptures: [],
      capture: null,
      shots: [],
    });

    returnToA();
    configureSyncRuntime(getApiSession()!);
    await triggerOutboxSync();
    await jest.advanceTimersByTimeAsync(0);
    expect(store.count('sync_receipt', OWNER_A)).toBe(2);
    expect(store.count('outbox', OWNER_A)).toBe(0);
    expect(
      http.calls.filter(call => call.url.endsWith('/v1/shots:sync')),
    ).toHaveLength(2);
    expect(http.calls.at(-1)?.bearer).toBe(`Bearer ${TOKEN_A_RESTORED}`);
    expect(http.releases).toBe(0);
    expect(http.reservations.size).toBe(2);
    expect(
      [...http.reservations.values()].every(
        permit => permit.owner === OWNER_A && permit.outcome === 'scored',
      ),
    ).toBe(true);
    expect(rowsOwnedBy(store, OWNER_B)).toEqual({});
  });
});

describe('ATK-9 corrupt / partial persisted state around an owner switch', () => {
  it('the journal identity columns are immutable at the storage layer: a corrupting write is refused, the committed row survives unchanged', () => {
    const { store } = legacySetup();
    const identity = {
      ownerKey: OWNER_A,
      apiOrigin: API_ORIGIN,
      operationId: OPERATION,
      ownerGeneration: captureDataOwnerContext().generation,
      captureId: CAPTURE,
      analysisId: '88888888-8888-4888-8888-888888888888',
      reservationKey: '99999999-9999-4999-8999-999999999999',
      requestHash: sha256Hex('request'),
    };
    return runJournal.begin(store.db, identity).then(() => {
      const before = journalRow(store, OWNER_A, OPERATION);
      for (const damage of [
        'owner_generation = -1',
        "request_hash = 'not-a-hash'",
        `owner_key = '${OWNER_B}'`,
        "state = 'committed'",
      ]) {
        expect(() =>
          store.native
            .prepare(
              `UPDATE analysis_run_journal SET ${damage} WHERE owner_key = ? AND operation_id = ?`,
            )
            .run(OWNER_A, OPERATION),
        ).toThrow('Invalid analysis run journal transition');
      }
      expect(journalRow(store, OWNER_A, OPERATION)).toEqual(before);
    });
  });

  it('a committed A journal whose result rows vanished while B was active is never replayed as a fabricated result, never charged again, and never visible to B', async () => {
    const { store, http, request, ref, scope, permits } = legacySetup();
    const scored = await runCaptureAnalysis(request);
    expect(scored.kind).toBe('scored');
    const analysisId = (scored as { analysisId: string }).analysisId;
    const before = journalRow(store, OWNER_A, OPERATION);
    switchToB();
    for (const table of ['local_shot', 'local_analysis_record', 'outbox']) {
      store.native
        .prepare(`DELETE FROM ${table} WHERE owner_key = ?`)
        .run(OWNER_A);
    }
    expect(await visibleToActiveOwner(store, analysisId)).toEqual({
      pendingCaptures: [],
      capture: null,
      shots: [],
      analysis: null,
    });
    expect(rowsOwnedBy(store, OWNER_B)).toEqual({});

    returnToA();
    const callsBefore = http.calls.length;
    expect((await runJournal.read(store.db, ref))?.state).toBe('committed');
    const replay = runCaptureAnalysis({
      ...request,
      ownerContext: captureDataOwnerContext(),
    });
    const settled = await replay.then(
      outcome => ({ outcome, error: null as unknown }),
      (error: unknown) => ({ outcome: null, error }),
    );
    if (settled.outcome) {
      expect(settled.outcome.kind).not.toBe('scored');
      expect(settled.outcome.kind).not.toBe('low_confidence');
    } else {
      expect(settled.error).toBeInstanceOf(Error);
    }
    await runJournal.recover(store.db, scope, permits);
    expect(http.calls.length).toBe(callsBefore);
    expect(http.releases).toBe(0);
    expect(http.reservations.size).toBe(1);
    expect(journalRow(store, OWNER_A, OPERATION)).toEqual(before);
    expect(store.count('local_shot', OWNER_A)).toBe(0);
    expect(rowsOwnedBy(store, OWNER_B)).toEqual({});
  });
});

describe('ATK-10 boundary values: invalid owner keys never notify or move the epoch', () => {
  it.each([
    ['empty', ''],
    ['whitespace uuid', ` ${OWNER_B} `],
    ['upper-case guest sentinel', 'DEVICE-GUEST'],
    ['version-0 uuid', '22222222-2222-0222-8222-222222222222'],
    ['invalid variant uuid', '22222222-2222-4222-c222-222222222222'],
    ['nil uuid', '00000000-0000-0000-0000-000000000000'],
  ])('%s owner is rejected before any fence observes it', (_label, owner) => {
    const fence = jest.fn();
    const stop = subscribeToDataOwner(fence);
    try {
      const before = getDataOwnerSnapshot();
      expect(() => setActiveDataOwner(owner)).toThrow(
        'Invalid local data owner.',
      );
      expect(fence).not.toHaveBeenCalled();
      expect(getDataOwnerSnapshot()).toBe(before);
      expect(getActiveDataOwner()).toBe(OWNER_A);
    } finally {
      stop();
    }
  });

  it('the same owner in upper case is the same owner: no generation bump, no delivery, and the lease stays current', () => {
    const lease = execution();
    const fence = jest.fn();
    const stop = subscribeToDataOwner(fence);
    try {
      const before = getDataOwnerSnapshot();
      setActiveDataOwner(OWNER_A.toUpperCase());
      expect(fence).not.toHaveBeenCalled();
      expect(getDataOwnerSnapshot()).toBe(before);
      expect(() => lease.assertCurrent()).not.toThrow();
    } finally {
      stop();
    }
  });
});
