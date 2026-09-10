/**
 * W05-07 adversarial suite — probes the court-offline scored read at its
 * failure boundaries: network classification (429 + Retry-After, 5xx,
 * redirect), trusted-time boundaries (rollback, unmeasured, floor-only,
 * far-future/past, NaN), allocation exhaustion, concurrent submits, an
 * account switch mid-commit, a crash + restart between steps, cross-owner
 * isolation, corrupt persisted state at drain time, malformed server
 * verdicts, refused settlements and the explicit "Check" reconciliation of a
 * saved analysis that was paid on the court.
 *
 * Every test states the invariant it expects the candidate to keep; a
 * failing test is a reproduced break, not a stylistic complaint.
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
  readOfflineWalletStatus,
  reconcileOfflineWallet,
} from '../src/data/offlineWallet';
import {
  getAnalysis,
  getShotOutboxStatus,
  hasShotSyncReceipt,
} from '../src/data/repository';
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
const CAPTURE_3 = '33333333-3333-4333-8333-333333333335';
const OPERATION = '44444444-4444-4444-8444-444444444444';
const OPERATION_2 = '44444444-4444-4444-8444-444444444445';
const OPERATION_3 = '44444444-4444-4444-8444-444444444446';
const API_ORIGIN = 'https://api.example.test/functions/v1/api';
const BEARER = 'fresh-owner-token';
const OTHER_BEARER = 'other-owner-token';
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

function signIn(owner = OWNER, bearer = BEARER) {
  setActiveDataOwner(owner);
  establishApiSession({
    canonicalAppUserId: owner,
    apiBaseUrl: API_ORIGIN,
    bearerToken: bearer,
    provider: 'apple',
  });
}

function fixture() {
  const { sequence, window } = generateSwingSequence();
  const sidecar = serializePoseSequence(sequence);
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
  const lower = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    ok: status < 400,
    status,
    statusText: String(status),
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    json: async () => body,
  } as unknown as Response;
}

interface FetchCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;
}

type PermitAnswer =
  'offline' | 'rate_limited' | 'server_error' | 'redirect' | 'reserved';

interface ReceiptVerdict {
  readonly receiptId: unknown;
  readonly status: string;
}

interface ServiceOptions {
  readonly permits: PermitAnswer;
  /** Shapes the receipt answer. Default: every receipt `result_recorded`. */
  readonly receipts?: (entries: Array<Record<string, unknown>>) => unknown;
}

/** The court's network with a configurable permit answer and receipt
 * verdicts. Every call is recorded with its URL, JSON body and headers. */
