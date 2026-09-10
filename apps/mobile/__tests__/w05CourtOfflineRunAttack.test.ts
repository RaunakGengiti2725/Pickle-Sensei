/**
 * W05-07 adversarial attacks on the court-offline scored read.
 *
 * Every test drives the shipping entry point (`runCaptureAnalysis`) or the
 * wallet drain / sync sweep through the same fixtures the candidate's own
 * suite uses, at the boundaries that suite does not exercise: concurrent
 * double submission, the last-ticket race, an account switch inside the
 * offline admission, the 100-paid-operation recovery exclusion cap, refusal
 * status codes, trusted-time faults, a write failing between the consume and
 * the shot, corrupt wallet rows, an empty free allocation and concurrent
 * drains of one owner's wallet.
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
  prepareOriginalCaptureAnalysis,
  runCaptureAnalysis,
  runOriginalCaptureAnalysis,
  type RunCaptureAnalysisRequest,
} from '../src/analysis/runCaptureAnalysis';
import { OriginalAnalysisExecution } from '../src/analysis/originalAnalysisOperations';
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
  consumeOfflineAllocation,
  holdOfflineGrant,
  pendingOfflineReceipts,
  readOfflineAllocation,
} from '../src/data/offlineCapabilities';
import { reconcileOfflineWallet } from '../src/data/offlineWallet';
import { hasShotSyncReceipt } from '../src/data/repository';
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
let mockReadHook: (() => void) | null = null;

jest.mock('../src/data/trustedTime', () => {
  const actual = jest.requireActual<typeof import('../src/data/trustedTime')>(
    '../src/data/trustedTime',
  );
  return {
    ...actual,
    trustedTime: {
      ...actual.trustedTime,
      read: async () => {
        mockReadHook?.();
        if (!mockReading) throw new Error('trusted time not configured');
        return mockReading;
      },
    },
  };
});

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
const CAPTURE = '33333333-3333-4333-8333-333333333333';
const CAPTURE_2 = '33333333-3333-4333-8333-333333333334';
const OPERATION = '44444444-4444-4444-8444-444444444444';
const OPERATION_2 = '44444444-4444-4444-8444-444444444445';
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

function reading(
  overrides: Partial<TrustedTimeReading> = {},
): TrustedTimeReading {
  return {
    authority: 'anchored',
    continuity: 'measured',
    nowMs: NOW_MS,
    wallClockMs: NOW_MS,
    rollbackDetected: false,
    storage: 'loaded',
    ...overrides,
  };
}

function base64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

interface GrantShape {
  pro?: boolean;
  ticketIds?: readonly string[];
  owner?: string;
  grantId?: string;
}

function grantCompactJws(shape: GrantShape): string {
  const claims = {
    schemaVersion: OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
    protocolVersion: OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
    iss: API_ORIGIN,
    aud: OFFLINE_GRANT_AUDIENCE,
    sub: shape.owner ?? OWNER,
    jti: shape.grantId ?? GRANT_ID,
    installationKeyId: INSTALLATION_KEY,
    iat: ISSUED_AT,
    exp: EXPIRES_AT,
    capabilities: ['analyze_joint_output'],
    release: {
      policy: ARTIFACT,
      mechanicsModel: ARTIFACT,
      benchmarkModel: ARTIFACT,
    },
    ...(shape.pro
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
            allocationId: shape.grantId ?? GRANT_ID,
            generation: 1,
            ticketIds: shape.ticketIds ?? TICKETS,
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

function issuedGrant(shape: GrantShape = {}): IssuedOfflineGrant {
  const parsed = parseIssuedOfflineGrant({
    grantId: shape.grantId ?? GRANT_ID,
    generation: 1,
    entitlementSource: shape.pro ? 'verified_store' : 'identity_lifetime_free',
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    entitlementExpiresAt: shape.pro ? EXPIRES_AT + 3600 : null,
    ticketIds: shape.pro ? [] : (shape.ticketIds ?? TICKETS),
    keyId: KEY_ID,
    grant: {
      schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
      compactJws: grantCompactJws(shape),
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

function signIn(owner = OWNER) {
  setActiveDataOwner(owner);
  establishApiSession({ ...SESSION, canonicalAppUserId: owner });
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
  const lookup = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    ok: status < 400,
    status,
    statusText: String(status),
    headers: { get: (name: string) => lookup.get(name.toLowerCase()) ?? null },
    json: async () => body,
  } as unknown as Response;
}

interface FetchCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

type ReserveAnswer = (
  call: FetchCall,
) => Response | Promise<Response> | 'offline';

/** A reservation the test answers later — a permit call still in the air. */
function deferredReservation() {
  let settle: (answer: Response) => void = () => {};
  const answer = new Promise<Response>(resolve => {
    settle = resolve;
  });
  return { reserve: (): Promise<Response> => answer, settle };
}

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

