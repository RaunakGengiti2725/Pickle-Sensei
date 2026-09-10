/**
 * W05-07 adversarial suite — the court-offline scored read at its failure
 * boundaries (candidate 75e512e8).
 *
 * Every test here is an attack on an invariant the package declares: a
 * connectivity-only offline classification, exactly-once consumption, the
 * receipt carrying the exact grant + output, owner isolation, honest
 * behaviour under corrupt state and process death. The candidate's own suite
 * (w05CourtOfflineRun.test.ts) covers the happy paths; nothing here
 * duplicates them.
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
  clearSyncRuntime,
  configureSyncRuntime,
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
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
const CAPTURE = '33333333-3333-4333-8333-333333333333';
const OPERATION = '44444444-4444-4444-8444-444444444444';
const CAPTURE_2 = '33333333-3333-4333-8333-333333333334';
const OPERATION_2 = '44444444-4444-4444-8444-444444444445';
const CAPTURE_3 = '33333333-3333-4333-8333-333333333335';
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

/** Copy the store dossier forbids in user-facing text (APP_STORE_SUBMISSION.md). */
const FORBIDDEN_COPY =
  /android|google play|guest mode|live court|dupr|swingvision|pb vision|selkirk|joola|\d+\s*%|most accurate|best-in-class|world.class|ai coach/i;

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

