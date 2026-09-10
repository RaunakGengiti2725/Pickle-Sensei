/**
 * W05-07 adversarial suite, round 4 — attacks the court-offline scored read
 * of candidate 1e9124bd at boundaries the earlier attack suites leave
 * uncovered. Every test states the invariant it expects the candidate to
 * hold; a failing test here is a confirmed break of that invariant.
 *
 * Categories: account deletion (owner purge) over the offline wallet,
 * concurrency (two captures racing for the last ticket), lease expiry
 * between the authority read and the commit, the repository's offline
 * persistence contract at its identity boundaries, duplicate / foreign
 * receipt identities in the server's verdict batch, tampered ticket state,
 * an account switch between the drain's submit and apply steps, and the
 * honesty of the Result surface for a shot the receipt (not the outbox)
 * carries — queued, held and refused.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {
  OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
  OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
  OFFLINE_FREE_ALLOCATION_POLICY,
  OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION,
  OFFLINE_GRANT_AUDIENCE,
  OFFLINE_GRANT_JWS_TYPE,
  OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
  type ShotAnalysis,
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
  readOfflineWalletJournal,
  readOfflineWalletStatus,
  reconcileOfflineWallet,
} from '../src/data/offlineWallet';
import { getDb } from '../src/data/db';
import {
  hasShotSyncReceipt,
  purgeOwnerData,
  saveOfflineAnalysis,
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
import { ResultDetailsScreen } from '../src/screens/ResultDetailsScreen';

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
let mockOnTrustedTimeRead: (() => void) | null = null;

jest.mock('../src/data/trustedTime', () => {
  const actual = jest.requireActual<typeof import('../src/data/trustedTime')>(
    '../src/data/trustedTime',
  );
  return {
    ...actual,
    trustedTime: {
      ...actual.trustedTime,
      read: async () => {
        mockOnTrustedTimeRead?.();
        if (!mockReading) throw new Error('trusted time not configured');
        return mockReading;
      },
    },
  };
});

// Result surface host: the same module boundary the fix-12 honesty suite
// drives, but over the REAL SQLite store the offline run wrote to.
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});
const mockRoute = { params: { analysisId: '' } };
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: jest.fn(),
    goBack: jest.fn(),
    popTo: jest.fn(),
    popToTop: jest.fn(),
    replace: jest.fn(),
  }),
  useRoute: () => mockRoute,
}));
const mockLoadEvidence = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../src/components/strokeResultData', () => ({
  loadStrokeResultEvidence: (...args: unknown[]) => mockLoadEvidence(...args),
}));
const mockTrainingState = {
  planStatus: 'ready',
  currentPlan: null,
  planError: null,
  mutation: 'idle',
  mutationError: null,
  drillDetails: {},
  loadCurrentPlan: jest.fn(async () => {}),
  createPlan: jest.fn(async () => {}),
  reassessCurrentPlan: jest.fn(async () => {}),
  setDrillSaved: jest.fn(async () => {}),
  completePlanItem: jest.fn(async () => {}),
  clearMutationError: jest.fn(),
};
jest.mock('../src/training/store', () => ({
  useTrainingStore: (selector: (s: typeof mockTrainingState) => unknown) =>
    selector(mockTrainingState),
}));
jest.mock('../src/consistency/store', () => {
  const state = { refresh: jest.fn(async () => {}) };
  return {
    useConsistencyStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});
jest.mock('../src/consistency/DaySecuredBanner', () => ({
  DaySecuredBanner: () => null,
}));
jest.mock('../src/components/AnalysisFeedbackPrompt', () => ({
  AnalysisFeedbackPrompt: () => null,
}));

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CAPTURE = '33333333-3333-4333-8333-333333333333';
const SECOND_CAPTURE = '33333333-3333-4333-8333-333333333334';
const OPERATION = '44444444-4444-4444-8444-444444444444';
const SECOND_OPERATION = '44444444-4444-4444-8444-444444444445';
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
const WALLET_TABLES = [
  'offline_grant',
  'offline_ticket',
  'offline_receipt',
  'offline_wallet_journal',
] as const;
const UNVERIFIABLE_COPY = 'could not verify whether this shot reached';
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

function fixture(
  visibility: number | null = null,
  uri = 'file:///private/captures/court.mov',
) {
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
    redirected: false,
    type: 'basic',
    url: '',
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    json: async () => body,
  } as unknown as Response;
}

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

type ReceiptsAnswer = (call: FetchCall) => Response | 'offline';

/** A scripted court network: the permit reservation always fails for
 * connectivity, the release policy is unreachable, `receipts` decides the
 * drain and everything else answers 404. */
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
        const answer = options.receipts ? options.receipts(call) : 'offline';
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

