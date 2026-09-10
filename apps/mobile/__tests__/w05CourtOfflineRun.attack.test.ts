/**
 * W05-07 adversarial suite — attacks the court-offline scored read at its
 * failure boundaries (candidate 2e5b47e0). Every test states the invariant it
 * expects the candidate to hold; a failing test here is a confirmed break of
 * that invariant, not a style opinion.
 *
 * Categories: the shipping (original-operation) entry point, crash between
 * steps (lost commit acknowledgement, rolled-back write), process restart +
 * reconnect recovery, concurrent double submit,
 * interleaved account switch, replay/duplicate identities, connectivity vs
 * verdict classification (timeout, 429 + Retry-After, 5xx, redirect,
 * unreadable 4xx, 401/409 verdicts), clock boundaries (far-future, past,
 * rollback, NaN), corrupt persisted state before the drain, drain network
 * failures (5xx, 429, concurrent drains) and free-rating conservation.
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
import {
  recoverAnalysisJournals,
  runJournal,
} from '../src/analysis/runJournal';
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
  createAnalysisPermitClient,
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
  readOfflineWalletStatus,
  reconcileOfflineWallet,
} from '../src/data/offlineWallet';
import { hasShotSyncReceipt } from '../src/data/repository';
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
let mockOnTrustedTimeRead: (() => void) | null = null;

jest.mock('../src/data/trustedTime', () => {
  const actual = jest.requireActual<typeof import('../src/data/trustedTime')>(
    '../src/data/trustedTime',
  );
  return {
    ...actual,
    trustedTime: {
      ...actual.trustedTime,
      read: async () => {
        mockOnTrustedTimeRead?.();
        if (!mockReading) throw new Error('trusted time not configured');
        return mockReading;
      },
    },
  };
});

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CAPTURE = '33333333-3333-4333-8333-333333333333';
const OPERATION = '44444444-4444-4444-8444-444444444444';
const API_ORIGIN = 'https://api.example.test/functions/v1/api';
const BEARER = 'fresh-owner-token';
const INSTALLATION_KEY = 'ios-install-key-1';
const KEY_ID = 'offline-grant-key-1';
const GRANT_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const OTHER_GRANT_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const TICKETS = [
  'aaaaaaaa-0000-4000-8000-000000000001',
  'aaaaaaaa-0000-4000-8000-000000000002',
] as const;
const OTHER_TICKETS = [
  'cccccccc-0000-4000-8000-000000000001',
  'cccccccc-0000-4000-8000-000000000002',
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

function reading(
  nowMs = NOW_MS,
  overrides: Partial<TrustedTimeReading> = {},
): TrustedTimeReading {
  return {
    authority: 'anchored',
    continuity: 'measured',
    nowMs,
    wallClockMs: nowMs,
    rollbackDetected: false,
    storage: 'loaded',
    ...overrides,
  };
}

function base64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function grantCompactJws(
  sub: string,
  grantId: string,
  ticketIds: readonly string[],
): string {
  const claims = {
    schemaVersion: OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
    protocolVersion: OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
    iss: API_ORIGIN,
    aud: OFFLINE_GRANT_AUDIENCE,
    sub,
    jti: grantId,
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
      allocationId: grantId,
      generation: 1,
      ticketIds,
      budgetPolicy: OFFLINE_FREE_ALLOCATION_POLICY.id,
      financialExpiry: 'reconciliation_only',
    },
  };
  const header = { alg: 'ES256', typ: OFFLINE_GRANT_JWS_TYPE, kid: KEY_ID };
  return `${base64Url(JSON.stringify(header))}.${base64Url(
    JSON.stringify(claims),
  )}.${'A'.repeat(86)}`;
}

function issuedGrant(
  sub = OWNER,
  grantId = GRANT_ID,
  ticketIds: readonly string[] = TICKETS,
): IssuedOfflineGrant {
  const parsed = parseIssuedOfflineGrant({
    grantId,
    generation: 1,
    entitlementSource: 'identity_lifetime_free',
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    entitlementExpiresAt: null,
    ticketIds,
    keyId: KEY_ID,
    grant: {
      schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
      compactJws: grantCompactJws(sub, grantId, ticketIds),
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
      uri: 'file:///private/captures/court.pose.json',
      frameCount: dimmed.frames.length,
      sha256: sha256Hex(sidecar),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: dimmed.producedBy.modelVersion,
    },
  };
  return { clip, sidecar };
}

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
  extra: Partial<Pick<Response, 'redirected' | 'type' | 'url'>> = {},
): Response {
  return {
    ok: status < 400,
    status,
    statusText: String(status),
    redirected: false,
    type: 'basic',
    url: '',
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    json: async () => body,
    ...extra,
  } as unknown as Response;
}

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

type ReserveAnswer = (
  call: FetchCall,
) => Response | Promise<Response> | 'offline';

/** A scripted court network. `reserve` decides the permit reservation;
 * `receipts` decides the drain; everything else answers 404. */
