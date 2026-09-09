/**
 * W05-04 adversarial suite against candidate 9197068573ea69216f54e0d7f57b3d9e40f33811.
 *
 * Every test here drives the SHIPPING surfaces (`AnalyzeScreen`,
 * `SettingsScreen`) through the real wallet, journal, ledger and API
 * transport, exactly like the candidate's own `w05OfflineJourney.test.tsx`
 * (whose harness is reproduced here unchanged so the two suites see the
 * same world). The candidate's production code and tests are not touched.
 *
 * Attacks (one `describe` each):
 *  A1 trusted time is confirmed while the surface stays focused (floor →
 *     anchored): the pass becomes executable and the card must say so.
 *  A2 a clock rollback is detected while READY is on screen: the ledger
 *     refuses to execute and the card must stop saying READY.
 *  A3 one transient ledger read failure during the watch: the card must
 *     recover once the ledger is readable again (and never write).
 *  A4 network failure at the presentation step — timeout, 429 + Retry-After,
 *     503, redirect: HOLD, never a double charge, exactly one settlement once
 *     the server finally answers.
 *  A5 double submit: two drains racing on one owner while the card watches.
 *  A6 interleaved account switch INSIDE the card's ledger transaction.
 *  A7 free-rating conservation: a partial answer settles nothing; a replayed
 *     verdict charges nothing.
 *  A8 a ticket left behind in an expired generation: the card must not call
 *     it a ready analysis when the ledger refuses to spend it.
 *  A9 process death and relaunch with an in-flight journal on disk.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { OFFLINE_JOURNEY_SYNC_WATCH_MS } from '../src/components/OfflineAllocationCard';
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
  API_REQUEST_TIMEOUT_MS,
  ApiError,
  createOfflineGrantClient,
  parseIssuedOfflineGrant,
  type IssuedOfflineGrant,
} from '../src/data/api';
import {
  consumeOfflineAllocation,
  holdOfflineGrant,
  pendingOfflineReceipts,
  readOfflineAllocation,
} from '../src/data/offlineCapabilities';
import {
  readOfflineWalletStatus,
  reconcileOfflineWallet,
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
const RESULT_SHA = 'c'.repeat(64);
const BINDING = { installationKeyId: INSTALLATION_KEY, issuer: ISSUER };
const CARD_TEST_ID = 'offline-allocation-card';

function base64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

interface GrantShape {
  readonly grantId: string;
  readonly generation: number;
  readonly ticketIds: readonly string[];
  readonly issuedAt: number;
  readonly expiresAt: number;
}

const FREE_GRANT: GrantShape = {
  grantId: GRANT_ID,
  generation: 1,
  ticketIds: TICKETS,
  issuedAt: ISSUED_AT,
  expiresAt: EXPIRES_AT,
};

/** The server's next generation for this installation, issued a day after
 * generation 1 lapsed: it restates only the ticket still outstanding
 * server-side (`issue_offline_grant` collects `v_outstanding` minus every
 * ticket with a terminal `consumed` / `released` event — a support release or
 * a recovered sibling's spend takes a ticket out of the restatement). */
const SECOND_GENERATION_ISSUED_AT = EXPIRES_AT + DAY_S;
const SECOND_GENERATION_GRANT: GrantShape = {
  grantId: SECOND_GENERATION_GRANT_ID,
  generation: 2,
  ticketIds: [TICKETS[1]],
  issuedAt: SECOND_GENERATION_ISSUED_AT,
  expiresAt: SECOND_GENERATION_ISSUED_AT + SIX_DAYS_S,
};

