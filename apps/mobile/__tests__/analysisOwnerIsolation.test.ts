import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { FusionProviders } from '@pickle/analysis-pipeline';
import type { CapturedClip } from '../src/camera/capture';
import type { LocalDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import { purgeOwnerData } from '../src/data/repository';
import {
  runCaptureAnalysis,
  type RunCaptureAnalysisRequest,
} from '../src/analysis/runCaptureAnalysis';
import * as providerFactory from '../src/vision/providers';
import {
  planPracticeSet,
  practiceSetKeyForOwner,
  type PracticeSetPlan,
} from '../src/analysis/practiceSet';

jest.mock('../src/camera/capture', () => ({
  ...jest.requireActual('../src/camera/capture'),
  readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
}));

const ownerA = '11111111-1111-4111-8111-111111111111';
const ownerB = '22222222-2222-4222-8222-222222222222';
const captureId = 'capture-owner-a';
const tokenA = 'memory-only-token-a';
let mockReadArtifact: (uri: string) => Promise<string>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function gate() {
  const entered = deferred<void>();
  const released = deferred<void>();
  return {
    entered: entered.promise,
    resume: () => released.resolve(),
    async wait() {
      entered.resolve();
      await released.promise;
    },
  };
}

interface DbCall {
  sql: string;
  params: unknown[];
}

interface StoredRow {
  owner: string;
  payload: string;
}

function fakeDb() {
  const calls: DbCall[] = [];
  const state = {
    captures: new Map([
      [`${ownerA}:${captureId}`, 'awaiting_model'],
      [`${ownerB}:${captureId}`, 'awaiting_model'],
    ]),
    records: new Map<string, StoredRow>(),
    shots: new Map<string, StoredRow>(),
    sessions: new Map<string, StoredRow>(),
    kv: new Map<string, string>(),
    outbox: [] as Array<StoredRow & { kind: string }>,
  };
  let snapshot: typeof state | null = null;
  const controls: {
    beforeExecute: (call: DbCall) => Promise<void>;
    failNext: ((call: DbCall) => boolean) | null;
    closed: boolean;
  } = { beforeExecute: async () => {}, failNext: null, closed: false };
  const db: LocalDb = {
    async execute(sql, params = []) {
      const call = { sql, params: [...params] };
      calls.push(call);
      if (controls.closed) throw new Error('database is closed');
      await controls.beforeExecute(call);
      if (controls.failNext?.(call)) {
        controls.failNext = null;
        throw new Error('injected storage failure');
      }
      if (sql === 'BEGIN IMMEDIATE') {
        if (snapshot) throw new Error('nested transaction');
        snapshot = {
          captures: new Map(state.captures),
          records: new Map(state.records),
          shots: new Map(state.shots),
          sessions: new Map(state.sessions),
          kv: new Map(state.kv),
          outbox: [...state.outbox],
        };
      } else if (sql === 'COMMIT') {
        if (!snapshot) throw new Error('commit without transaction');
        snapshot = null;
      } else if (sql === 'ROLLBACK') {
        if (!snapshot) throw new Error('rollback without transaction');
        Object.assign(state, snapshot);
        snapshot = null;
      } else if (sql.startsWith('SELECT value FROM kv')) {
        const value = state.kv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      } else if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        state.kv.set(String(params[0]), String(params[1]));
      } else if (sql.startsWith('INSERT OR REPLACE INTO local_session')) {
        state.sessions.set(`${params[0]}:${params[1]}`, {
          owner: String(params[0]),
          payload: JSON.stringify({
            id: params[1],
            mode: params[2],
            shotType: params[3],
            focusCheckpoint: params[4],
            startedAt: params[5],
          }),
        });
      } else if (sql.startsWith('INSERT INTO local_analysis_record')) {
        state.records.set(`${params[0]}:${params[1]}`, {
          owner: String(params[0]),
          payload: String(params[6]),
        });
      } else if (sql.includes('INSERT OR REPLACE INTO local_shot')) {
        state.shots.set(`${params[0]}:${params[1]}`, {
          owner: String(params[0]),
          payload: String(params[9]),
        });
      } else if (sql.includes('INSERT INTO outbox')) {
        state.outbox.push({
          owner: String(params[0]),
          kind: /'([a-z.]+)'/.exec(sql)?.[1] ?? 'unknown',
          payload: String(params[1]),
        });
      } else if (sql.includes("SET status = 'analyzed'")) {
        const key = `${params[0]}:${params[1]}`;
        if (state.captures.has(key)) state.captures.set(key, 'analyzed');
      } else if (sql.startsWith('DELETE FROM')) {
        const owner = String(params[0]);
        if (sql.includes('local_capture')) {
          for (const key of state.captures.keys()) {
            if (key.startsWith(`${owner}:`)) state.captures.delete(key);
          }
        }
        for (const [table, rows] of [
          ['local_analysis_record', state.records],
          ['local_shot', state.shots],
          ['local_session', state.sessions],
        ] as const) {
          if (sql.includes(table)) {
            for (const [key, row] of rows) {
              if (row.owner === owner) rows.delete(key);
            }
          }
        }
        if (sql.includes('outbox')) {
          state.outbox = state.outbox.filter(row => row.owner !== owner);
        }
        if (sql.startsWith('DELETE FROM kv'))
          state.kv.delete(String(params[0]));
      } else {
        throw new Error(`Unhandled SQL: ${sql}`);
      }
      return { rows: [] };
    },
    close() {},
  };
  return { db, calls, state, controls };
}

