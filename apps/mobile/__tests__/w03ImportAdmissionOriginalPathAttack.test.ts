import { generateSwingSequence } from '@pickle/evaluation';
import {
  serializePoseSequence,
  sha256Hex,
  type PoseSequence,
} from '@pickle/swing-domain';
import {
  OriginalAnalysisExecution,
  originalAnalysisOperations as operations,
} from '../src/analysis/originalAnalysisOperations';
import {
  recoverAnalysisJournals,
  type RunJournalPermitPort,
} from '../src/analysis/runJournal';
import * as captureRunner from '../src/analysis/runCaptureAnalysis';
import * as pipeline from '@pickle/analysis-pipeline';
import {
  captureDataOwnerContext,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';
import {
  extractImportedPoseSequence,
  readCaptureArtifact,
  verifyCapturedClipCurrentBytes,
  type CapturedClip,
} from '../src/camera/capture';
import { importAdmissionRejectionMessage } from '../src/camera/importAdmission';
import {
  closeSqliteTestDatabases,
  createSqliteTestDb,
  seedSqliteCapture,
} from '../testSupport/sqlite';

/**
 * W03-01 adversary — wiring attacks against candidate e7d0a078.
 *
 * AnalyzeScreen routes every signed-in import (an API session exists) through
 * `runOriginalCaptureAnalysis`, not `runCaptureAnalysis`. In that path the
 * saved-analysis attempt is admitted (`originalAnalysisOperations.admit`)
 * BEFORE `runCaptureAnalysisCore` reaches the W03-01 gates. These tests probe
 * what a refused import leaves behind on that path: journal rows, permit
 * traffic on startup recovery / explicit "Check", retry behaviour, account
 * isolation, and the outcome copy the player would see.
 */

jest.mock('@pickle/analysis-pipeline', () => {
  const actual = jest.requireActual('@pickle/analysis-pipeline');
  return { ...actual, analyzeCapture: jest.fn(actual.analyzeCapture) };
});
jest.mock('../src/camera/capture', () => ({
  ...jest.requireActual('../src/camera/capture'),
  verifyCapturedClipCurrentBytes: jest.fn(),
  readCaptureArtifact: jest.fn(),
  extractImportedPoseSequence: jest.fn(),
}));

const originalFetch = globalThis.fetch;
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://api.example.test/functions/v1/api';
const CAPTURE = '33333333-3333-4333-8333-333333333333';
const LOGICAL = '44444444-4444-4444-8444-444444444444';
const SESSION = '55555555-5555-4555-8555-555555555555';
const leases: OriginalAnalysisExecution[] = [];

function signIn(owner = OWNER) {
  setActiveDataOwner(owner);
  establishApiSession({
    canonicalAppUserId: owner,
    apiBaseUrl: ORIGIN,
    bearerToken: 'not-persisted-test-bearer',
    provider: 'apple',
  });
}

function execution() {
  const value = new OriginalAnalysisExecution(
    captureDataOwnerContext(),
    ORIGIN,
  );
  leases.push(value);
  return value;
}

function concatSequences(
  first: PoseSequence,
  second: PoseSequence,
  gapMs: number,
): PoseSequence {
  const lastFirst = first.frames[first.frames.length - 1];
  const offset = (lastFirst?.timestampMs ?? 0) + gapMs;
  return {
    ...first,
    frames: [
      ...first.frames,
      ...second.frames.map(frame => ({
        ...frame,
        frameIndex: first.frames.length + frame.frameIndex,
        timestampMs: frame.timestampMs + offset,
      })),
    ],
  };
}

type Scenario = 'ambiguous_rally' | 'duration_too_short';

function fixture(scenario: Scenario) {
  const single = generateSwingSequence().sequence;
  const sequence =
    scenario === 'ambiguous_rally'
      ? concatSequences(single, generateSwingSequence().sequence, 1000)
      : single;
  const sidecar = serializePoseSequence(sequence);
  const last = sequence.frames[sequence.frames.length - 1];
  const durationMs =
    scenario === 'duration_too_short' ? 500 : (last?.timestampMs ?? 0) + 200;
  const clip: CapturedClip = {
    uri: 'file:///private/captures/original.mov',
    captureMode: 'imported_video',
    capturedAtIso: '2026-09-08T09:00:00.000Z',
    durationMs,
    width: sequence.video.width,
    height: sequence.video.height,
    fps: sequence.video.fps,
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
      videoFileName: 'original.mov',
      byteSize: 25,
      sha256: sha256Hex('synthetic test movie bytes'),
    },
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///private/captures/original.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecar),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
  };
  return { clip, sidecar, sequence };
}