function grantResponse(shape: GrantShape): Record<string, unknown> {
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
    entitlementSource: 'identity_lifetime_free',
    allocation: {
      schemaVersion: OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION,
      allocationId: shape.grantId,
      generation: shape.generation,
      ticketIds: shape.ticketIds,
      budgetPolicy: OFFLINE_FREE_ALLOCATION_POLICY.id,
      financialExpiry: 'reconciliation_only',
    },
  };
  const header = { alg: 'ES256', typ: OFFLINE_GRANT_JWS_TYPE, kid: KEY_ID };
  const compactJws = `${base64Url(JSON.stringify(header))}.${base64Url(
    JSON.stringify(claims),
  )}.${'A'.repeat(86)}`;
  return {
    grantId: shape.grantId,
    generation: shape.generation,
    entitlementSource: 'identity_lifetime_free',
    issuedAt: shape.issuedAt,
    expiresAt: shape.expiresAt,
    entitlementExpiresAt: null,
    ticketIds: shape.ticketIds,
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

function card(renderer: TestRenderer.ReactTestRenderer) {
  const found = renderer.root.findAll(
    node => node.props.testID === CARD_TEST_ID,
  );
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

async function holdGrant(shape: GrantShape = FREE_GRANT) {
  await holdOfflineGrant(db, issuedGrant(shape), BINDING);
}

async function spend(operationId: string, reading = AT_ISSUE) {
  return consumeOfflineAllocation(db, consumption(operationId), reading);
}

function grantClient() {
  return createOfflineGrantClient({ baseUrl: ISSUER, token: 'access-token' });
}

function drain(reading = AT_ISSUE) {
  return reconcileOfflineWallet(db, grantClient(), reading);
}

function ledgerReads() {
  return handle.calls.filter(call => /FROM offline_/.test(call.sql));
}

const WRITE_STATEMENT =
  /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i;

function ledgerWrites() {
  return handle.calls.filter(call => WRITE_STATEMENT.test(call.sql));
}

async function ledgerTruth(reading = mockReading ?? AT_ISSUE) {
  return {
    allocation: await readOfflineAllocation(db, reading),
    wallet: await readOfflineWalletStatus(db),
    pending: await pendingOfflineReceipts(db),
  };
}

function receiptsIn(init: RequestInit | undefined): string[] {
  const body = JSON.parse(String(init?.body ?? '{}')) as {
    receipts?: Array<{ receiptId: string }>;
  };
  return (body.receipts ?? []).map(receipt => receipt.receiptId);
}

function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function verdictsFor(receiptIds: readonly string[], status: string): Response {
  return jsonResponse(
    {
      receipts: receiptIds.map(receiptId => ({ receiptId, status })),
      rejected: [],
    },
    200,
  );
}

/** The receipts route answers with `respond(receiptIds, init)`; everything
 * else is a 404. Records every presentation it saw. */
function serveReceipts(
  respond: (
    receiptIds: string[],
    init: RequestInit | undefined,
  ) => Promise<Response> | Response,
): { presentations: string[][] } {
  const presentations: string[][] = [];
  fetchSpy?.mockRestore();
  fetchSpy = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      if (String(input) !== RECEIPTS_ROUTE) {
        return jsonResponse({ error: 'not_found' }, 404);
      }
      const receiptIds = receiptsIn(init);
      presentations.push(receiptIds);
      return respond(receiptIds, init);
    });
  return { presentations };
}

function answerWhenReleased(status: string): {
  release(): void;
  presentations: string[][];
} {
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const served = serveReceipts(async receiptIds => {
    await gate;
    return verdictsFor(receiptIds, status);
  });
  return { release: () => release(), presentations: served.presentations };
}

async function presentAndLoseConnection() {
  fetchSpy?.mockRestore();
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new TypeError('Network request failed');
  });
  await expect(drain()).rejects.toThrow('Network request failed');
}

/** Every transaction opened before `release()` waits for it — the card's
 * read is stalled at the moment it enters its transaction. */
