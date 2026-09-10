/**
 * W05-07 adversarial tests — the court-offline scored read at its failure
 * boundaries. Each test is a distinct attack against the candidate at
 * be905c7a; an attack that holds is a passing test, a break is a failing one.
 *
 * Attacks:
 *  A1 the real receipts route caps a batch at 25 entries (supabase/functions/
 *     api/index.ts OFFLINE_RECEIPT_BATCH_MAX) — a device that paid 26 reads on
 *     a Pro lease must still settle every receipt.
 *  A2 double submit: the same operation started twice concurrently offline.
 *  A3 the account switches while the offline commit is being written.
 *  A4 trusted-time boundaries at the court: clock rollback, unanchored
 *     authority, a lease issued ahead of the device clock, an expired lease.
 *  A5 429 + Retry-After is a server answer, not connectivity — at the permit
 *     reservation and at the receipt drain.
 *  A6 the account switches while the receipt presentation is in flight.
 *  A7 process death between the in_flight journal and the answer, then a
 *     restart against a server that had already settled.
 *  A8 captive-portal redirects and unreadable answers ARE connectivity.
 *  A9 the production route (supabase/functions/api/index.ts
 *     reconcileOfflineReceipts) answers `{ results: [{ receiptId, delivery,
 *     reconciliation, error }] }` — the drain must settle from the answer the
 *     shipping backend actually sends.
 * A10 the wire entry the device sends must satisfy the server's own evidence
 *     binding: receipt/grant shapes, output.id = resultId, the output digest
 *     and the grant transport digest. The entry is dumped for the Deno half
 *     (supabase/functions/api/__wf__/w05_07_attack_wire_contract.test.ts)
 *     when W05_ATTACK_WIRE_DUMP names a file.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
  OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
  OFFLINE_FREE_ALLOCATION_POLICY,
  OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION,
  OFFLINE_GRANT_AUDIENCE,
  OFFLINE_GRANT_JWS_TYPE,
  OFFLINE_PRO_LEASE_SCHEMA_VERSION,
  OFFLINE_RECONCILIATION_SCHEMA_VERSION,
  OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
  validateOfflineResultReceiptShape,
  validateOfflineSignedGrantShape,
} from '@pickle/shared-types';
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { CapturedClip } from '../src/camera/capture';
import {
  runCaptureAnalysis,
  type RunCaptureAnalysisOutcome,
  type RunCaptureAnalysisRequest,
} from '../src/analysis/runCaptureAnalysis';
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
  ApiError,
  createOfflineGrantClient,
  parseIssuedOfflineGrant,
  type IssuedOfflineGrant,
} from '../src/data/api';
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
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
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
const NOW_MS = Date.now();
const ISSUED_AT = Math.floor(NOW_MS / 1000) - 60;
const EXPIRES_AT = ISSUED_AT + 6 * 24 * 60 * 60;
const BINDING = { installationKeyId: INSTALLATION_KEY, issuer: API_ORIGIN };
/** The route's frozen limits (supabase/functions/api/index.ts). */
const SERVER_RECEIPT_BATCH_MAX = 25;
const SERVER_RECEIPT_BODY_BYTES = 2_000_000;
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

type GrantKind = 'free' | 'pro';

function grantCompactJws(kind: GrantKind): string {
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

function issuedGrant(kind: GrantKind): IssuedOfflineGrant {
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

function fixture(uri = 'file:///private/captures/court.mov') {
  const { sequence, window } = generateSwingSequence();
  const sidecar = serializePoseSequence(sequence);
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
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecar),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
  };
  return { clip, sidecar };
}

interface ResponseOptions {
  readonly headers?: Record<string, string>;
  readonly redirected?: boolean;
  readonly url?: string;
  readonly json?: () => Promise<unknown>;
}

