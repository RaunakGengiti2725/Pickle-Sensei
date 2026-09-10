/**
 * W05-07 adversarial suite, round 3 (candidate 389bfbf7) — boundaries the
 * first three rounds (attack, attack2, Adversary) left open.
 * Every test names the invariant it expects the candidate to hold; a failing
 * test is a confirmed break of that invariant, not a style opinion.
 *
 * Categories: the lease ending between the authority read and the commit
 * (stale trusted-time reading at the spend), the exact lease-expiry boundary,
 * a corrupt GRANT row in front of a healthy receipt paid under another
 * grant, the free-limit signal when a second active grant still holds a
 * ticket, a newer grant generation restating the tickets mid-run, a local
 * write failure between the server's `result_recorded` and the local apply,
 * an account switch between the server's answer and the local apply, and
 * free-rating conservation when a Pro lease and a free grant are both held.
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
  runCaptureAnalysis,
  type RunCaptureAnalysisOutcome,
  type RunCaptureAnalysisRequest,
} from '../src/analysis/runCaptureAnalysis';
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
import {
  holdOfflineGrant,
  pendingOfflineReceipts,
  readOfflineAllocation,
  type OfflineConsumptionReceipt,
} from '../src/data/offlineCapabilities';
import {
  readOfflineReceiptEvidence,
  reconcileOfflineWallet,
} from '../src/data/offlineWallet';
import { getDb } from '../src/data/db';
import { hasShotSyncReceipt } from '../src/data/repository';
import { clearSyncRuntime } from '../src/data/syncRuntime';
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
const CAPTURE_B = '33333333-3333-4333-8333-333333333334';
const OPERATION = '44444444-4444-4444-8444-444444444444';
const OPERATION_B = '44444444-4444-4444-8444-444444444445';
const API_ORIGIN = 'https://api.example.test/functions/v1/api';
const BEARER = 'fresh-owner-token';
const INSTALLATION_KEY = 'ios-install-key-1';
const KEY_ID = 'offline-grant-key-1';
const GRANT_A = 'bbbbbbbb-0000-4000-8000-000000000001';
const GRANT_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const PRO_GRANT = 'bbbbbbbb-0000-4000-8000-000000000003';
const ALLOCATION_A = 'dddddddd-0000-4000-8000-000000000001';
const ALLOCATION_B = 'dddddddd-0000-4000-8000-000000000002';
const TICKET_1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const TICKET_2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const ARTIFACT = { version: 'v1', sha256: 'a'.repeat(64) };
const PERMITS_ROUTE = `${API_ORIGIN}/v1/analysis-permits`;
const RECEIPTS_ROUTE = `${API_ORIGIN}/v1/offline/receipts`;
const NOW_MS = Date.now();
const ISSUED_AT = Math.floor(NOW_MS / 1000) - 60;
const EXPIRES_AT = ISSUED_AT + 6 * 24 * 60 * 60;
const SHORT_EXPIRES_AT = ISSUED_AT + 60 * 60;
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

interface GrantSpec {
  readonly grantId: string;
  readonly generation: number;
  readonly allocationId: string;
  readonly ticketIds: readonly string[];
  readonly expiresAt?: number;
}

function grantCompactJws(sub: string, spec: GrantSpec): string {
  const claims = {
    schemaVersion: OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
    protocolVersion: OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
    iss: API_ORIGIN,
    aud: OFFLINE_GRANT_AUDIENCE,
    sub,
    jti: spec.grantId,
    installationKeyId: INSTALLATION_KEY,
    iat: ISSUED_AT,
    exp: spec.expiresAt ?? EXPIRES_AT,
    capabilities: ['analyze_joint_output'],
    release: {
      policy: ARTIFACT,
      mechanicsModel: ARTIFACT,
      benchmarkModel: ARTIFACT,
    },
    entitlementSource: 'identity_lifetime_free',
    allocation: {
      schemaVersion: OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION,
      allocationId: spec.allocationId,
      generation: spec.generation,
      ticketIds: spec.ticketIds,
      budgetPolicy: OFFLINE_FREE_ALLOCATION_POLICY.id,
      financialExpiry: 'reconciliation_only',
    },
  };
  const header = { alg: 'ES256', typ: OFFLINE_GRANT_JWS_TYPE, kid: KEY_ID };
  return `${base64Url(JSON.stringify(header))}.${base64Url(
    JSON.stringify(claims),
  )}.${'A'.repeat(86)}`;
}

/** A Pro (verified_store) lease: no tickets, bounded by the verified
 * entitlement expiry the server restates in the clear. */