async function setup(shape: GrantShape = {}) {
  const store = createSqliteTestDb();
  const { clip, sidecar } = fixture();
  mockReadArtifact = async () => sidecar;
  // local_capture is UNIQUE (owner_key, uri): a second capture needs its
  // own file, or the seed is silently ignored.
  const secondClip: CapturedClip = {
    ...clip,
    uri: 'file:///private/captures/court-2.mov',
  };
  seedSqliteCapture(store.db, OWNER, CAPTURE, clip);
  seedSqliteCapture(store.db, OWNER, CAPTURE_2, secondClip);
  expect(store.count('local_capture', OWNER)).toBe(2);
  mockReading = reading();
  await cachePolicy(store);
  await holdOfflineGrant(store.db, issuedGrant(shape), BINDING);
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
  const second: RunCaptureAnalysisRequest = {
    ...request,
    operationId: OPERATION_2,
    captureId: CAPTURE_2,
    clip: secondClip,
  };
  return { store, request, second };
}

const leases: OriginalAnalysisExecution[] = [];

/** The shipping path: a signed-in camera capture with a verified native
 * media identity, prepared as an original operation and run from its
 * immutable snapshot, exactly as AnalyzeScreen does. */
async function setupOriginal(
  capture: {
    store?: Store;
    captureId?: string;
    operationId?: string;
    file?: string;
  } = {},
) {
  const store = capture.store ?? createSqliteTestDb();
  const captureId = capture.captureId ?? CAPTURE;
  const operationId = capture.operationId ?? OPERATION;
  const file = capture.file ?? 'court.mov';
  const { clip: bare, sidecar } = fixture();
  const clip: CapturedClip = {
    ...bare,
    uri: `file:///private/captures/${file}`,
    byteSize: 25,
    nativeMediaIdentity: {
      schemaVersion: 1,
      format: 'pickle.native-media-identity.v1',
      receiptId: '66666666-6666-4666-8666-666666666666',
      operationId: '77777777-7777-4777-8777-777777777777',
      origin: 'native_export',
      algorithm: 'sha256',
      videoFileName: file,
      byteSize: 25,
      sha256: sha256Hex('synthetic court movie bytes'),
    },
  };
  mockReadArtifact = async () => sidecar;
  seedSqliteCapture(store.db, OWNER, captureId, clip);
  await store.db.execute(
    'UPDATE local_capture SET declared_stroke = ? WHERE owner_key = ? AND id = ?',
    ['forehand_drive', OWNER, captureId],
  );
  if (!capture.store) {
    mockReading = reading();
    await cachePolicy(store);
    await holdOfflineGrant(store.db, issuedGrant(), BINDING);
  }
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
  const run = async (): Promise<Attempt> => {
    try {
      const operation = await prepareOriginalCaptureAnalysis(
        request,
        execution,
        operationId,
      );
      return await runOriginalCaptureAnalysis({
        db: store.db,
        execution,
        operationId: operation.operationId,
      });
    } catch (error) {
      return { kind: 'threw', error: String(error) };
    }
  };
  return { store, run };
}

function outboxKinds(store: Store): string[] {
  return store.native
    .prepare(`SELECT kind FROM outbox WHERE owner_key = ? ORDER BY kind`)
    .all(OWNER)
    .map(row => String(row.kind));
}

/** Raw ticket states — read straight from the table so a corrupt ledger
 * (which makes readOfflineAllocation throw) can still be counted. */
function ticketRows(
  store: Store,
  owner = OWNER,
): { spendable: number; consumed: number } {
  const rows = store.native
    .prepare(
      `SELECT state, count(*) AS n FROM offline_ticket WHERE owner_key = ? GROUP BY state`,
    )
    .all(owner);
  const of = (state: string) =>
    Number(rows.find(row => row.state === state)?.n ?? 0);
  return { spendable: of('remaining'), consumed: of('consumed') };
}

async function tickets(store: Store) {
  const allocation = await readOfflineAllocation(store.db, reading());
  return {
    spendable: allocation.spendableTickets,
    consumed: allocation.consumedTickets,
  };
}

function shotIds(store: Store, owner = OWNER): string[] {
  return store.native
    .prepare(`SELECT id FROM local_shot WHERE owner_key = ? ORDER BY id`)
    .all(owner)
    .map(row => String(row.id));
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

type Outcome = Awaited<ReturnType<typeof runCaptureAnalysis>>;
type Attempt = Outcome | { kind: 'threw'; error: string };

/** The run as the screen experiences it: a thrown error is an outcome too. */
async function attempt(request: RunCaptureAnalysisRequest): Promise<Attempt> {
  try {
    return await runCaptureAnalysis(request);
  } catch (error) {
    return { kind: 'threw', error: String(error) };
  }
}

function scoredId(outcome: Attempt): string {
  if (outcome.kind !== 'scored' || !outcome.record.result) {
    throw new Error(
      `expected a scored outcome, got ${JSON.stringify(outcome)}`,
    );
  }
  return outcome.record.result.id;
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
  mockReadHook = null;
  (getDb as jest.Mock).mockReset();
  jest.restoreAllMocks();
  closeSqliteTestDatabases();
});