function answerAll(status = 'result_recorded'): ReceiptsAnswer {
  return call =>
    response(200, {
      receipts: presentedIds(call).map(receiptId => ({ receiptId, status })),
      rejected: [],
    });
}

function refuseAll(code = 'offline.invalid_input'): ReceiptsAnswer {
  return call =>
    response(200, {
      receipts: [],
      rejected: presentedIds(call).map(receiptId => ({ receiptId, code })),
    });
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

async function seed(options: {
  ticketIds?: readonly string[];
  visibility?: number | null;
  reading?: TrustedTimeReading;
}) {
  const store = createSqliteTestDb();
  const { clip, sidecar } = fixture(options.visibility ?? null);
  const artifacts = new Map<string, string>();
  registerArtifact(artifacts, clip, sidecar);
  mockReadArtifact = async uri => {
    const found = artifacts.get(uri);
    if (found === undefined) throw new Error(`no artifact for ${uri}`);
    return found;
  };
  seedSqliteCapture(store.db, OWNER, CAPTURE, clip);
  mockReading = options.reading ?? reading();
  await cachePolicy(store);
  await holdOfflineGrant(
    store.db,
    issuedGrant(OWNER, GRANT_ID, options.ticketIds ?? TICKETS),
    BINDING,
  );
  const request = requestFor(store, clip);
  return { store, request, clip, artifacts };
}

/** The runtime reads the pose sidecar by the clip's pose-sequence uri. */
function registerArtifact(
  artifacts: Map<string, string>,
  clip: CapturedClip,
  sidecar: string,
): void {
  artifacts.set(clip.uri, sidecar);
  if (clip.poseSequence) artifacts.set(clip.poseSequence.uri, sidecar);
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

function receiptPosts(calls: readonly FetchCall[]): FetchCall[] {
  return calls.filter(call => call.url === RECEIPTS_ROUTE);
}

async function scoredOffline(store: Store, request: RunCaptureAnalysisRequest) {
  network();
  const outcome = await runCaptureAnalysis(request);
  expect(outcome.kind).toBe('scored');
  if (outcome.kind !== 'scored' || !outcome.record.result) {
    throw new Error('precondition: the court-offline read must score');
  }
  const [receipt] = await pendingOfflineReceipts(store.db);
  if (!receipt) throw new Error('precondition: one receipt is queued');
  expect(receipt.resultId).toBe(outcome.record.result.id);
  return { analysis: outcome.record.result, receipt };
}

function walletRows(store: Store, owner: string): Record<string, number> {
  return Object.fromEntries(
    WALLET_TABLES.map(table => [table, store.count(table, owner)]),
  );
}

function textOf(renderer: TestRenderer.ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object' && 'children' in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer.toJSON());
  return out.join(' ');
}

/** Render the Result breakdown for `analysis` over the real store, letting
 * the evidence → receipt → outbox lookups settle against SQLite. */
async function renderResult(store: Store, analysis: ShotAnalysis) {
  (getDb as jest.Mock).mockReturnValue(store.db);
  mockRoute.params = { analysisId: analysis.id };
  mockLoadEvidence.mockResolvedValue({
    analysis,
    record: null,
    clip: null,
    review: null,
    attempts: [],
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<ResultDetailsScreen />);
  });
  for (let i = 0; i < 12; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  return renderer;
}

beforeEach(() => {
  signIn();
});
afterEach(() => {
  clearApiSession();
  (getDb as jest.Mock).mockReset();
  mockLoadEvidence.mockReset();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  globalThis.fetch = originalFetch;
  mockReading = null;
  mockOnTrustedTimeRead = null;
  jest.restoreAllMocks();
  jest.useRealTimers();
  closeSqliteTestDatabases();
});

describe('R1 account deletion over the offline wallet', () => {
  // `purgeOwnerData` is what authStore runs after the server confirms the
  // account deletion: "no analysis history, outbox entry, or cached profile
  // survives on the device". The receipt names the deleted account's rating
  // (result id, output digest, operation id); the grant carries its signed
  // claims. None of it may outlive the account on the device.
  it('the purge that follows a confirmed account deletion removes every offline wallet row of the deleted owner', async () => {
    const { store, request } = await seed({});
    const { analysis } = await scoredOffline(store, request);
    const before = walletRows(store, OWNER);
    expect(before.offline_receipt).toBe(1);
    expect(before.offline_grant).toBe(1);
    expect(before.offline_ticket).toBe(2);

    await purgeOwnerData(store.db, OWNER);

    expect(store.count('local_shot', OWNER)).toBe(0);
    expect(store.count('local_analysis_record', OWNER)).toBe(0);
    expect(store.count('analysis_run_journal', OWNER)).toBe(0);
    // The deleted account's receipt, grant and tickets: nothing survives.
    expect(walletRows(store, OWNER)).toEqual({
      offline_grant: 0,
      offline_ticket: 0,
      offline_receipt: 0,
      offline_wallet_journal: 0,
    });
    // Nothing of the deleted rating can be presented to the server later.
    signIn();
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(0);
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);
  });

  it('the purge of one owner leaves the OTHER owner’s wallet untouched', async () => {
    const { store, request } = await seed({});
    await scoredOffline(store, request);
    signIn(OTHER);
    await cachePolicy(store, OTHER);
    await holdOfflineGrant(
      store.db,
      issuedGrant(OTHER, OTHER_GRANT_ID, OTHER_TICKETS),
      BINDING,
    );
    const otherBefore = walletRows(store, OTHER);
    expect(otherBefore.offline_grant).toBe(1);

    await purgeOwnerData(store.db, OWNER);

    expect(walletRows(store, OTHER)).toEqual(otherBefore);
    expect(await tickets(store)).toEqual({ spendable: 2, consumed: 0 });
  });
});

describe('R2 two captures racing for the last ticket', () => {
  it('exactly one of two simultaneous different-capture runs spends the single remaining ticket; the other spends nothing and is not scored', async () => {
    const { store, request, artifacts } = await seed({
      ticketIds: [TICKETS[0]],
    });
    const second = fixture(null, 'file:///private/captures/court-2.mov');
    registerArtifact(artifacts, second.clip, second.sidecar);
    seedSqliteCapture(store.db, OWNER, SECOND_CAPTURE, second.clip);
    const secondRequest = requestFor(
      store,
      second.clip,
      SECOND_OPERATION,
      SECOND_CAPTURE,
    );
    network();
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 0 });

    const settled = await Promise.allSettled([
      runCaptureAnalysis(request),
      runCaptureAnalysis(secondRequest),
    ]);
    const scored = settled.filter(
      entry => entry.status === 'fulfilled' && entry.value.kind === 'scored',
    );
    expect(scored).toHaveLength(1);

    // One ticket, one receipt, one scored shot — never two receipts naming
    // the same ticket, never a scored shot without a receipt.
    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 1 });
    expect(store.count('offline_receipt', OWNER)).toBe(1);
    const scoredShots = store.native
      .prepare(
        `SELECT id FROM local_shot WHERE owner_key = ? AND result_kind = 'scored'`,
      )
      .all(OWNER);
    expect(scoredShots).toHaveLength(1);
    const [receipt] = await pendingOfflineReceipts(store.db);
    expect(receipt?.resultId).toBe(String(scoredShots[0]!.id));
    expect(store.count('outbox', OWNER)).toBe(0);

    // The loser must have failed honestly: no scored shot persisted for it
    // and no journal row of either run claims a result the receipt did not
    // pay for.
    const loser = settled.find(
      entry => !(entry.status === 'fulfilled' && entry.value.kind === 'scored'),
    );
    expect(loser).toBeDefined();
    const claimed = store.native
      .prepare(
        `SELECT result_id FROM analysis_run_journal
         WHERE owner_key = ? AND result_id IS NOT NULL`,
      )
      .all(OWNER)
      .map(row => String(row.result_id));
    expect(claimed.filter(id => id !== receipt?.resultId)).toEqual([]);
  });
});

