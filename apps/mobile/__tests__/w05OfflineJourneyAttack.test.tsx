/**
 * W05-04 adversarial suite — attacks against candidate d8fef4b5.
 *
 * Every test here drives the SHIPPING Analyze / Settings screens (or the
 * exported presenter) through the same ledger paths the app uses
 * (`holdOfflineGrant`, `consumeOfflineAllocation`, `reconcileOfflineWallet`)
 * and states what the card MUST say for the state the ledger is in. A failing
 * test is a confirmed break; a passing test is an attack that did not land.
 *
 * Attack index (mirrors the report):
 *  A1  foreground race: AppState 'active' starts BOTH the card read and the
 *      sync drain; the drain resolves the HOLD after the card already read.
 *  A2  Settings never re-reads on foreground (no AppState hook at all).
 *  A3  lease lapses while the ready screen stays in the foreground.
 *  A4  owner switch while a read is stalled on trusted time (cross-account).
 *  A5  corrupt journal / ticket rows must read as UNAVAILABLE, never empty.
 *  A6  zero-count copy on an expired / unconfirmed, fully spent pass.
 *  A7  the real navigation 'focus' event path (never exercised upstream).
 *  A8  read-only guarantee across mount, focus, foreground and owner switch.
 *  A9  a Pro lease that needs an online check beside a live free allocation.
 *  A10 far-future and far-past trusted clocks on the shipping screen.
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

type FocusListener = () => void;
const focusListeners = new Set<FocusListener>();
let mockFocused = true;
const mockNavigation = {
  replace: jest.fn(),
  goBack: jest.fn(),
  navigate: jest.fn(),
  popToTop: jest.fn(),
  isFocused: () => mockFocused,
  addListener: (event: string, listener: FocusListener) => {
    if (event !== 'focus') return () => undefined;
    focusListeners.add(listener);
    return () => {
      focusListeners.delete(listener);
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
let mockReadingGate: Promise<void> | null = null;
jest.mock('../src/data/trustedTime', () => {
  const actual = jest.requireActual<typeof import('../src/data/trustedTime')>(
    '../src/data/trustedTime',
  );
  return {
    ...actual,
    trustedTime: {
      ...actual.trustedTime,
      read: async () => {
        if (mockReadingGate) {
          const waiting = mockReadingGate;
          mockReadingGate = null;
          await waiting;
        }
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
const PRO_GRANT_ID = 'bbbbbbbb-0000-4000-8000-000000000003';
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

/** A Pro lease dated one day AFTER the free grant: on a reading anchored at
 * the free grant's issue it is ahead of the confirmed clock. */
const PRO_GRANT_AHEAD_OF_CLOCK: GrantShape = {
  entitlementSource: 'verified_store',
  grantId: PRO_GRANT_ID,
  issuedAt: ISSUED_AT + DAY_S,
  expiresAt: ISSUED_AT + DAY_S + SIX_DAYS_S,
  entitlementExpiresAt: ISSUED_AT + DAY_S + SIX_DAYS_S + DAY_S,
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
const HALF_HOUR_BEFORE_EXPIRY = anchored(EXPIRES_AT * 1000 - 30 * 60 * 1000);
const AFTER_EXPIRY = anchored(EXPIRES_AT * 1000 + 1000);
const YEAR_3000 = anchored(Date.UTC(3000, 0, 1));
const EPOCH = anchored(0);

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

type ChangeListener = (state: AppStateStatus) => void;
const appStateListeners = new Set<ChangeListener>();
const originalAppState = AppState.currentState;

/** The OS foreground transition as the shipping hooks see it. */
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

async function presentAndLoseConnection() {
  fetchSpy?.mockRestore();
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new TypeError('Network request failed');
  });
  await expect(
    reconcileOfflineWallet(db, grantClient(), AT_ISSUE),
  ).rejects.toThrow('Network request failed');
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

async function ledgerTruth() {
  return {
    allocation: await readOfflineAllocation(db, mockReading ?? AT_ISSUE),
    wallet: await readOfflineWalletStatus(db),
    pending: await pendingOfflineReceipts(db),
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
  mockReadingGate = null;
  mockFocused = true;
  focusListeners.clear();
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
  mockReadingGate = null;
  AppState.currentState = originalAppState;
  jest.restoreAllMocks();
  closeSqliteTestDatabases();
});

