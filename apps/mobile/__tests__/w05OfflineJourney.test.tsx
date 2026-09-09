/**
 * W05-04 — the offline journey is visible where the player looks for it.
 *
 * The wallet (`offlineCapabilities.ts`), the write-ahead receipt journal
 * (`offlineWallet.ts`) and the trusted clock (`trustedTime.ts`) already know
 * how many offline analyses this phone holds, whether the lease is still
 * active under TRUSTED time, how many consumption receipts still owe the
 * server an answer, and whether one of those receipts is an ambiguous
 * commitment (a HOLD). Nothing on the shipping Analyze or Settings screens
 * said any of it. These tests pin the shipping screens — not a detached
 * component — to honest copy for every one of those states, and pin the copy
 * to the App Store dossier's vocabulary rules.
 *
 * Round 2 pins what the first candidate got wrong: the Analyze ready surface
 * must state the ledger as it is NOW (after a spend, a HOLD, a resolved HOLD,
 * a relaunch) rather than replay the last Settings read; a slow read that
 * finishes after a newer one must never overwrite it; a lapsed Pro lease
 * beside a live free allocation must not be called an active Pro pass; a
 * fully spent pass is not READY; a server-answered HOLD is not described as
 * an unanswered one; corrupt journal state never yields a zero count; and an
 * inconsistent remaining time is never presented as a live pass.
 *
 * Round 3 pins the ledger's movement WHILE a surface stays mounted: a HOLD
 * the sync drain resolves is cleared on screen — on the foreground transition
 * that started the drain (the read follows the drain instead of racing it)
 * and on the drain's own backed-off timer (the card watches the ledger while
 * anything is waiting to sync); Settings re-reads on foreground like Analyze;
 * a live lease is re-read at its trusted end so READY never outlives the
 * pass; and a fully spent pass that is expired or unconfirmed never
 * announces "0 held analyses".
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

type NavigationListener = () => void;
const focusListeners = new Set<NavigationListener>();
const blurListeners = new Set<NavigationListener>();
let mockFocused = true;
const mockNavigation = {
  replace: jest.fn(),
  goBack: jest.fn(),
  navigate: jest.fn(),
  popToTop: jest.fn(),
  isFocused: () => mockFocused,
  addListener: (event: string, listener: NavigationListener) => {
    const listeners =
      event === 'focus'
        ? focusListeners
        : event === 'blur'
          ? blurListeners
          : null;
    listeners?.add(listener);
    return () => {
      listeners?.delete(listener);
    };
  },
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

/** The shipping outbox drain as the journey surfaces reach it
 * (`triggerOutboxSync`): a test hands over the promise of the drain it
 * started itself, or nothing (no runtime configured). */
