/**
 * W05-04 adversarial suite — attacks on the offline journey card at its
 * failure boundaries. Every test here states the behaviour the objective
 * promises ("honest offline states" on the shipping Analyze/Settings
 * surfaces) and drives the candidate through a path the shipping app can
 * take. A failing test is a confirmed break; a passing test is an attack the
 * candidate survived. Candidate production code and its own suite are not
 * touched.
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  readonly generation: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

const FREE_GRANT: GrantShape = {
  entitlementSource: 'identity_lifetime_free',
  grantId: GRANT_ID,
  generation: 1,
  issuedAt: ISSUED_AT,
  expiresAt: EXPIRES_AT,
};

/** A Pro lease issued two weeks before the free allocation and expired a
 * week before it: the subscription lapsed, the phone still holds the lease
 * row (an unused pass is never taken back automatically). */
const LAPSED_PRO_GRANT: GrantShape = {
  entitlementSource: 'verified_store',
  grantId: LAPSED_PRO_GRANT_ID,
  generation: 1,
  issuedAt: ISSUED_AT - 14 * DAY_S,
  expiresAt: ISSUED_AT - 7 * DAY_S,
};

function grantResponse(shape: GrantShape): Record<string, unknown> {
  const free = shape.entitlementSource === 'identity_lifetime_free';
  const entitlementExpiresAt = free ? null : shape.expiresAt;
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
            generation: shape.generation,
            ticketIds: TICKETS,
            budgetPolicy: OFFLINE_FREE_ALLOCATION_POLICY.id,
            financialExpiry: 'reconciliation_only',
          },
        }
      : {
          lease: {
            schemaVersion: OFFLINE_PRO_LEASE_SCHEMA_VERSION,
            kind: 'subscription',
            verifiedEntitlementExpiresAt: entitlementExpiresAt,
          },
        }),
  };
  const header = { alg: 'ES256', typ: OFFLINE_GRANT_JWS_TYPE, kid: KEY_ID };
  const compactJws = `${base64Url(JSON.stringify(header))}.${base64Url(
    JSON.stringify(claims),
  )}.${'A'.repeat(86)}`;
  return {
    grantId: shape.grantId,
    generation: shape.generation,
    entitlementSource: shape.entitlementSource,
    issuedAt: shape.issuedAt,
    expiresAt: shape.expiresAt,
    entitlementExpiresAt,
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

async function unmountCurrent() {
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

function client() {
  return createOfflineGrantClient({ baseUrl: ISSUER, token: 'access-token' });
}

/** Presents the queued receipts and loses the connection before any answer
 * arrives: the journal entry stays `in_flight` — a HOLD. */
async function presentAndLoseConnection() {
  fetchSpy?.mockRestore();
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new TypeError('Network request failed');
  });
  await expect(reconcileOfflineWallet(db, client(), AT_ISSUE)).rejects.toThrow(
    'Network request failed',
  );
}

/** Presents the queued receipts and receives the given status for each: the
 * server ANSWERED, so no presentation is left unanswered. */
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
  return reconcileOfflineWallet(db, client(), AT_ISSUE);
}

/** The wallet is read where the player reviews it (Settings); the Analyze
 * ready surface shows that read. Mirrors the candidate's own helper. */
async function visitSettings() {
  const settings = await render(<SettingsScreen />);
  await settle();
  card(settings);
  await unmountCurrent();
}

/** The ledger's own answer, read directly — the fact the card must state. */
async function ledgerTruth() {
  return {
    allocation: await readOfflineAllocation(db, AT_ISSUE),
    wallet: await readOfflineWalletStatus(db),
    pending: await pendingOfflineReceipts(db),
  };
}

function readState(
  allocation: Awaited<ReturnType<typeof readOfflineAllocation>>,
  wallet: OfflineWalletStatus,
): OfflineJourneyState {
  return { kind: 'read', allocation, wallet };
}

function presentedCopy(state: OfflineJourneyState): string {
  const view = presentOfflineJourney(state);
  return [
    view.badge,
    view.title,
    ...view.rows.flatMap(row => [row.label, row.value]),
    ...view.notes,
  ].join(' | ');
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
  await unmountCurrent();
  fetchSpy?.mockRestore();
  fetchSpy = null;
  clearAccessStoreConfiguration();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  mockDb = null;
  mockReading = null;
  closeSqliteTestDatabases();
});