function network(options: {
  reserve: ReserveAnswer;
  receipts?: (call: FetchCall) => Response | 'offline';
  finalize?: (call: FetchCall) => Response;
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
      const call: FetchCall = { url, method: String(init?.method), body };
      calls.push(call);
      const offline = () => {
        throw new TypeError('Network request failed');
      };
      if (isReleasePolicyRequest(url)) {
        if ((options.policy ?? 'offline') === 'offline') return offline();
        return response(200, activeReleaseAuthority());
      }
      if (url === PERMITS_ROUTE) {
        const answer = await options.reserve(call);
        return answer === 'offline' ? offline() : answer;
      }
      if (url.startsWith(`${PERMITS_ROUTE}/`) && url.endsWith('/finalize')) {
        if (options.finalize) return options.finalize(call);
        return offline();
      }
      if (url === RECEIPTS_ROUTE) {
        const answer = options.receipts ? options.receipts(call) : 'offline';
        return answer === 'offline' ? offline() : answer;
      }
      return response(404, { error: { code: 'not_found' } });
    },
  );
  globalThis.fetch = fetchPort as unknown as typeof fetch;
  return { calls, fetchPort };
}

const OFFLINE: ReserveAnswer = () => 'offline';

function acceptAll(status = 'result_recorded') {
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

function reservedPermit(id: string) {
  return response(200, {
    permit: {
      id,
      accessSource: 'free',
      status: 'reserved',
      expiresAt: new Date(NOW_MS + 15 * 60_000).toISOString(),
    },
    access: null,
  });
}

function finalizedPermit(call: FetchCall) {
  const id = decodeURIComponent(
    call.url.slice(PERMITS_ROUTE.length + 1, -'/finalize'.length),
  );
  return response(200, {
    permit: { id, status: 'released', outcome: call.body.outcome },
    access: null,
  });
}

async function seed(options: {
  policy?: boolean;
  grant?: boolean;
  visibility?: number | null;
  reading?: TrustedTimeReading;
}) {
  const store = createSqliteTestDb();
  const { clip, sidecar } = fixture(options.visibility ?? null);
  mockReadArtifact = async () => sidecar;
  seedSqliteCapture(store.db, OWNER, CAPTURE, clip);
  mockReading = options.reading ?? reading();
  if (options.policy ?? true) {
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
  if (options.grant ?? true) {
    await holdOfflineGrant(store.db, issuedGrant(), BINDING);
  }
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
  return { store, request, clip };
}

type Store = ReturnType<typeof createSqliteTestDb>;

function outboxKinds(store: Store, owner = OWNER): string[] {
  return store.native
    .prepare(`SELECT kind FROM outbox WHERE owner_key = ? ORDER BY kind`)
    .all(owner)
    .map(row => String(row.kind));
}

function journalRows(store: Store, owner = OWNER) {
  return store.native
    .prepare(
      `SELECT state, release_outcome, permit_id, result_id
       FROM analysis_run_journal WHERE owner_key = ?`,
    )
    .all(owner);
}

async function tickets(store: Store, at = reading()) {
  const allocation = await readOfflineAllocation(store.db, at);
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

function offlineClient() {
  return createOfflineGrantClient({ baseUrl: API_ORIGIN, token: BEARER });
}

async function scoredOffline(store: Store, request: RunCaptureAnalysisRequest) {
  network({ reserve: OFFLINE });
  const outcome = await runCaptureAnalysis(request);
  expect(outcome.kind).toBe('scored');
  if (outcome.kind !== 'scored' || !outcome.record.result) {
    throw new Error('precondition: the court-offline read must score');
  }
  expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
  const [receipt] = await pendingOfflineReceipts(store.db);
  if (!receipt) throw new Error('precondition: one receipt is queued');
  return { analysis: outcome.record.result, receipt };
}

const leases: OriginalAnalysisExecution[] = [];

beforeEach(() => {
  signIn();
});
afterEach(() => {
  for (const lease of leases.splice(0)) lease.dispose();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  globalThis.fetch = originalFetch;
  mockReading = null;
  mockOnTrustedTimeRead = null;
  jest.restoreAllMocks();
  jest.useRealTimers();
  closeSqliteTestDatabases();
});

async function seedOriginal() {
  const store = createSqliteTestDb();
  const { clip: bare, sidecar } = fixture();
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
  const verified = verifyReleasePolicy(activeReleaseAuthority().policy);
  if (!verified.ok) throw new Error('fixture policy must verify');
  await writeCachedReleasePolicy(
    store.db,
    { ownerKey: OWNER, apiOrigin: API_ORIGIN },
    { policy: verified.policy, serverTime: Math.floor(NOW_MS / 1000) },
  );
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
  const run = async () => {
    const operation = await prepareOriginalCaptureAnalysis(
      request,
      execution,
      OPERATION,
    );
    return runOriginalCaptureAnalysis({
      db: store.db,
      execution,
      operationId: operation.operationId,
    });
  };
  return { store, run };
}

describe('A0 the shipping entry point (AnalyzeScreen → runOriginalCaptureAnalysis)', () => {
  // AnalyzeScreen runs every signed-in, pose-backed capture through
  // prepareOriginalCaptureAnalysis + runOriginalCaptureAnalysis (its
  // `execution && clipSupportsScoring(clip)` branch). The objective is a
  // scored read on THAT path; the plain runCaptureAnalysis entry is the
  // session-less / pose-less legacy branch.
  it('control: the same harness scores through the original path when the service answers', async () => {
    const { store, run } = await seedOriginal();
    const net = network({
      reserve: () => reservedPermit('99999999-9999-4999-8999-999999999999'),
      finalize: finalizedPermit,
      policy: 'online',
    });
    const outcome = await run();
    expect(permitPosts(net.calls)).toHaveLength(1);
    expect(outcome.kind).toBe('scored');
    expect(store.count('local_shot', OWNER)).toBe(1);
    // A live permit paid for it: the offline wallet is untouched.
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
  });

  it('a signed-in camera capture on a court with no signal + cached policy + held grant produces a scored read', async () => {
    const { store, run } = await seedOriginal();
    const net = network({ reserve: OFFLINE });
    const outcome = await run();
    // The reservation was attempted and never answered…
    expect(permitPosts(net.calls)).toHaveLength(1);
    // …so the court must rate on-device, spend one ticket and queue one receipt.
    expect(outcome.kind).toBe('scored');
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(store.count('local_shot', OWNER)).toBe(1);
    expect(outboxKinds(store)).toEqual([]);
  });
});

describe('A1 crash between steps', () => {
  it('a rolled-back local_shot write spends nothing; the same operation is then held and a fresh operation on the same capture spends exactly once', async () => {
    const { store, request } = await seed({});
    network({ reserve: OFFLINE });
    store.failStatementOnce('INSERT OR REPLACE INTO local_shot');
    await expect(runCaptureAnalysis(request)).rejects.toThrow();
    // The transaction rolled back: no ticket, no receipt, no rating.
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
    expect(store.count('local_shot', OWNER)).toBe(0);
    expect(store.count('local_analysis_record', OWNER)).toBe(0);

    // The SAME operation id is a failed run's identity: the journal holds it
    // for recovery (as the live path does) and never spends for it.
    const retry = await runCaptureAnalysis(request);
    expect(retry).toMatchObject({
      kind: 'unavailable',
      cause: 'recovery_pending',
    });
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });

    // A fresh operation on the same capture (what the screen mints) scores
    // once.
    const fresh = await runCaptureAnalysis({
      ...request,
      operationId: '66666666-6666-4666-8666-666666666666',
    });
    expect(fresh.kind).toBe('scored');
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(store.count('local_shot', OWNER)).toBe(1);
  });

  it('a physical COMMIT that succeeds but loses its acknowledgement still returns the durable scored read (parity with the live path)', async () => {
    const { store, request } = await seed({});
    network({ reserve: OFFLINE });
    store.failCommitOnce('after', 'INSERT INTO offline_receipt');
    const outcome = await runCaptureAnalysis(request).catch(
      (error: unknown) => ({ kind: 'threw', error: String(error) }),
    );
    // The ticket IS spent and the rating IS persisted — the caller must learn
    // that, exactly as runCaptureJournalIntegration pins for a live permit
    // ("returns the original durable score when physical COMMIT succeeded but
    // its acknowledgement threw").
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(store.count('local_shot', OWNER)).toBe(1);
    expect(outcome).toMatchObject({ kind: 'scored' });
  });

  it('after a lost commit acknowledgement the same operation replays the paid rating without a second spend', async () => {
    const { store, request } = await seed({});
    network({ reserve: OFFLINE });
    store.failCommitOnce('after', 'INSERT INTO offline_receipt');
    await runCaptureAnalysis(request).catch(() => undefined);
    const replay = await runCaptureAnalysis(request);
    expect(replay.kind).toBe('scored');
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(store.count('local_shot', OWNER)).toBe(1);
  });
});

describe('A2 process restart + reconnect recovery', () => {
  it('the sync-runtime recovery sweep does not reserve a LIVE permit for an operation already paid offline', async () => {
    const { store, request } = await seed({});
    const { analysis } = await scoredOffline(store, request);
    const scope = runJournal.scope({ ownerKey: OWNER, apiOrigin: API_ORIGIN });
    // Restart: nothing is executing, the journal is whatever SQLite holds.
    expect(runJournal.activeOperationIds(scope)).toEqual([]);

    // The court gets signal back; the runtime runs its recovery sweep first
    // (syncRuntime.ts) with a server that WOULD hand out a permit.
    const online = network({
      reserve: () => reservedPermit('99999999-9999-4999-8999-999999999999'),
      finalize: finalizedPermit,
      receipts: acceptAll(),
      policy: 'online',
    });
    const permits = {
      ...scope,
      ...createAnalysisPermitClient({ baseUrl: API_ORIGIN, token: BEARER }),
    };
    await recoverAnalysisJournals(store.db, scope, permits, {
      excludeOperationIds: runJournal.activeOperationIds(scope),
    });

    // A paid, persisted offline rating is settled by its receipt. Reserving
    // a live permit for the same reservation key and then finalizing it as
    // `failed` tells the server this operation FAILED while the receipt says
    // it was recorded.
    expect(permitPosts(online.calls)).toHaveLength(0);
    expect(finalizePosts(online.calls)).toHaveLength(0);
    expect(journalRows(store)).not.toEqual([
      expect.objectContaining({ state: 'released', release_outcome: 'failed' }),
    ]);
    expect(analysis.id).toBeTruthy();
  });

  it('whatever the reconnect sweep did, the replay is the same rating with no second spend and the drain still settles it', async () => {
    const { store, request } = await seed({});
    const { analysis } = await scoredOffline(store, request);
    const scope = runJournal.scope({ ownerKey: OWNER, apiOrigin: API_ORIGIN });
    network({
      reserve: () => reservedPermit('99999999-9999-4999-8999-999999999999'),
      finalize: finalizedPermit,
      receipts: acceptAll(),
      policy: 'online',
    });
    const permits = {
      ...scope,
      ...createAnalysisPermitClient({ baseUrl: API_ORIGIN, token: BEARER }),
    };
    await recoverAnalysisJournals(store.db, scope, permits, {
      excludeOperationIds: runJournal.activeOperationIds(scope),
    });
    const replay = await runCaptureAnalysis(request);
    expect(replay.kind).toBe('scored');
    if (replay.kind === 'scored') {
      expect(replay.record.result?.id).toBe(analysis.id);
    }
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    const drained = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
    );
    expect(drained).toMatchObject({ submitted: 1, accepted: 1 });
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(true);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
  });
});

