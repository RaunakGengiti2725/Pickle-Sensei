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
 * offline is settled ONLY by its receipt: neither the reconnect recovery
 * sweep nor the explicit "Check" reconciliation reserves a live permit for it
 * (however many operations the owner has paid for), and a commit whose
 * acknowledgement is lost still hands the durable scored read to the caller.
 * The loser of a last-ticket race gets an honest no-score outcome; the drain
 * isolates an unreadable shot payload instead of journaling a presentation
 * it never sent; a refused verdict leaves owner-readable evidence.
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

function fixture(visibility: number | null = null, file = 'court') {
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
    uri: `file:///private/captures/${file}.mov`,
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
      uri: `file:///private/captures/${file}.pose.json`,
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
 * answers the receipt drain — with `receiptStatus` for every receipt, or a
 * refusal carrying `refusalCode` for every receipt. */
function court(
  signal: Signal,
  receiptStatus = 'result_recorded',
  refusalCode: string | null = null,
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
        return response(200, {
          receipts:
            refusalCode === null
              ? ids.map(receiptId => ({ receiptId, status: receiptStatus }))
              : [],
          rejected:
            refusalCode === null
              ? []
              : ids.map(receiptId => ({ receiptId, code: refusalCode })),
        });
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
  grant: boolean;
  visibility?: number | null;
}) {
  const store = createSqliteTestDb();
  const { clip, sidecar } = fixture(options.visibility ?? null);
  const second = fixture(options.visibility ?? null, 'court-2');
  mockReadArtifact = async (uri: string) =>
    uri === second.clip.poseSequence?.uri ? second.sidecar : sidecar;
  seedSqliteCapture(store.db, OWNER, CAPTURE, clip);
  seedSqliteCapture(store.db, OWNER, CAPTURE_2, second.clip);
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
  if (options.grant) await holdOfflineGrant(store.db, issuedGrant(), BINDING);
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
  /** A second, distinct capture and operation of the same owner. */
  const secondRequest: RunCaptureAnalysisRequest = {
    ...request,
    operationId: OPERATION_2,
    captureId: CAPTURE_2,
    clip: second.clip,
  };
  return { store, request, second: secondRequest, network };
}

type Store = ReturnType<typeof createSqliteTestDb>;

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

const sidecars = new Map<string, string>();

/** The shipping entry point: AnalyzeScreen runs every signed-in, pose-backed
 * capture through prepareOriginalCaptureAnalysis + runOriginalCaptureAnalysis
 * with a camera clip that carries its native media identity. A second call
 * with `store` adds another capture and operation of the same owner. */
