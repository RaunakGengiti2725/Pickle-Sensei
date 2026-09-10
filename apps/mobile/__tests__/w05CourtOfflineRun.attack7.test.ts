/**
 * W05-07 adversary (attack 7, independent). Every attack drives a SUPPORTED
 * continuation of a court-offline rating (Library open, AnalyzeScreen replay,
 * reconnect sweep, receipt drain, Result evidence) after something the
 * candidate does not control happened underneath it — a persisted payload
 * that is only shallowly valid, an account switch while a presentation is in
 * the air, a re-sign-in of the same account, a practice set, a server that
 * answers the receipt route with a budget or a captive page — and asserts
 * money conservation plus honest, typed outcomes (never a raw TypeError, never
 * a second spend, never a second receipt, never a fabricated settlement).
 *
 * Attack families:
 *  1. Corrupt persisted state (original path): the paid rating's local_shot
 *     payload is rewritten to a shallowly valid object (`id` + `resultKind`
 *     match) that is not a rating → Library load, replay, reconnect sweep and
 *     drain must stay honest and typed.
 *  2. The same corruption on the plain runCaptureAnalysis path.
 *  3. Account switch (sign-out) while the receipt presentation is in flight →
 *     nothing settles under the wrong owner; the re-signed-in owner
 *     re-presents the SAME receipt id and settles once.
 *  4. Re-sign-in of the SAME account (new owner generation) after a paid
 *     court-offline read → the paid rating stays loadable, the replay never
 *     spends, the drain settles once and Result shows it synced.
 *  5. Practice set on the court: the set's session.create row is the only
 *     outbox row; no shot.sync row; a second read in the same set resumes it,
 *     spends the last ticket and reports the free limit.
 *  6. Free-rating conservation: two DIFFERENT operation ids for the same
 *     capture on the court never spend two tickets.
 *  7. The receipt route answers 429 + Retry-After, then a captive-portal HTML
 *     200, then a well-formed acceptance → HOLD, HOLD, settled once under the
 *     same receipt id; the Result surface tracks each state truthfully.
 *  8. Boundary value: the receipt route refuses with a 20,000-character
 *     non-code string → the refusal code that reaches the Result copy must be
 *     bounded and code-shaped.
 *  9. Far-future clock: the lease expires long before the signal returns →
 *     the paid rating stays durable, replays without a second spend and its
 *     receipt still settles.
 * 10. Refused receipt, then the user taps analyze again → the durable read
 *     replays; no live permit, no second receipt.
 * 11. A practice set whose first court read abstains → nothing spent; the
 *     scored read that follows spends exactly one ticket.
 * 12. A court-offline low_confidence abstention on the plain path replayed
 *     under the same operation id → live parity of the answer; the reconnect
 *     sweep spends nothing.
 * 13. AUTO DETECT abstains, the user confirms a technique on the court and the
 *     confirmation abstains (low_confidence) → the saved-result loader and
 *     the replay must answer as the live path does; after the signal returns
 *     the re-run recovers it without spending.
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
  runCaptureAnalysis,
  runOriginalCaptureAnalysis,
  type RunCaptureAnalysisOutcome,
  type RunCaptureAnalysisRequest,
} from '../src/analysis/runCaptureAnalysis';
import {
  loadSavedOriginalAnalysis,
  OriginalAnalysisExecution,
} from '../src/analysis/originalAnalysisOperations';
import { planPracticeSet } from '../src/analysis/practiceSet';
import { RunJournalError } from '../src/analysis/runJournal';
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
  createOfflineGrantClient,
  parseIssuedOfflineGrant,
  type IssuedOfflineGrant,
} from '../src/data/api';
import { getDb } from '../src/data/db';
import {
  holdOfflineGrant,
  pendingOfflineReceipts,
  readOfflineAllocation,
} from '../src/data/offlineCapabilities';
import {
  readOfflineReceiptEvidence,
  reconcileOfflineWallet,
} from '../src/data/offlineWallet';
import { hasShotSyncReceipt } from '../src/data/repository';
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
const OTHER = '22222222-2222-4222-8222-222222222222';
const CAPTURE = '33333333-3333-4333-8333-333333333333';
const CAPTURE_2 = '33333333-3333-4333-8333-333333333334';
const OPERATION = '44444444-4444-4444-8444-444444444444';
const OPERATION_2 = '44444444-4444-4444-8444-444444444445';
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

function signIn(owner = OWNER) {
  setActiveDataOwner(owner);
  establishApiSession({
    canonicalAppUserId: owner,
    apiBaseUrl: API_ORIGIN,
    bearerToken: BEARER,
    provider: 'apple',
  });
}

function signOut() {
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
}

/** A declared-technique camera capture the on-device engine rates. */
function scoredFixture(uri = 'file:///private/captures/court.mov') {
  const { sequence, window } = generateSwingSequence();
  const sidecar = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri,
    durationMs: window.endMs,
    fps: sequence.video.fps,
    width: sequence.video.width,
    height: sequence.video.height,
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
      poseModelVersion: sequence.producedBy.modelVersion,
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: sequence.frames.length,
      poseFrameCount: sequence.frames.length,
      poseMissingFrameCount: 0,
      trackedDurationMs: window.endMs,
      meanCanonicalJointVisibility: 0.9,
      meanJointCoverage: 0.9,
      minimumJointCoverage: 0.8,
      fullBodyVisibleFrameCount: sequence.frames.length,
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
      uri: `${uri}.pose.json`,
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecar),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
  };
  return { clip, sidecar };
}

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status < 400,
    status,
    statusText: String(status),
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    json: async () => {
      if (typeof body === 'string') throw new SyntaxError('Unexpected token <');
      return body;
    },
  } as unknown as Response;
}

interface FetchCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

type ReceiptAnswer = (
  call: FetchCall,
) => Response | Promise<Response> | undefined;