describe('ATTACK A1 — Analyze publication goes stale after the wallet changes (no Settings revisit)', () => {
  it('a spend after the Settings read: the ready surface must show 1 of 2, not the pre-spend 2 of 2', async () => {
    await holdGrant();
    await visitSettings();
    // The player analyses a swing offline: one ticket is consumed and its
    // receipt queued. The ready surface is shown again before Settings is.
    await spend('op-1');
    const truth = await ledgerTruth();
    expect(truth.allocation.spendableTickets).toBe(1);
    expect(truth.pending).toHaveLength(1);

    const renderer = await render(<AnalyzeScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(copy).toContain('1 of 2');
    expect(copy).toContain('1 result waiting');
    expect(copy).not.toContain('2 of 2');
  });

  it('a HOLD that arises after the Settings read: the ready surface must show ON HOLD, not READY', async () => {
    await holdGrant();
    await spend('op-1');
    await visitSettings();
    // The sync runtime drains the outbox and loses the connection with the
    // receipt in flight: the ledger now records a HOLD.
    await presentAndLoseConnection();
    const truth = await ledgerTruth();
    expect(truth.wallet.hold).toBe(true);

    const renderer = await render(<AnalyzeScreen />);
    await settle();
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(textOf(card(renderer))).toContain('1 on hold');
  });

  it('a HOLD the server has since resolved: the ready surface must not keep claiming a HOLD', async () => {
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    await visitSettings();
    // The next drain re-presents the same receipt and the server accepts it:
    // nothing is pending and nothing is on hold any more.
    const outcome = await presentAndReceive('result_recorded');
    expect(outcome.accepted).toBe(1);
    const truth = await ledgerTruth();
    expect(truth.wallet.hold).toBe(false);
    expect(truth.pending).toHaveLength(0);

    const renderer = await render(<AnalyzeScreen />);
    await settle();
    expect(badgeOf(renderer)).not.toBe('ON HOLD');
    const copy = textOf(card(renderer));
    expect(copy).not.toContain('on hold');
    expect(copy).not.toContain('awaiting confirmation');
    expect(copy).toContain('Nothing');
  });
});

describe('ATTACK A2 — reentrancy: a slow Settings read finishing after a fresh one', () => {
  it('the last publication must reflect the newest ledger, never an earlier torn read', async () => {
    await holdGrant();
    // Gate the FIRST wallet-status transaction only: the first refresh reads
    // the allocation (2 of 2), then stalls before reading the receipts.
    let release: (() => void) | null = null;
    let gate: Promise<void> | null = new Promise<void>(resolve => {
      release = resolve;
    });
    const inner = db;
    const gated: LocalDb = {
      execute: (sql, params) => inner.execute(sql, params),
      transaction: async operation => {
        if (gate) {
          const waiting = gate;
          gate = null;
          await waiting;
        }
        if (!inner.transaction) throw new Error('test db has no transaction');
        return inner.transaction(operation);
      },
      close: () => inner.close(),
    };
    mockDb = () => gated;

    const first = await render(<SettingsScreen />);
    await settle();
    expect(badgeOf(first)).toBe('CHECKING');
    await unmountCurrent();

    // Meanwhile the player spends a ticket and Settings is opened again; the
    // fresh read completes first and is correct.
    await spend('op-1');
    const second = await render(<SettingsScreen />);
    await settle();
    expect(textOf(card(second))).toContain('1 of 2');

    // Now the stalled first read finishes and publishes.
    await act(async () => {
      release?.();
    });
    await settle();
    const copy = textOf(card(second));
    expect(copy).toContain('1 of 2');
    expect(copy).not.toContain('2 of 2');
  });
});

describe('ATTACK A3 — a server-answered HOLD is described as an unanswered one', () => {
  it('when the server answered "pending", the card must not claim the answer never arrived', async () => {
    await holdGrant();
    await spend('op-1');
    const outcome = await presentAndReceive('pending');
    expect(outcome.held).toBe(1);
    const truth = await ledgerTruth();
    // The server DID answer: no presentation is unanswered.
    expect(truth.wallet.hold).toBe(false);
    expect(truth.wallet.unansweredPresentations).toBe(0);
    expect(truth.wallet.pending[0]?.phase).toBe('held');

    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(copy).toContain('1 on hold');
    expect(copy).not.toContain('the answer never arrived');
    expect(copy).not.toContain('before the connection dropped');
    expectDossierCompliant(copy);
  });
});

describe('ATTACK A4 — boundary: every ticket spent', () => {
  it('a fully spent pass must not carry a READY badge', async () => {
    await holdGrant();
    await spend('op-1');
    await spend('op-2');
    const truth = await ledgerTruth();
    expect(truth.allocation.spendableTickets).toBe(0);

    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(copy).toContain('Offline pass fully spent');
    expect(copy).toContain('0 of 2');
    expect(badgeOf(renderer)).not.toBe('READY');
  });
});

describe('ATTACK A5 — duplicate identities: a lapsed Pro lease beside an active free allocation', () => {
  it('must describe the active free allocation, never claim a Pro pass is active', async () => {
    await holdGrant(LAPSED_PRO_GRANT);
    await holdGrant(FREE_GRANT);
    const truth = await ledgerTruth();
    const byId = new Map<string, HeldOfflineGrantView>(
      truth.allocation.grants.map(grant => [grant.grantId, grant]),
    );
    expect(byId.get(LAPSED_PRO_GRANT_ID)?.execution.kind).toBe('expired');
    expect(byId.get(GRANT_ID)?.execution.kind).toBe('active');
    expect(truth.allocation.spendableTickets).toBe(2);

    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).not.toContain('Pro offline pass active');
    expect(copy).not.toContain('Pro pass');
    expect(copy).toContain('2 of 2');
    expect(copy).toContain('2 offline analyses ready');
    expectDossierCompliant(copy);
  });
});

