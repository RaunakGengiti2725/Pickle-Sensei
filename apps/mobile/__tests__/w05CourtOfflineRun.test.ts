/**
 * W05-07 — a court with no signal can still produce a scored read.
 *
 * When the live permit reservation fails for CONNECTIVITY only (the request
 * never reached a verdict), a cached active release policy (W01-06) and an
 * executable held grant (W04/W05-06, trusted time) authorize the on-device
 * analysis. A SCORED result spends exactly one local allocation
 * (`consumeOfflineAllocation`) and persists the shot WITHOUT a `shot.sync`
 * outbox row: the queued receipt carries the grant and the output, and the
 * drain presents `{ receipt, grant, output }` for the server to settle. An
 * accepted settlement marks the local shot synced exactly as a successful
 * shot.sync does. Abstentions spend nothing, a missing grant is the honest
 * no-score path, and an explicit server refusal is never an offline case.
 *
 * The shipping entry point (AnalyzeScreen → prepareOriginalCaptureAnalysis +
 * runOriginalCaptureAnalysis) takes the same branch. An operation paid
 * offline is settled ONLY by its receipt: the reconnect recovery sweep never
 * reserves a live permit for it, and a commit whose acknowledgement is lost
 * still hands the durable scored read to the caller.
 *
 * Round 4 (adversary findings): the explicit Check of a paid attempt reserves
 * nothing; a drain builds every wire entry before it journals (an unreadable
 * payload is presented as `output: null`, never a phantom HOLD); a refused
 * settlement is durably visible on the shot; the loser of a last-ticket race
 * gets an honest no-score outcome; more than 100 paid receipts still fence
 * every paid operation from live re-reservation; corrupt wallet rows fail
 * typed, before anything is sent.
 */
import {
  OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
  OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
  OFFLINE_FREE_ALLOCATION_POLICY,
  OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION,
  OFFLINE_GRANT_AUDIENCE,
  OFFLINE_GRANT_JWS_TYPE,
  OFFLINE_PRO_LEASE_SCHEMA_VERSION,
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
import { OriginalAnalysisExecution } from '../src/analysis/originalAnalysisOperations';
import { originalCanonicalJson } from '../src/analysis/originalAnalysisSnapshot';
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
  consumeOfflineAllocation,
  holdOfflineGrant,
  pendingOfflineReceipts,
  readOfflineAllocation,
} from '../src/data/offlineCapabilities';
import {
  readOfflineWalletStatus,
  reconcileOfflineWallet,
} from '../src/data/offlineWallet';
import {
  getAnalysis,
  getOfflineShotStatus,
  getShotOutboxStatus,
  hasShotSyncReceipt,
} from '../src/data/repository';
import {
  clearSyncRuntime,
  configureSyncRuntime,
  SYNC_RETRY_BASE_MS,
  SYNC_RETRY_JITTER_RATIO,
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
const CAPTURE_2 = '33333333-3333-4333-8333-333333333334';
const OPERATION_2 = '44444444-4444-4444-8444-444444444445';
const REFUSAL_CODE = 'grant_signature_invalid';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
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
const LIVE_PERMIT_ID = '99999999-9999-4999-8999-999999999999';
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

/** `free`: the two-ticket lifetime-free allocation. `pro`: a verified-store
 * lease — no tickets, every scored read spends the lease and queues a receipt. */
type GrantKind = 'free' | 'pro';

function grantCompactJws(kind: GrantKind = 'free'): string {
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
    ...(kind === 'pro'
      ? {
          entitlementSource: 'verified_store',
          lease: {
            schemaVersion: OFFLINE_PRO_LEASE_SCHEMA_VERSION,
            kind: 'subscription',
            verifiedEntitlementExpiresAt: EXPIRES_AT + 3600,
          },
        }
      : {
          entitlementSource: 'identity_lifetime_free',
          allocation: {
            schemaVersion: OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION,
            allocationId: GRANT_ID,
            generation: 1,
            ticketIds: TICKETS,
            budgetPolicy: OFFLINE_FREE_ALLOCATION_POLICY.id,
            financialExpiry: 'reconciliation_only',
          },
        }),
  };
  const header = { alg: 'ES256', typ: OFFLINE_GRANT_JWS_TYPE, kid: KEY_ID };
  return `${base64Url(JSON.stringify(header))}.${base64Url(
    JSON.stringify(claims),
  )}.${'A'.repeat(86)}`;
}