function gateTransactionsUntilReleased(): { db: LocalDb; release(): void } {
  const inner = db;
  let release: () => void = () => undefined;
  let gate: Promise<void> | null = new Promise<void>(resolve => {
    release = () => {
      gate = null;
      resolve();
    };
  });
  const innerTransaction = inner.transaction;
  if (!innerTransaction) throw new Error('test db has no transaction');
  return {
    db: {
      execute: (sql, params) => inner.execute(sql, params),
      transaction: async <T,>(
        operation: (transaction: LocalDb) => Promise<T>,
      ): Promise<T> => {
        if (gate) await gate;
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

function useDatabase(next: ReturnType<typeof createSqliteTestDb>) {
  handle = next;
  db = next.db;
  mockDb = () => db;
}

beforeEach(() => {
  useDatabase(createSqliteTestDb());
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
  signInAs(OWNER, 'token-1');
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

describe('A1 — trusted time is confirmed while the surface stays focused', () => {
  /** The phone launched before any authenticated response anchored the
   * clock (floor only), so the card asks for an online check. Then a request
   * anywhere in the app is answered and the clock anchors: the ledger now
   * executes the pass. Nothing else happens — no foreground transition, no
   * navigation — while the player keeps looking at the card. */
  async function confirmTimeWhileFocused(element: React.ReactElement) {
    jest.useFakeTimers();
    await holdGrant();
    mockReading = FLOOR_ONLY;
    const renderer = await render(element);
    await elapse(0);
    expect(badgeOf(renderer)).toBe('CONFIRM ONLINE');
    expect(textOf(card(renderer))).toContain('needs an online check');

    mockReading = AT_ISSUE;
    const truth = await ledgerTruth();
    expect(truth.allocation.grants[0]?.execution.kind).toBe('active');

    await elapse(OFFLINE_JOURNEY_SYNC_WATCH_MS * 12);
    const copy = textOf(card(renderer));
    expect(copy).not.toContain('needs an online check');
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('In 6 days');
  }

  it('Settings stops asking for an online check once the clock is anchored and the ledger executes the pass', async () => {
    await confirmTimeWhileFocused(<SettingsScreen />);
  });

  it('Analyze stops asking for an online check once the clock is anchored and the ledger executes the pass', async () => {
    await confirmTimeWhileFocused(<AnalyzeScreen />);
  });
});

describe('A2 — a clock rollback is detected while READY is on screen', () => {
  it('Analyze stops calling the pass READY once the ledger refuses to execute it', async () => {
    jest.useFakeTimers();
    await holdGrant();
    const renderer = await render(<AnalyzeScreen />);
    await elapse(0);
    expect(badgeOf(renderer)).toBe('READY');

    mockReading = ROLLED_BACK;
    const truth = await ledgerTruth();
    expect(truth.allocation.grants[0]?.execution).toEqual({
      kind: 'reconcile_required',
      reason: 'clock_rollback',
    });
    await expect(spend('probe', ROLLED_BACK)).rejects.toMatchObject({
      code: 'offline.time_reconcile_required',
    });

    await elapse(OFFLINE_JOURNEY_SYNC_WATCH_MS * 12);
    expect(badgeOf(renderer)).not.toBe('READY');
    expect(textOf(card(renderer))).toContain('moved backwards');
  });
});

describe('A3 — one transient ledger read failure during the watch', () => {
  it('Analyze recovers from a single failed re-read once the ledger is readable again', async () => {
    jest.useFakeTimers();
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const renderer = await render(<AnalyzeScreen />);
    await elapse(0);
    expect(badgeOf(renderer)).toBe('ON HOLD');

    // The next scheduled read hits a busy database exactly once.
    handle.failStatementOnce(
      'FROM offline_grant',
      new Error('[op-sqlite] database is locked (SQLITE_BUSY)'),
    );
    await elapse(OFFLINE_JOURNEY_SYNC_WATCH_MS);
    expect(badgeOf(renderer)).toBe('UNAVAILABLE');

    // The drain resolves the HOLD on its own timer; the ledger is readable.
    const answer = answerWhenReleased('result_recorded');
    answer.release();
    await act(async () => {
      expect((await drain()).accepted).toBe(1);
    });
    const truth = await ledgerTruth();
    expect(truth.wallet.hold).toBe(false);
    expect(truth.pending).toHaveLength(0);

    handle.calls.length = 0;
    await elapse(OFFLINE_JOURNEY_SYNC_WATCH_MS * 12);
    expect(ledgerWrites()).toEqual([]);
    expect(ledgerReads()).not.toEqual([]);
    expect(badgeOf(renderer)).toBe('READY');
  });
});

describe('A4 — network failure at the presentation step', () => {
  interface NetworkFault {
    readonly name: string;
    readonly respond: (init: RequestInit | undefined) => Promise<Response>;
    readonly advanceMs: number;
    readonly expected: { status: number } | { code: string };
  }

  const RATE_LIMITED = {
    error: { code: 'rate_limited', message: 'Too many requests.' },
  };
  const UNAVAILABLE = {
    error: { code: 'unavailable', message: 'Service unavailable.' },
  };

  const FAULTS: readonly NetworkFault[] = [
    {
      name: '429 with Retry-After',
      respond: async () =>
        jsonResponse(RATE_LIMITED, 429, { 'retry-after': '30' }),
      advanceMs: 0,
      expected: { status: 429 },
    },
    {
      name: '503',
      respond: async () => jsonResponse(UNAVAILABLE, 503),
      advanceMs: 0,
      expected: { status: 503 },
    },
    {
      name: 'redirect to a captive portal',
      respond: async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://portal.example/login' },
        }),
      advanceMs: 0,
      expected: { code: 'network.redirected' },
    },
    {
      name: 'timeout',
      respond: init =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(
              new DOMException('The operation was aborted.', 'AbortError'),
            ),
          );
        }),
      advanceMs: API_REQUEST_TIMEOUT_MS,
      expected: { code: 'network.timeout' },
    },
  ];

  for (const fault of FAULTS) {
    it(`${fault.name}: HOLD on screen, no refund, then exactly one settlement once the server answers`, async () => {
      jest.useFakeTimers();
      await holdGrant();
      const spent = await spend('op-1');
      const receiptId = spent.receipt.receiptId;
      const renderer = await render(<AnalyzeScreen />);
      await elapse(0);
      expect(badgeOf(renderer)).toBe('READY');
      expect(textOf(card(renderer))).toContain('1 result waiting');

      const faulty = serveReceipts((_, init) => fault.respond(init));
      const attempt = drain();
      const outcome = attempt.then(
        () => 'resolved' as const,
        (error: unknown) => error,
      );
      await elapse(fault.advanceMs);
      const error = await outcome;
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject(fault.expected);
      expect(faulty.presentations).toEqual([[receiptId]]);

      let truth = await ledgerTruth();
      expect(truth.wallet.hold).toBe(true);
      expect(truth.pending).toHaveLength(1);
      expect(truth.allocation.spendableTickets).toBe(1);
      expect(truth.allocation.consumedTickets).toBe(1);

      await elapse(OFFLINE_JOURNEY_SYNC_WATCH_MS);
      let copy = textOf(card(renderer));
      expect(badgeOf(renderer)).toBe('ON HOLD');
      expect(copy).toContain('1 on hold');
      expect(copy).toContain('1 of 2');
      expect(copy).toContain('nothing is charged twice');

      // The server finally answers: the SAME receipt, one settlement.
      const answered = serveReceipts(receiptIds =>
        verdictsFor(receiptIds, 'result_recorded'),
      );
      await act(async () => {
        expect((await drain()).accepted).toBe(1);
      });
      expect(answered.presentations).toEqual([[receiptId]]);
      truth = await ledgerTruth();
      expect(truth.wallet.hold).toBe(false);
      expect(truth.pending).toHaveLength(0);
      expect(truth.allocation.spendableTickets).toBe(1);
      expect(truth.allocation.consumedTickets).toBe(1);

      await elapse(OFFLINE_JOURNEY_SYNC_WATCH_MS);
      copy = textOf(card(renderer));
      expect(badgeOf(renderer)).toBe('READY');
      expect(copy).toContain('1 of 2');
      expect(copy).toContain('Nothing');
    });
  }

  it('an HTTP answer the server refused (429) is not described as a dropped connection', async () => {
    await holdGrant();
    await spend('op-1');
    serveReceipts(async () =>
      jsonResponse(RATE_LIMITED, 429, { 'retry-after': '30' }),
    );
    await expect(drain()).rejects.toThrow();
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(textOf(card(renderer))).not.toContain('connection dropped');
  });
});

describe('A5 — double submit: two drains race on one owner while the card watches', () => {
  it('presents the receipt once, settles it once, and the card lands on READY', async () => {
    jest.useFakeTimers();
    await holdGrant();
    await spend('op-1');
    const renderer = await render(<AnalyzeScreen />);
    await elapse(0);
    expect(textOf(card(renderer))).toContain('1 result waiting');

    const answer = answerWhenReleased('result_recorded');
    const first = drain();
    const second = drain();
    await elapse(0);
    answer.release();
    let outcomes!: Awaited<ReturnType<typeof drain>>[];
    await act(async () => {
      outcomes = await Promise.all([first, second]);
    });
    expect(answer.presentations).toHaveLength(1);
    expect(outcomes.reduce((sum, o) => sum + o.accepted, 0)).toBe(1);
    expect(outcomes.reduce((sum, o) => sum + o.submitted, 0)).toBe(1);

    const truth = await ledgerTruth();
    expect(truth.wallet.hold).toBe(false);
    expect(truth.pending).toHaveLength(0);
    expect(truth.allocation.spendableTickets).toBe(1);
    expect(truth.allocation.consumedTickets).toBe(1);

    await elapse(OFFLINE_JOURNEY_SYNC_WATCH_MS);
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('Nothing');
    expect(copy).toContain('1 of 2');

    // A third drain has nothing to present: a settled receipt is never
    // replayed to the server.
    const replay = serveReceipts(receiptIds =>
      verdictsFor(receiptIds, 'result_recorded'),
    );
    expect((await drain()).submitted).toBe(0);
    expect(replay.presentations).toEqual([]);
  });
});

describe('A6 — the account switches inside the card’s ledger transaction', () => {
  // Settings is the surface that stays mounted across a sign-in change
  // (Analyze abandons its execution and leaves the ready surface).
  it('never publishes the first account’s wallet under the second, and states the second’s own ledger', async () => {
    await holdGrant();
    await spend('op-1');
    const gated = gateTransactionsUntilReleased();
    mockDb = () => gated.db;
    const renderer = await render(<SettingsScreen />);
    await settle();
    expect(badgeOf(renderer)).toBe('CHECKING');

    // Account switch while the read is stalled inside its transaction.
    await act(async () => {
      signInAs(OTHER_OWNER, 'token-2');
    });
    await settle();
    gated.release();
    await settle();
    await settle();

    const copy = textOf(renderer.root);
    expect(copy).not.toContain('1 of 2');
    expect(copy).not.toContain('waiting');
    expect(badgeOf(renderer)).toBe('NONE HELD');

    // Back to the first account (a new sign-in generation): its ledger shows.
    await act(async () => {
      signInAs(OWNER, 'token-3');
    });
    await settle();
    await settle();
    expect(badgeOf(renderer)).toBe('READY');
    expect(textOf(card(renderer))).toContain('1 of 2');
  });
});

describe('A7 — free-rating conservation across partial and replayed answers', () => {
  it('a partial answer settles nothing: both receipts stay pending, both tickets stay spent, the card shows the HOLD', async () => {
    jest.useFakeTimers();
    await holdGrant();
    const first = await spend('op-1');
    const second = await spend('op-2');
    const renderer = await render(<AnalyzeScreen />);
    await elapse(0);
    expect(badgeOf(renderer)).toBe('SPENT');
    expect(textOf(card(renderer))).toContain('2 results waiting');

    // The server names only the first receipt.
    const partial = serveReceipts(receiptIds =>
      verdictsFor(
        receiptIds.filter(id => id === first.receipt.receiptId),
        'result_recorded',
      ),
    );
    await expect(drain()).rejects.toThrow();
    expect(partial.presentations).toEqual([
      [first.receipt.receiptId, second.receipt.receiptId],
    ]);
    let truth = await ledgerTruth();
    expect(truth.pending.map(receipt => receipt.settlement)).toEqual([
      null,
      null,
    ]);
    expect(truth.wallet.hold).toBe(true);
    expect(truth.allocation.spendableTickets).toBe(0);
    expect(truth.allocation.consumedTickets).toBe(2);

    await elapse(OFFLINE_JOURNEY_SYNC_WATCH_MS);
    let copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(copy).toContain('2 on hold');
    expect(copy).toContain('0 of 2');
    expect(copy).not.toContain('0 held');

    // A complete answer settles both, once.
    const complete = serveReceipts(receiptIds =>
      verdictsFor(receiptIds, 'result_recorded'),
    );
    await act(async () => {
      expect((await drain()).accepted).toBe(2);
    });
    expect(complete.presentations).toEqual([
      [first.receipt.receiptId, second.receipt.receiptId],
    ]);
    truth = await ledgerTruth();
    expect(truth.pending).toHaveLength(0);
    expect(truth.allocation.consumedTickets).toBe(2);
    expect(truth.allocation.spendableTickets).toBe(0);

    await elapse(OFFLINE_JOURNEY_SYNC_WATCH_MS);
    copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('SPENT');
    expect(copy).toContain('Nothing');
  });

  it('a replayed operation id charges nothing more and the card keeps the same count', async () => {
    await holdGrant();
    const original = await spend('op-1');
    const replayed = await spend('op-1');
    expect(replayed.replayed).toBe(true);
    expect(replayed.receipt.receiptId).toBe(original.receipt.receiptId);
    await expect(
      consumeOfflineAllocation(
        db,
        { ...consumption('op-1'), fullOutputSha256: 'd'.repeat(64) },
        AT_ISSUE,
      ),
    ).rejects.toMatchObject({ code: 'offline.receipt_conflict' });
    const truth = await ledgerTruth();
    expect(truth.allocation.spendableTickets).toBe(1);
    expect(truth.allocation.consumedTickets).toBe(1);
    expect(truth.pending).toHaveLength(1);

    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('1 of 2');
    expect(copy).toContain('1 result waiting');
  });
});

describe('A8 — a ticket stranded in an expired generation', () => {
  it('is not announced as an offline analysis ready when the ledger refuses to spend it', async () => {
    // Generation 1 (two tickets) lapsed; generation 2 restates only the
    // second ticket. The first stays allocated to this phone under the
    // expired generation — never reclaimed, never executable.
    await holdGrant(FREE_GRANT);
    await holdGrant(SECOND_GENERATION_GRANT);
    mockReading = AT_SECOND_GENERATION_ISSUE;
    await spend('op-1', AT_SECOND_GENERATION_ISSUE);

    const truth = await ledgerTruth();
    expect(truth.allocation.spendableTickets).toBe(1);
    expect(truth.allocation.consumedTickets).toBe(1);
    const byGeneration = new Map(
      truth.allocation.grants.map(grant => [grant.generation, grant]),
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
    expect(copy).not.toContain('1 offline analysis ready');
    expect(badgeOf(renderer)).not.toBe('READY');
  });
});

describe('A9 — process death and relaunch with an in-flight journal on disk', () => {
  it('the relaunched app surfaces the persisted HOLD with the right counts and no write', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'w05-attack-'));
    const file = path.join(directory, 'pickle-sensei.db');
    try {
      useDatabase(createSqliteTestDb(file));
      await holdGrant();
      await spend('op-1');
      await presentAndLoseConnection();
      // The process dies: every in-memory module state is gone with it, only
      // the SQLite file survives.
      handle.close();

      useDatabase(createSqliteTestDb(file));
      handle.calls.length = 0;
      const renderer = await render(<AnalyzeScreen />);
      await settle();
      const copy = textOf(card(renderer));
      expect(badgeOf(renderer)).toBe('ON HOLD');
      expect(copy).toContain('1 on hold');
      expect(copy).toContain('1 of 2');
      expect(copy).toContain('nothing is charged twice');
      expect(ledgerWrites()).toEqual([]);
      const truth = await ledgerTruth();
      expect(truth.wallet.hold).toBe(true);
      expect(truth.pending).toHaveLength(1);
    } finally {
      closeSqliteTestDatabases();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
