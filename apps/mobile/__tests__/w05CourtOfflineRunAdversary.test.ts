/**
 * W05-07 ADVERSARIAL suite (independent of the candidate's own tests).
 *
 * Attacks the court-offline scored read at its failure boundaries:
 *   A1  wire contract — the drained `output` must be the FROZEN 1.0 shape
 *       (the shot.sync payload without analysisPermitId) and the receipt's
 *       fullOutputSha256 must digest exactly that object;
 *   A2  corrupt persisted state — one unreadable local_shot payload must not
 *       starve every other queued receipt;
 *   A3  Pro lease grant (no ticket) — scored read, nothing ticket-shaped is
 *       spent, output still presented;
 *   A4  lease bound — a Pro grant whose lease outlives the verified
 *       entitlement is never held, so it can never authorize a read;
 *   A5  grant withdrawn between the authority read and the commit — no
 *       rating, nothing spent, no orphan receipt;
 *   A6  concurrency — a receipt drain racing a second offline read: every
 *       spend is backed by exactly one receipt and settles once;
 *   A7  restart after an offline abstention on the shipping path — the
 *       replay stays honest and spends nothing;
 *   A8  trusted-time boundaries (no anchor, rollback, floor-only, expired,
 *       far-future) — no offline score, nothing spent;
 *   A9  cross-account isolation — a second account on the device cannot
 *       spend the first account's grant;
 *   A10 server-answered reservation failures — 429/403 are not offline;
 *       5xx is classified as connectivity (documented observation).
 *
 * Nothing here modifies the candidate's production code or its tests.
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
  type ShotAnalysis,
} from '@pickle/shared-types';
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { CapturedClip } from '../src/camera/capture';
import {
  prepareOriginalCaptureAnalysis,
  runCaptureAnalysis,
  runOriginalCaptureAnalysis,
  type RunCaptureAnalysisOutcome,
  type RunCaptureAnalysisRequest,
} from '../src/analysis/runCaptureAnalysis';
import { OriginalAnalysisExecution } from '../src/analysis/originalAnalysisOperations';
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
import { getDb } from '../src/data/db';
import {
  holdOfflineGrant,
  pendingOfflineReceipts,
  readOfflineAllocation,
} from '../src/data/offlineCapabilities';
import { reconcileOfflineWallet } from '../src/data/offlineWallet';
import { getAnalysis, hasShotSyncReceipt } from '../src/data/repository';
import { toSyncPayload } from '../src/data/sync';
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
const CAPTURE_2 = '33333333-3333-4333-8333-333333333334';
const OPERATION = '44444444-4444-4444-8444-444444444444';
const OPERATION_2 = '44444444-4444-4444-8444-444444444445';
const API_ORIGIN = 'https://api.example.test/functions/v1/api';
const BEARER = 'fresh-owner-token';
const INSTALLATION_KEY = 'ios-install-key-1';
const KEY_ID = 'offline-grant-key-1';
const GRANT_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const PRO_GRANT_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
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
const DAY_SECONDS = 24 * 60 * 60;
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

function compactJws(claims: Record<string, unknown>): string {
  const header = { alg: 'ES256', typ: OFFLINE_GRANT_JWS_TYPE, kid: KEY_ID };
  return `${base64Url(JSON.stringify(header))}.${base64Url(
    JSON.stringify(claims),
  )}.${'A'.repeat(86)}`;
}

function baseClaims(grantId: string, expiresAt: number) {
  return {
    schemaVersion: OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
    protocolVersion: OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
    iss: API_ORIGIN,
    aud: OFFLINE_GRANT_AUDIENCE,
    sub: OWNER,
    jti: grantId,
    installationKeyId: INSTALLATION_KEY,
    iat: ISSUED_AT,
    exp: expiresAt,
    capabilities: ['analyze_joint_output'],
    release: {
      policy: ARTIFACT,
      mechanicsModel: ARTIFACT,
      benchmarkModel: ARTIFACT,
    },
  };
}

function freeGrantJws(): string {
  return compactJws({
    ...baseClaims(GRANT_ID, EXPIRES_AT),
    entitlementSource: 'identity_lifetime_free',
    allocation: {
      schemaVersion: OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION,
      allocationId: GRANT_ID,
      generation: 1,
      ticketIds: TICKETS,
      budgetPolicy: OFFLINE_FREE_ALLOCATION_POLICY.id,
      financialExpiry: 'reconciliation_only',
    },
  });
}

function parsedOrThrow(value: unknown): IssuedOfflineGrant {
  const parsed = parseIssuedOfflineGrant(value);
  if (!parsed) throw new Error('fixture grant response must parse');
  return parsed;
}

function freeGrant(): IssuedOfflineGrant {
  return parsedOrThrow({
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
      compactJws: freeGrantJws(),
    },
  });
}

/** A Pro (verified_store) lease: no tickets, bounded by the verified
 * entitlement expiry the server restates in the clear. */