function service(options: ServiceOptions) {
  const calls: FetchCall[] = [];
  const fetchPort = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<
        string,
        unknown
      >;
      const headers = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      );
      calls.push({ url, body, headers });
      if (options.permits === 'offline')
        throw new TypeError('Network request failed');
      if (isReleasePolicyRequest(url))
        return response(200, activeReleaseAuthority());
      if (url === PERMITS_ROUTE) {
        switch (options.permits) {
          case 'rate_limited':
            return response(
              429,
              {
                error: {
                  code: 'rate_limited',
                  message: 'Too many requests.',
                },
              },
              { 'Retry-After': '30' },
            );
          case 'server_error':
            return response(503, {
              error: { code: 'unavailable', message: 'Try again later.' },
            });
          case 'redirect':
            return {
              ...response(200, {}),
              url: 'https://captive.example.test/login',
              redirected: true,
            } as unknown as Response;
          case 'reserved':
            return response(200, {
              permit: {
                id: LIVE_PERMIT_ID,
                accessSource: 'free',
                status: 'reserved',
                expiresAt: new Date(NOW_MS + 15 * 60_000).toISOString(),
              },
              access: null,
            });
        }
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
        const entries = (body.receipts ?? []) as Array<Record<string, unknown>>;
        if (options.receipts) return response(200, options.receipts(entries));
        return response(200, {
          receipts: entries.map((entry): ReceiptVerdict => ({
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

type Store = ReturnType<typeof createSqliteTestDb>;

async function cachePolicy(store: Store, owner = OWNER) {
  const verified = verifyReleasePolicy(activeReleaseAuthority().policy);
  if (!verified.ok) throw new Error('fixture policy must verify');
  expect(
    await writeCachedReleasePolicy(
      store.db,
      { ownerKey: owner, apiOrigin: API_ORIGIN },
      { policy: verified.policy, serverTime: Math.floor(NOW_MS / 1000) },
    ),
  ).toBe(true);
}

function requestFor(
  store: Store,
  clip: CapturedClip,
  operationId: string,
  captureId: string,
): RunCaptureAnalysisRequest {
  return {
    db: store.db,
    ownerContext: captureDataOwnerContext(),
    operationId,
    captureId,
    clip,
    declaredStroke: 'forehand_drive',
    declaredCanonical: 'FOREHAND_DRIVE',
    handedness: 'right',
    cameraView: 'side',
    apiConfig: { baseUrl: API_ORIGIN, token: BEARER },
    appVersion: '0.1.0',
  };
}

/** Plain-run court: cached policy + held grant + the requested network. Three
 * captures are seeded so allocation exhaustion can be probed. */
async function setup(options: ServiceOptions) {
  const store = createSqliteTestDb();
  const { clip, sidecar } = fixture();
  mockReadArtifact = async () => sidecar;
  // local_capture is unique per (owner, uri): each court capture is its own
  // clip so three operations can exist side by side.
  const clipFor = (ordinal: number): CapturedClip => ({
    ...clip,
    uri: `file:///private/captures/court-${ordinal}.mov`,
  });
  const clips = [clipFor(1), clipFor(2), clipFor(3)] as const;
  seedSqliteCapture(store.db, OWNER, CAPTURE, clips[0]);
  seedSqliteCapture(store.db, OWNER, CAPTURE_2, clips[1]);
  seedSqliteCapture(store.db, OWNER, CAPTURE_3, clips[2]);
  expect(store.count('local_capture', OWNER)).toBe(3);
  mockReading = reading();
  await cachePolicy(store);
  await holdOfflineGrant(store.db, issuedGrant(), BINDING);
  const network = service(options);
  const request = requestFor(store, clips[0], OPERATION, CAPTURE);
  return {
    store,
    clip: clips[0],
    request,
    network,
    second: requestFor(store, clips[1], OPERATION_2, CAPTURE_2),
    third: requestFor(store, clips[2], OPERATION_3, CAPTURE_3),
  };
}

function outboxKinds(store: Store, owner = OWNER): string[] {
  return store.native
    .prepare(`SELECT kind FROM outbox WHERE owner_key = ? ORDER BY kind`)
    .all(owner)
    .map(row => String(row.kind));
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

function journalRows(store: Store) {
  return store.native
    .prepare(
      `SELECT operation_id, state, release_outcome, permit_id
       FROM analysis_run_journal WHERE owner_key = ?`,
    )
    .all(OWNER);
}

const leases: OriginalAnalysisExecution[] = [];

/** The shipping entry point (AnalyzeScreen → prepareOriginalCaptureAnalysis
 * + runOriginalCaptureAnalysis) on a court with the requested network. */
async function setupOriginal(options: ServiceOptions) {
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
  await cachePolicy(store);
  await holdOfflineGrant(store.db, issuedGrant(), BINDING);
  const network = service(options);
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
  const run = async (): Promise<RunCaptureAnalysisOutcome> => {
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
  return { store, run, network, execution };
}

function client(token = BEARER) {
  return createOfflineGrantClient({ baseUrl: API_ORIGIN, token });
}

beforeEach(() => {
  signIn();
});
afterEach(() => {
  for (const lease of leases.splice(0)) lease.dispose();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  globalThis.fetch = originalFetch;
  mockReading = null;
  (getDb as jest.Mock).mockReset();
  jest.restoreAllMocks();
  closeSqliteTestDatabases();
});

describe('A1 network classification at the reservation', () => {
  it('429 + Retry-After is an answered request, not a lost one: no offline score, nothing spent', async () => {
    const { store, request, network } = await setup({
      permits: 'rate_limited',
    });
    const outcome = await runCaptureAnalysis(request);
    expect(permitPosts(network.calls)).toHaveLength(1);
    expect(outcome.kind).toBe('unavailable');
    expect(store.count('local_shot', OWNER)).toBe(0);
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
  });

  it('a 503 that never produced a verdict is a connectivity failure: the court rates once and queues one receipt', async () => {
    const { store, request } = await setup({ permits: 'server_error' });
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).toBe('scored');
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(outboxKinds(store)).toEqual([]);
  });

  it('a captive-portal redirect is a connectivity failure: the court rates once and queues one receipt', async () => {
    const { store, request } = await setup({ permits: 'redirect' });
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).toBe('scored');
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
  });
});

describe('A2 trusted-time boundaries gate the held grant', () => {
  const cases: Array<[string, () => TrustedTimeReading]> = [
    [
      'wall-clock rollback detected',
      () => reading(NOW_MS, { rollbackDetected: true }),
    ],
    [
      'app left the foreground since the anchor (floor + unmeasured)',
      () => reading(NOW_MS, { authority: 'floor', continuity: 'unmeasured' }),
    ],
    [
      'persisted floor only',
      () => reading(NOW_MS, { authority: 'floor', continuity: 'persisted' }),
    ],
    ['no trusted time at all', () => reading(NOW_MS, { authority: 'none' })],
    ['far-future clock (grant expired)', () => reading(EXPIRES_AT * 1000 + 1)],
    [
      'far-past clock (grant issued in the future)',
      () => reading((ISSUED_AT - 2 * 24 * 60 * 60) * 1000),
    ],
    ['NaN clock', () => reading(Number.NaN)],
    ['negative clock', () => reading(-1)],
  ];
  for (const [label, make] of cases) {
    it(`${label} → honest no-score, nothing spent, no receipt`, async () => {
      const { store, request } = await setup({ permits: 'offline' });
      mockReading = make();
      const outcome = await runCaptureAnalysis(request);
      expect(outcome.kind).toBe('unavailable');
      expect(store.count('local_shot', OWNER)).toBe(0);
      expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
      expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
    });
  }
});

describe('A3 allocation exhaustion is the maximum boundary', () => {
  it('two tickets rate exactly two captures; the third is an honest no-score with no phantom shot', async () => {
    const { store, request, second, third } = await setup({
      permits: 'offline',
    });
    expect((await runCaptureAnalysis(request)).kind).toBe('scored');
    expect((await runCaptureAnalysis(second)).kind).toBe('scored');
    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 2 });
    const outcome = await runCaptureAnalysis(third);
    expect(outcome.kind).toBe('unavailable');
    expect(store.count('local_shot', OWNER)).toBe(2);
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(2);
    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 2 });
  });
});

describe('A4 concurrency', () => {
  it('a double submit of the same operation spends one ticket and persists one shot', async () => {
    const { store, request } = await setup({ permits: 'offline' });
    const [first, second] = await Promise.all([
      runCaptureAnalysis(request),
      runCaptureAnalysis(request),
    ]);
    const kinds = [first.kind, second.kind].sort();
    expect(kinds[0]).toBe('scored');
    expect(['scored', 'unavailable']).toContain(kinds[1]);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(store.count('local_shot', OWNER)).toBe(1);
  });

  it('two captures racing for the last ticket: exactly one is scored, the other never persists a rating', async () => {
    const { store, request, second, third } = await setup({
      permits: 'offline',
    });
    expect((await runCaptureAnalysis(request)).kind).toBe('scored');
    const outcomes = await Promise.allSettled([
      runCaptureAnalysis(second),
      runCaptureAnalysis(third),
    ]);
    const scored = outcomes.filter(
      result => result.status === 'fulfilled' && result.value.kind === 'scored',
    );
    expect(scored).toHaveLength(1);
    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 2 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(2);
    expect(store.count('local_shot', OWNER)).toBe(2);
  });
});

describe('A5 account switch mid-commit', () => {
  it('the owner changes after the receipt row is written: the transaction rolls back, nothing is spent for either owner', async () => {
    const { store, request } = await setup({ permits: 'offline' });
    store.observeStatements(call => {
      if (call.sql.includes('INSERT INTO offline_receipt')) {
        store.observeStatements(null);
        setActiveDataOwner(OTHER);
      }
    });
    const outcome = await runCaptureAnalysis(request);
    expect(outcome).toMatchObject({
      kind: 'unavailable',
      cause: 'account_changed',
    });
    signIn();
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
    expect(store.count('local_shot', OWNER)).toBe(0);
    expect(store.count('local_shot', OTHER)).toBe(0);
    expect(store.count('offline_receipt', OTHER)).toBe(0);
  });
});

describe('A6 crash between steps and restart', () => {
  it('the receipt insert fails mid-commit: nothing spent; the SAME operation retried after relaunch is never charged twice', async () => {
    const { store, request } = await setup({ permits: 'offline' });
    store.failStatementOnce('INSERT INTO offline_receipt');
    await expect(runCaptureAnalysis(request)).rejects.toThrow();
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
    expect(store.count('local_shot', OWNER)).toBe(0);

    const retry = await runCaptureAnalysis(request);
    expect(['scored', 'unavailable']).toContain(retry.kind);
    const spent = await tickets(store);
    expect(spent.consumed).toBeLessThanOrEqual(1);
    expect(store.count('local_shot', OWNER)).toBe(spent.consumed);
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(spent.consumed);
  });

  it('the process dies after COMMIT: the durable rating survives a relaunch on a new execution and a signal-restored replay reserves no live permit', async () => {
    const { store, run } = await setupOriginal({ permits: 'offline' });
    store.failCommitOnce('after', 'INSERT INTO offline_receipt');
    const outcome = await run();
    expect(outcome.kind).toBe('scored');
    // Relaunch: a fresh execution lease for the same owner, signal restored.
    const online = service({ permits: 'reserved' });
    const relaunched = new OriginalAnalysisExecution(
      captureDataOwnerContext(),
      API_ORIGIN,
    );
    leases.push(relaunched);
    const replay = await runOriginalCaptureAnalysis({
      db: store.db,
      execution: relaunched,
      operationId: OPERATION,
    });
    expect(replay).toMatchObject({ kind: 'scored', replayed: true });
    expect(permitPosts(online.calls)).toHaveLength(0);
    expect(finalizePosts(online.calls)).toHaveLength(0);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(store.count('local_shot', OWNER)).toBe(1);
  });
});

describe('A7 the explicit "Check" of a saved analysis paid on the court', () => {
  it('reconcileOriginalCaptureAnalysis on an offline-paid attempt reserves no live permit and finalizes nothing', async () => {
    const { store, run, execution } = await setupOriginal({
      permits: 'offline',
    });
    const outcome = await run();
    expect(outcome.kind).toBe('scored');
    const paid = attemptRows(store);
    expect(paid).toEqual([expect.objectContaining({ permit_id: null })]);
    const receipts = await pendingOfflineReceipts(store.db);
    expect(receipts).toHaveLength(1);

    // Signal returns; the user taps "Check" on the saved analysis.
    const online = service({ permits: 'reserved' });
    await reconcileOriginalCaptureAnalysis({
      db: store.db,
      execution,
      operationId: OPERATION,
    });
    // An operation paid offline is settled ONLY by its receipt: the same
    // rule the sync sweep enforces through guardOfflinePaidReservations().
    expect({
      permitPosts: permitPosts(online.calls).length,
      finalizePosts: finalizePosts(online.calls).map(call => call.body),
      attempts: attemptRows(store),
    }).toEqual({ permitPosts: 0, finalizePosts: [], attempts: paid });
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
  });

  it('after the Check, retrying the saved analysis with signal still replays the paid read and spends nothing more', async () => {
    const { store, run, execution } = await setupOriginal({
      permits: 'offline',
    });
    const outcome = await run();
    expect(outcome.kind).toBe('scored');
    service({ permits: 'reserved' });
    await reconcileOriginalCaptureAnalysis({
      db: store.db,
      execution,
      operationId: OPERATION,
    });
    const attemptId = String(
      store.native
        .prepare(
          `SELECT operation_id FROM analysis_execution_attempts WHERE owner_key = ?`,
        )
        .get(OWNER)?.operation_id,
    );
    const again = await runOriginalCaptureAnalysis({
      db: store.db,
      execution,
      operationId: OPERATION,
      predecessorAttemptId: attemptId,
    });
    expect(again.kind).toBe('scored');
    expect(store.count('local_shot', OWNER)).toBe(1);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
  });
});

describe('A8 cross-owner isolation of receipts and shots', () => {
  it('another signed-in account cannot present, settle or sync the owner’s court receipt', async () => {
    const { store, request } = await setup({ permits: 'offline' });
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored' || !outcome.record.result) return;
    const analysis = outcome.record.result;

    clearApiSession();
    signIn(OTHER, OTHER_BEARER);
    const online = service({ permits: 'reserved' });
    const drained = await reconcileOfflineWallet(
      store.db,
      client(OTHER_BEARER),
      reading(),
    );
    expect(drained).toMatchObject({ submitted: 0, accepted: 0 });
    expect(receiptPosts(online.calls)).toHaveLength(0);
    expect(await getAnalysis(store.db, analysis.id)).toBeNull();
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);

    clearApiSession();
    signIn();
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);
    expect(await getAnalysis(store.db, analysis.id)).toEqual(analysis);
  });
});

