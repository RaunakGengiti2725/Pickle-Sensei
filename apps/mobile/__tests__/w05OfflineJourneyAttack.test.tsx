/**
 * W05-04 ADVERSARIAL TESTS against candidate 06913838 (branch
 * devin/pp/w05-04/impl-r3). Each `it` is one attack on a failure boundary of
 * the offline journey card; every assertion states the behaviour the
 * objective ("honest offline states") requires, so a failing test here is a
 * confirmed break of the candidate, not a test defect.
 *
 * Fixtures mirror __tests__/w05OfflineJourney.test.tsx (same grant JWS shape,
 * same shipping screens, same real SQLite ledger); the candidate's own suite
 * is left untouched.
 *
 * Result against 06913838 (npx jest --ci __tests__/w05OfflineJourneyAttack.test.tsx):
 * ATTACK 1, 2, 3 (and the Pro-lease case of ATTACK 8) FAIL = confirmed breaks;
 * ATTACK 4, 5, 6, 7 and the ATTACK 8 matrix PASS = the candidate held.
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
import type {
  TrustedTimeLeaseVerdict,
  TrustedTimeReading,
} from '../src/data/trustedTime';

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
let trustedReads = 0;
jest.mock('../src/data/trustedTime', () => {
  const actual = jest.requireActual<typeof import('../src/data/trustedTime')>(
    '../src/data/trustedTime',
  );
  return {
    ...actual,
    trustedTime: {
      ...actual.trustedTime,
      read: async () => {
        trustedReads += 1;
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
  readOfflineAllocation,
  type HeldOfflineGrantView,
} from '../src/data/offlineCapabilities';
import {
  readOfflineWalletStatus,
  reconcileOfflineWallet,
  type OfflineWalletPendingReceipt,
  type OfflineWalletReceiptPhase,
  type OfflineWalletStatus,
} from '../src/data/offlineWallet';
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
const RESULT_SHA = 'c'.repeat(64);
const BINDING = { installationKeyId: INSTALLATION_KEY, issuer: ISSUER };
const CARD_TEST_ID = 'offline-allocation-card';

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
  /\brefund/i,
  /\bretr(y|ied)\b/i,
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
}

const FREE_GRANT: GrantShape = {
  entitlementSource: 'identity_lifetime_free',
  grantId: GRANT_ID,
  issuedAt: ISSUED_AT,
  expiresAt: EXPIRES_AT,
  entitlementExpiresAt: null,
};

const LAPSED_PRO_GRANT: GrantShape = {
  entitlementSource: 'verified_store',
  grantId: LAPSED_PRO_GRANT_ID,
  issuedAt: ISSUED_AT - 14 * DAY_S,
  expiresAt: ISSUED_AT - 7 * DAY_S,
  entitlementExpiresAt: ISSUED_AT - 7 * DAY_S,
};

function grantResponse(shape: GrantShape): Record<string, unknown> {
  const free = shape.entitlementSource === 'identity_lifetime_free';
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
            allocationId: shape.grantId,
            generation: 1,
            ticketIds: TICKETS,
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
    generation: 1,
    entitlementSource: shape.entitlementSource,
    issuedAt: shape.issuedAt,
    expiresAt: shape.expiresAt,
    entitlementExpiresAt: shape.entitlementExpiresAt,
    ticketIds: free ? TICKETS : [],
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
/** Relaunch before any authenticated response: the persisted floor only. */
const FLOOR_ONLY: TrustedTimeReading = {
  authority: 'floor',
  continuity: 'persisted',
  nowMs: ISSUED_AT * 1000,
  wallClockMs: ISSUED_AT * 1000,
  rollbackDetected: false,
  storage: 'loaded',
};
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
let mounted: TestRenderer.ReactTestRenderer[] = [];
let fetchSpy: jest.SpyInstance | null = null;

async function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  mounted.push(renderer);
  return renderer;
}

async function unmount(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => renderer.unmount());
  mounted = mounted.filter(r => r !== renderer);
}

async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise(resolve => setTimeout(() => resolve(undefined), 0));
    });
  }
}

/** `settle()` under fake timers: flushes due timers and their promise chains
 * without advancing the clock. */
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
  return renderer.root.findAll(node => node.props.testID === CARD_TEST_ID);
}

function card(renderer: TestRenderer.ReactTestRenderer) {
  const found = cards(renderer);
  if (found.length === 0) throw new Error('offline allocation card missing');
  return found[0]!;
}