function proGrant(options: {
  expiresAt: number;
  entitlementExpiresAt: number;
}): IssuedOfflineGrant {
  return parsedOrThrow({
    grantId: PRO_GRANT_ID,
    generation: 1,
    entitlementSource: 'verified_store',
    issuedAt: ISSUED_AT,
    expiresAt: options.expiresAt,
    entitlementExpiresAt: options.entitlementExpiresAt,
    ticketIds: [],
    keyId: KEY_ID,
    grant: {
      schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
      compactJws: compactJws({
        ...baseClaims(PRO_GRANT_ID, options.expiresAt),
        entitlementSource: 'verified_store',
        lease: {
          schemaVersion: OFFLINE_PRO_LEASE_SCHEMA_VERSION,
          kind: 'subscription',
          verifiedEntitlementExpiresAt: options.entitlementExpiresAt,
        },
      }),
    },
  });
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

function fixture(visibility: number | null = null, name = 'court') {
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
    uri: `file:///private/captures/${name}.mov`,
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
      uri: `file:///private/captures/${name}.pose.json`,
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

interface FetchCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/** No signal: nothing leaves the device. */
function offlineCourt() {
  const calls: FetchCall[] = [];
  globalThis.fetch = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      throw new TypeError('Network request failed');
    },
  ) as unknown as typeof fetch;
  return { calls };
}

/** Signal restored for the receipt drain only: every presented receipt is
 * answered with `status`; permits still cannot be reserved (the drain and a
 * court read may overlap). */
function drainOnlyCourt(status = 'result_recorded') {
  const calls: FetchCall[] = [];
  globalThis.fetch = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<
        string,
        unknown
      >;
      calls.push({ url, body });
      if (isReleasePolicyRequest(url))
        return response(200, activeReleaseAuthority());
      if (url === PERMITS_ROUTE) throw new TypeError('Network request failed');
      if (url === RECEIPTS_ROUTE) {
        const receipts = (body.receipts ?? []) as Array<
          Record<string, unknown>
        >;
        return response(200, {
          receipts: receipts.map(entry => ({
            receiptId: (entry.receipt as Record<string, unknown>).receiptId,
            status,
          })),
          rejected: [],
        });
      }
      return response(404, { error: { code: 'not_found' } });
    },
  ) as unknown as typeof fetch;
  return { calls };
}

type Store = ReturnType<typeof createSqliteTestDb>;