function response(
  status: number,
  body: unknown,
  options: ResponseOptions = {},
): Response {
  const headers = new Map(
    Object.entries(options.headers ?? {}).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
  return {
    ok: status < 400,
    status,
    statusText: String(status),
    type: 'basic',
    redirected: options.redirected ?? false,
    url: options.url ?? '',
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    json: options.json ?? (async () => body),
  } as unknown as Response;
}

interface FetchCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

type Handler = (call: FetchCall, init?: RequestInit) => Promise<Response>;

/** A programmable court network: `permits` answers the reservation route,
 * `receipts` answers the drain. Every call is recorded. */
function network(handlers: { permits: Handler; receipts: Handler }): {
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchPort = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<
        string,
        unknown
      >;
      const call = { url, body };
      calls.push(call);
      if (isReleasePolicyRequest(url))
        return response(200, activeReleaseAuthority());
      if (url === PERMITS_ROUTE) return handlers.permits(call, init);
      if (url === RECEIPTS_ROUTE) return handlers.receipts(call, init);
      return response(404, { error: { code: 'not_found' } });
    },
  );
  globalThis.fetch = fetchPort as unknown as typeof fetch;
  return { calls };
}

const noSignal: Handler = async () => {
  throw new TypeError('Network request failed');
};

function receiptIds(call: FetchCall): string[] {
  const receipts = (call.body.receipts ?? []) as Array<Record<string, unknown>>;
  return receipts.map(entry =>
    String((entry.receipt as Record<string, unknown>).receiptId),
  );
}

function acceptAll(): Handler {
  return async call =>
    response(200, {
      receipts: receiptIds(call).map(receiptId => ({
        receiptId,
        status: 'result_recorded',
      })),
      rejected: [],
    });
}

/** The answer `reconcileOfflineReceipts` (supabase/functions/api/index.ts)
 * really returns for a settled batch — `json(200, { results })`, one
 * `{ receiptId, delivery, reconciliation, error }` per entry, pinned by
 * supabase/functions/api/__wf__/offline_receipt_reconciliation.test.ts. */
function productionRouteSettles(): Handler {
  return async call => {
    const receipts = (call.body.receipts ?? []) as Array<
      Record<string, unknown>
    >;
    return response(200, {
      results: receipts.map(entry => {
        const receipt = entry.receipt as Record<string, unknown>;
        return {
          receiptId: receipt.receiptId,
          delivery: 'settled',
          reconciliation: {
            schemaVersion: OFFLINE_RECONCILIATION_SCHEMA_VERSION,
            ownerId: receipt.ownerId,
            receiptId: receipt.receiptId,
            status: 'result_recorded',
            resultId: receipt.resultId,
            financialDisposition: 'consumed',
          },
          error: null,
        };
      }),
    });
  };
}

/** The receipts route exactly as `reconcileOfflineReceipts` bounds a batch:
 * 1–25 entries, ≤ 2,000,000 body bytes, otherwise a coded 400 and NOTHING
 * settled. Inside the bounds every receipt is recorded. */
function realRouteBounds(): { handler: Handler; settled: Set<string> } {
  const settled = new Set<string>();
  const handler: Handler = async (call, init) => {
    const ids = receiptIds(call);
    const bytes = Buffer.byteLength(String(init?.body ?? ''), 'utf8');
    if (bytes > SERVER_RECEIPT_BODY_BYTES)
      return response(413, {
        error: { code: 'request.too_large', message: 'Body too large.' },
      });
    if (ids.length === 0 || ids.length > SERVER_RECEIPT_BATCH_MAX)
      return response(400, {
        error: {
          code: 'offline.invalid_input',
          message: `receipts must be an array of 1-${SERVER_RECEIPT_BATCH_MAX} entries.`,
        },
      });
    for (const id of ids) settled.add(id);
    return response(200, {
      receipts: ids.map(receiptId => ({
        receiptId,
        status: 'result_recorded',
      })),
      rejected: [],
    });
  };
  return { handler, settled };
}

type Store = ReturnType<typeof createSqliteTestDb>;