describe('attack 1 — concurrent double submission of ONE operation', () => {
  it('two simultaneous runs of the same operation spend one ticket, file one receipt, keep one shot, and never throw', async () => {
    const { store, request } = await setup();
    network({ reserve: OFFLINE });
    const outcomes = await Promise.all([attempt(request), attempt(request)]);
    for (const outcome of outcomes) expect(outcome.kind).not.toBe('threw');
    const scored = outcomes.filter(outcome => outcome.kind === 'scored');
    expect(scored.length).toBeGreaterThanOrEqual(1);
    expect(new Set(scored.map(scoredId)).size).toBe(1);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(shotIds(store)).toEqual([scoredId(scored[0]!)]);
    expect(store.count('local_analysis_record', OWNER)).toBe(1);
    expect(outboxKinds(store)).toEqual([]);

    const replay = await attempt(request);
    expect(scoredId(replay)).toBe(scoredId(scored[0]!));
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
  });
});

describe('attack 2 — two operations race for the LAST ticket', () => {
  it('exactly one scores; the loser spends nothing and leaves no shot', async () => {
    const { store, request, second } = await setup();
    await consumeOfflineAllocation(
      store.db,
      {
        operationId: '55555555-5555-4555-8555-555555555555',
        resultId: '55555555-5555-4555-8555-555555555556',
        fullOutputSha256: 'c'.repeat(64),
      },
      reading(),
    );
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });

    network({ reserve: OFFLINE });
    const outcomes = await Promise.all([attempt(request), attempt(second)]);
    const scored = outcomes.filter(outcome => outcome.kind === 'scored');
    const losers = outcomes.filter(outcome => outcome.kind !== 'scored');
    expect(scored).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 2 });
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(2);
    expect(shotIds(store)).toEqual([scoredId(scored[0]!)]);
    expect(store.count('local_analysis_record', OWNER)).toBe(1);
    expect(outboxKinds(store)).toEqual([]);
  });

  it('the plain-path loser surfaces as an outcome for the screen, not a thrown OfflineGrantError', async () => {
    const { store, request, second } = await setup({
      ticketIds: ['aaaaaaaa-0000-4000-8000-000000000001'],
    });
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 0 });
    network({ reserve: OFFLINE });
    const outcomes = await Promise.all([attempt(request), attempt(second)]);
    const losers = outcomes.filter(outcome => outcome.kind !== 'scored');
    expect(losers).toHaveLength(1);
    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 1 });
    expect(losers[0]!.kind).not.toBe('threw');
  });

  it('shipping path: the loser of the last-ticket race is told the allowance is gone, not left "awaiting recovery"', async () => {
    const first = await setupOriginal();
    const second = await setupOriginal({
      store: first.store,
      captureId: CAPTURE_2,
      operationId: OPERATION_2,
      file: 'court-2.mov',
    });
    const { store } = first;
    await consumeOfflineAllocation(
      store.db,
      {
        operationId: '55555555-5555-4555-8555-555555555555',
        resultId: '55555555-5555-4555-8555-555555555556',
        fullOutputSha256: 'c'.repeat(64),
      },
      reading(),
    );
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });

    network({ reserve: OFFLINE });
    const outcomes = await Promise.all([first.run(), second.run()]);
    const scored = outcomes.filter(outcome => outcome.kind === 'scored');
    const losers = outcomes.filter(outcome => outcome.kind !== 'scored');
    expect(scored).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 2 });
    expect(shotIds(store)).toEqual([scoredId(scored[0]!)]);
    expect(outboxKinds(store)).toEqual([]);
    const loser = losers[0]!;
    expect(loser.kind).toBe('unavailable');
    expect(loser.kind === 'unavailable' && loser.cause).not.toBe(
      'recovery_pending',
    );
  });
});