async function setupOriginal(
  signal: Signal,
  options: {
    store?: Store;
    captureId?: string;
    operationId?: string;
    file?: string;
    visibility?: number | null;
  } = {},
) {
  const store = options.store ?? createSqliteTestDb();
  const captureId = options.captureId ?? CAPTURE;
  const operationId = options.operationId ?? OPERATION;
  const file = options.file ?? 'court';
  const { clip: bare, sidecar } = fixture(options.visibility ?? null, file);
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
      videoFileName: `${file}.mov`,
      byteSize: 25,
      sha256: sha256Hex(`synthetic ${file} movie bytes`),
    },
  };
  sidecars.set(clip.poseSequence!.uri, sidecar);
  mockReadArtifact = async (uri: string) => {
    const found = sidecars.get(uri);
    if (found === undefined) throw new Error(`no sidecar for ${uri}`);
    return found;
  };
  seedSqliteCapture(store.db, OWNER, captureId, clip);
  await store.db.execute(
    'UPDATE local_capture SET declared_stroke = ? WHERE owner_key = ? AND id = ?',
    ['forehand_drive', OWNER, captureId],
  );
  mockReading = reading();
  if (options.store === undefined) {
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
  /** AnalyzeScreen's "Check" action on a saved analysis. */
  const check = () =>
    reconcileOriginalCaptureAnalysis({ db: store.db, execution, operationId });
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
  sidecars.clear();
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

describe('the explicit "Check" of a saved analysis (reconcileOriginalCaptureAnalysis)', () => {
  it('an offline-paid original attempt is settled by its receipt: the Check reserves no live permit, finalizes nothing and leaves the paid attempt as it is', async () => {
    const { store, run, check } = await setupOriginal('offline');
    const outcome = await run();
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored' || !outcome.record.result) return;
    const analysis = outcome.record.result;
    const attempt = attemptRows(store);
    expect(attempt).toEqual([
      expect.objectContaining({ permit_id: null, result_id: null }),
    ]);

    const online = reconnected();
    await check();
    expect(permitPosts(online.calls)).toHaveLength(0);
    expect(finalizePosts(online.calls)).toHaveLength(0);
    expect(attemptRows(store)).toEqual(attempt);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);

    const replay = await run();
    expect(replay).toMatchObject({ kind: 'scored', replayed: true });
    if (replay.kind === 'scored')
      expect(replay.record.result?.id).toBe(analysis.id);
    expect(permitPosts(online.calls)).toHaveLength(0);
  });

  it('control: the Check of a transport-failed attempt that paid nothing still recovers through a live permit', async () => {
    const { store, run, check } = await setupOriginal('offline', {
      visibility: 0.5,
    });
    const outcome = await run();
    expect(outcome.kind).toBe('low_confidence');
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    const online = reconnected();
    await check();
    expect(permitPosts(online.calls)).toHaveLength(1);
    expect(finalizePosts(online.calls)).toHaveLength(1);
    expect(store.count('offline_receipt', OWNER)).toBe(0);
  });
});

describe('an abstention on the shipping path', () => {
  it('spends nothing, queues no receipt and is recorded locally as an unscored read', async () => {
    const { store, run, network } = await setupOriginal('offline', {
      visibility: 0.5,
    });
    const outcome = await run();
    expect(outcome.kind).toBe('low_confidence');
    expect(permitPosts(network.calls)).toHaveLength(1);
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
    expect(outboxKinds(store)).toEqual([]);
    expect(store.count('local_analysis_record', OWNER)).toBe(1);
    const kinds = store.native
      .prepare(`SELECT result_kind FROM local_shot WHERE owner_key = ?`)
      .all(OWNER)
      .map(row => row.result_kind);
    expect(kinds).toEqual(['low_confidence']);
  });
});

describe('two operations race for the LAST ticket', () => {
  const PRESEEDED = {
    operationId: '55555555-5555-4555-8555-555555555555',
    resultId: '55555555-5555-4555-8555-555555555556',
    fullOutputSha256: 'c'.repeat(64),
  };

  it('plain path: exactly one scores; the loser is told the allowance is spent as an outcome (nothing thrown, nothing spent, no shot)', async () => {
    const { store, request, second } = await setup({
      signal: 'offline',
      policy: true,
      grant: true,
    });
    await consumeOfflineAllocation(store.db, PRESEEDED, reading());
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });

    const outcomes = await Promise.all([
      runCaptureAnalysis(request),
      runCaptureAnalysis(second),
    ]);
    const scored = outcomes.filter(outcome => outcome.kind === 'scored');
    const losers = outcomes.filter(outcome => outcome.kind !== 'scored');
    expect(scored).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ kind: 'unavailable' });
    expect(losers[0]).not.toHaveProperty('cause');
    if (losers[0]?.kind === 'unavailable')
      expect(losers[0].reason).toMatch(/offline/i);
    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 2 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(2);
    expect(store.count('local_shot', OWNER)).toBe(1);
    expect(store.count('local_analysis_record', OWNER)).toBe(1);
    expect(outboxKinds(store)).toEqual([]);
  });

  it('shipping path: the loser is told the allowance is spent, not left "awaiting recovery"', async () => {
    const first = await setupOriginal('offline');
    const second = await setupOriginal('offline', {
      store: first.store,
      captureId: CAPTURE_2,
      operationId: OPERATION_2,
      file: 'court-2',
    });
    const { store } = first;
    await consumeOfflineAllocation(store.db, PRESEEDED, reading());
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });

    const outcomes = await Promise.all([first.run(), second.run()]);
    const scored = outcomes.filter(outcome => outcome.kind === 'scored');
    const losers = outcomes.filter(outcome => outcome.kind !== 'scored');
    expect(scored).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ kind: 'unavailable' });
    expect(losers[0]).not.toHaveProperty('cause');
    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 2 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(2);
    expect(store.count('local_shot', OWNER)).toBe(1);
    expect(outboxKinds(store)).toEqual([]);
    // The paid attempt is the only one holding a receipt; the loser's attempt
    // never claimed a permit either.
    expect(attemptRows(store)).toEqual([
      expect.objectContaining({ permit_id: null }),
      expect.objectContaining({ permit_id: null }),
    ]);
  });
});