async function cachePolicy(store: Store) {
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

function requestFor(
  store: Store,
  clip: CapturedClip,
  captureId: string,
  operationId: string,
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

async function setup(options: {
  grant: IssuedOfflineGrant | null;
  visibility?: number | null;
}) {
  const store = createSqliteTestDb();
  const first = fixture(options.visibility ?? null, 'court');
  const second = fixture(options.visibility ?? null, 'court-2');
  mockReadArtifact = async uri =>
    uri === second.clip.poseSequence?.uri ? second.sidecar : first.sidecar;
  seedSqliteCapture(store.db, OWNER, CAPTURE, first.clip);
  seedSqliteCapture(store.db, OWNER, CAPTURE_2, second.clip);
  mockReading = reading();
  await cachePolicy(store);
  if (options.grant) await holdOfflineGrant(store.db, options.grant, BINDING);
  const network = offlineCourt();
  return {
    store,
    network,
    request: requestFor(store, first.clip, CAPTURE, OPERATION),
    secondRequest: requestFor(store, second.clip, CAPTURE_2, OPERATION_2),
  };
}

function outboxKinds(store: Store): string[] {
  return store.native
    .prepare(`SELECT kind FROM outbox WHERE owner_key = ? ORDER BY kind`)
    .all(OWNER)
    .map(row => String(row.kind));
}

function receiptRows(store: Store) {
  return store.native
    .prepare(
      `SELECT receipt_id, grant_id, operation_id, settlement FROM offline_receipt
       WHERE owner_key = ? ORDER BY lifecycle_sequence ASC`,
    )
    .all(OWNER);
}

function ticketRows(store: Store) {
  return store.native
    .prepare(
      `SELECT ticket_id, state, receipt_id FROM offline_ticket
       WHERE owner_key = ? ORDER BY ticket_id ASC`,
    )
    .all(OWNER);
}

function scored(outcome: RunCaptureAnalysisOutcome): ShotAnalysis {
  expect(outcome.kind).toBe('scored');
  if (outcome.kind !== 'scored' || !outcome.record.result)
    throw new Error('a scored outcome carries its analysis');
  return outcome.record.result;
}

function drainClient() {
  return createOfflineGrantClient({ baseUrl: API_ORIGIN, token: BEARER });
}

function presentedEntries(calls: readonly FetchCall[]) {
  return calls
    .filter(call => call.url === RECEIPTS_ROUTE)
    .flatMap(
      call => (call.body.receipts ?? []) as Array<Record<string, unknown>>,
    );
}

/** The FROZEN 1.0 output: the shot.sync payload the outbox would carry for
 * this shot (apps/mobile/src/data/sync.ts toSyncPayload) WITHOUT
 * analysisPermitId — the shape supabase/functions/api admits under the sync
 * ingress rules (parseSyncShot: `capturedAt`, `confidence`, no
 * `capturedAtIso` / `analysisConfidence` / `handedness` / `measurements`). */
function frozenOutput(analysis: ShotAnalysis): Record<string, unknown> {
  const { analysisPermitId: _permit, ...output } = toSyncPayload(
    analysis,
    '00000000-0000-4000-8000-000000000000',
  );
  return output;
}

const leases: OriginalAnalysisExecution[] = [];

async function setupOriginal(visibility: number | null) {
  const store = createSqliteTestDb();
  const { clip: bare, sidecar } = fixture(visibility);
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
  await holdOfflineGrant(store.db, freeGrant(), BINDING);
  const network = offlineCourt();
  const request: Omit<RunCaptureAnalysisRequest, 'ownerContext'> = {
    db: store.db,
    captureId: CAPTURE,
    clip,
    declaredStroke: 'forehand_drive',
    declaredCanonical: 'FOREHAND_DRIVE',
    handedness: 'right',
    cameraView: 'side',
    apiConfig: { baseUrl: API_ORIGIN, token: BEARER },
    appVersion: '0.1.0',
  };
  /** One app process: a fresh execution lease per launch. */
  const launch = async (): Promise<RunCaptureAnalysisOutcome> => {
    const execution = new OriginalAnalysisExecution(
      captureDataOwnerContext(),
      API_ORIGIN,
    );
    leases.push(execution);
    const operation = await prepareOriginalCaptureAnalysis(
      { ...request, ownerContext: execution.ownerContext },
      execution,
      OPERATION,
    );
    return runOriginalCaptureAnalysis({
      db: store.db,
      execution,
      operationId: operation.operationId,
    });
  };
  return { store, launch, network };
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

describe('A1 — wire contract: output is the frozen 1.0 shot payload', () => {
  it('the drained output is the shot.sync payload without analysisPermitId, and the receipt digest binds exactly that object', async () => {
    const { store, request } = await setup({ grant: freeGrant() });
    const analysis = scored(await runCaptureAnalysis(request));
    const [receipt] = await pendingOfflineReceipts(store.db);
    expect(receipt).toBeDefined();
    const frozen = frozenOutput(analysis);

    // The digest the ticket was spent under must be the digest of the
    // frozen output — the server verifies the delivered object against it.
    expect(receipt!.fullOutputSha256).toBe(
      sha256Hex(originalCanonicalJson(frozen)),
    );

    const online = drainOnlyCourt();
    await reconcileOfflineWallet(store.db, drainClient(), reading());
    const [entry] = presentedEntries(online.calls);
    expect(entry).toBeDefined();
    expect(entry!.output).toEqual(frozen);
  });

  it('the drained output carries no field the sync ingress refuses', async () => {
    const { store, request } = await setup({ grant: freeGrant() });
    scored(await runCaptureAnalysis(request));
    const online = drainOnlyCourt();
    await reconcileOfflineWallet(store.db, drainClient(), reading());
    const [entry] = presentedEntries(online.calls);
    const output = entry!.output as Record<string, unknown>;
    // parseSyncShot (supabase/functions/api/index.ts) demands `capturedAt`
    // and `confidence` and knows nothing of the on-device record's
    // `capturedAtIso` / `analysisConfidence` / `handedness` / `measurements`
    // / `guidance` / `priorityFix`; a foreign key set is refused, and a
    // refused output is HELD as evidence_ambiguous with the ticket reserved.
    expect(Object.keys(output).sort()).toEqual(
      Object.keys(frozenOutput(scoredShot(store, output.id))).sort(),
    );
    expect(output).toHaveProperty('capturedAt');
    expect(output).toHaveProperty('confidence');
    expect(output).not.toHaveProperty('capturedAtIso');
    expect(output).not.toHaveProperty('analysisConfidence');
  });
});

function scoredShot(store: Store, id: unknown): ShotAnalysis {
  const row = store.native
    .prepare(`SELECT payload FROM local_shot WHERE owner_key = ? AND id = ?`)
    .get(OWNER, String(id));
  if (!row) throw new Error('the rated shot must be persisted');
  return JSON.parse(String(row.payload)) as ShotAnalysis;
}

describe('A2 — corrupt persisted state during the drain', () => {
  it('one unreadable local_shot payload does not starve the other queued receipts', async () => {
    const { store, request, secondRequest } = await setup({
      grant: freeGrant(),
    });
    const first = scored(await runCaptureAnalysis(request));
    const second = scored(await runCaptureAnalysis(secondRequest));
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(2);

    // The first rated shot's payload is damaged on disk (not JSON).
    store.native
      .prepare(
        `UPDATE local_shot SET payload = 'not json' WHERE owner_key = ? AND id = ?`,
      )
      .run(OWNER, first.id);

    const online = drainOnlyCourt();
    const drained = await reconcileOfflineWallet(
      store.db,
      drainClient(),
      reading(),
    );
    // The damaged shot is honestly presented without output (the server is
    // told the device no longer holds it); the intact one still settles.
    const entries = presentedEntries(online.calls);
    const byReceipt = new Map(
      entries.map(entry => [
        (entry.receipt as Record<string, unknown>).resultId,
        entry.output,
      ]),
    );
    expect(byReceipt.get(first.id)).toBeNull();
    expect(byReceipt.get(second.id)).not.toBeNull();
    expect(drained.submitted).toBe(2);
    expect(await hasShotSyncReceipt(store.db, second.id)).toBe(true);
  });
});

describe('A3 — Pro lease (no ticket) court-offline read', () => {
  it('scores under a verified_store lease, spends no ticket, queues a ticket-less receipt with output', async () => {
    const grant = proGrant({
      expiresAt: ISSUED_AT + 3 * DAY_SECONDS,
      entitlementExpiresAt: ISSUED_AT + 30 * DAY_SECONDS,
    });
    const { store, request, secondRequest } = await setup({ grant });
    const first = scored(await runCaptureAnalysis(request));
    const second = scored(await runCaptureAnalysis(secondRequest));
    expect(first.id).not.toBe(second.id);

    const receipts = await pendingOfflineReceipts(store.db);
    expect(receipts).toHaveLength(2);
    for (const receipt of receipts) {
      expect(receipt.ticket).toBeNull();
      expect(receipt.grantId).toBe(PRO_GRANT_ID);
      expect(receipt.billingDisposition).toBe('joint_verification_required');
    }
    expect(new Set(receipts.map(r => r.lifecycleSequence)).size).toBe(2);
    expect(ticketRows(store)).toEqual([]);
    const allocation = await readOfflineAllocation(store.db, reading());
    expect(allocation.spendableTickets).toBe(0);
    expect(allocation.consumedTickets).toBe(0);
    expect(store.count('local_shot', OWNER)).toBe(2);
    expect(outboxKinds(store)).toEqual([]);

    const online = drainOnlyCourt();
    const drained = await reconcileOfflineWallet(
      store.db,
      drainClient(),
      reading(),
    );
    expect(drained).toMatchObject({ submitted: 2, accepted: 2 });
    for (const entry of presentedEntries(online.calls)) {
      expect(entry.output).not.toBeNull();
      expect((entry.receipt as Record<string, unknown>).ticket).toBeNull();
    }
    expect(await hasShotSyncReceipt(store.db, first.id)).toBe(true);
    expect(await hasShotSyncReceipt(store.db, second.id)).toBe(true);
  });
});

describe('A4 — Pro lease bound (<= verified entitlement expiry)', () => {
  it('a lease that outlives the verified entitlement is never held, so it never authorizes a read', async () => {
    const store = createSqliteTestDb();
    const { clip, sidecar } = fixture();
    mockReadArtifact = async () => sidecar;
    seedSqliteCapture(store.db, OWNER, CAPTURE, clip);
    mockReading = reading();
    await cachePolicy(store);
    const overreaching = proGrant({
      expiresAt: ISSUED_AT + 3 * DAY_SECONDS,
      entitlementExpiresAt: ISSUED_AT + 2 * DAY_SECONDS,
    });
    await expect(
      holdOfflineGrant(store.db, overreaching, BINDING),
    ).rejects.toThrow();
    expect(store.count('offline_grant', OWNER)).toBe(0);

    offlineCourt();
    const outcome = await runCaptureAnalysis(
      requestFor(store, clip, CAPTURE, OPERATION),
    );
    expect(outcome.kind).toBe('unavailable');
    expect(store.count('local_shot', OWNER)).toBe(0);
    expect(receiptRows(store)).toEqual([]);
  });

  it('a lease longer than seven days is never held', async () => {
    const store = createSqliteTestDb();
    const tooLong = proGrant({
      expiresAt: ISSUED_AT + 7 * DAY_SECONDS + 1,
      entitlementExpiresAt: ISSUED_AT + 30 * DAY_SECONDS,
    });
    await expect(
      holdOfflineGrant(store.db, tooLong, BINDING),
    ).rejects.toThrow();
    expect(store.count('offline_grant', OWNER)).toBe(0);
  });
});

describe('A5 — grant withdrawn between the authority read and the commit', () => {
  it('produces no rating, spends nothing and leaves no orphan receipt', async () => {
    const { store, request } = await setup({ grant: freeGrant() });
    // The authority read ends with the pending-receipt count; when that
    // read's transaction commits, the wallet drops the grant (as a
    // concurrent wallet reconciliation replacing a withdrawn grant would)
    // before the commit transaction opens.
    let armed = false;
    let withdrawn = false;
    store.observeStatements(call => {
      if (call.sql.includes('COUNT(*) AS pending FROM offline_receipt'))
        armed = true;
      if (armed && !withdrawn && call.sql === 'COMMIT') {
        withdrawn = true;
        store.native
          .prepare(`DELETE FROM offline_ticket WHERE owner_key = ?`)
          .run(OWNER);
        store.native
          .prepare(`DELETE FROM offline_grant WHERE owner_key = ?`)
          .run(OWNER);
      }
    });

    let outcome: RunCaptureAnalysisOutcome | null = null;
    let failure: unknown = null;
    try {
      outcome = await runCaptureAnalysis(request);
    } catch (error) {
      failure = error;
    }
    store.observeStatements(null);
    expect(withdrawn).toBe(true);
    if (outcome !== null) expect(outcome.kind).not.toBe('scored');
    else expect(failure).toBeTruthy();

    // Nothing rated, nothing spent, no receipt naming a grant that is gone.
    expect(
      store.native
        .prepare(
          `SELECT count(*) AS n FROM local_shot WHERE owner_key = ? AND result_kind = 'scored'`,
        )
        .get(OWNER)?.n,
    ).toBe(0);
    expect(receiptRows(store)).toEqual([]);
    expect(store.count('offline_grant', OWNER)).toBe(0);
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
  });
});

describe('A6 — a receipt drain racing a second court read', () => {
  it('every spend is backed by exactly one receipt; each settles once; tickets conserve', async () => {
    const { store, request, secondRequest } = await setup({
      grant: freeGrant(),
    });
    const first = scored(await runCaptureAnalysis(request));
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);

    const online = drainOnlyCourt();
    const [drained, outcome] = await Promise.all([
      reconcileOfflineWallet(store.db, drainClient(), reading()),
      runCaptureAnalysis(secondRequest),
    ]);
    const second = scored(outcome);
    expect(second.id).not.toBe(first.id);
    expect(drained.submitted).toBeGreaterThanOrEqual(1);
    expect(drained.refused).toBe(0);

    const rows = receiptRows(store);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(row => row.receipt_id)).size).toBe(2);
    expect(rows.map(row => row.operation_id).sort()).toEqual(
      [OPERATION, OPERATION_2].sort(),
    );
    const tickets = ticketRows(store);
    expect(tickets.map(row => row.state)).toEqual(['consumed', 'consumed']);
    expect(new Set(tickets.map(row => row.receipt_id)).size).toBe(2);
    const allocation = await readOfflineAllocation(store.db, reading());
    expect(allocation.spendableTickets).toBe(0);
    expect(allocation.consumedTickets).toBe(2);

    // The second drain settles whatever the first one did not; nothing is
    // presented twice after acceptance.
    await reconcileOfflineWallet(store.db, drainClient(), reading());
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
    const presentedIds = presentedEntries(online.calls).map(
      entry => (entry.receipt as Record<string, unknown>).receiptId,
    );
    expect(new Set(presentedIds).size).toBe(presentedIds.length);
    expect(presentedIds).toHaveLength(2);
    expect(await hasShotSyncReceipt(store.db, first.id)).toBe(true);
    expect(await hasShotSyncReceipt(store.db, second.id)).toBe(true);
    expect(await getAnalysis(store.db, second.id)).toEqual(second);
  });
});