function grantCompactJws(owner = OWNER, grantId = GRANT_ID): string {
  const claims = {
    schemaVersion: OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
    protocolVersion: OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
    iss: API_ORIGIN,
    aud: OFFLINE_GRANT_AUDIENCE,
    sub: owner,
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

function issuedGrant(owner = OWNER, grantId = GRANT_ID): IssuedOfflineGrant {
  const parsed = parseIssuedOfflineGrant({
    grantId,
    generation: 1,
    entitlementSource: 'identity_lifetime_free',
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    entitlementExpiresAt: null,
    ticketIds: TICKETS,
    keyId: KEY_ID,
    grant: {
      schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
      compactJws: grantCompactJws(owner, grantId),
    },
  });
  if (!parsed) throw new Error('fixture grant response must parse');
  return parsed;
}

function signIn(owner = OWNER, bearer = BEARER) {
  clearApiSession();
  setActiveDataOwner(owner);
  establishApiSession({
    canonicalAppUserId: owner,
    apiBaseUrl: API_ORIGIN,
    bearerToken: bearer,
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

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status < 400,
    status,
    statusText: String(status),
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response;
}

interface FetchCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

type RouteAnswer = Response | Error;

interface ServiceBehaviour {
  /** Answer to POST /v1/analysis-permits (a thrown Error = never left). */
  permit?: (call: FetchCall) => RouteAnswer;
  /** Answer to POST /v1/offline/receipts; default accepts every receipt. */
  receipts?: (call: FetchCall, attempt: number) => RouteAnswer;
  /** When false the release-policy read also fails to leave the device. */
  reachable?: boolean;
}

function acceptedReceipts(call: FetchCall): Response {
  const receipts = (call.body.receipts ?? []) as Array<Record<string, unknown>>;
  return response(200, {
    receipts: receipts.map(entry => ({
      receiptId: (entry.receipt as Record<string, unknown>).receiptId,
      status: 'result_recorded',
    })),
    rejected: [],
  });
}

function reservedPermit(): Response {
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

/** A programmable rating service. */
function service(behaviour: ServiceBehaviour) {
  const calls: FetchCall[] = [];
  let receiptAttempts = 0;
  const reachable = behaviour.reachable ?? true;
  const fetchPort = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<
        string,
        unknown
      >;
      const call = { url, body };
      calls.push(call);
      if (!reachable) throw new TypeError('Network request failed');
      if (isReleasePolicyRequest(url))
        return response(200, activeReleaseAuthority());
      let answer: RouteAnswer;
      if (url === PERMITS_ROUTE) {
        answer = behaviour.permit
          ? behaviour.permit(call)
          : new TypeError('Network request failed');
      } else if (url === RECEIPTS_ROUTE) {
        receiptAttempts += 1;
        answer = behaviour.receipts
          ? behaviour.receipts(call, receiptAttempts)
          : acceptedReceipts(call);
      } else if (
        url.startsWith(`${PERMITS_ROUTE}/`) &&
        url.endsWith('/finalize')
      ) {
        answer = response(200, {
          permit: {
            id: decodeURIComponent(
              url.slice(PERMITS_ROUTE.length + 1, -'/finalize'.length),
            ),
            status: 'released',
            outcome: body.outcome,
          },
          access: null,
        });
      } else {
        answer = response(404, { error: { code: 'not_found' } });
      }
      if (answer instanceof Error) throw answer;
      return answer;
    },
  );
  globalThis.fetch = fetchPort as unknown as typeof fetch;
  return {
    calls,
    permitPosts: () => calls.filter(call => call.url === PERMITS_ROUTE),
    receiptPosts: () => calls.filter(call => call.url === RECEIPTS_ROUTE),
    finalizePosts: () =>
      calls.filter(
        call =>
          call.url.startsWith(`${PERMITS_ROUTE}/`) &&
          call.url.endsWith('/finalize'),
      ),
  };
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

interface Court {
  store: Store;
  request: RunCaptureAnalysisRequest;
  second: RunCaptureAnalysisRequest;
  third: RunCaptureAnalysisRequest;
}

/** A signed-in owner with three distinct captures, a cached active release
 * policy and one held two-ticket grant (unless disabled). */
async function court(options: {
  policy?: boolean;
  grant?: boolean;
  visibility?: number | null;
  store?: Store;
  owner?: string;
}): Promise<Court> {
  const store = options.store ?? createSqliteTestDb();
  const owner = options.owner ?? OWNER;
  const first = fixture(options.visibility ?? null, `court-${owner}-1`);
  const second = fixture(options.visibility ?? null, `court-${owner}-2`);
  const third = fixture(options.visibility ?? null, `court-${owner}-3`);
  const sidecars = new Map<string, string>([
    [first.clip.poseSequence!.uri, first.sidecar],
    [second.clip.poseSequence!.uri, second.sidecar],
    [third.clip.poseSequence!.uri, third.sidecar],
  ]);
  const previous = mockReadArtifact;
  mockReadArtifact = async (uri: string) =>
    sidecars.get(uri) ?? (previous ? previous(uri) : first.sidecar);
  seedSqliteCapture(store.db, owner, CAPTURE, first.clip);
  seedSqliteCapture(store.db, owner, CAPTURE_2, second.clip);
  seedSqliteCapture(store.db, owner, CAPTURE_3, third.clip);
  mockReading = reading();
  if (options.policy ?? true) await cachePolicy(store, owner);
  if (options.grant ?? true)
    await holdOfflineGrant(store.db, issuedGrant(owner), BINDING);
  const request: RunCaptureAnalysisRequest = {
    db: store.db,
    ownerContext: captureDataOwnerContext(),
    operationId: OPERATION,
    captureId: CAPTURE,
    clip: first.clip,
    declaredStroke: 'forehand_drive',
    declaredCanonical: 'FOREHAND_DRIVE',
    handedness: 'right',
    cameraView: 'side',
    apiConfig: { baseUrl: API_ORIGIN, token: BEARER },
    appVersion: '0.1.0',
  };
  return {
    store,
    request,
    second: {
      ...request,
      operationId: OPERATION_2,
      captureId: CAPTURE_2,
      clip: second.clip,
    },
    third: {
      ...request,
      operationId: OPERATION_3,
      captureId: CAPTURE_3,
      clip: third.clip,
    },
  };
}

async function tickets(store: Store) {
  const allocation = await readOfflineAllocation(store.db, reading());
  return {
    spendable: allocation.spendableTickets,
    consumed: allocation.consumedTickets,
  };
}

function outboxKinds(store: Store, owner = OWNER): string[] {
  return store.native
    .prepare(`SELECT kind FROM outbox WHERE owner_key = ? ORDER BY kind`)
    .all(owner)
    .map(row => String(row.kind));
}

function receiptRows(store: Store, owner = OWNER) {
  return store.native
    .prepare(
      `SELECT receipt_id, operation_id, settlement, settled_at
       FROM offline_receipt WHERE owner_key = ?`,
    )
    .all(owner);
}

function ticketRows(store: Store, owner = OWNER) {
  return store.native
    .prepare(
      `SELECT ticket_id, state, receipt_id FROM offline_ticket
       WHERE owner_key = ? ORDER BY ticket_id`,
    )
    .all(owner);
}

/** The untouched wallet: two spendable tickets, nothing consumed, no receipt,
 * no shot and no outbox row for the owner. */
async function expectNothingSpent(store: Store, owner = OWNER) {
  expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
  expect(receiptRows(store, owner)).toEqual([]);
  expect(store.count('local_shot', owner)).toBe(0);
  expect(outboxKinds(store, owner)).toEqual([]);
}

function client(bearer = BEARER) {
  return createOfflineGrantClient({ baseUrl: API_ORIGIN, token: bearer });
}

async function scoredOffline(request: RunCaptureAnalysisRequest) {
  const outcome = await runCaptureAnalysis(request);
  expect(outcome.kind).toBe('scored');
  if (outcome.kind !== 'scored' || !outcome.record.result)
    throw new Error('fixture: the offline run must score');
  return outcome.record.result;
}

async function sweep(store: Store, behaviour: ServiceBehaviour) {
  const online = service(behaviour);
  (getDb as jest.Mock).mockReturnValue(store.db);
  configureSyncRuntime({
    apiBaseUrl: API_ORIGIN,
    bearerToken: BEARER,
    canonicalAppUserId: OWNER,
    provider: 'apple',
  });
  await triggerOutboxSync();
  return online;
}

beforeEach(() => {
  signIn();
});
afterEach(() => {
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  globalThis.fetch = originalFetch;
  mockReading = null;
  (getDb as jest.Mock).mockReset();
  jest.restoreAllMocks();
  closeSqliteTestDatabases();
});

// ── Attack 1: server-answered reservations that are NOT connectivity ─────────

describe('attack 1 — a reservation the service ANSWERED is never an offline case', () => {
  const answered: Array<[string, () => Response]> = [
    [
      '200 with a permit the client cannot parse (unknown accessSource)',
      () =>
        response(200, {
          permit: {
            id: LIVE_PERMIT_ID,
            accessSource: 'trial',
            status: 'reserved',
            expiresAt: new Date(NOW_MS + 15 * 60_000).toISOString(),
          },
          access: null,
        }),
    ],
    [
      '200 with a permit whose expiresAt is not a string',
      () =>
        response(200, {
          permit: {
            id: LIVE_PERMIT_ID,
            accessSource: 'free',
            status: 'reserved',
            expiresAt: NOW_MS + 15 * 60_000,
          },
          access: null,
        }),
    ],
    [
      '200 JSON object without a permit at all',
      () => response(200, { access: null }),
    ],
  ];

  it.each(answered)(
    '%s → no offline score, nothing spent',
    async (_label, answer) => {
      const { store, request } = await court({});
      const net = service({ permit: () => answer() });

      const outcome = await runCaptureAnalysis(request);

      expect(net.permitPosts()).toHaveLength(1);
      expect(outcome.kind).not.toBe('scored');
      await expectNothingSpent(store);
    },
  );
});

// ── Attack 1b: a 5xx the route itself answered ────────────────────────────────────

describe('attack 1b — a coded 5xx from the rating service is a service answer, not lost connectivity', () => {
  const answered: Array<[string, () => Response]> = [
    [
      '500 with the API error envelope (the route answered)',
      () =>
        response(500, {
          error: { code: 'internal_error', message: 'Something went wrong.' },
        }),
    ],
    [
      '503 with the API error envelope (the route answered)',
      () =>
        response(503, {
          error: {
            code: 'service_unavailable',
            message: 'The rating service is temporarily unavailable.',
          },
        }),
    ],
  ];

  it.each(answered)(
    '%s → no offline score, nothing spent',
    async (_label, answer) => {
      const { store, request } = await court({});
      const net = service({ permit: () => answer() });

      const outcome = await runCaptureAnalysis(request);

      expect(net.permitPosts()).toHaveLength(1);
      expect(outcome.kind).not.toBe('scored');
      await expectNothingSpent(store);
    },
  );
});

// ── Attack 1c: an intermediary page (captive portal) ──────────────────────────────

describe('attack 1c — a 404 page without the API envelope', () => {
  it('whatever the classification, accounting is exactly-once and a replay spends nothing more', async () => {
    const { store, request } = await court({});
    const net = service({
      permit: () => response(404, '<html>not found</html>'),
    });
    const outcome = await runCaptureAnalysis(request);
    expect(net.permitPosts()).toHaveLength(1);
    const spent = await tickets(store);
    expect(spent.consumed).toBe(outcome.kind === 'scored' ? 1 : 0);
    expect(receiptRows(store)).toHaveLength(spent.consumed);
    expect(store.count('local_shot', OWNER)).toBe(spent.consumed);
    expect(outboxKinds(store)).toEqual([]);

    const replay = await runCaptureAnalysis(request);
    expect(replay.kind).toBe(outcome.kind);
    expect(await tickets(store)).toEqual(spent);
    expect(receiptRows(store)).toHaveLength(spent.consumed);
  });
});

// ── Attack 2: explicit server refusals / throttles stay online verdicts ──────

describe('attack 2 — refusals, throttles and consumed permits spend nothing', () => {
  const refusals: Array<[string, () => Response]> = [
    [
      '429 + Retry-After',
      () =>
        response(
          429,
          {
            error: {
              code: 'rate_limit.exceeded',
              message: 'Too many requests. Try again shortly.',
            },
          },
          { 'retry-after': '30' },
        ),
    ],
    [
      '401 auth.required',
      () =>
        response(401, {
          error: { code: 'auth.required', message: 'Sign in again.' },
        }),
    ],
    [
      '403 access.forbidden',
      () =>
        response(403, {
          error: { code: 'access.forbidden', message: 'Not allowed.' },
        }),
    ],
    [
      '402 access.paywall_required',
      () =>
        response(402, {
          error: {
            code: 'access.paywall_required',
            message: 'Your free ratings are used. Upgrade to keep rating.',
          },
        }),
    ],
    [
      '200 with a permit the service already CONSUMED',
      () =>
        response(200, {
          permit: {
            id: LIVE_PERMIT_ID,
            accessSource: 'free',
            status: 'consumed',
            expiresAt: new Date(NOW_MS + 15 * 60_000).toISOString(),
          },
          access: null,
        }),
    ],
  ];

  it.each(refusals)(
    '%s → no offline score, nothing spent, no receipt',
    async (_label, answer) => {
      const { store, request } = await court({});
      service({ permit: () => answer() });

      const outcome = await runCaptureAnalysis(request);

      expect(outcome.kind).not.toBe('scored');
      if (outcome.kind === 'unavailable')
        expect(outcome.reason).not.toMatch(FORBIDDEN_COPY);
      const spent = await tickets(store);
      expect(spent.consumed).toBe(receiptRows(store).length);
      expect(spent.consumed).toBe(store.count('local_shot', OWNER));
      expect(outboxKinds(store)).toEqual([]);
    },
  );

  it('a 429 reservation never scores offline (throttle is a server verdict)', async () => {
    const { store, request } = await court({});
    service({
      permit: () =>
        response(
          429,
          { error: { code: 'rate_limit.exceeded', message: 'Slow down.' } },
          { 'retry-after': '30' },
        ),
    });
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).toBe('unavailable');
    await expectNothingSpent(store);
  });
});

// ── Attack 3: concurrency — the same operation submitted twice at once ───────

describe('attack 3 — double submit of one operation while offline', () => {
  it('two concurrent runs of the same operation spend exactly one ticket and persist one shot', async () => {
    const { store, request } = await court({});
    service({ reachable: false });

    const [first, second] = await Promise.all([
      runCaptureAnalysis(request),
      runCaptureAnalysis(request),
    ]);

    const kinds = [first.kind, second.kind].sort();
    expect(kinds).toContain('scored');
    for (const outcome of [first, second]) {
      expect(['scored', 'unavailable']).toContain(outcome.kind);
      if (outcome.kind === 'unavailable')
        expect(outcome.cause).toBe('recovery_pending');
    }
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(receiptRows(store)).toHaveLength(1);
    expect(store.count('local_shot', OWNER)).toBe(1);
    expect(outboxKinds(store)).toEqual([]);

    // A follow-up run of the same operation replays, spending nothing more.
    const replay = await runCaptureAnalysis(request);
    expect(replay.kind).toBe('scored');
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(receiptRows(store)).toHaveLength(1);
  });

  it('two distinct captures in parallel spend two tickets; a third is the honest exhausted outcome with store-compliant copy', async () => {
    const { store, request, second, third } = await court({});
    service({ reachable: false });

    const [a, b] = await Promise.all([
      runCaptureAnalysis(request),
      runCaptureAnalysis(second),
    ]);
    expect(a.kind).toBe('scored');
    expect(b.kind).toBe('scored');
    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 2 });
    expect(receiptRows(store)).toHaveLength(2);

    const c = await runCaptureAnalysis(third);
    expect(c.kind).toBe('unavailable');
    if (c.kind !== 'unavailable') return;
    expect(c.reason).not.toMatch(FORBIDDEN_COPY);
    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 2 });
    expect(receiptRows(store)).toHaveLength(2);
    expect(store.count('local_shot', OWNER)).toBe(2);
  });
});