async function setup(options: {
  grant: GrantKind | false;
  policy?: boolean;
  reading?: TrustedTimeReading;
  permits?: Handler;
  receipts?: Handler;
}) {
  const store = createSqliteTestDb();
  const { clip, sidecar } = fixture();
  mockReadArtifact = async () => sidecar;
  seedSqliteCapture(store.db, OWNER, CAPTURE, clip);
  mockReading = options.reading ?? reading();
  if (options.policy !== false) {
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
    await holdOfflineGrant(store.db, issuedGrant(options.grant), BINDING);
  const net = network({
    permits: options.permits ?? noSignal,
    receipts: options.receipts ?? acceptAll(),
  });
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
  return { store, request, net };
}

type Attempt = RunCaptureAnalysisOutcome | { kind: 'threw'; error: unknown };

async function attempt(request: RunCaptureAnalysisRequest): Promise<Attempt> {
  try {
    return await runCaptureAnalysis(request);
  } catch (error) {
    return { kind: 'threw', error };
  }
}

function walletClient() {
  return createOfflineGrantClient({ baseUrl: API_ORIGIN, token: BEARER });
}

async function tickets(store: Store, at = reading()) {
  const allocation = await readOfflineAllocation(store.db, at);
  return {
    spendable: allocation.spendableTickets,
    consumed: allocation.consumedTickets,
  };
}

function rowsFor(store: Store, table: string, owner: string): number {
  return store.count(table, owner);
}

function journalStates(store: Store, owner: string): string[] {
  return store.native
    .prepare(
      `SELECT state FROM offline_wallet_journal WHERE owner_key = ? ORDER BY opened_at`,
    )
    .all(owner)
    .map(row => String(row.state));
}

function settlements(store: Store, owner: string): Array<string | null> {
  return store.native
    .prepare(
      `SELECT settlement FROM offline_receipt WHERE owner_key = ? ORDER BY queued_at, receipt_id`,
    )
    .all(owner)
    .map(row => (row.settlement === null ? null : String(row.settlement)));
}

async function scoredOffline(request: RunCaptureAnalysisRequest) {
  const outcome = await runCaptureAnalysis(request);
  expect(outcome.kind).toBe('scored');
  if (outcome.kind !== 'scored' || !outcome.record.result)
    throw new Error('precondition: the court-offline read must score');
  return outcome.record.result;
}

beforeEach(() => {
  signIn();
});
afterEach(() => {
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  globalThis.fetch = originalFetch;
  mockReading = null;
  jest.restoreAllMocks();
  closeSqliteTestDatabases();
});

describe('A1 — the receipts route caps a batch at 25 entries', () => {
  it('a Pro lease that paid 26 reads offline settles every receipt across bounded batches; the wallet is never left on a permanent HOLD', async () => {
    const route = realRouteBounds();
    const { store, request } = await setup({
      grant: 'pro',
      receipts: route.handler,
    });
    for (let index = 0; index < SERVER_RECEIPT_BATCH_MAX; index += 1) {
      const suffix = String(index).padStart(12, '0');
      await consumeOfflineAllocation(
        store.db,
        {
          operationId: `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`,
          resultId: `bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`,
          fullOutputSha256: 'c'.repeat(64),
        },
        reading(NOW_MS - (100 - index) * 1000),
      );
    }
    const analysis = await scoredOffline(request);
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(
      SERVER_RECEIPT_BATCH_MAX + 1,
    );

    // The drain against the real route bounds. A device that presents more
    // than the route accepts must still deliver every receipt — chunked, or
    // across successive drains — never fail the whole wallet forever.
    const outcomes: Array<'drained' | ApiError | unknown> = [];
    for (let pass = 0; pass < 4; pass += 1) {
      try {
        await reconcileOfflineWallet(store.db, walletClient(), reading());
        outcomes.push('drained');
      } catch (error) {
        outcomes.push(error);
      }
      if ((await pendingOfflineReceipts(store.db)).length === 0) break;
    }
    const remaining = await pendingOfflineReceipts(store.db);
    const status = await readOfflineWalletStatus(store.db);
    expect({
      remaining: remaining.length,
      settledByServer: route.settled.size,
      hold: status.hold,
      unansweredPresentations: status.unansweredPresentations,
      failures: outcomes
        .filter((outcome): outcome is unknown => outcome !== 'drained')
        .map(error =>
          error instanceof ApiError
            ? { status: error.status, code: error.code }
            : String(error),
        ),
    }).toEqual({
      remaining: 0,
      settledByServer: SERVER_RECEIPT_BATCH_MAX + 1,
      hold: false,
      unansweredPresentations: 0,
      failures: [],
    });
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(true);
  });
});

describe('A2 — double submit of the same offline operation', () => {
  it('two concurrent runs of one operation spend exactly one ticket, persist one shot and neither throws at the capture screen', async () => {
    const { store, request } = await setup({ grant: 'free' });
    const [first, second] = await Promise.all([
      attempt(request),
      attempt(request),
    ]);
    const kinds = [first.kind, second.kind];
    expect(kinds).not.toContain('threw');
    const scored = [first, second].filter(
      (
        outcome,
      ): outcome is Extract<RunCaptureAnalysisOutcome, { kind: 'scored' }> =>
        outcome.kind === 'scored',
    );
    expect(scored.length).toBeGreaterThanOrEqual(1);
    const ids = new Set(scored.map(outcome => outcome.analysisId));
    expect(ids.size).toBe(1);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(rowsFor(store, 'local_shot', OWNER)).toBe(1);

    // The replay after the race is the same paid rating, not a second spend.
    const replay = await runCaptureAnalysis(request);
    expect(replay.kind).toBe('scored');
    if (replay.kind === 'scored') expect(ids.has(replay.analysisId)).toBe(true);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
  });
});

describe('A3 — the account switches while the offline commit is written', () => {
  it('nothing is spent for either owner, no shot or receipt lands under either key, and the caller is told the account changed', async () => {
    const { store, request } = await setup({ grant: 'free' });
    let switched = false;
    store.observeStatements(call => {
      if (!switched && call.sql.includes('INSERT INTO local_analysis_record')) {
        switched = true;
        setActiveDataOwner(OTHER_OWNER);
      }
    });
    const outcome = await attempt(request);
    store.observeStatements(null);
    expect(switched).toBe(true);
    expect(outcome).toMatchObject({
      kind: 'unavailable',
      cause: 'account_changed',
    });
    for (const owner of [OWNER, OTHER_OWNER]) {
      expect({
        owner,
        shots: rowsFor(store, 'local_shot', owner),
        receipts: rowsFor(store, 'offline_receipt', owner),
        consumed: store.native
          .prepare(
            `SELECT count(*) AS n FROM offline_ticket WHERE owner_key = ? AND state <> 'remaining'`,
          )
          .get(owner)?.n,
      }).toEqual({ owner, shots: 0, receipts: 0, consumed: 0 });
    }
    setActiveDataOwner(OWNER);
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
  });
});

describe('A4 — trusted-time boundaries at the court', () => {
  it.each<[string, TrustedTimeReading]>([
    ['clock rollback detected', { ...reading(), rollbackDetected: true }],
    [
      'unanchored authority (floor only)',
      { ...reading(), authority: 'floor', continuity: 'measured' },
    ],
    ['no trusted time at all', { ...reading(), authority: 'none' }],
    [
      'device clock behind the lease issuance (far past)',
      reading(ISSUED_AT * 1000 - 24 * 60 * 60 * 1000),
    ],
    [
      'device clock past the lease expiry (far future)',
      reading(EXPIRES_AT * 1000 + 1),
    ],
  ])(
    '%s → honest no-score, nothing spent, no receipt, no shot',
    async (_label, at) => {
      const { store, request } = await setup({ grant: 'free', reading: at });
      const outcome = await attempt(request);
      expect(outcome.kind).toBe('unavailable');
      expect(rowsFor(store, 'local_shot', OWNER)).toBe(0);
      expect(rowsFor(store, 'offline_receipt', OWNER)).toBe(0);
      expect(
        store.native
          .prepare(
            `SELECT count(*) AS n FROM offline_ticket WHERE owner_key = ? AND state <> 'remaining'`,
          )
          .get(OWNER)?.n,
      ).toBe(0);
    },
  );
});

describe('A5 — 429 + Retry-After is a server answer, never connectivity', () => {
  const rateLimited: Handler = async () =>
    response(
      429,
      {
        error: {
          code: 'rate_limited',
          message: 'Too many requests. Try again shortly.',
        },
      },
      { headers: { 'Retry-After': '30' } },
    );

  it('at the permit reservation: no offline score, nothing spent, no receipt', async () => {
    const { store, request } = await setup({
      grant: 'free',
      permits: rateLimited,
    });
    const outcome = await attempt(request);
    expect(outcome.kind).toBe('unavailable');
    expect(rowsFor(store, 'local_shot', OWNER)).toBe(0);
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
  });

  it('at the receipt drain: nothing settles, the receipt stays pending, and the next drain settles it exactly once', async () => {
    let answers = 0;
    const accept = acceptAll();
    const { store, request } = await setup({
      grant: 'free',
      receipts: async (call, init) => {
        answers += 1;
        return answers === 1 ? rateLimited(call, init) : accept(call, init);
      },
    });
    const analysis = await scoredOffline(request);
    const first = await reconcileOfflineWallet(
      store.db,
      walletClient(),
      reading(),
    ).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(ApiError);
    expect((first as ApiError).status).toBe(429);
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);
    expect(settlements(store, OWNER)).toEqual([null]);

    const second = await reconcileOfflineWallet(
      store.db,
      walletClient(),
      reading(),
    );
    expect(second).toMatchObject({ submitted: 1, accepted: 1, pending: 0 });
    expect(answers).toBe(2);
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(true);
    expect(settlements(store, OWNER)).toEqual(['accepted']);
    expect(journalStates(store, OWNER).filter(s => s === 'in_flight')).toEqual(
      [],
    );
  });
});