const EXPECTED_REASON: Record<Scenario, string> = {
  ambiguous_rally: importAdmissionRejectionMessage('multiple_stroke_events'),
  duration_too_short: importAdmissionRejectionMessage('duration_too_short'),
};

interface PermitServer {
  reservations: Map<string, { id: string; outcome: string | null }>;
  charges: Set<string>;
  fetch: jest.Mock;
  permitCalls(): string[];
  failNextReserve(status: number, retryAfter?: string): void;
}

function permitServer(): PermitServer {
  const reservations = new Map<
    string,
    { id: string; outcome: string | null }
  >();
  const charges = new Set<string>();
  let failure: { status: number; retryAfter?: string } | null = null;
  const fetch = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}'));
      const ok = (value: unknown) =>
        ({ ok: true, status: 200, json: async () => value }) as Response;
      if (url.endsWith('/v1/analysis-permits')) {
        if (failure) {
          const { status, retryAfter } = failure;
          failure = null;
          return {
            ok: false,
            status,
            headers: new Headers(
              retryAfter ? { 'Retry-After': retryAfter } : {},
            ),
            json: async () => ({
              error: { code: status === 429 ? 'rate_limited' : 'server_error' },
            }),
            text: async () => '',
          } as unknown as Response;
        }
        let permit = reservations.get(body.idempotencyKey);
        if (!permit) {
          permit = {
            id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(reservations.size + 1).padStart(12, '0')}`,
            outcome: null,
          };
          reservations.set(body.idempotencyKey, permit);
        }
        return ok({
          permit: {
            id: permit.id,
            status: permit.outcome ? 'finalized' : 'reserved',
            accessSource: 'free',
            expiresAt: '2026-09-09T00:00:00.000Z',
          },
        });
      }
      if (url.endsWith('/finalize')) {
        const permit = [...reservations.values()].find(value =>
          url.includes(value.id),
        );
        if (permit) permit.outcome = body.outcome;
        return ok({ permit });
      }
      if (url.endsWith('/v1/sessions')) return ok({});
      if (url.endsWith('/v1/shots:sync')) {
        for (const shot of body.shots) charges.add(shot.id);
        return ok({
          acceptedIds: body.shots.map((shot: { id: string }) => shot.id),
          rejected: [],
        });
      }
      throw new Error(`Unexpected test HTTP ${url}`);
    },
  );
  globalThis.fetch = fetch;
  return {
    reservations,
    charges,
    fetch,
    permitCalls: () =>
      fetch.mock.calls
        .map(call => String(call[0]))
        .filter(url => url.includes('/v1/analysis-permits')),
    failNextReserve(status, retryAfter) {
      failure = { status, retryAfter };
    },
  };
}

function port(owner = OWNER): RunJournalPermitPort & {
  reserve: jest.Mock;
  release: jest.Mock;
} {
  return {
    ownerKey: owner,
    apiOrigin: ORIGIN,
    reserve: jest.fn(async (key: string) => ({
      permit: {
        id: `cccccccc-cccc-4ccc-8ccc-${key.slice(0, 12)}`,
        status: 'reserved',
      },
    })),
    release: jest.fn(async () => undefined),
  };
}

async function runnerSetup(scenario: Scenario) {
  const store = createSqliteTestDb();
  const { clip, sidecar } = fixture(scenario);
  seedSqliteCapture(store.db, OWNER, CAPTURE, clip);
  const targetSeed = {
    point: { x: 0.4, y: 0.6 },
    selectedAtIso: '2026-09-08T09:01:00.000Z',
  };
  await store.db.execute(
    'UPDATE local_capture SET declared_stroke = ?, target_seed = ? WHERE id = ?',
    ['forehand_drive', JSON.stringify(targetSeed), CAPTURE],
  );
  jest.mocked(readCaptureArtifact).mockResolvedValue(sidecar);
  const owner = execution();
  const request: captureRunner.RunCaptureAnalysisRequest = {
    db: store.db,
    ownerContext: owner.ownerContext,
    captureId: CAPTURE,
    clip,
    declaredStroke: 'forehand_drive',
    declaredCanonical: 'FOREHAND_DRIVE',
    handedness: 'right',
    cameraView: 'side',
    appVersion: '0.1.0',
    apiConfig: { baseUrl: ORIGIN, token: 'never-save-this-token' },
    sessionId: SESSION,
    practiceSet: {
      owner: OWNER,
      sessionId: SESSION,
      resumed: false,
      shotType: 'forehand_drive',
      startedAtIso: '2026-09-08T09:00:00.000Z',
      nowIso: '2026-09-08T09:00:00.000Z',
    },
    targetSeed,
  };
  const operation = await captureRunner.prepareOriginalCaptureAnalysis(
    request,
    owner,
    LOGICAL,
  );
  const server = permitServer();
  const run = (predecessorAttemptId?: string) =>
    captureRunner.runOriginalCaptureAnalysis({
      db: store.db,
      execution: owner,
      operationId: LOGICAL,
      predecessorAttemptId,
    });
  const attemptRows = () =>
    store.native
      .prepare(
        'SELECT state, release_outcome, permit_id, last_http_status FROM analysis_execution_attempts WHERE owner_key = ?',
      )
      .all(OWNER);
  return { store, owner, request, operation, server, run, attemptRows };
}

beforeEach(() => {
  signIn();
  jest
    .mocked(verifyCapturedClipCurrentBytes)
    .mockReset()
    .mockImplementation(async clip => ({
      status: 'verified-current-bytes',
      comparedExpectation: (clip as CapturedClip).nativeMediaIdentity!,
    }));
  jest.mocked(readCaptureArtifact).mockReset();
  jest.mocked(extractImportedPoseSequence).mockReset();
  jest
    .mocked(pipeline.analyzeCapture)
    .mockReset()
    .mockImplementation(
      jest.requireActual<typeof pipeline>('@pickle/analysis-pipeline')
        .analyzeCapture,
    );
});
afterEach(() => {
  for (const lease of leases.splice(0)) lease.dispose();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
  closeSqliteTestDatabases();
});

describe('ATTACK 7 — a refused import on the signed-in (saved original) path leaves no admitted attempt', () => {
  it.each<Scenario>(['ambiguous_rally', 'duration_too_short'])(
    '%s: the precise reason is returned and no journal attempt is left behind',
    async scenario => {
      const input = await runnerSetup(scenario);
      const outcome = await input.run();
      expect(outcome.kind).toBe('unavailable');
      if (outcome.kind !== 'unavailable') return;
      expect(outcome.reason).toBe(EXPECTED_REASON[scenario]);
      expect(input.server.permitCalls()).toHaveLength(0);
      expect(pipeline.analyzeCapture).not.toHaveBeenCalled();
      // The clip never reached charging, so nothing may be waiting on a permit.
      expect(input.attemptRows()).toEqual([]);
    },
  );
});

describe('ATTACK 8 — process death then startup recovery after a refused import', () => {
  it('startup recovery never reserves a permit for a clip the gate refused', async () => {
    const input = await runnerSetup('ambiguous_rally');
    expect((await input.run()).kind).toBe('unavailable');
    // Simulate process death: the in-memory execution lease is gone, only
    // SQLite survives. Startup recovery walks pending attempts.
    input.owner.dispose();
    const startup = port();
    const items = await recoverAnalysisJournals(
      input.store.db,
      input.owner.scope,
      startup,
    );
    expect(startup.reserve).not.toHaveBeenCalled();
    expect(startup.release).not.toHaveBeenCalled();
    expect(items.items.filter(item => item.kind === 'pending')).toHaveLength(0);
  });
});

describe('ATTACK 9 — explicit "Check" (reconcile) and network failure at reserve', () => {
  it('reconciling a refused import performs no permit traffic and does not reserve on the server', async () => {
    const input = await runnerSetup('ambiguous_rally');
    expect((await input.run()).kind).toBe('unavailable');
    await captureRunner.reconcileOriginalCaptureAnalysis({
      db: input.store.db,
      execution: input.owner,
      operationId: LOGICAL,
    });
    expect(input.server.permitCalls()).toHaveLength(0);
    expect(input.server.reservations.size).toBe(0);
  });

  it('reconciling a refused import never charges a free rating, whatever else it does on the wire', async () => {
    const input = await runnerSetup('ambiguous_rally');
    expect((await input.run()).kind).toBe('unavailable');
    await captureRunner.reconcileOriginalCaptureAnalysis({
      db: input.store.db,
      execution: input.owner,
      operationId: LOGICAL,
    });
    expect(input.server.charges.size).toBe(0);
    expect(
      [...input.server.reservations.values()].filter(
        permit => permit.outcome === 'scored',
      ),
    ).toEqual([]);
    expect(pipeline.analyzeCapture).not.toHaveBeenCalled();
  });

  it('a 429 + Retry-After from the permit service cannot leave a refused import held on the network', async () => {
    const input = await runnerSetup('ambiguous_rally');
    expect((await input.run()).kind).toBe('unavailable');
    input.server.failNextReserve(429, '30');
    await captureRunner.reconcileOriginalCaptureAnalysis({
      db: input.store.db,
      execution: input.owner,
      operationId: LOGICAL,
    });
    // A refused clip has no permit to reconcile; no row may record an HTTP
    // failure or wait for the server.
    expect(
      input.attemptRows().filter(row => row.last_http_status !== null),
    ).toEqual([]);
    expect(
      input.attemptRows().filter(row => row.state === 'release_pending'),
    ).toEqual([]);
  });

  it('a 5xx from the permit service likewise leaves nothing pending for a refused import', async () => {
    const input = await runnerSetup('ambiguous_rally');
    expect((await input.run()).kind).toBe('unavailable');
    input.server.failNextReserve(503);
    await captureRunner.reconcileOriginalCaptureAnalysis({
      db: input.store.db,
      execution: input.owner,
      operationId: LOGICAL,
    });
    expect(input.attemptRows().filter(row => row.state !== 'released')).toEqual(
      [],
    );
  });
});

describe('ATTACK 10 — retry after a refused import keeps the precise reason', () => {
  it('running the same saved analysis again returns the admission reason, not a recovery placeholder', async () => {
    const input = await runnerSetup('ambiguous_rally');
    const first = await input.run();
    expect(first.kind).toBe('unavailable');
    const second = await input.run();
    expect(second.kind).toBe('unavailable');
    if (second.kind !== 'unavailable') return;
    expect(second.reason).toBe(EXPECTED_REASON.ambiguous_rally);
    expect(second.cause).toBeUndefined();
  });

  it('after reconciliation the player is still told the precise reason and can retry the saved clip', async () => {
    const input = await runnerSetup('ambiguous_rally');
    expect((await input.run()).kind).toBe('unavailable');
    await captureRunner.reconcileOriginalCaptureAnalysis({
      db: input.store.db,
      execution: input.owner,
      operationId: LOGICAL,
    });
    const again = await input.run();
    expect(again.kind).toBe('unavailable');
    if (again.kind !== 'unavailable') return;
    expect(again.reason).toBe(EXPECTED_REASON.ambiguous_rally);
    expect(again.cause).not.toBe('recovery_pending');
  });
});

describe('ATTACK 11 — double submit of a refused import', () => {
  it('two concurrent runs of the same saved import neither reserve nor leave two attempts', async () => {
    const input = await runnerSetup('ambiguous_rally');
    const [first, second] = await Promise.all([input.run(), input.run()]);
    expect([first.kind, second.kind]).toEqual(['unavailable', 'unavailable']);
    expect(input.server.permitCalls()).toHaveLength(0);
    expect(input.attemptRows().length).toBeLessThanOrEqual(1);
    expect(pipeline.analyzeCapture).not.toHaveBeenCalled();
  });
});

describe('ATTACK 12 — account switch after a refused import', () => {
  it("another account signing in cannot reconcile or reserve the first account's refused import", async () => {
    const input = await runnerSetup('ambiguous_rally');
    expect((await input.run()).kind).toBe('unavailable');
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    signIn(OTHER_OWNER);
    const other = new OriginalAnalysisExecution(
      captureDataOwnerContext(),
      ORIGIN,
    );
    leases.push(other);
    const otherPort = port(OTHER_OWNER);
    const items = await recoverAnalysisJournals(
      input.store.db,
      other.scope,
      otherPort,
    );
    expect(items.items).toEqual([]);
    expect(otherPort.reserve).not.toHaveBeenCalled();
    expect(input.server.permitCalls()).toHaveLength(0);
    expect(input.store.count('analysis_execution_attempts', OTHER_OWNER)).toBe(
      0,
    );
    await expect(
      operations.read(input.store.db, other, LOGICAL),
    ).resolves.toBeNull();
  });
});
