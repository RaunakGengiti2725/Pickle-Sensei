/**
 * W05-07 adversary (attack 6): the court-offline branch skips the live
 * completion bookkeeping (permit id, journal commit, original operation
 * finalization). Every attack here drives a SUPPORTED continuation that reads
 * that bookkeeping afterwards and asserts live parity: what a signal-backed
 * run leaves confirmable, replayable or reconcilable, a court-offline run must
 * leave confirmable, replayable or reconcilable too — and an operation paid
 * offline must never be re-reserved live.
 *
 * Attack families:
 *  1. AUTO DETECT abstention on the court (nothing spent) → the pending
 *     technique confirmation must stay confirmable (Library loader, pending
 *     list, offline continuation with the held grant).
 *  2. Signal returns after an app restart → the pending confirmation still
 *     has to become confirmable.
 *  3. Live AUTO abstention → signal lost → offline confirmation → replay of the
 *     paid continuation and the saved-result loader.
 *  4./5. The shipping original path (AnalyzeScreen) with AUTO DETECT on the
 *     court: the operation must finalize the confirmation record so the
 *     in-place confirmation and the Library route can verify it.
 *  6. Explicit "Check saved analysis" on an original paid offline must not
 *     reserve a live permit for that operation.
 *  7. An original low_confidence abstention on the court must be replayable
 *     like its live twin.
 */
import {
  OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
  OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
  OFFLINE_FREE_ALLOCATION_POLICY,
  OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION,
  OFFLINE_GRANT_AUDIENCE,
  OFFLINE_GRANT_JWS_TYPE,
  OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
} from '@pickle/shared-types';
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { CapturedClip } from '../src/camera/capture';
import {
  prepareOriginalCaptureAnalysis,
  reconcileOriginalCaptureAnalysis,
  runCaptureAnalysis,
  runOriginalCaptureAnalysis,
  type RunCaptureAnalysisOutcome,
  type RunCaptureAnalysisRequest,
} from '../src/analysis/runCaptureAnalysis';
import {
  loadSavedOriginalAnalysis,
  OriginalAnalysisExecution,
  originalAnalysisOperations,
} from '../src/analysis/originalAnalysisOperations';
import { loadSavedTechniqueConfirmation } from '../src/analysis/savedTechniqueConfirmation';
import {
  verifyReleasePolicy,
  writeCachedReleasePolicy,
} from '../src/analysis/releasePolicyClient';
import {
  activeReleaseAuthority,
  isReleasePolicyRequest,
} from '../testSupport/releasePolicyFixture';
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';
import {
  parseIssuedOfflineGrant,
  type IssuedOfflineGrant,
} from '../src/data/api';
import { getDb } from '../src/data/db';
import {
  holdOfflineGrant,
  pendingOfflineReceipts,
  readOfflineAllocation,
} from '../src/data/offlineCapabilities';
import { listPendingCaptures } from '../src/data/repository';
import {
  clearSyncRuntime,
  configureSyncRuntime,
  triggerOutboxSync,
} from '../src/data/syncRuntime';
import {
  captureDataOwnerContext,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import type { TrustedTimeReading } from '../src/data/trustedTime';
import {
  closeSqliteTestDatabases,
  createSqliteTestDb,
  seedSqliteCapture,
} from '../testSupport/sqlite';

jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../src/camera/capture', () => ({
  ...jest.requireActual('../src/camera/capture'),
  readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  verifyCapturedClipCurrentBytes: async (clip: CapturedClip) => ({
    status: 'verified-current-bytes',
    comparedExpectation: clip.nativeMediaIdentity,
  }),
}));

let mockReading: TrustedTimeReading | null = null;

jest.mock('../src/data/trustedTime', () => {
  const actual = jest.requireActual<typeof import('../src/data/trustedTime')>(
    '../src/data/trustedTime',
  );
  return {
    ...actual,
    trustedTime: {
      ...actual.trustedTime,
      read: async () => {
        if (!mockReading) throw new Error('trusted time not configured');
        return mockReading;
      },
    },
  };
});