describe('A3 concurrent double submit', () => {
  it('two simultaneous runs of the same operation spend one ticket, persist one rating and queue one receipt', async () => {
    const { store, request } = await seed({});
    network({ reserve: OFFLINE });
    const results = await Promise.allSettled([
      runCaptureAnalysis(request),
      runCaptureAnalysis(request),
    ]);
    const kinds = results.map(result =>
      result.status === 'fulfilled' ? result.value.kind : 'threw',
    );
    expect(kinds).toContain('scored');
    expect(kinds).not.toContain('threw');
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(store.count('local_shot', OWNER)).toBe(1);
    expect(store.count('local_analysis_record', OWNER)).toBe(1);
    expect(outboxKinds(store)).toEqual([]);

    const settled = await runCaptureAnalysis(request);
    expect(settled.kind).toBe('scored');
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
  });

  it('two concurrent drains present the receipt once and settle it once', async () => {
    const { store, request } = await seed({});
    const { analysis } = await scoredOffline(store, request);
    const online = network({ reserve: OFFLINE, receipts: acceptAll() });
    const [first, second] = await Promise.all([
      reconcileOfflineWallet(store.db, offlineClient(), reading()),
      reconcileOfflineWallet(store.db, offlineClient(), reading()),
    ]);
    const posts = online.calls.filter(call => call.url === RECEIPTS_ROUTE);
    expect(posts).toHaveLength(1);
    expect(first.accepted + second.accepted).toBe(1);
    expect(first.submitted + second.submitted).toBe(1);
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(true);
    expect(store.count('sync_receipt', OWNER)).toBe(1);
  });
});

