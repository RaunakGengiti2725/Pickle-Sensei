/**
 * W05-04 adversarial suite against candidate 45e8ad41 (branch
 * devin/pp/w05-04/attack-45e8ad41). Every test here attacks a failure
 * boundary of the offline journey card the candidate's own suite does not
 * pin: an account switch or sign-out that lands while a read is still in
 * flight, a commit whose acknowledgement is lost between the steps of a
 * spend or a drain, replayed and foreign identities in the server's answer,
 * each way a presentation can fail on the wire (redirect, captive portal,
 * 5xx with Retry-After, a request that never answers), boundary trusted
 * readings (NaN, far-future, far-past, the exact lease end), partial or
 * corrupt persisted rows, a presenter-wide copy/accessibility sweep, and the
 * wallet where a live Pro lease sits beside a newer free generation.
 *
 * The candidate's production code and tests are not modified; fixtures are
 * restated here so this file stands alone.
 */
import React from 'react';
import { Text } from 'react-native';
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
  OfflineAllocationCard,
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
  pendingOfflineReceipts,
  readOfflineAllocation,
  type HeldOfflineGrantView,
} from '../src/data/offlineCapabilities';
import {
  readOfflineWalletStatus,
  reconcileOfflineWallet,
  type OfflineWalletPendingReceipt,
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
const SECOND_GENERATION_GRANT_ID = 'bbbbbbbb-0000-4000-8000-000000000003';
const LATER_PRO_GRANT_ID = 'bbbbbbbb-0000-4000-8000-000000000004';
const LONG_GRANT_ID = 'bbbbbbbb-0000-4000-8000-000000000005';
const FOREIGN_RECEIPT_ID = 'dddddddd-0000-4000-8000-000000000001';
const RESULT_SHA = 'c'.repeat(64);
const BINDING = { installationKeyId: INSTALLATION_KEY, issuer: ISSUER };
const CARD_TEST_ID = 'offline-allocation-card';

/** Vocabulary docs/APP_STORE_SUBMISSION.md forbids in user-facing copy. */
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
  /\bguarantee/i,
  /\bunlimited\b/i,
];

/** Rendering artefacts that would betray an unformatted value. */
const RENDER_ARTEFACTS = [
  /NaN/,
  /undefined/,
  /Infinity/,
  /\bnull\b/,
  /\[object/,
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

/** A lease the server must never issue: thirty days, four times the cap. */
const THIRTY_DAY_GRANT: GrantShape = {
  entitlementSource: 'identity_lifetime_free',
  grantId: LONG_GRANT_ID,
  issuedAt: ISSUED_AT,
  expiresAt: ISSUED_AT + 30 * DAY_S,
  entitlementExpiresAt: null,
};

const SECOND_GENERATION_ISSUED_AT = EXPIRES_AT + DAY_S;
/** The next free generation for this installation, restating one ticket. */
const SECOND_GENERATION_GRANT: GrantShape = {
  entitlementSource: 'identity_lifetime_free',
  grantId: SECOND_GENERATION_GRANT_ID,
  issuedAt: SECOND_GENERATION_ISSUED_AT,
  expiresAt: SECOND_GENERATION_ISSUED_AT + SIX_DAYS_S,
  entitlementExpiresAt: null,
  generation: 2,
  ticketIds: [TICKETS[1]],
};

/** A Pro lease (generation 1) that is live at the second generation's
 * issue: a subscriber whose entitlement the server no longer honoured when
 * it issued the free generation, while the signed lease is still in date. */
const PRO_BESIDE_SECOND_GENERATION: GrantShape = {
  entitlementSource: 'verified_store',
  grantId: LATER_PRO_GRANT_ID,
  issuedAt: SECOND_GENERATION_ISSUED_AT - DAY_S,
  expiresAt: SECOND_GENERATION_ISSUED_AT + 5 * DAY_S,
  entitlementExpiresAt: SECOND_GENERATION_ISSUED_AT + 30 * DAY_S,
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

const AT_ISSUE = anchored(ISSUED_AT * 1000);
const AT_SECOND_GENERATION_ISSUE = anchored(SECOND_GENERATION_ISSUED_AT * 1000);

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

async function unmount() {
  if (mounted) await act(async () => mounted?.unmount());
  mounted = null;
}

async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise(resolve => setTimeout(() => resolve(undefined), 0));
    });
  }
}