/** The court: `offline` never reaches the service; `online` reserves live
 * permits, acknowledges releases and accepts every receipt unless
 * `receiptAnswer` overrides the receipt route for a call. */
function court(signal: 'offline' | 'online', receiptAnswer?: ReceiptAnswer) {
  const calls: FetchCall[] = [];
  let permitSerial = 0;
  const fetchPort = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<
        string,
        unknown
      >;
      const call: FetchCall = { url, body };
      calls.push(call);
      if (signal === 'offline') throw new TypeError('Network request failed');
      if (isReleasePolicyRequest(url))
        return response(200, activeReleaseAuthority());
      if (url === PERMITS_ROUTE) {
        permitSerial += 1;
        return response(200, {
          permit: {
            id: `99999999-9999-4999-8999-${String(permitSerial).padStart(12, '0')}`,
            accessSource: 'free',
            status: 'reserved',
            expiresAt: new Date(NOW_MS + 15 * 60_000).toISOString(),
          },
          access: null,
        });
      }
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
        const overridden = await receiptAnswer?.(call);
        if (overridden) return overridden;
        return acceptAll(call);
      }
      if (url === `${API_ORIGIN}/v1/sessions`)
        return response(200, { ok: true });
      return response(404, { error: { code: 'not_found' } });
    },
  );
  globalThis.fetch = fetchPort as unknown as typeof fetch;
  return { calls, fetchPort };
}

function presentedReceiptIds(call: FetchCall): string[] {
  const receipts = (call.body.receipts ?? []) as Array<Record<string, unknown>>;
  return receipts.map(
    entry => (entry.receipt as Record<string, unknown>).receiptId as string,
  );
}

function acceptAll(call: FetchCall): Response {
  return response(200, {
    receipts: presentedReceiptIds(call).map(receiptId => ({
      receiptId,
      status: 'result_recorded',
    })),
    rejected: [],
  });
}

function receiptPosts(calls: readonly FetchCall[]): FetchCall[] {
  return calls.filter(call => call.url === RECEIPTS_ROUTE);
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

function offlineClient() {
  return createOfflineGrantClient({ baseUrl: API_ORIGIN, token: BEARER });
}

function countRows(store: Store, sql: string, ...params: string[]): number {
  const row = store.native.prepare(sql).get(...params) as { n: number };
  return row.n;
}

function outboxKinds(store: Store, owner = OWNER): string[] {
  return (
    store.native
      .prepare(`SELECT kind FROM outbox WHERE owner_key = ? ORDER BY id`)
      .all(owner) as Array<{ kind: string }>
  ).map(row => row.kind);
}

function syncReceipts(store: Store, owner = OWNER): number {
  return countRows(
    store,
    `SELECT COUNT(*) AS n FROM sync_receipt WHERE owner_key = ? AND kind = 'shot.sync'`,
    owner,
  );
}

function offlineReceiptRows(store: Store, owner = OWNER) {
  return store.native
    .prepare(
      `SELECT receipt_id, settlement FROM offline_receipt WHERE owner_key = ? ORDER BY receipt_id`,
    )
    .all(owner) as Array<{ receipt_id: string; settlement: string | null }>;
}

/** Rewrite the paid rating's persisted payload to an object that passes the
 * shallow `id` / `resultKind` / `source` checks but is not a rating (no
 * checkpoints, no version vector, no timestamps). */
function corruptShotPayload(store: Store, analysisId: string) {
  const changed = store.native
    .prepare(
      `UPDATE local_shot SET payload = ? WHERE owner_key = ? AND id = ? AND result_kind = 'scored'`,
    )
    .run(
      JSON.stringify({ id: analysisId, resultKind: 'scored', source: 'real' }),
      OWNER,
      analysisId,
    );
  expect(changed.changes).toBe(1);
}

function plainRequest(
  store: Store,
  clip: CapturedClip,
  overrides: Partial<RunCaptureAnalysisRequest> = {},
): RunCaptureAnalysisRequest {
  return {
    db: store.db,
    ownerContext: captureDataOwnerContext(),
    operationId: OPERATION,
    captureId: CAPTURE,
    clip,
    declaredStroke: 'forehand_drive',
    declaredCanonical: 'FOREHAND_DRIVE',
    handedness: 'right',
    cameraView: 'side',
    apiConfig: { baseUrl: API_ORIGIN, token: BEARER },
    appVersion: '0.1.0',
    ...overrides,
  };
}

async function setupPlain(signal: 'offline' | 'online') {
  const store = createSqliteTestDb();
  const { clip, sidecar } = scoredFixture();
  mockReadArtifact = async () => sidecar;
  seedSqliteCapture(store.db, OWNER, CAPTURE, clip);
  await armWallet(store);
  const network = court(signal);
  return { store, clip, network, request: plainRequest(store, clip) };
}

const leases: OriginalAnalysisExecution[] = [];

/** The shipping entry point (AnalyzeScreen → prepareOriginalCaptureAnalysis +
 * runOriginalCaptureAnalysis) with a declared technique. */
async function setupOriginal(signal: 'offline' | 'online') {
  const store = createSqliteTestDb();
  const { clip: bare, sidecar } = scoredFixture();
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
      videoFileName: 'court.mov',
      byteSize: 25,
      sha256: sha256Hex('synthetic court movie bytes'),
    },
  };
  mockReadArtifact = async () => sidecar;
  seedSqliteCapture(store.db, OWNER, CAPTURE, clip);
  await store.db.execute(
    'UPDATE local_capture SET declared_stroke = ? WHERE owner_key = ? AND id = ?',
    ['forehand_drive', OWNER, CAPTURE],
  );
  await armWallet(store);
  const network = court(signal);
  const newExecution = () => {
    const execution = new OriginalAnalysisExecution(
      captureDataOwnerContext(),
      API_ORIGIN,
    );
    leases.push(execution);
    return execution;
  };
  const request = (execution: OriginalAnalysisExecution) =>
    plainRequest(store, clip, {
      ownerContext: execution.ownerContext,
      operationId: undefined,
    });
  const run = async (
    execution = newExecution(),
  ): Promise<RunCaptureAnalysisOutcome> => {
    const operation = await prepareOriginalCaptureAnalysis(
      request(execution),
      execution,
      OPERATION,
    );
    return runOriginalCaptureAnalysis({
      db: store.db,
      execution,
      operationId: operation.operationId,
    });
  };
  const loadOriginal = (execution = newExecution()) =>
    loadSavedOriginalAnalysis({
      db: store.db,
      ownerContext: execution.ownerContext,
      captureId: CAPTURE,
      apiOrigin: API_ORIGIN,
    });
  return { store, clip, run, network, loadOriginal, newExecution };
}