describe('reconnect recovery protects EVERY paid operation, not the first hundred', () => {
  /** Another paid operation of the same owner, queued before the real one. */
  function cloneReceipt(store: Store, index: number) {
    const row = store.native
      .prepare(
        `SELECT * FROM offline_receipt WHERE owner_key = ? AND operation_id = ?`,
      )
      .get(OWNER, OPERATION) as Record<string, unknown>;
    const receipt = JSON.parse(String(row.receipt)) as Record<string, unknown>;
    const suffix = String(index).padStart(12, '0');
    const receiptId = `eeeeeeee-0000-4000-8000-${suffix}`;
    const operationId = `ffffffff-0000-4000-8000-${suffix}`;
    const resultId = `abababab-0000-4000-8000-${suffix}`;
    const queuedAt = new Date(NOW_MS - (1000 - index) * 60_000).toISOString();
    const columns = Object.keys(row);
    const values = columns.map(column => {
      switch (column) {
        case 'receipt_id':
          return receiptId;
        case 'operation_id':
          return operationId;
        case 'queued_at':
          return queuedAt;
        case 'receipt':
          return JSON.stringify({
            ...receipt,
            receiptId,
            operationId,
            resultId,
            queuedAt,
          });
        default:
          return row[column];
      }
    });
    store.native
      .prepare(
        `INSERT INTO offline_receipt (${columns.join(', ')}) VALUES (${columns
          .map(() => '?')
          .join(', ')})`,
      )
      .run(...(values as Array<string | number | null>));
  }

  it('with 100 older paid receipts the 101st paid operation is still never re-reserved live, and replays as the same rating', async () => {
    const { store, request } = await setup({
      signal: 'offline',
      policy: true,
      grant: true,
    });
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored' || !outcome.record.result) return;
    const analysis = outcome.record.result;
    for (let index = 0; index < 100; index += 1) cloneReceipt(store, index);
    expect(store.count('offline_receipt', OWNER)).toBe(101);

    const { online } = await reconnectSweep(store);
    expect(permitPosts(online.calls)).toHaveLength(0);
    expect(finalizePosts(online.calls)).toHaveLength(0);
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(true);
    expect(
      store.native
        .prepare(
          `SELECT state, permit_id FROM analysis_run_journal WHERE owner_key = ? AND operation_id = ?`,
        )
        .get(OWNER, OPERATION),
    ).toEqual(expect.objectContaining({ permit_id: null }));

    const replay = await runCaptureAnalysis(request);
    expect(replay.kind).toBe('scored');
    if (replay.kind === 'scored')
      expect(replay.record.result?.id).toBe(analysis.id);
    expect(permitPosts(online.calls)).toHaveLength(0);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
  });
});

