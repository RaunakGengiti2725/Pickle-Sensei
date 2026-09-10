/**
 * W05-07 adversarial suite, round 2 — attacks candidate 4282f5ea at
 * boundaries the first round (w05CourtOfflineRun.attack.test.ts) left open.
 * Every test names the invariant it expects the candidate to hold; a failing
 * test is a confirmed break of that invariant, not a style opinion.
 *
 * Categories: concurrency for the LAST ticket across two captures, an
 * account switch inside the commit transaction, a route-level `rejected`
 * entry without a ledger verdict, a corrupt receipt row in front of a healthy
 * one, clock rollback at settlement time, an owner purge racing an in-flight
 * presentation, the free-limit signal after the last free ticket, a crash
 * between the server's answer and the local apply, a redirect on the drain, a
 * duplicated receipt id across `receipts` and `rejected`, a mixed
 * accepted/pending verdict batch, and copy rules for the new Result surface.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  runCaptureAnalysis,
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
} from '../src/data/offlineCapabilities';
import {
  readOfflineReceiptEvidence,
  readOfflineWalletJournal,
  readOfflineWalletStatus,
  reconcileOfflineWallet,
} from '../src/data/offlineWallet';
import { getDb } from '../src/data/db';
import { hasShotSyncReceipt, purgeOwnerData } from '../src/data/repository';
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
const GRANT_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const OTHER_GRANT_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const TICKETS = [
  'aaaaaaaa-0000-4000-8000-000000000001',
  'aaaaaaaa-0000-4000-8000-000000000002',
] as const;
const ONE_TICKET = [TICKETS[0]] as const;
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

function verdicts(
  call: FetchCall,
  status: string | ((receiptId: string, index: number) => string),
) {
  return response(200, {
    receipts: presentedIds(call).map((receiptId, index) => ({
      receiptId,
      status: typeof status === 'string' ? status : status(receiptId, index),
    })),
    rejected: [],
  });
}

function acceptAll() {
  return (call: FetchCall) => verdicts(call, 'result_recorded');
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

/** OWNER holds a policy and a grant with `ticketIds`; two captures (A, B)
 * with distinct pose sidecars are on the device. */
async function seed(ticketIds: readonly string[] = TICKETS) {
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
  await holdOfflineGrant(
    store.db,
    issuedGrant(OWNER, GRANT_ID, ticketIds),
    BINDING,
  );
  return {
    store,
    requestA: request(store, a.clip),
    requestB: request(store, b.clip, OPERATION_B, CAPTURE_B),
    clipA: a.clip,
  };
}