describe('attack 3 — account switch inside the offline admission', () => {
  it('the owner changes between the connectivity failure and the trusted-time read: no rating, nothing spent for either owner', async () => {
    const { store, request } = await setup();
    network({ reserve: OFFLINE });
    let reads = 0;
    mockReadHook = () => {
      reads += 1;
      if (reads === 1) setActiveDataOwner(OTHER_OWNER);
    };
    const outcome = await attempt(request);
    expect(outcome.kind).not.toBe('scored');
    expect(outcome.kind).not.toBe('threw');
    expect(ticketRows(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(store.count('offline_receipt', OWNER)).toBe(0);
    expect(store.count('offline_receipt', OTHER_OWNER)).toBe(0);
    expect(shotIds(store)).toEqual([]);
    expect(shotIds(store, OTHER_OWNER)).toEqual([]);
    expect(store.count('local_analysis_record', OTHER_OWNER)).toBe(0);
  });
});

describe('attack 4 — the recovery sweep excludes at most 100 paid operations', () => {
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
    // Older than the real receipt so the real one sorts past the cap.
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

  it('control: with 99 older paid receipts (100 in total) the paid operation is left alone by the sweep', async () => {
    const { store, request } = await setup({ pro: true });
    network({ reserve: OFFLINE });
    const analysisId = scoredId(await attempt(request));
    for (let index = 0; index < 99; index += 1) cloneReceipt(store, index);
    expect(store.count('offline_receipt', OWNER)).toBe(100);
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
    expect(await hasShotSyncReceipt(store.db, analysisId)).toBe(true);
    expect(
      store.native
        .prepare(
          `SELECT state, release_outcome, permit_id FROM analysis_run_journal WHERE owner_key = ? AND operation_id = ?`,
        )
        .get(OWNER, OPERATION),
    ).toEqual({
      state: 'reserve_pending',
      release_outcome: null,
      permit_id: null,
    });
  });

  it('a Pro lease with 100 older paid receipts: the 101st paid operation is not re-reserved live and still replays as scored', async () => {
    const { store, request } = await setup({ pro: true });
    network({ reserve: OFFLINE });
    const analysisId = scoredId(await attempt(request));
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    for (let index = 0; index < 100; index += 1) cloneReceipt(store, index);
    expect(store.count('offline_receipt', OWNER)).toBe(101);
    expect(
      runJournal.activeOperationIds(
        runJournal.scope({ ownerKey: OWNER, apiOrigin: API_ORIGIN }),
      ),
    ).toEqual([]);

    const online = network({
      reserve: reservedPermit(LIVE_PERMIT),
      finalize: finalizedPermit,
      receipts: settleAll(),
      policy: 'online',
    });
    (getDb as jest.Mock).mockReturnValue(store.db);
    configureSyncRuntime(SESSION);
    await triggerOutboxSync();

    // The operation was paid offline; the sweep must never reserve a live
    // permit for it nor finalize it as failed/cancelled.
    expect(permitPosts(online.calls)).toHaveLength(0);
    expect(finalizePosts(online.calls)).toHaveLength(0);
    expect(receiptPosts(online.calls).length).toBeGreaterThanOrEqual(1);
    expect(await hasShotSyncReceipt(store.db, analysisId)).toBe(true);

    expect(
      store.native
        .prepare(
          `SELECT state, release_outcome, permit_id FROM analysis_run_journal WHERE owner_key = ? AND operation_id = ?`,
        )
        .get(OWNER, OPERATION),
    ).toEqual({
      state: 'reserve_pending',
      release_outcome: null,
      permit_id: null,
    });

    const replay = await attempt(request);
    expect(replay.kind).toBe('scored');
    expect(permitPosts(online.calls)).toHaveLength(0);
  });

  it('lifetime: 100 paid receipts already ACCEPTED on earlier reconnects, then one more court-day rating — its reconnect must not reserve a live permit', async () => {
    const { store, request, second } = await setup({ pro: true });
    network({ reserve: OFFLINE });
    scoredId(await attempt(request));
    for (let index = 0; index < 99; index += 1) cloneReceipt(store, index);
    const earlier = network({
      reserve: reservedPermit(LIVE_PERMIT),
      finalize: finalizedPermit,
      receipts: settleAll(),
      policy: 'online',
    });
    (getDb as jest.Mock).mockReturnValue(store.db);
    configureSyncRuntime(SESSION);
    await triggerOutboxSync();
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
    expect(permitPosts(earlier.calls)).toHaveLength(0);
    expect(store.count('offline_receipt', OWNER)).toBe(100);

    // Weeks later, another court without signal: the 101st paid rating of
    // this device's life.
    network({ reserve: OFFLINE });
    const analysisId = scoredId(await attempt(second));
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);

    const online = network({
      reserve: reservedPermit(LIVE_PERMIT),
      finalize: finalizedPermit,
      receipts: settleAll(),
      policy: 'online',
    });
    await triggerOutboxSync();
    expect(await hasShotSyncReceipt(store.db, analysisId)).toBe(true);
    expect(
      store.native
        .prepare(
          `SELECT state, release_outcome, permit_id FROM analysis_run_journal WHERE owner_key = ? AND operation_id = ?`,
        )
        .get(OWNER, OPERATION_2),
    ).toEqual({
      state: 'reserve_pending',
      release_outcome: null,
      permit_id: null,
    });
    expect(permitPosts(online.calls)).toHaveLength(0);
    expect(finalizePosts(online.calls)).toHaveLength(0);
  });

  it('end to end: 101 real Pro offline ratings on one court day, then reconnect — no paid operation may be re-reserved or finalized', async () => {
    const { store, request } = await setup({ pro: true });
    network({ reserve: OFFLINE });
    const paid: string[] = [];
    for (let index = 0; index < 101; index += 1) {
      const suffix = String(index).padStart(12, '0');
      const captureId = `cccccccc-0000-4000-8000-${suffix}`;
      const operationId = `dddddddd-0000-4000-8000-${suffix}`;
      const clip: CapturedClip = {
        ...request.clip,
        uri: `file:///private/captures/court-day-${index}.mov`,
      };
      seedSqliteCapture(store.db, OWNER, captureId, clip);
      const outcome = await attempt({
        ...request,
        captureId,
        operationId,
        clip,
      });
      expect(outcome.kind).toBe('scored');
      paid.push(operationId);
    }
    expect(store.count('offline_receipt', OWNER)).toBe(101);

    const online = network({
      reserve: reservedPermit(LIVE_PERMIT),
      finalize: finalizedPermit,
      receipts: settleAll(),
      policy: 'online',
    });
    (getDb as jest.Mock).mockReturnValue(store.db);
    configureSyncRuntime(SESSION);
    await triggerOutboxSync();

    const journals = store.native
      .prepare(
        `SELECT operation_id, state, release_outcome, permit_id FROM analysis_run_journal WHERE owner_key = ? AND state <> 'reserve_pending'`,
      )
      .all(OWNER);
    expect(journals).toEqual([]);
    expect(permitPosts(online.calls)).toHaveLength(0);
    expect(finalizePosts(online.calls)).toHaveLength(0);
  });

  it('100 paid receipts plus ONE rating in flight: the reconnect pass must still drain the outbox and present the receipts', async () => {
    const { store, request, second } = await setup({ pro: true });
    network({ reserve: OFFLINE });
    const analysisId = scoredId(await attempt(request));
    for (let index = 0; index < 99; index += 1) cloneReceipt(store, index);
    expect(store.count('offline_receipt', OWNER)).toBe(100);

    // Back online: a new rating is mid-reservation (its permit call has not
    // answered yet) when the reconnect pass runs.
    const pending = deferredReservation();
    const online = network({
      reserve: pending.reserve,
      finalize: finalizedPermit,
      receipts: settleAll(),
      policy: 'online',
    });
    const inFlight = attempt(second);
    for (
      let tick = 0;
      tick < 200 && permitPosts(online.calls).length === 0;
      tick += 1
    )
      await new Promise(resolve => setImmediate(resolve));
    expect(permitPosts(online.calls)).toHaveLength(1);
    const scope = runJournal.scope({ ownerKey: OWNER, apiOrigin: API_ORIGIN });
    expect(runJournal.activeOperationIds(scope)).toEqual([OPERATION_2]);

    (getDb as jest.Mock).mockReturnValue(store.db);
    configureSyncRuntime(SESSION);
    await triggerOutboxSync();

    expect(receiptPosts(online.calls).length).toBeGreaterThanOrEqual(1);
    expect(await hasShotSyncReceipt(store.db, analysisId)).toBe(true);
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);

    // The reservation finally answers with a refusal: the in-flight rating
    // ends as an honest outcome and the wallet is untouched by it.
    pending.settle(
      response(402, {
        error: { code: 'paywall', message: 'Pro required' },
      }),
    );
    const late = await inFlight;
    expect(late.kind).not.toBe('threw');
    expect(late.kind).not.toBe('scored');
    expect(store.count('offline_receipt', OWNER)).toBe(100);
  });
});