function proLeaseCompactJws(sub: string, entitlementExpiresAt: number) {
  const claims = {
    schemaVersion: OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
    protocolVersion: OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
    iss: API_ORIGIN,
    aud: OFFLINE_GRANT_AUDIENCE,
    sub,
    jti: PRO_GRANT,
    installationKeyId: INSTALLATION_KEY,
    iat: ISSUED_AT,
    exp: EXPIRES_AT,
    capabilities: ['analyze_joint_output'],
    release: {
      policy: ARTIFACT,
      mechanicsModel: ARTIFACT,
      benchmarkModel: ARTIFACT,
    },
    entitlementSource: 'verified_store',
    lease: {
      schemaVersion: OFFLINE_PRO_LEASE_SCHEMA_VERSION,
      kind: 'subscription',
      verifiedEntitlementExpiresAt: entitlementExpiresAt,
    },
  };
  const header = { alg: 'ES256', typ: OFFLINE_GRANT_JWS_TYPE, kid: KEY_ID };
  return `${base64Url(JSON.stringify(header))}.${base64Url(
    JSON.stringify(claims),
  )}.${'A'.repeat(86)}`;
}

function issuedProLease(sub = OWNER): IssuedOfflineGrant {
  const entitlementExpiresAt = ISSUED_AT + 30 * 24 * 60 * 60;
  const parsed = parseIssuedOfflineGrant({
    grantId: PRO_GRANT,
    generation: 1,
    entitlementSource: 'verified_store',
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    entitlementExpiresAt,
    ticketIds: [],
    keyId: KEY_ID,
    grant: {
      schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
      compactJws: proLeaseCompactJws(sub, entitlementExpiresAt),
    },
  });
  if (!parsed) throw new Error('fixture Pro lease must parse');
  return parsed;
}

function issuedGrant(spec: GrantSpec, sub = OWNER): IssuedOfflineGrant {
  const parsed = parseIssuedOfflineGrant({
    grantId: spec.grantId,
    generation: spec.generation,
    entitlementSource: 'identity_lifetime_free',
    issuedAt: ISSUED_AT,
    expiresAt: spec.expiresAt ?? EXPIRES_AT,
    entitlementExpiresAt: null,
    ticketIds: spec.ticketIds,
    keyId: KEY_ID,
    grant: {
      schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
      compactJws: grantCompactJws(sub, spec),
    },
  });
  if (!parsed) throw new Error('fixture grant response must parse');
  return parsed;
}

const GRANT_A_TWO_TICKETS: GrantSpec = {
  grantId: GRANT_A,
  generation: 1,
  allocationId: ALLOCATION_A,
  ticketIds: [TICKET_1, TICKET_2],
};
const GRANT_A_ONE_TICKET: GrantSpec = {
  ...GRANT_A_TWO_TICKETS,
  ticketIds: [TICKET_1],
};
const GRANT_B_OWN_TICKET: GrantSpec = {
  grantId: GRANT_B,
  generation: 2,
  allocationId: ALLOCATION_B,
  ticketIds: [TICKET_2],
};

function signIn(owner = OWNER) {
  setActiveDataOwner(owner);
  establishApiSession({
    canonicalAppUserId: owner,
    apiBaseUrl: API_ORIGIN,
    bearerToken: BEARER,
    provider: 'apple',
  });
}

function fixture(uri: string) {
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
      uri: `${uri}.pose.json`,
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
    redirected: false,
    type: 'basic',
    url: '',
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

type ReceiptsAnswer = (
  call: FetchCall,
) => Response | Promise<Response> | 'offline';

/** A scripted court network: the permit reservation never leaves the
 * device, `receipts` decides the drain, everything else answers 404. */
function network(options: { receipts?: ReceiptsAnswer } = {}) {
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
      if (isReleasePolicyRequest(url)) return offline();
      if (url === PERMITS_ROUTE) return offline();
      if (url === RECEIPTS_ROUTE) {
        const answer = options.receipts
          ? await options.receipts(call)
          : 'offline';
        return answer === 'offline' ? offline() : answer;
      }
      return response(404, { error: { code: 'not_found' } });
    },
  );
  globalThis.fetch = fetchPort as unknown as typeof fetch;
  return { calls, fetchPort };
}