const OWNER = '11111111-1111-4111-8111-111111111111';
const CAPTURE = '33333333-3333-4333-8333-333333333333';
const OPERATION = '44444444-4444-4444-8444-444444444444';
const API_ORIGIN = 'https://api.example.test/functions/v1/api';
const BEARER = 'fresh-owner-token';
const INSTALLATION_KEY = 'ios-install-key-1';
const KEY_ID = 'offline-grant-key-1';
const GRANT_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const TICKETS = [
  'aaaaaaaa-0000-4000-8000-000000000001',
  'aaaaaaaa-0000-4000-8000-000000000002',
] as const;
const ARTIFACT = { version: 'v1', sha256: 'a'.repeat(64) };
const PERMITS_ROUTE = `${API_ORIGIN}/v1/analysis-permits`;
const RECEIPTS_ROUTE = `${API_ORIGIN}/v1/offline/receipts`;
let permitSerial = 0;
function nextLivePermitId(): string {
  permitSerial += 1;
  return `99999999-9999-4999-8999-${String(permitSerial).padStart(12, '0')}`;
}
const NOW_MS = Date.now();
const ISSUED_AT = Math.floor(NOW_MS / 1000) - 60;
const EXPIRES_AT = ISSUED_AT + 6 * 24 * 60 * 60;
const BINDING = { installationKeyId: INSTALLATION_KEY, issuer: API_ORIGIN };
const originalFetch = globalThis.fetch;
let mockReadArtifact: (uri: string) => Promise<string>;

function reading(nowMs = NOW_MS): TrustedTimeReading {
  return {
    authority: 'anchored',
    continuity: 'measured',
    nowMs,
    wallClockMs: nowMs,
    rollbackDetected: false,
    storage: 'loaded',
  };
}

function base64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function grantCompactJws(): string {
  const claims = {
    schemaVersion: OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
    protocolVersion: OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
    iss: API_ORIGIN,
    aud: OFFLINE_GRANT_AUDIENCE,
    sub: OWNER,
    jti: GRANT_ID,
    installationKeyId: INSTALLATION_KEY,
    iat: ISSUED_AT,
    exp: EXPIRES_AT,
    capabilities: ['analyze_joint_output'],
    release: {
      policy: ARTIFACT,
      mechanicsModel: ARTIFACT,
      benchmarkModel: ARTIFACT,
    },
    entitlementSource: 'identity_lifetime_free',
    allocation: {
      schemaVersion: OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION,
      allocationId: GRANT_ID,
      generation: 1,
      ticketIds: TICKETS,
      budgetPolicy: OFFLINE_FREE_ALLOCATION_POLICY.id,
      financialExpiry: 'reconciliation_only',
    },
  };
  const header = { alg: 'ES256', typ: OFFLINE_GRANT_JWS_TYPE, kid: KEY_ID };
  return `${base64Url(JSON.stringify(header))}.${base64Url(
    JSON.stringify(claims),
  )}.${'A'.repeat(86)}`;
}

function issuedGrant(): IssuedOfflineGrant {
  const parsed = parseIssuedOfflineGrant({
    grantId: GRANT_ID,
    generation: 1,
    entitlementSource: 'identity_lifetime_free',
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    entitlementExpiresAt: null,
    ticketIds: TICKETS,
    keyId: KEY_ID,
    grant: {
      schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
      compactJws: grantCompactJws(),
    },
  });
  if (!parsed) throw new Error('fixture grant response must parse');
  return parsed;
}
function signIn() {
  setActiveDataOwner(OWNER);
  establishApiSession({
    canonicalAppUserId: OWNER,
    apiBaseUrl: API_ORIGIN,
    bearerToken: BEARER,
    provider: 'apple',
  });
}

/** A camera capture that AUTO DETECT may rate: automatic pose trigger with
 * full evidence, so a `declaredStroke: null` request reaches the classifier
 * and abstains into `needs_technique_confirmation` (as autoDetectAnalysis
 * pins). */