describe('ATTACK A6 — corrupt persisted state: an in-flight journal entry naming no pending receipt', () => {
  it('must not announce "0 results awaiting confirmation"', async () => {
    await holdGrant();
    handle.native
      .prepare(
        `INSERT INTO offline_wallet_journal
           (owner_key, journal_id, kind, receipt_ids, state, opened_at, closed_at, verdicts)
         VALUES (?, ?, 'receipt_submission', ?, 'in_flight', ?, NULL, NULL)`,
      )
      .run(
        OWNER,
        'dddddddd-0000-4000-8000-000000000001',
        JSON.stringify(['receipt-that-no-longer-exists']),
        new Date(ISSUED_AT * 1000).toISOString(),
      );
    const truth = await ledgerTruth();
    expect(truth.wallet.hold).toBe(true);
    expect(truth.wallet.pending).toHaveLength(0);

    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(copy).not.toContain('0 results');
    expectDossierCompliant(copy);
  });
});

describe('ATTACK A7 — boundary: non-finite and negative remaining time', () => {
  function grantWith(
    execution: HeldOfflineGrantView['execution'],
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
      execution,
    };
  }
  const emptyWallet: OfflineWalletStatus = {
    pending: [],
    unansweredPresentations: 0,
    hold: false,
  };

  it.each([Number.NaN, -1, Number.NEGATIVE_INFINITY])(
    'an "active" verdict with remainingMs=%p must not be shown as a live pass',
    remainingMs => {
      const copy = presentedCopy(
        readState(
          {
            grants: [grantWith({ kind: 'active', remainingMs })],
            spendableTickets: 2,
            consumedTickets: 0,
            pendingReceipts: 0,
          },
          emptyWallet,
        ),
      );
      expect(copy).not.toContain('READY');
      expect(copy).not.toContain('In under an hour');
    },
  );
});

describe('ATTACK A8 — interleaved account switch A → B → A during a read', () => {
  it('a read started under the first sign-in is never shown to the second sign-in of the same account', async () => {
    await holdGrant();
    await spend('op-1');
    let release: (() => void) | null = null;
    let gate: Promise<void> | null = new Promise<void>(resolve => {
      release = resolve;
    });
    const inner = db;
    const gated: LocalDb = {
      execute: async (sql, params) => {
        if (gate) {
          const waiting = gate;
          gate = null;
          await waiting;
        }
        return inner.execute(sql, params);
      },
      transaction: operation => {
        if (!inner.transaction) throw new Error('test db has no transaction');
        return inner.transaction(operation);
      },
      close: () => inner.close(),
    };
    mockDb = () => gated;

    const settings = await render(<SettingsScreen />);
    await settle();
    // A → B → A while the first read is stalled on its first statement.
    setActiveDataOwner(OTHER_OWNER);
    establishApiSession({
      apiBaseUrl: 'https://api.test',
      bearerToken: 'token-2',
      canonicalAppUserId: OTHER_OWNER,
      provider: 'apple',
    });
    await settle();
    setActiveDataOwner(OWNER);
    establishApiSession({
      apiBaseUrl: 'https://api.test',
      bearerToken: 'token-3',
      canonicalAppUserId: OWNER,
      provider: 'apple',
    });
    await settle();
    await act(async () => {
      release?.();
    });
    await settle();
    const copy = textOf(card(settings));
    // Whatever is shown is a read taken under the CURRENT sign-in: the
    // stalled read is dropped and a fresh one is issued, so the card either
    // states the ledger's truth or is still checking — never another
    // generation's snapshot presented as current.
    expect(['READY', 'CHECKING']).toContain(badgeOf(settings));
    if (badgeOf(settings) === 'READY') {
      expect(copy).toContain('1 of 2');
      expect(copy).toContain('1 result waiting');
    }
    await unmountCurrent();
    const analyze = await render(<AnalyzeScreen />);
    await settle();
    if (cards(analyze).length > 0) {
      expect(textOf(card(analyze))).toContain('1 of 2');
    }
  });
});