describe('A4 interleaved account switch', () => {
  it("an account switch during the offline authority read never spends the OTHER account's grant", async () => {
    // OTHER holds an executable grant; OWNER holds none.
    signIn(OTHER);
    const store = createSqliteTestDb();
    await holdOfflineGrant(
      store.db,
      issuedGrant(OTHER, OTHER_GRANT_ID, OTHER_TICKETS),
      BINDING,
    );
    signIn(OWNER);
    const { clip, sidecar } = fixture();
    mockReadArtifact = async () => sidecar;
    seedSqliteCapture(store.db, OWNER, CAPTURE, clip);
    mockReading = reading();
    const verified = verifyReleasePolicy(activeReleaseAuthority().policy);
    if (!verified.ok) throw new Error('fixture policy must verify');
    await writeCachedReleasePolicy(
      store.db,
      { ownerKey: OWNER, apiOrigin: API_ORIGIN },
      { policy: verified.policy, serverTime: Math.floor(NOW_MS / 1000) },
    );
    await writeCachedReleasePolicy(
      store.db,
      { ownerKey: OTHER, apiOrigin: API_ORIGIN },
      { policy: verified.policy, serverTime: Math.floor(NOW_MS / 1000) },
    );
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
    network({ reserve: OFFLINE });
    let switched = false;
    mockOnTrustedTimeRead = () => {
      if (switched) return;
      switched = true;
      signIn(OTHER);
    };
    const outcome = await runCaptureAnalysis(request);
    expect(switched).toBe(true);
    expect(outcome.kind).not.toBe('scored');
    expect(outcome).toMatchObject({ kind: 'unavailable' });
    // OTHER's wallet is untouched, nothing is rated for either owner.
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
    expect(store.count('local_shot', OWNER)).toBe(0);
    expect(store.count('local_shot', OTHER)).toBe(0);
    expect(store.count('local_analysis_record', OWNER)).toBe(0);
    expect(store.count('local_analysis_record', OTHER)).toBe(0);
    expect(store.count('offline_receipt', OTHER)).toBe(0);
    expect(store.count('offline_receipt', OWNER)).toBe(0);
  });

  it("a drain by OTHER presents nothing of OWNER's and OWNER's receipt stays queued", async () => {
    const { store, request } = await seed({});
    const { analysis } = await scoredOffline(store, request);
    signIn(OTHER);
    const online = network({ reserve: OFFLINE, receipts: acceptAll() });
    const drained = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
    );
    expect(drained).toMatchObject({ submitted: 0, accepted: 0 });
    expect(
      online.calls.filter(call => call.url === RECEIPTS_ROUTE),
    ).toHaveLength(0);
    signIn(OWNER);
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);
  });
});