describe('A9 corrupt persisted state at drain time', () => {
  it('a tampered shot payload is never presented as the paid output; the receipt goes out with output null', async () => {
    const { store, request } = await setup({ permits: 'offline' });
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored' || !outcome.record.result) return;
    const tampered = { ...outcome.record.result, overallScore: 99 };
    store.native
      .prepare(
        `UPDATE local_shot SET payload = ? WHERE owner_key = ? AND id = ?`,
      )
      .run(JSON.stringify(tampered), OWNER, tampered.id);
    const online = service({
      permits: 'reserved',
      receipts: entries => ({
        receipts: entries.map(entry => ({
          receiptId: (entry.receipt as Record<string, unknown>).receiptId,
          status: 'pending',
        })),
        rejected: [],
      }),
    });
    const drained = await reconcileOfflineWallet(store.db, client(), reading());
    expect(drained).toMatchObject({ submitted: 1, held: 1 });
    const posted = receiptPosts(online.calls);
    expect(posted).toHaveLength(1);
    const entries = posted[0]!.body.receipts as Array<Record<string, unknown>>;
    expect(entries[0]!.output).toBeNull();
    expect(JSON.stringify(posted[0]!.body)).not.toContain('"overallScore":99');
  });

  it('an unreadable shot payload must not journal a presentation that was never sent, and must not wedge every other receipt of the owner', async () => {
    const { store, request, second } = await setup({ permits: 'offline' });
    const first = await runCaptureAnalysis(request);
    expect(first.kind).toBe('scored');
    if (first.kind !== 'scored' || !first.record.result) return;
    expect((await runCaptureAnalysis(second)).kind).toBe('scored');
    const queued = await pendingOfflineReceipts(store.db);
    expect(queued).toHaveLength(2);
    const healthy = queued.find(
      receipt => receipt.resultId !== first.record.result?.id,
    );
    expect(healthy).toBeDefined();
    // The persisted payload of the FIRST shot is no longer JSON. The wire
    // contract says `output: null` when the device no longer holds the exact
    // payload; nothing about the SECOND receipt changed.
    store.native
      .prepare(
        `UPDATE local_shot SET payload = ? WHERE owner_key = ? AND id = ?`,
      )
      .run('not json', OWNER, first.record.result.id);

    const online = service({ permits: 'reserved' });
    let thrown: unknown = null;
    try {
      await reconcileOfflineWallet(store.db, client(), reading());
    } catch (error) {
      thrown = error;
    }
    const status = await readOfflineWalletStatus(store.db);
    const presented = receiptPosts(online.calls).flatMap(call =>
      (call.body.receipts as Array<Record<string, unknown>>).map(
        entry => entry.receiptId,
      ),
    );
    // A HOLD is an ambiguous commitment. With nothing sent there was no
    // commitment, so no presentation may be on record; and one unreadable
    // row must not wedge the owner's other receipt.
    expect({
      thrown: thrown === null ? null : String(thrown),
      healthyPresented: presented.includes(healthy!.receiptId),
      phantomHold: presented.length === 0 && status.hold,
      unansweredPresentations:
        presented.length === 0 ? status.unansweredPresentations : 0,
    }).toEqual({
      thrown: null,
      healthyPresented: true,
      phantomHold: false,
      unansweredPresentations: 0,
    });
  });
});