function autoFixture() {
  const { sequence: dimmed, window } = generateSwingSequence();
  const sidecar = serializePoseSequence(dimmed);
  const clip: CapturedClip = {
    uri: 'file:///private/captures/court-auto.mov',
    durationMs: window.endMs,
    fps: dimmed.video.fps,
    width: dimmed.video.width,
    height: dimmed.video.height,
    capturedAtIso: '2026-09-06T12:00:00.000Z',
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: window.startMs,
      endMs: window.endMs,
      peakMotionMs: window.peakMs,
      confidence: 0.86,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'apple_vision_body_pose',
      poseModelVersion: dimmed.producedBy.modelVersion,
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: dimmed.frames.length,
      poseFrameCount: dimmed.frames.length,
      poseMissingFrameCount: 0,
      trackedDurationMs: window.endMs,
      meanCanonicalJointVisibility: 0.9,
      meanJointCoverage: 0.9,
      minimumJointCoverage: 0.8,
      fullBodyVisibleFrameCount: dimmed.frames.length,
      jointMotion: [
        {
          joint: 'right_wrist',
          sampleCount: 4,
          meanNormalizedPerSecond: 0.6,
          peakNormalizedPerSecond: 1.4,
        },
      ],
    },
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 400,
    postRollMs: 300,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///private/captures/court-auto.pose.json',
      frameCount: dimmed.frames.length,
      sha256: sha256Hex(sidecar),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: dimmed.producedBy.modelVersion,
    },
  };
  return { clip, sidecar };
}

/** The sibling suite's imported clip with every landmark dimmed to
 * `visibility`: a declared-technique run abstains into low_confidence. */
function dimmedImportFixture(visibility: number) {
  const { sequence, window } = generateSwingSequence();
  const dimmed = {
    ...sequence,
    frames: sequence.frames.map(frame => ({
      ...frame,
      confidence: visibility,
      landmarks: frame.landmarks.map(mark => ({ ...mark, visibility })),
    })),
  };
  const sidecar = serializePoseSequence(dimmed);
  const clip: CapturedClip = {
    uri: 'file:///private/captures/court-auto.mov',
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
      uri: 'file:///private/captures/court-dim.pose.json',
      frameCount: dimmed.frames.length,
      sha256: sha256Hex(sidecar),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: dimmed.producedBy.modelVersion,
    },
  };
  return { clip, sidecar };
}

function response(status: number, body: unknown): Response {
  return {
    ok: status < 400,
    status,
    statusText: String(status),
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

interface FetchCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/** The court: `offline` never reaches the service; `online` reserves live
 * permits, acknowledges releases and accepts every receipt. */
function court(signal: 'offline' | 'online') {
  const calls: FetchCall[] = [];
  const fetchPort = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<
        string,
        unknown
      >;
      calls.push({ url, body });
      if (signal === 'offline') throw new TypeError('Network request failed');
      if (isReleasePolicyRequest(url))
        return response(200, activeReleaseAuthority());
      if (url === PERMITS_ROUTE)
        return response(200, {
          permit: {
            id: nextLivePermitId(),
            accessSource: 'free',
            status: 'reserved',
            expiresAt: new Date(NOW_MS + 15 * 60_000).toISOString(),
          },
          access: null,
        });
      if (url.startsWith(`${PERMITS_ROUTE}/`) && url.endsWith('/finalize'))
        return response(200, {
          permit: {
            id: decodeURIComponent(
              url.slice(PERMITS_ROUTE.length + 1, -'/finalize'.length),
            ),
            status: 'released',
            outcome: body.outcome,
          },
          access: null,
        });
      if (url === RECEIPTS_ROUTE) {
        const receipts = (body.receipts ?? []) as Array<
          Record<string, unknown>
        >;
        return response(200, {
          receipts: receipts.map(entry => ({
            receiptId: (entry.receipt as Record<string, unknown>).receiptId,
            status: 'result_recorded',
          })),
          rejected: [],
        });
      }
      return response(404, { error: { code: 'not_found' } });
    },
  );
  globalThis.fetch = fetchPort as unknown as typeof fetch;
  return { calls, fetchPort };
}

function permitPosts(calls: readonly FetchCall[]): FetchCall[] {
  return calls.filter(call => call.url === PERMITS_ROUTE);
}

type Store = ReturnType<typeof createSqliteTestDb>;

async function armWallet(store: Store) {
  mockReading = reading();
  const verified = verifyReleasePolicy(activeReleaseAuthority().policy);
  if (!verified.ok) throw new Error('fixture policy must verify');
  expect(
    await writeCachedReleasePolicy(
      store.db,
      { ownerKey: OWNER, apiOrigin: API_ORIGIN },
      { policy: verified.policy, serverTime: Math.floor(NOW_MS / 1000) },
    ),
  ).toBe(true);
  await holdOfflineGrant(store.db, issuedGrant(), BINDING);
}