/** `settle()` on fake timers: flushes due timers and their promise chains. */
async function settleFake() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
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
  for (const pattern of RENDER_ARTEFACTS) {
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

function mockFetch(
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
) {
  fetchSpy?.mockRestore();
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(implementation);
  return fetchSpy;
}

function presentedReceiptIds(init?: RequestInit): string[] {
  const body = JSON.parse(String(init?.body ?? '{}')) as {
    receipts?: Array<{ receiptId: string }>;
  };
  return (body.receipts ?? []).map(receipt => receipt.receiptId);
}

function jsonResponse(payload: unknown, status = 200, headers = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Presents and loses the connection: the journal entry stays in flight. */
async function presentAndLoseConnection() {
  mockFetch(async () => {
    throw new TypeError('Network request failed');
  });
  await expect(
    reconcileOfflineWallet(db, grantClient(), AT_ISSUE),
  ).rejects.toThrow('Network request failed');
}

/** Presents and receives `status` for every receipt named in the request. */
async function presentAndReceive(status: string) {
  mockFetch(async (input, init) => {
    if (String(input) !== RECEIPTS_ROUTE) {
      return jsonResponse({ error: 'not_found' }, 404);
    }
    return jsonResponse({
      receipts: presentedReceiptIds(init).map(receiptId => ({
        receiptId,
        status,
      })),
      rejected: [],
    });
  });
  return reconcileOfflineWallet(db, grantClient(), AT_ISSUE);
}

async function ledgerTruth(reading = AT_ISSUE) {
  return {
    allocation: await readOfflineAllocation(db, reading),
    wallet: await readOfflineWalletStatus(db),
    pending: await pendingOfflineReceipts(db),
  };
}

/** Wraps the test database so its FIRST transaction stalls until released. */
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
  clearApiSession();
  useAuthStore.setState({ session: null });
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
}

function sql(statement: string, ...params: unknown[]) {
  handle.native.prepare(statement).run(...params);
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
  await unmount();
  fetchSpy?.mockRestore();
  fetchSpy = null;
  clearAccessStoreConfiguration();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  mockDb = null;
  mockReading = null;
  closeSqliteTestDatabases();
});

describe('W05-04 attack — account switch and sign-out interleaved with a read', () => {
  it('a read that started under account A and finishes after the switch to B never shows under B, and A reads fresh when it returns', async () => {
    await holdGrant();
    await spend('op-1');
    const gated = gateFirstTransaction();
    mockDb = () => gated.db;
    // Settings stays mounted across an account switch (Analyze re-arms).
    const renderer = await render(<SettingsScreen />);
    await settle();
    // A's read is stalled inside the ledger: the card is still checking.
    expect(badgeOf(renderer)).toBe('CHECKING');

    signInAs(OTHER_OWNER, 'token-2');
    await settle();
    expect(badgeOf(renderer)).toBe('NONE HELD');

    // A's stale read lands now, under B.
    gated.release();
    await settle();
    expect(badgeOf(renderer)).toBe('NONE HELD');
    const underB = textOf(card(renderer));
    expect(underB).not.toContain('1 of 2');
    expect(underB).not.toContain('waiting');

    // The ledger moves on for A while B is signed in on this phone.
    setActiveDataOwner(OWNER);
    await spend('op-2');
    signInAs(OWNER, 'token-3');
    await settle();
    const underA = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('SPENT');
    expect(underA).toContain('0 of 2');
    expect(underA).not.toContain('1 of 2');
    expect(underA).toContain('2 results waiting');
    expectDossierCompliant(underA);
  });

  it('a read that finishes after sign-out is never shown, and the card is gone for the signed-out phone', async () => {
    await holdGrant();
    await spend('op-1');
    const gated = gateFirstTransaction();
    mockDb = () => gated.db;
    const renderer = await render(<SettingsScreen />);
    await settle();
    expect(badgeOf(renderer)).toBe('CHECKING');

    signOut();
    await settle();
    expect(cards(renderer)).toHaveLength(0);
    gated.release();
    await settle();
    expect(cards(renderer)).toHaveLength(0);

    // Back on the same account: only a fresh read is shown.
    setActiveDataOwner(OWNER);
    await spend('op-2');
    signInAs(OWNER, 'token-2');
    await settle();
    const copy = textOf(card(renderer));
    expect(copy).toContain('0 of 2');
    expect(copy).not.toContain('1 of 2');
  });

  it('a switch to a local-only guest while A is being read hides the card, and the stale read never resurfaces', async () => {
    await holdGrant();
    const gated = gateFirstTransaction();
    mockDb = () => gated.db;
    const renderer = await render(<SettingsScreen />);
    await settle();
    expect(badgeOf(renderer)).toBe('CHECKING');
    useAuthStore.setState({ session: guestSession });
    setActiveDataOwner('device-guest');
    await settle();
    expect(cards(renderer)).toHaveLength(0);
    gated.release();
    await settle();
    expect(cards(renderer)).toHaveLength(0);
    expect(textOf(renderer.root)).not.toContain('2 of 2');
  });

  it('a HOLD follow-up timer armed under account A never reads A’s ledger once B is signed in', async () => {
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    jest.useFakeTimers();
    try {
      const renderer = await render(<SettingsScreen />);
      await settleFake();
      expect(badgeOf(renderer)).toBe('ON HOLD');
      const readsOf = (owner: string) =>
        handle.calls.filter(
          call =>
            call.sql.includes('FROM offline_grant') &&
            call.params.includes(owner),
        ).length;
      const aReadsBefore = readsOf(OWNER);
      signInAs(OTHER_OWNER, 'token-2');
      await settleFake();
      expect(badgeOf(renderer)).toBe('NONE HELD');
      const bReadsBefore = readsOf(OTHER_OWNER);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(
          PENDING_RECEIPT_READ_CADENCE_MS * 4,
        );
      });
      await settleFake();
      expect(readsOf(OWNER)).toBe(aReadsBefore);
      // B holds nothing and has nothing pending: no timer reads B either.
      expect(readsOf(OTHER_OWNER)).toBe(bReadsBefore);
      expect(badgeOf(renderer)).toBe('NONE HELD');
      expect(textOf(card(renderer))).not.toContain('on hold');
    } finally {
      jest.useRealTimers();
    }
  });

  it('uppercase canonical account ids still address the same ledger as the lowercase owner key', async () => {
    await holdGrant();
    await spend('op-1');
    signInAs(OWNER.toUpperCase(), 'token-2');
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    expect(badgeOf(renderer)).toBe('READY');
    expect(textOf(card(renderer))).toContain('1 of 2');
  });
});