// ── Attack 4: trusted-time boundaries ───────────────────────────────────────

describe('attack 4 — clock boundaries authorize nothing', () => {
  const readings: Array<[string, TrustedTimeReading]> = [
    ['clock rollback detected', { ...reading(), rollbackDetected: true }],
    [
      'floor-only authority (unmeasured interval)',
      { ...reading(), authority: 'floor', continuity: 'unmeasured' },
    ],
    [
      'no trusted time at all',
      { ...reading(), authority: 'none', continuity: 'none', storage: 'empty' },
    ],
    ['exactly at grant expiry', reading(EXPIRES_AT * 1000)],
    ['one day past grant expiry', reading((EXPIRES_AT + 86_400) * 1000)],
    ['far future (400 days)', reading(NOW_MS + 400 * 86_400_000)],
    [
      'trusted clock a day BEFORE the grant was issued',
      reading((ISSUED_AT - 86_400) * 1000),
    ],
    ['negative epoch', reading(-1)],
  ];

  it.each(readings)('%s → honest no-score, nothing spent', async (_l, at) => {
    const { store, request } = await court({});
    mockReading = at;
    service({ reachable: false });

    const outcome = await runCaptureAnalysis(request);

    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind === 'unavailable')
      expect(outcome.reason).not.toMatch(FORBIDDEN_COPY);
    mockReading = reading();
    await expectNothingSpent(store);
  });

  it('a NaN trusted reading never becomes a scored read or a spent ticket', async () => {
    const { store, request } = await court({});
    mockReading = { ...reading(), nowMs: Number.NaN };
    service({ reachable: false });

    let outcome: RunCaptureAnalysisOutcome | null = null;
    try {
      outcome = await runCaptureAnalysis(request);
    } catch {
      outcome = null;
    }

    if (outcome !== null) expect(outcome.kind).not.toBe('scored');
    mockReading = reading();
    await expectNothingSpent(store);
  });

  it('a reading one millisecond before grant expiry still spends exactly one ticket (control)', async () => {
    const { store, request } = await court({});
    // The cached policy was written at NOW; a reading inside the grant's
    // lease but past the policy cache lifetime must also be a no-score.
    mockReading = reading(EXPIRES_AT * 1000 - 1);
    service({ reachable: false });
    const outcome = await runCaptureAnalysis(request);
    mockReading = reading();
    const spent = await tickets(store);
    if (outcome.kind === 'scored') {
      expect(spent).toEqual({ spendable: 1, consumed: 1 });
      expect(receiptRows(store)).toHaveLength(1);
    } else {
      expect(outcome.kind).toBe('unavailable');
      await expectNothingSpent(store);
    }
  });
});