function badgeOf(renderer: TestRenderer.ReactTestRenderer): string {
  const badge = card(renderer).findAll(
    node => node.props.testID === `${CARD_TEST_ID}-status`,
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
  await holdOfflineGrant(db, issuedGrant(shape), BINDING);
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
  };
}

/** Wraps the test database so the NEXT transaction after `arm()` stalls until
 * `release()`; every other transaction runs at once. */
function gatedDb(): { db: LocalDb; arm(): void; release(): void } {
  const inner = db;
  let release: () => void = () => undefined;
  let gate: Promise<void> | null = null;
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
    arm: () => {
      gate = new Promise<void>(resolve => {
        release = resolve;
      });
    },
    release: () => release(),
  };
}

const WRITE_STATEMENT =
  /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i;
const LEDGER_READ = /FROM offline_(grant|ticket|receipt|wallet_journal)\b/;

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

type ChangeListener = (state: AppStateStatus) => void;
const appStateListeners = new Set<ChangeListener>();
const originalAppState = AppState.currentState;

function foreground() {
  AppState.currentState = 'active';
  for (const listener of [...appStateListeners]) listener('active');
}

function background() {
  AppState.currentState = 'background';
  for (const listener of [...appStateListeners]) listener('background');
}

beforeEach(() => {
  handle = createSqliteTestDb();
  db = handle.db;
  mockDb = () => db;
  mockReading = AT_ISSUE;
  trustedReads = 0;
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
  for (const renderer of [...mounted])
    await act(async () => renderer.unmount());
  mounted = [];
  fetchSpy?.mockRestore();
  fetchSpy = null;
  clearAccessStoreConfiguration();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  mockDb = null;
  mockReading = null;
  jest.useRealTimers();
  AppState.currentState = originalAppState;
  jest.restoreAllMocks();
  closeSqliteTestDatabases();
});

describe('ATTACK 1 — transient storage failure during the follow-up cadence', () => {
  it('keeps following a HOLD after one failed quiet read, so the resolved HOLD still leaves the screen', async () => {
    jest.useFakeTimers();
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const renderer = await render(<AnalyzeScreen />);
    await settleFake();
    expect(badgeOf(renderer)).toBe('ON HOLD');

    // One SQLITE_BUSY-style failure on the next ledger read (the drain is
    // writing to the same file); every later statement succeeds.
    handle.failStatementOnce(
      'FROM offline_grant',
      new Error('SQLITE_BUSY: database is locked'),
    );
    await advance(PENDING_RECEIPT_READ_CADENCE_MS);
    // The transient failure is reported honestly for the moment...
    expect(badgeOf(renderer)).toBe('UNAVAILABLE');

    // ...and the server resolves the HOLD right after.
    const outcome = await presentAndReceive('result_recorded');
    expect(outcome.accepted).toBe(1);
    expect((await ledgerTruth()).wallet.hold).toBe(false);

    // The card stays on screen. The ledger is readable again. Within a few
    // cadences the resolved HOLD must be on screen — nothing on this screen
    // was navigated, backgrounded or foregrounded.
    const readsBefore = handle.calls.filter(c =>
      LEDGER_READ.test(c.sql),
    ).length;
    await advance(PENDING_RECEIPT_READ_CADENCE_MS * 12);
    const readsAfter = handle.calls.filter(c => LEDGER_READ.test(c.sql)).length;
    expect(readsAfter).toBeGreaterThan(readsBefore);
    expect(badgeOf(renderer)).toBe('READY');
    expect(textOf(card(renderer))).toContain('1 of 2');
  });

  it('a transient failure on a quiet read does not replace a known HOLD with "nothing is shown" for good', async () => {
    jest.useFakeTimers();
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const renderer = await render(<SettingsScreen />);
    await settleFake();
    expect(badgeOf(renderer)).toBe('ON HOLD');
    handle.failStatementOnce(
      'FROM offline_grant',
      new Error('SQLITE_BUSY: database is locked'),
    );
    await advance(PENDING_RECEIPT_READ_CADENCE_MS);
    // The HOLD is still in the ledger and readable; one minute later the
    // card must have caught up (the state has not changed on its own, but
    // "could not be read right now" must not outlive "right now").
    expect((await ledgerTruth()).wallet.hold).toBe(true);
    await advance(60_000);
    expect(badgeOf(renderer)).toBe('ON HOLD');
  });
});