describe('A5 replay and duplicate identities', () => {
  it('a tampered persisted output is never replayed as the rating and never spends again', async () => {
    const { store, request } = await seed({});
    const { analysis, receipt } = await scoredOffline(store, request);
    const tampered = { ...analysis, overallScore: 99 };
    store.native
      .prepare(
        `UPDATE local_shot SET payload = ?, overall_score = 99
         WHERE owner_key = ? AND id = ?`,
      )
      .run(JSON.stringify(tampered), OWNER, analysis.id);

    // The candidate's contract for a broken replay link is a thrown
    // identity_conflict (runCaptureAnalysis catch block) — acceptable, as
    // long as the tampered payload is never returned as the rating.
    const replay = await runCaptureAnalysis(request).catch(
      (error: unknown) => ({ kind: 'threw', error: String(error) }),
    );
    expect(replay).not.toMatchObject({ kind: 'scored' });
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(store.count('local_shot', OWNER)).toBe(1);

    // The drain never presents an output whose hash the receipt did not sign.
    const online = network({
      reserve: OFFLINE,
      receipts: acceptAll('pending'),
    });
    await reconcileOfflineWallet(store.db, offlineClient(), reading());
    const posts = online.calls.filter(call => call.url === RECEIPTS_ROUTE);
    expect(posts).toHaveLength(1);
    const entries = posts[0]!.body.receipts as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.output).toBeNull();
    expect((entries[0]!.receipt as Record<string, unknown>).receiptId).toBe(
      receipt.receiptId,
    );
  });

  it('the same operation id presented with a DIFFERENT capture never scores, never spends', async () => {
    const { store, request } = await seed({});
    await scoredOffline(store, request);
    const otherCapture = '55555555-5555-4555-8555-555555555555';
    const { clip, sidecar } = fixture(
      null,
      'file:///private/captures/other.mov',
    );
    mockReadArtifact = async () => sidecar;
    seedSqliteCapture(store.db, OWNER, otherCapture, clip);
    const outcome = await runCaptureAnalysis({
      ...request,
      captureId: otherCapture,
      clip,
    }).catch((error: unknown) => ({ kind: 'threw', error: String(error) }));
    expect(outcome).not.toMatchObject({ kind: 'scored' });
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(store.count('local_shot', OWNER)).toBe(1);
  });

  it('a second capture on the court spends the SECOND ticket and a third is the honest no-score path', async () => {
    const { store, request } = await seed({});
    await scoredOffline(store, request);
    const second = '55555555-5555-4555-8555-555555555555';
    const secondOp = '66666666-6666-4666-8666-666666666666';
    const third = '77777777-7777-4777-8777-777777777777';
    const thirdOp = '88888888-8888-4888-8888-888888888888';
    const { clip, sidecar } = fixture(
      null,
      'file:///private/captures/second.mov',
    );
    const thirdClip = fixture(null, 'file:///private/captures/third.mov').clip;
    mockReadArtifact = async () => sidecar;
    seedSqliteCapture(store.db, OWNER, second, clip);
    seedSqliteCapture(store.db, OWNER, third, thirdClip);
    const two = await runCaptureAnalysis({
      ...request,
      operationId: secondOp,
      captureId: second,
      clip,
    });
    expect(two.kind).toBe('scored');
    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 2 });
    const receipts = await pendingOfflineReceipts(store.db);
    expect(receipts.map(r => r.ticket?.ticketId).sort()).toEqual(
      [...TICKETS].sort(),
    );
    const three = await runCaptureAnalysis({
      ...request,
      operationId: thirdOp,
      captureId: third,
      clip: thirdClip,
    });
    expect(three.kind).toBe('unavailable');
    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 2 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(2);
    expect(store.count('local_shot', OWNER)).toBe(2);
  });
});