// ── Attack 5: account switch between the grant check and the spend ──────────

describe('attack 5 — the signed-in account changes inside the offline commit', () => {
  it('a switch after the ticket UPDATE rolls the whole spend back; neither account pays', async () => {
    const { store, request: seeded } = await court({});
    // The other account holds its own grant on this device.
    signIn(OTHER_OWNER, OTHER_BEARER);
    await holdOfflineGrant(
      store.db,
      issuedGrant(OTHER_OWNER, 'bbbbbbbb-0000-4000-8000-000000000002'),
      BINDING,
    );
    signIn();
    const request = { ...seeded, ownerContext: captureDataOwnerContext() };
    service({ reachable: false });

    let switched = false;
    store.observeStatements(call => {
      if (!switched && call.sql.includes(`UPDATE offline_ticket SET state`)) {
        switched = true;
        setActiveDataOwner(OTHER_OWNER);
      }
    });

    const outcome = await runCaptureAnalysis(request);
    store.observeStatements(null);
    expect(switched).toBe(true);
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind === 'unavailable')
      expect(outcome.cause).toBe('account_changed');

    signIn();
    await expectNothingSpent(store);
    expect(
      ticketRows(store).every(
        row => row.state === 'remaining' && row.receipt_id === null,
      ),
    ).toBe(true);
    expect(receiptRows(store, OTHER_OWNER)).toEqual([]);
    expect(store.count('local_shot', OTHER_OWNER)).toBe(0);
  });
});