describe('W05-04 attack — a commit whose acknowledgement is lost between steps', () => {
  it('a spend whose commit acknowledgement is lost is still shown as spent: the card follows the durable ledger, not the thrown error', async () => {
    await holdGrant();
    handle.failCommitOnce('after', 'INSERT INTO offline_receipt');
    await expect(spend('op-1')).rejects.toThrow('acknowledgement lost');
    const truth = await ledgerTruth();
    expect(truth.allocation.spendableTickets).toBe(1);
    expect(truth.pending).toHaveLength(1);
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('1 of 2');
    expect(copy).toContain('1 result waiting');
    expect(copy).not.toContain('2 of 2');
    expectDossierCompliant(copy);
  });

  it('a spend whose commit fails before it lands is not shown as spent', async () => {
    await holdGrant();
    handle.failCommitOnce('before', 'INSERT INTO offline_receipt');
    await expect(spend('op-1')).rejects.toThrow('before commit');
    const truth = await ledgerTruth();
    expect(truth.allocation.spendableTickets).toBe(2);
    expect(truth.pending).toHaveLength(0);
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('2 of 2');
    expect(copy).toContain('Nothing');
    expect(copy).not.toContain('waiting');
  });

  it('a drain whose verdict commit acknowledgement is lost still clears the HOLD on screen: the receipt was accepted durably', async () => {
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    expect((await ledgerTruth()).wallet.hold).toBe(true);
    handle.failCommitOnce('after', "SET state = 'applied'");
    await expect(presentAndReceive('result_recorded')).rejects.toThrow(
      'acknowledgement lost',
    );
    const truth = await ledgerTruth();
    expect(truth.wallet.hold).toBe(false);
    expect(truth.pending).toHaveLength(0);
    expect(truth.allocation.spendableTickets).toBe(1);
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('1 of 2');
    expect(copy).toContain('Nothing');
    expect(copy).not.toContain('on hold');
    expectDossierCompliant(copy);
  });
});