describe('A10 malformed and duplicate verdicts from the server', () => {
  it('an answer naming a receipt that was not presented settles nothing and leaves an honest HOLD', async () => {
    const { store, request } = await setup({ permits: 'offline' });
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored' || !outcome.record.result) return;
    service({
      permits: 'reserved',
      receipts: entries => ({
        receipts: [
          ...entries.map(entry => ({
            receiptId: (entry.receipt as Record<string, unknown>).receiptId,
            status: 'result_recorded',
          })),
          {
            receiptId: 'cccccccc-0000-4000-8000-000000000099',
            status: 'result_recorded',
          },
        ],
        rejected: [],
      }),
    });
    await expect(
      reconcileOfflineWallet(store.db, client(), reading()),
    ).rejects.toThrow();
    expect(await hasShotSyncReceipt(store.db, outcome.record.result.id)).toBe(
      false,
    );
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    const status = await readOfflineWalletStatus(store.db);
    expect(status.hold).toBe(true);
  });

  it('a duplicated verdict for the same receipt is applied at most once', async () => {
    const { store, request } = await setup({ permits: 'offline' });
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored' || !outcome.record.result) return;
    service({
      permits: 'reserved',
      receipts: entries => {
        const verdicts = entries.map(entry => ({
          receiptId: (entry.receipt as Record<string, unknown>).receiptId,
          status: 'result_recorded',
        }));
        return { receipts: [...verdicts, ...verdicts], rejected: [] };
      },
    });
    let drained: Awaited<ReturnType<typeof reconcileOfflineWallet>> | null =
      null;
    try {
      drained = await reconcileOfflineWallet(store.db, client(), reading());
    } catch {
      drained = null;
    }
    if (drained) expect(drained.accepted).toBeLessThanOrEqual(1);
    const syncRows = store.native
      .prepare(
        `SELECT count(*) AS n FROM sync_receipt WHERE owner_key = ? AND kind = 'shot.sync'`,
      )
      .get(OWNER);
    expect(Number(syncRows?.n ?? 0)).toBeLessThanOrEqual(1);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
  });
});