// ── Attack 6: the drain under network failure at every step ─────────────────

describe('attack 6 — receipt drain: 5xx, 429, redirect, unknown ids, then success', () => {
  it('failed presentations hold; the eventual accepted verdict settles exactly once', async () => {
    const { store, request } = await court({});
    service({ reachable: false });
    const analysis = await scoredOffline(request);

    const answers: Array<(call: FetchCall) => RouteAnswer> = [
      () => response(500, { error: { code: 'internal_error' } }),
      () =>
        response(
          429,
          { error: { code: 'rate_limit.exceeded' } },
          { 'retry-after': '5' },
        ),
      () => new TypeError('Network request failed'),
      () => response(302, null),
      // A verdict for a receipt the device never presented.
      () =>
        response(200, {
          receipts: [
            {
              receiptId: 'ffffffff-0000-4000-8000-000000000000',
              status: 'result_recorded',
            },
          ],
          rejected: [],
        }),
      // The device's receipt AND a stranger's.
      call => {
        const receipts = (call.body.receipts ?? []) as Array<
          Record<string, unknown>
        >;
        const id = (receipts[0]!.receipt as Record<string, unknown>).receiptId;
        return response(200, {
          receipts: [
            { receiptId: id, status: 'result_recorded' },
            {
              receiptId: 'ffffffff-0000-4000-8000-000000000000',
              status: 'result_recorded',
            },
          ],
          rejected: [],
        });
      },
      // An unknown status word.
      call => {
        const receipts = (call.body.receipts ?? []) as Array<
          Record<string, unknown>
        >;
        const id = (receipts[0]!.receipt as Record<string, unknown>).receiptId;
        return response(200, {
          receipts: [{ receiptId: id, status: 'accepted_i_guess' }],
          rejected: [],
        });
      },
    ];
    const net = service({
      receipts: (call, attempt) =>
        attempt <= answers.length
          ? answers[attempt - 1]!(call)
          : acceptedReceipts(call),
    });

    for (let index = 0; index < answers.length; index += 1) {
      await expect(
        reconcileOfflineWallet(store.db, client(), reading()),
      ).rejects.toBeDefined();
      // Nothing settled, the ticket stays spent, the shot is not synced.
      expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
      expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
      expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);
      const status = await readOfflineWalletStatus(store.db);
      expect(status.hold).toBe(true);
      expect(status.unansweredPresentations).toBe(1);
    }
    expect(net.receiptPosts()).toHaveLength(answers.length);
    // Every presentation carried the same receipt id, grant and exact output.
    const ids = new Set(
      net.receiptPosts().map(call => {
        const entry = (
          call.body.receipts as Array<Record<string, unknown>>
        )[0]!;
        expect(entry.grant).toEqual({
          schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
          compactJws: grantCompactJws(),
        });
        expect(entry.output).toEqual(
          JSON.parse(JSON.stringify(analysis)) as Record<string, unknown>,
        );
        return (entry.receipt as Record<string, unknown>).receiptId;
      }),
    );
    expect(ids.size).toBe(1);

    const drained = await reconcileOfflineWallet(store.db, client(), reading());
    expect(drained).toMatchObject({ submitted: 1, accepted: 1, pending: 0 });
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(true);
    expect((await readOfflineWalletStatus(store.db)).hold).toBe(false);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });

    // A further drain sends nothing and a replay of the operation spends
    // nothing more.
    const idle = await reconcileOfflineWallet(store.db, client(), reading());
    expect(idle.submitted).toBe(0);
    expect(net.receiptPosts()).toHaveLength(answers.length + 1);
    const replay = await runCaptureAnalysis(request);
    expect(replay.kind).toBe('scored');
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(receiptRows(store)).toHaveLength(1);
    expect(outboxKinds(store)).toEqual([]);
    expect(
      store.native
        .prepare(
          `SELECT count(*) AS n FROM sync_receipt WHERE owner_key = ? AND entity_id = ?`,
        )
        .get(OWNER, analysis.id)?.n,
    ).toBe(1);
  });

  it('held then accepted: one sync receipt, one spent ticket, no duplicate presentation of a settled receipt', async () => {
    const { store, request, second } = await court({});
    service({ reachable: false });
    const first = await scoredOffline(request);
    const net = service({
      receipts: (call, attempt) => {
        const receipts = (call.body.receipts ?? []) as Array<
          Record<string, unknown>
        >;
        return response(200, {
          receipts: receipts.map(entry => ({
            receiptId: (entry.receipt as Record<string, unknown>).receiptId,
            status:
              attempt === 1 ? 'reconciliation_required' : 'result_recorded',
          })),
          rejected: [],
        });
      },
    });
    const held = await reconcileOfflineWallet(store.db, client(), reading());
    expect(held).toMatchObject({ submitted: 1, held: 1, accepted: 0 });
    expect(await hasShotSyncReceipt(store.db, first.id)).toBe(false);

    // Meanwhile the court goes dark again and a second capture is rated.
    service({ reachable: false });
    const other = await scoredOffline(second);
    expect(net.receiptPosts()).toHaveLength(1);
    const again = service({
      receipts: call => acceptedReceipts(call),
    });
    const accepted = await reconcileOfflineWallet(
      store.db,
      client(),
      reading(),
    );
    expect(accepted).toMatchObject({ submitted: 2, accepted: 2, pending: 0 });
    expect(again.receiptPosts()).toHaveLength(1);
    expect(await hasShotSyncReceipt(store.db, first.id)).toBe(true);
    expect(await hasShotSyncReceipt(store.db, other.id)).toBe(true);
    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 2 });

    const idle = await reconcileOfflineWallet(store.db, client(), reading());
    expect(idle.submitted).toBe(0);
    expect(again.receiptPosts()).toHaveLength(1);
  });
});