function issuedGrant(kind: GrantKind = 'free'): IssuedOfflineGrant {
  const parsed = parseIssuedOfflineGrant({
    grantId: GRANT_ID,
    generation: 1,
    entitlementSource:
      kind === 'pro' ? 'verified_store' : 'identity_lifetime_free',
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    entitlementExpiresAt: kind === 'pro' ? EXPIRES_AT + 3600 : null,
    ticketIds: kind === 'pro' ? [] : TICKETS,
    keyId: KEY_ID,
    grant: {
      schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
      compactJws: grantCompactJws(kind),
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

function fixture(
  visibility: number | null = null,
  uri = 'file:///private/captures/court.mov',
) {
  const { sequence, window } = generateSwingSequence();
  const dimmed =
    visibility === null
      ? sequence
      : {
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
    width: 1080,
    height: 1080,
    fps: 60,
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: uri.replace(/\.mov$/, '.pose.json'),
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

type Signal = 'offline' | 'paywall' | 'online';

interface FetchCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/** The court's network: `offline` never reaches the service (the request
 * fails to leave the device); `paywall` reaches it and is REFUSED; `online`
 * answers the receipt drain — every presented receipt with `receiptStatus`,
 * or, when `refuseWith` is set, every one under `rejected` with that code. */
function court(
  signal: Signal,
  receiptStatus = 'result_recorded',
  refuseWith: string | null = null,
) {
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
      if (url.endsWith('/v1/analysis-permits')) {
        return response(402, {
          error: {
            code: 'access.paywall_required',
            message: 'Your free ratings are used. Upgrade to keep rating.',
          },
        });
      }
      if (url === RECEIPTS_ROUTE) {
        const receipts = (body.receipts ?? []) as Array<
          Record<string, unknown>
        >;
        const ids = receipts.map(
          entry => (entry.receipt as Record<string, unknown>).receiptId,
        );
        return response(
          200,
          refuseWith === null
            ? {
                receipts: ids.map(receiptId => ({
                  receiptId,
                  status: receiptStatus,
                })),
                rejected: [],
              }
            : {
                receipts: [],
                rejected: ids.map(receiptId => ({
                  receiptId,
                  code: refuseWith,
                })),
              },
        );
      }
      return response(404, { error: { code: 'not_found' } });
    },
  );
  globalThis.fetch = fetchPort as unknown as typeof fetch;
  return { calls, fetchPort };
}

async function setup(options: {
  signal: Signal;
  policy: boolean;
  grant: boolean | GrantKind;
  visibility?: number | null;
}) {
  const store = createSqliteTestDb();
  const { clip, sidecar } = fixture(options.visibility ?? null);
  mockReadArtifact = async () => sidecar;
  seedSqliteCapture(store.db, OWNER, CAPTURE, clip);
  mockReading = reading();
  if (options.policy) {
    const verified = verifyReleasePolicy(activeReleaseAuthority().policy);
    if (!verified.ok) throw new Error('fixture policy must verify');
    expect(
      await writeCachedReleasePolicy(
        store.db,
        { ownerKey: OWNER, apiOrigin: API_ORIGIN },
        { policy: verified.policy, serverTime: Math.floor(NOW_MS / 1000) },
      ),
    ).toBe(true);
  }
  if (options.grant)
    await holdOfflineGrant(
      store.db,
      issuedGrant(options.grant === 'pro' ? 'pro' : 'free'),
      BINDING,
    );
  const network = court(options.signal);
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
    apiConfig: { baseUrl: API_ORIGIN, token: BEARER },
    appVersion: '0.1.0',
  };
  return { store, request, network };
}

type Store = ReturnType<typeof createSqliteTestDb>;

/** A second capture of the same owner on the same court: its own capture,
 * operation and movie. `mockReadArtifact` serves both sidecars. */
function secondCapture(
  store: Store,
  request: RunCaptureAnalysisRequest,
): RunCaptureAnalysisRequest {
  const first = mockReadArtifact;
  const { clip, sidecar } = fixture(
    null,
    'file:///private/captures/court-2.mov',
  );
  mockReadArtifact = async uri =>
    uri === clip.poseSequence?.uri ? sidecar : first(uri);
  seedSqliteCapture(store.db, OWNER, CAPTURE_2, clip);
  return { ...request, operationId: OPERATION_2, captureId: CAPTURE_2, clip };
}

/** A plain-path run whose thrown error is recorded instead of propagated, so
 * a race can assert that NO participant throws at the capture screen. */
type Attempt = RunCaptureAnalysisOutcome | { kind: 'threw'; error: unknown };

async function attempt(request: RunCaptureAnalysisRequest): Promise<Attempt> {
  try {
    return await runCaptureAnalysis(request);
  } catch (error) {
    return { kind: 'threw', error };
  }
}

function receiptRows(store: Store) {
  return store.native
    .prepare(
      `SELECT receipt_id, operation_id, settlement, receipt FROM offline_receipt
       WHERE owner_key = ? ORDER BY queued_at ASC, receipt_id ASC`,
    )
    .all(OWNER);
}

function journalRow(store: Store, operationId: string) {
  return store.native
    .prepare(
      `SELECT state, release_outcome, permit_id FROM analysis_run_journal
       WHERE owner_key = ? AND operation_id = ?`,
    )
    .get(OWNER, operationId);
}

function outboxKinds(store: Store): string[] {
  return store.native
    .prepare(`SELECT kind FROM outbox WHERE owner_key = ? ORDER BY kind`)
    .all(OWNER)
    .map(row => String(row.kind));
}

/** The court with signal restored: a service that WOULD reserve a live permit
 * and acknowledge its release, and that accepts every presented receipt. */
function reconnected() {
  const calls: FetchCall[] = [];
  const fetchPort = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<
        string,
        unknown
      >;
      calls.push({ url, body });
      if (isReleasePolicyRequest(url))
        return response(200, activeReleaseAuthority());
      if (url === PERMITS_ROUTE)
        return response(200, {
          permit: {
            id: LIVE_PERMIT_ID,
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

function finalizePosts(calls: readonly FetchCall[]): FetchCall[] {
  return calls.filter(
    call =>
      call.url.startsWith(`${PERMITS_ROUTE}/`) &&
      call.url.endsWith('/finalize'),
  );
}

async function tickets(store: Store) {
  const allocation = await readOfflineAllocation(store.db, reading());
  return {
    spendable: allocation.spendableTickets,
    consumed: allocation.consumedTickets,
  };
}

function attemptRows(store: Store) {
  return store.native
    .prepare(
      `SELECT operation_id, state, release_outcome, permit_id, result_id
       FROM analysis_execution_attempts WHERE owner_key = ?`,
    )
    .all(OWNER);
}

const leases: OriginalAnalysisExecution[] = [];

/** The shipping entry point: AnalyzeScreen runs every signed-in, pose-backed
 * capture through prepareOriginalCaptureAnalysis + runOriginalCaptureAnalysis
 * with a camera clip that carries its native media identity. A `second`
 * capture joins an existing store (same owner, policy and grant) under its
 * own capture id, operation id and movie. */
async function setupOriginal(signal: Signal, second?: { store: Store }) {
  const store = second?.store ?? createSqliteTestDb();
  const captureId = second ? CAPTURE_2 : CAPTURE;
  const operationId = second ? OPERATION_2 : OPERATION;
  const movie = second ? 'court-2.mov' : 'court.mov';
  const { clip: bare, sidecar } = fixture(
    null,
    `file:///private/captures/${movie}`,
  );
  const clip: CapturedClip = {
    ...bare,
    byteSize: 25,
    nativeMediaIdentity: {
      schemaVersion: 1,
      format: 'pickle.native-media-identity.v1',
      receiptId: second
        ? '66666666-6666-4666-8666-666666666667'
        : '66666666-6666-4666-8666-666666666666',
      operationId: second
        ? '77777777-7777-4777-8777-777777777778'
        : '77777777-7777-4777-8777-777777777777',
      origin: 'native_export',
      algorithm: 'sha256',
      videoFileName: movie,
      byteSize: 25,
      sha256: sha256Hex(`synthetic ${movie} bytes`),
    },
  };
  const previous = mockReadArtifact;
  mockReadArtifact = second
    ? async uri => (uri === clip.poseSequence?.uri ? sidecar : previous(uri))
    : async () => sidecar;
  seedSqliteCapture(store.db, OWNER, captureId, clip);
  await store.db.execute(
    'UPDATE local_capture SET declared_stroke = ? WHERE owner_key = ? AND id = ?',
    ['forehand_drive', OWNER, captureId],
  );
  mockReading = reading();
  if (!second) {
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
  const network = court(signal);
  const execution = new OriginalAnalysisExecution(
    captureDataOwnerContext(),
    API_ORIGIN,
  );
  leases.push(execution);
  const request: RunCaptureAnalysisRequest = {
    db: store.db,
    ownerContext: execution.ownerContext,
    captureId,
    clip,
    declaredStroke: 'forehand_drive',
    declaredCanonical: 'FOREHAND_DRIVE',
    handedness: 'right',
    cameraView: 'side',
    apiConfig: { baseUrl: API_ORIGIN, token: BEARER },
    appVersion: '0.1.0',
  };
  const run = async (): Promise<RunCaptureAnalysisOutcome> => {
    const operation = await prepareOriginalCaptureAnalysis(
      request,
      execution,
      operationId,
    );
    return runOriginalCaptureAnalysis({
      db: store.db,
      execution,
      operationId: operation.operationId,
    });
  };
  const check = () =>
    reconcileOriginalCaptureAnalysis({
      db: store.db,
      execution,
      operationId,
    });
  return { store, run, check, network };
}

/** Signal comes back after the app restarted: nothing is executing, and the
 * shipping sync runtime runs its recovery sweep, outbox drain and receipt
 * drain against a service that would hand out a permit. Returns the delays
 * the runtime scheduled for its next pass. */
async function reconnectSweep(store: Store) {
  const online = reconnected();
  (getDb as jest.Mock).mockReturnValue(store.db);
  const timers = jest.spyOn(globalThis, 'setTimeout');
  configureSyncRuntime({
    apiBaseUrl: API_ORIGIN,
    bearerToken: BEARER,
    canonicalAppUserId: OWNER,
    provider: 'apple',
  });
  await triggerOutboxSync();
  const delays = timers.mock.calls
    .map(call => call[1])
    .filter(
      (delay): delay is number =>
        typeof delay === 'number' &&
        delay >= SYNC_RETRY_BASE_MS * (1 - SYNC_RETRY_JITTER_RATIO),
    );
  return { online, delays };
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

it('offline reservation failure + cached policy + executable grant → scored read, one ticket spent, receipt queued, no shot.sync row', async () => {
  const { store, request, network } = await setup({
    signal: 'offline',
    policy: true,
    grant: true,
  });
  const before = await readOfflineAllocation(store.db, reading());
  expect(before.spendableTickets).toBe(2);

  const outcome = await runCaptureAnalysis(request);
  expect(outcome.kind).toBe('scored');
  if (outcome.kind !== 'scored') return;
  const analysis = outcome.record.result;
  expect(analysis?.resultKind).toBe('scored');
  if (!analysis) return;

  // Exactly one allocation spent, backed by exactly one queued receipt that
  // names this operation, this result and the hash of the exact output.
  const after = await readOfflineAllocation(store.db, reading());
  expect(after.spendableTickets).toBe(1);
  expect(after.consumedTickets).toBe(1);
  const receipts = await pendingOfflineReceipts(store.db);
  expect(receipts).toHaveLength(1);
  const receipt = receipts[0]!;
  expect(receipt).toMatchObject({
    operationId: OPERATION,
    resultId: analysis.id,
    grantId: GRANT_ID,
    fullOutputSha256: sha256Hex(originalCanonicalJson(analysis)),
    settlement: null,
  });
  expect(receipt.ticket?.ticketId).toBe(TICKETS[0]);

  // The shot is persisted as a real scored rating, with NO shot.sync outbox
  // row — the receipt carries the output.
  expect(await getAnalysis(store.db, analysis.id)).toEqual(analysis);
  expect(store.count('local_shot', OWNER)).toBe(1);
  expect(outboxKinds(store)).toEqual([]);
  expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);
  // No permit traffic produced a verdict: every request failed to leave.
  expect(
    network.calls.filter(call => call.url.endsWith('/v1/analysis-permits')),
  ).toHaveLength(1);

  // Replaying the same operation returns the same read without a second
  // inference, ticket or receipt.
  const replay = await runCaptureAnalysis(request);
  expect(replay.kind).toBe('scored');
  if (replay.kind !== 'scored') return;
  expect(replay.record.result?.id).toBe(analysis.id);
  expect((await pendingOfflineReceipts(store.db)).length).toBe(1);
  expect(
    (await readOfflineAllocation(store.db, reading())).spendableTickets,
  ).toBe(1);
  expect(store.count('local_shot', OWNER)).toBe(1);
});

it('no executable grant → the existing honest no-score path, nothing persisted as a rating', async () => {
  const { store, request } = await setup({
    signal: 'offline',
    policy: true,
    grant: false,
  });
  const outcome = await runCaptureAnalysis(request);
  expect(outcome.kind).toBe('unavailable');
  expect(store.count('local_shot', OWNER)).toBe(0);
  expect(store.count('local_analysis_record', OWNER)).toBe(0);
  expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
});

it('no cached release policy → no new numeric score even with a held grant', async () => {
  const { store, request } = await setup({
    signal: 'offline',
    policy: false,
    grant: true,
  });
  const outcome = await runCaptureAnalysis(request);
  expect(outcome.kind).toBe('unavailable');
  expect(store.count('local_shot', OWNER)).toBe(0);
  expect(
    (await readOfflineAllocation(store.db, reading())).spendableTickets,
  ).toBe(2);
  expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
});

it('an abstention on the court consumes nothing and queues no receipt', async () => {
  const { store, request } = await setup({
    signal: 'offline',
    policy: true,
    grant: true,
    visibility: 0.5,
  });
  const outcome = await runCaptureAnalysis(request);
  expect(outcome.kind).toBe('low_confidence');
  const allocation = await readOfflineAllocation(store.db, reading());
  expect(allocation.spendableTickets).toBe(2);
  expect(allocation.consumedTickets).toBe(0);
  expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
  expect(outboxKinds(store)).toEqual([]);
  // The abstained mechanics are still recorded locally, never as a rating.
  expect(store.count('local_analysis_record', OWNER)).toBe(1);
  const kinds = store.native
    .prepare(`SELECT result_kind FROM local_shot WHERE owner_key = ?`)
    .all(OWNER)
    .map(row => row.result_kind);
  expect(kinds).toEqual(['low_confidence']);
});

it('the drain presents { receipt, grant, output } and an accepted verdict marks the shot synced', async () => {
  const { store, request } = await setup({
    signal: 'offline',
    policy: true,
    grant: true,
  });
  const outcome = await runCaptureAnalysis(request);
  expect(outcome.kind).toBe('scored');
  if (outcome.kind !== 'scored' || !outcome.record.result) return;
  const analysis = outcome.record.result;
  const [receipt] = await pendingOfflineReceipts(store.db);
  expect(receipt).toBeDefined();

  const online = court('online');
  const client = createOfflineGrantClient({
    baseUrl: API_ORIGIN,
    token: BEARER,
  });
  const drained = await reconcileOfflineWallet(store.db, client, reading());
  expect(drained).toMatchObject({
    submitted: 1,
    accepted: 1,
    held: 0,
    refused: 0,
    pending: 0,
  });

  const presented = online.calls.filter(call => call.url === RECEIPTS_ROUTE);
  expect(presented).toHaveLength(1);
  const {
    settlement: _settlement,
    settledAt: _settledAt,
    ...persisted
  } = receipt!;
  expect(presented[0]!.body).toEqual({
    receipts: [
      {
        ...persisted,
        receipt: persisted,
        grant: {
          schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
          compactJws: grantCompactJws(),
        },
        output: analysis,
      },
    ],
  });
  expect(JSON.stringify(presented[0]!.body)).not.toContain('analysisPermitId');

  // Accepted (result_recorded): the local shot is marked synced exactly as a
  // successful shot.sync is, and the receipt is settled.
  expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(true);
  expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
  expect(outboxKinds(store)).toEqual([]);
});

it('a held verdict keeps the receipt pending and the shot unsynced', async () => {
  const { store, request } = await setup({
    signal: 'offline',
    policy: true,
    grant: true,
  });
  const outcome = await runCaptureAnalysis(request);
  expect(outcome.kind).toBe('scored');
  if (outcome.kind !== 'scored' || !outcome.record.result) return;
  court('online', 'pending');
  const client = createOfflineGrantClient({
    baseUrl: API_ORIGIN,
    token: BEARER,
  });
  const drained = await reconcileOfflineWallet(store.db, client, reading());
  expect(drained).toMatchObject({ submitted: 1, accepted: 0, held: 1 });
  expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
  expect(await hasShotSyncReceipt(store.db, outcome.record.result.id)).toBe(
    false,
  );
});

it('an explicit server refusal (paywall) is NOT an offline case: no score, nothing spent', async () => {
  const { store, request, network } = await setup({
    signal: 'paywall',
    policy: true,
    grant: true,
  });
  const outcome = await runCaptureAnalysis(request);
  expect(outcome).toMatchObject({
    kind: 'unavailable',
    cause: 'paywall_required',
  });
  expect(
    network.calls.filter(call => call.url.endsWith('/v1/analysis-permits')),
  ).toHaveLength(1);
  expect(store.count('local_shot', OWNER)).toBe(0);
  expect(
    (await readOfflineAllocation(store.db, reading())).spendableTickets,
  ).toBe(2);
  expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
});

describe('the shipping entry point (AnalyzeScreen → runOriginalCaptureAnalysis)', () => {
  it('control: the same harness scores through the original path when the service answers, without touching the wallet', async () => {
    const { store, run } = await setupOriginal('offline');
    const online = reconnected();
    const outcome = await run();
    expect(permitPosts(online.calls)).toHaveLength(1);
    expect(outcome.kind).toBe('scored');
    expect(store.count('local_shot', OWNER)).toBe(1);
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
    expect(outboxKinds(store)).toEqual(['shot.sync']);
  });

  it('a signed-in capture on a court with no signal + cached policy + held grant produces a scored read, spends one ticket and queues one receipt; the replay is the same paid rating', async () => {
    const { store, run, network } = await setupOriginal('offline');
    const outcome = await run();
    // The reservation was attempted and never answered…
    expect(permitPosts(network.calls)).toHaveLength(1);
    // …so the court rates on-device, spends one ticket and queues one receipt.
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored' || !outcome.record.result) return;
    const analysis = outcome.record.result;
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    // The original attempt keeps its identity and never claims a permit; the
    // receipt is keyed by that attempt's run and names the ORIGINAL analysis.
    const attempts = attemptRows(store);
    expect(attempts).toEqual([
      expect.objectContaining({ permit_id: null, result_id: null }),
    ]);
    const receipts = await pendingOfflineReceipts(store.db);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      operationId: attempts[0]?.operation_id,
      resultId: analysis.id,
      grantId: GRANT_ID,
      fullOutputSha256: sha256Hex(originalCanonicalJson(analysis)),
      settlement: null,
    });
    expect(await getAnalysis(store.db, analysis.id)).toEqual(analysis);
    expect(store.count('local_shot', OWNER)).toBe(1);
    expect(outboxKinds(store)).toEqual([]);

    // The same operation (screen re-entry, app relaunch) replays the paid
    // rating: no second inference, ticket, receipt or reservation.
    const replay = await run();
    expect(replay).toMatchObject({ kind: 'scored', replayed: true });
    if (replay.kind !== 'scored') return;
    expect(replay.record.result?.id).toBe(analysis.id);
    expect(permitPosts(network.calls)).toHaveLength(1);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(store.count('local_shot', OWNER)).toBe(1);
  });

  it.each([
    ['unparseable', () => 'not json'],
    [
      're-pointed at another result',
      (receipt: string) =>
        JSON.stringify({
          ...(JSON.parse(receipt) as Record<string, unknown>),
          resultId: '77777777-7777-4777-8777-777777777777',
        }),
    ],
  ])(
    'a receipt row that is %s holds the paid operation: the replay is an honest HOLD, never a second inference, spend or fabricated rating',
    async (_label, corrupt: (receipt: string) => string) => {
      const { store, run, network } = await setupOriginal('offline');
      const outcome = await run();
      expect(outcome.kind).toBe('scored');
      const [receipt] = receiptRows(store) as Array<{
        receipt_id: string;
        receipt: string;
      }>;
      store.native
        .prepare(
          `UPDATE offline_receipt SET receipt = ? WHERE owner_key = ? AND receipt_id = ?`,
        )
        .run(corrupt(receipt!.receipt), OWNER, receipt!.receipt_id);

      const replay = await run();
      expect(replay).toMatchObject({
        kind: 'unavailable',
        cause: 'recovery_pending',
      });
      expect(permitPosts(network.calls)).toHaveLength(1);
      expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
      expect(store.count('offline_receipt', OWNER)).toBe(1);
      expect(store.count('local_shot', OWNER)).toBe(1);
      expect(outboxKinds(store)).toEqual([]);
    },
  );

  it('an explicit refusal on the original path is not offline: no score, nothing spent', async () => {
    const { store, run, network } = await setupOriginal('paywall');
    const outcome = await run();
    expect(outcome).toMatchObject({
      kind: 'unavailable',
      cause: 'paywall_required',
    });
    expect(permitPosts(network.calls)).toHaveLength(1);
    expect(store.count('local_shot', OWNER)).toBe(0);
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
  });
});

describe('a commit whose acknowledgement is lost', () => {
  it('plain path: the physical COMMIT succeeded, so the caller receives the durable scored read and nothing is spent twice', async () => {
    const { store, request } = await setup({
      signal: 'offline',
      policy: true,
      grant: true,
    });
    store.failCommitOnce('after', 'INSERT INTO offline_receipt');
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).toBe('scored');
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(store.count('local_shot', OWNER)).toBe(1);

    const replay = await runCaptureAnalysis(request);
    expect(replay.kind).toBe('scored');
    if (outcome.kind === 'scored' && replay.kind === 'scored')
      expect(replay.record.result?.id).toBe(outcome.record.result?.id);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(store.count('local_shot', OWNER)).toBe(1);
  });

  it('original path: the first caller receives the durable scored read; the replay is the same rating', async () => {
    const { store, run } = await setupOriginal('offline');
    store.failCommitOnce('after', 'INSERT INTO offline_receipt');
    const outcome = await run();
    expect(outcome.kind).toBe('scored');
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(store.count('local_shot', OWNER)).toBe(1);

    const replay = await run();
    expect(replay).toMatchObject({ kind: 'scored', replayed: true });
    if (outcome.kind === 'scored' && replay.kind === 'scored')
      expect(replay.record.result?.id).toBe(outcome.record.result?.id);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(store.count('local_shot', OWNER)).toBe(1);
  });

  it('a rolled-back write spends nothing and the same operation is held for recovery, never re-spent', async () => {
    const { store, request } = await setup({
      signal: 'offline',
      policy: true,
      grant: true,
    });
    store.failStatementOnce('INSERT OR REPLACE INTO local_shot');
    await expect(runCaptureAnalysis(request)).rejects.toThrow();
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
    expect(store.count('local_shot', OWNER)).toBe(0);
    const retry = await runCaptureAnalysis(request);
    expect(retry).toMatchObject({
      kind: 'unavailable',
      cause: 'recovery_pending',
    });
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
  });
});

describe('reconnect: an operation paid offline is settled only by its receipt', () => {
  it('original path: the sync runtime sweep reserves no live permit and finalizes nothing; the drain settles the receipt and the runtime keeps its healthy cadence', async () => {
    const { store, run } = await setupOriginal('offline');
    const outcome = await run();
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored' || !outcome.record.result) return;
    const analysis = outcome.record.result;
    const attempt = attemptRows(store);

    const { online, delays } = await reconnectSweep(store);
    expect(permitPosts(online.calls)).toHaveLength(0);
    expect(finalizePosts(online.calls)).toHaveLength(0);
    expect(
      online.calls.filter(call => call.url === RECEIPTS_ROUTE),
    ).toHaveLength(1);
    // Accepted: the shot is synced, the receipt settled, the ticket stays spent.
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(true);
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    // The attempt never became a live commitment.
    expect(attemptRows(store)).toEqual(attempt);
    expect(attempt).toEqual([expect.objectContaining({ permit_id: null })]);
    // A settled offline operation is not unfinished recovery work: the next
    // pass is scheduled at the healthy cadence, not backed off.
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeLessThan(
      SYNC_RETRY_BASE_MS * 2 * (1 - SYNC_RETRY_JITTER_RATIO),
    );

    // Signal or not, the replay is the same paid rating.
    const replay = await run();
    expect(replay).toMatchObject({ kind: 'scored', replayed: true });
    if (replay.kind === 'scored')
      expect(replay.record.result?.id).toBe(analysis.id);
    expect(permitPosts(online.calls)).toHaveLength(0);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
  });

  it('plain path: the sweep reserves no live permit and the replay is the same rating with no second spend', async () => {
    const { store, request } = await setup({
      signal: 'offline',
      policy: true,
      grant: true,
    });
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored' || !outcome.record.result) return;
    const analysis = outcome.record.result;

    const { online, delays } = await reconnectSweep(store);
    expect(permitPosts(online.calls)).toHaveLength(0);
    expect(finalizePosts(online.calls)).toHaveLength(0);
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(true);
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
    expect(delays[0]).toBeLessThan(
      SYNC_RETRY_BASE_MS * 2 * (1 - SYNC_RETRY_JITTER_RATIO),
    );

    const replay = await runCaptureAnalysis(request);
    expect(replay.kind).toBe('scored');
    if (replay.kind === 'scored')
      expect(replay.record.result?.id).toBe(analysis.id);
    expect(permitPosts(online.calls)).toHaveLength(0);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(store.count('local_shot', OWNER)).toBe(1);
  });
});

function walletClient() {
  return createOfflineGrantClient({ baseUrl: API_ORIGIN, token: BEARER });
}

/** Round 4: the explicit "Check" action (AnalyzeScreen `reconcile_saved`) of
 * a paid attempt must obey the same rule as the sweep — a receipt settles the
 * operation; no live permit is ever reserved for it. */
describe('the explicit Check of an offline-paid original attempt', () => {
  it('reserves no live permit and finalizes nothing; the attempt stays the offline-paid attempt and the replay is the same rating', async () => {
    const { store, run, check } = await setupOriginal('offline');
    const outcome = await run();
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored' || !outcome.record.result) return;
    const analysis = outcome.record.result;
    const attempt = attemptRows(store);
    expect(attempt).toEqual([expect.objectContaining({ permit_id: null })]);

    // Signal is back; the owner taps Check.
    const online = reconnected();
    await check();
    expect(permitPosts(online.calls)).toHaveLength(0);
    expect(finalizePosts(online.calls)).toHaveLength(0);
    expect(attemptRows(store)).toEqual(attempt);
    // An original attempt lives only in its attempt row; Check opens no run.
    expect(journalRow(store, OPERATION)).toBeUndefined();
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);

    const replay = await run();
    expect(replay).toMatchObject({ kind: 'scored', replayed: true });
    if (replay.kind === 'scored')
      expect(replay.record.result?.id).toBe(analysis.id);
    expect(permitPosts(online.calls)).toHaveLength(0);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
  });
});

describe('a drain never journals a presentation it did not send', () => {
  it('one unreadable local shot payload: the healthy receipt is presented and settled, the unreadable output is presented as null, and no HOLD is fabricated', async () => {
    const { store, request } = await setup({
      signal: 'offline',
      policy: true,
      grant: true,
    });
    const first = await runCaptureAnalysis(request);
    expect(first.kind).toBe('scored');
    if (first.kind !== 'scored' || !first.record.result) return;
    const second = await runCaptureAnalysis(secondCapture(store, request));
    expect(second.kind).toBe('scored');
    if (second.kind !== 'scored' || !second.record.result) return;
    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 2 });
    const receipts = await pendingOfflineReceipts(store.db);
    expect(receipts).toHaveLength(2);

    // The first shot's persisted payload is no longer JSON.
    store.native
      .prepare(
        `UPDATE local_shot SET payload = ? WHERE owner_key = ? AND id = ?`,
      )
      .run('not json', OWNER, first.record.result.id);

    const online = court('online');
    const drained = await reconcileOfflineWallet(
      store.db,
      walletClient(),
      reading(),
    );
    expect(drained).toMatchObject({
      submitted: 2,
      accepted: 2,
      held: 0,
      refused: 0,
      pending: 0,
    });
    const presented = online.calls.filter(call => call.url === RECEIPTS_ROUTE);
    expect(presented).toHaveLength(1);
    const entries = (
      presented[0]!.body as { receipts: Array<Record<string, unknown>> }
    ).receipts;
    const byResult = new Map(
      entries.map(entry => [
        (entry.receipt as { resultId: string }).resultId,
        entry.output,
      ]),
    );
    expect(byResult.get(first.record.result.id)).toBeNull();
    expect(byResult.get(second.record.result.id)).toEqual(second.record.result);

    const status = await readOfflineWalletStatus(store.db);
    expect(status.hold).toBe(false);
    expect(status.unansweredPresentations).toBe(0);
    expect(status.pending).toEqual([]);
    expect(await hasShotSyncReceipt(store.db, second.record.result.id)).toBe(
      true,
    );
  });

  it('an unreadable receipt row fails typed before anything is sent: no request, no journal, no HOLD, nothing settled', async () => {
    const { store, request } = await setup({
      signal: 'offline',
      policy: true,
      grant: true,
    });
    const first = await runCaptureAnalysis(request);
    expect(first.kind).toBe('scored');
    if (first.kind !== 'scored' || !first.record.result) return;
    const [receipt] = receiptRows(store) as Array<{ receipt_id: string }>;
    store.native
      .prepare(
        `UPDATE offline_receipt SET receipt = ? WHERE owner_key = ? AND receipt_id = ?`,
      )
      .run('not json', OWNER, receipt!.receipt_id);

    const online = court('online');
    await expect(
      reconcileOfflineWallet(store.db, walletClient(), reading()),
    ).rejects.toMatchObject({
      name: 'OfflineGrantError',
      code: 'offline.wallet_corrupt',
    });
    expect(online.calls.filter(call => call.url === RECEIPTS_ROUTE)).toEqual(
      [],
    );
    expect(store.count('offline_wallet_journal', OWNER)).toBe(0);
    expect(await hasShotSyncReceipt(store.db, first.record.result.id)).toBe(
      false,
    );
    expect(receiptRows(store)).toEqual([
      expect.objectContaining({ settlement: null }),
    ]);
  });
});

describe('a refused settlement is durably visible to the owner', () => {
  it('before the drain the shot reads as queued; after a refusal it reads as refused with the server code, and it is never marked synced', async () => {
    const { store, request } = await setup({
      signal: 'offline',
      policy: true,
      grant: true,
    });
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored' || !outcome.record.result) return;
    const analysis = outcome.record.result;
    expect(outboxKinds(store)).toEqual([]);
    // No shot.sync row ever exists for a court-offline read: the Result
    // screen falls through from the outbox reader to the receipt reader.
    expect(await getShotOutboxStatus(store.db, analysis.id)).toEqual({
      state: 'absent',
    });
    expect(await getOfflineShotStatus(store.db, analysis.id)).toEqual({
      state: 'queued',
      attempts: 0,
      lastError: null,
    });

    court('online', 'result_recorded', REFUSAL_CODE);
    const drained = await reconcileOfflineWallet(
      store.db,
      walletClient(),
      reading(),
    );
    expect(drained).toMatchObject({
      submitted: 1,
      accepted: 0,
      held: 0,
      refused: 1,
      pending: 0,
    });

    // Durable, owner-readable: the Result screen's evidence readers see a
    // refused read, not an absent or pending one.
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);
    expect(await getShotOutboxStatus(store.db, analysis.id)).toEqual({
      state: 'absent',
    });
    expect(await getOfflineShotStatus(store.db, analysis.id)).toEqual({
      state: 'exhausted',
      attempts: 1,
      lastError: REFUSAL_CODE,
    });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
    expect(receiptRows(store)).toEqual([
      expect.objectContaining({ settlement: 'refused' }),
    ]);
    // The rating itself stays on the device; the ticket stays spent.
    expect(await getAnalysis(store.db, analysis.id)).toMatchObject({
      resultKind: 'scored',
      source: 'real',
    });
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });

    // Another owner sees none of it.
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    signIn(OTHER_OWNER);
    expect(await getOfflineShotStatus(store.db, analysis.id)).toEqual({
      state: 'absent',
    });
  });

  it('a held verdict keeps the shot queued, not refused', async () => {
    const { store, request } = await setup({
      signal: 'offline',
      policy: true,
      grant: true,
    });
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored' || !outcome.record.result) return;
    court('online', 'pending');
    await reconcileOfflineWallet(store.db, walletClient(), reading());
    expect(
      await getOfflineShotStatus(store.db, outcome.record.result.id),
    ).toEqual({ state: 'queued', attempts: 1, lastError: null });
  });
});