describe('A6 — the account switches while the presentation is in flight', () => {
  it('no settlement lands under the other account, the original owner loses nothing, and the next drain by the owner settles exactly once', async () => {
    const accept = acceptAll();
    let presentations = 0;
    const { store, request } = await setup({
      grant: 'free',
      receipts: async (call, init) => {
        presentations += 1;
        if (presentations === 1) setActiveDataOwner(OTHER_OWNER);
        return accept(call, init);
      },
    });
    const analysis = await scoredOffline(request);
    const interleaved = await reconcileOfflineWallet(
      store.db,
      walletClient(),
      reading(),
    ).catch((error: unknown) => error);
    expect(rowsFor(store, 'offline_receipt', OTHER_OWNER)).toBe(0);
    expect(rowsFor(store, 'sync_receipt', OTHER_OWNER)).toBe(0);
    expect(rowsFor(store, 'offline_wallet_journal', OTHER_OWNER)).toBe(0);
    // Either the verdict settled the owner's receipt (it was the owner's
    // presentation, answered for the owner's bearer) or it was deferred —
    // never lost and never applied twice.
    expect([null, 'accepted']).toContain(settlements(store, OWNER)[0]);
    expect(rowsFor(store, 'sync_receipt', OWNER)).toBeLessThanOrEqual(1);
    if (interleaved instanceof Error)
      expect(interleaved.name).not.toBe('TypeError');

    signIn(OWNER);
    await reconcileOfflineWallet(store.db, walletClient(), reading());
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
    expect(settlements(store, OWNER)).toEqual(['accepted']);
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(true);
    expect(rowsFor(store, 'sync_receipt', OWNER)).toBe(1);
    expect(journalStates(store, OWNER).filter(s => s === 'in_flight')).toEqual(
      [],
    );
    expect(presentations).toBeLessThanOrEqual(2);
  });
});