describe('attack 11 — another account reuses the paid operation id on the same device', () => {
  const OTHER_GRANT = 'bbbbbbbb-0000-4000-8000-000000000002';
  const OTHER_TICKETS = [
    'aaaaaaaa-0000-4000-8000-000000000011',
    'aaaaaaaa-0000-4000-8000-000000000012',
  ] as const;

  async function paidThenSwitch() {
    const { store, request } = await setup();
    network({ reserve: OFFLINE });
    const paid = await attempt(request);
    expect(paid.kind).toBe('scored');
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });

    signIn(OTHER_OWNER);
    seedSqliteCapture(store.db, OTHER_OWNER, CAPTURE, request.clip);
    await cachePolicy(store, OTHER_OWNER);
    const foreign: RunCaptureAnalysisRequest = {
      ...request,
      ownerContext: captureDataOwnerContext(),
    };
    return { store, paid, foreign };
  }

  it('without a grant of its own the second account gets the honest no-score path and borrows nothing', async () => {
    const { store, foreign } = await paidThenSwitch();
    const bare = await attempt(foreign);
    expect(bare.kind).not.toBe('scored');
    expect(bare.kind).not.toBe('threw');
    expect(ticketRows(store, OWNER)).toEqual({ spendable: 1, consumed: 1 });
    expect(ticketRows(store, OTHER_OWNER)).toEqual({
      spendable: 0,
      consumed: 0,
    });
    expect(store.count('offline_receipt', OWNER)).toBe(1);
    expect(store.count('offline_receipt', OTHER_OWNER)).toBe(0);
    expect(shotIds(store, OTHER_OWNER)).toEqual([]);
  });

  it("with its own grant the same operation id is a NEW paid rating from its own wallet — never a replay of the first account's", async () => {
    const { store, paid, foreign } = await paidThenSwitch();
    await holdOfflineGrant(
      store.db,
      issuedGrant({
        owner: OTHER_OWNER,
        grantId: OTHER_GRANT,
        ticketIds: OTHER_TICKETS,
      }),
      BINDING,
    );
    const own = await attempt(foreign);
    expect(own.kind).toBe('scored');
    expect(scoredId(own)).not.toBe(scoredId(paid));
    expect(ticketRows(store, OWNER)).toEqual({ spendable: 1, consumed: 1 });
    expect(ticketRows(store, OTHER_OWNER)).toEqual({
      spendable: 1,
      consumed: 1,
    });
    expect(store.count('offline_receipt', OTHER_OWNER)).toBe(1);
    expect(store.count('offline_receipt', OWNER)).toBe(1);
    expect(shotIds(store, OTHER_OWNER)).toEqual([scoredId(own)]);
    expect(shotIds(store, OWNER)).toEqual([scoredId(paid)]);
    const receipts = store.native
      .prepare(
        `SELECT owner_key, grant_id, receipt FROM offline_receipt WHERE operation_id = ? ORDER BY owner_key`,
      )
      .all(OPERATION)
      .map(row => ({
        owner: String(row.owner_key),
        grantId: String(row.grant_id),
        resultId: (JSON.parse(String(row.receipt)) as { resultId: string })
          .resultId,
      }));
    expect(receipts).toEqual([
      { owner: OWNER, grantId: GRANT_ID, resultId: scoredId(paid) },
      { owner: OTHER_OWNER, grantId: OTHER_GRANT, resultId: scoredId(own) },
    ]);
  });
});