describe('A6 connectivity vs verdict classification at the reservation', () => {
  async function reserveWith(answer: ReserveAnswer) {
    const { store, request } = await seed({});
    const net = network({ reserve: answer });
    const outcome = await runCaptureAnalysis(request);
    return { store, outcome, net };
  }

  it('429 + Retry-After with a coded envelope is a verdict: no score, nothing spent', async () => {
    const { store, outcome } = await reserveWith(() =>
      response(
        429,
        { error: { code: 'rate_limited', message: 'Slow down.' } },
        { 'retry-after': '30' },
      ),
    );
    expect(outcome.kind).toBe('unavailable');
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
    expect(store.count('local_shot', OWNER)).toBe(0);
  });

  it('429 WITHOUT an envelope (a gateway budget) is still not an offline case', async () => {
    const { store, outcome } = await reserveWith(() =>
      response(429, 'Too Many Requests', { 'retry-after': '1' }),
    );
    expect(outcome.kind).toBe('unavailable');
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(store.count('local_shot', OWNER)).toBe(0);
  });

  it('a 409 permit_not_reserved verdict (200 body whose permit is already settled) is not offline', async () => {
    const { store, outcome } = await reserveWith(() =>
      response(200, {
        permit: {
          id: '99999999-9999-4999-8999-999999999999',
          accessSource: 'free',
          status: 'consumed',
          expiresAt: new Date(NOW_MS + 60_000).toISOString(),
        },
      }),
    );
    expect(outcome.kind).toBe('unavailable');
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(store.count('local_shot', OWNER)).toBe(0);
  });

  it('a coded 401 (session expired) is a verdict, not a connectivity failure', async () => {
    const { store, outcome } = await reserveWith(() =>
      response(401, {
        error: { code: 'auth.session_expired', message: 'Sign in again.' },
      }),
    );
    expect(outcome.kind).toBe('unavailable');
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(store.count('local_shot', OWNER)).toBe(0);
  });

  it('a coded 403 (unauthorised role) is a verdict, not a connectivity failure', async () => {
    const { store, outcome } = await reserveWith(() =>
      response(403, {
        error: { code: 'auth.forbidden', message: 'Not allowed.' },
      }),
    );
    expect(outcome.kind).toBe('unavailable');
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(store.count('local_shot', OWNER)).toBe(0);
  });

  it('a coded 402 allowance refusal is not offline even when the court also has no policy service', async () => {
    const { store, outcome } = await reserveWith(() =>
      response(402, {
        error: {
          code: 'access.free_ratings_exhausted',
          message: 'Your free ratings are used.',
        },
      }),
    );
    expect(outcome.kind).toBe('unavailable');
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(store.count('local_shot', OWNER)).toBe(0);
  });

  it('a 503 from the origin is connectivity: the court scores once and spends one ticket', async () => {
    const { store, outcome } = await reserveWith(() =>
      response(503, {
        error: { code: 'service.unavailable', message: 'Try again later.' },
      }),
    );
    expect(outcome.kind).toBe('scored');
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
  });

  it('a captive-portal redirect (302) is connectivity', async () => {
    const { store, outcome } = await reserveWith(() =>
      response(302, undefined, { location: 'https://portal.example/login' }),
    );
    expect(outcome.kind).toBe('scored');
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
  });

  it('an unreadable 404 HTML page (no envelope) is connectivity', async () => {
    const { store, outcome } = await reserveWith(() =>
      response(404, '<html>not found</html>'),
    );
    expect(outcome.kind).toBe('scored');
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
  });

  it('a reservation that never answers hits the 20s request timeout and is connectivity', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    const { store, request } = await seed({});
    network({
      reserve: () =>
        new Promise<Response>(() => {
          // never answers
        }),
    });
    const pending = runCaptureAnalysis(request);
    await jest.advanceTimersByTimeAsync(25_000);
    const outcome = await pending;
    expect(outcome.kind).toBe('scored');
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
  });

  it('a 200 that names no permit (client-synthesised 502 access.permit_invalid) — documents the classification', async () => {
    const { store, outcome } = await reserveWith(() => response(200, {}));
    // The candidate treats every synthesised >=500 as connectivity. Record
    // the behaviour so the reviewer can judge it; the ticket count must be
    // consistent with the outcome either way.
    if (outcome.kind === 'scored') {
      expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    } else {
      expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    }
  });
});