function presentedIds(call: FetchCall): string[] {
  const receipts = (call.body.receipts ?? []) as Array<Record<string, unknown>>;
  return receipts.map(entry =>
    String((entry.receipt as Record<string, unknown>).receiptId),
  );
}

function acceptAll() {
  return (call: FetchCall) =>
    response(200, {
      receipts: presentedIds(call).map(receiptId => ({
        receiptId,
        status: 'result_recorded',
      })),
      rejected: [],
    });
}

function receiptPosts(calls: readonly FetchCall[]): FetchCall[] {
  return calls.filter(call => call.url === RECEIPTS_ROUTE);
}

type Store = ReturnType<typeof createSqliteTestDb>;

function request(
  store: Store,
  clip: CapturedClip,
  operationId = OPERATION,
  captureId = CAPTURE,
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

/** OWNER holds a cached policy and the given grants; two captures (A, B)
 * with distinct pose sidecars are on the device. */
async function seed(grants: readonly GrantSpec[]) {
  const store = createSqliteTestDb();
  const a = fixture('file:///private/captures/court-a.mov');
  const b = fixture('file:///private/captures/court-b.mov');
  const sidecars = new Map([
    [a.clip.poseSequence?.uri, a.sidecar],
    [b.clip.poseSequence?.uri, b.sidecar],
  ]);
  mockReadArtifact = async uri => {
    const sidecar = sidecars.get(uri);
    if (sidecar === undefined) throw new Error(`no sidecar for ${uri}`);
    return sidecar;
  };
  seedSqliteCapture(store.db, OWNER, CAPTURE, a.clip);
  seedSqliteCapture(store.db, OWNER, CAPTURE_B, b.clip);
  mockReading = reading();
  await cachePolicy(store);
  for (const spec of grants) {
    await holdOfflineGrant(store.db, issuedGrant(spec), BINDING);
  }
  return {
    store,
    requestA: request(store, a.clip),
    requestB: request(store, b.clip, OPERATION_B, CAPTURE_B),
  };
}

async function tickets(store: Store, at: TrustedTimeReading) {
  const allocation = await readOfflineAllocation(store.db, at);
  return {
    spendable: allocation.spendableTickets,
    consumed: allocation.consumedTickets,
  };
}

function offlineClient() {
  return createOfflineGrantClient({ baseUrl: API_ORIGIN, token: BEARER });
}

async function scoredOffline(store: Store, req: RunCaptureAnalysisRequest) {
  network();
  const outcome = await runCaptureAnalysis(req);
  expect(outcome.kind).toBe('scored');
  if (outcome.kind !== 'scored' || !outcome.record.result) {
    throw new Error('precondition: the court-offline read must score');
  }
  const receipts = await pendingOfflineReceipts(store.db);
  const receipt = receipts.find(
    entry => entry.resultId === outcome.record.result?.id,
  );
  if (!receipt) throw new Error('precondition: the read queued a receipt');
  return { analysis: outcome.record.result, receipt, outcome };
}

function receiptRows(store: Store, owner = OWNER) {
  return store.native
    .prepare(
      `SELECT receipt_id, grant_id, settlement, settled_at, receipt
       FROM offline_receipt WHERE owner_key = ? ORDER BY lifecycle_sequence`,
    )
    .all(owner) as Array<{
    receipt_id: string;
    grant_id: string;
    settlement: string | null;
    settled_at: string | null;
    receipt: string;
  }>;
}

function journalStates(store: Store, owner = OWNER): string[] {
  return (
    store.native
      .prepare(
        `SELECT state FROM offline_wallet_journal WHERE owner_key = ? ORDER BY rowid`,
      )
      .all(owner) as Array<{ state: string }>
  ).map(row => row.state);
}

function scoredShots(store: Store, owner = OWNER): number {
  return Number(
    store.native
      .prepare(
        `SELECT count(*) AS n FROM local_shot WHERE owner_key = ? AND result_kind = 'scored'`,
      )
      .get(owner)?.n,
  );
}

function ticketFor(receipt: OfflineConsumptionReceipt) {
  if (receipt.ticket === null) throw new Error('a free receipt names a ticket');
  return receipt.ticket;
}

beforeEach(() => {
  signIn();
});
afterEach(() => {
  clearSyncRuntime();
  clearApiSession();
  (getDb as jest.Mock).mockReset();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  globalThis.fetch = originalFetch;
  mockReading = null;
  jest.restoreAllMocks();
  jest.useRealTimers();
  closeSqliteTestDatabases();
});

describe('C1 clock: the lease ends between the authority read and the commit', () => {
  it('a grant that trusted time says has expired by the time the rating commits is never spent', async () => {
    const shortLease: GrantSpec = {
      ...GRANT_A_TWO_TICKETS,
      expiresAt: SHORT_EXPIRES_AT,
    };
    const { store, requestA } = await seed([shortLease]);
    network();
    // The authority read ends with the pending-receipt count. The moment it
    // completes, trusted time moves past the lease end (a long inference on
    // a slow phone, or the phone sleeping mid-run), BEFORE the commit
    // transaction opens.
    const afterLease = reading((SHORT_EXPIRES_AT + 60 * 60) * 1000);
    let advanced = false;
    store.observeStatements(call => {
      if (
        !advanced &&
        call.sql.includes('COUNT(*) AS pending FROM offline_receipt')
      ) {
        advanced = true;
        mockReading = afterLease;
      }
    });

    let outcome: RunCaptureAnalysisOutcome | null = null;
    let failure: unknown = null;
    try {
      outcome = await runCaptureAnalysis(requestA);
    } catch (error) {
      failure = error;
    }
    store.observeStatements(null);
    expect(advanced).toBe(true);
    expect(failure).toBeNull();

    // Under the clock that was current at the spend, the grant is expired.
    const wallet = await readOfflineAllocation(store.db, afterLease);
    expect(wallet.grants.map(grant => grant.execution.kind)).toEqual([
      'expired',
    ]);
    // Invariant: an expired lease authorises nothing — no numeric score, no
    // ticket spent, no receipt queued under a lease that had already ended.
    const rows = receiptRows(store);
    expect({
      outcome: outcome?.kind,
      ...(await tickets(store, afterLease)),
      receipts: rows.length,
      queuedAt: rows.map(
        row => (JSON.parse(row.receipt) as { queuedAt: string }).queuedAt,
      ),
      scoredShots: scoredShots(store),
    }).toEqual({
      outcome: 'unavailable',
      spendable: 2,
      consumed: 0,
      receipts: 0,
      queuedAt: [],
      scoredShots: 0,
    });
  });
});

describe('C2 clock: the exact lease-expiry second', () => {
  it('at exp the lease is over (no score, nothing spent); one second before, the court still scores once', async () => {
    const { store, requestA, requestB } = await seed([GRANT_A_TWO_TICKETS]);
    network();
    mockReading = reading(EXPIRES_AT * 1000);
    const atExpiry = await runCaptureAnalysis(requestA);
    expect(atExpiry.kind).toBe('unavailable');
    expect(await tickets(store, reading(EXPIRES_AT * 1000))).toEqual({
      spendable: 2,
      consumed: 0,
    });
    expect(receiptRows(store)).toEqual([]);

    mockReading = reading(EXPIRES_AT * 1000 - 1000);
    const beforeExpiry = await runCaptureAnalysis(requestB);
    expect(beforeExpiry.kind).toBe('scored');
    expect(await tickets(store, reading(EXPIRES_AT * 1000 - 1000))).toEqual({
      spendable: 1,
      consumed: 1,
    });
    const rows = receiptRows(store);
    expect(rows).toHaveLength(1);
    expect(
      (JSON.parse(rows[0]!.receipt) as { queuedAt: string }).queuedAt,
    ).toBe(new Date(EXPIRES_AT * 1000 - 1000).toISOString());
  });
});

describe('C3 corrupt persisted state: a corrupt GRANT row in front of a healthy receipt', () => {
  async function twoReceiptsUnderTwoGrants() {
    const { store, requestA, requestB } = await seed([
      GRANT_A_ONE_TICKET,
      GRANT_B_OWN_TICKET,
    ]);
    const first = await scoredOffline(store, requestA);
    const second = await scoredOffline(store, requestB);
    expect(first.receipt.grantId).not.toBe(second.receipt.grantId);
    // The grant that paid for the FIRST receipt loses its stored bytes: the
    // compact JWS no longer matches its digest (a damaged row, not a
    // missing one).
    store.native
      .prepare(
        `UPDATE offline_grant SET compact_jws = compact_jws || 'x'
         WHERE owner_key = ? AND grant_id = ?`,
      )
      .run(OWNER, first.receipt.grantId);
    return { store, first, second };
  }

  it('the healthy receipt under the intact grant still settles; the damaged one is held, never presented, never dropped', async () => {
    const { store, first, second } = await twoReceiptsUnderTwoGrants();
    const { calls } = network({ receipts: acceptAll() });

    let outcome: Awaited<ReturnType<typeof reconcileOfflineWallet>> | null =
      null;
    let failure: unknown = null;
    try {
      outcome = await reconcileOfflineWallet(
        store.db,
        offlineClient(),
        reading(),
      );
    } catch (error) {
      failure = error;
    }

    // Whatever was reported, the damaged receipt is on file and unsettled,
    // and it was never sent under bytes the device cannot vouch for.
    const posts = receiptPosts(calls);
    for (const post of posts) {
      expect(presentedIds(post)).not.toContain(first.receipt.receiptId);
    }
    const rows = receiptRows(store);
    expect(rows.map(row => row.receipt_id).sort()).toEqual(
      [first.receipt.receiptId, second.receipt.receiptId].sort(),
    );
    expect(
      rows.find(row => row.receipt_id === first.receipt.receiptId)?.settled_at,
    ).toBeNull();
    // Nothing is fabricated on the damaged side.
    expect(await hasShotSyncReceipt(store.db, first.analysis.id)).toBe(false);

    // Invariant under attack: one damaged grant row must not hold the
    // owner's OTHER paid rating hostage (the r7 rule for a damaged receipt
    // row, applied to the grant the receipt points at).
    expect({
      failure: failure instanceof Error ? failure.message : failure,
      accepted: outcome?.accepted ?? null,
      presented: posts.map(presentedIds),
      healthySettlement: rows.find(
        row => row.receipt_id === second.receipt.receiptId,
      )?.settlement,
      healthyDelivered: await hasShotSyncReceipt(store.db, second.analysis.id),
    }).toEqual({
      failure: null,
      accepted: 1,
      presented: [[second.receipt.receiptId]],
      healthySettlement: 'accepted',
      healthyDelivered: true,
    });
  });

  it('the damaged grant never becomes a fabricated empty wallet: the healthy grant, the consumed tickets and both receipts stay visible or the read fails honestly', async () => {
    const { store, first, second } = await twoReceiptsUnderTwoGrants();
    let snapshot: Awaited<ReturnType<typeof readOfflineAllocation>> | null =
      null;
    let failure: unknown = null;
    try {
      snapshot = await readOfflineAllocation(store.db, reading());
    } catch (error) {
      failure = error;
    }
    if (snapshot !== null) {
      // If the wallet reads, it must not have lost what it still knows.
      expect(snapshot.grants.map(grant => grant.grantId)).toContain(
        second.receipt.grantId,
      );
      expect(snapshot.consumedTickets).toBe(2);
      expect(snapshot.pendingReceipts).toBe(2);
    } else {
      expect(failure).toBeInstanceOf(Error);
    }
    // The paid ratings are still on the phone and still name their receipts.
    expect(scoredShots(store)).toBe(2);
    expect(
      receiptRows(store)
        .map(row => row.receipt_id)
        .sort(),
    ).toEqual([first.receipt.receiptId, second.receipt.receiptId].sort());
  });
});

describe('C4 free-rating signal with two active grants', () => {
  it('freeLimitReached is true only when no ticket remains spendable on the device', async () => {
    const { store, requestA, requestB } = await seed([
      GRANT_A_ONE_TICKET,
      GRANT_B_OWN_TICKET,
    ]);
    const first = await scoredOffline(store, requestA);
    const afterFirst = await tickets(store, reading());
    // A ticket is still spendable, so the paywall prompt the flag drives
    // must not fire yet — exactly as the live path reports
    // `availableToReserve === 0` only when nothing is left.
    expect({
      ...afterFirst,
      paidBy: first.receipt.grantId,
      freeLimitReached: first.outcome.freeLimitReached,
    }).toEqual({
      spendable: 1,
      consumed: 1,
      paidBy: first.receipt.grantId,
      freeLimitReached: false,
    });

    const second = await scoredOffline(store, requestB);
    const afterSecond = await tickets(store, reading());
    expect(afterSecond).toEqual({ spendable: 0, consumed: 2 });
    expect(second.outcome.freeLimitReached).toBe(true);
    expect(ticketFor(first.receipt).ticketId).not.toBe(
      ticketFor(second.receipt).ticketId,
    );
  });
});

describe('C5 concurrency: a newer grant generation restates the tickets mid-run', () => {
  it('the receipt never names a ticket under a generation the wallet has already moved past; tickets conserve', async () => {
    const { store, requestA } = await seed([GRANT_A_TWO_TICKETS]);
    network();
    const restated: GrantSpec = {
      grantId: GRANT_B,
      generation: 2,
      allocationId: ALLOCATION_A,
      ticketIds: [TICKET_1, TICKET_2],
    };
    // After the authority read chose grant A, the wallet holds generation 2
    // of the same allocation (as a reconnect's grant pull would), moving
    // both unconsumed tickets to grant B before the commit opens.
    let armed = false;
    let restatedHeld: Promise<unknown> | null = null;
    store.observeStatements(call => {
      if (
        !armed &&
        call.sql.includes('COUNT(*) AS pending FROM offline_receipt')
      ) {
        armed = true;
        restatedHeld = holdOfflineGrant(
          store.db,
          issuedGrant(restated),
          BINDING,
        );
      }
    });

    let outcome: RunCaptureAnalysisOutcome | null = null;
    let failure: unknown = null;
    try {
      outcome = await runCaptureAnalysis(requestA);
    } catch (error) {
      failure = error;
    }
    store.observeStatements(null);
    expect(armed).toBe(true);
    await restatedHeld;
    expect(failure).toBeNull();
    expect(outcome).not.toBeNull();
    expect(['scored', 'unavailable']).toContain(outcome?.kind);

    const wallet = await readOfflineAllocation(store.db, reading());
    const rows = receiptRows(store);
    const scored = outcome?.kind === 'scored';
    // A scored read spent exactly one ticket and its receipt names that
    // ticket under the generation the wallet now holds it in; an honest
    // no-score spent nothing and queued nothing.
    expect(wallet.consumedTickets).toBe(scored ? 1 : 0);
    expect(wallet.spendableTickets).toBe(scored ? 1 : 2);
    expect(rows).toHaveLength(scored ? 1 : 0);
    expect(scoredShots(store)).toBe(scored ? 1 : 0);
    for (const row of rows) {
      const receipt = JSON.parse(row.receipt) as {
        grantId: string;
        ticket: { generation: number; ticketId: string } | null;
      };
      expect(receipt.ticket).not.toBeNull();
      const ticketRow = store.native
        .prepare(
          `SELECT grant_id, generation, state FROM offline_ticket
           WHERE owner_key = ? AND ticket_id = ?`,
        )
        .get(OWNER, receipt.ticket!.ticketId) as {
        grant_id: string;
        generation: number;
        state: string;
      };
      expect(ticketRow.state).toBe('consumed');
      expect(ticketRow.grant_id).toBe(receipt.grantId);
      expect(ticketRow.generation).toBe(receipt.ticket!.generation);
    }
  });
});

describe('C6 crash between the server answer and the local apply', () => {
  it('a failed sync_receipt write rolls back the whole apply: the receipt stays pending, is re-presented under the SAME id and settles once', async () => {
    const { store, requestA } = await seed([GRANT_A_TWO_TICKETS]);
    const { analysis, receipt } = await scoredOffline(store, requestA);
    const { calls } = network({ receipts: acceptAll() });

    store.failStatementOnce('INSERT OR REPLACE INTO sync_receipt');
    await expect(
      reconcileOfflineWallet(store.db, offlineClient(), reading()),
    ).rejects.toBeInstanceOf(Error);

    // Atomicity: the server said `result_recorded`, but the device could not
    // durably record delivery — so it recorded nothing of the verdict.
    expect(receiptPosts(calls)).toHaveLength(1);
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);
    const afterCrash = receiptRows(store);
    expect(afterCrash).toHaveLength(1);
    expect(afterCrash[0]!.settlement).toBeNull();
    expect(afterCrash[0]!.settled_at).toBeNull();
    expect(journalStates(store)).toEqual(['in_flight']);
    expect(await readOfflineReceiptEvidence(store.db, analysis.id)).toEqual({
      kind: 'held',
      answered: false,
    });

    // The next drain (server idempotent) settles the same receipt exactly
    // once and marks the shot delivered.
    const settled = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
    );
    expect(settled.accepted).toBe(1);
    expect(settled.pending).toBe(0);
    const posts = receiptPosts(calls);
    expect(posts).toHaveLength(2);
    expect(presentedIds(posts[0]!)).toEqual([receipt.receiptId]);
    expect(presentedIds(posts[1]!)).toEqual([receipt.receiptId]);
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(true);
    expect(receiptRows(store)[0]!.settlement).toBe('accepted');
    const states = journalStates(store);
    expect(states).not.toContain('in_flight');
    expect(states.filter(state => state === 'applied')).toHaveLength(1);
    expect(await tickets(store, reading())).toEqual({
      spendable: 1,
      consumed: 1,
    });
  });
});