describe('ATTACK A9 — copy and vocabulary across every presentable state', () => {
  const REASONS = [
    'no_trusted_time',
    'storage_invalid',
    'clock_rollback',
    'floor_only',
    'elapsed_unmeasured',
    'invalid_lease',
    'lease_ahead_of_clock',
  ] as const;

  function grantWith(
    source: 'identity_lifetime_free' | 'verified_store',
    execution: HeldOfflineGrantView['execution'],
  ): HeldOfflineGrantView {
    return {
      grantId: GRANT_ID,
      generation: 1,
      entitlementSource: source,
      installationKeyId: INSTALLATION_KEY,
      keyId: KEY_ID,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      entitlementExpiresAt: null,
      grantJwsSha256: 'e'.repeat(64),
      allocated: source === 'verified_store' ? 0 : 2,
      remaining: source === 'verified_store' ? 0 : 1,
      consumed: source === 'verified_store' ? 0 : 1,
      lifecycleSequence: 1,
      execution,
    };
  }

  const wallets: OfflineWalletStatus[] = [
    { pending: [], unansweredPresentations: 0, hold: false },
    {
      pending: [
        {
          receiptId: 'r1',
          operationId: 'op-1',
          settlement: null,
          presentations: 0,
          phase: 'queued',
        },
      ],
      unansweredPresentations: 0,
      hold: false,
    },
    {
      pending: [
        {
          receiptId: 'r1',
          operationId: 'op-1',
          settlement: null,
          presentations: 1,
          phase: 'presented_unanswered',
        },
      ],
      unansweredPresentations: 1,
      hold: true,
    },
    {
      pending: [
        {
          receiptId: 'r1',
          operationId: 'op-1',
          settlement: 'held',
          presentations: 1,
          phase: 'held',
        },
      ],
      unansweredPresentations: 0,
      hold: false,
    },
  ];

  const executions: HeldOfflineGrantView['execution'][] = [
    { kind: 'active', remainingMs: 6 * 24 * 60 * 60 * 1000 },
    { kind: 'active', remainingMs: 90 * 60 * 1000 },
    { kind: 'active', remainingMs: 1 },
    { kind: 'expired' },
    ...REASONS.map(reason => ({ kind: 'reconcile_required' as const, reason })),
  ];

  it('no state emits dossier-forbidden vocabulary, an empty sentence, or an unresolved template', () => {
    const states: OfflineJourneyState[] = [
      { kind: 'loading' },
      { kind: 'unavailable' },
    ];
    for (const wallet of wallets) {
      states.push(
        readState(
          {
            grants: [],
            spendableTickets: 0,
            consumedTickets: 0,
            pendingReceipts: 0,
          },
          wallet,
        ),
      );
      for (const source of [
        'identity_lifetime_free',
        'verified_store',
      ] as const)
        for (const execution of executions)
          states.push(
            readState(
              {
                grants: [grantWith(source, execution)],
                spendableTickets: source === 'verified_store' ? 0 : 1,
                consumedTickets: source === 'verified_store' ? 0 : 1,
                pendingReceipts: wallet.pending.length,
              },
              wallet,
            ),
          );
    }
    expect(states.length).toBeGreaterThan(80);
    for (const state of states) {
      const view = presentOfflineJourney(state);
      const copy = presentedCopy(state);
      expectDossierCompliant(copy);
      expect(copy).not.toMatch(/undefined|null|NaN|\[object/);
      expect(view.title.trim()).not.toBe('');
      expect(view.badge.trim()).not.toBe('');
      for (const note of view.notes) expect(note.trim()).not.toBe('');
      for (const row of view.rows) {
        expect(row.label.trim()).not.toBe('');
        expect(row.value.trim()).not.toBe('');
      }
    }
  });

  it('a reconcile-required lease never promises remaining time', () => {
    for (const reason of REASONS) {
      const copy = presentedCopy(
        readState(
          {
            grants: [
              grantWith('identity_lifetime_free', {
                kind: 'reconcile_required',
                reason,
              }),
            ],
            spendableTickets: 1,
            consumedTickets: 1,
            pendingReceipts: 0,
          },
          wallets[0]!,
        ),
      );
      expect(copy).not.toMatch(/In \d+ (day|hour)/);
      expect(copy).not.toContain('In under an hour');
      expect(copy).toContain('Unconfirmed');
    }
  });
});

describe('ATTACK A10 — the objective names the Result surface too', () => {
  it('ResultScreen renders the offline journey (allocation, lease, pending receipts, HOLD)', () => {
    const source = readFileSync(
      join(__dirname, '..', 'src', 'screens', 'ResultScreen.tsx'),
      'utf8',
    );
    expect(source).toMatch(
      /OfflineAllocationCard|usePublishedOfflineJourney|useOfflineJourney/,
    );
  });
});