describe('W05-04 attack — replayed and foreign identities in the server answer, and every way the wire can fail', () => {
  interface WireFailure {
    readonly name: string;
    readonly answer: (init?: RequestInit) => Response;
  }
  const failures: WireFailure[] = [
    {
      name: 'the same receipt answered twice (accepted and rejected)',
      answer: init => {
        const [receiptId] = presentedReceiptIds(init);
        return jsonResponse({
          receipts: [{ receiptId, status: 'result_recorded' }],
          rejected: [{ receiptId, code: 'receipt_replayed' }],
        });
      },
    },
    {
      name: 'a verdict for a receipt this phone never presented',
      answer: () =>
        jsonResponse({
          receipts: [
            { receiptId: FOREIGN_RECEIPT_ID, status: 'result_recorded' },
          ],
          rejected: [],
        }),
    },
    {
      name: 'an accepted verdict plus an extra foreign receipt',
      answer: init =>
        jsonResponse({
          receipts: [
            ...presentedReceiptIds(init).map(receiptId => ({
              receiptId,
              status: 'result_recorded',
            })),
            { receiptId: FOREIGN_RECEIPT_ID, status: 'result_recorded' },
          ],
          rejected: [],
        }),
    },
    {
      name: 'a captive portal answering 200 text/html',
      answer: () =>
        new Response('<html><body>Sign in to the network</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    },
    {
      name: 'a 302 redirect away from the rating service',
      answer: () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://portal.example.test/login' },
        }),
    },
    {
      name: 'a 503 with Retry-After',
      answer: () =>
        jsonResponse(
          { error: { code: 'unavailable', message: 'Try later.' } },
          503,
          { 'retry-after': '120' },
        ),
    },
    {
      name: 'a 500 with an empty body',
      answer: () => new Response(null, { status: 500 }),
    },
    {
      name: 'a 200 with an unknown verdict status',
      answer: init =>
        jsonResponse({
          receipts: presentedReceiptIds(init).map(receiptId => ({
            receiptId,
            status: 'result_maybe_recorded',
          })),
          rejected: [],
        }),
    },
  ];

  it.each(failures)(
    'after $name the card is ON HOLD, charges nothing twice and refunds nothing',
    async ({ answer }) => {
      await holdGrant();
      await spend('op-1');
      mockFetch(async (_input, init) => answer(init));
      await expect(
        reconcileOfflineWallet(db, grantClient(), AT_ISSUE),
      ).rejects.toThrow();
      const truth = await ledgerTruth();
      expect(truth.wallet.hold).toBe(true);
      expect(truth.pending).toHaveLength(1);
      expect(truth.allocation.spendableTickets).toBe(1);
      expect(truth.allocation.consumedTickets).toBe(1);
      const renderer = await render(<AnalyzeScreen />);
      await settle();
      const copy = textOf(card(renderer));
      expect(badgeOf(renderer)).toBe('ON HOLD');
      expect(copy).toContain('1 result awaiting confirmation');
      expect(copy).toContain('1 on hold');
      expect(copy).toContain('1 of 2');
      expect(copy).toContain('nothing is charged twice');
      expect(copy).not.toContain('2 of 2');
      expect(copy).not.toContain('0 of 2');
      expect(copy).not.toContain('Nothing');
      expect(copy).not.toContain('still confirming');
      expectDossierCompliant(copy);
    },
  );

  it('a request that never answers is a HOLD for as long as it hangs, and two concurrent drains present the receipt once', async () => {
    await holdGrant();
    await spend('op-1');
    let answer: () => void = () => undefined;
    const answered = new Promise<void>(resolve => {
      answer = resolve;
    });
    let presentations = 0;
    mockFetch(async (input, init) => {
      if (String(input) !== RECEIPTS_ROUTE) {
        return jsonResponse({ error: 'not_found' }, 404);
      }
      presentations += 1;
      await answered;
      return jsonResponse({
        receipts: presentedReceiptIds(init).map(receiptId => ({
          receiptId,
          status: 'result_recorded',
        })),
        rejected: [],
      });
    });
    const drains = Promise.all([
      reconcileOfflineWallet(db, grantClient(), AT_ISSUE),
      reconcileOfflineWallet(db, grantClient(), AT_ISSUE),
    ]);
    await new Promise(resolve => setTimeout(resolve, 0));
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    const hanging = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(hanging).toContain('1 on hold');
    expect(hanging).toContain('1 of 2');
    expect(hanging).not.toContain('Nothing');

    answer();
    const [first, second] = await drains;
    expect(presentations).toBe(1);
    expect(first.submitted + second.submitted).toBe(1);
    expect(first.accepted + second.accepted).toBe(1);
    await unmount();
    const again = await render(<AnalyzeScreen />);
    await settle();
    const settled = textOf(card(again));
    expect(badgeOf(again)).toBe('READY');
    expect(settled).toContain('1 of 2');
    expect(settled).toContain('Nothing');
    expect(settled).not.toContain('on hold');
    expectDossierCompliant(settled);
  });

  it('a receipt the server refuses per receipt stays spent on screen — no refund, no HOLD, no invented queue', async () => {
    await holdGrant();
    await spend('op-1');
    mockFetch(async (_input, init) =>
      jsonResponse({
        receipts: [],
        rejected: presentedReceiptIds(init).map(receiptId => ({
          receiptId,
          code: 'grant_not_recognized',
        })),
      }),
    );
    const outcome = await reconcileOfflineWallet(db, grantClient(), AT_ISSUE);
    expect(outcome.refused).toBe(1);
    const truth = await ledgerTruth();
    expect(truth.wallet.hold).toBe(false);
    expect(truth.pending).toHaveLength(0);
    expect(truth.allocation.spendableTickets).toBe(1);
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('1 of 2');
    expect(copy).toContain('Nothing');
    expect(copy).not.toContain('2 of 2');
    expect(copy).not.toContain('on hold');
    expect(copy).not.toContain('waiting');
    expectDossierCompliant(copy);
  });
});