describe('attack 5 — server verdicts are never an offline case', () => {
  const cases: Array<
    [string, number, Record<string, unknown>, Record<string, string>]
  > = [
    [
      '429 with Retry-After',
      429,
      { error: { code: 'rate_limited', message: 'Too many requests' } },
      { 'Retry-After': '30' },
    ],
    [
      '409 release refusal',
      409,
      { error: { code: 'release.refused', message: 'Release refused' } },
      {},
    ],
    [
      '401 session refusal',
      401,
      { error: { code: 'auth.unauthorized', message: 'Sign in again' } },
      {},
    ],
    [
      '403 forbidden',
      403,
      { error: { code: 'auth.forbidden', message: 'Forbidden' } },
      {},
    ],
    [
      '402 paywall',
      402,
      { error: { code: 'access.paywall_required', message: 'Upgrade' } },
      {},
    ],
  ];

  it.each(cases)(
    '%s → no offline rating, nothing spent, no receipt, no shot',
    async (_label, status, body, headers) => {
      const { store, request } = await setup();
      network({ reserve: () => response(status, body, headers) });
      const outcome = await attempt(request);
      expect(outcome.kind).not.toBe('scored');
      expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
      expect(store.count('offline_receipt', OWNER)).toBe(0);
      expect(shotIds(store)).toEqual([]);
      expect(outboxKinds(store)).toEqual([]);
    },
  );
});

describe('attack 12 — transport artifacts admit exactly ONE paid rating per operation', () => {
  /** An answer written by an intermediary, not the route: no JSON body. */
  function page(status: number, headers: Record<string, string> = {}) {
    const answer = response(status, null, headers);
    return {
      ...answer,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    } as unknown as Response;
  }
  const cases: Array<[string, () => Response]> = [
    ['captive portal: 200 text/html', () => page(200)],
    ['captive portal: 403 without a coded envelope', () => page(403)],
    [
      '302 redirect to a sign-on page',
      () => page(302, { Location: 'https://portal.example.test/' }),
    ],
    [
      '503 with Retry-After',
      () =>
        response(
          503,
          { error: { code: 'unavailable', message: 'Down' } },
          { 'Retry-After': '120' },
        ),
    ],
    ['502 gateway HTML', () => page(502)],
    [
      '408 request timeout',
      () =>
        response(408, { error: { code: 'network.timeout', message: 'Slow' } }),
    ],
  ];

  it.each(cases)(
    '%s → one paid rating; a same-operation replay and a rerun spend nothing more',
    async (_label, answer) => {
      const { store, request } = await setup();
      const net = network({ reserve: answer });
      const first = await attempt(request);
      expect(first.kind).toBe('scored');
      expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
      expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
      expect(shotIds(store)).toEqual([scoredId(first)]);
      expect(outboxKinds(store)).toEqual([]);

      const again = await attempt(request);
      expect(scoredId(again)).toBe(scoredId(first));
      expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
      expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
      expect(shotIds(store)).toEqual([scoredId(first)]);
      // The transport artifact was answered once per real attempt; a replay
      // never re-reserves.
      expect(permitPosts(net.calls)).toHaveLength(1);
    },
  );
});