function clipWithSidecar(
  overrides: Parameters<typeof generateSwingSequence>[0] = {},
) {
  const { sequence, window } = generateSwingSequence(overrides);
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///captures/owner-a.mov',
    durationMs: window.endMs,
    fps: 60,
    width: 1080,
    height: 1080,
    capturedAtIso: '2026-09-04T10:00:00.000Z',
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///captures/owner-a.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
  mockReadArtifact = async () => sidecarJson;
  return { clip, sidecarJson };
}

function request(
  db: LocalDb,
  clip: CapturedClip,
  overrides: Partial<RunCaptureAnalysisRequest> = {},
): RunCaptureAnalysisRequest {
  return {
    db,
    captureId,
    clip,
    declaredStroke: 'forehand_drive',
    handedness: 'right',
    cameraView: 'side',
    apiConfig: { baseUrl: 'https://api.test', token: tokenA },
    appVersion: '0.1.0',
    ...overrides,
  };
}

function permitServer() {
  const finalized: Array<{
    authorization: string;
    url: string;
    body: unknown;
  }> = [];
  const controls = {
    reserve: async () => {},
    release: async () => {},
  };
  let reservations = 0;
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    const authorization = String(
      (init?.headers as Record<string, string>)['authorization'],
    );
    if (url.endsWith('/v1/analysis-permits')) {
      reservations += 1;
      const id = `permit-a-${reservations}`;
      await controls.reserve();
      return jsonResponse({
        permit: {
          id,
          accessSource: 'free',
          status: 'reserved',
          expiresAt: '2026-09-04T11:00:00.000Z',
        },
        access: {
          premium: false,
          freeRatings: {
            limit: 2,
            used: 1,
            reserved: 1,
            remaining: 1,
            availableToReserve: 0,
          },
        },
      });
    }
    if (url.endsWith('/finalize')) {
      finalized.push({
        authorization,
        url,
        body: JSON.parse(String(init?.body)),
      });
      await controls.release();
      return jsonResponse({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { fetchMock, finalized, controls };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as Response;
}

function realProviders(): FusionProviders {
  const fusion = providerFactory.createFusionProviders('forehand_drive');
  if (fusion.kind !== 'real') throw new Error(fusion.reason);
  jest.spyOn(providerFactory, 'createFusionProviders').mockReturnValue(fusion);
  return fusion.providers;
}

function deferredPhase() {
  const providers = realProviders();
  const phase = providers.phase.segmentPhases.bind(providers.phase);
  const pending = gate();
  jest
    .spyOn(providers.phase, 'segmentPhases')
    .mockImplementation(async (...args) => {
      await pending.wait();
      return phase(...args);
    });
  return pending;
}

function abstainingScorer() {
  const providers = realProviders();
  const score = providers.scorer.score.bind(providers.scorer);
  jest.spyOn(providers.scorer, 'score').mockImplementation(async input => {
    const result = await score(input);
    if (!result.ok) return result;
    return {
      ...result,
      value: {
        ...result.value,
        overallScore: null,
        presentation: 'abstain',
        analysisConfidence: 0.1,
        guidance: 'Record a clearer swing.',
      },
    };
  });
}

const telemetry: RunCaptureAnalysisRequest['evaluationTelemetry'] = {
  consentActive: true,
  dims: {
    userPseudonym: 'owner-a-trial',
    sessionId: null,
    courtId: null,
    deviceModel: 'test-device',
    devicePlatform: 'ios',
    osVersion: 'test-os',
  },
};

function expectRetryable(store: ReturnType<typeof fakeDb>) {
  expect(store.state.captures.get(`${ownerA}:${captureId}`)).toBe(
    'awaiting_model',
  );
  expect(store.state.captures.get(`${ownerB}:${captureId}`)).toBe(
    'awaiting_model',
  );
  expect(store.state.records.size).toBe(0);
  expect(store.state.shots.size).toBe(0);
  expect(store.state.sessions.size).toBe(0);
  expect(store.state.kv.size).toBe(0);
  expect(
    store.state.outbox.filter(
      row => row.kind === 'shot.sync' || row.kind === 'session.create',
    ),
  ).toEqual([]);
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
  setActiveDataOwner(ownerA);
});
afterEach(() => {
  jest.restoreAllMocks();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  globalThis.fetch = originalFetch;
});

describe('real capture-analysis owner isolation', () => {
  it.each([tokenA, null])(
    'resolves the current bearer for reserve and release after asynchronous work (initial %s)',
    async initialToken => {
      const store = fakeDb();
      const { clip, sidecarJson } = clipWithSidecar();
      const reading = gate();
      mockReadArtifact = async () => {
        await reading.wait();
        return sidecarJson;
      };
      const server = permitServer();
      abstainingScorer();
      let token: string | null = initialToken;
      server.controls.reserve = async () => {
        token = 'rotated-before-release';
      };
      const running = runCaptureAnalysis(
        request(store.db, clip, {
          apiConfig: { baseUrl: 'https://api.test', token: initialToken },
          resolveApiToken: () => token,
        }),
      );
      await reading.entered;
      token = 'rotated-before-reserve';
      reading.resume();
      const outcome = await running;
      expect(outcome.kind).toBe('low_confidence');
      const reserveHeaders = server.fetchMock.mock.calls[0]?.[1]?.headers as
        Record<string, string> | undefined;
      expect(reserveHeaders?.authorization).toBe(
        'Bearer rotated-before-reserve',
      );
      expect(server.finalized).toHaveLength(1);
      expect(server.finalized[0]?.authorization).toBe(
        'Bearer rotated-before-release',
      );
      expect(server.finalized[0]?.body).toEqual({
        outcome: 'low_confidence',
        ratingId: null,
      });
      expect(store.state.records.size).toBe(1);
      expect(store.state.outbox).toHaveLength(0);
    },
  );

  it.each(['missing-bearer', 'rejected-bearer'] as const)(
    'keeps an active account capture retryable while reconnecting (%s)',
    async failure => {
      const store = fakeDb();
      const { clip } = clipWithSidecar();
      const fetchMock = jest.fn(
        async () =>
          ({
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            json: async () => ({
              error: { code: 'auth.invalid_token', message: 'Sign in again.' },
            }),
          }) as Response,
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const outcome = await runCaptureAnalysis(
        request(store.db, clip, {
          apiConfig: {
            baseUrl: 'https://api.test',
            token: failure === 'missing-bearer' ? null : tokenA,
          },
        }),
      );
      expect(outcome).toMatchObject({
        kind: 'unavailable',
        reason:
          'Your account is reconnecting. Your capture is saved; try again when the connection is ready.',
      });
      expect(fetchMock).toHaveBeenCalledTimes(
        failure === 'missing-bearer' ? 0 : 1,
      );
      expectRetryable(store);
    },
  );

  it.each(['switch', 'sign-out', 'return-to-a'] as const)(
    'cancels %s during actual provider inference without persisting A evidence under B or a later A generation',
    async change => {
      const store = fakeDb();
      const { clip } = clipWithSidecar();
      const server = permitServer();
      const inference = deferredPhase();
      const running = runCaptureAnalysis(
        request(store.db, clip, {
          evaluationTelemetry: telemetry,
        }),
      );
      await inference.entered;
      setActiveDataOwner(
        change === 'sign-out' ? SIGNED_OUT_DATA_OWNER : ownerB,
      );
      if (change === 'return-to-a') setActiveDataOwner(ownerA);
      inference.resume();
      const outcome = await running.catch(() => null);
      expect(
        store.calls.filter(call => /INSERT|UPDATE/.test(call.sql)),
      ).toEqual([]);
      expect(outcome).toMatchObject({
        kind: 'unavailable',
        cause: 'owner_changed',
      });
      expectRetryable(store);
      expect(server.finalized).toEqual([]);
    },
  );

  it('checks the entry owner after reading the sidecar, before reserving any permit', async () => {
    const store = fakeDb();
    const { clip, sidecarJson } = clipWithSidecar();
    const sidecar = gate();
    mockReadArtifact = async () => {
      await sidecar.wait();
      return sidecarJson;
    };
    const server = permitServer();
    const running = runCaptureAnalysis(request(store.db, clip));
    await sidecar.entered;
    setActiveDataOwner(ownerB);
    sidecar.resume();
    expect(await running).toMatchObject({
      kind: 'unavailable',
      cause: 'owner_changed',
    });
    expect(server.fetchMock).not.toHaveBeenCalled();
    expect(store.calls).toEqual([]);
    expectRetryable(store);
  });

  it('checks the owner after reservation resolves and never starts inference for the next owner', async () => {
    const store = fakeDb();
    const { clip } = clipWithSidecar();
    const reservation = gate();
    const server = permitServer();
    server.controls.reserve = () => reservation.wait();
    const providers = realProviders();
    const phase = jest.spyOn(providers.phase, 'segmentPhases');
    const running = runCaptureAnalysis(request(store.db, clip));
    await reservation.entered;
    setActiveDataOwner(ownerB);
    reservation.resume();
    expect(await running).toMatchObject({
      kind: 'unavailable',
      cause: 'owner_changed',
    });
    expect(phase).not.toHaveBeenCalled();
    expect(server.finalized).toEqual([]);
    expectRetryable(store);
  });

  it.each([
    'BEGIN IMMEDIATE',
    'INSERT INTO local_analysis_record',
    'INSERT OR REPLACE INTO local_shot',
    'INSERT INTO outbox',
    "UPDATE local_capture SET status = 'analyzed'",
  ])('rolls back an owner change while awaiting %s', async statement => {
    const store = fakeDb();
    const { clip } = clipWithSidecar();
    const server = permitServer();
    const pending = gate();
    let paused = false;
    store.controls.beforeExecute = async call => {
      if (!paused && call.sql.startsWith(statement)) {
        paused = true;
        await pending.wait();
      }
    };
    const running = runCaptureAnalysis(
      request(store.db, clip, {
        evaluationTelemetry: telemetry,
      }),
    );
    await pending.entered;
    setActiveDataOwner(ownerB);
    pending.resume();
    const outcome = await running.catch(() => null);
    expect(
      store.calls
        .filter(call => /INSERT|UPDATE/.test(call.sql))
        .every(call => call.params[0] === ownerA),
    ).toBe(true);
    expectRetryable(store);
    expect(outcome).toMatchObject({
      kind: 'unavailable',
      cause: 'owner_changed',
    });
    expect(store.calls.some(call => call.sql === 'ROLLBACK')).toBe(true);
    expect(server.finalized).toEqual([]);
  });

  it('does not resurrect a deleted owner when inference finishes later in the same owner bucket', async () => {
    const store = fakeDb();
    const { clip } = clipWithSidecar();
    permitServer();
    const inference = deferredPhase();
    const running = runCaptureAnalysis(request(store.db, clip));
    await inference.entered;
    await purgeOwnerData(store.db, ownerA);
    inference.resume();
    expect(await running).toMatchObject({
      kind: 'unavailable',
      cause: 'owner_changed',
    });
    expect(store.state.records.size).toBe(0);
    expect(store.state.shots.size).toBe(0);
    expect(store.state.outbox).toEqual([]);
    expect(store.state.captures.has(`${ownerA}:${captureId}`)).toBe(false);
  });

  it('does not write or enqueue telemetry after an owner change during permit release', async () => {
    const store = fakeDb();
    const { clip } = clipWithSidecar();
    abstainingScorer();
    const server = permitServer();
    const release = gate();
    server.controls.release = () => release.wait();
    const running = runCaptureAnalysis(
      request(store.db, clip, {
        evaluationTelemetry: telemetry,
      }),
    );
    await release.entered;
    const callCount = store.calls.length;
    setActiveDataOwner(ownerB);
    release.resume();
    expect(await running).toMatchObject({
      kind: 'unavailable',
      cause: 'owner_changed',
    });
    expect(store.calls.slice(callCount)).toEqual([]);
    expect(
      store.state.outbox.some(row => row.kind === 'evaluation.trial'),
    ).toBe(false);
    expect(
      [...store.state.shots.values()].every(row => row.owner === ownerA),
    ).toBe(true);
    expect(server.finalized[0]?.authorization).toBe(`Bearer ${tokenA}`);
  });

  it('rolls back an in-flight evaluation queue write without discarding the already committed score', async () => {
    const store = fakeDb();
    const { clip } = clipWithSidecar();
    const server = permitServer();
    const pending = gate();
    store.controls.beforeExecute = async call => {
      if (call.sql.includes("'evaluation.trial'")) await pending.wait();
    };
    const running = runCaptureAnalysis(
      request(store.db, clip, {
        evaluationTelemetry: telemetry,
      }),
    );
    await pending.entered;
    setActiveDataOwner(ownerB);
    pending.resume();
    expect(await running).toMatchObject({
      kind: 'unavailable',
      cause: 'owner_changed',
    });
    expect(store.state.outbox.map(row => row.kind)).toEqual(['shot.sync']);
    expect(store.state.shots.size).toBe(1);
    expect(store.state.outbox[0]?.owner).toBe(ownerA);
    expect(server.finalized).toEqual([]);
  });

  it('retains the entry bearer for cleanup even when its mutable config changes mid-inference', async () => {
    const store = fakeDb();
    const { clip } = clipWithSidecar();
    abstainingScorer();
    const config = { baseUrl: 'https://api.test', token: tokenA };
    const server = permitServer();
    const providers = providerFactory.createFusionProviders('forehand_drive');
    if (providers.kind !== 'real') throw new Error(providers.reason);
    const extract = providers.providers.biomechanics.extract.bind(
      providers.providers.biomechanics,
    );
    jest
      .spyOn(providers.providers.biomechanics, 'extract')
      .mockImplementation(async input => {
        config.token = 'not-the-entry-bearer';
        return extract(input);
      });
    const outcome = await runCaptureAnalysis(
      request(store.db, clip, { apiConfig: config }),
    );
    expect(outcome.kind).toBe('low_confidence');
    expect(server.finalized[0]?.authorization).toBe(`Bearer ${tokenA}`);
    expect(JSON.stringify(store.calls)).not.toContain(tokenA);
  });
});

describe('capture-analysis atomic storage and legitimate completion', () => {
  it.each([
    'INSERT INTO local_analysis_record',
    'INSERT OR REPLACE INTO local_shot',
    'INSERT INTO outbox',
    "UPDATE local_capture SET status = 'analyzed'",
    'COMMIT',
  ])(
    'keeps the capture retryable and releases the permit after failure at %s',
    async statement => {
      const store = fakeDb();
      const { clip } = clipWithSidecar();
      const server = permitServer();
      store.controls.failNext = call => call.sql.startsWith(statement);
      const failed = await runCaptureAnalysis(request(store.db, clip)).catch(
        () => null,
      );
      expectRetryable(store);
      expect(failed).toMatchObject({
        kind: 'unavailable',
        cause: 'storage_failed',
      });
      expect(server.finalized).toEqual([
        {
          authorization: `Bearer ${tokenA}`,
          url: 'https://api.test/v1/analysis-permits/permit-a-1/finalize',
          body: { outcome: 'failed', ratingId: null },
        },
      ]);
      const retried = await runCaptureAnalysis(request(store.db, clip));
      expect(retried.kind).toBe('scored');
      expect(store.state.captures.get(`${ownerA}:${captureId}`)).toBe(
        'analyzed',
      );
      expect(store.state.records.size).toBe(1);
      expect(store.state.shots.size).toBe(1);
      expect(store.state.outbox).toHaveLength(1);
      expect(JSON.parse(store.state.outbox[0]!.payload).analysisPermitId).toBe(
        'permit-a-2',
      );
    },
  );

  it('leaves a local-only abstention retryable if its display result cannot be saved', async () => {
    const store = fakeDb();
    const { clip } = clipWithSidecar();
    const server = permitServer();
    abstainingScorer();
    store.controls.failNext = call =>
      call.sql.includes('INSERT OR REPLACE INTO local_shot');
    const failed = await runCaptureAnalysis(request(store.db, clip)).catch(
      () => null,
    );
    expectRetryable(store);
    expect(failed).toMatchObject({
      kind: 'unavailable',
      cause: 'storage_failed',
    });
    expect(server.finalized).toHaveLength(1);
    const retried = await runCaptureAnalysis(request(store.db, clip));
    expect(retried.kind).toBe('low_confidence');
    expect(store.state.records.size).toBe(1);
    expect(store.state.shots.size).toBe(1);
    expect(store.state.outbox).toEqual([]);
  });

  it('completes for the same owner despite redundant owner installation and records the score before hiding the capture', async () => {
    const store = fakeDb();
    const { clip } = clipWithSidecar();
    const server = permitServer();
    const inference = deferredPhase();
    const running = runCaptureAnalysis(
      request(store.db, clip, {
        evaluationTelemetry: telemetry,
      }),
    );
    await inference.entered;
    setActiveDataOwner(ownerA);
    inference.resume();
    const outcome = await running;
    expect(outcome).toMatchObject({ kind: 'scored', freeLimitReached: true });
    const resultWrite = store.calls.findIndex(call =>
      call.sql.includes("'shot.sync'"),
    );
    const captureWrite = store.calls.findIndex(call =>
      call.sql.includes("SET status = 'analyzed'"),
    );
    expect(resultWrite).toBeLessThan(captureWrite);
    expect(store.state.records.size).toBe(1);
    expect(store.state.shots.size).toBe(1);
    expect(store.state.outbox.map(row => row.kind)).toEqual([
      'shot.sync',
      'evaluation.trial',
    ]);
    expect(store.state.outbox.every(row => row.owner === ownerA)).toBe(true);
    expect(server.finalized).toEqual([]);
  });

  it('preserves immutable history when the same capture is legitimately reprocessed', async () => {
    const store = fakeDb();
    const { clip } = clipWithSidecar();
    permitServer();
    await runCaptureAnalysis(request(store.db, clip));
    const earlier = [...store.state.records.entries()];
    await runCaptureAnalysis(request(store.db, clip));
    expect(store.state.records.size).toBe(2);
    expect(store.state.records.get(earlier[0]![0])).toEqual(earlier[0]![1]);
    expect(
      [...store.state.records.values()].map(
        row => JSON.parse(row.payload).engineVersion,
      ),
    ).toEqual(['fusion-1', 'fusion-1']);
  });

  it('stores a genuine unresolved AUTO abstention without a score or rating outbox', async () => {
    const store = fakeDb();
    const { clip } = clipWithSidecar({ contactForwardNorm: 0 });
    const server = permitServer();
    const outcome = await runCaptureAnalysis(
      request(store.db, clip, { declaredStroke: null }),
    );
    expect(outcome).toMatchObject({
      kind: 'low_confidence',
      record: { result: null },
    });
    expect(store.state.captures.get(`${ownerA}:${captureId}`)).toBe('analyzed');
    expect(store.state.records.size).toBe(1);
    expect(store.state.shots.size).toBe(0);
    expect(store.state.outbox).toEqual([]);
    expect(server.finalized[0]?.body).toEqual({
      outcome: 'low_confidence',
      ratingId: null,
    });
  });
});

async function newPracticePlan(db: LocalDb): Promise<PracticeSetPlan> {
  const plan = await planPracticeSet(db, {
    shotType: 'forehand_drive',
    nowIso: '2026-09-04T10:00:00.000Z',
  });
  if (!plan) throw new Error('Expected a practice plan for the active owner');
  return plan;
}

describe('scored capture and actual practice-set plan commit atomically', () => {
  it('commits the planned session, activity, score and capture status in a single transaction', async () => {
    const store = fakeDb();
    const { clip } = clipWithSidecar();
    const server = permitServer();
    const plan = await newPracticePlan(store.db);
    const outcome = await runCaptureAnalysis(
      request(store.db, clip, {
        sessionId: 'not-the-plan-session',
        practiceSetPlan: plan,
      }),
    );

    expect(outcome).toMatchObject({
      kind: 'scored',
      practiceSetCommitted: true,
    });
    expect(
      store.calls.filter(call => call.sql === 'BEGIN IMMEDIATE'),
    ).toHaveLength(1);
    expect(store.calls.filter(call => call.sql === 'COMMIT')).toHaveLength(1);
    expect(store.state.sessions.size).toBe(1);
    expect(
      JSON.parse(
        store.state.sessions.get(`${ownerA}:${plan.sessionId}`)!.payload,
      ),
    ).toEqual({
      id: plan.sessionId,
      mode: 'practice_set',
      shotType: plan.shotType,
      focusCheckpoint: null,
      startedAt: plan.startedAtIso,
    });
    expect(
      JSON.parse(store.state.kv.get(practiceSetKeyForOwner(ownerA))!),
    ).toEqual({
      sessionId: plan.sessionId,
      shotType: plan.shotType,
      startedAtIso: plan.startedAtIso,
      lastActivityAtIso: plan.nowIso,
    });
    expect(
      [...store.state.shots.values()].map(
        row => JSON.parse(row.payload).sessionId,
      ),
    ).toEqual([plan.sessionId]);
    expect(
      [...store.state.records.values()].map(
        row => JSON.parse(row.payload).result.sessionId,
      ),
    ).toEqual([plan.sessionId]);
    expect(store.state.outbox.map(row => row.kind).sort()).toEqual([
      'session.create',
      'shot.sync',
    ]);
    expect(store.state.outbox.every(row => row.owner === ownerA)).toBe(true);
    expect(store.state.captures.get(`${ownerA}:${captureId}`)).toBe('analyzed');
    expect(store.state.captures.get(`${ownerB}:${captureId}`)).toBe(
      'awaiting_model',
    );
    expect(server.finalized).toEqual([]);
  });

  it.each([
    'INSERT OR REPLACE INTO local_session',
    "'session.create'",
    'INSERT OR REPLACE INTO kv',
    "UPDATE local_capture SET status = 'analyzed'",
    'COMMIT',
  ])(
    'keeps the capture retryable with no partial shot, session or outbox after failure at %s',
    async statement => {
      const store = fakeDb();
      const { clip } = clipWithSidecar();
      const server = permitServer();
      const plan = await newPracticePlan(store.db);
      store.controls.failNext = call => call.sql.includes(statement);

      const failed = await runCaptureAnalysis(
        request(store.db, clip, { practiceSetPlan: plan }),
      );

      expectRetryable(store);
      expect(failed).toMatchObject({
        kind: 'unavailable',
        cause: 'storage_failed',
      });
      expect(server.finalized[0]?.body).toEqual({
        outcome: 'failed',
        ratingId: null,
      });
      const retried = await runCaptureAnalysis(
        request(store.db, clip, { practiceSetPlan: plan }),
      );
      expect(retried).toMatchObject({
        kind: 'scored',
        practiceSetCommitted: true,
      });
      expect(store.state.records.size).toBe(1);
      expect(store.state.shots.size).toBe(1);
      expect(store.state.sessions.size).toBe(1);
      expect(store.state.outbox).toHaveLength(2);
      const shot = store.state.outbox.find(row => row.kind === 'shot.sync');
      expect(JSON.parse(shot!.payload)).toMatchObject({
        sessionId: plan.sessionId,
        analysisPermitId: 'permit-a-2',
      });
      expect(store.state.captures.get(`${ownerA}:${captureId}`)).toBe(
        'analyzed',
      );
    },
  );

  it('resumes the actual set without creating another session and refreshes activity with the score', async () => {
    const store = fakeDb();
    const { clip } = clipWithSidecar();
    permitServer();
    const first = await newPracticePlan(store.db);
    await runCaptureAnalysis(
      request(store.db, clip, { practiceSetPlan: first }),
    );
    const next = (await planPracticeSet(store.db, {
      shotType: 'forehand_drive',
      nowIso: '2026-09-04T10:01:00.000Z',
    }))!;
    expect(next).toMatchObject({ sessionId: first.sessionId, resumed: true });

    await runCaptureAnalysis(
      request(store.db, clip, { practiceSetPlan: next }),
    );

    expect(store.state.sessions.size).toBe(1);
    expect(
      store.state.outbox.filter(row => row.kind === 'session.create'),
    ).toHaveLength(1);
    expect(
      store.state.outbox.filter(row => row.kind === 'shot.sync'),
    ).toHaveLength(2);
    expect(
      JSON.parse(store.state.kv.get(practiceSetKeyForOwner(ownerA))!)
        .lastActivityAtIso,
    ).toBe(next.nowIso);
  });

  it.each([
    'local-abstention',
    'unresolved-auto',
    'inference-failure',
  ] as const)('creates no practice entry for %s', async result => {
    const store = fakeDb();
    const { clip } = clipWithSidecar();
    permitServer();
    const plan = await newPracticePlan(store.db);
    if (result === 'local-abstention') abstainingScorer();
    if (result === 'inference-failure') {
      const providers = realProviders();
      jest
        .spyOn(providers.phase, 'segmentPhases')
        .mockRejectedValue(new Error('inference interrupted'));
    }
    const outcome = await runCaptureAnalysis(
      request(store.db, clip, {
        practiceSetPlan: plan,
        declaredStroke: result === 'unresolved-auto' ? null : 'forehand_drive',
      }),
    ).catch(error => error);

    if (result !== 'inference-failure')
      expect(outcome.kind).toBe('low_confidence');
    else
      expect(outcome).toMatchObject({
        kind: 'unavailable',
        reason: 'inference interrupted',
      });
    expect(store.state.sessions.size).toBe(0);
    expect(store.state.kv.size).toBe(0);
    expect(store.state.outbox).toEqual([]);
  });

  it.each(['switch', 'return-to-a'] as const)(
    'rejects an earlier owner plan before reserving a permit after %s',
    async change => {
      const store = fakeDb();
      const { clip } = clipWithSidecar();
      const plan = await newPracticePlan(store.db);
      const server = permitServer();
      setActiveDataOwner(ownerB);
      if (change === 'return-to-a') setActiveDataOwner(ownerA);
      const callCount = store.calls.length;

      const outcome = await runCaptureAnalysis(
        request(store.db, clip, { practiceSetPlan: plan }),
      );

      expect(outcome).toMatchObject({
        kind: 'unavailable',
        cause: 'owner_changed',
      });
      expect(store.calls.slice(callCount)).toEqual([]);
      expectRetryable(store);
      expect(server.fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    'INSERT OR REPLACE INTO local_session',
    'INSERT OR REPLACE INTO kv',
  ])(
    'rolls the scored read back if its owner changes during practice persistence at %s',
    async statement => {
      const store = fakeDb();
      const { clip } = clipWithSidecar();
      const plan = await newPracticePlan(store.db);
      const server = permitServer();
      const pending = gate();
      store.controls.beforeExecute = async call => {
        if (call.sql.startsWith(statement)) await pending.wait();
      };
      const running = runCaptureAnalysis(
        request(store.db, clip, { practiceSetPlan: plan }),
      );
      expect(
        await Promise.race([
          pending.entered.then(() => true),
          running.then(() => false),
        ]),
      ).toBe(true);
      setActiveDataOwner(ownerB);
      setActiveDataOwner(ownerA);
      pending.resume();

      expect(await running).toMatchObject({
        kind: 'unavailable',
        cause: 'owner_changed',
      });
      expectRetryable(store);
      expect(server.finalized).toEqual([]);
    },
  );

  it('snapshots the real plan before inference so caller mutations cannot change its owner or session', async () => {
    const store = fakeDb();
    const { clip } = clipWithSidecar();
    permitServer();
    const plan = await newPracticePlan(store.db);
    const original = { ...plan };
    const inference = deferredPhase();
    const running = runCaptureAnalysis(
      request(store.db, clip, { practiceSetPlan: plan }),
    );
    await inference.entered;
    plan.sessionId = 'mutated-session';
    plan.owner = ownerB;
    plan.ownerGeneration += 1;
    inference.resume();

    expect(await running).toMatchObject({
      kind: 'scored',
      practiceSetCommitted: true,
    });
    expect(store.state.sessions.has(`${ownerA}:${original.sessionId}`)).toBe(
      true,
    );
    expect(store.state.outbox.every(row => row.owner === ownerA)).toBe(true);
    expect(
      [...store.state.shots.values()].map(
        row => JSON.parse(row.payload).sessionId,
      ),
    ).toEqual([original.sessionId]);
  });

  it('preserves legacy sessionId callers without inventing a practice session from their shot', async () => {
    const store = fakeDb();
    const { clip } = clipWithSidecar();
    permitServer();
    const outcome = await runCaptureAnalysis(
      request(store.db, clip, { sessionId: 'already-existing-session' }),
    );

    expect(outcome.kind).toBe('scored');
    expect(store.state.sessions.size).toBe(0);
    expect(store.state.kv.size).toBe(0);
    expect(store.state.outbox.map(row => row.kind)).toEqual(['shot.sync']);
    expect(JSON.parse(store.state.outbox[0]!.payload).sessionId).toBe(
      'already-existing-session',
    );
  });
});