describe('W05-04 attack — boundary trusted readings through the ledger read path', () => {
  interface ReadingCase {
    readonly name: string;
    readonly reading: TrustedTimeReading;
    readonly badge: string;
    readonly contains: readonly string[];
    readonly absent: readonly string[];
  }
  const year2200Ms = Date.UTC(2200, 0, 1);
  const cases: ReadingCase[] = [
    {
      name: 'a NaN trusted instant',
      reading: { ...AT_ISSUE, nowMs: Number.NaN, wallClockMs: Number.NaN },
      badge: 'CONFIRM ONLINE',
      contains: ['2 of 2', 'Unconfirmed', 'online check'],
      absent: ['READY', 'ready', 'In '],
    },
    {
      name: 'a far-future trusted instant (year 2200)',
      reading: anchored(year2200Ms),
      badge: 'EXPIRED',
      contains: ['2 of 2', 'Expired', 'stay allocated'],
      absent: ['READY', 'ready', 'In '],
    },
    {
      name: 'a trusted instant a day before the pass was issued',
      reading: anchored((ISSUED_AT - DAY_S) * 1000),
      badge: 'CONFIRM ONLINE',
      contains: ['2 of 2', 'Unconfirmed', 'ahead of the confirmed time'],
      absent: ['READY', 'ready', 'In '],
    },
    {
      name: 'the last millisecond of the pass',
      reading: anchored(EXPIRES_AT * 1000 - 1),
      badge: 'READY',
      contains: ['2 of 2', 'In under an hour', '2 offline analyses ready'],
      absent: ['Expired', 'In 0'],
    },
    {
      name: 'the exact lease end',
      reading: anchored(EXPIRES_AT * 1000),
      badge: 'EXPIRED',
      contains: ['2 of 2', 'Expired'],
      absent: ['READY', 'ready', 'In '],
    },
    {
      name: 'an anchored reading with a detected rollback',
      reading: { ...AT_ISSUE, rollbackDetected: true },
      badge: 'CONFIRM ONLINE',
      contains: ['2 of 2', 'Unconfirmed', 'moved backwards'],
      absent: ['READY', 'ready', 'In '],
    },
    {
      name: 'no authority because the saved time record is invalid',
      reading: {
        ...AT_ISSUE,
        authority: 'none',
        continuity: 'none',
        storage: 'invalid',
      },
      badge: 'CONFIRM ONLINE',
      contains: ['2 of 2', 'Unconfirmed', 'saved time record'],
      absent: ['READY', 'ready', 'In '],
    },
    {
      name: 'a floor reading whose elapsed time went unmeasured',
      reading: { ...AT_ISSUE, authority: 'floor', continuity: 'unmeasured' },
      badge: 'CONFIRM ONLINE',
      contains: ['2 of 2', 'Unconfirmed', 'could not be measured'],
      absent: ['READY', 'ready', 'In '],
    },
    {
      name: 'a raw wall clock with no trusted authority',
      reading: {
        ...AT_ISSUE,
        authority: 'none',
        continuity: 'none',
        storage: 'empty',
      },
      badge: 'CONFIRM ONLINE',
      contains: ['2 of 2', 'Unconfirmed', 'not confirmed the time'],
      absent: ['READY', 'ready', 'In '],
    },
    {
      name: 'a phone clock in 1970 beside a trusted reading at issue',
      reading: { ...AT_ISSUE, wallClockMs: 0 },
      badge: 'READY',
      contains: ['2 of 2', 'In 6 days'],
      absent: ['Expired', 'Unconfirmed'],
    },
    {
      name: 'exactly one whole day left',
      reading: anchored((EXPIRES_AT - DAY_S) * 1000),
      badge: 'READY',
      contains: ['In 1 day'],
      absent: ['In 1 days', 'In 0', 'In 24 hours'],
    },
    {
      name: 'one millisecond under a whole day left',
      reading: anchored((EXPIRES_AT - DAY_S) * 1000 + 1),
      badge: 'READY',
      contains: ['In 23 hours'],
      absent: ['In 1 day', 'In 0'],
    },
  ];

  it.each(cases)(
    'under $name the card states what the ledger read, never a live pass it cannot prove',
    async ({ reading, badge, contains, absent }) => {
      await holdGrant();
      mockReading = reading;
      const renderer = await render(<AnalyzeScreen />);
      await settle();
      const copy = textOf(card(renderer));
      expect(badgeOf(renderer)).toBe(badge);
      for (const fragment of contains) expect(copy).toContain(fragment);
      for (const fragment of absent) expect(copy).not.toContain(fragment);
      expectDossierCompliant(copy);
    },
  );

  it('a thirty-day lease is refused at hold, and the card keeps saying nothing is held', async () => {
    await expect(holdGrant(THIRTY_DAY_GRANT)).rejects.toMatchObject({
      code: expect.stringMatching(/^offline\./),
    });
    expect(handle.count('offline_grant', OWNER)).toBe(0);
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('NONE HELD');
    expect(copy).not.toContain('In 30 days');
    expect(copy).not.toContain(' of ');
  });
});

