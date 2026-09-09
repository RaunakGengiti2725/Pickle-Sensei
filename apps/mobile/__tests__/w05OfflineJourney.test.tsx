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
 * needs an online check must stop saying so once the server anchors trusted
 * time while it stays on screen (and a READY card must stop saying READY
 * once a clock rollback is detected) — the surface follows the trusted
 * clock, not only the receipt queue; one transient storage failure on a
 * quiet read must not end the following for the rest of the visit; a Pro
 * lease never claims results that "stay allocated"; a ticket stranded in an
 * expired generation is never announced as ready; and a HOLD the server
 * refused is not described as a dropped connection.
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
  PENDING_RECEIPT_READ_CADENCE_MS,
  TRUSTED_TIME_WATCH_MS,
  UNAVAILABLE_RETRY_MS,
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
const RESULT_SHA = 'c'.repeat(64);
const BINDING = { installationKeyId: INSTALLATION_KEY, issuer: ISSUER };
const CARD_TEST_ID = 'offline-allocation-card';
const LEDGER_READ = /FROM offline_(grant|ticket|receipt|wallet_journal)\b/;

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
  /** Free allocation restated by a later generation (default: 1, all). */
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

/** Anchored exactly at issue: six whole days of lease remain. */
const AT_ISSUE = anchored(ISSUED_AT * 1000);
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
/** A relaunch before any authenticated response: only the persisted floor,
 * which can prove an expiry but never that a pass is still live. */
const FLOOR_ONLY: TrustedTimeReading = {
  authority: 'floor',
  continuity: 'persisted',
  nowMs: ISSUED_AT * 1000,
  wallClockMs: ISSUED_AT * 1000,
  rollbackDetected: false,
  storage: 'loaded',
};
/** The wall clock moved backwards since the last confirmed time. */
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

/** The statements the card issued against the ledger since the last reset. */
function ledgerReads() {
  return handle.calls.filter(call => LEDGER_READ.test(call.sql));
}

/** Every test in the enclosing describe observes AppState transitions and
 * may run on fake timers; both are torn down after each test. */
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