describe('ATTACK 2 — trusted time becomes anchored while the card is on screen', () => {
  it('Analyze stops asking for an online check once the server confirms the time (floor-only relaunch)', async () => {
    jest.useFakeTimers();
    await holdGrant();
    mockReading = FLOOR_ONLY;
    const renderer = await render(<AnalyzeScreen />);
    await settleFake();
    expect(badgeOf(renderer)).toBe('CONFIRM ONLINE');
    expect(textOf(card(renderer))).toContain('could not be measured');

    // The sync runtime's drain (30 s cadence) gets an authenticated response
    // and api.ts anchors trusted time. The ledger now says the pass is live.
    mockReading = AT_ISSUE;
    expect(
      (await readOfflineAllocation(db, AT_ISSUE)).grants[0]?.execution.kind,
    ).toBe('active');

    // No navigation, no foreground event: the player is looking at Analyze.
    await advance(5 * 60_000);
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).not.toContain('needs an online check');
    expect(copy).toContain('In 6 days');
  });

  it('Settings stops asking for an online check once the server confirms the time (no trusted time at all)', async () => {
    jest.useFakeTimers();
    await holdGrant();
    mockReading = NO_TRUSTED_TIME;
    const renderer = await render(<SettingsScreen />);
    await settleFake();
    expect(badgeOf(renderer)).toBe('CONFIRM ONLINE');
    mockReading = AT_ISSUE;
    await advance(5 * 60_000);
    expect(badgeOf(renderer)).toBe('READY');
  });
});

describe('ATTACK 3 — copy: an expired or unconfirmed Pro lease', () => {
  function copyOf(state: OfflineJourneyState): string {
    const presented = presentOfflineJourney(state);
    return [
      presented.badge,
      presented.title,
      ...presented.rows.flatMap(row => [row.label, row.value]),
      ...presented.notes,
    ].join(' | ');
  }

  it('does not tell a Pro user that "results stay allocated" and that the pass "is never taken back" when the lease has expired and nothing is pending', async () => {
    await holdGrant(LAPSED_PRO_GRANT);
    const truth = await ledgerTruth();
    expect(truth.allocation.grants[0]?.execution.kind).toBe('expired');
    expect(truth.allocation.pendingReceipts).toBe(0);
    expect(truth.wallet.pending).toHaveLength(0);
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('EXPIRED');
    // A Pro lease is a time lease: it holds no allocation and, with nothing
    // pending, no results. Saying results stay allocated and the pass is
    // never taken back contradicts "Offline pass expired" on the same card.
    expect(copy).not.toContain('Pro pass results stay allocated');
    expect(copy).not.toContain('never taken back');
  });

  it('presenter: reconcile_required Pro lease with nothing pending makes no allocation claim', () => {
    const proGrant: HeldOfflineGrantView = {
      grantId: GRANT_ID,
      generation: 1,
      entitlementSource: 'verified_store',
      installationKeyId: INSTALLATION_KEY,
      keyId: KEY_ID,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      entitlementExpiresAt: EXPIRES_AT,
      grantJwsSha256: 'e'.repeat(64),
      allocated: 0,
      remaining: 0,
      consumed: 0,
      lifecycleSequence: 0,
      execution: { kind: 'reconcile_required', reason: 'no_trusted_time' },
    };
    const copy = copyOf({
      kind: 'read',
      allocation: {
        grants: [proGrant],
        spendableTickets: 0,
        consumedTickets: 0,
        pendingReceipts: 0,
      },
      wallet: { pending: [], unansweredPresentations: 0, hold: false },
    });
    expect(copy).toContain('CONFIRM ONLINE');
    expect(copy).not.toContain('results stay allocated');
  });
});