describe('W05-04 attack — partial and corrupt persisted rows', () => {
  interface Corruption {
    readonly name: string;
    readonly apply: () => Promise<void>;
  }
  const corruptions: Corruption[] = [
    {
      name: 'a ticket row vanished from a held grant',
      apply: async () => {
        await holdGrant();
        sql(
          `DELETE FROM offline_ticket WHERE owner_key = ? AND ticket_id = ?`,
          OWNER,
          TICKETS[0],
        );
      },
    },
    {
      name: 'a receipt settled "accepted" with no settlement time (half a write)',
      apply: async () => {
        await holdGrant();
        await spend('op-1');
        sql(
          `UPDATE offline_receipt SET settlement = 'accepted', settled_at = NULL
           WHERE owner_key = ?`,
          OWNER,
        );
      },
    },
    {
      name: 'a journal entry in flight that also carries a close time',
      apply: async () => {
        await holdGrant();
        await spend('op-1');
        await presentAndLoseConnection();
        sql(
          `UPDATE offline_wallet_journal SET closed_at = '2027-01-01T00:00:00.000Z'
           WHERE owner_key = ? AND state = 'in_flight'`,
          OWNER,
        );
      },
    },
    {
      name: 'a grant row whose generation no longer matches its tickets',
      apply: async () => {
        await holdGrant();
        sql(
          `UPDATE offline_grant SET generation = 7 WHERE owner_key = ?`,
          OWNER,
        );
      },
    },
    {
      name: 'a receipt body truncated mid-JSON',
      apply: async () => {
        await holdGrant();
        await spend('op-1');
        sql(
          `UPDATE offline_receipt SET receipt = substr(receipt, 1, 40)
           WHERE owner_key = ?`,
          OWNER,
        );
      },
    },
    {
      name: 'a consumed ticket whose receipt row is gone',
      apply: async () => {
        await holdGrant();
        await spend('op-1');
        sql(`DELETE FROM offline_receipt WHERE owner_key = ?`, OWNER);
      },
    },
    {
      name: 'a journal entry naming a receipt list that is not a list',
      apply: async () => {
        await holdGrant();
        await spend('op-1');
        await presentAndLoseConnection();
        sql(
          `UPDATE offline_wallet_journal SET receipt_ids = '"not-a-list"'
           WHERE owner_key = ?`,
          OWNER,
        );
      },
    },
    {
      name: 'a grant whose expiry precedes its issue',
      apply: async () => {
        await holdGrant();
        sql(
          `UPDATE offline_grant SET expires_at = issued_at - 1 WHERE owner_key = ?`,
          OWNER,
        );
      },
    },
  ];

  it.each(corruptions)(
    'with $name the card is UNAVAILABLE on both surfaces and states no count, no pass and no queue',
    async ({ apply }) => {
      await apply();
      for (const Screen of [AnalyzeScreen, SettingsScreen]) {
        const renderer = await render(<Screen />);
        await settle();
        const copy = textOf(card(renderer));
        expect(badgeOf(renderer)).toBe('UNAVAILABLE');
        expect(copy).toContain('could not be read');
        expect(copy).toContain('Nothing was changed');
        expect(copy).not.toMatch(/\d of \d/);
        expect(copy).not.toContain('ready');
        expect(copy).not.toContain('waiting');
        expect(copy).not.toContain('on hold');
        expect(copy).not.toContain('Pro pass');
        expectDossierCompliant(copy);
        await unmount();
      }
    },
  );
});