describe('R3 the lease expires between the authority read and the commit', () => {
  it('a grant that expires while the on-device analysis runs never spends more than once and leaves the ledger coherent', async () => {
    // First trusted read (the authority check) lands one second before the
    // grant's exp; every later read is a minute past it.
    const beforeExpiry = reading(EXPIRES_AT * 1000 - 1000);
    const afterExpiry = reading(EXPIRES_AT * 1000 + 60_000);
    const { store, request } = await seed({ reading: beforeExpiry });
    let reads = 0;
    mockOnTrustedTimeRead = () => {
      reads += 1;
      if (reads > 1) mockReading = afterExpiry;
    };
    network();
    const outcome = await runCaptureAnalysis(request).catch(
      (error: unknown) => error,
    );
    const ledger = await tickets(store, afterExpiry);
    const receipts = store.count('offline_receipt', OWNER);
    const scoredShots = store.native
      .prepare(
        `SELECT id FROM local_shot WHERE owner_key = ? AND result_kind = 'scored'`,
      )
      .all(OWNER).length;
    if (
      typeof outcome === 'object' &&
      outcome !== null &&
      'kind' in outcome &&
      outcome.kind === 'scored'
    ) {
      // Paid exactly once, and the payment is queued for the server.
      expect(ledger).toEqual({ spendable: 1, consumed: 1 });
      expect(receipts).toBe(1);
      expect(scoredShots).toBe(1);
    } else {
      // Refused honestly: nothing spent, nothing queued, no numeric score.
      expect(ledger).toEqual({ spendable: 2, consumed: 0 });
      expect(receipts).toBe(0);
      expect(scoredShots).toBe(0);
    }
    expect(store.count('outbox', OWNER)).toBe(0);
    // Whatever happened, the wallet is still readable — never corrupt.
    await expect(readOfflineWalletStatus(store.db)).resolves.toMatchObject({
      hold: false,
    });
  });
});