describe('A11 refused settlement must be surfaced honestly', () => {
  it('a refused receipt leaves durable, owner-readable evidence that the rating was not accepted', async () => {
    const { store, request } = await setup({ permits: 'offline' });
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored' || !outcome.record.result) return;
    const analysis = outcome.record.result;
    service({
      permits: 'reserved',
      receipts: entries => ({
        receipts: [],
        rejected: entries.map(entry => ({
          receiptId: (entry.receipt as Record<string, unknown>).receiptId,
          code: 'grant_signature_invalid',
          message: 'The grant signature did not verify.',
        })),
      }),
    });
    const drained = await reconcileOfflineWallet(store.db, client(), reading());
    expect(drained).toMatchObject({ submitted: 1, refused: 1, accepted: 0 });
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);

    // Everything the Result screen (hasShotSyncReceipt + getShotOutboxStatus),
    // the Library (getAnalysis) and the allocation card
    // (readOfflineWalletStatus) can read about this shot afterwards. Some
    // surface must tell the owner the server refused this rating; a refused
    // read shown as a real score whose delivery merely "could not be
    // verified" is not honest.
    const stored = await getAnalysis(store.db, analysis.id);
    const outbox = await getShotOutboxStatus(store.db, analysis.id);
    const wallet = await readOfflineWalletStatus(store.db);
    const refusalVisible =
      stored === null ||
      stored.resultKind !== 'scored' ||
      stored.source !== 'real' ||
      outbox.state !== 'absent' ||
      wallet.pending.some(entry => entry.operationId === OPERATION);
    expect({
      refusalVisible,
      stored: stored && {
        resultKind: stored.resultKind,
        source: stored.source,
      },
      outbox: outbox.state,
      walletPending: wallet.pending.length,
    }).toEqual(expect.objectContaining({ refusalVisible: true }));
  });
});

describe('A12 the plain-run journal after an offline rating', () => {
  it('a signal-restored recovery of the plain run neither reserves a live permit nor rewrites the paid operation', async () => {
    const { store, request } = await setup({ permits: 'offline' });
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).toBe('scored');
    const before = journalRows(store);
    const online = service({ permits: 'reserved' });
    const replay = await runCaptureAnalysis(request);
    expect(replay.kind).toBe('scored');
    expect(permitPosts(online.calls)).toHaveLength(0);
    expect(finalizePosts(online.calls)).toHaveLength(0);
    expect(journalRows(store)).toEqual(before);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
  });
});