// ── Attack 7: corrupt / tampered persisted state ─────────────────────────────

describe('attack 7 — tampered or missing local state', () => {
  it('a tampered shot payload is never replayed as a scored read, is presented as output null, and never re-reserves live', async () => {
    const { store, request } = await court({});
    service({ reachable: false });
    const analysis = await scoredOffline(request);

    const tampered = { ...analysis, overallScore: 99 };
    store.native
      .prepare(
        `UPDATE local_shot SET payload = ?, overall_score = 99 WHERE owner_key = ? AND id = ?`,
      )
      .run(JSON.stringify(tampered), OWNER, analysis.id);

    // Replay: never the tampered score, never a fresh spend.
    let replay: RunCaptureAnalysisOutcome | null = null;
    try {
      replay = await runCaptureAnalysis(request);
    } catch {
      replay = null;
    }
    if (replay?.kind === 'scored') {
      expect(replay.record.result?.overallScore).not.toBe(99);
    }
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(receiptRows(store)).toHaveLength(1);

    // Reconnect: the drain tells the server the truth (no substitute output)
    // and the sweep reserves/finalizes nothing for the paid operation.
    const online = await sweep(store, {
      permit: () => reservedPermit(),
    });
    expect(online.permitPosts()).toHaveLength(0);
    expect(online.finalizePosts()).toHaveLength(0);
    const posts = online.receiptPosts();
    expect(posts).toHaveLength(1);
    const entry = (
      posts[0]!.body.receipts as Array<Record<string, unknown>>
    )[0]!;
    expect(entry.output).toBeNull();
    expect(entry.grant).toEqual({
      schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
      compactJws: grantCompactJws(),
    });
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
  });

  it('a vanished grant row fails closed: nothing sent, nothing journaled, receipts stay pending', async () => {
    const { store, request, second } = await court({});
    service({ reachable: false });
    const first = await scoredOffline(request);
    const other = await scoredOffline(second);
    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 2 });
    expect(receiptRows(store)).toHaveLength(2);

    store.native
      .prepare(`DELETE FROM offline_grant WHERE owner_key = ? AND grant_id = ?`)
      .run(OWNER, GRANT_ID);
    const net = service({});
    await expect(
      reconcileOfflineWallet(store.db, client(), reading()),
    ).rejects.toBeDefined();
    expect(net.receiptPosts()).toHaveLength(0);
    expect(
      store.native
        .prepare(
          `SELECT count(*) AS n FROM offline_wallet_journal WHERE owner_key = ?`,
        )
        .get(OWNER)?.n,
    ).toBe(0);
    expect(await hasShotSyncReceipt(store.db, first.id)).toBe(false);
    expect(await hasShotSyncReceipt(store.db, other.id)).toBe(false);
  });

  it('an offline receipt whose shot row is gone: replay is not a fabricated score; accepted settlement does not resurrect a shot', async () => {
    const { store, request } = await court({});
    service({ reachable: false });
    const analysis = await scoredOffline(request);
    store.native
      .prepare(`DELETE FROM local_shot WHERE owner_key = ? AND id = ?`)
      .run(OWNER, analysis.id);

    let replay: RunCaptureAnalysisOutcome | null = null;
    try {
      replay = await runCaptureAnalysis(request);
    } catch {
      replay = null;
    }
    expect(replay?.kind).not.toBe('scored');
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(receiptRows(store)).toHaveLength(1);
    expect(store.count('local_shot', OWNER)).toBe(0);

    const net = service({});
    const drained = await reconcileOfflineWallet(store.db, client(), reading());
    expect(drained).toMatchObject({ submitted: 1, accepted: 1 });
    const entry = (
      net.receiptPosts()[0]!.body.receipts as Array<Record<string, unknown>>
    )[0]!;
    expect(entry.output).toBeNull();
    expect(store.count('local_shot', OWNER)).toBe(0);
    expect(await getAnalysis(store.db, analysis.id)).toBeNull();
  });
});