async function tickets(store: Store) {
  const allocation = await readOfflineAllocation(store.db, reading());
  return {
    spendable: allocation.spendableTickets,
    consumed: allocation.consumedTickets,
  };
}

function journalRows(store: Store) {
  return store.native
    .prepare(
      `SELECT operation_id, state, release_outcome, permit_id, result_id
       FROM analysis_run_journal WHERE owner_key = ? ORDER BY created_at_ms`,
    )
    .all(OWNER);
}

function attemptRows(store: Store) {
  return store.native
    .prepare(
      `SELECT operation_id, state, release_outcome, permit_id, result_id
       FROM analysis_execution_attempts WHERE owner_key = ?`,
    )
    .all(OWNER);
}

/** Plain-path AUTO DETECT request (the AnalyzeScreen request shape without an
 * original operation). */
async function setupAuto(signal: 'offline' | 'online') {
  const store = createSqliteTestDb();
  const { clip, sidecar } = autoFixture();
  mockReadArtifact = async () => sidecar;
  seedSqliteCapture(store.db, OWNER, CAPTURE, clip);
  await armWallet(store);
  const network = court(signal);
  const request: RunCaptureAnalysisRequest = {
    db: store.db,
    ownerContext: captureDataOwnerContext(),
    operationId: OPERATION,
    captureId: CAPTURE,
    clip,
    declaredStroke: null,
    declaredCanonical: null,
    handedness: 'right',
    cameraView: 'side',
    apiConfig: { baseUrl: API_ORIGIN, token: BEARER },
    appVersion: '0.1.0',
  };
  const load = () =>
    loadSavedTechniqueConfirmation({
      db: store.db,
      ownerContext: captureDataOwnerContext(),
      captureId: CAPTURE,
      apiOrigin: API_ORIGIN,
    });
  return { store, request, network, load };
}

/** The exact-technique confirmation the AnalyzeScreen submits after the user
 * taps a technique: a fresh plain run carrying `techniqueConfirmation`. */
function confirmation(
  request: RunCaptureAnalysisRequest,
  analysisId: string,
): RunCaptureAnalysisRequest {
  const { operationId: _dropped, ...rest } = request;
  return {
    ...rest,
    declaredStroke: 'dink',
    declaredCanonical: 'BACKHAND_DINK',
    techniqueConfirmation: {
      analysisId,
      intent: {
        version: 'technique-intent-v1',
        source: 'tap',
        canonical: 'BACKHAND_DINK',
        legacySlug: 'dink',
        confidence: 1,
      },
      confirmedAtIso: '2026-09-06T18:00:00.000Z',
    },
  };
}

const leases: OriginalAnalysisExecution[] = [];

/** The shipping entry point (AnalyzeScreen → prepareOriginalCaptureAnalysis +
 * runOriginalCaptureAnalysis) with the technique left to AUTO DETECT (or a
 * declared technique when `declared` is set) on a camera clip carrying its
 * native media identity. */