describe('A7 clock boundaries', () => {
  async function runAt(at: TrustedTimeReading) {
    const { store, request } = await seed({ reading: at });
    network({ reserve: OFFLINE });
    const outcome = await runCaptureAnalysis(request);
    return { store, outcome };
  }

  it('a far-future trusted clock (past grant expiry) never scores offline', async () => {
    const { store, outcome } = await runAt(
      reading(NOW_MS + 30 * 24 * 60 * 60_000),
    );
    expect(outcome.kind).toBe('unavailable');
    expect(store.count('offline_receipt', OWNER)).toBe(0);
    expect(store.count('local_shot', OWNER)).toBe(0);
  });

  it('a clock before the grant was issued never scores offline', async () => {
    const { store, outcome } = await runAt(
      reading(NOW_MS - 365 * 24 * 60 * 60_000),
    );
    expect(outcome.kind).toBe('unavailable');
    expect(store.count('offline_receipt', OWNER)).toBe(0);
    expect(store.count('local_shot', OWNER)).toBe(0);
  });

  it('a detected clock rollback never scores offline', async () => {
    const { store, outcome } = await runAt(
      reading(NOW_MS, { rollbackDetected: true, continuity: 'persisted' }),
    );
    expect(outcome.kind).toBe('unavailable');
    expect(store.count('offline_receipt', OWNER)).toBe(0);
    expect(store.count('local_shot', OWNER)).toBe(0);
  });

  it('an unanchored (device-only) clock never scores offline', async () => {
    const { store, outcome } = await runAt(
      reading(NOW_MS, { authority: 'none', continuity: 'none' }),
    );
    expect(outcome.kind).toBe('unavailable');
    expect(store.count('offline_receipt', OWNER)).toBe(0);
    expect(store.count('local_shot', OWNER)).toBe(0);
  });

  it('a NaN clock never scores offline and never queues a receipt with an invalid queuedAt', async () => {
    const { store, outcome } = await runAt(reading(Number.NaN));
    expect(outcome.kind).toBe('unavailable');
    expect(store.count('offline_receipt', OWNER)).toBe(0);
    expect(store.count('local_shot', OWNER)).toBe(0);
  });

  it('a trusted-time read failure on the court is the honest no-score path', async () => {
    const { store, request } = await seed({});
    mockReading = null;
    network({ reserve: OFFLINE });
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).toBe('unavailable');
    expect(store.count('offline_receipt', OWNER)).toBe(0);
    expect(store.count('local_shot', OWNER)).toBe(0);
  });
});

describe('A8 corrupt or partial persisted state before the drain', () => {
  it('a missing local shot presents output: null (never an invented output) and the receipt is held, not refused locally', async () => {
    const { store, request } = await seed({});
    const { analysis, receipt } = await scoredOffline(store, request);
    store.native
      .prepare(`DELETE FROM local_shot WHERE owner_key = ? AND id = ?`)
      .run(OWNER, analysis.id);
    const online = network({
      reserve: OFFLINE,
      receipts: acceptAll('pending'),
    });
    const drained = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
    );
    expect(drained).toMatchObject({ submitted: 1, held: 1, refused: 0 });
    const posts = online.calls.filter(call => call.url === RECEIPTS_ROUTE);
    const entries = posts[0]!.body.receipts as Array<Record<string, unknown>>;
    expect(entries[0]!.output).toBeNull();
    expect((entries[0]!.receipt as Record<string, unknown>).receiptId).toBe(
      receipt.receiptId,
    );
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
  });

  it('a missing grant row never records a presentation that was never sent', async () => {
    const { store, request } = await seed({});
    await scoredOffline(store, request);
    store.native
      .prepare(`DELETE FROM offline_grant WHERE owner_key = ? AND grant_id = ?`)
      .run(OWNER, GRANT_ID);
    const online = network({ reserve: OFFLINE, receipts: acceptAll() });
    await expect(
      reconcileOfflineWallet(store.db, offlineClient(), reading()),
    ).rejects.toThrow();
    // Nothing reached the server…
    expect(
      online.calls.filter(call => call.url === RECEIPTS_ROUTE),
    ).toHaveLength(0);
    // …so the wallet must not claim an unanswered presentation exists.
    const status = await readOfflineWalletStatus(store.db);
    const journal = await readOfflineWalletJournal(store.db);
    expect(journal.filter(entry => entry.state === 'in_flight')).toHaveLength(
      0,
    );
    expect(status.hold).toBe(false);
    expect(status.pending[0]?.phase).toBe('queued');
  });

  it('a corrupt receipt row is never re-spent by the replay path', async () => {
    const { store, request } = await seed({});
    await scoredOffline(store, request);
    store.native
      .prepare(
        `UPDATE offline_receipt SET receipt = '{"garbage":true}'
         WHERE owner_key = ? AND operation_id = ?`,
      )
      .run(OWNER, OPERATION);
    const replay = await runCaptureAnalysis(request).catch(
      (error: unknown) => error,
    );
    expect(replay).not.toMatchObject({ kind: 'scored' });
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(store.count('local_shot', OWNER)).toBe(1);
    expect(store.count('offline_receipt', OWNER)).toBe(1);
  });
});