describe('W05-04 attack — presenter sweep over every verdict, entitlement, count and receipt phase', () => {
  const verdicts: TrustedTimeLeaseVerdict[] = [
    { kind: 'active', remainingMs: SIX_DAYS_S * 1000 },
    { kind: 'active', remainingMs: 1 },
    { kind: 'active', remainingMs: 0 },
    { kind: 'active', remainingMs: Number.NaN },
    { kind: 'active', remainingMs: Number.POSITIVE_INFINITY },
    { kind: 'expired' },
    { kind: 'reconcile_required', reason: 'no_trusted_time' },
    { kind: 'reconcile_required', reason: 'storage_invalid' },
    { kind: 'reconcile_required', reason: 'clock_rollback' },
    { kind: 'reconcile_required', reason: 'floor_only' },
    { kind: 'reconcile_required', reason: 'elapsed_unmeasured' },
    { kind: 'reconcile_required', reason: 'invalid_lease' },
    { kind: 'reconcile_required', reason: 'lease_ahead_of_clock' },
  ];

  function grant(
    entitlementSource: 'identity_lifetime_free' | 'verified_store',
    execution: TrustedTimeLeaseVerdict,
    allocated: number,
    remaining: number,
    grantId = GRANT_ID,
  ): HeldOfflineGrantView {
    return {
      grantId,
      generation: 1,
      entitlementSource,
      installationKeyId: INSTALLATION_KEY,
      keyId: KEY_ID,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      entitlementExpiresAt:
        entitlementSource === 'verified_store' ? EXPIRES_AT + DAY_S : null,
      grantJwsSha256: 'e'.repeat(64),
      allocated,
      remaining,
      consumed: allocated - remaining,
      lifecycleSequence: allocated - remaining,
      execution,
    };
  }

  function receipt(
    index: number,
    phase: OfflineWalletPendingReceipt['phase'],
  ): OfflineWalletPendingReceipt {
    return {
      receiptId: `receipt-${index}`,
      operationId: `op-${index}`,
      settlement: phase === 'held' ? 'held' : null,
      presentations: phase === 'queued' ? 0 : 1,
      phase,
    };
  }

  const wallets: OfflineWalletStatus[] = [
    { pending: [], unansweredPresentations: 0, hold: false },
    {
      pending: [receipt(1, 'queued')],
      unansweredPresentations: 0,
      hold: false,
    },
    {
      pending: [receipt(1, 'presented_unanswered')],
      unansweredPresentations: 1,
      hold: true,
    },
    { pending: [receipt(1, 'held')], unansweredPresentations: 0, hold: false },
    { pending: [], unansweredPresentations: 1, hold: true },
    {
      pending: [receipt(1, 'queued'), receipt(2, 'held')],
      unansweredPresentations: 1,
      hold: true,
    },
    {
      pending: [
        receipt(1, 'presented_unanswered'),
        receipt(2, 'presented_unanswered'),
      ],
      unansweredPresentations: 1,
      hold: true,
    },
  ];

  const grantSets: HeldOfflineGrantView[][] = [];
  for (const verdict of verdicts) {
    for (const [allocated, remaining] of [
      [2, 2],
      [2, 1],
      [2, 0],
      [1, 1],
      [1, 0],
    ] as const) {
      grantSets.push([
        grant('identity_lifetime_free', verdict, allocated, remaining),
      ]);
    }
    grantSets.push([grant('verified_store', verdict, 0, 0)]);
    for (const other of verdicts) {
      grantSets.push([
        grant('verified_store', verdict, 0, 0, LATER_PRO_GRANT_ID),
        grant('identity_lifetime_free', other, 2, 1),
      ]);
      // A newer free generation restating one ticket beside the older one.
      grantSets.push([
        {
          ...grant(
            'identity_lifetime_free',
            other,
            1,
            1,
            SECOND_GENERATION_GRANT_ID,
          ),
          generation: 2,
        },
        grant('identity_lifetime_free', verdict, 2, 1),
      ]);
    }
  }
  grantSets.push([]);

  function stateFor(
    grants: readonly HeldOfflineGrantView[],
    wallet: OfflineWalletStatus,
  ): Extract<OfflineJourneyState, { kind: 'read' }> {
    let spendable = 0;
    let consumed = 0;
    for (const held of grants) {
      spendable += held.remaining;
      consumed += held.consumed;
    }
    return {
      kind: 'read',
      allocation: {
        grants,
        spendableTickets: spendable,
        consumedTickets: consumed,
        pendingReceipts: wallet.pending.length,
      },
      wallet,
    };
  }

  const BADGES = new Set([
    'READY',
    'SPENT',
    'EXPIRED',
    'CONFIRM ONLINE',
    'ON HOLD',
    'NONE HELD',
  ]);
  const SINGULAR_AFTER_PLURAL_COUNT =
    /\b(?:0|[2-9]|\d{2,}) (?:result|analysis|day|hour)\b/;
  const PLURAL_AFTER_ONE = /\b1 (?:results|analyses|days|hours)\b/;

  function isLive(verdict: TrustedTimeLeaseVerdict): boolean {
    return (
      verdict.kind === 'active' &&
      Number.isFinite(verdict.remainingMs) &&
      verdict.remainingMs > 0
    );
  }

  it('every reachable state reads as consistent copy: no forbidden term, no artefact, agreeing numbers, a badge that matches the facts', () => {
    let examined = 0;
    for (const grants of grantSets) {
      for (const wallet of wallets) {
        const state = stateFor(grants, wallet);
        const view = presentOfflineJourney(state);
        const copy = [
          view.badge,
          view.title,
          ...view.rows.flatMap(row => [row.label, row.value]),
          ...view.notes,
        ].join(' | ');
        const label = `${JSON.stringify(grants.map(g => [g.entitlementSource, g.execution, g.remaining]))} ${JSON.stringify(wallet)}`;
        const expectWith = (condition: boolean, why: string) => {
          if (!condition)
            throw new Error(`${why}\n  state: ${label}\n  copy: ${copy}`);
        };
        expectDossierCompliant(copy);
        expectWith(BADGES.has(view.badge), `unknown badge ${view.badge}`);
        expectWith(
          !SINGULAR_AFTER_PLURAL_COUNT.test(copy),
          'singular noun after a plural count',
        );
        expectWith(!PLURAL_AFTER_ONE.test(copy), 'plural noun after "1"');
        expectWith(
          !/\b0 held analys/.test(copy),
          'announces zero held analyses',
        );
        expectWith(!/\bYour 0\b/.test(copy), 'announces "Your 0"');
        expectWith(
          new Set(view.notes).size === view.notes.length,
          'duplicate note (duplicate React key)',
        );
        expectWith(
          new Set(view.rows.map(row => row.label)).size === view.rows.length,
          'duplicate row label (duplicate React key)',
        );
        expectWith(view.title.trim().length > 0, 'empty title');
        expectWith(
          view.rows.every(row => row.value.trim().length > 0),
          'empty row value',
        );

        const spendable = state.allocation.spendableTickets;
        const liveFree = grants.some(
          g =>
            g.entitlementSource === 'identity_lifetime_free' &&
            isLive(g.execution),
        );
        const livePro = grants.some(
          g => g.entitlementSource === 'verified_store' && isLive(g.execution),
        );
        const anyPending = wallet.pending.length > 0 || wallet.hold;
        const hold =
          wallet.hold || wallet.pending.some(r => r.phase !== 'queued');
        const readyCount = grants
          .filter(
            g =>
              g.entitlementSource === 'identity_lifetime_free' &&
              isLive(g.execution),
          )
          .reduce((sum, g) => sum + g.remaining, 0);

        expectWith(
          (view.badge === 'ON HOLD') === hold,
          'ON HOLD disagrees with the wallet',
        );
        if (view.badge === 'READY') {
          expectWith(
            livePro || readyCount > 0,
            'READY with nothing live to spend',
          );
          expectWith(!hold, 'READY while on hold');
          if (!livePro) {
            expectWith(
              copy.includes(`${readyCount} offline analys`),
              'READY count disagrees with the live tickets',
            );
          }
        }
        if (!livePro) {
          expectWith(
            !/\d offline analys/.test(copy) || view.badge === 'READY',
            'announces ready analyses without READY',
          );
        }
        const strandedCount = spendable - readyCount;
        if (view.badge === 'READY' && !livePro && strandedCount > 0) {
          expectWith(
            copy.includes(`${strandedCount} held analys`),
            'stranded tickets not named beside READY',
          );
        }
        if (view.badge === 'SPENT') {
          expectWith(spendable === 0, 'SPENT with tickets left');
        }
        if (view.badge === 'NONE HELD') {
          expectWith(grants.length === 0, 'NONE HELD with grant rows');
        }
        if (grants.length > 0 && !hold && (liveFree || livePro)) {
          expectWith(
            view.badge === 'READY' ||
              view.badge === 'SPENT' ||
              view.badge === 'CONFIRM ONLINE',
            `live grant badged ${view.badge}`,
          );
        }
        const waitingRow = view.rows.find(
          row => row.label === 'Waiting to sync',
        );
        expectWith(waitingRow !== undefined, 'no Waiting to sync row');
        expectWith(
          (waitingRow?.value === 'Nothing') === !anyPending,
          'Waiting to sync disagrees with the wallet',
        );
        const allocationRow = view.rows.find(row => row.label === 'Allocation');
        if (grants.length === 0) {
          expectWith(
            allocationRow === undefined,
            'allocation row without grants',
          );
        } else {
          expectWith(
            allocationRow !== undefined,
            'no allocation row for held grants',
          );
        }
        const claimsPro = copy.includes('Pro pass');
        if (livePro) {
          expectWith(claimsPro, 'live Pro lease not stated');
        } else if (!(
          grants.every(g => g.entitlementSource === 'verified_store') &&
          grants.length > 0
        )) {
          expectWith(!claimsPro, 'Pro pass claimed without a live Pro lease');
        }
        if (!claimsPro && grants.length > 0) {
          const total = spendable + state.allocation.consumedTickets;
          expectWith(
            copy.includes(`${spendable} of ${total} unspent`),
            'allocation count missing',
          );
        }
        if (
          copy.includes('stay allocated') ||
          copy.includes('stays allocated')
        ) {
          expectWith(spendable > 0, 'retention note with nothing held');
        }
        examined += 1;
      }
    }
    expect(examined).toBe(grantSets.length * wallets.length);
    expect(examined).toBeGreaterThan(1000);
  });

  it('the rendered card always carries its status as text (never colour alone) and never two children under one key', async () => {
    const samples: OfflineJourneyState[] = [
      { kind: 'loading' },
      { kind: 'unavailable' },
      stateFor(
        [
          grant(
            'identity_lifetime_free',
            { kind: 'active', remainingMs: 1 },
            2,
            2,
          ),
        ],
        wallets[5]!,
      ),
      stateFor(
        [grant('verified_store', { kind: 'expired' }, 0, 0)],
        wallets[4]!,
      ),
      stateFor([], wallets[6]!),
    ];
    for (const state of samples) {
      const renderer = await render(<OfflineAllocationCard state={state} />);
      const badge = card(renderer).findAll(
        node => node.props.testID === `${CARD_TEST_ID}-status`,
      )[0];
      expect(badge).toBeDefined();
      expect(textOf(badge!).trim().length).toBeGreaterThan(0);
      for (const text of card(renderer).findAllByType(Text)) {
        expect(textOf(text).trim().length).toBeGreaterThan(0);
      }
      expectDossierCompliant(textOf(card(renderer)));
      await unmount();
    }
  });
});