describe('W05-04 the card keeps following the ledger while it stays on screen', () => {
  observeAppStateAndTimers();

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

describe('W05-04 round 4 — the card follows the trusted clock while it stays on screen', () => {
  observeAppStateAndTimers();

  it('Analyze stops asking for an online check once the server anchors trusted time (floor-only relaunch)', async () => {
    jest.useFakeTimers();
    await holdGrant();
    mockReading = FLOOR_ONLY;
    const renderer = await render(<AnalyzeScreen />);
    await settleFake();
    expect(badgeOf(renderer)).toBe('CONFIRM ONLINE');
    expect(textOf(card(renderer))).toContain('could not be measured');

    // The sync runtime's next authenticated response anchors the clock; the
    // card is told nothing and no navigation or foreground event follows.
    mockReading = AT_ISSUE;
    expect(
      (await readOfflineAllocation(db, AT_ISSUE)).grants[0]?.execution.kind,
    ).toBe('active');
    await advance(TRUSTED_TIME_WATCH_MS);
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('2 offline analyses ready');
    expect(copy).toContain('In 6 days');
    expect(copy).not.toContain('needs an online check');
    expect(copy).not.toContain('Unconfirmed');
    expectDossierCompliant(copy);
  });

  it('Settings stops asking for an online check once the phone has trusted time at all', async () => {
    jest.useFakeTimers();
    await holdGrant();
    mockReading = NO_TRUSTED_TIME;
    const renderer = await render(<SettingsScreen />);
    await settleFake();
    expect(badgeOf(renderer)).toBe('CONFIRM ONLINE');
    expect(textOf(card(renderer))).toContain('has not confirmed the time');

    mockReading = AT_ISSUE;
    await advance(TRUSTED_TIME_WATCH_MS);
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('In 6 days');
    expect(copy).not.toContain('has not confirmed the time');
    expect(copy).not.toContain('Unconfirmed');
    expectDossierCompliant(copy);
  });

  it('Analyze stops calling a pass READY once a clock rollback is detected while it stays on screen', async () => {
    jest.useFakeTimers();
    await holdGrant();
    const renderer = await render(<AnalyzeScreen />);
    await settleFake();
    expect(badgeOf(renderer)).toBe('READY');

    mockReading = ROLLED_BACK;
    const truth = await readOfflineAllocation(db, ROLLED_BACK);
    expect(truth.grants[0]?.execution).toEqual({
      kind: 'reconcile_required',
      reason: 'clock_rollback',
    });
    await expect(
      consumeOfflineAllocation(db, consumption('op-rollback'), ROLLED_BACK),
    ).rejects.toMatchObject({ code: 'offline.time_reconcile_required' });
    await advance(TRUSTED_TIME_WATCH_MS);
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('CONFIRM ONLINE');
    expect(copy).toContain('moved backwards');
    expect(copy).toContain('Unconfirmed');
    expect(copy).not.toContain('READY');
    expect(copy).not.toContain('ready');
    expect(copy).not.toContain('In 6 days');
    // The unspent allocation is still held: nothing was reclaimed.
    expect(copy).toContain('2 of 2');
    expectDossierCompliant(copy);
  });

  it('Settings moves the pass end on as trusted time passes, with no foreground event', async () => {
    jest.useFakeTimers();
    await holdGrant();
    const renderer = await render(<SettingsScreen />);
    await settleFake();
    expect(textOf(card(renderer))).toContain('In 6 days');

    mockReading = anchored(ISSUED_AT * 1000 + DAY_S * 1000 + 1);
    await advance(TRUSTED_TIME_WATCH_MS);
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('In 4 days');
    expect(copy).not.toContain('In 6 days');
  });

  it('the watch reads the trusted clock, not the ledger: a READY pass with nothing waiting issues no SQL until a verdict moves', async () => {
    jest.useFakeTimers();
    await holdGrant();
    const renderer = await render(<AnalyzeScreen />);
    await settleFake();
    expect(badgeOf(renderer)).toBe('READY');

    handle.calls.length = 0;
    await advance(12 * TRUSTED_TIME_WATCH_MS);
    expect(ledgerReads()).toEqual([]);
    expect(badgeOf(renderer)).toBe('READY');

    mockReading = AFTER_EXPIRY;
    await advance(TRUSTED_TIME_WATCH_MS);
    expect(ledgerReads().length).toBeGreaterThan(0);
    expect(badgeOf(renderer)).toBe('EXPIRED');
    expect(handle.calls.filter(call => WRITE_STATEMENT.test(call.sql))).toEqual(
      [],
    );
  });

  it('reads nothing on a cadence while no pass is held and nothing is waiting', async () => {
    jest.useFakeTimers();
    const renderer = await render(<SettingsScreen />);
    await settleFake();
    expect(badgeOf(renderer)).toBe('NONE HELD');

    handle.calls.length = 0;
    await advance(60_000);
    expect(ledgerReads()).toEqual([]);
  });

  it('no follow-up read outlives the last surface', async () => {
    jest.useFakeTimers();
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const renderer = await render(<AnalyzeScreen />);
    await settleFake();
    expect(badgeOf(renderer)).toBe('ON HOLD');

    await act(async () => renderer.unmount());
    mounted = null;
    handle.calls.length = 0;
    await advance(60_000);
    expect(ledgerReads()).toEqual([]);
  });
});

describe('W05-04 round 4 — one transient read failure does not end the following', () => {
  observeAppStateAndTimers();

  const BUSY = new Error('SQLITE_BUSY: database is locked');

  it('Analyze recovers from a failed quiet read and still shows the HOLD resolving', async () => {
    jest.useFakeTimers();
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const renderer = await render(<AnalyzeScreen />);
    await settleFake();
    expect(badgeOf(renderer)).toBe('ON HOLD');

    handle.failStatementOnce('FROM offline_grant', BUSY);
    await advance(PENDING_RECEIPT_READ_CADENCE_MS);
    // For the moment the truth is "could not be read": stated honestly.
    expect(badgeOf(renderer)).toBe('UNAVAILABLE');

    const outcome = await presentAndReceive('result_recorded');
    expect(outcome.accepted).toBe(1);
    expect((await ledgerTruth()).wallet.hold).toBe(false);
    handle.calls.length = 0;
    await advance(UNAVAILABLE_RETRY_MS);
    expect(ledgerReads().length).toBeGreaterThan(0);
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('1 of 2');
    expect(copy).toContain('Nothing');
    expect(copy).not.toContain('could not be read');
    expect(handle.calls.filter(call => WRITE_STATEMENT.test(call.sql))).toEqual(
      [],
    );
    expectDossierCompliant(copy);
  });

  it('Settings brings a HOLD that is still in the ledger back on screen after a failed quiet read', async () => {
    jest.useFakeTimers();
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const renderer = await render(<SettingsScreen />);
    await settleFake();
    expect(badgeOf(renderer)).toBe('ON HOLD');

    handle.failStatementOnce('FROM offline_grant', BUSY);
    await advance(PENDING_RECEIPT_READ_CADENCE_MS);
    expect(badgeOf(renderer)).toBe('UNAVAILABLE');

    await advance(UNAVAILABLE_RETRY_MS);
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(copy).toContain('1 result awaiting confirmation');
    expect(copy).toContain('nothing is charged twice');
    expect(copy).not.toContain('could not be read');
  });

  it('retries an unreadable ledger on a bounded backoff, never a hot loop, and recovers once it reads again', async () => {
    jest.useFakeTimers();
    await holdGrant();
    const inner = db;
    let attempts = 0;
    let unreadable = true;
    mockDb = () => ({
      execute: (sql, params) => inner.execute(sql, params),
      transaction: async <T,>(
        operation: (transaction: LocalDb) => Promise<T>,
      ): Promise<T> => {
        if (unreadable) {
          attempts += 1;
          throw BUSY;
        }
        const innerTransaction = inner.transaction;
        if (!innerTransaction) throw new Error('test db has no transaction');
        return innerTransaction.call(inner, operation) as Promise<T>;
      },
      close: () => inner.close(),
    });
    const renderer = await render(<SettingsScreen />);
    await settleFake();
    expect(badgeOf(renderer)).toBe('UNAVAILABLE');
    expect(attempts).toBe(1);

    await advance(5 * 60_000);
    // Kept trying (the state is not parked), but backed off.
    expect(attempts).toBeGreaterThanOrEqual(4);
    expect(attempts).toBeLessThanOrEqual(10);
    expect(badgeOf(renderer)).toBe('UNAVAILABLE');

    unreadable = false;
    await advance(60_000);
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('2 offline analyses ready');
    expect(copy).not.toContain('could not be read');
  });
});

describe('W05-04 round 4 — copy states only what the ledger holds', () => {
  const ALLOCATION_ID = 'bbbbbbbb-0000-4000-8000-00000000000a';
  /** Generation 1 of a free allocation, whose lease ended a week ago with
   * one ticket unspent. */
  const EARLIER_GENERATION: GrantShape = {
    entitlementSource: 'identity_lifetime_free',
    grantId: 'bbbbbbbb-0000-4000-8000-000000000003',
    issuedAt: ISSUED_AT - 14 * DAY_S,
    expiresAt: ISSUED_AT - 7 * DAY_S,
    entitlementExpiresAt: null,
    generation: 1,
    allocationId: ALLOCATION_ID,
  };
  /** Generation 2 restates only the second ticket under a live lease; the
   * first stays allocated in the ended generation (never reclaimed). */
  const RESTATED_GENERATION: GrantShape = {
    ...FREE_GRANT,
    grantId: 'bbbbbbbb-0000-4000-8000-000000000004',
    generation: 2,
    allocationId: ALLOCATION_ID,
    ticketIds: [TICKETS[1]],
  };

  function grantView(
    overrides: Partial<HeldOfflineGrantView>,
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
      execution: { kind: 'active', remainingMs: SIX_DAYS_S * 1000 },
      ...overrides,
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

  it('an expired Pro lease with nothing pending makes no allocation claim on Settings', async () => {
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
    expect(copy).not.toContain('stay allocated');
    expect(copy).not.toContain('never taken back');
    expect(copy).not.toContain('results');
    expectDossierCompliant(copy);
  });

  it('an unconfirmed Pro lease with nothing pending makes no allocation claim on Analyze', async () => {
    await holdGrant(PRO_GRANT);
    mockReading = NO_TRUSTED_TIME;
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('CONFIRM ONLINE');
    expect(copy).toContain('has not confirmed the time');
    expect(copy).not.toContain('stay allocated');
    expect(copy).not.toContain('never taken back');
    expect(copy).not.toContain('results');
    expectDossierCompliant(copy);
  });

  it('presenter: a Pro lease never claims results that stay allocated, under any verdict', () => {
    const verdicts: TrustedTimeLeaseVerdict[] = [
      { kind: 'active', remainingMs: SIX_DAYS_S * 1000 },
      { kind: 'expired' },
      { kind: 'reconcile_required', reason: 'no_trusted_time' },
      { kind: 'reconcile_required', reason: 'floor_only' },
      { kind: 'reconcile_required', reason: 'clock_rollback' },
    ];
    for (const execution of verdicts) {
      const copy = copyOf({
        kind: 'read',
        allocation: {
          grants: [
            grantView({
              entitlementSource: 'verified_store',
              entitlementExpiresAt: EXPIRES_AT,
              allocated: 0,
              remaining: 0,
              execution,
            }),
          ],
          spendableTickets: 0,
          consumedTickets: 0,
          pendingReceipts: 0,
        },
        wallet: quietWallet,
      });
      expect(copy).not.toContain('stay allocated');
      expect(copy).not.toContain('never taken back');
      expect(copy).not.toMatch(/\d of \d/);
      expectDossierCompliant(copy);
    }
  });

  it('a receipt the server refused (HTTP 429) is a HOLD, but not a dropped connection', async () => {
    await holdGrant();
    await spend('op-1');
    fetchSpy?.mockRestore();
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: 'rate_limited' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '30' },
        }),
    );
    await expect(
      reconcileOfflineWallet(db, grantClient(), AT_ISSUE),
    ).rejects.toMatchObject({ status: 429 });
    const truth = await ledgerTruth();
    expect(truth.wallet.hold).toBe(true);
    expect(truth.wallet.pending.map(receipt => receipt.phase)).toEqual([
      'presented_unanswered',
    ]);
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(copy).toContain('1 result awaiting confirmation');
    expect(copy).toContain('nothing is charged twice');
    expect(copy).toContain('same receipt is presented again');
    expect(copy).not.toContain('connection dropped');
    expect(copy).not.toContain('never arrived');
    expect(copy).not.toMatch(/connection/i);
    expectDossierCompliant(copy);
  });

  it('never calls a ticket stranded in an expired generation ready on Analyze', async () => {
    await holdGrant(EARLIER_GENERATION);
    await holdGrant(RESTATED_GENERATION);
    await spend('op-1');
    const truth = await ledgerTruth();
    expect(truth.allocation.spendableTickets).toBe(1);
    expect(
      truth.allocation.grants.map(grant => [
        grant.generation,
        grant.execution.kind,
        grant.remaining,
      ]),
    ).toEqual([
      [2, 'active', 0],
      [1, 'expired', 1],
    ]);
    await expect(spend('op-2')).rejects.toMatchObject({
      code: 'offline.allocation_exhausted',
    });
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).not.toBe('READY');
    expect(copy).not.toContain('ready');
    expect(copy).not.toContain('READY');
    // Allocation is not consumption: the stranded ticket is still held.
    expect(copy).toContain('1 of 2');
    expect(copy).toContain('stays allocated');
    expect(copy).toContain('earlier pass');
    expect(copy).not.toContain('fully spent');
    expectDossierCompliant(copy);
  });

  it('presenter: READY counts only the analyses the ledger would execute now', () => {
    const copy = copyOf({
      kind: 'read',
      allocation: {
        grants: [
          grantView({
            grantId: RESTATED_GENERATION.grantId,
            generation: 2,
            allocated: 1,
            remaining: 1,
            consumed: 0,
          }),
          grantView({
            grantId: EARLIER_GENERATION.grantId,
            generation: 1,
            issuedAt: EARLIER_GENERATION.issuedAt,
            expiresAt: EARLIER_GENERATION.expiresAt,
            allocated: 2,
            remaining: 1,
            consumed: 0,
            execution: { kind: 'expired' },
          }),
        ],
        spendableTickets: 2,
        consumedTickets: 0,
        pendingReceipts: 0,
      },
      wallet: quietWallet,
    });
    expect(copy).toContain('READY');
    expect(copy).toContain('1 offline analysis ready');
    expect(copy).not.toContain('2 offline analyses ready');
    expect(copy).toContain('2 of 2 unspent');
    expect(copy).toContain('In 6 days');
    expect(copy).toContain('1 unspent analysis belongs to an earlier pass');
    expectDossierCompliant(copy);
  });

  it('presenter: a lone stranded ticket under a live but empty generation is not READY and not fully spent', () => {
    const copy = copyOf({
      kind: 'read',
      allocation: {
        grants: [
          grantView({
            grantId: RESTATED_GENERATION.grantId,
            generation: 2,
            allocated: 1,
            remaining: 0,
            consumed: 1,
          }),
          grantView({
            grantId: EARLIER_GENERATION.grantId,
            generation: 1,
            issuedAt: EARLIER_GENERATION.issuedAt,
            expiresAt: EARLIER_GENERATION.expiresAt,
            allocated: 2,
            remaining: 1,
            consumed: 0,
            execution: { kind: 'expired' },
          }),
        ],
        spendableTickets: 1,
        consumedTickets: 1,
        pendingReceipts: 1,
      },
      wallet: {
        pending: [
          {
            receiptId: 'receipt-1',
            operationId: 'op-1',
            settlement: null,
            presentations: 0,
            phase: 'queued',
          },
        ],
        unansweredPresentations: 0,
        hold: false,
      },
    });
    expect(copy).not.toContain('READY');
    expect(copy).not.toContain('ready');
    expect(copy).not.toContain('fully spent');
    expect(copy).toContain('1 of 2 unspent');
    expect(copy).toContain('1 result waiting');
    expect(copy).toContain('earlier pass');
    expect(copy).not.toMatch(/\b0 (held|unspent|offline) analys/);
    expectDossierCompliant(copy);
  });
});