describe('A9 network failure at each drain step', () => {
  it('a 503 on the drain keeps the receipt pending and re-presents the SAME receipt id', async () => {
    const { store, request } = await seed({});
    const { analysis, receipt } = await scoredOffline(store, request);
    let answers = 0;
    const online = network({
      reserve: OFFLINE,
      receipts: call => {
        answers += 1;
        if (answers === 1) return response(503, {});
        return acceptAll()(call);
      },
    });
    await expect(
      reconcileOfflineWallet(store.db, offlineClient(), reading()),
    ).rejects.toThrow();
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);
    expect((await readOfflineWalletStatus(store.db)).hold).toBe(true);

    const second = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
    );
    expect(second).toMatchObject({ submitted: 1, accepted: 1, recovered: 1 });
    const posts = online.calls.filter(call => call.url === RECEIPTS_ROUTE);
    expect(posts).toHaveLength(2);
    for (const post of posts) {
      const entries = post.body.receipts as Array<Record<string, unknown>>;
      expect(
        entries.map(e => (e.receipt as Record<string, unknown>).receiptId),
      ).toEqual([receipt.receiptId]);
    }
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(true);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect((await readOfflineWalletStatus(store.db)).hold).toBe(false);
  });

  it('429 + Retry-After on the drain settles nothing', async () => {
    const { store, request } = await seed({});
    const { analysis } = await scoredOffline(store, request);
    network({
      reserve: OFFLINE,
      receipts: () =>
        response(
          429,
          { error: { code: 'rate_limited', message: 'Slow down.' } },
          { 'retry-after': '30' },
        ),
    });
    await expect(
      reconcileOfflineWallet(store.db, offlineClient(), reading()),
    ).rejects.toThrow();
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
  });

  it('a verdict naming a receipt that was not presented settles nothing', async () => {
    const { store, request } = await seed({});
    const { analysis } = await scoredOffline(store, request);
    network({
      reserve: OFFLINE,
      receipts: () =>
        response(200, {
          receipts: [
            {
              receiptId: 'dddddddd-0000-4000-8000-000000000001',
              status: 'result_recorded',
            },
          ],
          rejected: [],
        }),
    });
    await expect(
      reconcileOfflineWallet(store.db, offlineClient(), reading()),
    ).rejects.toThrow();
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);
  });
});

describe('A10 free-rating conservation across settlement', () => {
  it('a refused receipt is terminal: the shot is never marked synced and the ticket is never returned locally', async () => {
    const { store, request } = await seed({});
    const { analysis, receipt } = await scoredOffline(store, request);
    const online = network({
      reserve: OFFLINE,
      receipts: () =>
        response(200, {
          receipts: [],
          rejected: [
            { receiptId: receipt.receiptId, code: 'offline.grant_revoked' },
          ],
        }),
    });
    const drained = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
    );
    expect(drained).toMatchObject({
      submitted: 1,
      accepted: 0,
      held: 0,
      refused: 1,
      pending: 0,
    });
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
    // The device never un-spends a ticket on its own: only a server grant
    // reconciliation may return it.
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    // A second drain has nothing to present.
    const again = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
    );
    expect(again).toMatchObject({ submitted: 0 });
    expect(
      online.calls.filter(call => call.url === RECEIPTS_ROUTE),
    ).toHaveLength(1);
  });

  it('an accepted receipt is idempotent: a later replay of the run and a later drain change nothing', async () => {
    const { store, request } = await seed({});
    const { analysis } = await scoredOffline(store, request);
    const online = network({ reserve: OFFLINE, receipts: acceptAll() });
    await reconcileOfflineWallet(store.db, offlineClient(), reading());
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(true);
    const replay = await runCaptureAnalysis(request);
    expect(replay.kind).toBe('scored');
    if (replay.kind === 'scored') {
      expect(replay.record.result?.id).toBe(analysis.id);
    }
    const again = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
    );
    expect(again).toMatchObject({ submitted: 0, accepted: 0 });
    expect(
      online.calls.filter(call => call.url === RECEIPTS_ROUTE),
    ).toHaveLength(1);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(store.count('sync_receipt', OWNER)).toBe(1);
    expect(outboxKinds(store)).toEqual([]);
  });

  it('an abstention after a scored read leaves the second ticket untouched and queues nothing new', async () => {
    const { store, request } = await seed({});
    await scoredOffline(store, request);
    const second = '55555555-5555-4555-8555-555555555555';
    const secondOp = '66666666-6666-4666-8666-666666666666';
    const { clip, sidecar } = fixture(0.5, 'file:///private/captures/dim.mov');
    mockReadArtifact = async () => sidecar;
    seedSqliteCapture(store.db, OWNER, second, clip);
    const outcome = await runCaptureAnalysis({
      ...request,
      operationId: secondOp,
      captureId: second,
      clip,
    });
    expect(outcome.kind).toBe('low_confidence');
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(outboxKinds(store)).toEqual([]);
  });
});
