/**
 * W05-04 adversarial suite against candidate d18f1df4 (branch
 * devin/pp/w05-04/impl-r4-c2). Every test below is an attack at a failure
 * boundary of the offline journey card as rendered by the SHIPPING Analyze
 * and Settings screens: interleaved account switches mid-read, sign-out
 * while a HOLD cadence is armed, corrupt persisted ledger rows, refused or
 * redirected receipt presentations, degenerate trusted-time readings, grant
 * and operation replays, the trusted-time watch at a day boundary, two
 * surfaces mounted at once, a relaunch with an unanswered presentation, the
 * unavailable-retry backoff cap, and ledgers that hold BOTH a Pro lease and
 * a free allocation (the copy must state the allocation the phone holds,
 * whatever the lease that governs the badge).
 *
 * The harness mirrors `w05OfflineJourney.test.tsx` (same mocks, same
 * fixtures, same drain paths) so a failure here is a failure of the
 * candidate, not of a different environment. Nothing in the candidate's own
 * tests or production code is modified.
 */
import React from 'react';
import { AppState, Text, type AppStateStatus } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
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
import type { LocalDb } from '../src/data/db';
import type { TrustedTimeReading } from '../src/data/trustedTime';

jest.mock('../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

const mockNavigation = {
  replace: jest.fn(),
  goBack: jest.fn(),
  navigate: jest.fn(),
  popToTop: jest.fn(),
  isFocused: () => true,
};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: { source: 'camera' } }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const React = jest.requireActual<typeof import('react')>('react');
    React.useEffect(() => callback(), [callback]);
  },
}));
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => insets,
    initialWindowMetrics: null,
  };
});

let mockDb: (() => LocalDb) | null = null;
jest.mock('../src/data/db', () => ({
  getDb: () => {
    if (!mockDb) throw new Error('no local database in this test');
    return mockDb();
  },
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

jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    captureStrokeVideo: () =>
      Promise.reject(new Error('capture is not part of this test')),
    importStrokeVideo: () => Promise.reject(new Error('out of scope')),
    cancelCameraOperation: () => undefined,
    subscribeToCameraEvents: () => () => undefined,
  };
});
jest.mock('../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: () =>
    Promise.reject(new Error('analysis is not part of this test')),
}));

import { AnalyzeScreen } from '../src/screens/AnalyzeScreen';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import {
  PENDING_RECEIPT_READ_CADENCE_MS,
  TRUSTED_TIME_WATCH_MS,
  UNAVAILABLE_RETRY_MS,
  presentOfflineJourney,
  type OfflineJourneyState,
} from '../src/components/OfflineAllocationCard';
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';
import { useAuthStore, type AuthSession } from '../src/auth/authStore';
import { useConsentStore } from '../src/state/consentStore';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../src/state/accessStore';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
} from '../src/billing/types';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
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
  type HeldOfflineGrantView,
} from '../src/data/offlineCapabilities';
import {
  readOfflineWalletStatus,
  reconcileOfflineWallet,
  type OfflineWalletStatus,
} from '../src/data/offlineWallet';
import { clearSyncRuntime } from '../src/data/syncRuntime';
import {
  closeSqliteTestDatabases,
  createSqliteTestDb,
} from '../testSupport/sqlite';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
const INSTALLATION_KEY = 'ios-install-key-1';
const ISSUER = 'https://api.example.test/functions/v1/api';
const RECEIPTS_ROUTE = `${ISSUER}/v1/offline/receipts`;
const KEY_ID = 'offline-grant-key-1';
const ARTIFACT = { version: 'v1', sha256: 'a'.repeat(64) };
const ISSUED_AT = 1_800_000_000;
const DAY_S = 24 * 60 * 60;
const SIX_DAYS_S = 6 * DAY_S;
const EXPIRES_AT = ISSUED_AT + SIX_DAYS_S;
const TICKETS = [
  'aaaaaaaa-0000-4000-8000-000000000001',
  'aaaaaaaa-0000-4000-8000-000000000002',
] as const;
const GRANT_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const LAPSED_PRO_GRANT_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
/** Sorts BEFORE the free grant id under `ORDER BY ... grant_id ASC`. */
const EARLY_PRO_GRANT_ID = 'ab000000-0000-4000-8000-000000000001';
/** Sorts AFTER the free grant id. */
const LATE_PRO_GRANT_ID = 'cc000000-0000-4000-8000-000000000001';
const RESULT_SHA = 'c'.repeat(64);
const BINDING = { installationKeyId: INSTALLATION_KEY, issuer: ISSUER };
const CARD_TEST_ID = 'offline-allocation-card';
const LEDGER_READ = /FROM offline_(grant|ticket|receipt|wallet_journal)\b/;
const WRITE_STATEMENT =
  /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i;