describe('the last-ticket race between two distinct offline operations', () => {
  async function spendOneTicket(store: Store) {
    await consumeOfflineAllocation(
      store.db,
      {
        operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        resultId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        fullOutputSha256: 'b'.repeat(64),
      },
      reading(NOW_MS - 60_000),
    );
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
  }

  it('plain path: exactly one scores; the loser receives an honest no-score outcome — no thrown OfflineGrantError, nothing spent, no shot, no recovery hold', async () => {
    const { store, request } = await setup({
      signal: 'offline',
      policy: true,
      grant: true,
    });
    await spendOneTicket(store);
    const second = secondCapture(store, request);

    const outcomes = await Promise.all([attempt(request), attempt(second)]);
    const scored = outcomes.filter(outcome => outcome.kind === 'scored');
    const losers = outcomes.filter(outcome => outcome.kind !== 'scored');
    expect(scored).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ kind: 'unavailable' });
    expect(losers[0]).not.toHaveProperty('cause');
    if (losers[0]!.kind === 'unavailable')
      expect(losers[0]!.reason).toMatch(/offline|reached/i);

    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 2 });
    expect(store.count('local_shot', OWNER)).toBe(1);
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(2);
    expect(outboxKinds(store)).toEqual([]);
    // The loser's operation spent nothing, so reconnect reconciles it exactly
    // like any no-score run the service never answered (one reservation,
    // finalized failed with no rating); the paid winner is never re-reserved,
    // its receipt settles it.
    const loserKey = store.native
      .prepare(
        `SELECT reservation_key FROM analysis_run_journal
         WHERE owner_key = ? AND operation_id NOT IN (
           SELECT operation_id FROM offline_receipt WHERE owner_key = ?)`,
      )
      .all(OWNER, OWNER)
      .map(row => (row as { reservation_key: string }).reservation_key);
    expect(loserKey).toHaveLength(1);
    const { online } = await reconnectSweep(store);
    expect(permitPosts(online.calls).map(call => call.body)).toEqual([
      { idempotencyKey: loserKey[0] },
    ]);
    expect(finalizePosts(online.calls).map(call => call.body)).toEqual([
      { outcome: 'failed', ratingId: null },
    ]);
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
  });

  it('shipping path: the loser is told the allowance is gone, not left "awaiting recovery"; the winner replays as the same paid rating', async () => {
    const first = await setupOriginal('offline');
    const second = await setupOriginal('offline', { store: first.store });
    const { store } = first;
    await spendOneTicket(store);

    const outcomes = await Promise.all([first.run(), second.run()]);
    const scored = outcomes.filter(outcome => outcome.kind === 'scored');
    const losers = outcomes.filter(outcome => outcome.kind !== 'scored');
    expect(scored).toHaveLength(1);
    expect(losers).toEqual([expect.objectContaining({ kind: 'unavailable' })]);
    expect(losers[0]).not.toHaveProperty('cause');
    if (losers[0]!.kind === 'unavailable')
      expect(losers[0]!.reason).toMatch(/offline|reached/i);

    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 2 });
    expect(store.count('local_shot', OWNER)).toBe(1);
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(2);
    // The loser's attempt is released, never a live commitment.
    expect(attemptRows(store)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ permit_id: null, result_id: null }),
      ]),
    );
    expect(attemptRows(store)).toHaveLength(2);

    const winner = scored[0]!.kind === 'scored' ? scored[0]! : null;
    const replayOf = outcomes[0]!.kind === 'scored' ? first : second;
    const replay = await replayOf.run();
    expect(replay).toMatchObject({ kind: 'scored', replayed: true });
    if (replay.kind === 'scored' && winner?.kind === 'scored')
      expect(replay.record.result?.id).toBe(winner.record.result?.id);
    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 2 });
  });
});