describe('A7 — process death between the in_flight journal and the answer', () => {
  it('the relaunch re-presents the same receipt; a server that already settled it replays the verdict and the shot is marked synced exactly once', async () => {
    const accept = acceptAll();
    let presentations = 0;
    const { store, request } = await setup({
      grant: 'free',
      receipts: async (call, init) => {
        presentations += 1;
        // The request left the device and the server recorded it, but the
        // process died before the answer was read.
        if (presentations === 1) throw new TypeError('Network request failed');
        return accept(call, init);
      },
    });
    const analysis = await scoredOffline(request);
    const died = await reconcileOfflineWallet(
      store.db,
      walletClient(),
      reading(),
    ).catch((error: unknown) => error);
    expect(died).toBeInstanceOf(TypeError);
    const heldStatus = await readOfflineWalletStatus(store.db);
    expect(heldStatus).toMatchObject({
      hold: true,
      unansweredPresentations: 1,
    });
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);

    // Relaunch: same database, fresh runtime, signal restored.
    const relaunched = await reconcileOfflineWallet(
      store.db,
      walletClient(),
      reading(),
    );
    expect(relaunched).toMatchObject({
      submitted: 1,
      accepted: 1,
      recovered: 1,
      pending: 0,
    });
    expect(await readOfflineWalletStatus(store.db)).toMatchObject({
      hold: false,
      unansweredPresentations: 0,
    });
    expect(settlements(store, OWNER)).toEqual(['accepted']);
    expect(rowsFor(store, 'sync_receipt', OWNER)).toBe(1);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(presentations).toBe(2);
  });
});

