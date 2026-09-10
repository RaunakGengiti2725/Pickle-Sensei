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
 * shot.sync does. Abstentions spend nothing, a missing grant or policy is the
 * honest no-score path, and an explicit server refusal is never an offline
 * case.
 *
 * Both entry points are covered: the plain `runCaptureAnalysis()` and the
 * shipping signed-in flow (`prepareOriginalCaptureAnalysis` +
 * `runOriginalCaptureAnalysis`, what AnalyzeScreen drives for every
 * signed-in, pose-backed capture).
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
  type RunCaptureAnalysisRequest,
} from '../src/analysis/runCaptureAnalysis';
import { OriginalAnalysisExecution } from '../src/analysis/originalAnalysisOperations';
import { originalCanonicalJson } from '../src/analysis/originalAnalysisSnapshot';
import {
  verifyReleasePolicy,
  writeCachedReleasePolicy,
} from '../src/analysis/releasePolicyClient';
import { runJournal } from '../src/analysis/runJournal';
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
import {
  holdOfflineGrant,
  pendingOfflineReceipts,
  readOfflineAllocation,
} from '../src/data/offlineCapabilities';
import {
  readOfflineWalletJournal,
  reconcileOfflineWallet,
} from '../src/data/offlineWallet';
import { getAnalysis, hasShotSyncReceipt } from '../src/data/repository';
import {
  captureDataOwnerContext,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import {
  clearSyncRuntime,
  configureSyncRuntime,
  triggerOutboxSync,
} from '../src/data/syncRuntime';
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

import { getDb } from '../src/data/db';

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
const LIVE_PERMIT = '99999999-9999-4999-8999-999999999999';
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

const SESSION = {
  canonicalAppUserId: OWNER,
  apiBaseUrl: API_ORIGIN,
  bearerToken: BEARER,
  provider: 'apple' as const,
};

function signIn() {
  setActiveDataOwner(OWNER);
  establishApiSession(SESSION);
}

function fixture(visibility: number | null = null) {
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
    uri: 'file:///private/captures/court.mov',
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
      uri: 'file:///private/captures/court.pose.json',
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

type ReserveAnswer = (call: FetchCall) => Response | 'offline';

/** The court's network. Every route the harness does not answer fails to
 * leave the device (`TypeError`, never a verdict); `reserve` decides the
 * permit reservation, `finalize` the permit release, `receipts` the drain. */
function network(options: {
  reserve: ReserveAnswer;
  finalize?: (call: FetchCall) => Response;
  receipts?: (call: FetchCall) => Response;
  policy?: 'offline' | 'online';
}) {
  const calls: FetchCall[] = [];
  const fetchPort = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<
        string,
        unknown
      >;
      const call: FetchCall = { url, body };
      calls.push(call);
      const offline = () => {
        throw new TypeError('Network request failed');
      };
      if (isReleasePolicyRequest(url)) {
        if ((options.policy ?? 'offline') === 'offline') return offline();
        return response(200, activeReleaseAuthority());
      }
      if (url === PERMITS_ROUTE) {
        const answer = options.reserve(call);
        return answer === 'offline' ? offline() : answer;
      }
      if (url.startsWith(`${PERMITS_ROUTE}/`) && url.endsWith('/finalize')) {
        if (options.finalize) return options.finalize(call);
        return offline();
      }
      if (url === RECEIPTS_ROUTE) {
        if (options.receipts) return options.receipts(call);
        return offline();
      }
      return response(404, { error: { code: 'not_found' } });
    },
  );
  globalThis.fetch = fetchPort as unknown as typeof fetch;
  return { calls, fetchPort };
}

const OFFLINE: ReserveAnswer = () => 'offline';

const PAYWALL: ReserveAnswer = () =>
  response(402, {
    error: {
      code: 'access.paywall_required',
      message: 'Your free ratings are used. Upgrade to keep rating.',
    },
  });

function reservedPermit(id: string): ReserveAnswer {
  return () =>
    response(200, {
      permit: {
        id,
        accessSource: 'free',
        status: 'reserved',
        expiresAt: new Date(NOW_MS + 15 * 60_000).toISOString(),
      },
      access: null,
    });
}

function finalizedPermit(call: FetchCall): Response {
  const id = decodeURIComponent(
    call.url.slice(PERMITS_ROUTE.length + 1, -'/finalize'.length),
  );
  return response(200, {
    permit: { id, status: 'released', outcome: call.body.outcome },
    access: null,
  });
}