describe('reconnect with more than 100 paid receipts', () => {
  it('a Pro lease with 100 older paid receipts: the 101st and 102nd paid operations are not re-reserved live or finalized; every receipt drains', async () => {
    const { store, request } = await setup({
      signal: 'offline',
      policy: true,
      grant: 'pro',
    });
    // 100 earlier court-day ratings already paid on this lease.
    for (let index = 0; index < 100; index += 1) {
      const suffix = String(index).padStart(12, '0');
      await consumeOfflineAllocation(
        store.db,
        {
          operationId: `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`,
          resultId: `bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`,
          fullOutputSha256: 'c'.repeat(64),
        },
        reading(NOW_MS - (200 - index) * 1000),
      );
    }
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored' || !outcome.record.result) return;
    const analysis = outcome.record.result;
    const second = await runCaptureAnalysis(secondCapture(store, request));
    expect(second.kind).toBe('scored');
    if (second.kind !== 'scored' || !second.record.result) return;
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(102);
    const journals = [
      journalRow(store, OPERATION),
      journalRow(store, OPERATION_2),
    ];
    expect(journals).toEqual([
      expect.objectContaining({ permit_id: null }),
      expect.objectContaining({ permit_id: null }),
    ]);

    const { online } = await reconnectSweep(store);
    expect(permitPosts(online.calls)).toHaveLength(0);
    expect(finalizePosts(online.calls)).toHaveLength(0);
    expect([
      journalRow(store, OPERATION),
      journalRow(store, OPERATION_2),
    ]).toEqual(journals);
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(true);
    expect(await hasShotSyncReceipt(store.db, second.record.result.id)).toBe(
      true,
    );
    expect(
      receiptRows(store).filter(row => row['settlement'] === 'accepted'),
    ).toHaveLength(102);

    const replay = await runCaptureAnalysis(request);
    expect(replay.kind).toBe('scored');
    if (replay.kind === 'scored')
      expect(replay.record.result?.id).toBe(analysis.id);
    expect(permitPosts(online.calls)).toHaveLength(0);
    expect(store.count('local_shot', OWNER)).toBe(2);
  });
});