describe('attack 6 — trusted-time faults at admission', () => {
  const FAR_FUTURE = Date.UTC(2100, 0, 1);
  const BEFORE_ISSUE = (ISSUED_AT - 24 * 3600) * 1000;
  const cases: Array<[string, Partial<TrustedTimeReading>]> = [
    ['clock rollback detected', { rollbackDetected: true }],
    [
      'far-future clock (grant long expired)',
      { nowMs: FAR_FUTURE, wallClockMs: FAR_FUTURE },
    ],
    [
      'clock a day before the grant was issued',
      { nowMs: BEFORE_ISSUE, wallClockMs: BEFORE_ISSUE },
    ],
    ['floor-only time authority', { authority: 'floor' }],
    [
      'no trusted time, invalid storage',
      { authority: 'none', storage: 'invalid' },
    ],
    [
      'anchor whose elapsed time is unmeasured',
      { authority: 'floor', continuity: 'unmeasured' },
    ],
    ['NaN clock', { nowMs: Number.NaN, wallClockMs: Number.NaN }],
    ['negative clock', { nowMs: -1, wallClockMs: -1 }],
    [
      'exactly at grant expiry',
      { nowMs: EXPIRES_AT * 1000, wallClockMs: EXPIRES_AT * 1000 },
    ],
  ];

  it.each(cases)(
    '%s → no offline rating, no ticket spent, no receipt',
    async (_label, overrides) => {
      const { store, request } = await setup();
      network({ reserve: OFFLINE });
      mockReading = reading(overrides);
      const outcome = await attempt(request);
      expect(outcome.kind).not.toBe('scored');
      expect(ticketRows(store)).toEqual({ spendable: 2, consumed: 0 });
      expect(store.count('offline_receipt', OWNER)).toBe(0);
      expect(shotIds(store)).toEqual([]);
    },
  );
});