describe('A9 — the answer the production route really sends', () => {
  it('a settled batch answered as { results: [{ delivery: "settled", reconciliation: { status: "result_recorded" } }] } marks the shot synced and settles the receipt', async () => {
    const { store, request } = await setup({
      grant: 'free',
      receipts: productionRouteSettles(),
    });
    const analysis = await scoredOffline(request);
    const drained = await reconcileOfflineWallet(
      store.db,
      walletClient(),
      reading(),
    ).catch((error: unknown) => error);
    const status = await readOfflineWalletStatus(store.db);
    expect({
      drained:
        drained instanceof ApiError
          ? { status: drained.status, code: drained.code }
          : drained,
      pending: (await pendingOfflineReceipts(store.db)).length,
      hold: status.hold,
      synced: await hasShotSyncReceipt(store.db, analysis.id),
      settlements: settlements(store, OWNER),
    }).toEqual({
      drained: expect.objectContaining({
        submitted: 1,
        accepted: 1,
        pending: 0,
      }),
      pending: 0,
      hold: false,
      synced: true,
      settlements: ['accepted'],
    });
  });
});

describe("A10 — the wire entry satisfies the server's evidence binding", () => {
  it("receipt and grant validate as the frozen shapes, output.id names the receipt's result, the canonical output digest matches, and the persisted receipt is sent verbatim", async () => {
    const { store, request, net } = await setup({ grant: 'free' });
    const analysis = await scoredOffline(request);
    const [persisted] = await pendingOfflineReceipts(store.db);
    expect(persisted).toBeDefined();
    await reconcileOfflineWallet(store.db, walletClient(), reading());
    const presented = net.calls.filter(call => call.url === RECEIPTS_ROUTE);
    expect(presented).toHaveLength(1);
    const entries = presented[0]!.body.receipts as Array<
      Record<string, unknown>
    >;
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    const dump = process.env.W05_ATTACK_WIRE_DUMP;
    if (dump) {
      mkdirSync(dirname(dump), { recursive: true });
      writeFileSync(dump, JSON.stringify(entry, null, 2));
    }
    expect(Object.keys(entry)).toEqual(
      expect.arrayContaining(['receipt', 'grant', 'output']),
    );
    const receipt = validateOfflineResultReceiptShape(entry.receipt);
    expect(
      receipt.ok
        ? null
        : {
            rejected: receipt,
            sentFields: Object.keys(entry.receipt as object),
          },
    ).toBeNull();
    if (!receipt.ok) return;
    const grant = validateOfflineSignedGrantShape(entry.grant);
    expect(grant.ok ? null : grant).toBeNull();
    if (!grant.ok) return;
    expect(grant.value.compactJws).toBe(grantCompactJws('free'));
    expect(receipt.value.grantJwsSha256).toBe(
      sha256Hex(grant.value.compactJws),
    );
    expect(receipt.value.ownerId).toBe(OWNER);
    expect(receipt.value.operationId).toBe(OPERATION);
    expect(receipt.value.resultId).toBe(analysis.id);
    const output = entry.output as Record<string, unknown>;
    expect(output.id).toBe(analysis.id);
    expect(output).not.toHaveProperty('analysisPermitId');
    expect(sha256Hex(originalCanonicalJson(output))).toBe(
      receipt.value.fullOutputSha256,
    );
    const {
      settlement: _settlement,
      settledAt: _settledAt,
      ...persistedBody
    } = persisted!;
    expect(entry.receipt).toEqual(persistedBody);
  });
});

describe('A8 — intermediary answers at the reservation are connectivity', () => {
  it.each<[string, Handler]>([
    [
      'captive portal 302 redirect',
      async () =>
        response(302, null, { headers: { location: 'http://portal' } }),
    ],
    [
      'captive portal 200 HTML (unreadable body)',
      async () =>
        response(200, null, {
          json: async () => {
            throw new SyntaxError('Unexpected token <');
          },
        }),
    ],
    [
      'gateway 504 without a coded envelope',
      async () => response(504, null, { json: async () => undefined }),
    ],
  ])(
    '%s → the court-offline read scores once, one ticket, one receipt',
    async (_label, permits) => {
      const { store, request, net } = await setup({ grant: 'free', permits });
      const analysis = await scoredOffline(request);
      expect(net.calls.filter(call => call.url === PERMITS_ROUTE)).toHaveLength(
        1,
      );
      expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
      const receipts = await pendingOfflineReceipts(store.db);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        operationId: OPERATION,
        resultId: analysis.id,
      });
      expect(rowsFor(store, 'local_shot', OWNER)).toBe(1);
    },
  );
});