describe('R4 saveOfflineAnalysis at its identity boundaries', () => {
  it('a whitespace receipt id, a receipt naming another result, an abstention and the OTHER owner’s receipt are all refused without a local_shot write', async () => {
    const { store, request } = await seed({});
    const { analysis, receipt } = await scoredOffline(store, request);
    store.native
      .prepare(`DELETE FROM local_shot WHERE owner_key = ? AND id = ?`)
      .run(OWNER, analysis.id);
    expect(store.count('local_shot', OWNER)).toBe(0);

    await expect(
      saveOfflineAnalysis(store.db, analysis, '   '),
    ).rejects.toThrow();
    await expect(
      saveOfflineAnalysis(
        store.db,
        { ...analysis, id: '55555555-5555-4555-8555-555555555555' },
        receipt.receiptId,
      ),
    ).rejects.toThrow();
    await expect(
      saveOfflineAnalysis(
        store.db,
        {
          ...analysis,
          resultKind: 'low_confidence',
          overallScore: null,
        },
        receipt.receiptId,
      ),
    ).rejects.toThrow();
    await expect(
      saveOfflineAnalysis(
        store.db,
        { ...analysis, source: 'fixture' },
        receipt.receiptId,
      ),
    ).rejects.toThrow();
    // The OTHER account cannot persist a rating against OWNER's receipt.
    signIn(OTHER);
    await expect(
      saveOfflineAnalysis(store.db, analysis, receipt.receiptId),
    ).rejects.toThrow();
    expect(store.count('local_shot', OTHER)).toBe(0);
    signIn();
    expect(store.count('local_shot', OWNER)).toBe(0);
    expect(store.count('outbox', OWNER)).toBe(0);
  });

  it('a payload that keeps the receipt’s result id but not its output is not persisted as the paid rating', async () => {
    // The receipt paid for ONE exact output (fullOutputSha256). A payload
    // with the same id and a different score is not that output; persisting
    // it would present a rating the receipt never paid for (the drain then
    // ships output:null and the server holds it — the user sees a score the
    // server can never accept).
    const { store, request } = await seed({});
    const { analysis, receipt } = await scoredOffline(store, request);
    const forged: ShotAnalysis = {
      ...analysis,
      overallScore: analysis.overallScore === 9.9 ? 1.1 : 9.9,
    };
    const attempt = await saveOfflineAnalysis(
      store.db,
      forged,
      receipt.receiptId,
    ).catch((error: unknown) => error);
    const stored = store.native
      .prepare(`SELECT payload FROM local_shot WHERE owner_key = ? AND id = ?`)
      .get(OWNER, analysis.id);
    const persisted = JSON.parse(String(stored?.payload)) as ShotAnalysis;
    // The paid output is the one the receipt digests; the repository must
    // refuse to overwrite it with a payload of a different digest.
    expect(persisted.overallScore).toBe(analysis.overallScore);
    expect(attempt).toBeInstanceOf(Error);
  });
});