// ── Attack 8: cross-account isolation ───────────────────────────────────────

describe('attack 8 — another account on the same device', () => {
  it('cannot drain, replay or read the first owner’s offline receipt and shot', async () => {
    const { store, request } = await court({});
    service({ reachable: false });
    const analysis = await scoredOffline(request);

    // The second account signs in on the same device (same operation id,
    // same capture id, its own capture rows, no grant of its own).
    signIn(OTHER_OWNER, OTHER_BEARER);
    const other = await court({ store, owner: OTHER_OWNER, grant: false });
    const net = service({});

    const drained = await reconcileOfflineWallet(
      store.db,
      client(OTHER_BEARER),
      reading(),
    );
    expect(drained.submitted).toBe(0);
    expect(net.receiptPosts()).toHaveLength(0);

    expect(await getAnalysis(store.db, analysis.id)).toBeNull();
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);
    expect(await getShotOutboxStatus(store.db, analysis.id)).toMatchObject({
      state: 'absent',
    });

    // Offline again: the other account has no grant, so the same operation
    // id must not replay the first owner's paid read.
    service({ reachable: false });
    const outcome = await runCaptureAnalysis({
      ...other.request,
      apiConfig: { baseUrl: API_ORIGIN, token: OTHER_BEARER },
    });
    expect(outcome.kind).toBe('unavailable');
    expect(store.count('local_shot', OTHER_OWNER)).toBe(0);
    expect(receiptRows(store, OTHER_OWNER)).toEqual([]);

    // The first owner's wallet is untouched.
    signIn();
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(receiptRows(store)).toHaveLength(1);
    expect(await getAnalysis(store.db, analysis.id)).toEqual(analysis);
  });
});

// ── Attack 9: process death between the answered drain and its apply ────────

describe('attack 9 — the process dies after the server answered but before the verdict is applied', () => {
  it('the receipt is re-presented once and settles exactly once; the ticket is never spent twice', async () => {
    const { store, request } = await court({});
    service({ reachable: false });
    const analysis = await scoredOffline(request);

    const net = service({});
    // The settle UPDATE fails (the app is killed mid-apply): the journal
    // entry stays in flight.
    store.failStatementOnce(`UPDATE offline_receipt SET settlement`);
    await expect(
      reconcileOfflineWallet(store.db, client(), reading()),
    ).rejects.toBeDefined();
    expect(net.receiptPosts()).toHaveLength(1);
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect((await readOfflineWalletStatus(store.db)).hold).toBe(true);

    // "Restart": the sync runtime is configured afresh and sweeps.
    const online = await sweep(store, { permit: () => reservedPermit() });
    expect(online.permitPosts()).toHaveLength(0);
    expect(online.finalizePosts()).toHaveLength(0);
    expect(online.receiptPosts()).toHaveLength(1);
    const presented = (
      online.receiptPosts()[0]!.body.receipts as Array<Record<string, unknown>>
    )[0]!;
    expect((presented.receipt as Record<string, unknown>).receiptId).toBe(
      (
        net.receiptPosts()[0]!.body.receipts as Array<Record<string, unknown>>
      )[0]!.receiptId,
    );
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(true);
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
    expect((await readOfflineWalletStatus(store.db)).hold).toBe(false);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });

    // Replay after settlement: same read, nothing more spent.
    const replay = await runCaptureAnalysis(request);
    expect(replay.kind).toBe('scored');
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(receiptRows(store)).toHaveLength(1);
  });
});

