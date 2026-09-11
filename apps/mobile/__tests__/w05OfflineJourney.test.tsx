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
 * Round 3 pins what the second candidate got wrong: a card that stays on
 * screen must keep following the ledger — a HOLD the sync drain resolves
 * (on the foreground transition that started the drain, or on the drain's
 * own timer) leaves the screen without navigation; Settings re-reads on
 * foreground like Analyze; a pass whose trusted end passes while the ready
 * screen is open stops being READY; and a fully spent pass never announces
 * "0 held analyses" whatever the lease verdict.
 *
 * Round 4 pins what the third candidate got wrong: a card that says the pass
 * needs an online check must stop saying so once trusted time is confirmed
 * while it stays on screen (and must stop saying READY once a clock rollback
 * is detected); one transient storage failure on a quiet follow-up read must
 * not park the card on "could not be read" for the rest of the visit; a Pro
 * lease that has expired or is unconfirmed holds no allocation, so no
 * sentence may claim its results "stay allocated"; a ticket stranded in an
 * expired generation that the ledger refuses to spend is never announced as
 * an offline analysis ready; and a HOLD the server answered with a refusal
 * is not described as a dropped connection.
 *
 * Round 5 pins what the fourth candidate got wrong: a Pro lease that is NOT
 * live (lapsed, or unconfirmed for want of trusted time) lends nothing to
 * the copy — the free tickets this phone still holds are counted and their
 * retention stated exactly as they would be without the Pro row, and the
 * wallet is never labelled a Pro pass; a live Pro lease beside held free
 * tickets states their count; a HOLD whose journal entry names no pending
 * receipt is not described as a receipt that "was never recorded" (the
 * receipt may be on file and settled); and a HOLD over several receipts
 * keeps count and noun in agreement.
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
  HELD_PASS_READ_CADENCE_MS,
  PENDING_RECEIPT_READ_CADENCE_MS,
  presentOfflineJourney,
  type OfflineJourneyState,
} from '../src/components/OfflineAllocationCard';
import {
  clearApiSession,
  establishApiSession,
  getApiSession,
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
  clearSyncRuntime,
  configureSyncRuntime,
  triggerOutboxSync,
} from '../src/data/syncRuntime';
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
const SECOND_GENERATION_GRANT_ID = 'bbbbbbbb-0000-4000-8000-000000000003';
const LATER_PRO_GRANT_ID = 'bbbbbbbb-0000-4000-8000-000000000004';
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
  readonly generation?: number;
  readonly ticketIds?: readonly string[];
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

/** A Pro lease issued the day AFTER the free allocation: a free player who
 * subscribed while still holding free tickets. Same generation, so the
 * ledger lists it first. */
const LATER_PRO_GRANT: GrantShape = {
  entitlementSource: 'verified_store',
  grantId: LATER_PRO_GRANT_ID,
  issuedAt: ISSUED_AT + DAY_S,
  expiresAt: ISSUED_AT + 7 * DAY_S,
  entitlementExpiresAt: ISSUED_AT + 30 * DAY_S,
};

/** The server's next generation for this installation, issued a day after
 * generation 1 lapsed: it restates only the ticket still outstanding
 * server-side. The other ticket stays allocated to this phone under the
 * expired generation — never reclaimed, never executable. */
const SECOND_GENERATION_ISSUED_AT = EXPIRES_AT + DAY_S;
const SECOND_GENERATION_GRANT: GrantShape = {
  entitlementSource: 'identity_lifetime_free',
  grantId: SECOND_GENERATION_GRANT_ID,
  issuedAt: SECOND_GENERATION_ISSUED_AT,
  expiresAt: SECOND_GENERATION_ISSUED_AT + SIX_DAYS_S,
  entitlementExpiresAt: null,
  generation: 2,
  ticketIds: [TICKETS[1]],
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
            allocationId: shape.grantId,
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

/** Anchored exactly at issue: six whole days of lease remain. */
const AT_ISSUE = anchored(ISSUED_AT * 1000);
const AT_SECOND_GENERATION_ISSUE = anchored(SECOND_GENERATION_ISSUED_AT * 1000);
const HALF_HOUR_MS = 30 * 60 * 1000;
const HALF_HOUR_BEFORE_EXPIRY = anchored(EXPIRES_AT * 1000 - HALF_HOUR_MS);
const AFTER_EXPIRY = anchored(EXPIRES_AT * 1000 + 1000);
/** The phone has never confirmed the time with the server. */
const NO_TRUSTED_TIME: TrustedTimeReading = {
  authority: 'none',
  continuity: 'unmeasured',
  nowMs: ISSUED_AT * 1000,
  wallClockMs: ISSUED_AT * 1000,
  rollbackDetected: false,
  storage: 'empty',
};
/** The launch reading before any authenticated response has anchored the
 * clock: a persisted floor, elapsed time measured, no anchor. */
const FLOOR_ONLY: TrustedTimeReading = {
  authority: 'floor',
  continuity: 'measured',
  nowMs: ISSUED_AT * 1000,
  wallClockMs: ISSUED_AT * 1000,
  rollbackDetected: false,
  storage: 'loaded',
};
const ROLLED_BACK: TrustedTimeReading = { ...AT_ISSUE, rollbackDetected: true };

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

async function spend(operationId: string, reading = AT_ISSUE) {
  return consumeOfflineAllocation(db, consumption(operationId), reading);
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

/** Presents the queued receipts and the server refuses the whole request
 * with an HTTP status (rate limit, outage): no verdict per receipt, so the
 * journal entry stays `in_flight` and the wallet reports a HOLD. */
async function presentAndBeRefused(status: number) {
  fetchSpy?.mockRestore();
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          error: { code: 'rate_limited', message: 'Too many requests.' },
        }),
        {
          status,
          headers: { 'content-type': 'application/json', 'retry-after': '30' },
        },
      ),
  );
  await expect(
    reconcileOfflineWallet(db, grantClient(), AT_ISSUE),
  ).rejects.toThrow();
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

