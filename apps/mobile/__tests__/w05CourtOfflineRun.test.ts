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
 * shot.sync does. Abstentions spend nothing, a missing grant is the honest
 * no-score path, and an explicit server refusal is never an offline case.
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
  createOfflineGrantClient,
  parseIssuedOfflineGrant,
  type IssuedOfflineGrant,
} from '../src/data/api';
import {
  holdOfflineGrant,
  pendingOfflineReceipts,
  readOfflineAllocation,
} from '../src/data/offlineCapabilities';
import { reconcileOfflineWallet } from '../src/data/offlineWallet';
import { getAnalysis, hasShotSyncReceipt } from '../src/data/repository';
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

function signIn() {
  setActiveDataOwner(OWNER);
  establishApiSession({
    canonicalAppUserId: OWNER,
    apiBaseUrl: API_ORIGIN,
    bearerToken: BEARER,
    provider: 'apple',
  });
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

type Signal = 'offline' | 'paywall' | 'online';

interface FetchCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/** The court's network: `offline` never reaches the service (the request
 * fails to leave the device); `paywall` reaches it and is REFUSED; `online`
 * answers the receipt drain. */
function court(signal: Signal, receiptStatus = 'result_recorded') {
  const calls: FetchCall[] = [];
  const fetchPort = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<
        string,
        unknown
      >;
      calls.push({ url, body });
      if (signal === 'offline') throw new TypeError('Network request failed');
      if (isReleasePolicyRequest(url))
        return response(200, activeReleaseAuthority());
      if (url.endsWith('/v1/analysis-permits')) {
        return response(402, {
          error: {
            code: 'access.paywall_required',
            message: 'Your free ratings are used. Upgrade to keep rating.',
          },
        });
      }
      if (url === RECEIPTS_ROUTE) {
        const receipts = (body.receipts ?? []) as Array<
          Record<string, unknown>
        >;
        return response(200, {
          receipts: receipts.map(entry => ({
            receiptId: (entry.receipt as Record<string, unknown>).receiptId,
            status: receiptStatus,
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

async function setup(options: {
  signal: Signal;
  policy: boolean;
  grant: boolean;
  visibility?: number | null;
}) {
  const store = createSqliteTestDb();
  const { clip, sidecar } = fixture(options.visibility ?? null);
  mockReadArtifact = async () => sidecar;
  seedSqliteCapture(store.db, OWNER, CAPTURE, clip);
  mockReading = reading();
  if (options.policy) {
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
  if (options.grant) await holdOfflineGrant(store.db, issuedGrant(), BINDING);
  const network = court(options.signal);
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
  return { store, request, network };
}

function outboxKinds(store: ReturnType<typeof createSqliteTestDb>): string[] {
  return store.native
    .prepare(`SELECT kind FROM outbox WHERE owner_key = ? ORDER BY kind`)
    .all(OWNER)
    .map(row => String(row.kind));
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

it('offline reservation failure + cached policy + executable grant → scored read, one ticket spent, receipt queued, no shot.sync row', async () => {
  const { store, request, network } = await setup({
    signal: 'offline',
    policy: true,
    grant: true,
  });
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
  // No permit traffic produced a verdict: every request failed to leave.
  expect(
    network.calls.filter(call => call.url.endsWith('/v1/analysis-permits')),
  ).toHaveLength(1);

  // Replaying the same operation returns the same read without a second
  // inference, ticket or receipt.
  const replay = await runCaptureAnalysis(request);
  expect(replay.kind).toBe('scored');
  if (replay.kind !== 'scored') return;
  expect(replay.record.result?.id).toBe(analysis.id);
  expect((await pendingOfflineReceipts(store.db)).length).toBe(1);
  expect(
    (await readOfflineAllocation(store.db, reading())).spendableTickets,
  ).toBe(1);
  expect(store.count('local_shot', OWNER)).toBe(1);
});

it('no executable grant → the existing honest no-score path, nothing persisted as a rating', async () => {
  const { store, request } = await setup({
    signal: 'offline',
    policy: true,
    grant: false,
  });
  const outcome = await runCaptureAnalysis(request);
  expect(outcome.kind).toBe('unavailable');
  expect(store.count('local_shot', OWNER)).toBe(0);
  expect(store.count('local_analysis_record', OWNER)).toBe(0);
  expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
});

it('no cached release policy → no new numeric score even with a held grant', async () => {
  const { store, request } = await setup({
    signal: 'offline',
    policy: false,
    grant: true,
  });
  const outcome = await runCaptureAnalysis(request);
  expect(outcome.kind).toBe('unavailable');
  expect(store.count('local_shot', OWNER)).toBe(0);
  expect(
    (await readOfflineAllocation(store.db, reading())).spendableTickets,
  ).toBe(2);
  expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
});

it('an abstention on the court consumes nothing and queues no receipt', async () => {
  const { store, request } = await setup({
    signal: 'offline',
    policy: true,
    grant: true,
    visibility: 0.5,
  });
  const outcome = await runCaptureAnalysis(request);
  expect(outcome.kind).toBe('low_confidence');
  const allocation = await readOfflineAllocation(store.db, reading());
  expect(allocation.spendableTickets).toBe(2);
  expect(allocation.consumedTickets).toBe(0);
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

it('the drain presents { receipt, grant, output } and an accepted verdict marks the shot synced', async () => {
  const { store, request } = await setup({
    signal: 'offline',
    policy: true,
    grant: true,
  });
  const outcome = await runCaptureAnalysis(request);
  expect(outcome.kind).toBe('scored');
  if (outcome.kind !== 'scored' || !outcome.record.result) return;
  const analysis = outcome.record.result;
  const [receipt] = await pendingOfflineReceipts(store.db);
  expect(receipt).toBeDefined();

  const online = court('online');
  const client = createOfflineGrantClient({
    baseUrl: API_ORIGIN,
    token: BEARER,
  });
  const drained = await reconcileOfflineWallet(store.db, client, reading());
  expect(drained).toMatchObject({
    submitted: 1,
    accepted: 1,
    held: 0,
    refused: 0,
    pending: 0,
  });

  const presented = online.calls.filter(call => call.url === RECEIPTS_ROUTE);
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
  expect(JSON.stringify(presented[0]!.body)).not.toContain('analysisPermitId');

  // Accepted (result_recorded): the local shot is marked synced exactly as a
  // successful shot.sync is, and the receipt is settled.
  expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(true);
  expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
  expect(outboxKinds(store)).toEqual([]);
});

it('a held verdict keeps the receipt pending and the shot unsynced', async () => {
  const { store, request } = await setup({
    signal: 'offline',
    policy: true,
    grant: true,
  });
  const outcome = await runCaptureAnalysis(request);
  expect(outcome.kind).toBe('scored');
  if (outcome.kind !== 'scored' || !outcome.record.result) return;
  court('online', 'pending');
  const client = createOfflineGrantClient({
    baseUrl: API_ORIGIN,
    token: BEARER,
  });
  const drained = await reconcileOfflineWallet(store.db, client, reading());
  expect(drained).toMatchObject({ submitted: 1, accepted: 0, held: 1 });
  expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
  expect(await hasShotSyncReceipt(store.db, outcome.record.result.id)).toBe(
    false,
  );
});

it('an explicit server refusal (paywall) is NOT an offline case: no score, nothing spent', async () => {
  const { store, request, network } = await setup({
    signal: 'paywall',
    policy: true,
    grant: true,
  });
  const outcome = await runCaptureAnalysis(request);
  expect(outcome).toMatchObject({
    kind: 'unavailable',
    cause: 'paywall_required',
  });
  expect(
    network.calls.filter(call => call.url.endsWith('/v1/analysis-permits')),
  ).toHaveLength(1);
  expect(store.count('local_shot', OWNER)).toBe(0);
  expect(
    (await readOfflineAllocation(store.db, reading())).spendableTickets,
  ).toBe(2);
  expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
});