// ── Attack 11: what the Result screen is told about a HELD receipt ──────────

describe('attack 11 — a held (not refused) receipt must read as still queued', () => {
  function heldVerdicts(call: FetchCall): Response {
    const receipts = (call.body.receipts ?? []) as Array<
      Record<string, unknown>
    >;
    return response(200, {
      receipts: receipts.map(entry => ({
        receiptId: (entry.receipt as Record<string, unknown>).receiptId,
        status: 'reconciliation_required',
      })),
      rejected: [],
    });
  }

  it('one held verdict: the shot is still queued, not "refused"', async () => {
    const { store, request } = await court({});
    service({ reachable: false });
    const analysis = await scoredOffline(request);
    service({ receipts: heldVerdicts });
    const held = await reconcileOfflineWallet(store.db, client(), reading());
    expect(held).toMatchObject({ submitted: 1, held: 1, refused: 0 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);

    expect(await getShotOutboxStatus(store.db, analysis.id)).toEqual({
      state: 'queued',
      attempts: 1,
      lastError: null,
    });
  });

  it('one presentation the network lost (no verdict at all): still queued, not "refused"', async () => {
    const { store, request } = await court({});
    service({ reachable: false });
    const analysis = await scoredOffline(request);
    service({ receipts: () => new TypeError('Network request failed') });
    await expect(
      reconcileOfflineWallet(store.db, client(), reading()),
    ).rejects.toBeInstanceOf(TypeError);
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);

    expect(await getShotOutboxStatus(store.db, analysis.id)).toEqual({
      state: 'queued',
      attempts: 1,
      lastError: null,
    });
  });

  it('eight held verdicts: the receipt is still pending and re-presented, so the shot must not read as terminally refused', async () => {
    const { store, request } = await court({});
    service({ reachable: false });
    const analysis = await scoredOffline(request);
    const net = service({ receipts: heldVerdicts });
    for (let round = 0; round < 8; round += 1) {
      const held = await reconcileOfflineWallet(store.db, client(), reading());
      expect(held).toMatchObject({ submitted: 1, held: 1, refused: 0 });
    }
    expect(net.receiptPosts()).toHaveLength(8);
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);

    const status = await getShotOutboxStatus(store.db, analysis.id);
    // The wallet will present this receipt again on the very next drain…
    const accepted = service({});
    const drained = await reconcileOfflineWallet(store.db, client(), reading());
    expect(drained).toMatchObject({ submitted: 1, accepted: 1 });
    expect(accepted.receiptPosts()).toHaveLength(1);
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(true);
    // …so before that drain it was still queued, never exhausted.
    expect(status.state).toBe('queued');
  });
});

// ── Attack 10: free-rating conservation across abstention + replay ──────────

describe('attack 10 — abstention then a scored run of the SAME capture, and replays', () => {
  it('a low-visibility abstention spends nothing and does not poison a later scored operation', async () => {
    const dim = await court({ visibility: 0.05 });
    service({ reachable: false });
    const abstained = await runCaptureAnalysis(dim.request);
    expect(abstained.kind).not.toBe('scored');
    await expectNothingSpent(dim.store);
    // Replaying the abstention spends nothing either.
    const again = await runCaptureAnalysis(dim.request);
    expect(again.kind).not.toBe('scored');
    await expectNothingSpent(dim.store);
    // The wallet is intact for the next capture.
    const outcome = await runCaptureAnalysis(dim.second);
    if (outcome.kind === 'scored') {
      expect(await tickets(dim.store)).toEqual({ spendable: 1, consumed: 1 });
      expect(receiptRows(dim.store)).toHaveLength(1);
    } else {
      // A dimmed second clip also abstains — still nothing spent.
      await expectNothingSpent(dim.store);
    }
  });

  it('after an accepted settlement a reconnected run of a NEW capture reserves live and the paid operation is never reserved again', async () => {
    const { store, request, second } = await court({});
    service({ reachable: false });
    const analysis = await scoredOffline(request);
    const online = await sweep(store, { permit: () => reservedPermit() });
    expect(online.permitPosts()).toHaveLength(0);
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(true);

    const live = service({ permit: () => reservedPermit() });
    const outcome = await runCaptureAnalysis(second);
    expect(outcome.kind).toBe('scored');
    expect(live.permitPosts()).toHaveLength(1);
    expect(live.permitPosts()[0]!.body.idempotencyKey).toBeDefined();
    // The live run spent no offline ticket and queued a shot.sync row.
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(receiptRows(store)).toHaveLength(1);
    expect(outboxKinds(store)).toEqual(['shot.sync']);

    // And the paid operation still replays without any permit traffic.
    const replay = await runCaptureAnalysis(request);
    expect(replay.kind).toBe('scored');
    expect(live.permitPosts()).toHaveLength(1);
  });
});