/** Signal back after an app restart: the shipping sync runtime's sweep. */
async function reconnectSweep(store: Store, receiptAnswer?: ReceiptAnswer) {
  const online = court('online', receiptAnswer);
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

async function paidOffline(
  store: Store,
  outcome: RunCaptureAnalysisOutcome,
): Promise<string> {
  expect(outcome.kind).toBe('scored');
  if (outcome.kind !== 'scored') throw new Error('unreachable');
  expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
  expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
  expect(outboxKinds(store)).toEqual([]);
  return outcome.analysisId;
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

describe('attack 1: shallowly valid but non-rating local_shot payload under a paid ORIGINAL court read', () => {
  it('Library load, replay, reconnect sweep and drain stay typed and honest; nothing is spent twice', async () => {
    const { store, run, loadOriginal, network } =
      await setupOriginal('offline');
    const analysisId = await paidOffline(store, await run());
    const [receipt] = await pendingOfflineReceipts(store.db);
    if (!receipt) throw new Error('unreachable');
    corruptShotPayload(store, analysisId);

    // The Library opens the capture: a corrupt product is an honest
    // unavailable, never an exception escaping to the screen.
    const loaded = await loadOriginal();
    expect(loaded.kind).toBe('unavailable');

    // The user taps analyze again on the same court: still no signal. The
    // replay must be a typed outcome — the receipt already paid for THIS
    // operation, so a second spend or a second receipt is a money bug, and a
    // raw TypeError is a crash on a supported path.
    const permitsBeforeReplay = permitPosts(network.calls).length;
    let replay: RunCaptureAnalysisOutcome | { thrown: unknown };
    try {
      replay = await run();
    } catch (error) {
      replay = { thrown: error };
    }
    expect(replay).not.toHaveProperty('thrown');
    if ('thrown' in replay) return;
    expect(['scored', 'unavailable']).toContain(replay.kind);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(offlineReceiptRows(store)).toEqual([
      { receipt_id: receipt.receiptId, settlement: null },
    ]);
    // A paid operation is never re-reserved (the court is offline anyway, but
    // the attempt itself would be the bug).
    expect(permitPosts(network.calls).length).toBe(permitsBeforeReplay);

    // Signal returns: the sweep must not reserve a live permit for the paid
    // operation, and the drain presents the receipt WITHOUT inventing an
    // output the device no longer holds.
    const online = await reconnectSweep(store);
    expect(permitPosts(online.calls)).toHaveLength(0);
    const presented = receiptPosts(online.calls);
    expect(presented).toHaveLength(1);
    const [entry] = (presented[0]?.body.receipts ?? []) as Array<
      Record<string, unknown>
    >;
    expect(entry?.output).toBeNull();
    expect((entry?.receipt as Record<string, unknown>).receiptId).toBe(
      receipt.receiptId,
    );
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
  });
});

describe('attack 2: the same shallow corruption under a paid PLAIN court read', () => {
  it('the replay is typed, spends nothing and queues no second receipt', async () => {
    const { store, request, network } = await setupPlain('offline');
    const analysisId = await paidOffline(
      store,
      await runCaptureAnalysis(request),
    );
    const [receipt] = await pendingOfflineReceipts(store.db);
    if (!receipt) throw new Error('unreachable');
    corruptShotPayload(store, analysisId);

    // The candidate's documented contract for a broken replay link on the
    // plain path is a TYPED RunJournalError('identity_conflict') that the
    // screen renders as an error (never a scored rating, never a TypeError).
    const permitsBeforeReplay = permitPosts(network.calls).length;
    let replay: RunCaptureAnalysisOutcome | { thrown: unknown };
    try {
      replay = await runCaptureAnalysis(request);
    } catch (error) {
      replay = { thrown: error };
    }
    if ('thrown' in replay) {
      expect(replay.thrown).toBeInstanceOf(RunJournalError);
      expect(replay.thrown).toMatchObject({ code: 'identity_conflict' });
    } else {
      expect(replay.kind).toBe('unavailable');
    }
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(offlineReceiptRows(store)).toEqual([
      { receipt_id: receipt.receiptId, settlement: null },
    ]);
    expect(permitPosts(network.calls).length).toBe(permitsBeforeReplay);
    // Result still names the receipt truthfully.
    expect(await readOfflineReceiptEvidence(store.db, analysisId)).toEqual({
      kind: 'queued',
    });
  });
});

describe('attack 3: the account signs out while the receipt presentation is in the air', () => {
  it('nothing settles under the wrong owner; the re-signed-in owner re-presents the SAME receipt id and settles once', async () => {
    const { store, request } = await setupPlain('offline');
    const analysisId = await paidOffline(
      store,
      await runCaptureAnalysis(request),
    );
    const [receipt] = await pendingOfflineReceipts(store.db);
    if (!receipt) throw new Error('unreachable');

    // The answer arrives after the device switched to another account.
    const first = court('online', call => {
      signOut();
      signIn(OTHER);
      return acceptAll(call);
    });
    let drained: unknown;
    try {
      drained = await reconcileOfflineWallet(
        store.db,
        offlineClient(),
        reading(),
      );
    } catch (error) {
      drained = { thrown: error };
    }
    expect(receiptPosts(first.calls).map(presentedReceiptIds)).toEqual([
      [receipt.receiptId],
    ]);
    // Whatever the reconcile reported, the durable state is what matters:
    // OWNER's receipt is not settled by a transaction fenced to the switched
    // owner, OTHER never gains a shot.sync receipt, and nothing was dropped.
    expect(syncReceipts(store, OTHER)).toBe(0);
    expect(offlineReceiptRows(store, OTHER)).toEqual([]);
    expect(offlineReceiptRows(store)).toHaveLength(1);
    expect(drained).toBeDefined();

    // OWNER signs back in: the presentation is either already settled (the
    // answer was recorded before the switch was observed) or a HOLD that is
    // re-presented under the same receipt id — never a new receipt, never a
    // second consumption.
    signOut();
    signIn(OWNER);
    const second = court('online');
    await reconcileOfflineWallet(store.db, offlineClient(), reading());
    for (const call of receiptPosts(second.calls))
      expect(presentedReceiptIds(call)).toEqual([receipt.receiptId]);
    expect(offlineReceiptRows(store)).toEqual([
      { receipt_id: receipt.receiptId, settlement: 'accepted' },
    ]);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(syncReceipts(store)).toBe(1);
    expect(await hasShotSyncReceipt(store.db, analysisId)).toBe(true);
    expect(syncReceipts(store, OTHER)).toBe(0);
  });
});

describe('attack 4: the same account signs out and back in (new owner generation) after a paid court read', () => {
  it('original path: the Library still opens it, the replay never spends, the drain settles once and Result shows synced', async () => {
    const { store, run, loadOriginal } = await setupOriginal('offline');
    const analysisId = await paidOffline(store, await run());
    const [receipt] = await pendingOfflineReceipts(store.db);
    if (!receipt) throw new Error('unreachable');

    signOut();
    signIn(OWNER);
    court('offline');
    // The paid rating is this account's durable product.
    expect((await loadOriginal()).kind).toBe('load_result');
    const replay = await run();
    expect(replay).toMatchObject({
      kind: 'scored',
      replayed: true,
      analysisId,
    });
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);

    const online = await reconnectSweep(store);
    expect(permitPosts(online.calls)).toHaveLength(0);
    expect(receiptPosts(online.calls).map(presentedReceiptIds)).toEqual([
      [receipt.receiptId],
    ]);
    expect(await hasShotSyncReceipt(store.db, analysisId)).toBe(true);
    expect(await readOfflineReceiptEvidence(store.db, analysisId)).toEqual({
      kind: 'accepted',
    });
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
  });

  it('plain path: the replay after the re-sign-in returns the durable paid rating without a second spend', async () => {
    const { store, request } = await setupPlain('offline');
    const analysisId = await paidOffline(
      store,
      await runCaptureAnalysis(request),
    );
    signOut();
    signIn(OWNER);
    court('offline');
    const replay = await runCaptureAnalysis({
      ...request,
      ownerContext: captureDataOwnerContext(),
    });
    expect(replay).toMatchObject({
      kind: 'scored',
      replayed: true,
      analysisId,
    });
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(outboxKinds(store)).toEqual([]);
  });
});

describe('attack 5: a practice set on the court', () => {
  it('the set session is the only outbox row (no shot.sync), the second read resumes the set, spends the last ticket and reports the free limit', async () => {
    const { store, clip, network } = await setupPlain('offline');
    const plan = await planPracticeSet(store.db, {
      shotType: 'forehand_drive',
      nowIso: '2026-09-06T12:00:00.000Z',
    });
    if (!plan) throw new Error('signed-in owner must plan a set');
    expect(plan.resumed).toBe(false);
    const first = await runCaptureAnalysis(
      plainRequest(store, clip, {
        sessionId: plan.sessionId,
        practiceSet: plan,
      }),
    );
    expect(first).toMatchObject({ kind: 'scored', freeLimitReached: false });
    if (first.kind !== 'scored') return;
    expect(outboxKinds(store)).toEqual(['session.create']);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    const shot = store.native
      .prepare(
        `SELECT session_id FROM local_shot WHERE owner_key = ? AND id = ?`,
      )
      .get(OWNER, first.analysisId) as { session_id: string };
    expect(shot.session_id).toBe(plan.sessionId);

    // Second capture in the same set, still on the court.
    const { clip: clip2, sidecar: sidecar2 } = scoredFixture(
      'file:///private/captures/court-2.mov',
    );
    mockReadArtifact = async () => sidecar2;
    seedSqliteCapture(store.db, OWNER, CAPTURE_2, clip2);
    const resumed = await planPracticeSet(store.db, {
      shotType: 'forehand_drive',
      nowIso: '2026-09-06T12:05:00.000Z',
    });
    if (!resumed) throw new Error('signed-in owner must plan a set');
    expect(resumed).toMatchObject({ resumed: true, sessionId: plan.sessionId });
    const second = await runCaptureAnalysis(
      plainRequest(store, clip2, {
        operationId: OPERATION_2,
        captureId: CAPTURE_2,
        sessionId: resumed.sessionId,
        practiceSet: resumed,
      }),
    );
    expect(second).toMatchObject({ kind: 'scored', freeLimitReached: true });
    if (second.kind !== 'scored') return;
    expect(second.analysisId).not.toBe(first.analysisId);
    expect(outboxKinds(store)).toEqual(['session.create']);
    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 2 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(2);
    expect(
      countRows(
        store,
        `SELECT COUNT(*) AS n FROM local_session WHERE owner_key = ?`,
        OWNER,
      ),
    ).toBe(1);
    expect(permitPosts(network.calls).length).toBeGreaterThanOrEqual(2);

    // Signal returns: the sweep syncs the session row, presents both
    // receipts and marks both shots synced; no shot.sync row ever existed.
    const online = await reconnectSweep(store);
    expect(permitPosts(online.calls)).toHaveLength(0);
    expect(
      receiptPosts(online.calls).flatMap(presentedReceiptIds).sort(),
    ).toEqual(
      offlineReceiptRows(store)
        .map(row => row.receipt_id)
        .sort(),
    );
    expect(offlineReceiptRows(store)).toHaveLength(2);
    expect(await hasShotSyncReceipt(store.db, first.analysisId)).toBe(true);
    expect(await hasShotSyncReceipt(store.db, second.analysisId)).toBe(true);
    expect(outboxKinds(store)).toEqual([]);
    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 2 });
  });
});