describe('the drain and an unreadable shot payload', () => {
  it('presents the healthy receipt and the unreadable one with output null; no presentation is journaled that was never sent', async () => {
    const { store, request, second } = await setup({
      signal: 'offline',
      policy: true,
      grant: true,
    });
    const first = await runCaptureAnalysis(request);
    const other = await runCaptureAnalysis(second);
    expect(first.kind).toBe('scored');
    expect(other.kind).toBe('scored');
    if (
      first.kind !== 'scored' ||
      !first.record.result ||
      other.kind !== 'scored' ||
      !other.record.result
    )
      return;
    const corrupted = first.record.result;
    const healthy = other.record.result;
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(2);
    store.native
      .prepare(
        `UPDATE local_shot SET payload = ? WHERE owner_key = ? AND id = ?`,
      )
      .run('not json', OWNER, corrupted.id);

    const online = court('online');
    const client = createOfflineGrantClient({
      baseUrl: API_ORIGIN,
      token: BEARER,
    });
    const drained = await reconcileOfflineWallet(store.db, client, reading());
    expect(drained).toMatchObject({ submitted: 2, accepted: 2, pending: 0 });
    const presented = online.calls.filter(call => call.url === RECEIPTS_ROUTE);
    expect(presented).toHaveLength(1);
    const entries = presented[0]!.body.receipts as Array<
      Record<string, unknown>
    >;
    expect(entries).toHaveLength(2);
    const byResult = new Map(entries.map(entry => [entry.resultId, entry]));
    expect(byResult.get(corrupted.id)?.output).toBeNull();
    expect(byResult.get(healthy.id)?.output).toEqual(healthy);
    for (const entry of entries)
      expect(entry.grant).toEqual({
        schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
        compactJws: grantCompactJws(),
      });
    const status = await readOfflineWalletStatus(store.db);
    expect(status).toMatchObject({
      pending: [],
      unansweredPresentations: 0,
      hold: false,
    });
    expect(await hasShotSyncReceipt(store.db, healthy.id)).toBe(true);
  });
});

describe('a refused verdict', () => {
  it('settles the receipt and leaves durable, owner-readable evidence on the shot: not synced, not pending, refused for good', async () => {
    const { store, request } = await setup({
      signal: 'offline',
      policy: true,
      grant: true,
    });
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored' || !outcome.record.result) return;
    const analysis = outcome.record.result;
    court('online', 'result_recorded', 'grant_signature_invalid');
    const client = createOfflineGrantClient({
      baseUrl: API_ORIGIN,
      token: BEARER,
    });
    const drained = await reconcileOfflineWallet(store.db, client, reading());
    expect(drained).toMatchObject({
      submitted: 1,
      accepted: 0,
      held: 0,
      refused: 1,
      pending: 0,
    });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);
    // The Result screen reads exactly this: the server did not accept the
    // read and it will not be sent again.
    expect(await getShotOutboxStatus(store.db, analysis.id)).toEqual({
      state: 'exhausted',
      attempts: 1,
      lastError: 'grant_signature_invalid',
    });
    // The read itself stays on the device; the ticket stays spent.
    expect(await getAnalysis(store.db, analysis.id)).toEqual(analysis);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect((await readOfflineWalletStatus(store.db)).pending).toEqual([]);
  });

  it('control: a court-scored read whose receipt is still pending reads as queued (never presented yet), and as absent once accepted', async () => {
    const { store, request } = await setup({
      signal: 'offline',
      policy: true,
      grant: true,
    });
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored' || !outcome.record.result) return;
    const shotId = outcome.record.result.id;
    expect(await getShotOutboxStatus(store.db, shotId)).toEqual({
      state: 'queued',
      attempts: 0,
      lastError: null,
    });
    court('online', 'result_recorded');
    const client = createOfflineGrantClient({
      baseUrl: API_ORIGIN,
      token: BEARER,
    });
    await reconcileOfflineWallet(store.db, client, reading());
    expect(await hasShotSyncReceipt(store.db, shotId)).toBe(true);
    expect(await getShotOutboxStatus(store.db, shotId)).toEqual({
      state: 'absent',
    });
  });
});
