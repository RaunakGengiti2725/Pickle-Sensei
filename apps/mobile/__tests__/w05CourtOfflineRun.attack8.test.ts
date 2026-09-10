/**
 * W05-07 adversarial suite, round 8 (candidate 9702c7cf) — failure boundaries
 * the earlier rounds (attack, attack2, attack3, attack4, attack6, attack7,
 * Adversary) did not exercise. Every test names the invariant it expects the
 * candidate to hold; a failing test is a confirmed break of that invariant.
 *
 * Categories: E1 the drain answered 401/403 (an unauthorised session while
 * paid receipts are queued); E2 the wire entry checked against the SAME
 * shared-types validators the Edge route applies, plus the frozen output key
 * set; E3 one damaged APPLIED journal row behind a durably REFUSED receipt
 * (corrupt wallet state vs. the Result surface and vs. the next drain); E4
 * process restart with the cached release policy gone: the paid read must
 * replay, a new read must not score and must spend nothing; E5 presentation
 * bound boundary values (0, 1, NaN, negative) — every receipt presented
 * exactly once, all settled; E6 the server's accepted verdict names another
 * resultId (duplicate identity on the answer); E7 a drain that times out
 * after the server processed it (ambiguous commitment → same ids, one
 * settlement, no second spend); E8 owner B reuses owner A's operation id on
 * the same device (cross-account replay of a paid rating).
 */