async function setupOriginal(
  signal: 'offline' | 'online',
  options: { declared?: boolean; dimmedImport?: number } = {},
) {
  const store = createSqliteTestDb();
  const { clip: bare, sidecar } =
    options.dimmedImport === undefined
      ? autoFixture()
      : dimmedImportFixture(options.dimmedImport);
  const clip: CapturedClip = {
    ...bare,
    byteSize: 25,
    nativeMediaIdentity: {
      schemaVersion: 1,
      format: 'pickle.native-media-identity.v1',
      receiptId: '66666666-6666-4666-8666-666666666666',
      operationId: '77777777-7777-4777-8777-777777777777',
      origin: 'native_export',
      algorithm: 'sha256',
      videoFileName: 'court-auto.mov',
      byteSize: 25,
      sha256: sha256Hex('synthetic court movie bytes'),
    },
  };
  mockReadArtifact = async () => sidecar;
  seedSqliteCapture(store.db, OWNER, CAPTURE, clip);
  const declaredStroke = options.declared ? 'forehand_drive' : null;
  await store.db.execute(
    'UPDATE local_capture SET declared_stroke = ? WHERE owner_key = ? AND id = ?',
    [declaredStroke, OWNER, CAPTURE],
  );
  await armWallet(store);
  const network = court(signal);
  const execution = new OriginalAnalysisExecution(
    captureDataOwnerContext(),
    API_ORIGIN,
  );
  leases.push(execution);
  const request: RunCaptureAnalysisRequest = {
    db: store.db,
    ownerContext: execution.ownerContext,
    captureId: CAPTURE,
    clip,
    declaredStroke,
    declaredCanonical: options.declared ? 'FOREHAND_DRIVE' : null,
    handedness: 'right',
    cameraView: 'side',
    apiConfig: { baseUrl: API_ORIGIN, token: BEARER },
    appVersion: '0.1.0',
  };
  const prepare = () =>
    prepareOriginalCaptureAnalysis(request, execution, OPERATION);
  const run = async (): Promise<RunCaptureAnalysisOutcome> => {
    const operation = await prepare();
    return runOriginalCaptureAnalysis({
      db: store.db,
      execution,
      operationId: operation.operationId,
    });
  };
  const loadOriginal = () =>
    loadSavedOriginalAnalysis({
      db: store.db,
      ownerContext: execution.ownerContext,
      captureId: CAPTURE,
      apiOrigin: API_ORIGIN,
    });
  return { store, run, prepare, execution, network, request, loadOriginal };
}

/** Signal back after an app restart: the shipping sync runtime's sweep. */
async function reconnectSweep(store: Store) {
  const online = court('online');
  (getDb as jest.Mock).mockReturnValue(store.db);
  configureSyncRuntime({
    apiBaseUrl: API_ORIGIN,
    bearerToken: BEARER,
    canonicalAppUserId: OWNER,
    provider: 'apple',
  });
  await triggerOutboxSync();
  return online;
}

beforeEach(() => {
  signIn();
});
afterEach(() => {
  clearSyncRuntime();
  for (const lease of leases.splice(0)) lease.dispose();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  globalThis.fetch = originalFetch;
  mockReading = null;
  (getDb as jest.Mock).mockReset();
  jest.restoreAllMocks();
  closeSqliteTestDatabases();
});

describe('attack 1: court-offline AUTO DETECT abstention must stay confirmable', () => {
  it('the pending confirmation loads as ready and the Library does not mark it blocked', async () => {
    const { store, request, load } = await setupAuto('offline');
    const first = await runCaptureAnalysis(request);
    expect(first.kind).toBe('needs_technique_confirmation');
    // The abstention spent nothing — the invariant the package protects.
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);

    // Live parity: after a signal-backed AUTO abstention the saved
    // confirmation is `ready` (autoDetectAnalysis pins it). A court-offline
    // abstention is the same durable record and must be equally confirmable.
    const loaded = await load();
    expect(['ready', 'release_pending']).toContain(loaded.kind);
    const pending = await listPendingCaptures(store.db);
    expect(pending.map(capture => capture.techniqueConfirmation)).toEqual([
      expect.stringMatching(/^(ready|release_pending)$/),
    ]);
  });

  it('confirming the technique on the same court (still offline, held grant) rates it and spends one ticket', async () => {
    const { store, request } = await setupAuto('offline');
    const first = await runCaptureAnalysis(request);
    expect(first.kind).toBe('needs_technique_confirmation');
    if (first.kind !== 'needs_technique_confirmation') return;

    const confirmed = await runCaptureAnalysis(
      confirmation(request, first.analysisId),
    );
    expect(confirmed.kind).toBe('scored');
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    const receipts = await pendingOfflineReceipts(store.db);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.grantId).toBe(GRANT_ID);
  });
});

describe('attack 2: app restart + signal restored after a court-offline AUTO abstention', () => {
  it('the sweep leaves the confirmation confirmable and the live continuation scores', async () => {
    const { store, request, load } = await setupAuto('offline');
    const first = await runCaptureAnalysis(request);
    expect(first.kind).toBe('needs_technique_confirmation');
    if (first.kind !== 'needs_technique_confirmation') return;

    const online = await reconnectSweep(store);
    const loaded = await load();
    expect(loaded.kind).toBe('ready');
    const pending = await listPendingCaptures(store.db);
    expect(pending.map(capture => capture.techniqueConfirmation)).toEqual([
      'ready',
    ]);
    const confirmed = await runCaptureAnalysis(
      confirmation(request, first.analysisId),
    );
    expect(confirmed.kind).toBe('scored');
    // With signal the confirmation is a LIVE rating: a permit, not a ticket.
    expect(permitPosts(online.calls).length).toBeGreaterThanOrEqual(1);
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
  });
});