describe('ATTACK 4 — account switch while a quiet cadence read is in flight', () => {
  it('never publishes the previous account’s HOLD under the new account, and never reads the old ledger for it', async () => {
    jest.useFakeTimers();
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const gated = gatedDb();
    mockDb = () => gated.db;
    const renderer = await render(<SettingsScreen />);
    await settleFake();
    expect(badgeOf(renderer)).toBe('ON HOLD');

    // The cadence read starts and stalls inside storage...
    gated.arm();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(PENDING_RECEIPT_READ_CADENCE_MS);
    });
    // ...and the player switches account while it is stalled.
    await act(async () => {
      signInAs(OTHER_OWNER, 'token-2');
    });
    await settleFake();
    expect(badgeOf(renderer)).toBe('NONE HELD');

    // The stalled read finishes last. It belongs to the old owner.
    gated.release();
    await settleFake();
    await advance(PENDING_RECEIPT_READ_CADENCE_MS * 3);
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('NONE HELD');
    expect(copy).not.toContain('on hold');
    expect(copy).not.toContain('1 of 2');
    // No follow-up timer keeps re-reading on behalf of the old owner: with
    // nothing pending for the new owner, the ledger reads stop.
    const reads = handle.calls.filter(c => LEDGER_READ.test(c.sql)).length;
    await advance(PENDING_RECEIPT_READ_CADENCE_MS * 6);
    expect(handle.calls.filter(c => LEDGER_READ.test(c.sql)).length).toBe(
      reads,
    );
  });

  it('switching back to the original account shows its ledger as it is NOW, not the state read before the switch', async () => {
    jest.useFakeTimers();
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const renderer = await render(<SettingsScreen />);
    await settleFake();
    expect(badgeOf(renderer)).toBe('ON HOLD');
    await act(async () => {
      signInAs(OTHER_OWNER, 'token-2');
    });
    await settleFake();
    expect(badgeOf(renderer)).toBe('NONE HELD');
    // The original account's HOLD resolves while the other account is active.
    setActiveDataOwner(OWNER);
    const outcome = await presentAndReceive('result_recorded');
    expect(outcome.accepted).toBe(1);
    await act(async () => {
      signInAs(OWNER, 'token-3');
    });
    await settleFake();
    expect(badgeOf(renderer)).toBe('READY');
    expect(textOf(card(renderer))).toContain('Nothing');
  });
});

describe('ATTACK 5 — follow-up timers and mounted surfaces', () => {
  it('stops reading the ledger once the last surface unmounts (no orphan cadence after the screen is gone)', async () => {
    jest.useFakeTimers();
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const analyze = await render(<AnalyzeScreen />);
    const settings = await render(<SettingsScreen />);
    await settleFake();
    expect(badgeOf(analyze)).toBe('ON HOLD');
    expect(badgeOf(settings)).toBe('ON HOLD');

    // One surface leaves; the other must keep following.
    await unmount(settings);
    handle.calls.length = 0;
    await advance(PENDING_RECEIPT_READ_CADENCE_MS);
    expect(
      handle.calls.filter(c => LEDGER_READ.test(c.sql)).length,
    ).toBeGreaterThan(0);
    expect(handle.calls.filter(c => WRITE_STATEMENT.test(c.sql))).toEqual([]);

    // The last surface leaves; no read may follow.
    await unmount(analyze);
    handle.calls.length = 0;
    await advance(PENDING_RECEIPT_READ_CADENCE_MS * 20);
    expect(handle.calls.filter(c => LEDGER_READ.test(c.sql))).toEqual([]);
  });

  it('a quiet read that lands after the last surface unmounted does not arm a new timer', async () => {
    jest.useFakeTimers();
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const gated = gatedDb();
    mockDb = () => gated.db;
    const analyze = await render(<AnalyzeScreen />);
    await settleFake();
    expect(badgeOf(analyze)).toBe('ON HOLD');
    gated.arm();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(PENDING_RECEIPT_READ_CADENCE_MS);
    });
    await unmount(analyze);
    gated.release();
    await settleFake();
    handle.calls.length = 0;
    await advance(PENDING_RECEIPT_READ_CADENCE_MS * 20);
    expect(handle.calls.filter(c => LEDGER_READ.test(c.sql))).toEqual([]);
  });

  it('the lease-end follow-up never becomes a hot loop: a 1 ms remaining lease re-reads at the 1 s floor, not faster', async () => {
    jest.useFakeTimers();
    await holdGrant();
    mockReading = anchored(EXPIRES_AT * 1000 - 1);
    const renderer = await render(<AnalyzeScreen />);
    await settleFake();
    expect(badgeOf(renderer)).toBe('READY');
    const before = trustedReads;
    await advance(10_000);
    // Trusted time did not move (mock): each follow-up sees 1 ms remaining
    // again. Ten seconds may hold at most ~10 reads at the 1 s floor.
    expect(trustedReads - before).toBeLessThanOrEqual(11);
    expect(trustedReads - before).toBeGreaterThan(0);
  });
});