describe('C8 free-rating conservation: a Pro lease and a free grant are both held', () => {
  it('a Pro subscriber on the court rates under the lease and spends no lifetime free ticket', async () => {
    // The Pro lease was held first; the free grant is the newer generation
    // (the order a free-tier user who then subscribed, or a subscriber whose
    // free grant was restated, ends up with).
    const { store, requestA } = await seed([]);
    await holdOfflineGrant(store.db, issuedProLease(), BINDING);
    await holdOfflineGrant(
      store.db,
      issuedGrant({ ...GRANT_A_TWO_TICKETS, generation: 2 }),
      BINDING,
    );
    const before = await readOfflineAllocation(store.db, reading());
    expect(before.grants.map(grant => grant.execution.kind)).toEqual([
      'active',
      'active',
    ]);

    const { receipt } = await scoredOffline(store, requestA);

    // Premium bypasses the free allowance exactly as the live path does
    // (`accessSource: 'premium'` never counts a free rating): the receipt
    // is ticket-less and names the Pro lease; both lifetime tickets remain.
    expect({
      paidBy: receipt.grantId,
      ticket: receipt.ticket,
      ...(await tickets(store, reading())),
    }).toEqual({
      paidBy: PRO_GRANT,
      ticket: null,
      spendable: 2,
      consumed: 0,
    });
  });
});