/** The ledger's own answer, read directly — the fact the card must state. */
async function ledgerTruth() {
  return {
    allocation: await readOfflineAllocation(db, AT_ISSUE),
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
const LEDGER_READ = /FROM offline_(grant|ticket|receipt|wallet_journal)\b/;

function ledgerReads(): number {
  return handle.calls.filter(call => LEDGER_READ.test(call.sql)).length;
}

/** `settle()` for a test running on fake timers: flushes due timers and
 * the promise chains behind them without advancing the clock. */
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
    // The card cannot see whether the named receipt ever existed or was
    // settled since; it only knows no pending receipt carries that id.
    expect(copy).toContain('names no receipt that is still waiting');
    expect(copy).not.toContain('never recorded');
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

  it('never announces a zero count for a fully spent pass, whatever the lease verdict', () => {
    const verdicts: TrustedTimeLeaseVerdict[] = [
      { kind: 'expired' },
      { kind: 'reconcile_required', reason: 'no_trusted_time' },
      { kind: 'reconcile_required', reason: 'clock_rollback' },
    ];
    for (const execution of verdicts) {
      const copy = copyOf({
        kind: 'read',
        allocation: {
          grants: [{ ...activeGrant(0), remaining: 0, consumed: 2, execution }],
          spendableTickets: 0,
          consumedTickets: 2,
          pendingReceipts: 0,
        },
        wallet: quietWallet,
      });
      expect(copy).toContain('0 of 2');
      expect(copy).not.toMatch(/\b0 held analys/);
      expect(copy).not.toMatch(/\bYour 0\b/);
      expectDossierCompliant(copy);
    }
  });
});