describe('ATTACK 6 — foreground storms and interleaved announce reads', () => {
  it('twenty inactive→active transitions in a row end in the correct state and never a torn or stale one', async () => {
    jest.useFakeTimers();
    await holdGrant();
    await spend('op-1');
    const renderer = await render(<AnalyzeScreen />);
    await settleFake();
    expect(badgeOf(renderer)).toBe('READY');
    const gated = gatedDb();
    mockDb = () => gated.db;
    // First of the storm stalls in storage; the other nineteen run.
    gated.arm();
    await act(async () => {
      background();
      foreground();
    });
    for (let i = 0; i < 19; i += 1) {
      await act(async () => {
        background();
        foreground();
      });
    }
    await settleFake();
    // A spend lands between the storm and the stalled read's completion.
    mockDb = () => db;
    await spend('op-2');
    await act(async () => {
      foreground();
    });
    await settleFake();
    expect(textOf(card(renderer))).toContain('0 of 2');
    gated.release();
    await settleFake();
    await advance(PENDING_RECEIPT_READ_CADENCE_MS);
    const copy = textOf(card(renderer));
    expect(copy).toContain('0 of 2');
    expect(copy).not.toContain('1 of 2');
    expect(badgeOf(renderer)).toBe('SPENT');
  });

  it('a foreground read only announces CHECKING when the previous state is genuinely unknown (documents the flash)', async () => {
    await holdGrant();
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    expect(badgeOf(renderer)).toBe('READY');
    const gated = gatedDb();
    mockDb = () => gated.db;
    gated.arm();
    await act(async () => {
      foreground();
    });
    // While the foreground read is in flight, the last known READY state is
    // still true (nothing changed); the candidate replaces it with CHECKING.
    const midFlight = badgeOf(renderer);
    gated.release();
    await settle();
    expect(badgeOf(renderer)).toBe('READY');
    // Recorded, not asserted as a break: an announce on every foreground is
    // the candidate's documented choice.
    expect(['READY', 'CHECKING']).toContain(midFlight);
  });
});

describe('ATTACK 7 — corrupt and partial persisted state', () => {
  it('a ticket row in an unknown state never becomes a spendable count', async () => {
    await holdGrant();
    await db.execute(
      `UPDATE offline_ticket SET state = 'released' WHERE owner_key = ? AND ticket_id = ?`,
      [OWNER, TICKETS[0]],
    );
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('UNAVAILABLE');
    expect(copy).not.toMatch(/\d of \d/);
    expect(copy).not.toContain('ready');
  });

  it('a consumed ticket whose receipt row is missing never presents as spent-and-synced', async () => {
    await holdGrant();
    await spend('op-1');
    await db.execute(`DELETE FROM offline_receipt WHERE owner_key = ?`, [
      OWNER,
    ]);
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('UNAVAILABLE');
    expect(copy).not.toContain('Waiting to sync | Nothing');
    expect(copy).not.toMatch(/\d of \d/);
  });

  it('a Pro lease row that hosts a ticket is corruption, not a Pro pass with a count', async () => {
    await holdGrant(FREE_GRANT);
    await db.execute(
      `UPDATE offline_grant SET entitlement_source = 'verified_store' WHERE owner_key = ? AND grant_id = ?`,
      [OWNER, GRANT_ID],
    );
    const renderer = await render(<SettingsScreen />);
    await settle();
    expect(badgeOf(renderer)).toBe('UNAVAILABLE');
    expect(textOf(card(renderer))).not.toContain('Pro');
  });

  it('a corrupt wallet journal row (unparseable receipt_ids) never becomes an empty queue', async () => {
    await holdGrant();
    await spend('op-1');
    await db.execute(
      `INSERT INTO offline_wallet_journal
         (owner_key, journal_id, kind, receipt_ids, state, opened_at, closed_at, verdicts)
       VALUES (?, ?, 'receipt_submission', ?, 'in_flight', ?, NULL, NULL)`,
      [
        OWNER,
        'dddddddd-0000-4000-8000-000000000002',
        '{not json',
        new Date(ISSUED_AT * 1000).toISOString(),
      ],
    );
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(['UNAVAILABLE', 'ON HOLD']).toContain(badgeOf(renderer));
    expect(copy).not.toContain('Waiting to sync | Nothing');
    expect(copy).not.toContain('ready');
  });
});