const FORBIDDEN_COPY = [
  /android/i,
  /google play/i,
  /guest mode/i,
  /live court/i,
  /dupr/i,
  /swingvision/i,
  /pb vision/i,
  /selkirk/i,
  /joola/i,
  /\d\s?%/,
  /\bbest\b/i,
  /world[- ]class/i,
  /ai coach/i,
];

function base64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

interface GrantShape {
  readonly entitlementSource: 'identity_lifetime_free' | 'verified_store';
  readonly grantId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly entitlementExpiresAt: number | null;
  readonly generation?: number;
  readonly allocationId?: string;
  readonly ticketIds?: readonly string[];
}

const FREE_GRANT: GrantShape = {
  entitlementSource: 'identity_lifetime_free',
  grantId: GRANT_ID,
  issuedAt: ISSUED_AT,
  expiresAt: EXPIRES_AT,
  entitlementExpiresAt: null,
};

/** A Pro lease issued at the same instant as the free allocation. */
function proGrant(grantId: string): GrantShape {
  return {
    entitlementSource: 'verified_store',
    grantId,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    entitlementExpiresAt: EXPIRES_AT + SIX_DAYS_S,
  };
}

const LAPSED_PRO_GRANT: GrantShape = {
  entitlementSource: 'verified_store',
  grantId: LAPSED_PRO_GRANT_ID,
  issuedAt: ISSUED_AT - 14 * DAY_S,
  expiresAt: ISSUED_AT - 7 * DAY_S,
  entitlementExpiresAt: ISSUED_AT - 7 * DAY_S,
};

function grantResponse(shape: GrantShape): Record<string, unknown> {
  const free = shape.entitlementSource === 'identity_lifetime_free';
  const generation = shape.generation ?? 1;
  const ticketIds = shape.ticketIds ?? TICKETS;
  const claims = {
    schemaVersion: OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
    protocolVersion: OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
    iss: ISSUER,
    aud: OFFLINE_GRANT_AUDIENCE,
    sub: OWNER,
    jti: shape.grantId,
    installationKeyId: INSTALLATION_KEY,
    iat: shape.issuedAt,
    exp: shape.expiresAt,
    capabilities: ['analyze_joint_output'],
    release: {
      policy: ARTIFACT,
      mechanicsModel: ARTIFACT,
      benchmarkModel: ARTIFACT,
    },
    entitlementSource: shape.entitlementSource,
    ...(free
      ? {
          allocation: {
            schemaVersion: OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION,
            allocationId: shape.allocationId ?? shape.grantId,
            generation,
            ticketIds,
            budgetPolicy: OFFLINE_FREE_ALLOCATION_POLICY.id,
            financialExpiry: 'reconciliation_only',
          },
        }
      : {
          lease: {
            schemaVersion: OFFLINE_PRO_LEASE_SCHEMA_VERSION,
            kind: 'subscription',
            verifiedEntitlementExpiresAt: shape.entitlementExpiresAt,
          },
        }),
  };
  const header = { alg: 'ES256', typ: OFFLINE_GRANT_JWS_TYPE, kid: KEY_ID };
  const compactJws = `${base64Url(JSON.stringify(header))}.${base64Url(
    JSON.stringify(claims),
  )}.${'A'.repeat(86)}`;
  return {
    grantId: shape.grantId,
    generation,
    entitlementSource: shape.entitlementSource,
    issuedAt: shape.issuedAt,
    expiresAt: shape.expiresAt,
    entitlementExpiresAt: shape.entitlementExpiresAt,
    ticketIds: free ? ticketIds : [],
    keyId: KEY_ID,
    grant: { schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION, compactJws },
  };
}

function issuedGrant(shape: GrantShape = FREE_GRANT): IssuedOfflineGrant {
  const parsed = parseIssuedOfflineGrant(grantResponse(shape));
  if (!parsed) throw new Error('fixture grant response must parse');
  return parsed;
}