describe('attack 3: live AUTO abstention, then the signal drops before the user confirms', () => {
  it('the offline confirmation is a paid read; its replay is the same rating and the loader reports it completed', async () => {
    const { store, request, load } = await setupAuto('online');
    const first = await runCaptureAnalysis(request);
    expect(first.kind).toBe('needs_technique_confirmation');
    if (first.kind !== 'needs_technique_confirmation') return;
    expect((await load()).kind).toBe('ready');

    court('offline');
    const confirm = confirmation(request, first.analysisId);
    const confirmed = await runCaptureAnalysis(confirm);
    expect(confirmed.kind).toBe('scored');
    if (confirmed.kind !== 'scored') return;
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);

    // Live parity (autoDetectAnalysis: a repeated selection replays the
    // committed continuation). The replay is the same paid rating and never a
    // second spend.
    const replay = await runCaptureAnalysis(confirm);
    expect(replay).toMatchObject({
      kind: 'scored',
      replayed: true,
      analysisId: confirmed.analysisId,
    });
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    // And the saved-result loader sees a completed confirmation, not corrupt.
    const loaded = await load();
    expect(loaded.kind).toBe('already_completed');
    expect(journalRows(store)).toHaveLength(2);
  });
});

describe('attack 4: shipping original path, AUTO DETECT on the court', () => {
  it('the operation finalizes the confirmation record so AnalyzeScreen can confirm it in place', async () => {
    const { store, run, execution } = await setupOriginal('offline');
    const first = await run();
    expect(first.kind).toBe('needs_technique_confirmation');
    if (first.kind !== 'needs_technique_confirmation') return;
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });

    // AnalyzeScreen's in-place confirmation requires the original operation to
    // point at the pending confirmation record (finalRecordId === analysisId,
    // completionKind === 'needs_technique_confirmation'); otherwise it throws
    // 'The original saved confirmation could not be verified.' — exactly what
    // a signal-backed AUTO abstention on this path leaves behind.
    const operation = await originalAnalysisOperations.read(
      store.db,
      execution,
      OPERATION,
    );
    expect(operation).toMatchObject({
      finalRecordId: first.analysisId,
      completionKind: 'needs_technique_confirmation',
    });
  });

  it('the Library route (loadSavedOriginalAnalysis) delegates to the saved confirmation instead of reporting corrupt evidence', async () => {
    const { run, loadOriginal } = await setupOriginal('offline');
    const first = await run();
    expect(first.kind).toBe('needs_technique_confirmation');
    const loaded = await loadOriginal();
    expect(loaded.kind).toBe('load_result');
  });
});

describe('attack 5: process death, then signal, after a court-offline original AUTO abstention', () => {
  it('the reconnect sweep must leave the original confirmable from the Library', async () => {
    const { store, run, loadOriginal, execution } =
      await setupOriginal('offline');
    const first = await run();
    expect(first.kind).toBe('needs_technique_confirmation');
    if (first.kind !== 'needs_technique_confirmation') return;

    await reconnectSweep(store);
    const operation = await originalAnalysisOperations.read(
      store.db,
      execution,
      OPERATION,
    );
    expect(operation?.finalRecordId).toBe(first.analysisId);
    const loaded = await loadOriginal();
    expect(loaded.kind).toBe('load_result');
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
  });
});