describe('attack 6: two DIFFERENT operation ids for the same capture on the court', () => {
  it('shipping original path: a second prepare of the same capture under a new operation id joins the paid operation; one ticket, one receipt', async () => {
    const { store, clip, run, newExecution, network } =
      await setupOriginal('offline');
    const analysisId = await paidOffline(store, await run());
    const execution = newExecution();
    const operation = await prepareOriginalCaptureAnalysis(
      plainRequest(store, clip, {
        ownerContext: execution.ownerContext,
        operationId: undefined,
      }),
      execution,
      OPERATION_2,
    );
    expect(operation.operationId).toBe(OPERATION);
    const replay = await runOriginalCaptureAnalysis({
      db: store.db,
      execution,
      operationId: operation.operationId,
    });
    expect(replay).toMatchObject({
      kind: 'scored',
      replayed: true,
      analysisId,
    });
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(permitPosts(network.calls)).toHaveLength(1);
  });

  it('plain path (documented observation): the operation id is the unit of payment offline exactly as the permit is live — two ids for one capture spend twice on BOTH courts', async () => {
    const offline = await setupPlain('offline');
    const [a, b] = await Promise.all([
      runCaptureAnalysis(offline.request),
      runCaptureAnalysis({ ...offline.request, operationId: OPERATION_2 }),
    ]);
    expect([a.kind, b.kind]).toEqual(['scored', 'scored']);
    const offlineSpend = await tickets(offline.store);
    const offlineReceipts = (await pendingOfflineReceipts(offline.store.db))
      .length;

    // Control: the live court with the same two operation ids.
    closeSqliteTestDatabases();
    const live = await setupPlain('online');
    const [c, d] = await Promise.all([
      runCaptureAnalysis(live.request),
      runCaptureAnalysis({ ...live.request, operationId: OPERATION_2 }),
    ]);
    expect([c.kind, d.kind]).toEqual(['scored', 'scored']);
    const livePermits = permitPosts(live.network.calls).length;

    // Parity: the offline branch spends exactly as many tickets as the live
    // branch reserved permits for the same request pair — no more.
    expect(offlineSpend.consumed).toBe(livePermits);
    expect(offlineReceipts).toBe(livePermits);
    expect(offlineSpend.consumed + offlineSpend.spendable).toBe(2);
  });
});