describe('C7 account switch between the server answer and the local apply', () => {
  it("OTHER signing in while OWNER's verdict is in flight settles nothing for anyone; OWNER's next drain settles it once", async () => {
    const { store, requestA } = await seed([GRANT_A_TWO_TICKETS]);
    const { analysis, receipt } = await scoredOffline(store, requestA);
    const { calls } = network({
      receipts: call => {
        signIn(OTHER);
        return acceptAll()(call);
      },
    });

    let failure: unknown = null;
    try {
      await reconcileOfflineWallet(store.db, offlineClient(), reading());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);

    // OTHER is active: nothing of OWNER's was applied under OTHER, and OTHER
    // holds no wallet rows at all.
    expect(store.count('offline_receipt', OTHER)).toBe(0);
    expect(store.count('sync_receipt', OTHER)).toBe(0);
    expect(store.count('offline_wallet_journal', OTHER)).toBe(0);
    const rows = receiptRows(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.settlement).toBeNull();
    expect(journalStates(store)).toEqual(['in_flight']);

    // OWNER returns: the unanswered presentation is recovered, the SAME
    // receipt id is presented again and settles exactly once.
    signIn(OWNER);
    network({ receipts: acceptAll() });
    const settled = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
    );
    expect(settled.recovered).toBe(1);
    expect(settled.accepted).toBe(1);
    expect(settled.pending).toBe(0);
    expect(presentedIds(receiptPosts(calls)[0]!)).toEqual([receipt.receiptId]);
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(true);
    expect(receiptRows(store)[0]!.settlement).toBe('accepted');
    expect(store.count('sync_receipt', OTHER)).toBe(0);
  });
});