describe('A1 — foreground race between the card read and the sync drain', () => {
  it('Analyze states a HOLD the drain already resolved in the same foreground transition', async () => {
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    expect(badgeOf(renderer)).toBe('ON HOLD');

    // The phone comes back to the foreground. `syncRuntime` drains on this
    // exact AppState event, and the candidate hook re-reads on it too. The
    // server answers after the card has already read the ledger.
    background();
    const answer = answerReceiptsWhenReleased('result_recorded');
    let drained: Promise<unknown> | null = null;
    await act(async () => {
      foreground();
      drained = drain();
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
    // The ready surface must state the ledger as it is NOW.
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).not.toContain('on hold');
    expect(copy).not.toContain('awaiting confirmation');
    expect(copy).toContain('Nothing');
  });

  it('Analyze states a HOLD the backed-off drain resolved while the ready screen stayed open', async () => {
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    expect(badgeOf(renderer)).toBe('ON HOLD');

    // No navigation, no foreground transition: the drain's backoff timer
    // fires while the player looks at the ready screen and the server
    // records the result.
    const answer = answerReceiptsWhenReleased('result_recorded');
    answer.release();
    await act(async () => {
      const outcome = await drain();
      expect(outcome.accepted).toBe(1);
    });
    await settle();

    expect((await ledgerTruth()).wallet.hold).toBe(false);
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).not.toContain('on hold');
  });
});

describe('A2 — Settings has no foreground read', () => {
  it('Settings states a HOLD the drain resolved across a background/foreground cycle', async () => {
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
      const outcome = await drain();
      expect(outcome.accepted).toBe(1);
    });
    await act(async () => {
      foreground();
    });
    await settle();

    expect((await ledgerTruth()).wallet.hold).toBe(false);
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).not.toContain('on hold');
    expect(copy).toContain('Nothing');
  });
});

describe('A3 — the lease lapses while the ready screen stays in the foreground', () => {
  it('Analyze stops calling a pass READY once trusted time has passed its end', async () => {
    mockReading = HALF_HOUR_BEFORE_EXPIRY;
    await holdGrant();
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    expect(badgeOf(renderer)).toBe('READY');
    expect(textOf(card(renderer))).toContain('In under an hour');

    // Trusted time moves past the lease end. The phone never left the
    // foreground and the player never left the screen.
    mockReading = AFTER_EXPIRY;
    expect((await ledgerTruth()).allocation.grants[0]?.execution.kind).toBe(
      'expired',
    );
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).not.toBe('READY');
    expect(copy).not.toContain('In under an hour');
  });

  it('a foreground transition after the lapse does refresh the lease (control)', async () => {
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
    expect(textOf(card(renderer))).toContain('Expired');
  });
});

describe('A4 — owner switch while a read is stalled on trusted time', () => {
  // Settings hosts the card across an in-place owner switch (Analyze leaves
  // its ready state when its bound account changes, so no card is on screen).
  it('never publishes the first account’s read under the second account, in either completion order', async () => {
    await holdGrant();
    await spend('op-1');
    // Read #1 for OWNER stalls inside trustedTime.read().
    let releaseReading: () => void = () => undefined;
    mockReadingGate = new Promise<void>(resolve => {
      releaseReading = resolve;
    });
    const renderer = await render(<SettingsScreen />);
    await settle();
    expect(badgeOf(renderer)).toBe('CHECKING');

    // The other account signs in on this phone before read #1 resumes.
    await act(async () => {
      signInAs(OTHER_OWNER, 'token-2');
    });
    await settle();
    expect(badgeOf(renderer)).toBe('NONE HELD');

    // Read #1 resumes: it must neither leak OWNER's ledger under OTHER_OWNER
    // nor replace OTHER_OWNER's newer read.
    releaseReading();
    await settle();
    expect(badgeOf(renderer)).toBe('NONE HELD');
    const copy = textOf(renderer.root);
    expect(copy).not.toContain('1 of 2');
    expect(copy).not.toContain('2 of 2');
    expect(copy).not.toContain('waiting');
  });

  it('a read stalled across sign-out and sign-in of the SAME account is discarded for the newer one', async () => {
    await holdGrant();
    let releaseReading: () => void = () => undefined;
    mockReadingGate = new Promise<void>(resolve => {
      releaseReading = resolve;
    });
    const renderer = await render(<SettingsScreen />);
    await settle();
    expect(badgeOf(renderer)).toBe('CHECKING');
    await act(async () => {
      signInAs(OTHER_OWNER, 'token-2');
    });
    await settle();
    // The original owner spends a ticket in the meantime and signs back in.
    setActiveDataOwner(OWNER);
    await spend('op-1');
    await act(async () => {
      signInAs(OWNER, 'token-3');
    });
    await settle();
    expect(textOf(card(renderer))).toContain('1 of 2');
    releaseReading();
    await settle();
    const copy = textOf(card(renderer));
    expect(copy).toContain('1 of 2');
    expect(copy).not.toContain('2 of 2');
  });
});