function expectNothingSpent(store: Store) {
  expect(ticketRows(store).map(row => row.state)).toEqual([
    'remaining',
    'remaining',
  ]);
  expect(receiptRows(store)).toEqual([]);
  expect(
    store.native
      .prepare(
        `SELECT count(*) AS n FROM local_shot WHERE owner_key = ? AND result_kind = 'scored'`,
      )
      .get(OWNER)?.n,
  ).toBe(0);
}

describe('A8 — trusted-time boundaries: no offline score on uncertain time', () => {
  const cases: ReadonlyArray<[string, TrustedTimeReading]> = [
    [
      'no trusted anchor (raw wall clock)',
      { ...reading(), authority: 'none', continuity: 'none', storage: 'empty' },
    ],
    ['a detected clock rollback', { ...reading(), rollbackDetected: true }],
    [
      'a floor-only reading (lower bound, cannot prove the lease active)',
      { ...reading(), authority: 'floor', continuity: 'persisted' },
    ],
    [
      'trusted time past the grant expiry while the wall clock is rolled back',
      {
        ...reading(EXPIRES_AT * 1000 + 1_000),
        wallClockMs: NOW_MS,
        rollbackDetected: false,
      },
    ],
    [
      'trusted time far in the future (NaN-free but past every lease)',
      reading((EXPIRES_AT + 400 * DAY_SECONDS) * 1000),
    ],
  ];
  it.each(cases)('%s → honest no-score, nothing spent', async (_, when) => {
    const { store, request } = await setup({ grant: freeGrant() });
    mockReading = when;
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).not.toBe('scored');
    expectNothingSpent(store);
  });

  it('an anchored reading with unmeasured continuity is active per evaluateLease and rates offline (documented observation)', async () => {
    const { store, request } = await setup({ grant: freeGrant() });
    mockReading = { ...reading(), continuity: 'unmeasured' };
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).toBe('scored');
    expect(receiptRows(store)).toHaveLength(1);
  });
});