describe('attack 7: the receipt route answers with a budget, then a captive page, then a verdict', () => {
  it('429 + Retry-After and an HTML 200 are HOLDs re-presented under the same id; the acceptance settles once and Result tracks each state', async () => {
    const { store, request } = await setupPlain('offline');
    const analysisId = await paidOffline(
      store,
      await runCaptureAnalysis(request),
    );
    const [receipt] = await pendingOfflineReceipts(store.db);
    if (!receipt) throw new Error('unreachable');
    expect(await readOfflineReceiptEvidence(store.db, analysisId)).toEqual({
      kind: 'queued',
    });

    let answer = 0;
    const network = court('online', call => {
      answer += 1;
      if (answer === 1)
        return response(
          429,
          { error: { code: 'rate_limited', message: 'slow down' } },
          { 'retry-after': '30' },
        );
      if (answer === 2) return response(200, '<html>captive portal</html>');
      return acceptAll(call);
    });

    // The drain surfaces a server budget / unreadable page as a thrown,
    // typed failure to its caller (the sync runtime logs it); the durable
    // contract is what we assert: nothing settled, nothing dropped.
    const settle = () =>
      reconcileOfflineWallet(store.db, offlineClient(), reading()).then(
        result => ({ result, thrown: null as unknown }),
        (thrown: unknown) => ({ result: null, thrown }),
      );
    const first = await settle();
    expect(first.result?.accepted ?? 0).toBe(0);
    expect(first.result?.refused ?? 0).toBe(0);
    if (first.thrown !== null) expect(first.thrown).toBeInstanceOf(Error);
    expect(offlineReceiptRows(store)).toEqual([
      { receipt_id: receipt.receiptId, settlement: null },
    ]);
    expect(await hasShotSyncReceipt(store.db, analysisId)).toBe(false);
    const afterBudget = await readOfflineReceiptEvidence(store.db, analysisId);
    expect(afterBudget).not.toBeNull();
    expect(['queued', 'held']).toContain(afterBudget?.kind);

    const second = await settle();
    expect(second.result?.accepted ?? 0).toBe(0);
    expect(second.result?.refused ?? 0).toBe(0);
    if (second.thrown !== null) expect(second.thrown).toBeInstanceOf(Error);
    expect(offlineReceiptRows(store)).toEqual([
      { receipt_id: receipt.receiptId, settlement: null },
    ]);
    expect(await hasShotSyncReceipt(store.db, analysisId)).toBe(false);
    const afterPortal = await readOfflineReceiptEvidence(store.db, analysisId);
    expect(['queued', 'held']).toContain(afterPortal?.kind);

    const third = await settle();
    expect(third.thrown).toBeNull();
    expect(third.result?.accepted).toBe(1);
    expect(receiptPosts(network.calls).map(presentedReceiptIds)).toEqual([
      [receipt.receiptId],
      [receipt.receiptId],
      [receipt.receiptId],
    ]);
    expect(offlineReceiptRows(store)).toEqual([
      { receipt_id: receipt.receiptId, settlement: 'accepted' },
    ]);
    expect(await hasShotSyncReceipt(store.db, analysisId)).toBe(true);
    expect(await readOfflineReceiptEvidence(store.db, analysisId)).toEqual({
      kind: 'accepted',
    });
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(syncReceipts(store)).toBe(1);
  });
});