async function tickets(store: Store, at = reading()) {
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

function ownerRows(store: Store, owner: string): Record<string, number> {
  const tables = [
    'local_shot',
    'local_analysis_record',
    'sync_receipt',
    'outbox',
    'offline_grant',
    'offline_ticket',
    'offline_receipt',
    'offline_wallet_journal',
  ];
  return Object.fromEntries(
    tables.map(table => [table, store.count(table, owner)]),
  );
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

describe('B1 concurrency — two captures race for the LAST free ticket', () => {
  it('exactly one read scores, the loser ends on an honest outcome (never a throw), one ticket is spent', async () => {
    const { store, requestA, requestB } = await seed(ONE_TICKET);
    network();
    const results = await Promise.allSettled([
      runCaptureAnalysis(requestA),
      runCaptureAnalysis(requestB),
    ]);
    const kinds = results.map(result =>
      result.status === 'fulfilled'
        ? result.value.kind
        : `threw:${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
    );
    expect(kinds.filter(kind => kind === 'scored')).toHaveLength(1);
    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(store.count('local_shot', OWNER)).toBe(1);
    expect(store.count('outbox', OWNER)).toBe(0);
    // The loser must end on the same honest no-score outcome a sequential
    // second capture gets (`unavailable`), not on a rejected promise that
    // reaches the screen as a generic error.
    expect(kinds.filter(kind => kind.startsWith('threw:'))).toEqual([]);
  });

  it('after the lost race, retrying the loser is the honest no-score path and spends nothing more', async () => {
    const { store, requestA, requestB } = await seed(ONE_TICKET);
    network();
    const results = await Promise.allSettled([
      runCaptureAnalysis(requestA),
      runCaptureAnalysis(requestB),
    ]);
    const winner = results.findIndex(
      result => result.status === 'fulfilled' && result.value.kind === 'scored',
    );
    expect(winner).toBeGreaterThanOrEqual(0);
    const loser = winner === 0 ? requestB : requestA;
    const loserRow = store.native
      .prepare(
        `SELECT state, release_outcome FROM analysis_run_journal WHERE owner_key = ? AND operation_id = ?`,
      )
      .get(OWNER, loser.operationId ?? '');
    // Whatever the loser's journal says, it never claims a rating.
    expect(loserRow?.state ?? null).not.toBe('committed');
    const retry = await runCaptureAnalysis(loser);
    expect(retry.kind).toBe('unavailable');
    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(store.count('local_shot', OWNER)).toBe(1);
    expect(store.count('outbox', OWNER)).toBe(0);
  });

  it('a sequential second capture after the last ticket is the honest no-score path', async () => {
    const { store, requestA, requestB } = await seed(ONE_TICKET);
    await scoredOffline(store, requestA);
    const second = await runCaptureAnalysis(requestB);
    expect(second.kind).toBe('unavailable');
    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(store.count('local_shot', OWNER)).toBe(1);
  });
});

describe('B2 interleaved account switch inside the commit transaction', () => {
  it("OTHER signing in between the record write and the consume never spends OTHER's grant and persists nothing", async () => {
    const { store, clipA } = await seed();
    signIn(OTHER);
    await holdOfflineGrant(
      store.db,
      issuedGrant(OTHER, OTHER_GRANT_ID, OTHER_TICKETS),
      BINDING,
    );
    await cachePolicy(store, OTHER);
    signIn(OWNER);
    const requestA = request(store, clipA);
    network();
    let switched = false;
    store.observeStatements(call => {
      if (!switched && call.sql.includes('INSERT INTO local_analysis_record')) {
        switched = true;
        signIn(OTHER);
      }
    });
    const settled = await Promise.allSettled([runCaptureAnalysis(requestA)]);
    store.observeStatements(null);
    expect(switched).toBe(true);
    const [result] = settled;
    if (result.status === 'fulfilled') {
      expect(result.value.kind).not.toBe('scored');
    }
    signIn(OTHER);
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    signIn(OWNER);
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
    for (const owner of [OWNER, OTHER]) {
      expect(store.count('offline_receipt', owner)).toBe(0);
      expect(store.count('local_shot', owner)).toBe(0);
      expect(store.count('local_analysis_record', owner)).toBe(0);
    }
  });
});

describe('B3 a route-level `rejected` entry (no ledger verdict)', () => {
  it('never marks the shot synced, never returns the ticket, and the receipt is not silently dropped from evidence', async () => {
    const { store, requestA } = await seed();
    const { analysis, receipt } = await scoredOffline(store, requestA);
    const online = network({
      receipts: call =>
        response(200, {
          receipts: [],
          rejected: presentedIds(call).map(receiptId => ({
            receiptId,
            code: 'offline.invalid_input',
            message: 'receipt: malformed',
          })),
        }),
    });
    const drained = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
    );
    expect(receiptPosts(online.calls)).toHaveLength(1);
    expect(drained.accepted).toBe(0);
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    const evidence = await readOfflineReceiptEvidence(store.db, analysis.id);
    expect(evidence).not.toBeNull();
    expect(evidence?.kind).not.toBe('accepted');
    // Whatever the local classification, the receipt id the device presented
    // is the only one it ever presents.
    const again = network({ receipts: acceptAll() });
    await reconcileOfflineWallet(store.db, offlineClient(), reading());
    for (const post of receiptPosts(again.calls)) {
      expect(presentedIds(post)).toEqual([receipt.receiptId]);
    }
  });
});

describe('B4 a corrupt receipt row in front of a healthy one', () => {
  it('does not starve settlement of the healthy receipt', async () => {
    const { store, requestA, requestB } = await seed();
    const first = await scoredOffline(store, requestA);
    const second = await scoredOffline(store, requestB);
    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 2 });
    store.native
      .prepare(
        `UPDATE offline_receipt SET receipt = '{"not":"a receipt"' WHERE owner_key = ? AND receipt_id = ?`,
      )
      .run(OWNER, first.receipt.receiptId);
    const online = network({ receipts: acceptAll() });
    const settled = await Promise.allSettled([
      reconcileOfflineWallet(store.db, offlineClient(), reading()),
    ]);
    const posts = receiptPosts(online.calls);
    const presented = posts.flatMap(presentedIds);
    // The corrupt row is never presented as if it were a receipt…
    expect(presented).not.toContain(first.receipt.receiptId);
    // …and the healthy one still reaches the server and settles; a single
    // unreadable row must not starve every other paid receipt of the owner.
    expect({
      drain: settled[0].status,
      presented,
      posts: posts.length,
    }).toEqual({
      drain: 'fulfilled',
      presented: [second.receipt.receiptId],
      posts: 1,
    });
    expect(await hasShotSyncReceipt(store.db, second.analysis.id)).toBe(true);
  });

  it('the corrupt row does not hide the healthy receipt from the Result surface or the run replay', async () => {
    const { store, requestA, requestB } = await seed();
    const first = await scoredOffline(store, requestA);
    const second = await scoredOffline(store, requestB);
    store.native
      .prepare(
        `UPDATE offline_receipt SET receipt = '{"not":"a receipt"' WHERE owner_key = ? AND receipt_id = ?`,
      )
      .run(OWNER, first.receipt.receiptId);
    expect(
      await readOfflineReceiptEvidence(store.db, second.analysis.id),
    ).toEqual({ kind: 'queued' });
    network();
    const replay = await runCaptureAnalysis(requestB);
    expect(replay.kind).toBe('scored');
    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 2 });
  });
});

describe('B5 clock rollback at settlement time', () => {
  it('a rollback-detected device reading still lets the server settle the receipt (settlement is not a lease decision)', async () => {
    const { store, requestA } = await seed();
    const { analysis } = await scoredOffline(store, requestA);
    const rolledBack = reading(NOW_MS - 3 * 24 * 60 * 60 * 1000, {
      authority: 'none',
      continuity: 'unmeasured',
      rollbackDetected: true,
    });
    const online = network({ receipts: acceptAll() });
    const drained = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      rolledBack,
    );
    expect(receiptPosts(online.calls)).toHaveLength(1);
    expect(drained).toMatchObject({ submitted: 1, accepted: 1, pending: 0 });
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(true);
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
  });

  it('a NaN wall clock at settlement never writes an unparseable settled_at or throws the drain', async () => {
    const { store, requestA } = await seed();
    const { analysis } = await scoredOffline(store, requestA);
    network({ receipts: acceptAll() });
    const settled = await Promise.allSettled([
      reconcileOfflineWallet(
        store.db,
        offlineClient(),
        reading(NOW_MS, { wallClockMs: Number.NaN }),
      ),
    ]);
    if (settled[0].status === 'fulfilled') {
      const row = store.native
        .prepare(
          `SELECT settlement, settled_at FROM offline_receipt WHERE owner_key = ?`,
        )
        .get(OWNER);
      expect(row?.settlement).toBe('accepted');
      expect(Number.isNaN(Date.parse(String(row?.settled_at)))).toBe(false);
      expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(true);
    } else {
      // A thrown drain must have settled nothing and left the receipt
      // re-presentable (HOLD), never half-applied.
      expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);
      const [pending] = await pendingOfflineReceipts(store.db);
      expect(pending?.settlement).not.toBe('accepted');
    }
  });
});

describe('B6 an owner purge racing an in-flight presentation', () => {
  it("the verdict for a purged owner's receipt resurrects nothing", async () => {
    const { store, requestA } = await seed();
    await scoredOffline(store, requestA);
    network({
      receipts: async call => {
        await purgeOwnerData(store.db, OWNER);
        return verdicts(call, 'result_recorded');
      },
    });
    await Promise.allSettled([
      reconcileOfflineWallet(store.db, offlineClient(), reading()),
    ]);
    expect(ownerRows(store, OWNER)).toEqual({
      local_shot: 0,
      local_analysis_record: 0,
      sync_receipt: 0,
      outbox: 0,
      offline_grant: 0,
      offline_ticket: 0,
      offline_receipt: 0,
      offline_wallet_journal: 0,
    });
  });
});

describe('B7 free-rating signal after the last free ticket', () => {
  it('spending the last free ticket on court reports the free limit exactly as the live path does', async () => {
    const { store, requestA } = await seed(ONE_TICKET);
    const { outcome } = await scoredOffline(store, requestA);
    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 1 });
    // The live path sets freeLimitReached when the reservation leaves zero
    // free ratings to reserve; a free grant with zero tickets left is the
    // same fact, decided by the same server-issued allocation.
    expect(outcome.freeLimitReached).toBe(true);
  });
});

describe('B8 crash between the server answer and the local apply', () => {
  it('a drain that dies after the verdict arrived re-presents the SAME receipt and settles it once', async () => {
    const { store, requestA } = await seed();
    const { analysis, receipt } = await scoredOffline(store, requestA);
    store.failStatementOnce(
      "UPDATE offline_wallet_journal SET state = 'applied'",
    );
    const first = network({ receipts: acceptAll() });
    const crashed = await Promise.allSettled([
      reconcileOfflineWallet(store.db, offlineClient(), reading()),
    ]);
    expect(receiptPosts(first.calls)).toHaveLength(1);
    expect(crashed[0].status).toBe('rejected');
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);
    const status = await readOfflineWalletStatus(store.db);
    expect(status.pending.map(entry => entry.phase)).toEqual([
      'presented_unanswered',
    ]);
    const second = network({ receipts: acceptAll() });
    const drained = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
    );
    expect(receiptPosts(second.calls).map(presentedIds)).toEqual([
      [receipt.receiptId],
    ]);
    expect(drained).toMatchObject({ accepted: 1, pending: 0 });
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(true);
    expect(store.count('sync_receipt', OWNER)).toBe(1);
    const journal = await readOfflineWalletJournal(store.db);
    expect(journal.map(entry => entry.state).sort()).toEqual([
      'applied',
      'superseded',
    ]);
  });
});

describe('B9 redirect on the drain', () => {
  it('a captive-portal redirect settles nothing; the same receipt id is re-presented and settled once', async () => {
    const { store, requestA } = await seed();
    const { analysis, receipt } = await scoredOffline(store, requestA);
    const portal = network({
      receipts: () =>
        response(
          200,
          {
            receipts: [
              { receiptId: receipt.receiptId, status: 'result_recorded' },
            ],
            rejected: [],
          },
          {},
          { redirected: true, url: 'https://portal.example.test/login' },
        ),
    });
    const first = await Promise.allSettled([
      reconcileOfflineWallet(store.db, offlineClient(), reading()),
    ]);
    expect(receiptPosts(portal.calls)).toHaveLength(1);
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);
    if (first[0].status === 'fulfilled') {
      expect(first[0].value.accepted).toBe(0);
    }
    const again = network({ receipts: acceptAll() });
    const drained = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
    );
    expect(receiptPosts(again.calls).map(presentedIds)).toEqual([
      [receipt.receiptId],
    ]);
    expect(drained).toMatchObject({ accepted: 1 });
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(true);
    expect(store.count('sync_receipt', OWNER)).toBe(1);
  });
});

describe('B10 duplicate identities in the verdict', () => {
  it('a receipt id named in both `receipts` and `rejected` settles nothing and stays a HOLD', async () => {
    const { store, requestA } = await seed();
    const { analysis, receipt } = await scoredOffline(store, requestA);
    network({
      receipts: () =>
        response(200, {
          receipts: [
            { receiptId: receipt.receiptId, status: 'result_recorded' },
          ],
          rejected: [
            {
              receiptId: receipt.receiptId,
              code: 'offline.invalid_input',
              message: 'grant: malformed',
            },
          ],
        }),
    });
    await Promise.allSettled([
      reconcileOfflineWallet(store.db, offlineClient(), reading()),
    ]);
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);
    const row = store.native
      .prepare(
        `SELECT settlement FROM offline_receipt WHERE owner_key = ? AND receipt_id = ?`,
      )
      .get(OWNER, receipt.receiptId);
    expect(row?.settlement ?? null).toBeNull();
    const status = await readOfflineWalletStatus(store.db);
    expect(status.pending.map(entry => entry.phase)).toEqual([
      'presented_unanswered',
    ]);
  });
});

describe('B11 mixed verdict batch', () => {
  it('accepted + pending in one answer settles only the accepted one and re-presents only the pending one', async () => {
    const { store, requestA, requestB } = await seed();
    const first = await scoredOffline(store, requestA);
    const second = await scoredOffline(store, requestB);
    network({
      receipts: call =>
        verdicts(call, receiptId =>
          receiptId === first.receipt.receiptId ? 'result_recorded' : 'pending',
        ),
    });
    const drained = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
    );
    expect(drained).toMatchObject({ accepted: 1, held: 1, pending: 1 });
    expect(await hasShotSyncReceipt(store.db, first.analysis.id)).toBe(true);
    expect(await hasShotSyncReceipt(store.db, second.analysis.id)).toBe(false);
    expect(
      await readOfflineReceiptEvidence(store.db, second.analysis.id),
    ).toEqual({ kind: 'held', answered: true });
    const again = network({ receipts: acceptAll() });
    await reconcileOfflineWallet(store.db, offlineClient(), reading());
    expect(receiptPosts(again.calls).map(presentedIds)).toEqual([
      [second.receipt.receiptId],
    ]);
    expect(await hasShotSyncReceipt(store.db, second.analysis.id)).toBe(true);
    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 2 });
  });
});

describe('B12 copy rules for the new Result surface', () => {
  it('the offline receipt copy follows APP_STORE_SUBMISSION.md (no platform, competitor, accuracy or superlative claims)', () => {
    const source = readFileSync(
      join(__dirname, '..', 'src', 'screens', 'ResultScreen.tsx'),
      'utf8',
    );
    const offlineCopy = source
      .split('\n')
      .filter(line => /on-court read|offline allocation/.test(line));
    expect(offlineCopy.length).toBeGreaterThanOrEqual(4);
    const banned =
      /android|google play|guest|live court|dupr|swingvision|% accura|accuracy|best|#1|world-class|replaces? (your|a) coach|as good as a coach/i;
    for (const line of offlineCopy) {
      expect(line).not.toMatch(banned);
    }
  });
});