describe('attack 7 — a write fails between the consume and the shot', () => {
  it.each([
    ['analysis record insert', 'INTO local_analysis_record'],
    ['ticket consume', 'UPDATE offline_ticket'],
    ['receipt insert', 'INTO offline_receipt'],
    ['shot insert', 'INTO local_shot'],
  ])(
    'plain path: a failed %s rolls the whole paid commit back — nothing spent, no receipt, no shot',
    async (_label, statement) => {
      const { store, request } = await setup();
      network({ reserve: OFFLINE });
      store.failStatementOnce(statement, new Error('disk I/O error'));
      const outcome = await attempt(request);
      expect(outcome.kind).not.toBe('scored');
      expect(ticketRows(store)).toEqual({ spendable: 2, consumed: 0 });
      expect(store.count('offline_receipt', OWNER)).toBe(0);
      expect(shotIds(store)).toEqual([]);
      expect(store.count('local_analysis_record', OWNER)).toBe(0);
      expect(outboxKinds(store)).toEqual([]);
    },
  );

  it.each([
    ['ticket consume', 'UPDATE offline_ticket'],
    ['receipt insert', 'INTO offline_receipt'],
    ['shot insert', 'INTO local_shot'],
  ])(
    'shipping path: a failed %s spends nothing, fabricates nothing, and a same-operation rerun still spends nothing',
    async (_label, statement) => {
      const { store, run } = await setupOriginal();
      network({ reserve: OFFLINE });
      store.failStatementOnce(statement, new Error('disk I/O error'));
      const outcome = await run();
      expect(outcome.kind).not.toBe('scored');
      expect(outcome.kind).not.toBe('threw');
      expect(ticketRows(store)).toEqual({ spendable: 2, consumed: 0 });
      expect(store.count('offline_receipt', OWNER)).toBe(0);
      expect(shotIds(store)).toEqual([]);
      expect(outboxKinds(store)).toEqual([]);

      const rerun = await run();
      expect(rerun.kind).not.toBe('scored');
      expect(rerun.kind).not.toBe('threw');
      expect(ticketRows(store)).toEqual({ spendable: 2, consumed: 0 });
      expect(store.count('offline_receipt', OWNER)).toBe(0);
      expect(shotIds(store)).toEqual([]);
    },
  );

  it('shipping path: a commit that fails BEFORE the durable write spends nothing, and a same-operation rerun still spends nothing', async () => {
    const { store, run } = await setupOriginal();
    network({ reserve: OFFLINE });
    store.failCommitOnce('before', 'INTO offline_receipt');
    const outcome = await run();
    expect(outcome.kind).not.toBe('scored');
    expect(outcome.kind).not.toBe('threw');
    expect(ticketRows(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(store.count('offline_receipt', OWNER)).toBe(0);
    expect(shotIds(store)).toEqual([]);
    const rerun = await run();
    expect(rerun.kind).not.toBe('scored');
    expect(rerun.kind).not.toBe('threw');
    expect(ticketRows(store)).toEqual({ spendable: 2, consumed: 0 });
    expect(store.count('offline_receipt', OWNER)).toBe(0);
  });
});

describe('attack 8 — corrupt wallet rows at the moment of consumption', () => {
  it('a corrupt ticket row: no rating, no receipt, no shot, and the run does not throw', async () => {
    const { store, request } = await setup();
    store.native
      .prepare(
        `UPDATE offline_ticket SET state = 'spent' WHERE owner_key = ? AND ticket_id = ?`,
      )
      .run(OWNER, TICKETS[0]);
    network({ reserve: OFFLINE });
    const outcome = await attempt(request);
    expect(outcome.kind).not.toBe('scored');
    expect(outcome.kind).not.toBe('threw');
    expect(store.count('offline_receipt', OWNER)).toBe(0);
    expect(shotIds(store)).toEqual([]);
    expect(store.count('local_analysis_record', OWNER)).toBe(0);
    expect(outboxKinds(store)).toEqual([]);
  });

  it('an unparseable receipt already filed for this operation holds the replay: no second charge, no fabricated rating, no throw', async () => {
    const { store, request } = await setup();
    network({ reserve: OFFLINE });
    const analysisId = scoredId(await attempt(request));
    store.native
      .prepare(
        `UPDATE offline_receipt SET receipt = 'not json' WHERE owner_key = ? AND operation_id = ?`,
      )
      .run(OWNER, OPERATION);
    const replay = await attempt(request);
    expect(replay.kind).not.toBe('scored');
    expect(replay.kind).not.toBe('threw');
    expect(ticketRows(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(store.count('offline_receipt', OWNER)).toBe(1);
    expect(shotIds(store)).toEqual([analysisId]);
  });

  it('a receipt re-pointed at ANOTHER result id is never presented as this rating and never charged again', async () => {
    const { store, request } = await setup();
    network({ reserve: OFFLINE });
    scoredId(await attempt(request));
    const row = store.native
      .prepare(
        `SELECT receipt FROM offline_receipt WHERE owner_key = ? AND operation_id = ?`,
      )
      .get(OWNER, OPERATION);
    const receipt = JSON.parse(String(row?.receipt)) as Record<string, unknown>;
    store.native
      .prepare(
        `UPDATE offline_receipt SET receipt = ? WHERE owner_key = ? AND operation_id = ?`,
      )
      .run(
        JSON.stringify({
          ...receipt,
          resultId: '77777777-7777-4777-8777-777777777777',
        }),
        OWNER,
        OPERATION,
      );
    const replay = await attempt(request);
    expect(replay.kind).not.toBe('scored');
    expect(replay.kind).not.toBe('threw');
    expect(ticketRows(store)).toEqual({ spendable: 1, consumed: 1 });
    expect(store.count('offline_receipt', OWNER)).toBe(1);
  });
});

describe('attack 9 — an exhausted free allocation is not an executable grant', () => {
  it('a held free grant whose every ticket is already consumed → honest no-score path, nothing spent, no new receipt', async () => {
    const { store, request } = await setup();
    for (const [index, ticket] of ['5', '6'].entries()) {
      await consumeOfflineAllocation(
        store.db,
        {
          operationId: `${ticket.repeat(8)}-${ticket.repeat(4)}-4${ticket.repeat(3)}-8${ticket.repeat(3)}-${ticket.repeat(12)}`,
          resultId: `${ticket.repeat(8)}-${ticket.repeat(4)}-4${ticket.repeat(3)}-8${ticket.repeat(3)}-${ticket.repeat(11)}${index}`,
          fullOutputSha256: ticket.repeat(64),
        },
        reading(),
      );
    }
    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 2 });
    network({ reserve: OFFLINE });
    const outcome = await attempt(request);
    expect(outcome.kind).not.toBe('scored');
    expect(outcome.kind).not.toBe('threw');
    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 2 });
    expect(store.count('offline_receipt', OWNER)).toBe(2);
    expect(shotIds(store)).toEqual([]);
  });
});

describe('attack 10 — concurrent wallet drains for one owner', () => {
  it('two simultaneous drains present the receipt once and record the shot sync once', async () => {
    const { store, request } = await setup();
    network({ reserve: OFFLINE });
    const analysisId = scoredId(await attempt(request));
    const online = network({ reserve: OFFLINE, receipts: settleAll() });
    const [first, second] = await Promise.all([
      reconcileOfflineWallet(store.db, offlineClient(), reading()),
      reconcileOfflineWallet(store.db, offlineClient(), reading()),
    ]);
    expect(receiptPosts(online.calls)).toHaveLength(1);
    expect(first.submitted + second.submitted).toBe(1);
    expect(first.accepted + second.accepted).toBe(1);
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
    expect(await hasShotSyncReceipt(store.db, analysisId)).toBe(true);
    expect(
      Number(
        store.native
          .prepare(
            `SELECT count(*) AS n FROM sync_receipt WHERE owner_key = ? AND entity_id = ?`,
          )
          .get(OWNER, analysisId)?.n,
      ),
    ).toBe(1);
  });
});