function anchored(nowMs: number): TrustedTimeReading {
  return {
    authority: 'anchored',
    continuity: 'measured',
    nowMs,
    wallClockMs: nowMs,
    rollbackDetected: false,
    storage: 'loaded',
  };
}

const AT_ISSUE = anchored(ISSUED_AT * 1000);
const AFTER_EXPIRY = anchored(EXPIRES_AT * 1000 + 1000);
const NO_TRUSTED_TIME: TrustedTimeReading = {
  authority: 'none',
  continuity: 'unmeasured',
  nowMs: ISSUED_AT * 1000,
  wallClockMs: ISSUED_AT * 1000,
  rollbackDetected: false,
  storage: 'empty',
};

function consumption(operationId: string) {
  return {
    operationId,
    resultId: `result-${operationId}`,
    fullOutputSha256: RESULT_SHA,
  };
}

const syncedSession: AuthSession = {
  provider: 'apple',
  subject: OWNER,
  canonicalAppUserId: OWNER,
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

function freeAccess(): CanonicalAccessState {
  return {
    premium: false,
    entitlements: [],
    freeRatings: {
      limit: 2,
      used: 0,
      reserved: 0,
      remaining: 2,
      availableToReserve: 2,
    },
    canStartRating: true,
    paywallRequired: false,
  };
}

function billing(): BillingAccessDependencies {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => {
        throw new Error('plans are not part of this test');
      }),
      purchase: jest.fn(),
      restore: jest.fn(),
      readEntitlement: jest.fn(),
    },
    backend: {
      getAccess: jest.fn(async () => freeAccess()),
      syncBilling: jest.fn(),
    },
  };
}

let handle: ReturnType<typeof createSqliteTestDb>;
let db: LocalDb;
let mounted: TestRenderer.ReactTestRenderer | null = null;
let fetchSpy: jest.SpyInstance | null = null;

async function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  mounted = renderer;
  return renderer;
}

async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise(resolve => setTimeout(() => resolve(undefined), 0));
    });
  }
}

function textOf(node: TestRenderer.ReactTestInstance): string {
  const parts: string[] = [];
  const visit = (value: unknown): void => {
    if (value === null || value === undefined || typeof value === 'boolean')
      return;
    if (typeof value === 'string' || typeof value === 'number') {
      parts.push(String(value));
      return;
    }
    if (Array.isArray(value)) value.forEach(visit);
  };
  for (const text of node.findAllByType(Text)) visit(text.props.children);
  return parts.join(' | ');
}

function cards(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props !== null &&
      node.props.testID === CARD_TEST_ID,
  );
}

function card(renderer: TestRenderer.ReactTestRenderer) {
  const found = cards(renderer);
  if (found.length === 0) throw new Error('offline allocation card missing');
  return found[0]!;
}

function badgeOf(renderer: TestRenderer.ReactTestRenderer): string {
  return badgeOfCard(card(renderer));
}

function badgeOfCard(node: TestRenderer.ReactTestInstance): string {
  const badge = node.findAll(
    child => child.props.testID === `${CARD_TEST_ID}-status`,
  )[0];
  if (!badge) throw new Error('offline allocation status badge missing');
  return textOf(badge);
}

function expectDossierCompliant(copy: string) {
  for (const pattern of FORBIDDEN_COPY) {
    expect(copy).not.toMatch(pattern);
  }
}

async function holdGrant(shape: GrantShape = FREE_GRANT) {
  return holdOfflineGrant(db, issuedGrant(shape), BINDING);
}

async function spend(operationId: string) {
  return consumeOfflineAllocation(db, consumption(operationId), AT_ISSUE);
}

function grantClient() {
  return createOfflineGrantClient({ baseUrl: ISSUER, token: 'access-token' });
}

async function presentAndLoseConnection() {
  fetchSpy?.mockRestore();
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new TypeError('Network request failed');
  });
  await expect(
    reconcileOfflineWallet(db, grantClient(), AT_ISSUE),
  ).rejects.toThrow('Network request failed');
}

/** The server answers the presentation with an HTTP status and no verdict
 * body the client can apply (429 + Retry-After, 5xx, a redirect). */