function settleAll(status = 'result_recorded') {
  return (call: FetchCall) => {
    const receipts = (call.body.receipts ?? []) as Array<
      Record<string, unknown>
    >;
    return response(200, {
      receipts: receipts.map(entry => ({
        receiptId: (entry.receipt as Record<string, unknown>).receiptId,
        status,
      })),
      rejected: [],
    });
  };
}

/** The route's refusal of every presented receipt: a `rejected` entry naming
 * the receipt and a code, never a `receipts` status. */
function rejectAll(code = 'offline.invalid_input') {
  return (call: FetchCall) => {
    const receipts = (call.body.receipts ?? []) as Array<
      Record<string, unknown>
    >;
    return response(200, {
      receipts: [],
      rejected: receipts.map(entry => ({
        receiptId: (entry.receipt as Record<string, unknown>).receiptId,
        code,
      })),
    });
  };
}

type Store = ReturnType<typeof createSqliteTestDb>;

async function cachePolicy(store: Store) {
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

async function setup(options: {
  policy?: boolean;
  grant?: boolean;
  visibility?: number | null;
}) {
  const store = createSqliteTestDb();
  const { clip, sidecar } = fixture(options.visibility ?? null);
  mockReadArtifact = async () => sidecar;
  seedSqliteCapture(store.db, OWNER, CAPTURE, clip);
  mockReading = reading();
  if (options.policy ?? true) await cachePolicy(store);
  if (options.grant ?? true)
    await holdOfflineGrant(store.db, issuedGrant(), BINDING);
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
  return { store, request };
}

const leases: OriginalAnalysisExecution[] = [];

/** The shipping path: a signed-in camera capture with a verified native
 * media identity, prepared as an original operation and run from its
 * immutable snapshot, exactly as AnalyzeScreen does. */
async function setupOriginal(options: { visibility?: number | null } = {}) {
  const store = createSqliteTestDb();
  const { clip: bare, sidecar } = fixture(options.visibility ?? null);
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
  mockReading = reading();
  await cachePolicy(store);
  await holdOfflineGrant(store.db, issuedGrant(), BINDING);
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
    declaredStroke: 'forehand_drive',
    declaredCanonical: 'FOREHAND_DRIVE',
    handedness: 'right',
    cameraView: 'side',
    apiConfig: { baseUrl: API_ORIGIN, token: BEARER },
    appVersion: '0.1.0',
  };
  const prepare = () =>
    prepareOriginalCaptureAnalysis(request, execution, OPERATION);
  const run = async () => {
    const operation = await prepare();
    return runOriginalCaptureAnalysis({
      db: store.db,
      execution,
      operationId: operation.operationId,
    });
  };
  const replay = () =>
    runOriginalCaptureAnalysis({
      db: store.db,
      execution,
      operationId: OPERATION,
    });
  return { store, run, replay };
}

function outboxKinds(store: Store): string[] {
  return store.native
    .prepare(`SELECT kind FROM outbox WHERE owner_key = ? ORDER BY kind`)
    .all(OWNER)
    .map(row => String(row.kind));
}