describe('W05-04 the card keeps following the ledger while it stays on screen', () => {
  type ChangeListener = (state: AppStateStatus) => void;
  const appStateListeners = new Set<ChangeListener>();
  const originalAppState = AppState.currentState;

  /** The OS transitions as every shipping AppState subscriber sees them. */
  function foreground() {
    AppState.currentState = 'active';
    for (const listener of [...appStateListeners]) listener('active');
  }

  function background() {
    AppState.currentState = 'background';
    for (const listener of [...appStateListeners]) listener('background');
  }

  const RECEIPTS_PATH = '/v1/offline/receipts';

  /** The connection is down: every request fails before an answer. */
  function loseConnection() {
    fetchSpy?.mockRestore();
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new TypeError('Network request failed');
    });
  }

  /** Answers every presented receipt with `status`, but only once released,
   * so the server's answer can be ordered after the card's own reads. The
   * route is matched by path: the sync runtime builds its client on the API
   * session's origin, the direct drain on the grant issuer. */
  function answerReceiptsWhenReleased(status: string): {
    release(): void;
    presented(): number;
  } {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let presented = 0;
    fetchSpy?.mockRestore();
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        if (new URL(String(input)).pathname !== RECEIPTS_PATH) {
          return new Response(JSON.stringify({ error: 'not_found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        presented += 1;
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
    return { release: () => release(), presented: () => presented };
  }

  function apiSession() {
    const session = getApiSession();
    if (!session) throw new Error('the test signs in before configuring sync');
    return session;
  }

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

  it('Analyze states READY within the read cadence once the drain the foreground transition started records the result', async () => {
    jest.useFakeTimers();
    await holdGrant();
    await spend('op-1');
    // The shipping sync runtime presents the receipt and the connection drops
    // before the answer: a HOLD, recorded by the runtime's own drain.
    loseConnection();
    configureSyncRuntime(apiSession());
    await triggerOutboxSync();
    expect((await ledgerTruth()).wallet.hold).toBe(true);
    const renderer = await render(<AnalyzeScreen />);
    await settleFake();
    expect(badgeOf(renderer)).toBe('ON HOLD');

    background();
    const answer = answerReceiptsWhenReleased('result_recorded');
    await act(async () => {
      foreground();
    });
    await settleFake();
    // The runtime's drain re-presented the receipt on the same transition
    // and is still waiting for the server: the HOLD stands, honestly.
    expect(answer.presented()).toBe(1);
    expect(badgeOf(renderer)).toBe('ON HOLD');

    answer.release();
    await settleFake();
    const truth = await ledgerTruth();
    expect(truth.wallet.hold).toBe(false);
    expect(truth.pending).toHaveLength(0);
    // The drain announces nothing; the card catches up by reading again.
    await advance(PENDING_RECEIPT_READ_CADENCE_MS);
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('Nothing');
    expect(copy).not.toContain('on hold');
    expect(copy).not.toContain('awaiting confirmation');
    expectDossierCompliant(copy);
  });

  it('Analyze states READY within the read cadence after a timer-driven drain resolved the HOLD, with no navigation or foreground event', async () => {
    jest.useFakeTimers();
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const renderer = await render(<AnalyzeScreen />);
    await settleFake();
    expect(badgeOf(renderer)).toBe('ON HOLD');

    const outcome = await presentAndReceive('result_recorded');
    expect(outcome.accepted).toBe(1);
    expect((await ledgerTruth()).wallet.hold).toBe(false);
    handle.calls.length = 0;

    await advance(PENDING_RECEIPT_READ_CADENCE_MS);
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('1 of 2');
    expect(copy).toContain('Nothing');
    expect(copy).not.toContain('on hold');
    // The card caught up by reading; it wrote nothing.
    expect(handle.calls.length).toBeGreaterThan(0);
    expect(handle.calls.filter(call => WRITE_STATEMENT.test(call.sql))).toEqual(
      [],
    );
  });

  it('Settings states READY after a HOLD resolved across a background/foreground cycle', async () => {
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const renderer = await render(<SettingsScreen />);
    await settle();
    expect(badgeOf(renderer)).toBe('ON HOLD');

    background();
    const outcome = await presentAndReceive('result_recorded');
    expect(outcome.accepted).toBe(1);
    await act(async () => {
      foreground();
    });
    await settle();

    expect((await ledgerTruth()).wallet.hold).toBe(false);
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('Nothing');
    expect(copy).not.toContain('on hold');
  });

  it('Analyze stops calling a pass READY once trusted time passes its end while the ready screen stays open', async () => {
    jest.useFakeTimers();
    mockReading = HALF_HOUR_BEFORE_EXPIRY;
    await holdGrant();
    const renderer = await render(<AnalyzeScreen />);
    await settleFake();
    expect(badgeOf(renderer)).toBe('READY');
    expect(textOf(card(renderer))).toContain('In under an hour');

    // Trusted time has not moved on: the phone's timers alone prove nothing.
    await advance(HALF_HOUR_MS - 60_000);
    expect(badgeOf(renderer)).toBe('READY');

    mockReading = AFTER_EXPIRY;
    expect(
      (await readOfflineAllocation(db, AFTER_EXPIRY)).grants[0]?.execution.kind,
    ).toBe('expired');
    await advance(2 * 60_000);
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('EXPIRED');
    expect(copy).not.toContain('In under an hour');
    expect(copy).toContain('Expired');
    expectDossierCompliant(copy);
  });

  it('an expired, fully spent pass never announces "0 held analyses" on Analyze', async () => {
    await holdGrant();
    await spend('op-1');
    await spend('op-2');
    mockReading = AFTER_EXPIRY;
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('EXPIRED');
    expect(copy).toContain('0 of 2');
    expect(copy).not.toMatch(/\b0 held analys/);
    expect(copy).not.toMatch(/\bYour 0\b/);
    expectDossierCompliant(copy);
  });

  it('an unconfirmed, fully spent pass never announces "0 held analyses" on Settings', async () => {
    await holdGrant();
    await spend('op-1');
    await spend('op-2');
    mockReading = NO_TRUSTED_TIME;
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('CONFIRM ONLINE');
    expect(copy).toContain('0 of 2');
    expect(copy).not.toMatch(/\b0 held analys/);
    expect(copy).not.toMatch(/\bYour 0\b/);
    expectDossierCompliant(copy);
  });
});

describe('W05-04 round 4 — the card follows trusted time, recovers from a transient read failure and never invents an allocation', () => {
  afterEach(async () => {
    if (mounted) await act(async () => mounted?.unmount());
    mounted = null;
    jest.useRealTimers();
  });

  function copyOf(state: OfflineJourneyState): string {
    const presented = presentOfflineJourney(state);
    return [
      presented.badge,
      presented.title,
      ...presented.rows.flatMap(row => [row.label, row.value]),
      ...presented.notes,
    ].join(' | ');
  }

  function proGrant(execution: TrustedTimeLeaseVerdict): HeldOfflineGrantView {
    return {
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
      execution,
    };
  }

  it('Analyze stops asking for an online check once the server confirms the time while the ready screen stays open (floor-only relaunch)', async () => {
    jest.useFakeTimers();
    await holdGrant();
    mockReading = FLOOR_ONLY;
    const renderer = await render(<AnalyzeScreen />);
    await settleFake();
    expect(badgeOf(renderer)).toBe('CONFIRM ONLINE');
    expect(textOf(card(renderer))).toContain('could not be measured');

    // The phone's timers alone prove nothing: with the reading unchanged the
    // card keeps asking for the check.
    await advance(HELD_PASS_READ_CADENCE_MS);
    expect(badgeOf(renderer)).toBe('CONFIRM ONLINE');

    // The sync runtime's next authenticated response anchors trusted time;
    // the ledger now executes the pass. No navigation, no foreground event.
    mockReading = AT_ISSUE;
    expect(
      (await readOfflineAllocation(db, AT_ISSUE)).grants[0]?.execution.kind,
    ).toBe('active');
    handle.calls.length = 0;
    await advance(HELD_PASS_READ_CADENCE_MS);
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('In 6 days');
    expect(copy).not.toContain('needs an online check');
    expect(copy).not.toContain('could not be measured');
    // The card caught up by reading; it wrote nothing.
    expect(ledgerReads()).toBeGreaterThan(0);
    expect(handle.calls.filter(call => WRITE_STATEMENT.test(call.sql))).toEqual(
      [],
    );
    expectDossierCompliant(copy);
  });

  it('Settings stops asking for an online check once trusted time is confirmed (no trusted time at all at mount)', async () => {
    jest.useFakeTimers();
    await holdGrant();
    mockReading = NO_TRUSTED_TIME;
    const renderer = await render(<SettingsScreen />);
    await settleFake();
    expect(badgeOf(renderer)).toBe('CONFIRM ONLINE');
    expect(textOf(card(renderer))).toContain('has not confirmed the time');
    mockReading = AT_ISSUE;
    await advance(HELD_PASS_READ_CADENCE_MS);
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('2 offline analyses ready');
    expect(copy).not.toContain('has not confirmed the time');
  });

  it('Analyze stops calling a pass READY once a clock rollback is detected while the ready screen stays open', async () => {
    jest.useFakeTimers();
    await holdGrant();
    const renderer = await render(<AnalyzeScreen />);
    await settleFake();
    expect(badgeOf(renderer)).toBe('READY');

    mockReading = ROLLED_BACK;
    expect(
      (await readOfflineAllocation(db, ROLLED_BACK)).grants[0]?.execution,
    ).toEqual({ kind: 'reconcile_required', reason: 'clock_rollback' });
    await expect(spend('probe', ROLLED_BACK)).rejects.toMatchObject({
      code: 'offline.time_reconcile_required',
    });
    await advance(HELD_PASS_READ_CADENCE_MS);
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('CONFIRM ONLINE');
    expect(copy).toContain('moved backwards');
    expect(copy).not.toContain('READY');
    expect(copy).not.toContain('In 6 days');
    expectDossierCompliant(copy);
  });

  it('keeps following a HOLD after one transient storage failure on a quiet read, so the resolved HOLD still leaves the screen', async () => {
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

    // The card stays on screen; nothing is navigated, backgrounded or
    // foregrounded. Within one more cadence the resolved HOLD is on screen.
    handle.calls.length = 0;
    await advance(PENDING_RECEIPT_READ_CADENCE_MS);
    expect(ledgerReads()).toBeGreaterThan(0);
    expect(handle.calls.filter(call => WRITE_STATEMENT.test(call.sql))).toEqual(
      [],
    );
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('1 of 2');
    expect(copy).toContain('Nothing');
    expect(copy).not.toContain('could not be read');
  });

  it('a transient failure on a quiet read does not replace a known HOLD with "could not be read" for good', async () => {
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
    expect(badgeOf(renderer)).toBe('UNAVAILABLE');
    // The HOLD is still in the ledger and readable: "could not be read right
    // now" must not outlive "right now".
    expect((await ledgerTruth()).wallet.hold).toBe(true);
    await advance(PENDING_RECEIPT_READ_CADENCE_MS);
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(copy).toContain('1 on hold');
    expect(copy).toContain('1 of 2');
  });

  it('stops reading the ledger once the last surface unmounts, and never reads on a cadence when nothing is held or pending', async () => {
    jest.useFakeTimers();
    await holdGrant();
    const analyze = await render(<AnalyzeScreen />);
    await settleFake();
    expect(badgeOf(analyze)).toBe('READY');
    handle.calls.length = 0;
    await advance(HELD_PASS_READ_CADENCE_MS);
    expect(ledgerReads()).toBeGreaterThan(0);

    await act(async () => analyze.unmount());
    mounted = null;
    handle.calls.length = 0;
    await advance(HELD_PASS_READ_CADENCE_MS * 20);
    expect(ledgerReads()).toBe(0);

    // A wallet with nothing held and nothing pending changes only through a
    // user action or a foreground event: no timer reads it.
    signInAs(OTHER_OWNER, 'token-2');
    const settings = await render(<SettingsScreen />);
    await settleFake();
    expect(badgeOf(settings)).toBe('NONE HELD');
    handle.calls.length = 0;
    await advance(HELD_PASS_READ_CADENCE_MS * 20);
    expect(ledgerReads()).toBe(0);
  });

  it('does not tell a Pro user that results "stay allocated" or that the pass is "never taken back" once the lease has expired with nothing pending', async () => {
    await holdGrant(LAPSED_PRO_GRANT);
    const truth = await ledgerTruth();
    expect(truth.allocation.grants[0]?.execution.kind).toBe('expired');
    expect(truth.allocation.pendingReceipts).toBe(0);
    expect(truth.wallet.pending).toHaveLength(0);
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('EXPIRED');
    expect(copy).toContain('Offline pass expired');
    expect(copy).toContain('Pro pass');
    // A Pro lease is a time lease: it holds no allocation and, with nothing
    // pending, no results. Saying results stay allocated and the pass is
    // never taken back would contradict "Offline pass expired" on the card.
    expect(copy).not.toContain('stay allocated');
    expect(copy).not.toContain('never taken back');
    expect(copy).not.toContain('results');
    expectDossierCompliant(copy);
  });

  it('presenter: a Pro lease makes no allocation claim under any verdict', () => {
    const verdicts: TrustedTimeLeaseVerdict[] = [
      { kind: 'active', remainingMs: 3 * 60 * 60 * 1000 },
      { kind: 'expired' },
      { kind: 'reconcile_required', reason: 'no_trusted_time' },
      { kind: 'reconcile_required', reason: 'floor_only' },
      { kind: 'reconcile_required', reason: 'clock_rollback' },
      { kind: 'reconcile_required', reason: 'storage_invalid' },
      { kind: 'reconcile_required', reason: 'elapsed_unmeasured' },
      { kind: 'reconcile_required', reason: 'invalid_lease' },
      { kind: 'reconcile_required', reason: 'lease_ahead_of_clock' },
    ];
    for (const execution of verdicts) {
      const copy = copyOf({
        kind: 'read',
        allocation: {
          grants: [proGrant(execution)],
          spendableTickets: 0,
          consumedTickets: 0,
          pendingReceipts: 0,
        },
        wallet: { pending: [], unansweredPresentations: 0, hold: false },
      });
      expect(copy).toContain('Pro pass');
      expect(copy).not.toMatch(/\d of \d/);
      expect(copy).not.toContain('stay allocated');
      expect(copy).not.toContain('never taken back');
      expect(copy).not.toMatch(/\bYour\b/);
      if (execution.kind === 'reconcile_required')
        expect(copy).toContain('CONFIRM ONLINE');
      if (execution.kind === 'expired') expect(copy).toContain('EXPIRED');
      expectDossierCompliant(copy);
    }
  });

  it('never announces a ticket stranded in an expired generation as an offline analysis ready when the ledger refuses to spend it', async () => {
    // Generation 1 (two tickets) lapsed; generation 2 restates only the
    // second ticket. The first stays allocated to this phone under the
    // expired generation — never reclaimed, never executable.
    await holdGrant(FREE_GRANT);
    await holdGrant(SECOND_GENERATION_GRANT);
    mockReading = AT_SECOND_GENERATION_ISSUE;
    await spend('op-1', AT_SECOND_GENERATION_ISSUE);

    const allocation = await readOfflineAllocation(
      db,
      AT_SECOND_GENERATION_ISSUE,
    );
    expect(allocation.spendableTickets).toBe(1);
    expect(allocation.consumedTickets).toBe(1);
    const byGeneration = new Map(
      allocation.grants.map(grant => [grant.generation, grant]),
    );
    expect(byGeneration.get(2)?.execution.kind).toBe('active');
    expect(byGeneration.get(2)?.remaining).toBe(0);
    expect(byGeneration.get(1)?.execution.kind).toBe('expired');
    expect(byGeneration.get(1)?.remaining).toBe(1);
    // The ledger's own verdict: nothing can be spent on this phone now.
    await expect(
      spend('op-2', AT_SECOND_GENERATION_ISSUE),
    ).rejects.toMatchObject({ code: 'offline.allocation_exhausted' });

    const renderer = await render(<AnalyzeScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('CONFIRM ONLINE');
    expect(badgeOf(renderer)).not.toBe('READY');
    expect(copy).not.toContain('offline analysis ready');
    expect(copy).not.toContain('ready');
    // The stranded ticket is stated as allocated, never as spendable.
    expect(copy).toContain('1 of 2');
    expect(copy).toContain('1 held analysis');
    expect(copy).toContain('stays allocated');
    expect(copy).toContain('online check');
    expect(copy).toContain('1 result waiting');
    expectDossierCompliant(copy);
  });

  it('counts only the tickets the live pass can spend as ready, and names the stranded ones', () => {
    const live: HeldOfflineGrantView = {
      ...proGrant({ kind: 'active', remainingMs: SIX_DAYS_S * 1000 }),
      grantId: SECOND_GENERATION_GRANT_ID,
      generation: 2,
      entitlementSource: 'identity_lifetime_free',
      entitlementExpiresAt: null,
      allocated: 1,
      remaining: 1,
    };
    const lapsed: HeldOfflineGrantView = {
      ...proGrant({ kind: 'expired' }),
      entitlementSource: 'identity_lifetime_free',
      entitlementExpiresAt: null,
      allocated: 2,
      remaining: 1,
    };
    const copy = copyOf({
      kind: 'read',
      allocation: {
        grants: [live, lapsed],
        spendableTickets: 2,
        consumedTickets: 0,
        pendingReceipts: 0,
      },
      wallet: { pending: [], unansweredPresentations: 0, hold: false },
    });
    expect(copy).toContain('READY');
    expect(copy).toContain('1 offline analysis ready');
    expect(copy).not.toContain('2 offline analyses ready');
    expect(copy).toContain('2 of 2');
    expect(copy).toContain('1 held analysis');
    expect(copy).toContain('stays allocated');
    expectDossierCompliant(copy);
  });

  it('describes a receipt the server refused with HTTP 429 as a HOLD without asserting a dropped connection', async () => {
    await holdGrant();
    await spend('op-1');
    await presentAndBeRefused(429);
    const truth = await ledgerTruth();
    expect(truth.wallet.hold).toBe(true);
    expect(truth.wallet.pending.map(receipt => receipt.phase)).toEqual([
      'presented_unanswered',
    ]);
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(copy).toContain('1 result awaiting confirmation');
    expect(copy).toContain('1 on hold');
    expect(copy).toContain('nothing is charged twice');
    expect(copy).not.toContain('connection dropped');
    expect(copy).not.toContain('connection');
    // The HOLD never refunds: the spent ticket stays spent on screen.
    expect(copy).toContain('1 of 2');
    expectDossierCompliant(copy);
  });
});

describe('W05-04 round 5 — a Pro lease that is not live lends nothing to the copy, and HOLD copy states only what the ledger holds', () => {
  function copyOf(state: OfflineJourneyState): string {
    const presented = presentOfflineJourney(state);
    return [
      presented.badge,
      presented.title,
      ...presented.rows.flatMap(row => [row.label, row.value]),
      ...presented.notes,
    ].join(' | ');
  }

  async function insertInFlightJournal(receiptIds: readonly string[]) {
    await db.execute(
      `INSERT INTO offline_wallet_journal
         (owner_key, journal_id, kind, receipt_ids, state, opened_at, closed_at, verdicts)
       VALUES (?, ?, 'receipt_submission', ?, 'in_flight', ?, NULL, NULL)`,
      [
        OWNER,
        'dddddddd-0000-4000-8000-000000000005',
        JSON.stringify(receiptIds),
        new Date(ISSUED_AT * 1000).toISOString(),
      ],
    );
  }

  it('a lapsed Pro lease does not hide the expired free allocation this phone still holds', async () => {
    await holdGrant(LAPSED_PRO_GRANT);
    await holdGrant(FREE_GRANT);
    mockReading = AFTER_EXPIRY;
    const allocation = await readOfflineAllocation(db, AFTER_EXPIRY);
    expect(allocation.spendableTickets).toBe(2);
    expect(allocation.grants.map(grant => grant.execution.kind)).toEqual([
      'expired',
      'expired',
    ]);
    // Control: the identical wallet without the lapsed Pro row.
    const control = copyOf({
      kind: 'read',
      allocation: {
        ...allocation,
        grants: allocation.grants.filter(
          grant => grant.entitlementSource === 'identity_lifetime_free',
        ),
      },
      wallet: { pending: [], unansweredPresentations: 0, hold: false },
    });
    expect(control).toContain('2 of 2 unspent');
    expect(control).toContain('stay allocated');

    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('EXPIRED');
    expect(copy).toContain('Offline pass expired');
    // The lapsed Pro row deletes none of the allocation facts and never
    // relabels the wallet as a Pro pass.
    expect(copy).toContain('2 of 2 unspent');
    expect(copy).toContain('2 held analyses');
    expect(copy).toContain('stay allocated');
    expect(copy).toContain('never taken back');
    expect(copy).not.toContain('Pro pass');
    expect(copy).not.toContain('Pro');
    expectDossierCompliant(copy);
  });

  it('a Pro lease issued after the free allocation, under no trusted time, does not hide the held free tickets', async () => {
    await holdGrant(FREE_GRANT);
    await holdGrant(LATER_PRO_GRANT);
    mockReading = NO_TRUSTED_TIME;
    const allocation = await readOfflineAllocation(db, NO_TRUSTED_TIME);
    expect(allocation.spendableTickets).toBe(2);
    // The ledger lists the Pro lease first (same generation, issued later).
    expect(
      allocation.grants.map(grant => [
        grant.entitlementSource,
        grant.execution.kind,
      ]),
    ).toEqual([
      ['verified_store', 'reconcile_required'],
      ['identity_lifetime_free', 'reconcile_required'],
    ]);

    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('CONFIRM ONLINE');
    expect(copy).toContain('has not confirmed the time');
    expect(copy).toContain('2 of 2 unspent');
    expect(copy).toContain('2 held analyses');
    expect(copy).toContain('stay allocated');
    expect(copy).toContain('Unconfirmed');
    expect(copy).not.toContain('Pro pass');
    expectDossierCompliant(copy);
  });

  it('a live Pro lease beside a live free allocation is stated as a Pro pass AND states the free tickets still held', async () => {
    await holdGrant(FREE_GRANT);
    await holdGrant(LATER_PRO_GRANT);
    mockReading = anchored((ISSUED_AT + 2 * DAY_S) * 1000);
    const allocation = await readOfflineAllocation(db, mockReading);
    expect(allocation.spendableTickets).toBe(2);
    expect(allocation.grants.map(grant => grant.execution.kind)).toEqual([
      'active',
      'active',
    ]);
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('Pro offline pass active');
    expect(copy).toContain('Pro pass');
    expect(copy).toContain('In 5 days');
    // The free tickets are a fact of this phone's wallet: counted, but no
    // sentence claims the Pro pass's results "stay allocated".
    expect(copy).toContain('2 of 2 unspent');
    expect(copy).not.toContain('stay allocated');
    expect(copy).not.toContain('never taken back');
    expectDossierCompliant(copy);
  });

  it('presenter: a Pro lease that is not live never relabels held free tickets as a Pro pass, whatever its verdict or position', () => {
    const notLive: TrustedTimeLeaseVerdict[] = [
      { kind: 'expired' },
      { kind: 'reconcile_required', reason: 'no_trusted_time' },
      { kind: 'reconcile_required', reason: 'floor_only' },
      { kind: 'reconcile_required', reason: 'clock_rollback' },
      { kind: 'reconcile_required', reason: 'storage_invalid' },
      { kind: 'reconcile_required', reason: 'elapsed_unmeasured' },
      { kind: 'reconcile_required', reason: 'invalid_lease' },
      { kind: 'reconcile_required', reason: 'lease_ahead_of_clock' },
      { kind: 'active', remainingMs: 0 },
      { kind: 'active', remainingMs: Number.NaN },
    ];
    const free = (
      execution: TrustedTimeLeaseVerdict,
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
      remaining: 2,
      consumed: 0,
      lifecycleSequence: 0,
      execution,
    });
    const pro = (execution: TrustedTimeLeaseVerdict): HeldOfflineGrantView => ({
      ...free(execution),
      grantId: LATER_PRO_GRANT_ID,
      entitlementSource: 'verified_store',
      entitlementExpiresAt: EXPIRES_AT,
      allocated: 0,
      remaining: 0,
    });
    for (const proVerdict of notLive) {
      for (const freeVerdict of notLive) {
        for (const grants of [
          [pro(proVerdict), free(freeVerdict)],
          [free(freeVerdict), pro(proVerdict)],
        ]) {
          const copy = copyOf({
            kind: 'read',
            allocation: {
              grants,
              spendableTickets: 2,
              consumedTickets: 0,
              pendingReceipts: 0,
            },
            wallet: { pending: [], unansweredPresentations: 0, hold: false },
          });
          expect(copy).toContain('2 of 2 unspent');
          expect(copy).toContain('2 held analyses');
          expect(copy).toContain('stay allocated');
          expect(copy).not.toContain('Pro');
          expect(copy).not.toContain('READY');
          expectDossierCompliant(copy);
        }
      }
    }
  });

  it('an in-flight journal entry naming a receipt that IS on file (already accepted) is not described as a receipt that was never recorded', async () => {
    await holdGrant();
    await spend('op-1');
    const outcome = await presentAndReceive('result_recorded');
    expect(outcome.accepted).toBe(1);
    const accepted = await db.execute(
      `SELECT receipt_id, settlement FROM offline_receipt WHERE owner_key = ?`,
      [OWNER],
    );
    const receiptId = String(accepted.rows[0]?.['receipt_id']);
    expect(accepted.rows[0]?.['settlement']).toBe('accepted');
    // Corruption written straight to storage: an unanswered presentation
    // that names the settled receipt.
    await insertInFlightJournal([receiptId]);
    const truth = await ledgerTruth();
    expect(truth.wallet.hold).toBe(true);
    expect(truth.wallet.pending).toHaveLength(0);

    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(copy).toContain('An offline result needs an online check');
    expect(copy).toContain('Unreadable');
    // The receipt is recorded on this phone and settled. The card states
    // only what it can read: no pending receipt carries that id.
    expect(copy).toContain('names no receipt that is still waiting');
    expect(copy).not.toContain('never recorded');
    expect(copy).not.toContain('0 result');
    expect(copy).not.toMatch(/\bNothing\b/);
    expectDossierCompliant(copy);
  });

  it('a HOLD whose grant rows are gone (receipts only) keeps count and noun in agreement for two pending receipts', async () => {
    await holdGrant();
    await spend('op-1');
    await spend('op-2');
    await presentAndLoseConnection();
    // Partial state: the grant and ticket rows are gone, the receipts and
    // the in-flight journal survive.
    await db.execute(`DELETE FROM offline_ticket WHERE owner_key = ?`, [OWNER]);
    await db.execute(`DELETE FROM offline_grant WHERE owner_key = ?`, [OWNER]);
    const truth = await ledgerTruth();
    expect(truth.allocation.grants).toHaveLength(0);
    expect(truth.wallet.hold).toBe(true);
    expect(truth.wallet.pending).toHaveLength(2);

    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(copy).toContain('2 results awaiting confirmation');
    expect(copy).toContain('2 on hold');
    expect(copy).toContain('The spent analyses stay recorded');
    expect(copy).toContain('confirms them');
    expect(copy).not.toContain('The spent analysis ');
    expect(copy).not.toContain('confirms it');
    expectDossierCompliant(copy);
  });

  it('presenter: a HOLD with no grant rows names one spent analysis for one receipt and none for a journal entry naming no pending receipt', () => {
    const receipt = (index: number) => ({
      receiptId: `receipt-${index}`,
      operationId: `op-${index}`,
      settlement: null,
      presentations: 1,
      phase: 'presented_unanswered' as const,
    });
    const empty = {
      grants: [],
      spendableTickets: 0,
      consumedTickets: 0,
      pendingReceipts: 0,
    };
    const one = copyOf({
      kind: 'read',
      allocation: { ...empty, pendingReceipts: 1 },
      wallet: { pending: [receipt(1)], unansweredPresentations: 1, hold: true },
    });
    expect(one).toContain('1 result awaiting confirmation');
    expect(one).toContain('The spent analysis stays recorded');
    expect(one).toContain('confirms it');
    expect(one).not.toContain('analyses');
    // No pending receipt at all: nothing was spent that the card can name,
    // so no sentence speaks of "the spent analysis".
    const none = copyOf({
      kind: 'read',
      allocation: empty,
      wallet: { pending: [], unansweredPresentations: 1, hold: true },
    });
    expect(none).toContain('ON HOLD');
    expect(none).toContain('names no receipt that is still waiting');
    expect(none).not.toContain('spent analysis');
    expect(none).not.toContain('spent analyses');
    expectDossierCompliant(one);
    expectDossierCompliant(none);
  });
});
