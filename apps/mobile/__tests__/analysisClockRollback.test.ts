/**
 * Device clock rollback between capture and commit on the SHIPPING analysis
 * paths (AnalyzeScreen → prepareOriginalCaptureAnalysis →
 * runOriginalCaptureAnalysis, and the direct runCaptureAnalysis runner).
 *
 * The capture is stamped with the device clock; the analysis record's
 * `createdAtIso` and each model run's instants are stamped by the runner's
 * clock at commit time. When the clock steps back in between (an NTP
 * correction, a time-zone repair, a manual change) a record stamped by the
 * raw wall clock claims to have been produced BEFORE its own capture and the
 * durable-record verifier rejects it — the fully inferred, honest result is
 * then held as `recovery_pending`, the permit is finalised 'failed' and the
 * replay stays unavailable. Pins: the record's instants are never earlier
 * than the capture they describe, the result is delivered, the replay
 * returns the same result, and the permit is left reserved for sync exactly
 * as under a monotonic clock.
 */
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';
import { OriginalAnalysisExecution } from '../src/analysis/originalAnalysisOperations';
import * as captureRunner from '../src/analysis/runCaptureAnalysis';
import {
  extractImportedPoseSequence,
  readCaptureArtifact,
  verifyCapturedClipCurrentBytes,
  type CapturedClip,
} from '../src/camera/capture';
import {
  captureDataOwnerContext,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import type { LocalDb } from '../src/data/db';
import { clearSyncRuntime } from '../src/data/syncRuntime';
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

const OWNER = '11111111-1111-4111-8111-111111111111';
const ORIGIN = 'https://api.example.test/functions/v1/api';
const CAPTURE = '33333333-3333-4333-8333-333333333333';
const LOGICAL = '44444444-4444-4444-8444-444444444444';
const originalFetch = globalThis.fetch;
const leases: OriginalAnalysisExecution[] = [];

function fixture(capturedAtIso: string) {
  const { sequence, window } = generateSwingSequence();
  const sidecar = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///private/captures/original.mov',
    captureMode: 'imported_video',
    capturedAtIso,
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
  return { clip, sidecar };
}

const ok = (value: unknown): Response =>
  ({ ok: true, status: 200, json: async () => value }) as Response;

interface Permit {
  id: string;
  outcome: string | null;
  reason: string | null;
}

function server() {
  const reservations = new Map<string, Permit>();
  globalThis.fetch = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        idempotencyKey?: string;
        outcome?: string;
        reason?: string;
        shots?: Array<{ id: string; analysisPermitId?: string }>;
      };
      if (url.endsWith('/v1/analysis-permits')) {
        const key = String(body.idempotencyKey);
        let permit = reservations.get(key);
        if (!permit) {
          permit = {
            id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(reservations.size + 1).padStart(12, '0')}`,
            outcome: null,
            reason: null,
          };
          reservations.set(key, permit);
        }
        return ok({
          permit: {
            id: permit.id,
            status: permit.outcome ? 'finalized' : 'reserved',
            accessSource: 'free',
            expiresAt: new Date(Date.now() + 12 * 3_600_000).toISOString(),
          },
        });
      }
      if (url.endsWith('/finalize')) {
        const permit = [...reservations.values()].find(value =>
          url.includes(value.id),
        );
        if (!permit)
          return {
            ok: false,
            status: 404,
            json: async () => ({ error: { code: 'access.permit_not_found' } }),
          } as Response;
        permit.outcome = String(body.outcome);
        permit.reason = body.reason ?? null;
        return ok({ permit });
      }
      if (url.endsWith('/v1/sessions')) return ok({});
      if (url.endsWith('/v1/shots:sync')) {
        const shots = body.shots ?? [];
        return ok({ acceptedIds: shots.map(shot => shot.id), rejected: [] });
      }
      throw new Error(`Unexpected test HTTP ${url}`);
    },
  );
  return reservations;
}

const permitSummary = (reservations: Map<string, Permit>) =>
  [...reservations.values()].map(p => ({
    outcome: p.outcome,
    reason: p.reason,
  }));

interface StoredRecord {
  createdAtIso: string;
  result: { capturedAtIso: string } | null;
  modelRuns: Array<{ startedAtIso: string; completedAtIso: string }>;
  provenance: { recordedAtIso: string };
}

async function storedRecords(db: LocalDb): Promise<StoredRecord[]> {
  const { rows } = await db.execute(
    'SELECT record FROM local_analysis_record WHERE owner_key = ? ORDER BY created_at',
    [OWNER],
  );
  return rows.map(row => JSON.parse(String(row.record)) as StoredRecord);
}

function expectInstantsNoEarlierThanCapture(
  record: StoredRecord,
  capturedAtIso: string,
): void {
  const capturedMs = Date.parse(capturedAtIso);
  const createdMs = Date.parse(record.createdAtIso);
  expect(record.result?.capturedAtIso).toBe(capturedAtIso);
  expect(record.provenance.recordedAtIso).toBe(record.createdAtIso);
  expect(createdMs).toBeGreaterThanOrEqual(capturedMs);
  expect(record.modelRuns.length).toBeGreaterThan(0);
  for (const run of record.modelRuns) {
    const started = Date.parse(run.startedAtIso);
    const completed = Date.parse(run.completedAtIso);
    expect(started).toBeGreaterThanOrEqual(capturedMs);
    expect(completed).toBeGreaterThanOrEqual(started);
    expect(createdMs).toBeGreaterThanOrEqual(completed);
  }
}

function baseRequest(
  db: LocalDb,
  clip: CapturedClip,
): Omit<captureRunner.RunCaptureAnalysisRequest, 'ownerContext'> {
  return {
    db,
    captureId: CAPTURE,
    clip,
    declaredStroke: 'forehand_drive',
    declaredCanonical: 'FOREHAND_DRIVE',
    handedness: 'right',
    cameraView: 'side',
    appVersion: '0.1.0',
    apiConfig: { baseUrl: ORIGIN, token: 'never-save-this-token' },
  };
}

async function seed(capturedAtIso: string) {
  const store = createSqliteTestDb();
  const { clip, sidecar } = fixture(capturedAtIso);
  const pose = clip.poseSequence!;
  seedSqliteCapture(store.db, OWNER, CAPTURE, clip);
  await store.db.execute(
    'UPDATE local_capture SET declared_stroke = ? WHERE id = ?',
    ['forehand_drive', CAPTURE],
  );
  jest.mocked(readCaptureArtifact).mockResolvedValue(sidecar);
  jest.mocked(extractImportedPoseSequence).mockResolvedValue({
    poseSequence: pose,
    framesWithPose: pose.frameCount,
    framesTotal: pose.frameCount,
  });
  return { store, clip };
}

async function originalRunner(capturedAtIso: string) {
  const { store, clip } = await seed(capturedAtIso);
  const owner = new OriginalAnalysisExecution(
    captureDataOwnerContext(),
    ORIGIN,
  );
  leases.push(owner);
  await captureRunner.prepareOriginalCaptureAnalysis(
    { ...baseRequest(store.db, clip), ownerContext: owner.ownerContext },
    owner,
    LOGICAL,
  );
  const reservations = server();
  const run = () =>
    captureRunner.runOriginalCaptureAnalysis({
      db: store.db,
      execution: owner,
      operationId: LOGICAL,
    });
  return { store, reservations, run };
}

async function directRunner(capturedAtIso: string) {
  const { store, clip } = await seed(capturedAtIso);
  const reservations = server();
  const request: captureRunner.RunCaptureAnalysisRequest = {
    ...baseRequest(store.db, clip),
    ownerContext: captureDataOwnerContext(),
    operationId: LOGICAL,
  };
  const run = () => captureRunner.runCaptureAnalysis(request);
  return { store, reservations, run };
}

beforeEach(() => {
  jest
    .mocked(verifyCapturedClipCurrentBytes)
    .mockImplementation(async clip => ({
      status: 'verified-current-bytes',
      comparedExpectation: (clip as CapturedClip).nativeMediaIdentity!,
    }));
  setActiveDataOwner(OWNER);
  establishApiSession({
    canonicalAppUserId: OWNER,
    apiBaseUrl: ORIGIN,
    bearerToken: 'not-persisted-test-bearer',
    provider: 'apple',
  });
});

afterEach(() => {
  for (const lease of leases.splice(0)) lease.dispose();
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
  closeSqliteTestDatabases();
});

const ROLLBACKS: Array<[string, number]> = [
  ['1 second', 1_000],
  ['5 minutes', 5 * 60_000],
  ['1 hour', 3_600_000],
];

describe('original-analysis path: clock rollback between capture and commit', () => {
  // The runner commits locally; the scored shot is charged by the outbox
  // drain later, so a delivered result leaves its permit reserved (null).
  it('control: a monotonic clock delivers a scored result and leaves the permit reserved for sync', async () => {
    const capturedAtIso = new Date(Date.now() - 1_000).toISOString();
    const input = await originalRunner(capturedAtIso);
    const first = await input.run();
    const second = await input.run();
    expect({
      first: first.kind,
      second: second.kind,
      permits: permitSummary(input.reservations),
    }).toEqual({
      first: 'scored',
      second: 'scored',
      permits: [{ outcome: null, reason: null }],
    });
    const records = await storedRecords(input.store.db);
    expect(records).toHaveLength(1);
    expectInstantsNoEarlierThanCapture(records[0]!, capturedAtIso);
  });

  it.each(ROLLBACKS)(
    'a %s rollback still delivers the fully inferred result, replays it, and leaves the permit reserved',
    async (_label, rollbackMs) => {
      const capturedAtIso = new Date(Date.now() + rollbackMs).toISOString();
      const input = await originalRunner(capturedAtIso);
      const first = await input.run();
      const second = await input.run();
      expect({
        first: first.kind,
        firstCause: first.kind === 'unavailable' ? first.cause : null,
        firstReason: first.kind === 'unavailable' ? first.reason : null,
        second: second.kind,
        permits: permitSummary(input.reservations),
      }).toEqual({
        first: 'scored',
        firstCause: null,
        firstReason: null,
        second: 'scored',
        permits: [{ outcome: null, reason: null }],
      });
      const records = await storedRecords(input.store.db);
      expect(records).toHaveLength(1);
      expectInstantsNoEarlierThanCapture(records[0]!, capturedAtIso);
    },
  );
});

describe('direct runner: clock rollback between capture and commit', () => {
  it.each(ROLLBACKS)(
    'after a %s rollback the delivered analysis replays as the same scored result, not as a hold',
    async (_label, rollbackMs) => {
      const capturedAtIso = new Date(Date.now() + rollbackMs).toISOString();
      const input = await directRunner(capturedAtIso);
      const first = await input.run();
      expect(first.kind).toBe('scored');
      const second = await input.run();
      expect(second).toEqual({ ...first, replayed: true });
      expect(input.reservations.size).toBe(1);
      const records = await storedRecords(input.store.db);
      expect(records).toHaveLength(1);
      expectInstantsNoEarlierThanCapture(records[0]!, capturedAtIso);
    },
  );

  it('control: with a monotonic clock the same replay returns the scored result', async () => {
    const input = await directRunner(
      new Date(Date.now() - 1_000).toISOString(),
    );
    const first = await input.run();
    expect(first.kind).toBe('scored');
    const second = await input.run();
    expect(second).toEqual({ ...first, replayed: true });
  });
});