async function tickets(store: Store) {
  const allocation = await readOfflineAllocation(store.db, reading());
  return {
    spendable: allocation.spendableTickets,
    consumed: allocation.consumedTickets,
  };
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

function receiptPosts(calls: readonly FetchCall[]): FetchCall[] {
  return calls.filter(call => call.url === RECEIPTS_ROUTE);
}

function offlineClient() {
  return createOfflineGrantClient({ baseUrl: API_ORIGIN, token: BEARER });
}

/** Everything a paid court-offline read leaves behind, and nothing else. */
async function expectPaidOffline(store: Store) {
  expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
  expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
  expect(store.count('local_shot', OWNER)).toBe(1);
  expect(outboxKinds(store)).toEqual([]);
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

describe('plain runCaptureAnalysis on a court with no signal', () => {
  it('offline reservation failure + cached policy + executable grant → scored read, one ticket spent, receipt queued, no shot.sync row', async () => {
    const { store, request } = await setup({});
    const net = network({ reserve: OFFLINE });
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
    // The reservation was attempted once and never answered.
    expect(permitPosts(net.calls)).toHaveLength(1);

    // Replaying the same operation returns the same read without a second
    // inference, ticket or receipt.
    const replay = await runCaptureAnalysis(request);
    expect(replay.kind).toBe('scored');
    if (replay.kind !== 'scored') return;
    expect(replay.record.result?.id).toBe(analysis.id);
    await expectPaidOffline(store);
    expect(permitPosts(net.calls)).toHaveLength(1);
  });

  it('no executable grant → the existing honest no-score path, nothing persisted as a rating', async () => {
    const { store, request } = await setup({ grant: false });
    network({ reserve: OFFLINE });
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).toBe('unavailable');
    expect(store.count('local_shot', OWNER)).toBe(0);
    expect(store.count('local_analysis_record', OWNER)).toBe(0);
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
  });

  it('no cached release policy → no new numeric score even with a held grant', async () => {
    const { store, request } = await setup({ policy: false });
    network({ reserve: OFFLINE });
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).toBe('unavailable');
    expect(store.count('local_shot', OWNER)).toBe(0);
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
  });

  it('an abstention on the court consumes nothing and queues no receipt', async () => {
    const { store, request } = await setup({ visibility: 0.5 });
    network({ reserve: OFFLINE });
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).toBe('low_confidence');
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
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

  it('an explicit server refusal (paywall) is NOT an offline case: no score, nothing spent', async () => {
    const { store, request } = await setup({});
    const net = network({ reserve: PAYWALL, policy: 'online' });
    const outcome = await runCaptureAnalysis(request);
    expect(outcome).toMatchObject({
      kind: 'unavailable',
      cause: 'paywall_required',
    });
    expect(permitPosts(net.calls)).toHaveLength(1);
    expect(store.count('local_shot', OWNER)).toBe(0);
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
  });

  it('a physical COMMIT that succeeds but loses its acknowledgement still returns the durable scored read, and the replay spends nothing more', async () => {
    const { store, request } = await setup({});
    network({ reserve: OFFLINE });
    store.failCommitOnce('after', 'INSERT INTO offline_receipt');
    const outcome = await runCaptureAnalysis(request);
    // The ticket IS spent and the rating IS persisted — the caller learns
    // that, exactly as the live path guarantees for a lost acknowledgement.
    expect(outcome.kind).toBe('scored');
    await expectPaidOffline(store);

    const replay = await runCaptureAnalysis(request);
    expect(replay.kind).toBe('scored');
    await expectPaidOffline(store);
  });
});

describe('the shipping entry point (prepareOriginalCaptureAnalysis + runOriginalCaptureAnalysis)', () => {
  it('control: the same harness scores through a live permit when the service answers', async () => {
    const { store, run } = await setupOriginal();
    const net = network({
      reserve: reservedPermit(LIVE_PERMIT),
      finalize: finalizedPermit,
      policy: 'online',
    });
    const outcome = await run();
    expect(permitPosts(net.calls)).toHaveLength(1);
    expect(outcome.kind).toBe('scored');
    expect(store.count('local_shot', OWNER)).toBe(1);
    expect(outboxKinds(store)).toEqual(['shot.sync']);
    // A live permit paid for it: the offline wallet is untouched.
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
  });

  it('a signed-in camera capture on a court with no signal + cached policy + held grant produces a scored read paid by one ticket, and replays it', async () => {
    const { store, run, replay } = await setupOriginal();
    const net = network({ reserve: OFFLINE });
    const outcome = await run();
    // The reservation was attempted and never answered…
    expect(permitPosts(net.calls)).toHaveLength(1);
    // …so the court rates on-device, spends one ticket and queues one receipt.
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored' || !outcome.record.result) return;
    const analysis = outcome.record.result;
    await expectPaidOffline(store);
    const [receipt] = await pendingOfflineReceipts(store.db);
    expect(receipt).toMatchObject({
      resultId: analysis.id,
      grantId: GRANT_ID,
      fullOutputSha256: sha256Hex(originalCanonicalJson(analysis)),
      settlement: null,
    });
    expect(await getAnalysis(store.db, analysis.id)).toEqual(analysis);
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);

    // The same logical operation replays the paid rating: no second
    // inference, reservation, ticket or receipt.
    const again = await replay();
    expect(again.kind).toBe('scored');
    if (again.kind !== 'scored') return;
    expect(again.record.result?.id).toBe(analysis.id);
    await expectPaidOffline(store);
    expect(permitPosts(net.calls)).toHaveLength(1);
    expect(finalizePosts(net.calls)).toHaveLength(0);
  });

  it('an abstention on the shipping path spends nothing and queues no receipt', async () => {
    const { store, run } = await setupOriginal({ visibility: 0.5 });
    network({ reserve: OFFLINE });
    const outcome = await run();
    expect(outcome.kind).toBe('low_confidence');
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
    expect(outboxKinds(store)).toEqual([]);
    expect(
      store.native
        .prepare(
          `SELECT count(*) AS n FROM local_shot WHERE owner_key = ? AND result_kind = 'scored'`,
        )
        .get(OWNER)?.n,
    ).toBe(0);
  });

  it('an explicit server refusal on the shipping path is NOT an offline case', async () => {
    const { store, run } = await setupOriginal();
    const net = network({ reserve: PAYWALL, policy: 'online' });
    const outcome = await run();
    expect(outcome.kind).not.toBe('scored');
    expect(permitPosts(net.calls)).toHaveLength(1);
    expect(store.count('local_shot', OWNER)).toBe(0);
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
  });

  it('a lost commit acknowledgement on the shipping path still returns the durable scored read', async () => {
    const { store, run, replay } = await setupOriginal();
    network({ reserve: OFFLINE });
    store.failCommitOnce('after', 'INSERT INTO offline_receipt');
    const outcome = await run();
    expect(outcome.kind).toBe('scored');
    await expectPaidOffline(store);
    const again = await replay();
    expect(again.kind).toBe('scored');
    await expectPaidOffline(store);
  });
});