describe('A9 — cross-account isolation on a shared device', () => {
  const OTHER = '22222222-2222-4222-8222-222222222222';
  it("a second signed-in account cannot spend the first account's held grant", async () => {
    const { store } = await setup({ grant: freeGrant() });
    // Account switch on the same device: the other owner has a capture and
    // the same cached release authority, but no grant of their own.
    clearApiSession();
    setActiveDataOwner(OTHER);
    establishApiSession({
      canonicalAppUserId: OTHER,
      apiBaseUrl: API_ORIGIN,
      bearerToken: 'other-owner-token',
      provider: 'google',
    });
    const other = fixture(null, 'other-court');
    mockReadArtifact = async () => other.sidecar;
    const otherCapture = '33333333-3333-4333-8333-333333333340';
    seedSqliteCapture(store.db, OTHER, otherCapture, other.clip);
    const verified = verifyReleasePolicy(activeReleaseAuthority().policy);
    if (!verified.ok) throw new Error('fixture policy must verify');
    await writeCachedReleasePolicy(
      store.db,
      { ownerKey: OTHER, apiOrigin: API_ORIGIN },
      { policy: verified.policy, serverTime: Math.floor(NOW_MS / 1000) },
    );
    offlineCourt();
    const outcome = await runCaptureAnalysis({
      ...requestFor(store, other.clip, otherCapture, OPERATION_2),
      ownerContext: captureDataOwnerContext(),
      apiConfig: { baseUrl: API_ORIGIN, token: 'other-owner-token' },
    });
    expect(outcome.kind).not.toBe('scored');
    expectNothingSpent(store);
    expect(store.count('offline_receipt', OTHER)).toBe(0);
    expect(store.count('local_shot', OTHER)).toBe(0);
    expect(
      store.native
        .prepare(`SELECT count(*) AS n FROM offline_grant WHERE owner_key = ?`)
        .get(OTHER)?.n,
    ).toBe(0);
  });
});

