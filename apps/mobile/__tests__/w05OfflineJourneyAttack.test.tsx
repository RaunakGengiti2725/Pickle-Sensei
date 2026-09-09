/**
 * W05-04 adversarial tests against candidate fda1aeff.
 *
 * Each `it` is one attack on a failure boundary of the offline journey card
 * as rendered by the shipping Analyze and Settings screens: mixed
 * entitlements, corrupt persisted state, interleaved account switches,
 * replayed operations, boundary clocks, transport failures at each step,
 * a process death mid-presentation, a foreground read that fails, follower
 * lifecycle across sign-out, and copy agreement across every presenter
 * state. Nothing here edits the candidate's production code or its own
 * tests; fixtures mirror the candidate suite so the two runs describe the
 * same wallet.
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
  type OfflineAllocationSnapshot,
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
const LAPSED_PRO_GRANT_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const LATER_PRO_GRANT_ID = 'bbbbbbbb-0000-4000-8000-000000000004';
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

/** Rendering artifacts that mean a number or a value was never formatted. */
const RENDER_ARTIFACTS = [
  /NaN/,
  /Infinity/,
  /undefined/,
  /\bnull\b/,
  /\[object/,
];

/** Count/noun disagreement anywhere in the copy. */
const PLURAL_DISAGREEMENT = [
  /\b1 (results|analyses|days|hours|minutes|held analyses|offline analyses)\b/,
  /\b(0|[2-9]|\d{2,}) (result|analysis|day|hour|minute)\b/,
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

/** A Pro lease issued two weeks before the free allocation and lapsed a week
 * before it (the candidate suite's own fixture). */
const LAPSED_PRO_GRANT: GrantShape = {
  entitlementSource: 'verified_store',
  grantId: LAPSED_PRO_GRANT_ID,
  issuedAt: ISSUED_AT - 14 * DAY_S,
  expiresAt: ISSUED_AT - 7 * DAY_S,
  entitlementExpiresAt: ISSUED_AT - 7 * DAY_S,
};

/** A Pro lease issued the day AFTER the free allocation: a free player who
 * subscribed while still holding free tickets. */
const LATER_PRO_GRANT: GrantShape = {
  entitlementSource: 'verified_store',
  grantId: LATER_PRO_GRANT_ID,
  issuedAt: ISSUED_AT + DAY_S,
  expiresAt: ISSUED_AT + 7 * DAY_S,
  entitlementExpiresAt: ISSUED_AT + 30 * DAY_S,
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

function expectCleanCopy(copy: string) {
  for (const pattern of FORBIDDEN_COPY) expect(copy).not.toMatch(pattern);
  for (const pattern of RENDER_ARTIFACTS) expect(copy).not.toMatch(pattern);
  for (const pattern of PLURAL_DISAGREEMENT) expect(copy).not.toMatch(pattern);
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

function mockFetch(implementation: typeof fetch) {
  fetchSpy?.mockRestore();
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(implementation);
}

async function presentAndLoseConnection() {
  mockFetch(async () => {
    throw new TypeError('Network request failed');
  });
  await expect(
    reconcileOfflineWallet(db, grantClient(), AT_ISSUE),
  ).rejects.toThrow('Network request failed');
}

/** The server answers the whole batch with one HTTP response: `status` and
 * `headers` as given, `body` as given. */
async function presentAndGetResponse(
  status: number,
  body: string,
  headers: Record<string, string>,
) {
  mockFetch(async () => new Response(body, { status, headers }));
  return reconcileOfflineWallet(db, grantClient(), AT_ISSUE);
}

/** Every presented receipt gets `status`; `rejectedCode` moves them all to
 * the refusal list instead. */
async function presentAndReceive(status: string, rejectedCode?: string) {
  mockFetch(async (input, init) => {
    if (String(input) !== RECEIPTS_ROUTE) {
      return new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      receipts?: Array<{ receiptId: string }>;
    };
    const presented = body.receipts ?? [];
    return new Response(
      JSON.stringify(
        rejectedCode === undefined
          ? {
              receipts: presented.map(receipt => ({
                receiptId: receipt.receiptId,
                status,
              })),
              rejected: [],
            }
          : {
              receipts: [],
              rejected: presented.map(receipt => ({
                receiptId: receipt.receiptId,
                code: rejectedCode,
              })),
            },
      ),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
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

function writes(): string[] {
  return handle.calls
    .filter(call => WRITE_STATEMENT.test(call.sql))
    .map(call => call.sql);
}

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

function signOut() {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  clearApiSession();
  useAuthStore.setState({ session: null });
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
  jest.useRealTimers();
  closeSqliteTestDatabases();
});

describe('ATTACK W05-04: mixed entitlements', () => {
  it('A1 a lapsed Pro lease must not hide the expired free allocation this phone still holds', async () => {
    await holdGrant(LAPSED_PRO_GRANT);
    await holdGrant(FREE_GRANT);
    mockReading = AFTER_EXPIRY;
    const truth = await ledgerTruth(AFTER_EXPIRY);
    // Ledger fact: two free tickets are still allocated to this phone; both
    // grants are expired under trusted time.
    expect(truth.allocation.spendableTickets).toBe(2);
    expect(truth.allocation.grants.map(grant => grant.execution.kind)).toEqual([
      'expired',
      'expired',
    ]);

    // Control: the same wallet WITHOUT the lapsed Pro row.
    const control = presentOfflineJourney({
      kind: 'read',
      allocation: {
        ...truth.allocation,
        grants: truth.allocation.grants.filter(
          grant => grant.entitlementSource === 'identity_lifetime_free',
        ),
      },
      wallet: truth.wallet,
    });
    const controlCopy = [
      control.title,
      ...control.rows.map(row => `${row.label} ${row.value}`),
      ...control.notes,
    ].join(' | ');
    expect(controlCopy).toContain('2 of 2 unspent');
    expect(controlCopy).toContain('stay allocated');

    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('EXPIRED');
    expectCleanCopy(copy);
    // Adding a lapsed Pro row must not delete the allocation facts.
    expect(copy).toContain('2 of 2 unspent');
    expect(copy).toContain('stay allocated');
    expect(copy).not.toContain('Pro pass');
  });

  it('A2 an unconfirmed Pro lease issued after the free allocation must not hide the held free tickets', async () => {
    await holdGrant(FREE_GRANT);
    await holdGrant(LATER_PRO_GRANT);
    mockReading = NO_TRUSTED_TIME;
    const truth = await ledgerTruth(NO_TRUSTED_TIME);
    expect(truth.allocation.spendableTickets).toBe(2);
    expect(truth.allocation.grants.map(grant => grant.execution.kind)).toEqual([
      'reconcile_required',
      'reconcile_required',
    ]);

    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('CONFIRM ONLINE');
    expectCleanCopy(copy);
    expect(copy).toContain('2 of 2 unspent');
    expect(copy).toContain('stay allocated');
  });

  it('A3 a live Pro lease beside a live free allocation states the free tickets it still holds', async () => {
    await holdGrant(FREE_GRANT);
    await holdGrant(LATER_PRO_GRANT);
    mockReading = anchored((ISSUED_AT + 2 * DAY_S) * 1000);
    const truth = await ledgerTruth(mockReading);
    expect(truth.allocation.spendableTickets).toBe(2);
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expectCleanCopy(copy);
    // The live Pro lease governs the verdict; the card must state it as a
    // Pro pass and never claim its results stay allocated.
    expect(copy).toContain('Pro offline pass active');
    expect(copy).toContain('In 5 days');
    expect(copy).not.toContain('stay allocated');
    expect(copy).not.toContain('never taken back');
  });
});

describe('ATTACK W05-04: corrupt and partial persisted state', () => {
  async function insertInFlightJournal(receiptIds: readonly string[]) {
    await db.execute(
      `INSERT INTO offline_wallet_journal
         (owner_key, journal_id, kind, receipt_ids, state, opened_at, closed_at, verdicts)
       VALUES (?, ?, 'receipt_submission', ?, 'in_flight', ?, NULL, NULL)`,
      [
        OWNER,
        'dddddddd-0000-4000-8000-000000000009',
        JSON.stringify(receiptIds),
        new Date(ISSUED_AT * 1000).toISOString(),
      ],
    );
  }

  it('A4 an in-flight journal entry naming a receipt that IS on file (already accepted) must not be described as "never recorded on this phone"', async () => {
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
    await insertInFlightJournal([receiptId]);
    const truth = await ledgerTruth();
    expect(truth.wallet.hold).toBe(true);
    expect(truth.wallet.pending).toHaveLength(0);

    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expectCleanCopy(copy);
    // The receipt is recorded on this phone, settled as accepted. Copy that
    // says it "was never recorded" states something the ledger contradicts.
    expect(copy).not.toContain('never recorded on this phone');
  });

  it('A5 a corrupt ticket row makes the card UNAVAILABLE, writes nothing, and recovers on the retry cadence once storage is readable again', async () => {
    jest.useFakeTimers();
    await holdGrant();
    await spend('op-1');
    // Corruption: a consumed ticket that names no receipt.
    await db.execute(
      `UPDATE offline_ticket SET receipt_id = NULL
       WHERE owner_key = ? AND state = 'consumed'`,
      [OWNER],
    );
    await expect(readOfflineAllocation(db, AT_ISSUE)).rejects.toThrow();
    handle.calls.length = 0;
    const renderer = await render(<AnalyzeScreen />);
    await settleFake();
    expect(badgeOf(renderer)).toBe('UNAVAILABLE');
    const copy = textOf(card(renderer));
    expectCleanCopy(copy);
    expect(copy).not.toMatch(/\d of \d/);
    expect(copy).not.toContain('READY');
    expect(writes()).toEqual([]);

    // Storage becomes readable again (the receipt reference is restored).
    const receipt = await db.execute(
      `SELECT receipt_id FROM offline_receipt WHERE owner_key = ?`,
      [OWNER],
    );
    await db.execute(
      `UPDATE offline_ticket SET receipt_id = ?
       WHERE owner_key = ? AND state = 'consumed'`,
      [String(receipt.rows[0]?.['receipt_id']), OWNER],
    );
    handle.calls.length = 0;
    await advance(PENDING_RECEIPT_READ_CADENCE_MS);
    expect(badgeOf(renderer)).toBe('READY');
    expect(textOf(card(renderer))).toContain('1 of 2');
    expect(writes()).toEqual([]);
  });

  it('A6 a HOLD whose grants were purged (receipts only) keeps count and noun in agreement', async () => {
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
    expectCleanCopy(copy);
    // Two results are on hold: no sentence may speak of "the spent analysis"
    // as if there were one.
    expect(copy).not.toContain('The spent analysis');
  });
});

describe('ATTACK W05-04: account switching and replay', () => {
  it('A7 a HOLD never crosses accounts and comes back for its owner after a round trip', async () => {
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const renderer = await render(<SettingsScreen />);
    await settle();
    expect(badgeOf(renderer)).toBe('ON HOLD');

    await act(async () => {
      signInAs(OTHER_OWNER, 'token-2');
    });
    await settle();
    expect(badgeOf(renderer)).toBe('NONE HELD');
    const otherCopy = textOf(card(renderer));
    expect(otherCopy).not.toMatch(/on hold|ON HOLD/);
    expect(otherCopy).not.toContain('awaiting');
    expect(otherCopy).not.toContain('no confirmed answer');
    expect(otherCopy).not.toMatch(/\d of \d/);

    await act(async () => {
      signInAs(OWNER, 'token-3');
    });
    await settle();
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(textOf(card(renderer))).toContain('1 on hold');
  });

  it('A8 an interleaved switch A → B → A(regenerated) while A’s first read is stalled never shows B’s ledger to A nor A’s stale read', async () => {
    await holdGrant();
    await spend('op-1');
    const gated = gateFirstTransaction();
    mockDb = () => gated.db;
    const renderer = await render(<SettingsScreen />);
    await settle();
    expect(badgeOf(renderer)).toBe('CHECKING');
    mockDb = () => db;

    await act(async () => {
      signInAs(OTHER_OWNER, 'token-2');
    });
    await settle();
    expect(badgeOf(renderer)).toBe('NONE HELD');

    // Back to A under a new owner generation; a spend happened meanwhile.
    setActiveDataOwner(OWNER);
    await spend('op-2');
    await act(async () => {
      signInAs(OWNER, 'token-3');
    });
    await settle();
    expect(badgeOf(renderer)).toBe('SPENT');
    expect(textOf(card(renderer))).toContain('0 of 2');

    // A's very first read resumes and finishes last. It must be discarded.
    gated.release();
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('SPENT');
    expect(copy).toContain('0 of 2');
    expect(copy).not.toContain('1 of 2');
    expect(copy).not.toContain('No offline pass');
  });

  it('A9 a replayed operation id never consumes a second ticket or queues a second receipt', async () => {
    await holdGrant();
    const first = await spend('op-1');
    const replay = await spend('op-1');
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.receipt.receiptId).toBe(first.receipt.receiptId);
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('1 of 2');
    expect(copy).toContain('1 result waiting');
    expect(copy).not.toContain('2 results');
    expectCleanCopy(copy);
  });
});

describe('ATTACK W05-04: boundary clocks', () => {
  const READINGS: Array<[string, TrustedTimeReading]> = [
    ['NaN now', anchored(Number.NaN)],
    ['negative now', anchored(-1)],
    ['zero now', anchored(0)],
    ['far past', anchored((ISSUED_AT - 365 * DAY_S) * 1000)],
    ['far future', anchored(Number.MAX_SAFE_INTEGER)],
    ['+Infinity now', anchored(Number.POSITIVE_INFINITY)],
    ['-Infinity now', anchored(Number.NEGATIVE_INFINITY)],
    ['one ms before expiry', anchored(EXPIRES_AT * 1000 - 1)],
    ['exactly at expiry', anchored(EXPIRES_AT * 1000)],
  ];

  for (const [label, reading] of READINGS) {
    it(`A10 never renders READY, an artifact, or a spinning timer under a ${label} reading`, async () => {
      jest.useFakeTimers();
      await holdGrant();
      mockReading = reading;
      const renderer = await render(<SettingsScreen />);
      await settleFake();
      const copy = textOf(card(renderer));
      const badge = badgeOf(renderer);
      expectCleanCopy(copy);
      const liveMs = reading.nowMs;
      const genuinelyLive =
        Number.isFinite(liveMs) &&
        liveMs >= ISSUED_AT * 1000 &&
        liveMs < EXPIRES_AT * 1000;
      if (!genuinelyLive) {
        expect(badge).not.toBe('READY');
        expect(copy).not.toContain('ready');
      }
      // Whatever the verdict, the follow-up cadence never drops under its
      // 1 s floor: at most one read transaction per second over one
      // held-pass cadence, and never a write.
      handle.calls.length = 0;
      await advance(HELD_PASS_READ_CADENCE_MS);
      const transactions = handle.calls.filter(
        call => call.sql === 'BEGIN IMMEDIATE',
      ).length;
      expect(transactions).toBeLessThanOrEqual(
        HELD_PASS_READ_CADENCE_MS / 1000 + 1,
      );
      expect(ledgerReads()).toBeGreaterThan(0);
      expect(writes()).toEqual([]);
    });
  }
});

describe('ATTACK W05-04: transport failures at each presentation step', () => {
  it('A11 a redirect answer (captive portal) leaves an honest HOLD with no dropped-connection claim', async () => {
    await holdGrant();
    await spend('op-1');
    await expect(
      presentAndGetResponse(302, '', {
        location: 'https://portal.example/login',
      }),
    ).rejects.toThrow();
    const truth = await ledgerTruth();
    expect(truth.wallet.hold).toBe(true);
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(copy).toContain('1 on hold');
    expect(copy).toContain('no confirmed answer');
    expect(copy).not.toContain('connection dropped');
    expect(copy).not.toContain('never arrived');
    expectCleanCopy(copy);
  });

  it('A12 a 503 outage and a 200 with an unparseable body both leave an honest HOLD', async () => {
    await holdGrant();
    await spend('op-1');
    await expect(
      presentAndGetResponse(503, '<html>maintenance</html>', {
        'content-type': 'text/html',
        'retry-after': '120',
      }),
    ).rejects.toThrow();
    expect((await ledgerTruth()).wallet.hold).toBe(true);
    // A later drain re-presents the SAME receipt and gets a 200 that names
    // nothing: still no verdict.
    await expect(
      presentAndGetResponse(200, JSON.stringify({ receipts: 'yes' }), {
        'content-type': 'application/json',
      }),
    ).rejects.toThrow();
    const truth = await ledgerTruth();
    expect(truth.wallet.hold).toBe(true);
    expect(truth.wallet.unansweredPresentations).toBe(1);
    expect(truth.wallet.pending[0]?.presentations).toBe(2);
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(copy).toContain('1 on hold');
    expect(copy).not.toContain('2 on hold');
    expectCleanCopy(copy);
  });

  it('A13 a refusal (unused_ticket_returned) is terminal: nothing waits, nothing is on hold, and the ticket count is the ledger’s', async () => {
    await holdGrant();
    await spend('op-1');
    const outcome = await presentAndReceive('unused_ticket_returned');
    expect(outcome.refused).toBe(1);
    const truth = await ledgerTruth();
    expect(truth.pending).toHaveLength(0);
    expect(truth.wallet.hold).toBe(false);
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain(
      `${truth.allocation.spendableTickets} of ${
        truth.allocation.spendableTickets + truth.allocation.consumedTickets
      }`,
    );
    expect(copy).toContain('Nothing');
    expect(copy).not.toContain('on hold');
    expect(copy).not.toContain('waiting');
    expectCleanCopy(copy);
  });

  it('A14 a refusal via the rejected list is terminal too and never counted as waiting', async () => {
    await holdGrant();
    await spend('op-1');
    const outcome = await presentAndReceive('ignored', 'receipt_unknown');
    expect(outcome.refused).toBe(1);
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(copy).toContain('Nothing');
    expect(copy).not.toContain('waiting');
    expect(copy).not.toContain('on hold');
    expectCleanCopy(copy);
  });
});

describe('ATTACK W05-04: process death, foreground failure and follower lifecycle', () => {
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
    AppState.currentState = originalAppState;
    jest.restoreAllMocks();
  });

  it('A15 the process dies while a presentation is outstanding: the relaunched Analyze surface states the HOLD and writes nothing', async () => {
    jest.useFakeTimers();
    await holdGrant();
    await spend('op-1');
    // The request leaves the phone and the process dies before any answer:
    // the fetch does not settle while the relaunched surface reads.
    let dropConnection: () => void = () => undefined;
    mockFetch(
      () =>
        new Promise<Response>((_resolve, reject) => {
          dropConnection = () =>
            reject(new TypeError('Network request failed'));
        }),
    );
    const drain = reconcileOfflineWallet(db, grantClient(), AT_ISSUE);
    await settleFake();
    const truth = await ledgerTruth();
    expect(truth.wallet.hold).toBe(true);
    expect(truth.wallet.pending[0]?.phase).toBe('presented_unanswered');
    handle.calls.length = 0;
    const renderer = await render(<AnalyzeScreen />);
    await settleFake();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(copy).toContain('1 on hold');
    expect(copy).toContain('1 of 2');
    expect(writes()).toEqual([]);
    expectCleanCopy(copy);
    // Release the module-level presentation queue for the tests that follow.
    dropConnection();
    await expect(drain).rejects.toThrow('Network request failed');
  });

  it('A16 a foreground (announced) read that fails once shows UNAVAILABLE honestly and recovers the HOLD on the retry cadence', async () => {
    jest.useFakeTimers();
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const renderer = await render(<AnalyzeScreen />);
    await settleFake();
    expect(badgeOf(renderer)).toBe('ON HOLD');
    background();
    handle.failStatementOnce('FROM offline_grant');
    await act(async () => {
      foreground();
    });
    await settleFake();
    expect(badgeOf(renderer)).toBe('UNAVAILABLE');
    expect(textOf(card(renderer))).not.toContain('on hold');
    await advance(PENDING_RECEIPT_READ_CADENCE_MS);
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(textOf(card(renderer))).toContain('1 on hold');
  });

  it('A17 signing out while Settings stays mounted stops every follow-up read; a new sign-in resumes them', async () => {
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
    expect(cards(renderer)).toHaveLength(0);
    handle.calls.length = 0;
    await advance(4 * PENDING_RECEIPT_READ_CADENCE_MS);
    expect(ledgerReads()).toBe(0);
    await act(async () => {
      signInAs(OWNER, 'token-2');
    });
    await settleFake();
    expect(badgeOf(renderer)).toBe('ON HOLD');
    handle.calls.length = 0;
    await advance(PENDING_RECEIPT_READ_CADENCE_MS);
    expect(ledgerReads()).toBeGreaterThan(0);
    expect(writes()).toEqual([]);
  });

  it('A18 two surfaces mounted at once: unmounting one keeps the other following the ledger', async () => {
    jest.useFakeTimers();
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const analyze = await render(<AnalyzeScreen />);
    await settleFake();
    let settings!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      settings = TestRenderer.create(<SettingsScreen />);
    });
    await settleFake();
    expect(badgeOf(analyze)).toBe('ON HOLD');
    expect(badgeOf(settings)).toBe('ON HOLD');
    await act(async () => settings.unmount());
    await settleFake();
    const outcome = await presentAndReceive('result_recorded');
    expect(outcome.accepted).toBe(1);
    await advance(PENDING_RECEIPT_READ_CADENCE_MS);
    expect(badgeOf(analyze)).toBe('READY');
    expect(textOf(card(analyze))).toContain('Nothing');
  });
});

describe('ATTACK W05-04: presenter copy across every state', () => {
  function grant(
    entitlementSource: HeldOfflineGrantView['entitlementSource'],
    execution: TrustedTimeLeaseVerdict,
    remaining: number,
    consumed: number,
    grantId = GRANT_ID,
  ): HeldOfflineGrantView {
    const free = entitlementSource === 'identity_lifetime_free';
    return {
      grantId,
      generation: 1,
      entitlementSource,
      installationKeyId: INSTALLATION_KEY,
      keyId: KEY_ID,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      entitlementExpiresAt: free ? null : EXPIRES_AT,
      grantJwsSha256: 'f'.repeat(64),
      allocated: free ? remaining + consumed : 0,
      remaining: free ? remaining : 0,
      consumed: free ? consumed : 0,
      lifecycleSequence: free ? consumed : 0,
      execution,
    };
  }

  function allocation(
    grants: readonly HeldOfflineGrantView[],
  ): OfflineAllocationSnapshot {
    let spendable = 0;
    let consumed = 0;
    for (const held of grants) {
      spendable += held.remaining;
      consumed += held.consumed;
    }
    return {
      grants,
      spendableTickets: spendable,
      consumedTickets: consumed,
      pendingReceipts: consumed,
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

  function wallet(
    pending: readonly OfflineWalletPendingReceipt[],
    unidentified = false,
  ): OfflineWalletStatus {
    const unanswered =
      pending.filter(item => item.phase === 'presented_unanswered').length +
      (unidentified ? 1 : 0);
    return {
      pending,
      unansweredPresentations: unanswered,
      hold: unanswered > 0,
    };
  }

  const VERDICTS: TrustedTimeLeaseVerdict[] = [
    { kind: 'active', remainingMs: 6 * DAY_S * 1000 },
    { kind: 'active', remainingMs: 1 },
    { kind: 'active', remainingMs: 0 },
    { kind: 'active', remainingMs: Number.NaN },
    { kind: 'active', remainingMs: Number.POSITIVE_INFINITY },
    { kind: 'active', remainingMs: -5 },
    { kind: 'expired' },
    { kind: 'reconcile_required', reason: 'no_trusted_time' },
    { kind: 'reconcile_required', reason: 'storage_invalid' },
    { kind: 'reconcile_required', reason: 'clock_rollback' },
    { kind: 'reconcile_required', reason: 'floor_only' },
    { kind: 'reconcile_required', reason: 'elapsed_unmeasured' },
    { kind: 'reconcile_required', reason: 'invalid_lease' },
    { kind: 'reconcile_required', reason: 'lease_ahead_of_clock' },
  ];

  const PENDING_SETS: Array<readonly OfflineWalletPendingReceipt[]> = [
    [],
    [receipt(1, 'queued')],
    [receipt(1, 'queued'), receipt(2, 'queued')],
    [receipt(1, 'presented_unanswered')],
    [receipt(1, 'presented_unanswered'), receipt(2, 'presented_unanswered')],
    [receipt(1, 'held')],
    [receipt(1, 'held'), receipt(2, 'held')],
    [receipt(1, 'queued'), receipt(2, 'presented_unanswered')],
    [receipt(1, 'held'), receipt(2, 'presented_unanswered')],
  ];

  function copyOf(state: OfflineJourneyState): string {
    const view = presentOfflineJourney(state);
    return [
      view.badge,
      view.title,
      ...view.rows.map(row => `${row.label} ${row.value}`),
      ...view.notes,
    ].join(' | ');
  }

  it('A19 every combination of verdict, entitlement, counts, pending phases and unidentified hold renders agreeing, artifact-free, dossier-compliant copy', () => {
    const offenders: string[] = [];
    const check = (label: string, state: OfflineJourneyState) => {
      const copy = copyOf(state);
      for (const pattern of [
        ...FORBIDDEN_COPY,
        ...RENDER_ARTIFACTS,
        ...PLURAL_DISAGREEMENT,
      ]) {
        if (pattern.test(copy)) offenders.push(`${label} :: ${copy}`);
      }
    };
    for (const verdict of VERDICTS) {
      for (const [remaining, consumed] of [
        [2, 0],
        [1, 1],
        [0, 2],
        [1, 0],
        [0, 1],
      ] as const) {
        for (const pending of PENDING_SETS) {
          if (pending.length > consumed) continue;
          for (const unidentified of [false, true]) {
            const label = `${JSON.stringify(verdict)} free ${remaining}/${consumed} pending=${pending
              .map(item => item.phase)
              .join(',')} unidentified=${unidentified}`;
            check(label, {
              kind: 'read',
              allocation: allocation([
                grant('identity_lifetime_free', verdict, remaining, consumed),
              ]),
              wallet: wallet(pending, unidentified),
            });
            check(`${label} +pro`, {
              kind: 'read',
              allocation: allocation([
                grant('verified_store', verdict, 0, 0, LATER_PRO_GRANT_ID),
                grant('identity_lifetime_free', verdict, remaining, consumed),
              ]),
              wallet: wallet(pending, unidentified),
            });
          }
        }
      }
    }
    for (const pending of PENDING_SETS) {
      for (const unidentified of [false, true]) {
        check(
          `no grants pending=${pending.map(item => item.phase).join(',')} unidentified=${unidentified}`,
          {
            kind: 'read',
            allocation: allocation([]),
            wallet: wallet(pending, unidentified),
          },
        );
      }
    }
    check('loading', { kind: 'loading' });
    check('unavailable', { kind: 'unavailable' });
    expect(offenders).toEqual([]);
  });
});