describe('reconnect: the paid operation is settled by its receipt only', () => {
  it('the sync-runtime recovery sweep reserves no LIVE permit for an operation already paid offline (plain run)', async () => {
    const { store, request } = await setup({});
    network({ reserve: OFFLINE });
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored' || !outcome.record.result) return;
    const analysis = outcome.record.result;
    const scope = runJournal.scope({ ownerKey: OWNER, apiOrigin: API_ORIGIN });
    // Restart: nothing is executing, the journal is whatever SQLite holds.
    expect(runJournal.activeOperationIds(scope)).toEqual([]);

    // The court gets signal back; the runtime runs its recovery sweep first
    // with a server that WOULD hand out a permit, then drains the wallet.
    const online = network({
      reserve: reservedPermit(LIVE_PERMIT),
      finalize: finalizedPermit,
      receipts: settleAll(),
      policy: 'online',
    });
    (getDb as jest.Mock).mockReturnValue(store.db);
    configureSyncRuntime(SESSION);
    await triggerOutboxSync();

    expect(permitPosts(online.calls)).toHaveLength(0);
    expect(finalizePosts(online.calls)).toHaveLength(0);
    expect(receiptPosts(online.calls)).toHaveLength(1);
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(true);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });

    // The operation still replays the paid rating after the sweep.
    const replay = await runCaptureAnalysis(request);
    expect(replay.kind).toBe('scored');
    expect(permitPosts(online.calls)).toHaveLength(0);
  });

  it('the sync-runtime recovery sweep reserves no LIVE permit for a shipping-path operation already paid offline', async () => {
    const { store, run, replay } = await setupOriginal();
    network({ reserve: OFFLINE });
    expect((await run()).kind).toBe('scored');
    const online = network({
      reserve: reservedPermit(LIVE_PERMIT),
      finalize: finalizedPermit,
      receipts: settleAll(),
      policy: 'online',
    });
    (getDb as jest.Mock).mockReturnValue(store.db);
    configureSyncRuntime(SESSION);
    await triggerOutboxSync();
    expect(permitPosts(online.calls)).toHaveLength(0);
    expect(finalizePosts(online.calls)).toHaveLength(0);
    expect(receiptPosts(online.calls)).toHaveLength(1);
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect((await replay()).kind).toBe('scored');
    expect(permitPosts(online.calls)).toHaveLength(0);
  });

  it('when the receipts cannot be read the sweep recovers no journal (no LIVE permit) but still drains the outbox', async () => {
    const { store, request } = await setup({});
    network({ reserve: OFFLINE });
    expect((await runCaptureAnalysis(request)).kind).toBe('scored');
    store.native
      .prepare(`INSERT INTO outbox (owner_key, kind, payload) VALUES (?, ?, ?)`)
      .run(
        OWNER,
        'session.create',
        JSON.stringify({
          id: '66666666-6666-4666-8666-666666666666',
          mode: 'quick',
          shotType: 'forehand_drive',
          focusCheckpoint: null,
          startedAt: new Date(NOW_MS).toISOString(),
        }),
      );
    const online = network({
      reserve: reservedPermit(LIVE_PERMIT),
      finalize: finalizedPermit,
      receipts: settleAll(),
      policy: 'online',
    });
    const unreadable: typeof store.db = {
      ...store.db,
      execute: (sql, params) =>
        /FROM offline_receipt/.test(sql)
          ? Promise.reject(new Error('disk I/O error'))
          : store.db.execute(sql, params),
    };
    (getDb as jest.Mock).mockReturnValue(unreadable);
    configureSyncRuntime(SESSION);
    await triggerOutboxSync();

    expect(permitPosts(online.calls)).toHaveLength(0);
    expect(finalizePosts(online.calls)).toHaveLength(0);
    expect(
      online.calls.filter(call => call.url === `${API_ORIGIN}/v1/sessions`),
    ).toHaveLength(1);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
  });
});

