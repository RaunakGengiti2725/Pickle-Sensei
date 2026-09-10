/**
 * W05-07 adversarial suite, round 4 (candidate 48d3db71) — boundaries the
 * first four rounds (attack, attack2, attack3, Adversary) left open.
 * Every test names the invariant it expects the candidate to hold; a failing
 * test is a confirmed break of that invariant, not a style opinion.
 *
 * Categories: D1 a cancellation that lands the instant the offline commit is
 * durable (reentrancy at the commit boundary), D2 the rated shot altered on
 * disk after the receipt paid for it (corrupt product row behind a healthy
 * receipt), D3 a corrupt write-ahead journal row (corrupt wallet state that
 * is neither a receipt nor a grant), D4 a 429 + Retry-After answer to the
 * SECOND chunk of one drain (network failure mid-drain), D5 a HELD verdict
 * followed by acceptance on a later drain (settlement state machine), D6 a
 * REFUSED receipt replayed by the same operation (free-rating conservation
 * after a refusal), D7 an unreadable trusted clock at the moment of spending
 * (clock boundary after inference), D8 a spend-time clock that has rolled
 * back since the authority read.
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
  type OfflineConsumptionReceipt,
} from '../src/data/offlineCapabilities';
import {
  readOfflineReceiptEvidence,
  readOfflineWalletStatus,
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
const CAPTURE = '33333333-3333-4333-8333-333333333333';
const CAPTURE_B = '33333333-3333-4333-8333-333333333334';
const OPERATION = '44444444-4444-4444-8444-444444444444';
const OPERATION_B = '44444444-4444-4444-8444-444444444445';
const API_ORIGIN = 'https://api.example.test/functions/v1/api';
const BEARER = 'fresh-owner-token';
const INSTALLATION_KEY = 'ios-install-key-1';
const KEY_ID = 'offline-grant-key-1';
const GRANT_A = 'bbbbbbbb-0000-4000-8000-000000000001';
const ALLOCATION_A = 'dddddddd-0000-4000-8000-000000000001';
const TICKET_1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const TICKET_2 = 'aaaaaaaa-0000-4000-8000-000000000002';
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

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status < 400,
    status,
    statusText: String(status),
    redirected: false,
    type: 'basic',
    url: '',
    headers: {
      get: (name: string) => {
        const key = Object.keys(headers).find(
          candidate => candidate.toLowerCase() === name.toLowerCase(),
        );
        return key === undefined ? null : headers[key]!;
      },
    },
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

function presentedEntries(call: FetchCall): Array<Record<string, unknown>> {
  return (call.body.receipts ?? []) as Array<Record<string, unknown>>;
}

function presentedIds(call: FetchCall): string[] {
  return presentedEntries(call).map(entry =>
    String((entry.receipt as Record<string, unknown>).receiptId),
  );
}

function answerAll(status: string) {
  return (call: FetchCall) =>
    response(200, {
      receipts: presentedIds(call).map(receiptId => ({ receiptId, status })),
      rejected: [],
    });
}

function acceptAll() {
  return answerAll('result_recorded');
}

function refuseAll(code: string) {
  return (call: FetchCall) =>
    response(200, {
      receipts: [],
      rejected: presentedIds(call).map(receiptId => ({ receiptId, code })),
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
  signal?: AbortSignal,
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
    ...(signal ? { signal } : {}),
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
    clipA: a.clip,
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

function ticketStates(store: Store, owner = OWNER): Record<string, string> {
  const rows = store.native
    .prepare(
      `SELECT ticket_id, state FROM offline_ticket WHERE owner_key = ? ORDER BY ticket_id`,
    )
    .all(owner) as Array<{ ticket_id: string; state: string }>;
  return Object.fromEntries(rows.map(row => [row.ticket_id, row.state]));
}

function ticketFor(receipt: OfflineConsumptionReceipt) {
  if (receipt.ticket === null) throw new Error('a free receipt names a ticket');
  return receipt.ticket;
}

async function settle<T>(
  operation: () => Promise<T>,
): Promise<{ value: T | null; failure: unknown }> {
  try {
    return { value: await operation(), failure: null };
  } catch (error) {
    return { value: null, failure: error };
  }
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

describe('D1 reentrancy: the caller cancels the instant the offline commit is durable', () => {
  it('a paid, durable court-offline rating is never reported as "cancelled" — the caller gets the rating or the recovery hold, exactly as the live path does', async () => {
    const { store, clipA } = await seed([GRANT_A_TWO_TICKETS]);
    network();
    const controller = new AbortController();
    const req = request(store, clipA, OPERATION, CAPTURE, controller.signal);
    // The screen unmounts (back gesture, incoming call) at the exact moment
    // SQLite acknowledges the COMMIT that spent the ticket, queued the
    // receipt and stored the scored shot.
    let committed = false;
    const transactions = new Map<number, boolean>();
    store.observeStatements(call => {
      if (call.sql.includes('INSERT INTO offline_receipt')) {
        transactions.set(call.transaction, true);
      }
      if (
        !committed &&
        call.sql === 'COMMIT' &&
        transactions.get(call.transaction) === true
      ) {
        committed = true;
        controller.abort();
      }
    });

    const { value: outcome, failure } = await settle(() =>
      runCaptureAnalysis(req),
    );
    store.observeStatements(null);
    expect(committed).toBe(true);
    expect(failure).toBeNull();

    // The spend is durable: one ticket consumed, one receipt queued, one
    // scored shot — the same state a successful run leaves behind.
    expect({
      ...(await tickets(store, reading())),
      receipts: receiptRows(store).length,
      scoredShots: scoredShots(store),
    }).toEqual({ spendable: 1, consumed: 1, receipts: 1, scoredShots: 1 });

    // Invariant under attack: the live path answers a cancellation that
    // lands after its commit with the durable outcome (scored) or the
    // recovery hold, never with "This analysis was cancelled" (pinned by
    // runCaptureJournalIntegration.test.ts "preserves a committed result
    // when cancel happens before publication") — a rating the user paid a
    // lifetime free ticket for must not be announced as cancelled. The
    // court-offline commit must hold the same line.
    expect(outcome).not.toBeNull();
    const kind = outcome?.kind;
    const cause = outcome?.kind === 'unavailable' ? outcome.cause : null;
    expect({ kind, cause }).not.toEqual({
      kind: 'unavailable',
      cause: 'cancelled',
    });
    expect(
      kind === 'scored' ||
        (kind === 'unavailable' && cause === 'recovery_pending'),
    ).toBe(true);

    // The same operation, run again on the same court, replays the paid
    // rating and spends nothing more.
    network();
    const replay = await runCaptureAnalysis(request(store, clipA));
    expect(replay.kind).toBe('scored');
    expect(replay.kind === 'scored' && replay.replayed).toBe(true);
    expect(await tickets(store, reading())).toEqual({
      spendable: 1,
      consumed: 1,
    });
    expect(receiptRows(store)).toHaveLength(1);
  });
});

describe('D2 corrupt persisted state: the rated shot changes on disk after its receipt paid for it', () => {
  async function paidThenAltered() {
    const { store, requestA, clipA } = await seed([GRANT_A_TWO_TICKETS]);
    const { analysis, receipt } = await scoredOffline(store, requestA);
    // A later write (a bug, a migration, a tampering user) changes the
    // stored overall score of the shot the receipt hashed.
    const row = store.native
      .prepare(`SELECT payload FROM local_shot WHERE owner_key = ? AND id = ?`)
      .get(OWNER, analysis.id) as { payload: string };
    const payload = JSON.parse(row.payload) as { overallScore: number };
    payload.overallScore = Math.min(100, payload.overallScore + 1);
    store.native
      .prepare(
        `UPDATE local_shot SET payload = ?, overall_score = ? WHERE owner_key = ? AND id = ?`,
      )
      .run(JSON.stringify(payload), payload.overallScore, OWNER, analysis.id);
    return { store, analysis, receipt, clipA };
  }

  it('the drain never presents the altered output as the paid one: output is null, the receipt still travels under the same id, and nothing local is invented', async () => {
    const { store, analysis, receipt } = await paidThenAltered();
    const { calls } = network({
      receipts: refuseAll('unused_ticket_returned'),
    });

    const drained = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
    );
    const posts = receiptPosts(calls);
    expect(posts).toHaveLength(1);
    const entries = presentedEntries(posts[0]!);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.output).toBeNull();
    expect(
      (entries[0]!.receipt as Record<string, unknown>).fullOutputSha256,
    ).toBe(receipt.fullOutputSha256);
    expect((entries[0]!.grant as Record<string, unknown>).schemaVersion).toBe(
      OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
    );

    // The server's refusal is recorded as such; the shot is NOT marked
    // synced; the ticket the device spent stays consumed until a grant pull
    // restates it (nothing is refunded locally).
    expect(drained.refused).toBe(1);
    expect(drained.accepted).toBe(0);
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);
    expect(receiptRows(store)[0]!.settlement).toBe('refused');
    expect(await readOfflineReceiptEvidence(store.db, analysis.id)).toEqual({
      kind: 'refused',
      code: 'unused_ticket_returned',
    });
    expect(await tickets(store, reading())).toEqual({
      spendable: 1,
      consumed: 1,
    });
  });

  it('the same operation replayed does not hand back the altered rating as the paid one and spends nothing more', async () => {
    const { store, clipA } = await paidThenAltered();
    network();
    const { value: outcome, failure } = await settle(() =>
      runCaptureAnalysis(request(store, clipA)),
    );
    // Either the run refuses honestly (a thrown conflict or a non-scored
    // outcome) or — never — returns a scored replay whose payload differs
    // from what the receipt paid for. In every case no second spend.
    if (failure === null) {
      expect(outcome?.kind).not.toBe('scored');
    } else {
      expect(failure).toBeInstanceOf(Error);
    }
    expect(await tickets(store, reading())).toEqual({
      spendable: 1,
      consumed: 1,
    });
    expect(receiptRows(store)).toHaveLength(1);
    expect(scoredShots(store)).toBe(1);
  });
});

describe('D3 corrupt persisted state: a damaged write-ahead journal row', () => {
  async function paidWithDamagedJournal() {
    const { store, requestA, requestB } = await seed([GRANT_A_TWO_TICKETS]);
    const first = await scoredOffline(store, requestA);
    // A previous presentation's journal row loses its verdicts (an
    // `applied` entry whose verdict list is gone).
    store.native
      .prepare(
        `INSERT INTO offline_wallet_journal
         (owner_key, journal_id, kind, receipt_ids, state, opened_at, closed_at, verdicts)
         VALUES (?, 'eeeeeeee-0000-4000-8000-000000000001', 'receipt_submission', ?, 'applied', ?, ?, NULL)`,
      )
      .run(
        OWNER,
        JSON.stringify(['ffffffff-0000-4000-8000-000000000001']),
        new Date(NOW_MS - 60_000).toISOString(),
        new Date(NOW_MS - 59_000).toISOString(),
      );
    return { store, first, requestB };
  }

  it('the drain fails honestly (typed, before anything is sent) and nothing is dropped, settled or invented', async () => {
    const { store, first } = await paidWithDamagedJournal();
    const { calls } = network({ receipts: acceptAll() });
    const { value, failure } = await settle(() =>
      reconcileOfflineWallet(store.db, offlineClient(), reading()),
    );
    // Whether the candidate holds the whole wallet or skips the damaged
    // row, the receipt must still be on file and never reported as settled
    // by a verdict the server did not give.
    const rows = receiptRows(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.receipt_id).toBe(first.receipt.receiptId);
    if (failure !== null) {
      expect(failure).toBeInstanceOf(Error);
      expect((failure as { code?: string }).code).toBe(
        'offline.wallet_corrupt',
      );
      expect(receiptPosts(calls)).toHaveLength(0);
      expect(rows[0]!.settlement).toBeNull();
      expect(await hasShotSyncReceipt(store.db, first.analysis.id)).toBe(false);
    } else {
      expect(value?.accepted).toBe(1);
      expect(rows[0]!.settlement).toBe('accepted');
    }
    // The tickets are untouched by a journal problem.
    expect(await tickets(store, reading())).toEqual({
      spendable: 1,
      consumed: 1,
    });
  });

  it('a damaged journal row does not stop a new court-offline read from rating and spending exactly one ticket', async () => {
    const { store, requestB } = await paidWithDamagedJournal();
    const second = await scoredOffline(store, requestB);
    expect(ticketFor(second.receipt).ticketId).not.toBe(TICKET_1);
    expect(await tickets(store, reading())).toEqual({
      spendable: 0,
      consumed: 2,
    });
    expect(second.outcome.freeLimitReached).toBe(true);
    expect(receiptRows(store)).toHaveLength(2);
  });
});

describe('D4 network failure mid-drain: 429 + Retry-After on the SECOND chunk', () => {
  it('the first chunk stays settled, the second is a HOLD (not refused, not dropped), and the next drain settles it once under the same id', async () => {
    const { store, requestA, requestB } = await seed([GRANT_A_TWO_TICKETS]);
    const first = await scoredOffline(store, requestA);
    const second = await scoredOffline(store, requestB);
    let posts = 0;
    const { calls } = network({
      receipts: call => {
        posts += 1;
        if (posts === 1) return acceptAll()(call);
        return response(
          429,
          { error: { code: 'rate_limited', message: 'Slow down.' } },
          { 'Retry-After': '30' },
        );
      },
    });

    const { failure } = await settle(() =>
      reconcileOfflineWallet(store.db, offlineClient(), reading(), {
        presentationMaxChars: 1,
      }),
    );
    expect(failure).toBeInstanceOf(Error);
    expect(receiptPosts(calls)).toHaveLength(2);
    expect(presentedIds(receiptPosts(calls)[0]!)).toEqual([
      first.receipt.receiptId,
    ]);
    expect(presentedIds(receiptPosts(calls)[1]!)).toEqual([
      second.receipt.receiptId,
    ]);

    // Chunk 1's acceptance is durable; chunk 2 is an unanswered
    // presentation, surfaced as such — never a refusal, never forgotten.
    expect(await hasShotSyncReceipt(store.db, first.analysis.id)).toBe(true);
    expect(await hasShotSyncReceipt(store.db, second.analysis.id)).toBe(false);
    const rows = receiptRows(store);
    expect(rows.map(row => row.settlement)).toEqual(['accepted', null]);
    expect(journalStates(store)).toEqual(['applied', 'in_flight']);
    const status = await readOfflineWalletStatus(store.db);
    expect(status.hold).toBe(true);
    expect(status.pending.map(entry => [entry.receiptId, entry.phase])).toEqual(
      [[second.receipt.receiptId, 'presented_unanswered']],
    );
    expect(
      await readOfflineReceiptEvidence(store.db, second.analysis.id),
    ).toEqual({ kind: 'held', answered: false });

    // After Retry-After: the same receipt id, presented once more, settles.
    network({ receipts: acceptAll() });
    const settled = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(NOW_MS + 31_000),
    );
    expect({
      recovered: settled.recovered,
      accepted: settled.accepted,
      pending: settled.pending,
      stale: settled.stale,
    }).toEqual({ recovered: 1, accepted: 1, pending: 0, stale: 0 });
    expect(await hasShotSyncReceipt(store.db, second.analysis.id)).toBe(true);
    expect(receiptRows(store).map(row => row.settlement)).toEqual([
      'accepted',
      'accepted',
    ]);
    expect(journalStates(store)).toEqual(['applied', 'superseded', 'applied']);
    expect(await tickets(store, reading())).toEqual({
      spendable: 0,
      consumed: 2,
    });
  });
});

describe('D5 settlement state machine: HELD, then accepted on a later drain', () => {
  it('a held receipt is not re-presented within the same drain, stays pending with the W05-04 phase, and a later acceptance marks the shot synced exactly once', async () => {
    const { store, requestA } = await seed([GRANT_A_TWO_TICKETS]);
    const { analysis, receipt } = await scoredOffline(store, requestA);
    const { calls } = network({ receipts: answerAll('pending') });

    const held = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
    );
    expect({
      held: held.held,
      accepted: held.accepted,
      pending: held.pending,
    }).toEqual({ held: 1, accepted: 0, pending: 1 });
    expect(receiptPosts(calls)).toHaveLength(1);
    expect(receiptRows(store)[0]).toMatchObject({
      settlement: 'held',
      settled_at: null,
    });
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);
    const status = await readOfflineWalletStatus(store.db);
    expect(status.hold).toBe(false);
    expect(status.pending.map(entry => entry.phase)).toEqual(['held']);
    expect(await readOfflineReceiptEvidence(store.db, analysis.id)).toEqual({
      kind: 'held',
      answered: true,
    });

    // A second HOLD answer keeps it held (no double-count, no flip).
    const heldAgain = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
    );
    expect(heldAgain.held).toBe(1);
    expect(receiptRows(store)[0]!.settlement).toBe('held');

    network({ receipts: acceptAll() });
    const accepted = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
    );
    expect({
      accepted: accepted.accepted,
      held: accepted.held,
      pending: accepted.pending,
    }).toEqual({ accepted: 1, held: 0, pending: 0 });
    expect(receiptRows(store)[0]!.settlement).toBe('accepted');
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(true);
    expect(await readOfflineReceiptEvidence(store.db, analysis.id)).toEqual({
      kind: 'accepted',
    });
    expect(
      store.native
        .prepare(
          `SELECT count(*) AS n FROM sync_receipt WHERE owner_key = ? AND entity_id = ?`,
        )
        .get(OWNER, analysis.id)?.n,
    ).toBe(1);
    expect(receipt.receiptId).toBe(receiptRows(store)[0]!.receipt_id);
  });
});

describe('D6 free-rating conservation after a REFUSED receipt', () => {
  it('the refusal is surfaced with its code, the same operation replays without a new spend, and the refused ticket is neither refunded nor re-spent locally', async () => {
    const { store, requestA, clipA } = await seed([GRANT_A_TWO_TICKETS]);
    const { analysis, receipt } = await scoredOffline(store, requestA);
    network({ receipts: refuseAll('offline.grant_revoked') });
    const drained = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
    );
    expect(drained.refused).toBe(1);
    expect(await readOfflineReceiptEvidence(store.db, analysis.id)).toEqual({
      kind: 'refused',
      code: 'offline.grant_revoked',
    });
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);

    // The refused receipt is final: a later drain never re-presents it.
    const { calls } = network({ receipts: acceptAll() });
    const again = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
    );
    expect(again.submitted).toBe(0);
    expect(receiptPosts(calls)).toHaveLength(0);
    expect(receiptRows(store)[0]!.settlement).toBe('refused');

    // The same operation on the court again: the paid rating is replayed,
    // no second ticket is spent, no second receipt is queued.
    network();
    const replay = await runCaptureAnalysis(request(store, clipA));
    expect(replay.kind).toBe('scored');
    expect(replay.kind === 'scored' && replay.replayed).toBe(true);
    expect(await tickets(store, reading())).toEqual({
      spendable: 1,
      consumed: 1,
    });
    expect(receiptRows(store)).toHaveLength(1);
    expect(ticketStates(store)[ticketFor(receipt).ticketId]).toBe('consumed');
  });
});

describe('D7 clock boundary: the trusted clock becomes unreadable at the moment of spending', () => {
  it('no numeric score is committed, nothing is spent, nothing is queued, and the outcome is the honest no-score (not a crash)', async () => {
    const { store, requestA, clipA } = await seed([GRANT_A_TWO_TICKETS]);
    network();
    let blinded = false;
    store.observeStatements(call => {
      if (
        !blinded &&
        call.sql.includes('COUNT(*) AS pending FROM offline_receipt')
      ) {
        blinded = true;
        mockReading = null;
      }
    });
    const { value: outcome, failure } = await settle(() =>
      runCaptureAnalysis(requestA),
    );
    store.observeStatements(null);
    expect(blinded).toBe(true);
    expect(failure).toBeNull();
    expect(outcome?.kind).toBe('unavailable');
    mockReading = reading();
    expect({
      ...(await tickets(store, reading())),
      receipts: receiptRows(store).length,
      scoredShots: scoredShots(store),
    }).toEqual({ spendable: 2, consumed: 0, receipts: 0, scoredShots: 0 });

    // The failed operation is held for recovery (the journal's existing
    // design: a released run is never re-run under its own id) and the
    // court is still usable once the clock is back: a new operation on the
    // same capture rates and spends exactly one ticket.
    const sameOperation = await runCaptureAnalysis(requestA);
    expect(sameOperation).toMatchObject({
      kind: 'unavailable',
      cause: 'recovery_pending',
    });
    expect(await tickets(store, reading())).toEqual({
      spendable: 2,
      consumed: 0,
    });
    const retry = await runCaptureAnalysis(
      request(store, clipA, OPERATION_B, CAPTURE),
    );
    expect(retry.kind).toBe('scored');
    expect(retry.kind === 'scored' && retry.replayed).toBeFalsy();
    expect(await tickets(store, reading())).toEqual({
      spendable: 1,
      consumed: 1,
    });
    expect(receiptRows(store)).toHaveLength(1);
  });
});

describe('D8 clock boundary: rollback detected between the authority read and the spend', () => {
  it('a spend-time reading that flags a rollback authorises nothing: no score, nothing spent, nothing queued', async () => {
    const { store, requestA } = await seed([GRANT_A_TWO_TICKETS]);
    network();
    let rolledBack = false;
    store.observeStatements(call => {
      if (
        !rolledBack &&
        call.sql.includes('COUNT(*) AS pending FROM offline_receipt')
      ) {
        rolledBack = true;
        mockReading = reading(NOW_MS - 2 * 24 * 60 * 60 * 1000, {
          rollbackDetected: true,
        });
      }
    });
    const { value: outcome, failure } = await settle(() =>
      runCaptureAnalysis(requestA),
    );
    store.observeStatements(null);
    expect(rolledBack).toBe(true);
    expect(failure).toBeNull();
    expect(outcome?.kind).toBe('unavailable');
    expect({
      ...(await tickets(store, reading())),
      receipts: receiptRows(store).length,
      scoredShots: scoredShots(store),
    }).toEqual({ spendable: 2, consumed: 0, receipts: 0, scoredShots: 0 });
  });
});