describe('attack 6: "Check saved analysis" on an original that was paid offline', () => {
  it('a concurrent second submit is answered with recovery, and the explicit reconcile must not reserve a live permit for the paid operation', async () => {
    const { store, prepare, execution, network } = await setupOriginal(
      'offline',
      { declared: true },
    );
    const operation = await prepare();
    const runOnce = () =>
      runOriginalCaptureAnalysis({
        db: store.db,
        execution,
        operationId: operation.operationId,
      });
    // Double submit on the court: exactly one paid rating.
    const [a, b] = await Promise.all([runOnce(), runOnce()]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toContain('scored');
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(permitPosts(network.calls).length).toBeGreaterThanOrEqual(1);
    // The loser (if any) surfaced as recovery — that is the path on which
    // AnalyzeScreen offers "Check saved analysis" (reconcile_saved).
    const loser = [a, b].find(outcome => outcome.kind !== 'scored');
    if (loser)
      expect(loser).toMatchObject({
        kind: 'unavailable',
        cause: 'recovery_pending',
      });

    // Signal returns and the user taps Check. The operation is already paid
    // by its receipt: the reconcile must not reserve a live permit for it.
    const online = court('online');
    await reconcileOriginalCaptureAnalysis({
      db: store.db,
      execution,
      operationId: operation.operationId,
    });
    expect(permitPosts(online.calls)).toHaveLength(0);
    expect(attemptRows(store)).toEqual([
      expect.objectContaining({ permit_id: null }),
    ]);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
  });
});

describe('attack 7: court-offline original low_confidence abstention', () => {
  it('spends nothing and replays like its live twin instead of falling into recovery', async () => {
    const { store, run, execution } = await setupOriginal('offline', {
      declared: true,
      dimmedImport: 0.5,
    });
    const first = await run();
    expect(first.kind).toBe('low_confidence');
    if (first.kind !== 'low_confidence') return;
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);

    // Live parity: a signal-backed low_confidence run finalizes the operation
    // (completionKind 'low_confidence') and every later run() replays it.
    const replay = await run();
    expect(replay).toMatchObject({
      kind: 'low_confidence',
      analysisId: first.analysisId,
      replayed: true,
    });
    const operation = await originalAnalysisOperations.read(
      store.db,
      execution,
      OPERATION,
    );
    expect(operation?.finalRecordId).toBe(first.analysisId);
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
  });
});

describe('control: the same continuations with signal (the parity the attacks assert)', () => {
  it('live AUTO abstention on the original path finalizes the confirmation and the Library loads it', async () => {
    const { store, run, execution, loadOriginal } =
      await setupOriginal('online');
    const first = await run();
    expect(first.kind).toBe('needs_technique_confirmation');
    if (first.kind !== 'needs_technique_confirmation') return;
    const operation = await originalAnalysisOperations.read(
      store.db,
      execution,
      OPERATION,
    );
    expect(operation).toMatchObject({
      finalRecordId: first.analysisId,
      completionKind: 'needs_technique_confirmation',
    });
    expect((await loadOriginal()).kind).toBe('load_result');
  });

  it('live low_confidence abstention on the original path replays', async () => {
    const { store, run, execution } = await setupOriginal('online', {
      declared: true,
      dimmedImport: 0.5,
    });
    const first = await run();
    expect(first.kind).toBe('low_confidence');
    if (first.kind !== 'low_confidence') return;
    const replay = await run();
    expect(replay).toMatchObject({
      kind: 'low_confidence',
      analysisId: first.analysisId,
      replayed: true,
    });
    const operation = await originalAnalysisOperations.read(
      store.db,
      execution,
      OPERATION,
    );
    expect(operation?.finalRecordId).toBe(first.analysisId);
  });

  it('live AUTO abstention on the plain path: loader ready, live confirmation scores and replays', async () => {
    const { store, request, load } = await setupAuto('online');
    const first = await runCaptureAnalysis(request);
    expect(first.kind).toBe('needs_technique_confirmation');
    if (first.kind !== 'needs_technique_confirmation') return;
    expect((await load()).kind).toBe('ready');
    const pending = await listPendingCaptures(store.db);
    expect(pending.map(capture => capture.techniqueConfirmation)).toEqual([
      'ready',
    ]);
    const confirm = confirmation(request, first.analysisId);
    const confirmed = await runCaptureAnalysis(confirm);
    expect(confirmed.kind).toBe('scored');
    if (confirmed.kind !== 'scored') return;
    const replay = await runCaptureAnalysis(confirm);
    expect(replay).toMatchObject({
      kind: 'scored',
      replayed: true,
      analysisId: confirmed.analysisId,
    });
    expect((await load()).kind).toBe('already_completed');
  });
});