describe('R5 duplicate and foreign identities in the verdict batch', () => {
  it('a batch naming the presented receipt twice (accepted AND rejected) settles nothing and is a HOLD, then recovers on a clean answer', async () => {
    const { store, request } = await seed({});
    const { analysis, receipt } = await scoredOffline(store, request);
    let answers = 0;
    const online = network({
      receipts: call => {
        answers += 1;
        if (answers === 1) {
          const [id] = presentedIds(call);
          return response(200, {
            receipts: [{ receiptId: id, status: 'result_recorded' }],
            rejected: [{ receiptId: id, code: 'offline.invalid_input' }],
          });
        }
        return answerAll()(call);
      },
    });
    await expect(
      reconcileOfflineWallet(store.db, offlineClient(), reading()),
    ).rejects.toThrow();
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);
    const row = store.native
      .prepare(
        `SELECT settlement, settled_at FROM offline_receipt WHERE owner_key = ? AND receipt_id = ?`,
      )
      .get(OWNER, receipt.receiptId);
    expect(row).toMatchObject({ settlement: null, settled_at: null });
    expect((await readOfflineWalletStatus(store.db)).hold).toBe(true);

    const second = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
    );
    expect(second).toMatchObject({ submitted: 1, accepted: 1, recovered: 1 });
    expect(receiptPosts(online.calls)).toHaveLength(2);
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(true);
    expect(await tickets(store)).toEqual({ spendable: 1, consumed: 1 });
  });

  it('a batch that answers the presented receipt AND a receipt this device never presented settles nothing', async () => {
    const { store, request } = await seed({});
    const { analysis, receipt } = await scoredOffline(store, request);
    network({
      receipts: call =>
        response(200, {
          receipts: [
            ...presentedIds(call).map(receiptId => ({
              receiptId,
              status: 'result_recorded',
            })),
            {
              receiptId: '99999999-9999-4999-8999-999999999999',
              status: 'result_recorded',
            },
          ],
          rejected: [],
        }),
    });
    await expect(
      reconcileOfflineWallet(store.db, offlineClient(), reading()),
    ).rejects.toThrow();
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);
    expect(await pendingOfflineReceipts(store.db)).toHaveLength(1);
    expect(store.count('sync_receipt', OWNER)).toBe(0);
    const row = store.native
      .prepare(
        `SELECT settlement FROM offline_receipt WHERE owner_key = ? AND receipt_id = ?`,
      )
      .get(OWNER, receipt.receiptId);
    expect(row).toMatchObject({ settlement: null });
  });
});

describe('R6 tampered ticket state', () => {
  it('a consumed ticket flipped back to remaining never authorizes a second rating and never re-spends', async () => {
    const { store, request, artifacts } = await seed({
      ticketIds: [TICKETS[0]],
    });
    await scoredOffline(store, request);
    expect(await tickets(store)).toEqual({ spendable: 0, consumed: 1 });
    store.native
      .prepare(
        `UPDATE offline_ticket SET state = 'remaining', receipt_id = NULL
         WHERE owner_key = ? AND ticket_id = ?`,
      )
      .run(OWNER, TICKETS[0]);
    const second = fixture(null, 'file:///private/captures/court-2.mov');
    registerArtifact(artifacts, second.clip, second.sidecar);
    seedSqliteCapture(store.db, OWNER, SECOND_CAPTURE, second.clip);
    network();
    const outcome = await runCaptureAnalysis(
      requestFor(store, second.clip, SECOND_OPERATION, SECOND_CAPTURE),
    ).catch((error: unknown) => error);
    expect(outcome).not.toMatchObject({ kind: 'scored' });
    // Still exactly one receipt; the tampered ticket did not become a second
    // spend, and no second scored shot exists.
    expect(store.count('offline_receipt', OWNER)).toBe(1);
    expect(
      store.native
        .prepare(
          `SELECT id FROM local_shot WHERE owner_key = ? AND result_kind = 'scored'`,
        )
        .all(OWNER),
    ).toHaveLength(1);
    expect(store.count('outbox', OWNER)).toBe(0);
  });
});