describe('receipt drain', () => {
  it('presents { receipt, grant, output } and an accepted verdict marks the shot synced', async () => {
    const { store, request } = await setup({});
    network({ reserve: OFFLINE });
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored' || !outcome.record.result) return;
    const analysis = outcome.record.result;
    const [receipt] = await pendingOfflineReceipts(store.db);
    expect(receipt).toBeDefined();

    const online = network({ reserve: OFFLINE, receipts: settleAll() });
    const drained = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
    );
    expect(drained).toMatchObject({
      submitted: 1,
      accepted: 1,
      held: 0,
      refused: 0,
      pending: 0,
    });

    const presented = receiptPosts(online.calls);
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
    expect(JSON.stringify(presented[0]!.body)).not.toContain(
      'analysisPermitId',
    );

    // Accepted (result_recorded): the local shot is marked synced exactly as
    // a successful shot.sync is, and the receipt is settled.
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(true);
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
    expect(outboxKinds(store)).toEqual([]);
  });

  it('a held verdict keeps the receipt pending and the shot unsynced', async () => {
    const { store, request } = await setup({});
    network({ reserve: OFFLINE });
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored' || !outcome.record.result) return;
    network({ reserve: OFFLINE, receipts: settleAll('pending') });
    const drained = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
    );
    expect(drained).toMatchObject({ submitted: 1, accepted: 0, held: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(await hasShotSyncReceipt(store.db, outcome.record.result.id)).toBe(
      false,
    );
  });

  it('a stored payload the receipt did not digest is presented as output: null, never as the rating', async () => {
    const { store, request } = await setup({});
    network({ reserve: OFFLINE });
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored' || !outcome.record.result) return;
    const analysis = outcome.record.result;
    store.native
      .prepare(
        `UPDATE local_shot SET payload = ?, overall_score = 99
         WHERE owner_key = ? AND id = ?`,
      )
      .run(
        JSON.stringify({ ...analysis, overallScore: 99 }),
        OWNER,
        analysis.id,
      );

    const replay = await runCaptureAnalysis(request).catch(
      (error: unknown) => ({ kind: 'threw', error: String(error) }),
    );
    expect(replay).not.toMatchObject({ kind: 'scored' });
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });

    const online = network({
      reserve: OFFLINE,
      receipts: settleAll('pending'),
    });
    const drained = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
    );
    expect(drained).toMatchObject({ submitted: 1, accepted: 0, held: 1 });
    const [post] = receiptPosts(online.calls);
    const entries = post!.body.receipts as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.output).toBeNull();
    expect((entries[0]!.receipt as Record<string, unknown>).resultId).toBe(
      analysis.id,
    );
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);
  });

  it('a refused verdict is surfaced honestly: the shot is never marked synced', async () => {
    const { store, request } = await setup({});
    network({ reserve: OFFLINE });
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored' || !outcome.record.result) return;
    network({ reserve: OFFLINE, receipts: rejectAll() });
    const drained = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
    );
    expect(drained).toMatchObject({ submitted: 1, accepted: 0, refused: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
    expect(await hasShotSyncReceipt(store.db, outcome.record.result.id)).toBe(
      false,
    );
  });

  it('a missing grant row is corrupt state: nothing is sent and no presentation is journaled as in flight', async () => {
    const { store, request } = await setup({});
    network({ reserve: OFFLINE });
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).toBe('scored');
    store.native
      .prepare(`DELETE FROM offline_grant WHERE owner_key = ? AND grant_id = ?`)
      .run(OWNER, GRANT_ID);
    const online = network({ reserve: OFFLINE, receipts: settleAll() });
    await expect(
      reconcileOfflineWallet(store.db, offlineClient(), reading()),
    ).rejects.toThrow();
    expect(receiptPosts(online.calls)).toHaveLength(0);
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(
      (await readOfflineWalletJournal(store.db)).filter(
        entry => entry.state === 'in_flight',
      ),
    ).toEqual([]);
  });
});