describe('A5 — corrupt persisted state is UNAVAILABLE, never an empty wallet', () => {
  it('a journal row whose state is not a known state reads as UNAVAILABLE on Analyze', async () => {
    await holdGrant();
    await spend('op-1');
    await db.execute(
      `INSERT INTO offline_wallet_journal
         (owner_key, journal_id, kind, receipt_ids, state, opened_at, closed_at, verdicts)
       VALUES (?, ?, 'receipt_submission', ?, 'settled', ?, NULL, NULL)`,
      [
        OWNER,
        'dddddddd-0000-4000-8000-000000000001',
        JSON.stringify(['eeeeeeee-0000-4000-8000-000000000001']),
        new Date(ISSUED_AT * 1000).toISOString(),
      ],
    );
    await expect(readOfflineWalletStatus(db)).rejects.toThrow();
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('UNAVAILABLE');
    expect(copy).not.toContain('NONE HELD');
    expect(copy).not.toMatch(/\b0 of\b/);
    expect(copy).not.toContain('Waiting to sync');
    expectDossierCompliant(copy);
  });

  it('a consumed ticket row that names no receipt reads as UNAVAILABLE on Settings', async () => {
    await holdGrant();
    await spend('op-1');
    await db.execute(
      `UPDATE offline_ticket SET receipt_id = NULL WHERE owner_key = ? AND state = 'consumed'`,
      [OWNER],
    );
    await expect(readOfflineAllocation(db, AT_ISSUE)).rejects.toThrow();
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('UNAVAILABLE');
    expect(copy).not.toContain('of 2');
    expect(copy).not.toContain('ready');
  });

  it('a grant row whose JWS digest no longer matches reads as UNAVAILABLE, not READY', async () => {
    await holdGrant();
    await db.execute(
      `UPDATE offline_grant SET grant_jws_sha256 = ? WHERE owner_key = ?`,
      ['f'.repeat(64), OWNER],
    );
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    expect(badgeOf(renderer)).toBe('UNAVAILABLE');
    expect(textOf(card(renderer))).not.toContain('ready');
  });
});

describe('A6 — zero-count copy on a fully spent pass that is expired or unconfirmed', () => {
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
    // Nothing is held, so nothing "stays allocated"; the candidate's own
    // standard (A6 in its summary) is that a zero count is never announced.
    expect(copy).not.toMatch(/\b0 held analys/);
    expect(copy).not.toMatch(/\bYour 0\b/);
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
    expect(copy).not.toMatch(/\b0 held analys/);
    expect(copy).not.toMatch(/\bYour 0\b/);
  });

  it('presenter: an expired grant with no spendable ticket has no zero-count note', () => {
    const grant: HeldOfflineGrantView = {
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
      execution: { kind: 'expired' },
    };
    const wallet: OfflineWalletStatus = {
      pending: [],
      unansweredPresentations: 0,
      hold: false,
    };
    const state: OfflineJourneyState = {
      kind: 'read',
      allocation: {
        grants: [grant],
        spendableTickets: 0,
        consumedTickets: 2,
        pendingReceipts: 0,
      },
      wallet,
    };
    const presented = presentOfflineJourney(state);
    const copy = [presented.title, ...presented.notes].join(' | ');
    expect(copy).not.toMatch(/\b0 held analys/);
  });
});

