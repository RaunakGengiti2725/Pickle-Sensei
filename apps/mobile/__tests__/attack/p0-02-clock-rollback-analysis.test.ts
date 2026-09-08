/**
 * P0-02 adversarial attack: device clock rollback between capture and analysis.
 *
 * `capturedAtIso` is the device clock at capture time (native
 * ClipMediaStore.swift stamps `Date()`); the analysis record's `createdAtIso`
 * is the device clock at commit time. If the clock steps backwards in
 * between (NTP correction, manual change, the user analyses a saved capture
 * after travelling) the record has `capturedAtIso > createdAtIso`, which
 * `isVerifiedCompletedCaptureRecord` treats as a corrupt record. Nothing else
 * about the capture, permit or inference is different.
 *
 * Product invariant under test: a real, fully inferred and charged analysis
 * on a supported path must stay reachable — a replay / saved-analysis load of
 * the same operation must return the same scored result, never a hold.
 */
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { CapturedClip } from '../../src/camera/capture';
import {
  runCaptureAnalysis,
  type RunCaptureAnalysisRequest,
} from '../../src/analysis/runCaptureAnalysis';
import { runJournal } from '../../src/analysis/runJournal';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import {
  captureDataOwnerContext,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import {
  closeSqliteTestDatabases,
  createSqliteTestDb,
  seedSqliteCapture,
} from '../../testSupport/sqlite';

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../../src/camera/capture', () => ({
  ...jest.requireActual('../../src/camera/capture'),
  readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
}));

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const CAPTURE = '33333333-3333-4333-8333-333333333333';
const OPERATION = '44444444-4444-4444-8444-444444444444';
const API_ORIGIN = 'https://api.example.test/functions/v1/api';
const originalFetch = globalThis.fetch;
let mockReadArtifact: (uri: string) => Promise<string>;

function fixture(capturedAtIso: string) {
  const { sequence, window } = generateSwingSequence();
  const sidecar = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///private/captures/owned.mov',
    capturedAtIso,
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

function response(status: number, body: unknown): Response {
  return {
    ok: status < 400,
    status,
    statusText: String(status),
    json: async () => body,
  } as Response;
}

function server() {
  const reservations = new Map<
    string,
    { id: string; outcome: string | null }
  >();
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchPort = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<
        string,
        unknown
      >;
      calls.push({ url, body });
      if (url.endsWith('/v1/analysis-permits')) {
        const key = String(body.idempotencyKey);
        let permit = reservations.get(key);
        if (!permit) {
          permit = {
            id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(reservations.size + 1).padStart(12, '0')}`,
            outcome: null,
          };
          reservations.set(key, permit);
        }
        return response(200, {
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
          return response(404, { error: { code: 'access.permit_not_found' } });
        permit.outcome = String(body.outcome);
        return response(200, { permit });
      }
      if (url.endsWith('/v1/shots:sync')) {
        const shots = body.shots as Array<{ id: string }>;
        return response(200, {
          acceptedIds: shots.map(shot => shot.id),
          rejected: [],
        });
      }
      if (url.endsWith('/v1/sessions')) return response(200, {});
      throw new Error(`Unexpected test request ${url}`);
    },
  );
  return { calls, reservations, fetchPort };
}

function setup(capturedAtIso: string) {
  const store = createSqliteTestDb();
  const { clip, sidecar } = fixture(capturedAtIso);
  mockReadArtifact = async () => sidecar;
  seedSqliteCapture(store.db, OWNER_A, CAPTURE, clip);
  const http = server();
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
  };
  return {
    store,
    http,
    request,
    ref: { ownerKey: OWNER_A, apiOrigin: API_ORIGIN, operationId: OPERATION },
  };
}

beforeEach(() => {
  setActiveDataOwner(OWNER_A);
  establishApiSession({
    canonicalAppUserId: OWNER_A,
    apiBaseUrl: API_ORIGIN,
    bearerToken: 'fresh-owner-token',
    provider: 'apple',
  });
});

afterEach(() => {
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
  closeSqliteTestDatabases();
});

describe('P0-02 attack: device clock rollback between capture and analysis', () => {
  it('control: a clip captured a year ago is scored', async () => {
    const { request } = setup(
      new Date(Date.now() - 365 * 86_400_000).toISOString(),
    );
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).toBe('scored');
  });

  it.each([
    ['1 second', 1_000],
    ['5 minutes', 5 * 60_000],
    ['1 hour', 3_600_000],
    ['3 days', 3 * 86_400_000],
  ])(
    'a clip captured before the clock rolled back by %s is still delivered (scored) and its permit is not left reserved',
    async (_label, rollbackMs) => {
      const { store, http, request, ref } = setup(
        new Date(Date.now() + rollbackMs).toISOString(),
      );
      const outcome = await runCaptureAnalysis(request);
      const journal = await runJournal.read(store.db, ref);
      const permit = [...http.reservations.values()][0];
      expect({
        kind: outcome.kind,
        cause: outcome.kind === 'unavailable' ? outcome.cause : null,
        journalState: journal?.state ?? null,
        permitOutcome: permit?.outcome ?? null,
        analysisRecords: store.count('local_analysis_record', OWNER_A),
      }).toEqual({
        kind: 'scored',
        cause: null,
        journalState: 'committed',
        permitOutcome: null,
        analysisRecords: 1,
      });
    },
  );

  it.each([
    ['1 second', 1_000],
    ['5 minutes', 5 * 60_000],
    ['3 days', 3 * 86_400_000],
  ])(
    'after a %s rollback the delivered (charged) analysis replays as the same scored result, not as a hold',
    async (_label, rollbackMs) => {
      const { request, http } = setup(
        new Date(Date.now() + rollbackMs).toISOString(),
      );
      const first = await runCaptureAnalysis(request);
      expect(first.kind).toBe('scored');
      const second = await runCaptureAnalysis(request);
      expect(second).toEqual({ ...first, replayed: true });
      expect(http.reservations.size).toBe(1);
    },
  );

  it('control: with a monotonic clock the same replay returns the scored result', async () => {
    const { request } = setup(new Date(Date.now() - 1_000).toISOString());
    const first = await runCaptureAnalysis(request);
    const second = await runCaptureAnalysis(request);
    expect(second).toEqual({ ...first, replayed: true });
  });
});