/** A declared-technique capture whose landmarks are all dimmed to
 * `visibility`: the on-device engine abstains into low_confidence. */
function dimmedFixture(
  visibility: number,
  uri = 'file:///private/captures/court-dim.mov',
) {
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
    uri,
    capturedAtIso: '2026-09-06T12:00:00.000Z',
    durationMs: window.endMs,
    width: sequence.video.width,
    height: sequence.video.height,
    fps: sequence.video.fps,
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: `${uri}.pose.json`,
      frameCount: dimmed.frames.length,
      sha256: sha256Hex(sidecar),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: dimmed.producedBy.modelVersion,
    },
  };
  return { clip, sidecar };
}

describe('attack 8: the server refuses a receipt with an unbounded, non-code string', () => {
  it('the refusal code that reaches the Result copy is bounded and code-shaped (never verbatim server prose)', async () => {
    const { store, request } = await setupPlain('offline');
    const analysisId = await paidOffline(
      store,
      await runCaptureAnalysis(request),
    );
    const [receipt] = await pendingOfflineReceipts(store.db);
    if (!receipt) throw new Error('unreachable');

    // A refusal "code" that is prose (and long): the wire contract only
    // says `code` is a string, and the Result surface renders it verbatim
    // after "last response:". The device must not repeat arbitrary server
    // text to the user, nor journal an unbounded string.
    const hostileCode = `${'x'.repeat(20_000)} Android Google Play DUPR 99% accurate`;
    court('online', call =>
      response(200, {
        receipts: [],
        rejected: presentedReceiptIds(call).map(receiptId => ({
          receiptId,
          code: hostileCode,
          message: 'refused',
        })),
      }),
    );
    const settled = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
    );
    expect(settled.refused).toBe(1);
    expect(offlineReceiptRows(store)).toEqual([
      { receipt_id: receipt.receiptId, settlement: 'refused' },
    ]);
    expect(await hasShotSyncReceipt(store.db, analysisId)).toBe(false);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });

    const evidence = await readOfflineReceiptEvidence(store.db, analysisId);
    expect(evidence?.kind).toBe('refused');
    if (evidence?.kind !== 'refused') return;
    const code = evidence.code ?? '';
    expect(code.length).toBeLessThanOrEqual(128);
    expect(code).toMatch(/^[A-Za-z0-9_.:-]*$/);
  });
});

describe('attack 9: the lease expires long before the signal returns', () => {
  it('the paid rating replays without spending; the drain still presents the receipt and the acceptance settles once', async () => {
    const { store, request, network } = await setupPlain('offline');
    const analysisId = await paidOffline(
      store,
      await runCaptureAnalysis(request),
    );
    const [receipt] = await pendingOfflineReceipts(store.db);
    if (!receipt) throw new Error('unreachable');

    // Thirty days later: the grant expired three weeks ago. The ticket was
    // spent while the lease was live, so the rating is paid and durable.
    const later = NOW_MS + 30 * 24 * 60 * 60 * 1000;
    mockReading = reading(later);
    const permitsBefore = permitPosts(network.calls).length;
    const replay = await runCaptureAnalysis(request);
    expect(replay).toMatchObject({ kind: 'scored', analysisId });
    if (replay.kind !== 'scored') return;
    expect(replay.replayed).toBe(true);
    const allocation = await readOfflineAllocation(store.db, reading(later));
    expect(allocation.consumedTickets).toBe(1);
    expect(allocation.grants.map(grant => grant.execution.kind)).toEqual([
      'expired',
    ]);
    expect(offlineReceiptRows(store)).toEqual([
      { receipt_id: receipt.receiptId, settlement: null },
    ]);
    expect(permitPosts(network.calls).length).toBe(permitsBefore);

    // A fresh capture on the court now: the lease is expired, so this is the
    // honest no-score path — nothing spent, no receipt.
    const { clip: clip2, sidecar: sidecar2 } = scoredFixture(
      'file:///private/captures/court-late.mov',
    );
    mockReadArtifact = async () => sidecar2;
    seedSqliteCapture(store.db, OWNER, CAPTURE_2, clip2);
    const late = await runCaptureAnalysis(
      plainRequest(store, clip2, {
        operationId: OPERATION_2,
        captureId: CAPTURE_2,
      }),
    );
    expect(late.kind).not.toBe('scored');
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(
      (await readOfflineAllocation(store.db, reading(later))).consumedTickets,
    ).toBe(1);

    // Signal returns: the expired lease does not strand the paid receipt.
    const online = court('online');
    const settled = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(later),
    );
    expect(settled.accepted).toBe(1);
    expect(receiptPosts(online.calls).map(presentedReceiptIds)).toEqual([
      [receipt.receiptId],
    ]);
    expect(await hasShotSyncReceipt(store.db, analysisId)).toBe(true);
    expect(await readOfflineReceiptEvidence(store.db, analysisId)).toEqual({
      kind: 'accepted',
    });
  });
});