import {
  OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
  OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
  OFFLINE_FREE_ALLOCATION_POLICY,
  OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION,
  OFFLINE_GRANT_AUDIENCE,
  OFFLINE_GRANT_JWS_TYPE,
  OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
  validateOfflineDeviceReceiptShape,
  validateOfflineSignedGrantShape,
} from '@pickle/shared-types';
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { CapturedClip } from '../src/camera/capture';
import {
  runCaptureAnalysis,
  type RunCaptureAnalysisRequest,
} from '../src/analysis/runCaptureAnalysis';
import {
  clearCachedReleasePolicy,
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
  API_REQUEST_TIMEOUT_MS,
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
import { originalCanonicalJson } from '../src/analysis/originalAnalysisSnapshot';
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
const OWNER_B = '22222222-2222-4222-8222-222222222222';
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
const ALLOCATION_A = 'dddddddd-0000-4000-8000-000000000001';
const ALLOCATION_B = 'dddddddd-0000-4000-8000-000000000002';
const TICKET_1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const TICKET_2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const TICKET_3 = 'aaaaaaaa-0000-4000-8000-000000000003';
const TICKET_4 = 'aaaaaaaa-0000-4000-8000-000000000004';
const GRANT_A2 = 'bbbbbbbb-0000-4000-8000-0000000000a2';
const ALLOCATION_A2 = 'dddddddd-0000-4000-8000-0000000000a2';
const TICKET_B1 = 'aaaaaaaa-0000-4000-8000-0000000000b1';
const TICKET_B2 = 'aaaaaaaa-0000-4000-8000-0000000000b2';
const ARTIFACT = { version: 'v1', sha256: 'a'.repeat(64) };
const PERMITS_ROUTE = `${API_ORIGIN}/v1/analysis-permits`;
const RECEIPTS_ROUTE = `${API_ORIGIN}/v1/offline/receipts`;
const NOW_MS = Date.now();
const ISSUED_AT = Math.floor(NOW_MS / 1000) - 60;
const EXPIRES_AT = ISSUED_AT + 6 * 24 * 60 * 60;
const BINDING = { installationKeyId: INSTALLATION_KEY, issuer: API_ORIGIN };
const originalFetch = globalThis.fetch;
let mockReadArtifact: (uri: string) => Promise<string>;

/** The frozen 1.0 `shot.sync` payload keys (`toSyncPayload`, src/data/sync.ts)
 * minus `analysisPermitId`, as the W05-07 objective defines the receipt's
 * `output`. */
const FROZEN_OUTPUT_KEYS = [
  'cameraView',
  'capturedAt',
  'checkpoints',
  'confidence',
  'id',
  'overallScore',
  'phases',
  'resultKind',
  'sessionId',
  'shotType',
  'source',
  'timestamps',
  'versionVector',
];

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

/** A second held free grant of owner A (a later allocation): two more
 * tickets so a third paid read can follow two settled ones. */
const GRANT_A_SECOND: GrantSpec = {
  grantId: GRANT_A2,
  generation: 1,
  allocationId: ALLOCATION_A2,
  ticketIds: [TICKET_3, TICKET_4],
};

const GRANT_B_TWO_TICKETS: GrantSpec = {
  grantId: GRANT_B,
  generation: 1,
  allocationId: ALLOCATION_B,
  ticketIds: [TICKET_B1, TICKET_B2],
};

function signIn(owner = OWNER, bearer = BEARER) {
  setActiveDataOwner(owner);
  establishApiSession({
    canonicalAppUserId: owner,
    apiBaseUrl: API_ORIGIN,
    bearerToken: bearer,
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
  readonly authorization: string | null;
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
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const call: FetchCall = {
        url,
        method: String(init?.method),
        body,
        authorization: headers['authorization'] ?? null,
      };
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
    clipA: a.clip,
    clipB: b.clip,
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

function offlineClient(token = BEARER) {
  return createOfflineGrantClient({ baseUrl: API_ORIGIN, token });
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

function journalRows(store: Store, owner = OWNER) {
  return store.native
    .prepare(
      `SELECT journal_id, state, receipt_ids, verdicts FROM offline_wallet_journal
       WHERE owner_key = ? ORDER BY rowid`,
    )
    .all(owner) as Array<{
    journal_id: string;
    state: string;
    receipt_ids: string;
    verdicts: string | null;
  }>;
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

function outboxRows(store: Store, owner = OWNER): number {
  return Number(
    store.native
      .prepare(
        `SELECT count(*) AS n FROM outbox WHERE owner_key = ? AND kind = 'shot.sync'`,
      )
      .get(owner)?.n,
  );
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

describe('E1 unauthorised: the drain is answered 401 / 403 while paid receipts are queued', () => {
  it.each([
    [401, 'auth.expired'],
    [403, 'auth.forbidden'],
  ])(
    'a %s answer settles nothing, refuses nothing, keeps the ticket consumed and the receipt re-presentable — then a fresh session settles it once',
    async (status, code) => {
      const { store, requestA } = await seed([GRANT_A_TWO_TICKETS]);
      const { analysis, receipt } = await scoredOffline(store, requestA);

      const denied = network({
        receipts: () =>
          response(status, { error: { code, message: 'denied' } }),
      });
      const { value, failure } = await settle(() =>
        reconcileOfflineWallet(store.db, offlineClient(), reading()),
      );
      expect(value).toBeNull();
      expect(failure).toBeInstanceOf(Error);
      expect((failure as { status?: number }).status).toBe(status);
      expect(receiptPosts(denied.calls)).toHaveLength(1);

      // Nothing about the wallet changed: the receipt is still pending, its
      // ticket still consumed (never auto-reclaimed), no refusal on file, and
      // the local shot is not marked delivered.
      const rows = receiptRows(store);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.settlement).toBeNull();
      expect(rows[0]!.settled_at).toBeNull();
      expect(await tickets(store, reading())).toEqual({
        spendable: 1,
        consumed: 1,
      });
      expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);
      // The presentation stays an unanswered HOLD — not a refusal, not
      // "queued, never sent".
      expect(await readOfflineReceiptEvidence(store.db, analysis.id)).toEqual({
        kind: 'held',
        answered: false,
      });
      const status1 = await readOfflineWalletStatus(store.db);
      expect(status1.hold).toBe(true);
      expect(status1.pending[0]?.phase).toBe('presented_unanswered');

      // The next drain (after re-authentication) presents the SAME receipt
      // and settles it exactly once.
      const accepted = network({ receipts: acceptAll() });
      const settled = await reconcileOfflineWallet(
        store.db,
        offlineClient('rotated-owner-token'),
        reading(),
      );
      expect(settled.accepted).toBe(1);
      expect(settled.recovered).toBe(1);
      const posts = receiptPosts(accepted.calls);
      expect(posts).toHaveLength(1);
      expect(presentedIds(posts[0]!)).toEqual([receipt.receiptId]);
      expect(posts[0]!.authorization).toBe('Bearer rotated-owner-token');
      expect(receiptRows(store)[0]!.settlement).toBe('accepted');
      expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(true);
      expect(await tickets(store, reading())).toEqual({
        spendable: 1,
        consumed: 1,
      });
      expect(journalRows(store).map(row => row.state)).toEqual([
        'superseded',
        'applied',
      ]);
    },
  );
});

describe('E2 wire contract: the drained entry must pass the Edge route validators and carry exactly the frozen output', () => {
  it('receipt and grant validate with the shared-types validators the route uses; output is the frozen 1.0 shot payload minus analysisPermitId and its canonical digest equals fullOutputSha256', async () => {
    const { store, requestA } = await seed([GRANT_A_TWO_TICKETS]);
    const { analysis, receipt } = await scoredOffline(store, requestA);
    const { calls } = network({ receipts: acceptAll() });
    await reconcileOfflineWallet(store.db, offlineClient(), reading());
    const posts = receiptPosts(calls);
    expect(posts).toHaveLength(1);
    const entries = presentedEntries(posts[0]!);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    // The 1.0 entry carries `receipt`, `grant` and `output`; the flat copy
    // of the receipt beside them (pre-1.0 readers) must agree with `receipt`.
    expect(Object.keys(entry)).toEqual(
      expect.arrayContaining(['grant', 'output', 'receipt']),
    );
    const {
      grant: _grant,
      output: _output,
      receipt: _receipt,
      ...flat
    } = entry;
    expect(flat).toEqual(entry.receipt);

    const wireReceipt = validateOfflineDeviceReceiptShape(entry.receipt);
    expect(wireReceipt.ok).toBe(true);
    if (!wireReceipt.ok) return;
    expect(wireReceipt.value.receiptId).toBe(receipt.receiptId);
    expect(wireReceipt.value.operationId).toBe(OPERATION);
    expect(wireReceipt.value.resultId).toBe(analysis.id);
    expect(wireReceipt.value.grantId).toBe(GRANT_A);
    expect(wireReceipt.value.ticket?.ticketId).toBe(
      ticketFor(receipt).ticketId,
    );

    const wireGrant = validateOfflineSignedGrantShape(entry.grant);
    expect(wireGrant.ok).toBe(true);
    if (!wireGrant.ok) return;
    expect(wireGrant.value.schemaVersion).toBe(
      OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
    );
    expect(wireGrant.value.compactJws).toBe(
      grantCompactJws(OWNER, GRANT_A_TWO_TICKETS),
    );

    const output = entry.output as Record<string, unknown>;
    expect(output).not.toBeNull();
    expect('analysisPermitId' in output).toBe(false);
    expect(Object.keys(output).sort()).toEqual(FROZEN_OUTPUT_KEYS);
    expect(output.id).toBe(analysis.id);
    expect(output.resultKind).toBe('scored');
    expect(output.overallScore).toBe(analysis.overallScore);
    expect(sha256Hex(originalCanonicalJson(output))).toBe(
      wireReceipt.value.fullOutputSha256,
    );
    // Nothing the server could not have derived from the receipt: no
    // analysis permit, no ticket state, no local-only fields.
    expect(JSON.stringify(entry)).not.toContain('offline-receipt');
  });
});

describe('E3 corrupt wallet state: one damaged APPLIED journal row behind a durably REFUSED receipt', () => {
  /** First read refused (journal row 1 applied), second read accepted
   * (journal row 2 applied), then row 2's verdicts column is truncated
   * mid-JSON — storage damage on a HISTORY row that names neither the
   * refused receipt nor anything pending. */
  async function damagedHistory() {
    const seeded = await seed([GRANT_A_TWO_TICKETS, GRANT_A_SECOND]);
    const { store, requestA, requestB } = seeded;
    const first = await scoredOffline(store, requestA);
    network({ receipts: refuseAll('offline.receipt_conflict') });
    const refused = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
    );
    expect(refused.refused).toBe(1);
    expect(receiptRows(store)[0]!.settlement).toBe('refused');
    expect(
      await readOfflineReceiptEvidence(store.db, first.analysis.id),
    ).toEqual({ kind: 'refused', code: 'offline.receipt_conflict' });

    const second = await scoredOffline(store, requestB);
    network({ receipts: acceptAll() });
    await reconcileOfflineWallet(store.db, offlineClient(), reading());
    const applied = journalRows(store);
    expect(applied.map(row => row.state)).toEqual(['applied', 'applied']);
    expect(JSON.parse(applied[1]!.receipt_ids)).toEqual([
      second.receipt.receiptId,
    ]);
    store.native
      .prepare(
        `UPDATE offline_wallet_journal SET verdicts = substr(verdicts, 1, 12)
         WHERE journal_id = ?`,
      )
      .run(applied[1]!.journal_id);
    return { ...seeded, first, second };
  }

  it('the Result surface still names the durably REFUSED receipt as refused (code may be unknown), never "could not verify"', async () => {
    const { store, first } = await damagedHistory();
    // Invariant under attack: the refusal is durable in the offline_receipt
    // row itself (settlement = refused). ResultScreen maps a throwing
    // evidence read to the outbox, and a court-offline read has no outbox
    // row → `unknown` ("could not verify") for a read the server REFUSED.
    const evidence = await settle(() =>
      readOfflineReceiptEvidence(store.db, first.analysis.id),
    );
    expect(evidence.failure).toBeNull();
    expect(evidence.value?.kind).toBe('refused');
  });

  it('the wallet status the allocation card reads stays readable (the damaged row is history, not a pending presentation)', async () => {
    const { store } = await damagedHistory();
    const status = await settle(() => readOfflineWalletStatus(store.db));
    expect(status.failure).toBeNull();
    expect(status.value?.hold).toBe(false);
    expect(status.value?.pending).toEqual([]);

    // The error text demands "reconciliation"; the drain IS the wallet's
    // reconciliation, so after it the status must be readable.
    network({ receipts: acceptAll() });
    await reconcileOfflineWallet(store.db, offlineClient(), reading());
    const after = await settle(() => readOfflineWalletStatus(store.db));
    expect(after.failure).toBeNull();
  });

  it('a later paid read still drains and settles despite the damaged history row', async () => {
    const { store, requestB, second } = await damagedHistory();
    expect(await tickets(store, reading())).toEqual({
      spendable: 2,
      consumed: 2,
    });
    const third = await scoredOffline(
      store,
      request(
        store,
        requestB.clip,
        '44444444-4444-4444-8444-444444444446',
        CAPTURE_B,
      ),
    );
    const { calls } = network({ receipts: acceptAll() });
    const drained = await settle(() =>
      reconcileOfflineWallet(store.db, offlineClient(), reading()),
    );
    expect(drained.failure).toBeNull();
    expect(drained.value?.accepted).toBe(1);
    expect(presentedIds(receiptPosts(calls)[0]!)).toEqual([
      third.receipt.receiptId,
    ]);
    expect(await hasShotSyncReceipt(store.db, third.analysis.id)).toBe(true);
    expect(second.receipt.receiptId).not.toBe(third.receipt.receiptId);
  });
});

describe('E4 process restart: the cached release policy is gone by the time the app relaunches', () => {
  it('the paid read replays as the durable rating without a policy; a NEW read without a policy is an honest no-score that spends nothing', async () => {
    const { store, requestA, requestB } = await seed([GRANT_A_TWO_TICKETS]);
    const { analysis } = await scoredOffline(store, requestA);
    expect(await tickets(store, reading())).toEqual({
      spendable: 1,
      consumed: 1,
    });

    // Relaunch: the policy cache was cleared (cache lifetime ran out and the
    // court is still offline), the run is re-issued with the same operation.
    await clearCachedReleasePolicy(store.db, {
      ownerKey: OWNER,
      apiOrigin: API_ORIGIN,
    });
    network();
    const replay = await runCaptureAnalysis(requestA);
    expect(replay.kind).toBe('scored');
    if (replay.kind !== 'scored') return;
    expect(replay.record.result?.id).toBe(analysis.id);
    expect(replay.record.result?.overallScore).toBe(analysis.overallScore);
    // Replayed: nothing spent twice, no second receipt, no outbox row.
    expect(await tickets(store, reading())).toEqual({
      spendable: 1,
      consumed: 1,
    });
    expect(receiptRows(store)).toHaveLength(1);
    expect(scoredShots(store)).toBe(1);
    expect(outboxRows(store)).toBe(0);

    // A NEW read without a cached policy must not produce a numeric score
    // and must not touch the wallet.
    const fresh = await runCaptureAnalysis(requestB);
    expect(fresh.kind).not.toBe('scored');
    expect(await tickets(store, reading())).toEqual({
      spendable: 1,
      consumed: 1,
    });
    expect(receiptRows(store)).toHaveLength(1);
    expect(scoredShots(store)).toBe(1);
  });
});

describe('E5 boundary values: the presentation bound at 0, 1, NaN and negative', () => {
  it.each([[0], [1], [Number.NaN], [-1]])(
    'presentationMaxChars=%p — every pending receipt is presented exactly once and settled, no receipt is dropped and none is presented twice',
    async maxChars => {
      const { store, requestA, requestB } = await seed([GRANT_A_TWO_TICKETS]);
      const first = await scoredOffline(store, requestA);
      const second = await scoredOffline(store, requestB);
      expect(await tickets(store, reading())).toEqual({
        spendable: 0,
        consumed: 2,
      });
      const { calls } = network({ receipts: acceptAll() });
      const settled = await reconcileOfflineWallet(
        store.db,
        offlineClient(),
        reading(),
        { presentationMaxChars: maxChars },
      );
      expect(settled).toMatchObject({
        submitted: 2,
        accepted: 2,
        pending: 0,
        stale: 0,
      });
      const presented = receiptPosts(calls).flatMap(presentedIds);
      expect(presented.sort()).toEqual(
        [first.receipt.receiptId, second.receipt.receiptId].sort(),
      );
      expect(new Set(presented).size).toBe(2);
      expect(receiptRows(store).map(row => row.settlement)).toEqual([
        'accepted',
        'accepted',
      ]);
      expect(await hasShotSyncReceipt(store.db, first.analysis.id)).toBe(true);
      expect(await hasShotSyncReceipt(store.db, second.analysis.id)).toBe(true);
      expect(journalRows(store).every(row => row.state === 'applied')).toBe(
        true,
      );
    },
  );
});

describe('E6 duplicate identity on the answer: the accepted verdict names another resultId', () => {
  it('only the shot the receipt names is marked delivered; the other paid read stays pending', async () => {
    const { store, requestA, requestB } = await seed([GRANT_A_TWO_TICKETS]);
    const first = await scoredOffline(store, requestA);
    const second = await scoredOffline(store, requestB);
    // Present only the first receipt; the server "accepts" it but claims it
    // recorded the SECOND result.
    const { calls } = network({
      receipts: call =>
        response(200, {
          receipts: presentedIds(call).map(receiptId => ({
            receiptId,
            status: 'result_recorded',
            resultId: second.analysis.id,
            financialDisposition: 'consumed',
          })),
          rejected: [],
        }),
    });
    const settled = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
      {
        presentationMaxChars: 1,
      },
    );
    expect(settled.submitted).toBe(2);
    expect(receiptPosts(calls)).toHaveLength(2);
    // Whatever the server claimed, the local ledger follows the receipts
    // this device presented: each accepted receipt marks ITS OWN result.
    expect(await hasShotSyncReceipt(store.db, first.analysis.id)).toBe(true);
    expect(await hasShotSyncReceipt(store.db, second.analysis.id)).toBe(true);
    expect(receiptRows(store).map(row => row.settlement)).toEqual([
      'accepted',
      'accepted',
    ]);
    expect(first.receipt.receiptId).not.toBe(second.receipt.receiptId);
  });
});

describe('E7 network failure: the drain times out after the server processed the batch', () => {
  it('the receipt stays an unanswered HOLD; the next drain re-presents the same id, the server replay settles it once and the ticket is spent exactly once', async () => {
    const { store, requestA } = await seed([GRANT_A_TWO_TICKETS]);
    const { analysis, receipt } = await scoredOffline(store, requestA);

    jest.useFakeTimers();
    const serverSaw: string[][] = [];
    const hung = network({
      receipts: call => {
        serverSaw.push(presentedIds(call));
        // The server handles the batch but the answer never reaches the
        // device before the client deadline.
        return new Promise<Response>(() => {});
      },
    });
    const drain = settle(() =>
      reconcileOfflineWallet(store.db, offlineClient(), reading()),
    );
    await jest.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS + 1);
    const { value, failure } = await drain;
    jest.useRealTimers();
    expect(value).toBeNull();
    expect((failure as { code?: string }).code).toBe('network.timeout');
    expect(receiptPosts(hung.calls)).toHaveLength(1);
    expect(serverSaw).toEqual([[receipt.receiptId]]);

    // The commitment is ambiguous: HOLD, not refund, not a new operation.
    expect(receiptRows(store)[0]!.settlement).toBeNull();
    expect(await readOfflineReceiptEvidence(store.db, analysis.id)).toEqual({
      kind: 'held',
      answered: false,
    });
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);
    expect(await tickets(store, reading())).toEqual({
      spendable: 1,
      consumed: 1,
    });

    // Reconnect: the same receipt id is re-presented and the server's
    // idempotent replay answers accepted.
    const replay = network({ receipts: acceptAll() });
    const settled = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
    );
    expect(settled).toMatchObject({ accepted: 1, recovered: 1, pending: 0 });
    expect(presentedIds(receiptPosts(replay.calls)[0]!)).toEqual([
      receipt.receiptId,
    ]);
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(true);
    expect(await tickets(store, reading())).toEqual({
      spendable: 1,
      consumed: 1,
    });
    expect(receiptRows(store)).toHaveLength(1);
  });
});