describe('A10 — reservation answered by the server: what counts as offline', () => {
  function permitAnswers(status: number, body: unknown, retryAfter?: string) {
    globalThis.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (isReleasePolicyRequest(url))
        return response(200, activeReleaseAuthority());
      if (url === PERMITS_ROUTE) {
        return {
          ok: false,
          status,
          statusText: String(status),
          headers: {
            get: (name: string) =>
              name.toLowerCase() === 'retry-after'
                ? (retryAfter ?? null)
                : null,
          },
          json: async () => body,
        } as unknown as Response;
      }
      return response(404, { error: { code: 'not_found' } });
    }) as unknown as typeof fetch;
  }

  it('429 + Retry-After is a server answer, not connectivity: no offline score, nothing spent', async () => {
    const { store, request } = await setup({ grant: freeGrant() });
    permitAnswers(429, { error: { code: 'rate_limited' } }, '30');
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).not.toBe('scored');
    expectNothingSpent(store);
  });

  it('an explicit 403 refusal is not connectivity: no offline score, nothing spent', async () => {
    const { store, request } = await setup({ grant: freeGrant() });
    permitAnswers(403, { error: { code: 'access.forbidden' } });
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).not.toBe('scored');
    expectNothingSpent(store);
  });

  it('a 5xx from a reachable server is classified as connectivity and rates offline (documented observation)', async () => {
    const { store, request } = await setup({ grant: freeGrant() });
    permitAnswers(503, { error: { code: 'service_unavailable' } });
    const outcome = await runCaptureAnalysis(request);
    expect(outcome.kind).toBe('scored');
    expect(receiptRows(store)).toHaveLength(1);
    expect(ticketRows(store).map(row => row.state)).toEqual([
      'consumed',
      'remaining',
    ]);
  });
});

describe('A7 — restart after an offline abstention on the shipping path', () => {
  it('the relaunch replays honestly and spends nothing', async () => {
    const { store, launch } = await setupOriginal(0.5);
    const first = await launch();
    expect(first.kind).toBe('low_confidence');
    expect(ticketRows(store).map(row => row.state)).toEqual([
      'remaining',
      'remaining',
    ]);
    expect(receiptRows(store)).toEqual([]);

    // The app is relaunched on the same court (still no signal).
    const second = await launch();
    expect(['low_confidence', 'unavailable']).toContain(second.kind);
    expect(ticketRows(store).map(row => row.state)).toEqual([
      'remaining',
      'remaining',
    ]);
    expect(receiptRows(store)).toEqual([]);
    expect(
      store.native
        .prepare(
          `SELECT count(*) AS n FROM local_shot WHERE owner_key = ? AND result_kind = 'scored'`,
        )
        .get(OWNER)?.n,
    ).toBe(0);
    expect(outboxKinds(store)).toEqual([]);
  });
});