describe('ATTACK 8 — copy matrix across every verdict, entitlement and receipt phase', () => {
  const REASONS = [
    'no_trusted_time',
    'storage_invalid',
    'clock_rollback',
    'floor_only',
    'elapsed_unmeasured',
    'invalid_lease',
    'lease_ahead_of_clock',
  ] as const;

  function grant(
    pro: boolean,
    execution: TrustedTimeLeaseVerdict,
    remaining: number,
    consumed: number,
  ): HeldOfflineGrantView {
    return {
      grantId: GRANT_ID,
      generation: 1,
      entitlementSource: pro ? 'verified_store' : 'identity_lifetime_free',
      installationKeyId: INSTALLATION_KEY,
      keyId: KEY_ID,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      entitlementExpiresAt: pro ? EXPIRES_AT : null,
      grantJwsSha256: 'e'.repeat(64),
      allocated: pro ? 0 : remaining + consumed,
      remaining: pro ? 0 : remaining,
      consumed: pro ? 0 : consumed,
      lifecycleSequence: pro ? 0 : consumed,
      execution,
    };
  }

  function wallet(
    queued: number,
    unanswered: number,
    held: number,
    unidentified: boolean,
  ): OfflineWalletStatus {
    const pending: OfflineWalletPendingReceipt[] = [];
    let n = 0;
    const push = (phase: OfflineWalletReceiptPhase) => {
      n += 1;
      pending.push({
        receiptId: `receipt-${n}`,
        operationId: `op-${n}`,
        settlement: phase === 'held' ? 'held' : null,
        presentations: phase === 'queued' ? 0 : 1,
        phase,
      });
    };
    for (let i = 0; i < queued; i += 1) push('queued');
    for (let i = 0; i < unanswered; i += 1) push('presented_unanswered');
    for (let i = 0; i < held; i += 1) push('held');
    return {
      pending,
      unansweredPresentations: unanswered,
      hold: unanswered > 0 || unidentified,
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

  const verdicts: TrustedTimeLeaseVerdict[] = [
    { kind: 'active', remainingMs: 3 * 60 * 60 * 1000 },
    { kind: 'active', remainingMs: 7 * DAY_S * 1000 },
    { kind: 'active', remainingMs: 1 },
    { kind: 'expired' },
    ...REASONS.map(reason => ({ kind: 'reconcile_required', reason }) as const),
  ];

  it('every reachable state is dossier-compliant, grammatical, and never announces a zero or a promise the ledger did not make', () => {
    let states = 0;
    for (const pro of [false, true]) {
      for (const execution of verdicts) {
        const counts: ReadonlyArray<readonly [number, number]> = pro
          ? [[0, 0]]
          : [
              [2, 0],
              [1, 1],
              [0, 2],
            ];
        const receiptMixes: ReadonlyArray<
          readonly [number, number, number, boolean]
        > = [
          [0, 0, 0, false],
          [1, 0, 0, false],
          [2, 0, 0, false],
          [0, 1, 0, false],
          [0, 0, 1, false],
          [1, 1, 0, false],
          [0, 1, 1, false],
          [0, 0, 0, true],
        ];
        for (const [remaining, consumed] of counts) {
          for (const [queued, unanswered, held, unidentified] of receiptMixes) {
            states += 1;
            const copy = copyOf({
              kind: 'read',
              allocation: {
                grants: [grant(pro, execution, remaining, consumed)],
                spendableTickets: remaining,
                consumedTickets: consumed,
                pendingReceipts: queued + unanswered + held,
              },
              wallet: wallet(queued, unanswered, held, unidentified),
            });
            expectDossierCompliant(copy);
            expect(copy).not.toMatch(/\b1 (results|analyses|days|hours)\b/);
            expect(copy).not.toMatch(
              /\b(0|[2-9]) (result|analysis|day|hour)\b/,
            );
            expect(copy).not.toMatch(/\bYour 0\b/);
            expect(copy).not.toMatch(/\b0 held/);
            expect(copy).not.toMatch(
              /\b0 (result|results) (waiting|awaiting|on hold)/,
            );
            expect(copy).not.toMatch(/undefined|null|NaN|\[object/);
            if (execution.kind !== 'active') {
              expect(copy).not.toContain('READY');
              expect(copy).not.toMatch(/\bIn (\d|under)/);
            }
            if (unanswered + held > 0 || unidentified) {
              expect(copy).toContain('ON HOLD');
            } else {
              expect(copy).not.toContain('ON HOLD');
              expect(copy).not.toContain('charged twice');
            }
          }
        }
      }
    }
    expect(states).toBeGreaterThan(200);
  });

  it('the presenter never invents an allocation for a Pro lease under any verdict', () => {
    for (const execution of verdicts) {
      const copy = copyOf({
        kind: 'read',
        allocation: {
          grants: [grant(true, execution, 0, 0)],
          spendableTickets: 0,
          consumedTickets: 0,
          pendingReceipts: 0,
        },
        wallet: wallet(0, 0, 0, false),
      });
      expect(copy).not.toMatch(/\d of \d/);
      expect(copy).not.toContain('stay allocated');
    }
  });
});