describe('A7 — the navigation focus event path', () => {
  it('Analyze re-reads on the screen’s own focus event after a spend and after a HOLD', async () => {
    await holdGrant();
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    expect(textOf(card(renderer))).toContain('2 of 2');
    await spend('op-1');
    await act(async () => {
      emitFocus();
    });
    await settle();
    let copy = textOf(card(renderer));
    expect(copy).toContain('1 of 2');
    expect(copy).toContain('1 result waiting');
    await presentAndLoseConnection();
    await act(async () => {
      emitFocus();
    });
    await settle();
    copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(copy).toContain('1 on hold');
  });

  it('an unfocused Analyze does not publish a read over the focused screen on foreground', async () => {
    await holdGrant();
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    expect(badgeOf(renderer)).toBe('READY');
    mockFocused = false;
    handle.calls.length = 0;
    background();
    await act(async () => {
      foreground();
    });
    await settle();
    expect(handle.calls.filter(call => /FROM offline_/.test(call.sql))).toEqual(
      [],
    );
  });
});

describe('A8 — the journey surfaces never write (free-rating conservation)', () => {
  it('mount, focus and foreground on Analyze, then an owner switch and back on Settings, write nothing to the ledger', async () => {
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    handle.calls.length = 0;
    const analyze = await render(<AnalyzeScreen />);
    await settle();
    await act(async () => {
      emitFocus();
    });
    await settle();
    background();
    await act(async () => {
      foreground();
    });
    await settle();
    expect(badgeOf(analyze)).toBe('ON HOLD');
    await act(async () => analyze.unmount());
    mounted = null;
    const renderer = await render(<SettingsScreen />);
    await settle();
    await act(async () => {
      signInAs(OTHER_OWNER, 'token-2');
    });
    await settle();
    expect(badgeOf(renderer)).toBe('NONE HELD');
    await act(async () => {
      signInAs(OWNER, 'token-3');
    });
    await settle();
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(handle.calls.length).toBeGreaterThan(0);
    expect(handle.calls.filter(call => WRITE_STATEMENT.test(call.sql))).toEqual(
      [],
    );
    const truth = await ledgerTruth();
    expect(truth.allocation.spendableTickets).toBe(1);
    expect(truth.allocation.consumedTickets).toBe(1);
    expect(truth.wallet.hold).toBe(true);
  });
});

describe('A9 — a Pro lease that needs an online check beside a live free allocation', () => {
  it('states the live free allocation and never calls the unconfirmed Pro lease active', async () => {
    await holdGrant();
    await holdGrant(PRO_GRANT_AHEAD_OF_CLOCK);
    const truth = await ledgerTruth();
    const pro = truth.allocation.grants.find(
      grant => grant.grantId === PRO_GRANT_ID,
    );
    expect(pro?.execution).toEqual({
      kind: 'reconcile_required',
      reason: 'lease_ahead_of_clock',
    });
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).not.toContain('Pro offline pass active');
    expect(copy).not.toContain('Pro pass');
    expect(copy).toContain('2 of 2');
    expectDossierCompliant(copy);
  });
});

describe('A10 — far-future and far-past trusted clocks on the shipping screen', () => {
  it('a year-3000 trusted clock reads the pass as expired with the allocation intact', async () => {
    await holdGrant();
    await spend('op-1');
    mockReading = YEAR_3000;
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('EXPIRED');
    expect(copy).toContain('1 of 2');
    expect(copy).toContain('Expired');
    expect(copy).not.toContain('ready');
    expectDossierCompliant(copy);
  });

  it('an epoch trusted clock (pass dated ahead of it) asks for an online check, never READY', async () => {
    await holdGrant();
    mockReading = EPOCH;
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('CONFIRM ONLINE');
    expect(copy).toContain('Unconfirmed');
    expect(copy).toContain('ahead of the confirmed time');
    expect(copy).not.toContain('ready');
    expectDossierCompliant(copy);
  });
});