describe('W05-04 attack — a live Pro lease beside a newer free generation', () => {
  it('states which allocation the ledger actually spends: the free ticket the newer generation hosts, not the Pro pass the card names first', async () => {
    await holdGrant(PRO_BESIDE_SECOND_GENERATION);
    await holdGrant(SECOND_GENERATION_GRANT);
    mockReading = AT_SECOND_GENERATION_ISSUE;
    const before = await ledgerTruth(AT_SECOND_GENERATION_ISSUE);
    expect(before.allocation.grants.map(g => g.execution.kind)).toEqual([
      'active',
      'active',
    ]);
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    const idle = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(idle).toContain('Pro pass');
    expect(idle).toContain('Free analyses');
    expect(idle).toContain('1 of 1 unspent');
    await unmount();

    const outcome = await spend('op-1', AT_SECOND_GENERATION_ISSUE);
    const after = await ledgerTruth(AT_SECOND_GENERATION_ISSUE);
    const again = await render(<AnalyzeScreen />);
    await settle();
    const spentCopy = textOf(card(again));
    expect(badgeOf(again)).toBe('READY');
    expect(spentCopy).toContain('1 result waiting');
    // Observed against 45e8ad41: the ledger orders grants by generation and
    // charges the free ticket even though a Pro lease is live. The card
    // names the Pro pass first, and after the spend it must at least state
    // that the free ticket is gone.
    expect(outcome.grant.grantId).toBe(SECOND_GENERATION_GRANT_ID);
    expect(outcome.grant.entitlementSource).toBe('identity_lifetime_free');
    expect(after.allocation.consumedTickets).toBe(1);
    expect(spentCopy).toContain('Pro pass');
    expect(spentCopy).toContain('0 of 1 unspent');
    expect(spentCopy).not.toContain('1 of 1 unspent');
    expectDossierCompliant(spentCopy);
  });
});