describe('attack 10: the server refuses the receipt, then the user taps analyze again', () => {
  it('a refused read replays as the durable device rating without a second spend, a second receipt or a live permit; Result keeps saying refused', async () => {
    const { store, request } = await setupPlain('offline');
    const analysisId = await paidOffline(
      store,
      await runCaptureAnalysis(request),
    );
    const [receipt] = await pendingOfflineReceipts(store.db);
    if (!receipt) throw new Error('unreachable');

    const online = court('online', call =>
      response(200, {
        receipts: [],
        rejected: presentedReceiptIds(call).map(receiptId => ({
          receiptId,
          code: 'offline.receipt_conflict',
          message: 'A different receipt with this id was already delivered.',
        })),
      }),
    );
    const settled = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
    );
    expect(settled.refused).toBe(1);
    expect(await readOfflineReceiptEvidence(store.db, analysisId)).toEqual({
      kind: 'refused',
      code: 'offline.receipt_conflict',
    });
    expect(await hasShotSyncReceipt(store.db, analysisId)).toBe(false);

    // Online now; the user re-runs the same capture. The operation is
    // committed on this device: it must replay, never reserve a live permit
    // (that would rate the same capture twice against the allowance) and
    // never present the refused receipt again.
    const replay = await runCaptureAnalysis(request);
    expect(replay).toMatchObject({ kind: 'scored', analysisId });
    if (replay.kind !== 'scored') return;
    expect(replay.replayed).toBe(true);
    expect(permitPosts(online.calls)).toHaveLength(0);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(offlineReceiptRows(store)).toEqual([
      { receipt_id: receipt.receiptId, settlement: 'refused' },
    ]);
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);

    const again = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
    );
    expect(again.submitted).toBe(0);
    expect(receiptPosts(online.calls)).toHaveLength(1);
    expect(await readOfflineReceiptEvidence(store.db, analysisId)).toEqual({
      kind: 'refused',
      code: 'offline.receipt_conflict',
    });
    expect(await hasShotSyncReceipt(store.db, analysisId)).toBe(false);
    expect(outboxKinds(store)).toEqual([]);
  });
});

describe('attack 11: a practice set whose first court read abstains', () => {
  it('the abstention spends nothing and queues no receipt; the scored read that follows in the same set spends exactly one ticket', async () => {
    const store = createSqliteTestDb();
    const { clip: dimClip, sidecar: dimSidecar } = dimmedFixture(0.5);
    mockReadArtifact = async () => dimSidecar;
    seedSqliteCapture(store.db, OWNER, CAPTURE, dimClip);
    await armWallet(store);
    const network = court('offline');
    const plan = await planPracticeSet(store.db, {
      shotType: 'forehand_drive',
      nowIso: '2026-09-06T12:00:00.000Z',
    });
    if (!plan) throw new Error('signed-in owner must plan a set');

    const first = await runCaptureAnalysis(
      plainRequest(store, dimClip, {
        sessionId: plan.sessionId,
        practiceSet: plan,
      }),
    );
    expect(first.kind).toBe('low_confidence');
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
    expect(offlineReceiptRows(store)).toEqual([]);
    expect(outboxKinds(store)).not.toContain('shot.sync');
    expect(
      countRows(
        store,
        `SELECT COUNT(*) AS n FROM local_shot WHERE owner_key = ? AND result_kind = 'scored'`,
        OWNER,
      ),
    ).toBe(0);

    // A clean capture in the same set: one ticket, one receipt, the set's
    // session row is the only outbox row.
    const { clip: clip2, sidecar: sidecar2 } = scoredFixture(
      'file:///private/captures/court-2.mov',
    );
    mockReadArtifact = async () => sidecar2;
    seedSqliteCapture(store.db, OWNER, CAPTURE_2, clip2);
    const resumed = await planPracticeSet(store.db, {
      shotType: 'forehand_drive',
      nowIso: '2026-09-06T12:05:00.000Z',
    });
    if (!resumed) throw new Error('signed-in owner must plan a set');
    const second = await runCaptureAnalysis(
      plainRequest(store, clip2, {
        operationId: OPERATION_2,
        captureId: CAPTURE_2,
        sessionId: resumed.sessionId,
        practiceSet: resumed,
      }),
    );
    expect(second).toMatchObject({ kind: 'scored', freeLimitReached: false });
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(outboxKinds(store).filter(kind => kind === 'shot.sync')).toEqual([]);
    expect(
      countRows(
        store,
        `SELECT COUNT(*) AS n FROM local_session WHERE owner_key = ?`,
        OWNER,
      ),
    ).toBe(1);
    expect(permitPosts(network.calls).length).toBeGreaterThanOrEqual(1);
  });
});

describe('attack 12: a court-offline low_confidence abstention on the plain path is re-run under the same operation id', () => {
  async function abstainTwice(signal: 'offline' | 'online') {
    const store = createSqliteTestDb();
    const { clip, sidecar } = dimmedFixture(0.5);
    mockReadArtifact = async () => sidecar;
    seedSqliteCapture(store.db, OWNER, CAPTURE, clip);
    await armWallet(store);
    const network = court(signal);
    const first = await runCaptureAnalysis(plainRequest(store, clip));
    expect(first.kind).toBe('low_confidence');
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(offlineReceiptRows(store)).toEqual([]);
    const replay = await runCaptureAnalysis(plainRequest(store, clip));
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(offlineReceiptRows(store)).toEqual([]);
    return { store, clip, network, first, replay };
  }

  it('the replay answers the abstention exactly as the live path does (never "awaiting recovery")', async () => {
    const live = await abstainTwice('online');
    expect(live.replay.kind).toBe('low_confidence');
    const offline = await abstainTwice('offline');
    // Money is conserved either way; the break, if any, is the answer.
    expect(offline.replay.kind).toBe(live.replay.kind);
  });

  it('signal returns: the sweep spends nothing for the answered operation and the re-run still spends nothing', async () => {
    const offline = await abstainTwice('offline');
    const online = await reconnectSweep(offline.store);
    expect(receiptPosts(online.calls)).toHaveLength(0);
    expect(await tickets(offline.store)).toEqual({ spendable: 2, consumed: 0 });
    expect(offlineReceiptRows(offline.store)).toEqual([]);
    const afterSignal = await runCaptureAnalysis(
      plainRequest(offline.store, offline.clip),
    );
    expect(afterSignal.kind).not.toBe('scored');
    expect(await tickets(offline.store)).toEqual({ spendable: 2, consumed: 0 });
    expect(offlineReceiptRows(offline.store)).toEqual([]);
    expect(outboxKinds(offline.store)).not.toContain('shot.sync');
  });
});