describe('E8 cross-account: owner B reuses owner A’s operation id on the same device', () => {
  it('B never sees A’s paid rating, never spends A’s ticket, and A’s receipt/shot stay A’s', async () => {
    const { store, requestA, clipA } = await seed([GRANT_A_TWO_TICKETS]);
    const a = await scoredOffline(store, requestA);
    expect(await tickets(store, reading())).toEqual({
      spendable: 1,
      consumed: 1,
    });

    // Owner B signs in on the same phone with their own held grant and a
    // cached policy, and issues a run under the SAME operation id and the
    // same capture id (a device-local id collision).
    signIn(OWNER_B, 'owner-b-token');
    seedSqliteCapture(store.db, OWNER_B, CAPTURE, clipA);
    await cachePolicy(store, OWNER_B);
    await holdOfflineGrant(
      store.db,
      issuedGrant(GRANT_B_TWO_TICKETS, OWNER_B),
      BINDING,
    );
    network();
    const b = await runCaptureAnalysis({
      ...request(store, clipA),
      apiConfig: { baseUrl: API_ORIGIN, token: 'owner-b-token' },
    });
    // B's outcome is B's own: either a fresh scored read paid by B's grant
    // or an honest non-scored outcome — never A's analysis.
    if (b.kind === 'scored') {
      expect(b.record.result?.id).not.toBe(a.analysis.id);
      const bReceipts = receiptRows(store, OWNER_B);
      expect(bReceipts).toHaveLength(1);
      expect(bReceipts[0]!.grant_id).toBe(GRANT_B);
      expect(await tickets(store, reading())).toEqual({
        spendable: 1,
        consumed: 1,
      });
    } else {
      expect(receiptRows(store, OWNER_B)).toHaveLength(0);
      expect(await tickets(store, reading())).toEqual({
        spendable: 2,
        consumed: 0,
      });
    }
    // A's wallet is untouched by B's run.
    const aRows = receiptRows(store, OWNER);
    expect(aRows).toHaveLength(1);
    expect(aRows[0]!.receipt_id).toBe(a.receipt.receiptId);
    expect(aRows[0]!.settlement).toBeNull();
    expect(scoredShots(store, OWNER)).toBe(1);
    // B cannot read A's receipt evidence for A's result.
    expect(
      await readOfflineReceiptEvidence(store.db, a.analysis.id),
    ).toBeNull();

    // B's drain presents only B's receipts.
    const { calls } = network({ receipts: acceptAll() });
    await reconcileOfflineWallet(
      store.db,
      offlineClient('owner-b-token'),
      reading(),
    );
    for (const post of receiptPosts(calls)) {
      expect(presentedIds(post)).not.toContain(a.receipt.receiptId);
    }
    expect(receiptRows(store, OWNER)[0]!.settlement).toBeNull();
  });
});