let mockDrainInFlight: (() => Promise<unknown>) | null = null;
jest.mock('../src/data/syncRuntime', () => {
  const actual = jest.requireActual<typeof import('../src/data/syncRuntime')>(
    '../src/data/syncRuntime',
  );
  return {
    ...actual,
    triggerOutboxSync: async () => {
      await mockDrainInFlight?.();
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
  OFFLINE_JOURNEY_SYNC_WATCH_MS,
  nextOfflineJourneyReadMs,
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

/** Vocabulary the App Store dossier forbids anywhere in user-facing copy. */
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
}

const FREE_GRANT: GrantShape = {
  entitlementSource: 'identity_lifetime_free',
  grantId: GRANT_ID,
  issuedAt: ISSUED_AT,
  expiresAt: EXPIRES_AT,
  entitlementExpiresAt: null,
};

const PRO_GRANT: GrantShape = {
  entitlementSource: 'verified_store',
  grantId: GRANT_ID,
  issuedAt: ISSUED_AT,
  expiresAt: EXPIRES_AT,
  entitlementExpiresAt: EXPIRES_AT + SIX_DAYS_S,
};

/** A Pro lease issued two weeks before the free allocation and lapsed a week
 * before it; the phone still holds the row (an unused pass is never taken
 * back automatically). */
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

/** Anchored exactly at issue: six whole days of lease remain. */
const AT_ISSUE = anchored(ISSUED_AT * 1000);
const HALF_HOUR_MS = 30 * 60 * 1000;
const HALF_HOUR_BEFORE_EXPIRY = anchored(EXPIRES_AT * 1000 - HALF_HOUR_MS);
const AFTER_EXPIRY = anchored(EXPIRES_AT * 1000 + 1000);

/** No confirmed time at all: the trusted clock refuses to vouch for elapsed
 * time, so every held pass needs an online check. */
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

const guestSession: AuthSession = {
  provider: 'guest',
  subject: 'local-only',
  canonicalAppUserId: null,
  localOnly: true,
  displayName: null,
  email: null,
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

type AppStateListener = (state: AppStateStatus) => void;
const appStateListeners = new Set<AppStateListener>();
const originalAppState = AppState.currentState;

/** The OS foreground / background transitions as the shipping hooks see
 * them. */
function foreground() {
  AppState.currentState = 'active';
  for (const listener of [...appStateListeners]) listener('active');
}

function background() {
  AppState.currentState = 'background';
  for (const listener of [...appStateListeners]) listener('background');
}

function emitFocus() {
  for (const listener of [...focusListeners]) listener();
}

function emitBlur() {
  for (const listener of [...blurListeners]) listener();
}

/** Advances fake timers by `ms` and lets every read they start finish. */
async function elapse(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

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

/** Presents the queued receipts and loses the connection before any answer
 * arrives: the journal entry stays `in_flight`, which the wallet reports as a
 * HOLD. Exactly the shipping drain path (`reconcileOfflineWallet`). */
async function presentAndLoseConnection() {
  fetchSpy?.mockRestore();
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new TypeError('Network request failed');
  });
  await expect(
    reconcileOfflineWallet(db, grantClient(), AT_ISSUE),
  ).rejects.toThrow('Network request failed');
}

/** Presents the queued receipts and receives `status` for each of them: the
 * server ANSWERED, so no presentation is left unanswered. Same drain path. */
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

/** The server's answer for every presented receipt, released only when the
 * test says so — this is how the drain's network round trip is ordered after
 * the card's ledger read. */
function answerReceiptsWhenReleased(status: string): { release(): void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
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
      await gate;
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
  return { release: () => release() };
}

/** The shipping drain (`syncRuntime` → `reconcileOfflineWallet`). */
function drain() {
  return reconcileOfflineWallet(db, grantClient(), AT_ISSUE);
}

function ledgerReads() {
  return handle.calls.filter(call => /FROM offline_/.test(call.sql));
}

/** The ledger's own answer, read directly — the fact the card must state. */
async function ledgerTruth() {
  return {
    allocation: await readOfflineAllocation(db, mockReading ?? AT_ISSUE),
    wallet: await readOfflineWalletStatus(db),
    pending: await pendingOfflineReceipts(db),
  };
}

/** Wraps the test database so its FIRST transaction stalls until `release()`
 * is called; every later transaction runs at once. */
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

const WRITE_STATEMENT =
  /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i;

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

beforeEach(() => {
  handle = createSqliteTestDb();
  db = handle.db;
  mockDb = () => db;
  mockReading = AT_ISSUE;
  mockDrainInFlight = null;
  mockFocused = true;
  focusListeners.clear();
  blurListeners.clear();
  appStateListeners.clear();
  AppState.currentState = 'active';
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((event, listener) => {
      expect(event).toBe('change');
      const change = listener as AppStateListener;
      appStateListeners.add(change);
      return { remove: jest.fn(() => appStateListeners.delete(change)) };
    });
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
  mockDrainInFlight = null;
  AppState.currentState = originalAppState;
  jest.useRealTimers();
  jest.restoreAllMocks();
  closeSqliteTestDatabases();
});

describe('W05-04 Settings surfaces the offline journey', () => {
  it('states the remaining allocation and the lease end measured by trusted time, not the phone clock', async () => {
    await holdGrant();
    // The phone's wall clock says the lease ended long ago; trusted time
    // (anchored at issue) says six days remain. The screen must follow the
    // trusted reading.
    const wallClock = jest
      .spyOn(Date, 'now')
      .mockReturnValue((EXPIRES_AT + SIX_DAYS_S) * 1000);
    try {
      const renderer = await render(<SettingsScreen />);
      await settle();
      const copy = textOf(card(renderer));
      expect(badgeOf(renderer)).toBe('READY');
      expect(copy).toContain('2 offline analyses ready');
      expect(copy).toContain('2 of 2');
      expect(copy).toContain('In 6 days');
      expect(copy).toContain('Nothing');
      expect(copy).toContain('not this phone’s clock');
      expectDossierCompliant(copy);
    } finally {
      wallClock.mockRestore();
    }
  });

  it('keeps counting held tickets after a spend and reports the receipt waiting to sync', async () => {
    await holdGrant();
    await spend('op-1');
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('1 offline analysis ready');
    expect(copy).toContain('1 of 2');
    expect(copy).toContain('1 result waiting');
    expectDossierCompliant(copy);
  });

  it('shows a HOLD for a receipt whose presentation never got an answer, and promises no double charge', async () => {
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(copy).toContain('1 result awaiting confirmation');
    expect(copy).toContain('1 on hold');
    expect(copy).toContain('nothing is charged twice');
    expect(copy).toContain('same receipt is presented again');
    // The HOLD never refunds: the spent ticket stays spent on screen.
    expect(copy).toContain('1 of 2');
    expectDossierCompliant(copy);
  });

  it('reports an expired lease while keeping the unspent allocation visible (allocation is not consumption)', async () => {
    await holdGrant();
    mockReading = anchored((EXPIRES_AT + 1) * 1000);
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('EXPIRED');
    expect(copy).toContain('Offline pass expired');
    expect(copy).toContain('2 held');
    expect(copy).toContain('Expired');
    expect(copy).toContain('stay allocated');
    expectDossierCompliant(copy);
  });

  it('asks for an online check when the phone has no trusted time at all', async () => {
    await holdGrant();
    mockReading = {
      authority: 'none',
      continuity: 'unmeasured',
      nowMs: ISSUED_AT * 1000,
      wallClockMs: ISSUED_AT * 1000,
      rollbackDetected: false,
      storage: 'empty',
    };
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('CONFIRM ONLINE');
    expect(copy).toContain('has not confirmed the time');
    expect(copy).toContain('2 held');
    expect(copy).toContain('Unconfirmed');
    expectDossierCompliant(copy);
  });

  it('does not claim an unexpired lease is active on a floor-only reading', async () => {
    await holdGrant();
    mockReading = {
      authority: 'floor',
      continuity: 'measured',
      nowMs: ISSUED_AT * 1000,
      wallClockMs: ISSUED_AT * 1000,
      rollbackDetected: false,
      storage: 'loaded',
    };
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('CONFIRM ONLINE');
    expect(copy).toContain('could not be measured');
    expect(copy).not.toContain('In 6 days');
    expectDossierCompliant(copy);
  });

  it('names a clock rollback as the reason the lease cannot be trusted', async () => {
    await holdGrant();
    mockReading = { ...AT_ISSUE, rollbackDetected: true };
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('CONFIRM ONLINE');
    expect(copy).toContain('moved backwards');
    expectDossierCompliant(copy);
  });

  it('describes a Pro lease without inventing a ticket count', async () => {
    await holdGrant(PRO_GRANT);
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('Pro offline pass active');
    expect(copy).toContain('Pro pass');
    expect(copy).toContain('In 6 days');
    expect(copy).not.toMatch(/\d of \d/);
    expectDossierCompliant(copy);
  });

  it('says nothing is held rather than inventing an allowance', async () => {
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('NONE HELD');
    expect(copy).toContain('No offline pass on this phone');
    expectDossierCompliant(copy);
  });

  it('never turns an unreadable wallet into an empty one', async () => {
    mockDb = () => {
      throw new Error('storage unavailable');
    };
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('UNAVAILABLE');
    expect(copy).toContain('could not be read');
    expect(copy).not.toContain('No offline pass');
    expect(copy).not.toMatch(/\d of \d/);
    expectDossierCompliant(copy);
  });

  it('shows nothing for a local-only guest, who has no server-issued allocation', async () => {
    useAuthStore.setState({ session: guestSession });
    setActiveDataOwner('device-guest');
    const renderer = await render(<SettingsScreen />);
    await settle();
    expect(cards(renderer)).toHaveLength(0);
  });

  it('describes a server-answered HOLD as still being confirmed, not as an answer that never arrived', async () => {
    await holdGrant();
    await spend('op-1');
    const outcome = await presentAndReceive('pending');
    expect(outcome.held).toBe(1);
    const truth = await ledgerTruth();
    expect(truth.wallet.hold).toBe(false);
    expect(truth.wallet.unansweredPresentations).toBe(0);
    expect(truth.wallet.pending.map(receipt => receipt.phase)).toEqual([
      'held',
    ]);
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(copy).toContain('1 result awaiting confirmation');
    expect(copy).toContain('1 on hold');
    expect(copy).toContain('still confirming');
    expect(copy).toContain('nothing is charged twice');
    expect(copy).not.toContain('never arrived');
    expect(copy).not.toContain('connection dropped');
    expectDossierCompliant(copy);
  });

  it('does not badge a fully spent pass READY', async () => {
    await holdGrant();
    await spend('op-1');
    await spend('op-2');
    const truth = await ledgerTruth();
    expect(truth.allocation.spendableTickets).toBe(0);
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('SPENT');
    expect(copy).toContain('Offline pass fully spent');
    expect(copy).toContain('0 of 2');
    expect(copy).toContain('2 results waiting');
    expect(copy).not.toContain('READY');
    expect(copy).not.toContain('ready');
    expectDossierCompliant(copy);
  });

  it('describes the live free allocation beside a lapsed Pro lease, never an active Pro pass', async () => {
    await holdGrant(LAPSED_PRO_GRANT);
    await holdGrant(FREE_GRANT);
    const truth = await ledgerTruth();
    expect(truth.allocation.spendableTickets).toBe(2);
    expect(
      truth.allocation.grants.map(grant => [
        grant.entitlementSource,
        grant.execution.kind,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['verified_store', 'expired'],
        ['identity_lifetime_free', 'active'],
      ]),
    );
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('2 offline analyses ready');
    expect(copy).toContain('2 of 2');
    expect(copy).toContain('In 6 days');
    expect(copy).not.toContain('Pro offline pass active');
    expect(copy).not.toContain('Pro pass');
    expectDossierCompliant(copy);
  });

  it('describes a lapsed Pro lease alone as expired, not active', async () => {
    await holdGrant(LAPSED_PRO_GRANT);
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('EXPIRED');
    expect(copy).toContain('Offline pass expired');
    expect(copy).not.toContain('Pro offline pass active');
    expect(copy).not.toMatch(/\d of \d/);
    expectDossierCompliant(copy);
  });

  it('never announces a zero count for a HOLD whose journal entry names no receipt on file', async () => {
    await holdGrant();
    // Corruption written straight to storage: an in-flight submission that
    // names a receipt the wallet no longer has on file.
    await db.execute(
      `INSERT INTO offline_wallet_journal
         (owner_key, journal_id, kind, receipt_ids, state, opened_at, closed_at, verdicts)
       VALUES (?, ?, 'receipt_submission', ?, 'in_flight', ?, NULL, NULL)`,
      [
        OWNER,
        'dddddddd-0000-4000-8000-000000000001',
        JSON.stringify(['receipt-that-no-longer-exists']),
        new Date(ISSUED_AT * 1000).toISOString(),
      ],
    );
    const truth = await ledgerTruth();
    expect(truth.wallet.hold).toBe(true);
    expect(truth.wallet.pending).toHaveLength(0);
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(copy).not.toContain('0 result');
    expect(copy).not.toContain('never arrived');
    expect(copy).toContain('never recorded');
    expect(copy).not.toMatch(/\bNothing\b/);
    expectDossierCompliant(copy);
  });

  it('drops a slow read that finishes after a newer one instead of publishing a torn snapshot', async () => {
    await holdGrant();
    const gated = gateFirstTransaction();
    mockDb = () => gated.db;
    // Read #1: Settings opens; its single transaction stalls at the gate.
    const first = await render(<SettingsScreen />);
    await settle();
    expect(badgeOf(first)).toBe('CHECKING');
    await act(async () => first.unmount());
    mounted = null;
    // The player spends a ticket while read #1 is still stalled.
    mockDb = () => db;
    await spend('op-1');
    // Read #2: Settings reopens and publishes the newer ledger.
    const second = await render(<SettingsScreen />);
    await settle();
    expect(textOf(card(second))).toContain('1 of 2');
    // Read #1 resumes and finishes last. It must be discarded.
    gated.release();
    await settle();
    const copy = textOf(card(second));
    expect(copy).toContain('1 of 2');
    expect(copy).toContain('1 result waiting');
    expect(copy).not.toContain('2 of 2');
  });

  it('reads the allocation and the receipt journal in ONE transaction so the pair can never tear', async () => {
    await holdGrant();
    await spend('op-1');
    handle.calls.length = 0;
    const renderer = await render(<SettingsScreen />);
    await settle();
    card(renderer);
    const isLedgerRead = (sql: string) =>
      /FROM offline_(grant|ticket|receipt|wallet_journal)\b/.test(sql);
    const indices = handle.calls.flatMap((call, index) =>
      isLedgerRead(call.sql) ? [index] : [],
    );
    expect(indices.length).toBeGreaterThan(1);
    const first = indices[0]!;
    const last = indices[indices.length - 1]!;
    const enclosing = handle.calls.slice(first, last + 1);
    // Every ledger read sits inside one open transaction: no BEGIN or
    // COMMIT between the first and the last of them, and one id throughout.
    expect(
      enclosing.filter(call => /^(BEGIN|COMMIT|ROLLBACK)/.test(call.sql)),
    ).toEqual([]);
    expect(new Set(enclosing.map(call => call.transaction)).size).toBe(1);
    expect(handle.calls[first - 1]?.sql).toBe('BEGIN IMMEDIATE');
  });
});

describe('W05-04 Analyze surfaces the offline journey', () => {
  /** A Settings visit that reads the wallet and publishes it. Used to prove
   * the Analyze surface does NOT replay that read once the ledger moves on. */
  async function visitSettings() {
    const settings = await render(<SettingsScreen />);
    await settle();
    card(settings);
    await act(async () => settings.unmount());
    mounted = null;
  }

  it('shows the held allocation and lease on the ready screen', async () => {
    await holdGrant();
    await spend('op-1');
    await visitSettings();
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('1 offline analysis ready');
    expect(copy).toContain('In 6 days');
    expect(copy).toContain('1 result waiting');
    expectDossierCompliant(copy);
  });

  it('shows the HOLD before another analysis is started', async () => {
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    await visitSettings();
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(copy).toContain('1 on hold');
    expectDossierCompliant(copy);
  });

  it('reads the ledger for the ready surface without writing anything before an attempt', async () => {
    await holdGrant();
    handle.calls.length = 0;
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    expect(badgeOf(renderer)).toBe('READY');
    expect(handle.calls.length).toBeGreaterThan(0);
    expect(handle.calls.filter(call => WRITE_STATEMENT.test(call.sql))).toEqual(
      [],
    );
  });

  it('never shows another account’s allocation', async () => {
    await holdGrant();
    await spend('op-1');
    await visitSettings();
    signInAs(OTHER_OWNER, 'token-2');
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    // The other account holds nothing; its own (empty) ledger is what shows.
    expect(badgeOf(renderer)).toBe('NONE HELD');
    expect(textOf(renderer.root)).not.toContain('1 of 2');
    expect(textOf(renderer.root)).not.toContain('waiting');
  });

  it('never shows a read taken under an earlier sign-in of the same account', async () => {
    await holdGrant();
    await spend('op-1');
    const settings = await render(<SettingsScreen />);
    await settle();
    expect(textOf(card(settings))).toContain('1 of 2');
    signInAs(OTHER_OWNER, 'token-2');
    await settle();
    await act(async () => settings.unmount());
    mounted = null;
    // The ledger moves on while the account is signed out of this phone.
    setActiveDataOwner(OWNER);
    await spend('op-2');
    signInAs(OWNER, 'token-3');
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(copy).toContain('0 of 2');
    expect(copy).not.toContain('1 of 2');
  });

  it('states the allocation after a spend made since the last Settings visit', async () => {
    await holdGrant();
    await visitSettings();
    await spend('op-1');
    const truth = await ledgerTruth();
    expect(truth.allocation.spendableTickets).toBe(1);
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('1 of 2');
    expect(copy).toContain('1 result waiting');
    expect(copy).not.toContain('2 of 2');
  });

  it('shows a HOLD created since the last Settings visit', async () => {
    await holdGrant();
    await spend('op-1');
    await visitSettings();
    await presentAndLoseConnection();
    expect((await ledgerTruth()).wallet.hold).toBe(true);
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(textOf(card(renderer))).toContain('1 on hold');
  });

  it('clears a HOLD the server resolved since the last Settings visit', async () => {
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    await visitSettings();
    const outcome = await presentAndReceive('result_recorded');
    expect(outcome.accepted).toBe(1);
    const truth = await ledgerTruth();
    expect(truth.wallet.hold).toBe(false);
    expect(truth.pending).toHaveLength(0);
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('1 of 2');
    expect(copy).toContain('Nothing');
    expect(copy).not.toContain('on hold');
  });

  it('surfaces a persisted HOLD on launch, before Settings was ever opened', async () => {
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    expect((await ledgerTruth()).wallet.hold).toBe(true);
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(copy).toContain('1 on hold');
    expect(copy).toContain('1 of 2');
    expectDossierCompliant(copy);
  });

  it('never turns an unreadable wallet into a missing card on the ready surface', async () => {
    mockDb = () => {
      throw new Error('storage unavailable');
    };
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    expect(badgeOf(renderer)).toBe('UNAVAILABLE');
    expect(textOf(card(renderer))).toContain('could not be read');
  });

  it('shows nothing for a local-only guest', async () => {
    useAuthStore.setState({ session: guestSession });
    setActiveDataOwner('device-guest');
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    expect(cards(renderer)).toHaveLength(0);
  });
});

describe('W05-04 presenter boundaries', () => {
  function activeGrant(remainingMs: number): HeldOfflineGrantView {
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
      execution: { kind: 'active', remainingMs },
    };
  }

  const quietWallet: OfflineWalletStatus = {
    pending: [],
    unansweredPresentations: 0,
    hold: false,
  };

  function copyOf(state: OfflineJourneyState): string {
    const presented = presentOfflineJourney(state);
    return [
      presented.badge,
      presented.title,
      ...presented.rows.flatMap(row => [row.label, row.value]),
      ...presented.notes,
    ].join(' | ');
  }

  it.each([Number.NaN, -1, Number.NEGATIVE_INFINITY, 0])(
    'never presents an active verdict with remainingMs=%p as a live pass',
    remainingMs => {
      const copy = copyOf({
        kind: 'read',
        allocation: {
          grants: [activeGrant(remainingMs)],
          spendableTickets: 2,
          consumedTickets: 0,
          pendingReceipts: 0,
        },
        wallet: quietWallet,
      });
      expect(copy).not.toContain('READY');
      expect(copy).not.toContain('In under an hour');
      expect(copy).not.toContain('ready');
      expectDossierCompliant(copy);
    },
  );

  it('presents a finite positive remaining time as a live pass', () => {
    const copy = copyOf({
      kind: 'read',
      allocation: {
        grants: [activeGrant(30 * 60 * 1000)],
        spendableTickets: 2,
        consumedTickets: 0,
        pendingReceipts: 0,
      },
      wallet: quietWallet,
    });
    expect(copy).toContain('READY');
    expect(copy).toContain('In under an hour');
  });
});

describe('W05-04 a HOLD the sync drain resolves is cleared while the surface stays mounted', () => {
  it('Analyze reads again once the drain the same foreground transition started has recorded the result', async () => {
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    expect(badgeOf(renderer)).toBe('ON HOLD');

    // The phone returns to the foreground. The runtime drains on this exact
    // AppState event; the server answers only after the card's immediate
    // read has already seen the ledger.
    background();
    const answer = answerReceiptsWhenReleased('result_recorded');
    let drained: Promise<unknown> | null = null;
    mockDrainInFlight = () => {
      drained ??= drain();
      return drained;
    };
    await act(async () => {
      foreground();
    });
    await settle();
    expect(badgeOf(renderer)).toBe('ON HOLD');
    answer.release();
    await act(async () => {
      await drained;
    });
    await settle();

    const truth = await ledgerTruth();
    expect(truth.wallet.hold).toBe(false);
    expect(truth.pending).toHaveLength(0);
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('1 of 2');
    expect(copy).toContain('Nothing');
    expect(copy).not.toContain('on hold');
    expect(copy).not.toContain('awaiting confirmation');
    expectDossierCompliant(copy);
  });

  it('Analyze reads again on its own while a receipt waits, so a drain nobody on screen triggered is still seen', async () => {
    jest.useFakeTimers();
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const renderer = await render(<AnalyzeScreen />);
    await elapse(0);
    expect(badgeOf(renderer)).toBe('ON HOLD');

    // No navigation, no foreground transition: the drain's backoff timer
    // fires while the player looks at the ready screen.
    const answer = answerReceiptsWhenReleased('result_recorded');
    answer.release();
    await act(async () => {
      const outcome = await drain();
      expect(outcome.accepted).toBe(1);
    });
    expect((await ledgerTruth()).wallet.hold).toBe(false);
    expect(badgeOf(renderer)).toBe('ON HOLD');

    await elapse(OFFLINE_JOURNEY_SYNC_WATCH_MS);
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('Nothing');
    expect(copy).not.toContain('on hold');

    // Nothing waits any more, so the card stops re-reading the ledger.
    handle.calls.length = 0;
    await elapse(OFFLINE_JOURNEY_SYNC_WATCH_MS * 4);
    expect(ledgerReads()).toEqual([]);
  });

  it('Settings reads again once a queued receipt is accepted, then rests', async () => {
    jest.useFakeTimers();
    await holdGrant();
    await spend('op-1');
    const renderer = await render(<SettingsScreen />);
    await elapse(0);
    expect(badgeOf(renderer)).toBe('READY');
    expect(textOf(card(renderer))).toContain('1 result waiting');

    const answer = answerReceiptsWhenReleased('result_recorded');
    answer.release();
    await act(async () => {
      expect((await drain()).accepted).toBe(1);
    });
    await elapse(OFFLINE_JOURNEY_SYNC_WATCH_MS);
    const copy = textOf(card(renderer));
    expect(copy).toContain('Nothing');
    expect(copy).not.toContain('waiting |');
    handle.calls.length = 0;
    await elapse(OFFLINE_JOURNEY_SYNC_WATCH_MS * 4);
    expect(ledgerReads()).toEqual([]);
  });

  it('the watch reads only: no ledger write across a dozen re-reads', async () => {
    jest.useFakeTimers();
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const renderer = await render(<AnalyzeScreen />);
    await elapse(0);
    expect(badgeOf(renderer)).toBe('ON HOLD');
    handle.calls.length = 0;
    for (let i = 0; i < 12; i += 1) await elapse(OFFLINE_JOURNEY_SYNC_WATCH_MS);
    const readTransactions = new Set(
      ledgerReads().map(call => call.transaction),
    );
    expect(readTransactions.size).toBeGreaterThanOrEqual(12);
    expect(handle.calls.filter(call => WRITE_STATEMENT.test(call.sql))).toEqual(
      [],
    );
    const truth = await ledgerTruth();
    expect(truth.wallet.hold).toBe(true);
    expect(truth.allocation.spendableTickets).toBe(1);
    expect(badgeOf(renderer)).toBe('ON HOLD');
  });

  it('a re-read keeps the last ledger state on screen instead of flashing CHECKING', async () => {
    jest.useFakeTimers();
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const renderer = await render(<AnalyzeScreen />);
    await elapse(0);
    expect(badgeOf(renderer)).toBe('ON HOLD');
    // The next scheduled read stalls inside its transaction: the card must
    // keep stating the last ledger read, not fall back to CHECKING.
    const gated = gateFirstTransaction();
    mockDb = () => gated.db;
    handle.calls.length = 0;
    await elapse(OFFLINE_JOURNEY_SYNC_WATCH_MS);
    expect(ledgerReads()).toEqual([]);
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(textOf(card(renderer))).toContain('1 on hold');
    gated.release();
    await elapse(0);
    expect(ledgerReads()).not.toEqual([]);
    expect(badgeOf(renderer)).toBe('ON HOLD');
  });

  it('an unmounted surface stops reading the ledger', async () => {
    jest.useFakeTimers();
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const renderer = await render(<AnalyzeScreen />);
    await elapse(0);
    expect(badgeOf(renderer)).toBe('ON HOLD');
    await act(async () => renderer.unmount());
    mounted = null;
    handle.calls.length = 0;
    await elapse(OFFLINE_JOURNEY_SYNC_WATCH_MS * 4);
    expect(ledgerReads()).toEqual([]);
    expect(appStateListeners.size).toBe(0);
  });

  it('a blurred Analyze neither watches the ledger nor reads it on foreground', async () => {
    jest.useFakeTimers();
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const renderer = await render(<AnalyzeScreen />);
    await elapse(0);
    expect(badgeOf(renderer)).toBe('ON HOLD');
    mockFocused = false;
    await act(async () => {
      emitBlur();
    });
    handle.calls.length = 0;
    await elapse(OFFLINE_JOURNEY_SYNC_WATCH_MS * 4);
    background();
    await act(async () => {
      foreground();
    });
    await elapse(0);
    expect(ledgerReads()).toEqual([]);
  });

  it('Analyze reads again when it regains focus after the drain recorded the result', async () => {
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    expect(badgeOf(renderer)).toBe('ON HOLD');
    const answer = answerReceiptsWhenReleased('result_recorded');
    answer.release();
    await act(async () => {
      expect((await drain()).accepted).toBe(1);
    });
    await act(async () => {
      emitFocus();
    });
    await settle();
    expect(badgeOf(renderer)).toBe('READY');
  });
});

describe('W05-04 Settings re-reads on foreground', () => {
  it('states a HOLD the drain resolved across a background/foreground cycle as resolved', async () => {
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const renderer = await render(<SettingsScreen />);
    await settle();
    expect(badgeOf(renderer)).toBe('ON HOLD');

    background();
    const answer = answerReceiptsWhenReleased('result_recorded');
    answer.release();
    await act(async () => {
      expect((await drain()).accepted).toBe(1);
    });
    await act(async () => {
      foreground();
    });
    await settle();

    expect((await ledgerTruth()).wallet.hold).toBe(false);
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('Nothing');
    expect(copy).not.toContain('on hold');
    expectDossierCompliant(copy);
  });

  it('a foreground read follows the drain the same transition started', async () => {
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const renderer = await render(<SettingsScreen />);
    await settle();
    expect(badgeOf(renderer)).toBe('ON HOLD');

    background();
    const answer = answerReceiptsWhenReleased('result_recorded');
    let drained: Promise<unknown> | null = null;
    mockDrainInFlight = () => {
      drained ??= drain();
      return drained;
    };
    await act(async () => {
      foreground();
    });
    await settle();
    expect(badgeOf(renderer)).toBe('ON HOLD');
    answer.release();
    await act(async () => {
      await drained;
    });
    await settle();
    expect(badgeOf(renderer)).toBe('READY');
  });

  it('a blurred Settings does not read on foreground', async () => {
    await holdGrant();
    const renderer = await render(<SettingsScreen />);
    await settle();
    expect(badgeOf(renderer)).toBe('READY');
    // useFocusEffect's cleanup runs on blur; the mock runs it on unmount.
    await act(async () => renderer.unmount());
    mounted = null;
    expect(appStateListeners.size).toBe(0);
  });
});

describe('W05-04 a lease that lapses while the ready screen stays in the foreground', () => {
  it('Analyze stops calling the pass READY once trusted time passes its end', async () => {
    jest.useFakeTimers();
    mockReading = HALF_HOUR_BEFORE_EXPIRY;
    await holdGrant();
    const renderer = await render(<AnalyzeScreen />);
    await elapse(0);
    expect(badgeOf(renderer)).toBe('READY');
    expect(textOf(card(renderer))).toContain('In under an hour');

    // Trusted time moves past the lease end while the phone stays in the
    // foreground and the player stays on the screen.
    mockReading = AFTER_EXPIRY;
    expect((await ledgerTruth()).allocation.grants[0]?.execution.kind).toBe(
      'expired',
    );
    await elapse(HALF_HOUR_MS - 1000);
    expect(badgeOf(renderer)).toBe('READY');
    await elapse(1000);
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('EXPIRED');
    expect(copy).toContain('Expired');
    expect(copy).not.toContain('In under an hour');
    expect(copy).not.toContain('ready');
    expectDossierCompliant(copy);
  });

  it('Settings stops calling the pass READY once trusted time passes its end', async () => {
    jest.useFakeTimers();
    mockReading = HALF_HOUR_BEFORE_EXPIRY;
    await holdGrant();
    const renderer = await render(<SettingsScreen />);
    await elapse(0);
    expect(badgeOf(renderer)).toBe('READY');
    mockReading = AFTER_EXPIRY;
    await elapse(HALF_HOUR_MS);
    expect(badgeOf(renderer)).toBe('EXPIRED');
    expect(textOf(card(renderer))).toContain('2 held analyses stay allocated');
  });

  it('a pass that trusted time still finds live at its scheduled end is read again at the new end, never in a tight loop', async () => {
    jest.useFakeTimers();
    mockReading = HALF_HOUR_BEFORE_EXPIRY;
    await holdGrant();
    const renderer = await render(<SettingsScreen />);
    await elapse(0);
    expect(badgeOf(renderer)).toBe('READY');
    // The trusted clock ran slower than the phone's timer: 10 s still remain.
    mockReading = anchored(EXPIRES_AT * 1000 - 10_000);
    handle.calls.length = 0;
    await elapse(HALF_HOUR_MS);
    const readsAtEnd = ledgerReads().length;
    expect(readsAtEnd).toBeGreaterThan(0);
    expect(badgeOf(renderer)).toBe('READY');
    handle.calls.length = 0;
    await elapse(9_000);
    expect(ledgerReads()).toEqual([]);
    mockReading = AFTER_EXPIRY;
    await elapse(1_000);
    expect(badgeOf(renderer)).toBe('EXPIRED');
  });

  it('a foreground transition after the lapse refreshes the lease (control)', async () => {
    mockReading = HALF_HOUR_BEFORE_EXPIRY;
    await holdGrant();
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    expect(badgeOf(renderer)).toBe('READY');
    mockReading = AFTER_EXPIRY;
    background();
    await act(async () => {
      foreground();
    });
    await settle();
    expect(badgeOf(renderer)).toBe('EXPIRED');
  });
});

describe('W05-04 no zero count on a fully spent pass that is expired or unconfirmed', () => {
  it('an expired, fully spent pass never announces "0 held analyses" staying allocated', async () => {
    await holdGrant();
    await spend('op-1');
    await spend('op-2');
    mockReading = AFTER_EXPIRY;
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('EXPIRED');
    expect(copy).toContain('0 of 2');
    expect(copy).toContain('2 results waiting');
    expect(copy).not.toMatch(/\b0 held analys/);
    expect(copy).not.toMatch(/\bYour 0\b/);
    expect(copy).not.toContain('stay allocated');
    expectDossierCompliant(copy);
  });

  it('an unconfirmed (no trusted time), fully spent pass never announces "0 held analyses"', async () => {
    await holdGrant();
    await spend('op-1');
    await spend('op-2');
    mockReading = NO_TRUSTED_TIME;
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('CONFIRM ONLINE');
    expect(copy).toContain('has not confirmed the time');
    expect(copy).not.toMatch(/\b0 held analys/);
    expect(copy).not.toMatch(/\bYour 0\b/);
    expect(copy).not.toContain('stay allocated');
    expectDossierCompliant(copy);
  });

  it('a partly spent expired pass still says its held analyses stay allocated', async () => {
    await holdGrant();
    await spend('op-1');
    mockReading = AFTER_EXPIRY;
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('EXPIRED');
    expect(copy).toContain('Your 1 held analysis stay');
    expectDossierCompliant(copy);
  });

  it('presenter: an expired or unconfirmed grant with no spendable ticket has no zero-count note', () => {
    const spentGrant = (
      execution: HeldOfflineGrantView['execution'],
    ): HeldOfflineGrantView => ({
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
      remaining: 0,
      consumed: 2,
      lifecycleSequence: 2,
      execution,
    });
    const wallet: OfflineWalletStatus = {
      pending: [],
      unansweredPresentations: 0,
      hold: false,
    };
    for (const execution of [
      { kind: 'expired' } as const,
      { kind: 'reconcile_required', reason: 'no_trusted_time' } as const,
    ]) {
      const presented = presentOfflineJourney({
        kind: 'read',
        allocation: {
          grants: [spentGrant(execution)],
          spendableTickets: 0,
          consumedTickets: 2,
          pendingReceipts: 0,
        },
        wallet,
      });
      const copy = [presented.title, ...presented.notes].join(' | ');
      expect(copy).not.toMatch(/\b0 held analys/);
      expect(copy).not.toMatch(/\bYour 0\b/);
    }
  });
});

describe('W05-04 the next scheduled read', () => {
  function grant(
    execution: HeldOfflineGrantView['execution'],
    grantId = GRANT_ID,
  ): HeldOfflineGrantView {
    return {
      grantId,
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
      execution,
    };
  }
  const quiet: OfflineWalletStatus = {
    pending: [],
    unansweredPresentations: 0,
    hold: false,
  };
  const queued: OfflineWalletStatus = {
    pending: [
      {
        receiptId: 'r-1',
        operationId: 'op-1',
        settlement: null,
        presentations: 0,
        phase: 'queued',
      },
    ],
    unansweredPresentations: 0,
    hold: false,
  };
  function read(
    grants: HeldOfflineGrantView[],
    wallet: OfflineWalletStatus,
  ): OfflineJourneyState {
    return {
      kind: 'read',
      allocation: {
        grants,
        spendableTickets: 2,
        consumedTickets: 0,
        pendingReceipts: wallet.pending.length,
      },
      wallet,
    };
  }

  it('is never scheduled while nothing can change on its own', () => {
    expect(nextOfflineJourneyReadMs({ kind: 'loading' })).toBeNull();
    expect(nextOfflineJourneyReadMs({ kind: 'unavailable' })).toBeNull();
    expect(nextOfflineJourneyReadMs(read([], quiet))).toBeNull();
    expect(
      nextOfflineJourneyReadMs(read([grant({ kind: 'expired' })], quiet)),
    ).toBeNull();
    expect(
      nextOfflineJourneyReadMs(
        read(
          [grant({ kind: 'reconcile_required', reason: 'no_trusted_time' })],
          quiet,
        ),
      ),
    ).toBeNull();
  });

  it('falls at the soonest live lease end, and at the sync watch while anything waits', () => {
    const soon = grant({ kind: 'active', remainingMs: HALF_HOUR_MS });
    const later = grant(
      { kind: 'active', remainingMs: 3 * HALF_HOUR_MS },
      LAPSED_PRO_GRANT_ID,
    );
    expect(nextOfflineJourneyReadMs(read([later, soon], quiet))).toBe(
      HALF_HOUR_MS,
    );
    expect(nextOfflineJourneyReadMs(read([later, soon], queued))).toBe(
      OFFLINE_JOURNEY_SYNC_WATCH_MS,
    );
    expect(nextOfflineJourneyReadMs(read([], queued))).toBe(
      OFFLINE_JOURNEY_SYNC_WATCH_MS,
    );
    expect(
      nextOfflineJourneyReadMs(
        read([grant({ kind: 'active', remainingMs: 250 })], queued),
      ),
    ).toBe(1000);
    expect(
      nextOfflineJourneyReadMs(
        read([grant({ kind: 'active', remainingMs: 250 })], quiet),
      ),
    ).toBe(1000);
  });

  it('is bounded: an inconsistent live verdict schedules nothing and a distant end is clamped to a real timer', () => {
    for (const remainingMs of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      expect(
        nextOfflineJourneyReadMs(
          read([grant({ kind: 'active', remainingMs })], quiet),
        ),
      ).toBeNull();
    }
    expect(
      nextOfflineJourneyReadMs(
        read([grant({ kind: 'active', remainingMs: 2 ** 40 })], quiet),
      ),
    ).toBe(2 ** 31 - 1);
  });
});