/** A camera capture that AUTO DETECT abstains on (validated classifier
 * unavailable) whose landmarks are dimmed to `visibility`, so the technique
 * confirmation that follows abstains into low_confidence. */
function dimmedAutoFixture(visibility: number) {
  const { clip: bare, sidecar } = dimmedFixture(
    visibility,
    'file:///private/captures/court-auto-dim.mov',
  );
  const frameCount = bare.poseSequence?.frameCount ?? 0;
  const clip: CapturedClip = {
    ...bare,
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: 0,
      endMs: bare.durationMs,
      peakMotionMs: Math.round(bare.durationMs / 2),
      confidence: 0.86,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'apple_vision_body_pose',
      poseModelVersion: bare.poseSequence?.poseModelVersion ?? '',
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: frameCount,
      poseFrameCount: frameCount,
      poseMissingFrameCount: 0,
      trackedDurationMs: bare.durationMs,
      meanCanonicalJointVisibility: 0.9,
      meanJointCoverage: 0.9,
      minimumJointCoverage: 0.8,
      fullBodyVisibleFrameCount: frameCount,
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
  };
  return { clip, sidecar };
}

/** The exact request the AnalyzeScreen submits after the user taps a
 * technique on an AUTO DETECT abstention. */
function confirmationOf(
  request: RunCaptureAnalysisRequest,
  analysisId: string,
): RunCaptureAnalysisRequest {
  const { operationId: _dropped, ...rest } = request;
  return {
    ...rest,
    declaredStroke: 'forehand_drive',
    declaredCanonical: 'FOREHAND_DRIVE',
    techniqueConfirmation: {
      analysisId,
      intent: {
        version: 'technique-intent-v1',
        source: 'tap',
        canonical: 'FOREHAND_DRIVE',
        legacySlug: 'forehand_drive',
        confidence: 1,
      },
      confirmedAtIso: '2026-09-06T18:00:00.000Z',
    },
  };
}

describe('attack 13: AUTO DETECT abstains, the user confirms a technique on the court, and the confirmation itself abstains (low_confidence)', () => {
  async function confirmDim(signal: 'offline' | 'online') {
    const store = createSqliteTestDb();
    const { clip, sidecar } = dimmedAutoFixture(0.5);
    mockReadArtifact = async () => sidecar;
    seedSqliteCapture(store.db, OWNER, CAPTURE, clip);
    await armWallet(store);
    const network = court(signal);
    const request = plainRequest(store, clip, {
      declaredStroke: null,
      declaredCanonical: null,
    });
    const load = () =>
      loadSavedTechniqueConfirmation({
        db: store.db,
        ownerContext: captureDataOwnerContext(),
        captureId: CAPTURE,
        apiOrigin: API_ORIGIN,
      });
    const first = await runCaptureAnalysis(request);
    expect(first.kind).toBe('needs_technique_confirmation');
    if (first.kind !== 'needs_technique_confirmation')
      throw new Error('unreachable');
    const confirm = confirmationOf(request, first.analysisId);
    const confirmed = await runCaptureAnalysis(confirm);
    expect(confirmed.kind).toBe('low_confidence');
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(offlineReceiptRows(store)).toEqual([]);
    const loaded = await load();
    const replay = await runCaptureAnalysis(confirm);
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(offlineReceiptRows(store)).toEqual([]);
    expect(outboxKinds(store)).not.toContain('shot.sync');
    return { store, network, confirm, loaded, replay };
  }

  it('the saved-result loader and the replay answer the court-offline abstention exactly as the live path does', async () => {
    const live = await confirmDim('online');
    expect(live.loaded.kind).toBe('already_completed');
    expect(live.replay.kind).toBe('low_confidence');
    const offline = await confirmDim('offline');
    expect([offline.loaded.kind, offline.replay]).toEqual([
      live.loaded.kind,
      expect.objectContaining({ kind: live.replay.kind }),
    ]);
  });
});

describe('attack 13b: the same court-offline abstained confirmation after the signal returns', () => {
  it('the reconnect sweep and a re-run recover the saved abstention without spending anything', async () => {
    const store = createSqliteTestDb();
    const { clip, sidecar } = dimmedAutoFixture(0.5);
    mockReadArtifact = async () => sidecar;
    seedSqliteCapture(store.db, OWNER, CAPTURE, clip);
    await armWallet(store);
    court('offline');
    const request = plainRequest(store, clip, {
      declaredStroke: null,
      declaredCanonical: null,
    });
    const first = await runCaptureAnalysis(request);
    if (first.kind !== 'needs_technique_confirmation')
      throw new Error(`unexpected first outcome ${first.kind}`);
    const confirm = confirmationOf(request, first.analysisId);
    expect((await runCaptureAnalysis(confirm)).kind).toBe('low_confidence');

    const online = await reconnectSweep(store);
    expect(receiptPosts(online.calls)).toHaveLength(0);
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    const afterSignal = await runCaptureAnalysis(confirm);
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(offlineReceiptRows(store)).toEqual([]);
    expect(outboxKinds(store)).not.toContain('shot.sync');
    const loaded = await loadSavedTechniqueConfirmation({
      db: store.db,
      ownerContext: captureDataOwnerContext(),
      captureId: CAPTURE,
      apiOrigin: API_ORIGIN,
    });
    expect([loaded.kind, afterSignal.kind]).toEqual([
      'already_completed',
      'low_confidence',
    ]);
  });
});