describe('R7 account switch between the drain’s submit and apply steps', () => {
  it('the verdict is applied to the presenting owner’s rows only; nothing is written under the account that signed in meanwhile', async () => {
    const { store, request } = await seed({});
    const { analysis, receipt } = await scoredOffline(store, request);
    network({
      receipts: call => {
        // The user switches accounts while the answer is in flight.
        signIn(OTHER);
        return answerAll()(call);
      },
    });
    const drained = await reconcileOfflineWallet(
      store.db,
      offlineClient(),
      reading(),
    ).catch((error: unknown) => error);
    // Either the verdict landed on OWNER's rows or it was refused entirely —
    // never a partial apply, never OTHER's rows.
    expect(store.count('sync_receipt', OTHER)).toBe(0);
    expect(store.count('offline_receipt', OTHER)).toBe(0);
    expect(store.count('offline_wallet_journal', OTHER)).toBe(0);
    const row = store.native
      .prepare(
        `SELECT settlement FROM offline_receipt WHERE owner_key = ? AND receipt_id = ?`,
      )
      .get(OWNER, receipt.receiptId);
    signIn();
    const synced = await hasShotSyncReceipt(store.db, analysis.id);
    if (drained instanceof Error) {
      expect(row).toMatchObject({ settlement: null });
      expect(synced).toBe(false);
    } else {
      expect(drained).toMatchObject({ submitted: 1, accepted: 1 });
      expect(row).toMatchObject({ settlement: 'accepted' });
      expect(synced).toBe(true);
      const journal = await readOfflineWalletJournal(store.db);
      expect(journal.filter(e => e.state === 'in_flight')).toHaveLength(0);
    }
  });
});

describe('R8 the Result surface for a receipt-carried shot', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
  });

  it('a scored read whose receipt is queued is not described as unverifiable — the device knows it is queued', async () => {
    const { store, request } = await seed({});
    const { analysis } = await scoredOffline(store, request);
    const renderer = await renderResult(store, analysis);
    const text = textOf(renderer);
    expect(text).toContain('Sync this read first.');
    // The receipt is durable and pending on THIS device; "could not verify"
    // is the copy for a shot with no evidence at all.
    expect(text).not.toContain(UNVERIFIABLE_COPY);
    act(() => renderer.unmount());
  });

  it('a scored read the server HELD stays pending copy, not unverifiable copy', async () => {
    const { store, request } = await seed({});
    const { analysis } = await scoredOffline(store, request);
    network({ receipts: answerAll('pending') });
    await expect(
      reconcileOfflineWallet(store.db, offlineClient(), reading()),
    ).resolves.toMatchObject({ submitted: 1, held: 1 });
    const renderer = await renderResult(store, analysis);
    const text = textOf(renderer);
    expect(text).toContain('Sync this read first.');
    expect(text).not.toContain(UNVERIFIABLE_COPY);
    act(() => renderer.unmount());
  });

  it('a scored read the server REFUSED surfaces the refusal instead of "could not verify"', async () => {
    const { store, request } = await seed({});
    const { analysis, receipt } = await scoredOffline(store, request);
    network({ receipts: refuseAll('offline.invalid_input') });
    await expect(
      reconcileOfflineWallet(store.db, offlineClient(), reading()),
    ).resolves.toMatchObject({ submitted: 1, refused: 1 });
    const row = store.native
      .prepare(
        `SELECT settlement FROM offline_receipt WHERE owner_key = ? AND receipt_id = ?`,
      )
      .get(OWNER, receipt.receiptId);
    expect(row).toMatchObject({ settlement: 'refused' });
    expect(await hasShotSyncReceipt(store.db, analysis.id)).toBe(false);

    const renderer = await renderResult(store, analysis);
    const text = textOf(renderer);
    // The device knows the server refused this rating; the surface must not
    // claim it cannot tell.
    expect(text).not.toContain(UNVERIFIABLE_COPY);
    // No plan can be built from a refused read.
    expect(
      renderer.root.findAll(
        n => n.props.accessibilityLabel === 'Build reviewed plan',
      ),
    ).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('control: an ACCEPTED receipt unlocks the plan exactly as a synced shot.sync does', async () => {
    const { store, request } = await seed({});
    const { analysis } = await scoredOffline(store, request);
    network({ receipts: answerAll() });
    await expect(
      reconcileOfflineWallet(store.db, offlineClient(), reading()),
    ).resolves.toMatchObject({ submitted: 1, accepted: 1 });
    const renderer = await renderResult(store, analysis);
    const text = textOf(renderer);
    expect(text).not.toContain('Sync this read first.');
    expect(text).not.toContain(UNVERIFIABLE_COPY);
    act(() => renderer.unmount());
  });
});