async function presentAndGetStatus(
  status: number,
  headers: Record<string, string> = {},
) {
  fetchSpy?.mockRestore();
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(
        status >= 300 && status < 400 ? null : JSON.stringify({ error: 'x' }),
        {
          status,
          headers: { 'content-type': 'application/json', ...headers },
        },
      ),
  );
  await expect(
    reconcileOfflineWallet(db, grantClient(), AT_ISSUE),
  ).rejects.toThrow();
}

async function presentAndReceive(status: string) {
  fetchSpy?.mockRestore();
  fetchSpy = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      if (String(input) !== RECEIPTS_ROUTE) {
        return new Response(JSON.stringify({ error: 'not_found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        receipts?: Array<{ receiptId: string }>;
      };
      return new Response(
        JSON.stringify({
          receipts: (body.receipts ?? []).map(receipt => ({
            receiptId: receipt.receiptId,
            status,
          })),
          rejected: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
  return reconcileOfflineWallet(db, grantClient(), AT_ISSUE);
}

async function ledgerTruth(reading: TrustedTimeReading = AT_ISSUE) {
  return {
    allocation: await readOfflineAllocation(db, reading),
    wallet: await readOfflineWalletStatus(db),
    pending: await pendingOfflineReceipts(db),
  };
}

function gateFirstTransaction(): { db: LocalDb; release(): void } {
  const inner = db;
  let release: () => void = () => undefined;
  let gate: Promise<void> | null = new Promise<void>(resolve => {
    release = resolve;
  });
  const innerTransaction = inner.transaction;
  if (!innerTransaction) throw new Error('test db has no transaction');
  return {
    db: {
      execute: (sql, params) => inner.execute(sql, params),
      transaction: async <T,>(
        operation: (transaction: LocalDb) => Promise<T>,
      ): Promise<T> => {
        if (gate) {
          const waiting = gate;
          gate = null;
          await waiting;
        }
        return innerTransaction.call(inner, operation) as Promise<T>;
      },
      close: () => inner.close(),
    },
    release: () => release(),
  };
}

function signInAs(owner: string, bearerToken: string) {
  setActiveDataOwner(owner);
  establishApiSession({
    apiBaseUrl: 'https://api.test',
    bearerToken,
    canonicalAppUserId: owner,
    provider: 'apple',
  });
  useAuthStore.setState({
    session: { ...syncedSession, subject: owner, canonicalAppUserId: owner },
  });
}

function signOut() {
  useAuthStore.setState({ session: null });
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
}

function ledgerReads() {
  return handle.calls.filter(call => LEDGER_READ.test(call.sql));
}

function ledgerWrites() {
  return handle.calls.filter(call => WRITE_STATEMENT.test(call.sql));
}

type ChangeListener = (state: AppStateStatus) => void;
const appStateListeners = new Set<ChangeListener>();
const originalAppState = AppState.currentState;

async function settleFake() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
  }
}

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
  await settleFake();
}

function observeAppStateAndTimers() {
  beforeEach(() => {
    appStateListeners.clear();
    AppState.currentState = 'active';
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((event, listener) => {
        expect(event).toBe('change');
        const change = listener as ChangeListener;
        appStateListeners.add(change);
        return { remove: jest.fn(() => appStateListeners.delete(change)) };
      });
  });

  afterEach(async () => {
    if (mounted) await act(async () => mounted?.unmount());
    mounted = null;
    clearSyncRuntime();
    jest.useRealTimers();
    AppState.currentState = originalAppState;
    jest.restoreAllMocks();
  });
}

beforeEach(() => {
  handle = createSqliteTestDb();
  db = handle.db;
  mockDb = () => db;
  mockReading = AT_ISSUE;
  setActiveDataOwner(OWNER);
  establishApiSession({
    apiBaseUrl: 'https://api.test',
    bearerToken: 'token-1',
    canonicalAppUserId: OWNER,
    provider: 'apple',
  });
  useAuthStore.setState({ session: syncedSession });
  useConsentStore.setState({
    availability: 'signed_out',
    modelTrainingActive: false,
    hydrate: jest.fn(() => Promise.resolve()),
  });
  clearAccessStoreConfiguration();
  configureAccessStore(billing());
  useAccessStore.setState({ status: 'ready', canonicalAccess: freeAccess() });
});

afterEach(async () => {
  if (mounted) await act(async () => mounted?.unmount());
  mounted = null;
  fetchSpy?.mockRestore();
  fetchSpy = null;
  clearAccessStoreConfiguration();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  mockDb = null;
  mockReading = null;
  closeSqliteTestDatabases();
});

const quietWallet: OfflineWalletStatus = {
  pending: [],
  unansweredPresentations: 0,
  hold: false,
};

function view(
  overrides: Partial<HeldOfflineGrantView> & {
    execution: HeldOfflineGrantView['execution'];
  },
): HeldOfflineGrantView {
  return {
    grantId: GRANT_ID,
    generation: 1,
    entitlementSource: 'identity_lifetime_free',
    installationKeyId: INSTALLATION_KEY,
    keyId: KEY_ID,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    entitlementExpiresAt: null,
    grantJwsSha256: 'e'.repeat(64),
    allocated: 2,
    remaining: 2,
    consumed: 0,
    lifecycleSequence: 0,
    ...overrides,
  };
}

function copyOf(state: OfflineJourneyState): string {
  const presented = presentOfflineJourney(state);
  return [
    presented.badge,
    presented.title,
    ...presented.rows.flatMap(row => [row.label, row.value]),
    ...presented.notes,
  ].join(' | ');
}

describe('ATTACK 1 — a ledger holding a Pro lease AND a free allocation', () => {
  it('presenter: the same facts in a different row order must present the same allocation', () => {
    const pro = view({
      grantId: EARLY_PRO_GRANT_ID,
      entitlementSource: 'verified_store',
      entitlementExpiresAt: EXPIRES_AT + SIX_DAYS_S,
      allocated: 0,
      remaining: 0,
      execution: { kind: 'reconcile_required', reason: 'no_trusted_time' },
    });
    const free = view({
      execution: { kind: 'reconcile_required', reason: 'no_trusted_time' },
    });
    const facts = (grants: HeldOfflineGrantView[]): OfflineJourneyState => ({
      kind: 'read',
      allocation: {
        grants,
        spendableTickets: 2,
        consumedTickets: 0,
        pendingReceipts: 0,
      },
      wallet: quietWallet,
    });
    const proFirst = copyOf(facts([pro, free]));
    const freeFirst = copyOf(facts([free, pro]));
    expectDossierCompliant(proFirst);
    expectDossierCompliant(freeFirst);
    // Two held, unspent analyses are a fact of the ledger whichever grant
    // is listed first; the card must state them in both orders.
    expect(freeFirst).toContain('2 of 2');
    expect(proFirst).toContain('2 of 2');
    expect(proFirst).toBe(freeFirst);
  });

  it('Settings: an expired Pro lease beside an expired free allocation still states the 2 held analyses', async () => {
    await holdGrant(LAPSED_PRO_GRANT);
    await holdGrant(FREE_GRANT);
    mockReading = AFTER_EXPIRY;
    const truth = await ledgerTruth(AFTER_EXPIRY);
    expect(truth.allocation.spendableTickets).toBe(2);
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expectDossierCompliant(copy);
    expect(badgeOf(renderer)).toBe('EXPIRED');
    // The ledger holds two unspent free analyses that are never reclaimed.
    // A lapsed Pro lease must not hide them behind "Pro pass".
    expect(copy).not.toContain('Pro pass');
    expect(copy).toContain('2 of 2');
    expect(copy).toContain('stay allocated');
  });

  it('Settings: a Pro lease awaiting an online check beside 2 held free analyses states the 2 held analyses (Pro row sorted first)', async () => {
    await holdGrant(proGrant(EARLY_PRO_GRANT_ID));
    await holdGrant(FREE_GRANT);
    mockReading = NO_TRUSTED_TIME;
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expectDossierCompliant(copy);
    expect(badgeOf(renderer)).toBe('CONFIRM ONLINE');
    expect(copy).toContain('2 of 2');
    expect(copy).toContain('stay allocated');
  });

  it('Settings: a Pro lease awaiting an online check beside 2 held free analyses states the 2 held analyses (free row sorted first)', async () => {
    await holdGrant(proGrant(LATE_PRO_GRANT_ID));
    await holdGrant(FREE_GRANT);
    mockReading = NO_TRUSTED_TIME;
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expectDossierCompliant(copy);
    expect(badgeOf(renderer)).toBe('CONFIRM ONLINE');
    expect(copy).toContain('2 of 2');
    expect(copy).toContain('stay allocated');
  });
});

describe('ATTACK 2 — interleaved account switch while a read is in flight', () => {
  it('the other account never sees the first account’s allocation, and the first account sees its own again', async () => {
    await holdGrant();
    handle.calls.length = 0;
    const gated = gateFirstTransaction();
    mockDb = () => gated.db;
    const renderer = await render(<SettingsScreen />);
    await settle();
    // The read for OWNER is stalled inside its transaction.
    expect(badgeOf(renderer)).toBe('CHECKING');

    await act(async () => {
      signInAs(OTHER_OWNER, 'token-2');
    });
    await settle();
    // OTHER_OWNER holds nothing. Whatever is on screen for them must not be
    // OWNER's allocation.
    for (const node of cards(renderer)) {
      const copy = textOf(node);
      expect(copy).not.toContain('2 of 2');
      expect(copy).not.toContain('analyses ready');
    }

    gated.release();
    await settle();
    await settle();
    expect(badgeOf(renderer)).toBe('NONE HELD');
    expect(textOf(card(renderer))).not.toContain('2 of 2');

    await act(async () => {
      signInAs(OWNER, 'token-3');
    });
    await settle();
    await settle();
    expect(badgeOf(renderer)).toBe('READY');
    expect(textOf(card(renderer))).toContain('2 of 2');
    expect(ledgerWrites()).toEqual([]);
  });
});

describe('ATTACK 3 — sign-out while the HOLD cadence is armed', () => {
  observeAppStateAndTimers();

  it('no ledger read runs for a signed-out process and the card leaves the screen', async () => {
    jest.useFakeTimers();
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const renderer = await render(<SettingsScreen />);
    await settleFake();
    expect(badgeOf(renderer)).toBe('ON HOLD');

    await act(async () => {
      signOut();
    });
    await settleFake();
    handle.calls.length = 0;
    await advance(PENDING_RECEIPT_READ_CADENCE_MS * 3);
    expect(ledgerReads()).toEqual([]);
    expect(cards(renderer)).toHaveLength(0);
  });
});

describe('ATTACK 4 — corrupt persisted ledger rows', () => {
  observeAppStateAndTimers();

  it('a ticket whose generation disagrees with its grant reads as UNAVAILABLE, never as a count, and recovers once the row is consistent again', async () => {
    jest.useFakeTimers();
    await holdGrant();
    await db.execute(
      `UPDATE offline_ticket SET generation = 7 WHERE owner_key = ? AND ticket_id = ?`,
      [OWNER, TICKETS[0]],
    );
    await expect(readOfflineAllocation(db, AT_ISSUE)).rejects.toThrow();
    handle.calls.length = 0;
    const renderer = await render(<SettingsScreen />);
    await settleFake();
    const copy = textOf(card(renderer));
    expectDossierCompliant(copy);
    expect(badgeOf(renderer)).toBe('UNAVAILABLE');
    expect(copy).not.toMatch(/\d of \d/);
    expect(copy).not.toContain('ready');
    expect(copy).not.toContain('No offline pass');
    expect(ledgerWrites()).toEqual([]);

    await db.execute(
      `UPDATE offline_ticket SET generation = 1 WHERE owner_key = ? AND ticket_id = ?`,
      [OWNER, TICKETS[0]],
    );
    await advance(UNAVAILABLE_RETRY_MS);
    expect(badgeOf(renderer)).toBe('READY');
    expect(textOf(card(renderer))).toContain('2 of 2');
  });

  it('a journal row with unreadable receipt ids reads as UNAVAILABLE, not as a clean wallet', async () => {
    await holdGrant();
    await spend('op-1');
    await db.execute(
      `INSERT INTO offline_wallet_journal (
        owner_key, journal_id, kind, receipt_ids, state, opened_at, closed_at, verdicts
      ) VALUES (?, ?, 'receipt_submission', ?, 'in_flight', ?, NULL, NULL)`,
      [OWNER, 'journal-garbage', '{not json', new Date(0).toISOString()],
    );
    await expect(readOfflineWalletStatus(db)).rejects.toThrow();
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expectDossierCompliant(copy);
    expect(badgeOf(renderer)).toBe('UNAVAILABLE');
    expect(copy).not.toContain('Waiting to sync');
    expect(copy).not.toMatch(/\d of \d/);
    expect(copy).not.toContain('READY');
  });
});

describe('ATTACK 5 — the server refuses, fails or redirects the presentation', () => {
  observeAppStateAndTimers();

  it.each([
    [429, { 'retry-after': '30' }],
    [503, {}],
    [302, { location: 'https://elsewhere.example.test/' }],
  ])(
    'HTTP %i leaves the receipt on HOLD with copy that asserts only the journal, keeps the ticket spent, and the card catches up when the server finally answers',
    async (status, headers) => {
      jest.useFakeTimers();
      await holdGrant();
      await spend('op-1');
      await presentAndGetStatus(status, headers as Record<string, string>);
      const truth = await ledgerTruth();
      expect(truth.wallet.hold).toBe(true);
      const renderer = await render(<AnalyzeScreen />);
      await settleFake();
      const copy = textOf(card(renderer));
      expectDossierCompliant(copy);
      expect(badgeOf(renderer)).toBe('ON HOLD');
      expect(copy).toContain('1 of 2');
      expect(copy).toContain('1 on hold');
      expect(copy).not.toMatch(/connection dropped|dropped connection/i);
      expect(copy).not.toContain('refund');

      const outcome = await presentAndReceive('result_recorded');
      expect(outcome.accepted).toBe(1);
      await advance(PENDING_RECEIPT_READ_CADENCE_MS);
      const after = textOf(card(renderer));
      expect(badgeOf(renderer)).toBe('READY');
      expect(after).toContain('1 of 2');
      expect(after).toContain('Nothing');
    },
  );
});

describe('ATTACK 6 — degenerate trusted-time readings', () => {
  it.each([
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['epoch zero', 0],
    ['negative', -1],
    ['far future', 8.64e15],
    ['max safe integer', Number.MAX_SAFE_INTEGER],
  ])(
    'an anchored reading at %s never presents the pass as READY',
    async (_label, nowMs) => {
      await holdGrant();
      mockReading = anchored(nowMs);
      const renderer = await render(<SettingsScreen />);
      await settle();
      const copy = textOf(card(renderer));
      expectDossierCompliant(copy);
      expect(badgeOf(renderer)).not.toBe('READY');
      expect(copy).not.toMatch(/\bready\b/);
      expect(copy).not.toContain('NaN');
      expect(copy).not.toContain('Infinity');
      expect(copy).toContain('2 of 2');
    },
  );

  it('a lease at the seven-day maximum reads as 7 days, and one a second longer is refused by the ledger and never shown', async () => {
    await expect(
      holdGrant({ ...FREE_GRANT, expiresAt: ISSUED_AT + 7 * DAY_S + 1 }),
    ).rejects.toThrow();
    const empty = await render(<SettingsScreen />);
    await settle();
    expect(badgeOf(empty)).toBe('NONE HELD');
    await act(async () => empty.unmount());
    mounted = null;

    await holdGrant({ ...FREE_GRANT, expiresAt: ISSUED_AT + 7 * DAY_S });
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expectDossierCompliant(copy);
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('In 7 days');
    expect(copy).not.toMatch(/In (?:[89]|\d{2,}) days/);
  });
});

describe('ATTACK 7 — replayed grants and replayed operations', () => {
  it('re-holding the same grant after a spend never refills it, a reused grant id is refused, and a replayed operation is not charged twice', async () => {
    await holdGrant();
    await holdGrant();
    await spend('op-1');
    await holdGrant();
    await expect(
      holdGrant({ ...FREE_GRANT, expiresAt: EXPIRES_AT + DAY_S }),
    ).rejects.toThrow();
    const first = await spend('op-1');
    const truth = await ledgerTruth();
    expect(first).toBeDefined();
    expect(truth.allocation.consumedTickets).toBe(1);
    expect(truth.allocation.spendableTickets).toBe(1);
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expectDossierCompliant(copy);
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('1 of 2');
    expect(copy).toContain('1 offline analysis ready');
    expect(copy).toContain('1 result waiting');
  });
});

describe('ATTACK 8 — the trusted-time watch at a day boundary', () => {
  observeAppStateAndTimers();

  it('one millisecond past a whole day the card stops promising that day, within the watch cadence', async () => {
    jest.useFakeTimers();
    await holdGrant();
    handle.calls.length = 0;
    const renderer = await render(<AnalyzeScreen />);
    await settleFake();
    expect(textOf(card(renderer))).toContain('In 6 days');

    mockReading = anchored(ISSUED_AT * 1000 + 1);
    await advance(TRUSTED_TIME_WATCH_MS);
    const copy = textOf(card(renderer));
    expect(copy).toContain('In 5 days');
    expect(copy).not.toContain('In 6 days');
    expect(badgeOf(renderer)).toBe('READY');

    // Right at the edge of the last hour: whole units, rounded down.
    mockReading = anchored(EXPIRES_AT * 1000 - 60 * 60 * 1000);
    await advance(TRUSTED_TIME_WATCH_MS);
    expect(textOf(card(renderer))).toContain('In 1 hour');
    mockReading = anchored(EXPIRES_AT * 1000 - 60 * 60 * 1000 + 1);
    await advance(TRUSTED_TIME_WATCH_MS);
    expect(textOf(card(renderer))).toContain('In under an hour');
    mockReading = anchored(EXPIRES_AT * 1000);
    await advance(TRUSTED_TIME_WATCH_MS);
    expect(badgeOf(renderer)).toBe('EXPIRED');
    expect(ledgerWrites()).toEqual([]);
  });
});

describe('ATTACK 9 — two surfaces mounted at once', () => {
  observeAppStateAndTimers();

  it('Analyze keeps following a HOLD after Settings unmounts, and both cards always agree', async () => {
    jest.useFakeTimers();
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const renderer = await render(
      <>
        <AnalyzeScreen />
        <SettingsScreen />
      </>,
    );
    await settleFake();
    const both = cards(renderer);
    expect(both).toHaveLength(2);
    expect(both.map(badgeOfCard)).toEqual(['ON HOLD', 'ON HOLD']);

    await act(async () => {
      renderer.update(<AnalyzeScreen />);
    });
    await settleFake();
    expect(cards(renderer)).toHaveLength(1);

    const outcome = await presentAndReceive('result_recorded');
    expect(outcome.accepted).toBe(1);
    await advance(PENDING_RECEIPT_READ_CADENCE_MS);
    expect(badgeOf(renderer)).toBe('READY');
    expect(textOf(card(renderer))).toContain('Nothing');
  });
});

describe('ATTACK 10 — relaunch with an unanswered presentation on disk', () => {
  it('after sign-out and sign-in as the same account the card is read from the ledger, never replayed from the last publication', async () => {
    await holdGrant();
    const first = await render(<SettingsScreen />);
    await settle();
    expect(badgeOf(first)).toBe('READY');
    await act(async () => first.unmount());
    mounted = null;

    // The process dies mid-presentation: the journal keeps the in_flight
    // entry, the receipt stays pending.
    await spend('op-1');
    await presentAndLoseConnection();
    signOut();
    signInAs(OWNER, 'token-relaunch');

    handle.calls.length = 0;
    const second = await render(<SettingsScreen />);
    // Nothing from the previous owner generation may show at any point.
    expect(textOf(card(second))).not.toContain('2 of 2');
    expect(badgeOf(second)).not.toBe('READY');
    await settle();
    const copy = textOf(card(second));
    expectDossierCompliant(copy);
    expect(badgeOf(second)).toBe('ON HOLD');
    expect(copy).toContain('1 of 2');
    expect(copy).toContain('1 on hold');
    expect(ledgerReads().length).toBeGreaterThan(0);
    expect(ledgerWrites()).toEqual([]);
  });
});

describe('ATTACK 11 — the unavailable-retry backoff under a long outage', () => {
  observeAppStateAndTimers();

  it('after many failed reads the card still retries within the 60 s cap and recovers', async () => {
    jest.useFakeTimers();
    await holdGrant();
    const healthy = db;
    let failing = true;
    mockDb = () => {
      if (failing) throw new Error('storage busy');
      return healthy;
    };
    const renderer = await render(<SettingsScreen />);
    await settleFake();
    expect(badgeOf(renderer)).toBe('UNAVAILABLE');
    // 5, 10, 20, 40, 60, 60, 60 s: seven more failures.
    for (let i = 0; i < 7; i += 1) {
      await advance(60_000);
      expect(badgeOf(renderer)).toBe('UNAVAILABLE');
    }
    failing = false;
    await advance(60_000);
    expect(badgeOf(renderer)).toBe('READY');
    expect(textOf(card(renderer))).toContain('2 of 2');
  });
});
