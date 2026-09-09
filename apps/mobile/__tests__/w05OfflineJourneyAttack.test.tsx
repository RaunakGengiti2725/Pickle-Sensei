/**
 * W05-04 adversarial suite against candidate 71967640.
 *
 * Every test here is an attack at a failure boundary of the offline journey
 * surface: concurrent and replayed spends, racing drains, an account switch
 * under an armed follow-up timer, duplicate journal identities, exact lease
 * boundaries, corrupt and partially persisted ledger rows, a server answer
 * that names receipts this phone never presented, a presentation still in
 * flight, a process death between the server recording a result and the
 * phone reading the answer, and copy/accessibility sweeps over the whole
 * presenter matrix. A test that passes means the attack did not break the
 * candidate; a test that fails is a reproducible break.
 *
 * Nothing in the shipping code or in the candidate's own regression suite
 * is touched by this file.
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
const HOUR_S = 60 * 60;
const DAY_S = 24 * HOUR_S;
const SIX_DAYS_S = 6 * DAY_S;
const EXPIRES_AT = ISSUED_AT + SIX_DAYS_S;
const TICKETS = [
  'aaaaaaaa-0000-4000-8000-000000000001',
  'aaaaaaaa-0000-4000-8000-000000000002',
] as const;
const GRANT_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const PRO_GRANT_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const RESULT_SHA = 'c'.repeat(64);
const OTHER_RESULT_SHA = 'd'.repeat(64);
const UNKNOWN_RECEIPT_ID = 'ffffffff-0000-4000-8000-000000000001';
const BINDING = { installationKeyId: INSTALLATION_KEY, issuer: ISSUER };
const CARD_TEST_ID = 'offline-allocation-card';

const RENDER_ARTIFACTS = [
  /NaN/,
  /Infinity/,
  /undefined/,
  /\bnull\b/,
  /\[object/,
];

const PLURAL_DISAGREEMENT = [
  /\b1 (results|analyses|days|hours|minutes|held analyses|offline analyses)\b/,
  /\b(0|[2-9]|\d{2,}) (result|analysis|day|hour|minute)\b/,
];

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
  /\baccura(cy|te)\b/i,
  /\bguarantee/i,
];

/** Typographic breakage: doubled spaces, a space before punctuation, an
 * unterminated sentence, leading/trailing whitespace, or a count of zero
 * stated as a fraction of zero. */
const TYPOGRAPHY_ARTIFACTS = [/ {2}/, / [.,;:]/, /^\s|\s$/, /\b0 of 0\b/];

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

/** A Pro lease held beside the free allocation, ending one day after it. */
const PRO_GRANT: GrantShape = {
  entitlementSource: 'verified_store',
  grantId: PRO_GRANT_ID,
  issuedAt: ISSUED_AT,
  expiresAt: EXPIRES_AT + DAY_S,
  entitlementExpiresAt: EXPIRES_AT + SIX_DAYS_S,
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
const ROLLED_BACK: TrustedTimeReading = { ...AT_ISSUE, rollbackDetected: true };

function consumption(operationId: string, fullOutputSha256 = RESULT_SHA) {
  return {
    operationId,
    resultId: `result-${operationId}`,
    fullOutputSha256,
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

function expectCleanCopy(copy: string) {
  for (const pattern of FORBIDDEN_COPY) expect(copy).not.toMatch(pattern);
  for (const pattern of RENDER_ARTIFACTS) expect(copy).not.toMatch(pattern);
  for (const pattern of PLURAL_DISAGREEMENT) expect(copy).not.toMatch(pattern);
}

async function holdGrant(shape: GrantShape = FREE_GRANT) {
  await holdOfflineGrant(db, issuedGrant(shape), BINDING);
}

async function spend(operationId: string, fullOutputSha256 = RESULT_SHA) {
  return consumeOfflineAllocation(
    db,
    consumption(operationId, fullOutputSha256),
    AT_ISSUE,
  );
}

function grantClient() {
  return createOfflineGrantClient({ baseUrl: ISSUER, token: 'access-token' });
}

interface ReceiptRequest {
  receipts?: Array<{ receiptId: string }>;
}

function receiptIdsIn(init: RequestInit | undefined): string[] {
  const body = JSON.parse(String(init?.body ?? '{}')) as ReceiptRequest;
  return (body.receipts ?? []).map(receipt => receipt.receiptId);
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function notFound(): Response {
  return jsonResponse({ error: 'not_found' }, 404);
}

/** A server that records every receipt id it is shown and answers each
 * with `status`. `beforeAnswer` runs after the server recorded the receipts
 * and before the phone can read the answer. */
function serveReceipts(
  status: string,
  beforeAnswer: (presented: readonly string[]) => Response | void = () =>
    undefined,
) {
  const presented: string[][] = [];
  fetchSpy?.mockRestore();
  fetchSpy = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      if (String(input) !== RECEIPTS_ROUTE) return notFound();
      const ids = receiptIdsIn(init);
      presented.push(ids);
      const override = beforeAnswer(ids);
      if (override) return override;
      return jsonResponse({
        receipts: ids.map(receiptId => ({ receiptId, status })),
        rejected: [],
      });
    });
  return presented;
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

async function insertInFlightJournal(
  receiptIds: readonly string[],
  journalId: string,
  owner = OWNER,
) {
  await db.execute(
    `INSERT INTO offline_wallet_journal
       (owner_key, journal_id, kind, receipt_ids, state, opened_at, closed_at, verdicts)
     VALUES (?, ?, 'receipt_submission', ?, 'in_flight', ?, NULL, NULL)`,
    [
      owner,
      journalId,
      JSON.stringify(receiptIds),
      new Date(ISSUED_AT * 1000).toISOString(),
    ],
  );
}

async function ledgerTruth(reading: TrustedTimeReading = AT_ISSUE) {
  return {
    allocation: await readOfflineAllocation(db, reading),
    wallet: await readOfflineWalletStatus(db),
    pending: await pendingOfflineReceipts(db),
  };
}

async function receiptRows() {
  const { rows } = await db.execute(
    `SELECT receipt_id, operation_id, settlement FROM offline_receipt WHERE owner_key = ? ORDER BY queued_at`,
    [OWNER],
  );
  return rows as { receipt_id: string; settlement: string | null }[];
}

const WRITE_STATEMENT =
  /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i;
const LEDGER_READ = /FROM offline_(grant|ticket|receipt|wallet_journal)\b/;

function writes() {
  return handle.calls.filter(call => WRITE_STATEMENT.test(call.sql));
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

function useDb(next: ReturnType<typeof createSqliteTestDb>) {
  handle = next;
  db = next.db;
  mockDb = () => db;
}

beforeEach(() => {
  useDb(createSqliteTestDb());
  mockReading = AT_ISSUE;
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
  jest.useRealTimers();
  closeSqliteTestDatabases();
});

describe('ATTACK 1 — concurrency and reentrancy', () => {
  it('A1 two concurrent spends of one operation, then a conflicting replay racing a fresh spend, charge exactly two tickets and the card states the ledger', async () => {
    await holdGrant();
    const [first, second] = await Promise.all([spend('op-1'), spend('op-1')]);
    expect(first.receipt.receiptId).toBe(second.receipt.receiptId);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);

    const raced = await Promise.allSettled([
      spend('op-1', OTHER_RESULT_SHA),
      spend('op-2'),
    ]);
    expect(raced[0].status).toBe('rejected');
    expect(raced[1].status).toBe('fulfilled');

    const truth = await ledgerTruth();
    expect(truth.allocation.spendableTickets).toBe(0);
    expect(truth.allocation.consumedTickets).toBe(2);
    expect(truth.pending).toHaveLength(2);
    expect(await receiptRows()).toHaveLength(2);

    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('SPENT');
    expect(copy).toContain('0 of 2 unspent');
    expect(copy).toContain('2 results waiting');
    expectCleanCopy(copy);
  });

  it('A2 two drains racing for one wallet present the receipt once and settle it once; the card then states READY with nothing waiting', async () => {
    await holdGrant();
    await spend('op-1');
    const presented = serveReceipts('result_recorded');
    const [left, right] = await Promise.all([
      reconcileOfflineWallet(db, grantClient(), AT_ISSUE),
      reconcileOfflineWallet(db, grantClient(), AT_ISSUE),
    ]);
    expect(presented).toHaveLength(1);
    expect(left.submitted + right.submitted).toBe(1);
    expect(left.accepted + right.accepted).toBe(1);
    const truth = await ledgerTruth();
    expect(truth.allocation.consumedTickets).toBe(1);
    expect(truth.allocation.spendableTickets).toBe(1);
    expect(truth.wallet.hold).toBe(false);
    expect(truth.pending).toHaveLength(0);
    expect((await receiptRows()).map(row => row.settlement)).toEqual([
      'accepted',
    ]);

    const renderer = await render(<AnalyzeScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('1 of 2 unspent');
    expect(copy).toContain('Nothing');
    expectCleanCopy(copy);
  });

  it('A3 a HOLD follow-up timer armed for account A never reads A after the switch to B, even while B’s first read stalls', async () => {
    jest.useFakeTimers();
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const renderer = await render(<SettingsScreen />);
    await settleFake();
    expect(badgeOf(renderer)).toBe('ON HOLD');

    const gated = gateFirstTransaction();
    mockDb = () => gated.db;
    const switchedAt = handle.calls.length;
    await act(async () => {
      signInAs(OTHER_OWNER, 'token-2');
    });
    await settleFake();
    expect(badgeOf(renderer)).toBe('CHECKING');

    await advance(PENDING_RECEIPT_READ_CADENCE_MS + 1);
    expect(badgeOf(renderer)).toBe('CHECKING');
    gated.release();
    await settleFake();
    expect(badgeOf(renderer)).toBe('NONE HELD');

    const afterSwitch = handle.calls.slice(switchedAt);
    const ledgerReadsForA = afterSwitch.filter(
      call => LEDGER_READ.test(call.sql) && call.params.includes(OWNER),
    );
    expect(ledgerReadsForA).toEqual([]);
    expect(afterSwitch.filter(call => WRITE_STATEMENT.test(call.sql))).toEqual(
      [],
    );
    expect(textOf(card(renderer))).not.toContain('on hold');
  });
});

describe('ATTACK 2 — replay and duplicate identities', () => {
  it('A4 two in-flight journal rows naming the same receipt are one HOLD on the card, and the receipt stays one spent ticket', async () => {
    await holdGrant();
    const spent = await spend('op-1');
    await presentAndLoseConnection();
    await insertInFlightJournal(
      [spent.receipt.receiptId],
      'dddddddd-0000-4000-8000-000000000002',
    );
    const truth = await ledgerTruth();
    expect(truth.wallet.unansweredPresentations).toBe(2);
    expect(truth.allocation.consumedTickets).toBe(1);

    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(copy).toContain('1 result awaiting confirmation');
    expect(copy).toContain('1 on hold');
    expect(copy).not.toContain('2 on hold');
    expect(copy).toContain('1 of 2 unspent');
    expectCleanCopy(copy);
  });

  it('A5 an in-flight submission naming a receipt this phone never queued, beside an identified HOLD, is stated on the card', async () => {
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    await insertInFlightJournal(
      [UNKNOWN_RECEIPT_ID],
      'dddddddd-0000-4000-8000-000000000003',
    );
    const truth = await ledgerTruth();
    expect(truth.wallet.hold).toBe(true);
    expect(truth.wallet.unansweredPresentations).toBe(2);

    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(copy).toContain('1 of 2 unspent');
    // The second in-flight submission names nothing on file. The card must
    // not describe the wallet as holding exactly one answered-for receipt.
    expect(copy).toMatch(/Unreadable|names no receipt|2 on hold/);
    expectCleanCopy(copy);
  });

  it('A6 a settled receipt re-answered by the server (a replayed verdict) charges nothing further', async () => {
    await holdGrant();
    const spent = await spend('op-1');
    serveReceipts('result_recorded');
    await reconcileOfflineWallet(db, grantClient(), AT_ISSUE);
    // The wallet already settled the receipt; a stale answer for it arrives
    // through a stale in-flight row left by a superseded presentation.
    await insertInFlightJournal(
      [spent.receipt.receiptId],
      'dddddddd-0000-4000-8000-000000000004',
    );
    const drained = await reconcileOfflineWallet(db, grantClient(), AT_ISSUE);
    expect(drained.submitted).toBe(0);
    expect(drained.accepted).toBe(0);
    const truth = await ledgerTruth();
    expect(truth.allocation.consumedTickets).toBe(1);
    expect(truth.allocation.spendableTickets).toBe(1);
    expect(truth.wallet.hold).toBe(false);
    expect(await receiptRows()).toHaveLength(1);

    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('READY');
    expect(copy).toContain('1 of 2 unspent');
    expectCleanCopy(copy);
  });
});

describe('ATTACK 3 — boundary values under trusted time', () => {
  it.each([
    [
      'one millisecond before the lease end',
      EXPIRES_AT * 1000 - 1,
      'READY',
      'In under an hour',
    ],
    ['exactly at the lease end', EXPIRES_AT * 1000, 'EXPIRED', 'Expired'],
    [
      'one millisecond past the lease end',
      EXPIRES_AT * 1000 + 1,
      'EXPIRED',
      'Expired',
    ],
    [
      'exactly one hour before the end',
      (EXPIRES_AT - HOUR_S) * 1000,
      'READY',
      'In 1 hour',
    ],
    [
      'exactly one day before the end',
      (EXPIRES_AT - DAY_S) * 1000,
      'READY',
      'In 1 day',
    ],
    [
      'one millisecond under a day before the end',
      (EXPIRES_AT - DAY_S) * 1000 + 1,
      'READY',
      'In 23 hours',
    ],
  ])(
    'A7 %s states the verdict trusted time gives, never one more unit',
    async (_label, nowMs, badge, passEnds) => {
      await holdGrant();
      mockReading = anchored(nowMs);
      const renderer = await render(<SettingsScreen />);
      await settle();
      const copy = textOf(card(renderer));
      expect(badgeOf(renderer)).toBe(badge);
      expect(copy).toContain(passEnds);
      expect(copy).toContain('2 of 2 unspent');
      if (badge === 'EXPIRED') expect(copy).toContain('stay allocated');
      expectCleanCopy(copy);
    },
  );

  it.each([
    ['the Unix epoch', 0],
    ['a negative clock', -DAY_S * 1000],
    ['the far future', 4_000_000_000 * 1000],
    ['a NaN clock', Number.NaN],
    ['a positive-infinite clock', Number.POSITIVE_INFINITY],
    ['a negative-infinite clock', Number.NEGATIVE_INFINITY],
  ])(
    'A8 an anchored reading at %s never presents a live pass or a fabricated count',
    async (_label, nowMs) => {
      await holdGrant();
      mockReading = anchored(nowMs);
      const renderer = await render(<SettingsScreen />);
      await settle();
      const copy = textOf(card(renderer));
      expect(['EXPIRED', 'CONFIRM ONLINE']).toContain(badgeOf(renderer));
      expect(copy).not.toMatch(/\bIn \d+ (day|days|hour|hours)\b/);
      expect(copy).toContain('2 of 2 unspent');
      expect(copy).toContain('stay allocated');
      expectCleanCopy(copy);
    },
  );

  it('A9 a rollback detected while a HOLD is on record states both, and the rollback never turns the HOLD into a refund', async () => {
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    mockReading = ROLLED_BACK;
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(copy).toContain('moved backwards');
    expect(copy).toContain('1 on hold');
    expect(copy).toContain('1 of 2 unspent');
    expect(copy).toContain('Unconfirmed');
    expectCleanCopy(copy);
  });

  it.each([
    [
      'the free allocation ends while the Pro lease is live',
      EXPIRES_AT * 1000,
      'READY',
      'Pro offline pass active',
      'In 1 day',
    ],
    [
      'both leases have ended',
      (EXPIRES_AT + DAY_S) * 1000,
      'EXPIRED',
      'Offline pass expired',
      'Expired',
    ],
    [
      'the Pro lease ends one millisecond from now',
      (EXPIRES_AT + DAY_S) * 1000 - 1,
      'READY',
      'Pro offline pass active',
      'In under an hour',
    ],
  ])(
    'A26 Pro lease beside free tickets when %s: the ticket ledger is stated and only a live lease is named',
    async (_label, nowMs, badge, title, passEnds) => {
      await holdGrant();
      await holdGrant(PRO_GRANT);
      mockReading = anchored(nowMs);
      const renderer = await render(<SettingsScreen />);
      await settle();
      const copy = textOf(card(renderer));
      expect(badgeOf(renderer)).toBe(badge);
      expect(copy).toContain(title);
      expect(copy).toContain(passEnds);
      expect(copy).toContain('2 of 2 unspent');
      expect(copy).not.toContain('Pro pass');
      if (badge === 'EXPIRED') {
        expect(copy).toContain('stay allocated');
        expect(copy).not.toContain('Pro offline pass');
      }
      expectCleanCopy(copy);
    },
  );

  it('A10 a free grant listing zero tickets is refused by the wallet or shown without a claim of anything spent', async () => {
    let refused = false;
    try {
      await holdGrant({ ...FREE_GRANT, ticketIds: [] });
    } catch {
      refused = true;
    }
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    if (refused) {
      expect(badgeOf(renderer)).toBe('NONE HELD');
    } else {
      expect(badgeOf(renderer)).not.toBe('SPENT');
      expect(copy).not.toContain('fully spent');
      expect(copy).not.toContain('0 of 0');
    }
    expectCleanCopy(copy);
  });
});

describe('ATTACK 4 — corrupt and partially persisted state', () => {
  async function expectUnavailableAndUntouched() {
    const before = await db.execute(
      `SELECT count(*) AS n FROM offline_receipt WHERE owner_key = ?`,
      [OWNER],
    );
    handle.calls.length = 0;
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('UNAVAILABLE');
    expect(copy).toContain('could not be read');
    expect(copy).not.toMatch(/\d of \d/);
    expect(copy).not.toContain('No offline pass');
    expect(writes()).toEqual([]);
    const after = await db.execute(
      `SELECT count(*) AS n FROM offline_receipt WHERE owner_key = ?`,
      [OWNER],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    expectCleanCopy(copy);
  }

  it('A11 an in-flight journal row naming no receipts is unreadable, not an empty wallet', async () => {
    await holdGrant();
    await spend('op-1');
    await insertInFlightJournal([], 'dddddddd-0000-4000-8000-000000000005');
    await expectUnavailableAndUntouched();
  });

  it('A12 an applied journal row that recorded no verdicts is unreadable, not a resolved HOLD', async () => {
    await holdGrant();
    const spent = await spend('op-1');
    await db.execute(
      `INSERT INTO offline_wallet_journal
         (owner_key, journal_id, kind, receipt_ids, state, opened_at, closed_at, verdicts)
       VALUES (?, ?, 'receipt_submission', ?, 'applied', ?, ?, NULL)`,
      [
        OWNER,
        'dddddddd-0000-4000-8000-000000000006',
        JSON.stringify([spent.receipt.receiptId]),
        new Date(ISSUED_AT * 1000).toISOString(),
        new Date(ISSUED_AT * 1000 + 1000).toISOString(),
      ],
    );
    await expectUnavailableAndUntouched();
  });

  it('A13 a receipt whose stored body names a different receipt id than its row is unreadable', async () => {
    await holdGrant();
    const spent = await spend('op-1');
    const { rows } = await db.execute(
      `SELECT receipt FROM offline_receipt WHERE owner_key = ? AND receipt_id = ?`,
      [OWNER, spent.receipt.receiptId],
    );
    const body = JSON.parse(String(rows[0]?.['receipt'])) as Record<
      string,
      unknown
    >;
    body['receiptId'] = UNKNOWN_RECEIPT_ID;
    await db.execute(
      `UPDATE offline_receipt SET receipt = ? WHERE owner_key = ? AND receipt_id = ?`,
      [JSON.stringify(body), OWNER, spent.receipt.receiptId],
    );
    await expectUnavailableAndUntouched();
  });

  it('A14 a consumed ticket whose receipt row is missing (a torn spend) is unreadable, never a fabricated count', async () => {
    await holdGrant();
    const spent = await spend('op-1');
    await db.execute(
      `DELETE FROM offline_receipt WHERE owner_key = ? AND receipt_id = ?`,
      [OWNER, spent.receipt.receiptId],
    );
    await expectUnavailableAndUntouched();
  });

  it('A15 a wallet that becomes unreadable on a quiet follow-up read is reported as such, and recovers once readable again', async () => {
    jest.useFakeTimers();
    await holdGrant();
    await spend('op-1');
    const renderer = await render(<SettingsScreen />);
    await settleFake();
    expect(badgeOf(renderer)).toBe('READY');
    await insertInFlightJournal([], 'dddddddd-0000-4000-8000-000000000007');
    await advance(PENDING_RECEIPT_READ_CADENCE_MS + 1);
    expect(badgeOf(renderer)).toBe('UNAVAILABLE');
    await db.execute(
      `DELETE FROM offline_wallet_journal WHERE owner_key = ? AND journal_id = ?`,
      [OWNER, 'dddddddd-0000-4000-8000-000000000007'],
    );
    await advance(PENDING_RECEIPT_READ_CADENCE_MS + 1);
    expect(badgeOf(renderer)).toBe('READY');
    expect(textOf(card(renderer))).toContain('1 of 2 unspent');
  });
});

describe('ATTACK 5 — network failure at each step of the drain', () => {
  it('A16 an answer naming one receipt more than the phone presented settles nothing, refunds nothing and leaves a HOLD on the card', async () => {
    await holdGrant();
    const spent = await spend('op-1');
    const presented = serveReceipts('result_recorded', ids =>
      jsonResponse({
        receipts: [...ids, UNKNOWN_RECEIPT_ID].map(receiptId => ({
          receiptId,
          status: 'result_recorded',
        })),
        rejected: [],
      }),
    );
    await expect(
      reconcileOfflineWallet(db, grantClient(), AT_ISSUE),
    ).rejects.toThrow();
    expect(presented).toEqual([[spent.receipt.receiptId]]);
    const truth = await ledgerTruth();
    expect(truth.allocation.consumedTickets).toBe(1);
    expect(truth.allocation.spendableTickets).toBe(1);
    expect(truth.wallet.hold).toBe(true);
    expect((await receiptRows()).map(row => row.settlement)).toEqual([null]);

    const renderer = await render(<AnalyzeScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(copy).toContain('1 on hold');
    expect(copy).toContain('1 of 2 unspent');
    expectCleanCopy(copy);
  });

  it('A17 a 200 answer that is an HTML redirect page settles nothing and the card states a HOLD, not READY', async () => {
    await holdGrant();
    await spend('op-1');
    fetchSpy?.mockRestore();
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response('<html><body>Moved</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    await expect(
      reconcileOfflineWallet(db, grantClient(), AT_ISSUE),
    ).rejects.toThrow();
    const truth = await ledgerTruth();
    expect(truth.wallet.hold).toBe(true);
    expect(truth.allocation.consumedTickets).toBe(1);

    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(copy).toContain('1 result awaiting confirmation');
    expectCleanCopy(copy);
  });

  it('A18 a presentation still in flight is a HOLD while the request is outstanding and READY once the same presentation is answered', async () => {
    await holdGrant();
    await spend('op-1');
    let answer: (response: Response) => void = () => undefined;
    const outstanding = new Promise<Response>(resolve => {
      answer = resolve;
    });
    let presentedIds: string[] = [];
    fetchSpy?.mockRestore();
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        if (String(input) !== RECEIPTS_ROUTE) return notFound();
        presentedIds = receiptIdsIn(init);
        return outstanding;
      });
    const drain = reconcileOfflineWallet(db, grantClient(), AT_ISSUE);
    await settle();
    expect(presentedIds).toHaveLength(1);

    const renderer = await render(<AnalyzeScreen />);
    await settle();
    let copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(copy).toContain('1 on hold');
    expect(copy).toContain('nothing is charged twice');
    expectCleanCopy(copy);

    answer(
      jsonResponse({
        receipts: presentedIds.map(receiptId => ({
          receiptId,
          status: 'result_recorded',
        })),
        rejected: [],
      }),
    );
    const drained = await drain;
    expect(drained.accepted).toBe(1);
    await act(async () => renderer.unmount());
    mounted = null;
    const reopened = await render(<AnalyzeScreen />);
    await settle();
    copy = textOf(card(reopened));
    expect(badgeOf(reopened)).toBe('READY');
    expect(copy).toContain('1 of 2 unspent');
    expect(copy).toContain('Nothing');
    expect((await receiptRows()).map(row => row.settlement)).toEqual([
      'accepted',
    ]);
  });
});

describe('ATTACK 6 — process death and restart through the persisted journal', () => {
  let directory: string | null = null;

  afterEach(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = null;
  });

  it('A19 the server records the result, the phone dies before reading the answer; after relaunch the card states a HOLD, the retry re-presents the same receipt and nothing is charged twice', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'w05-attack-'));
    const file = path.join(directory, 'wallet.sqlite');
    const first = createSqliteTestDb(file);
    useDb(first);
    await holdGrant();
    const spent = await spend('op-1');
    const recorded: string[][] = [];
    fetchSpy?.mockRestore();
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        if (String(input) !== RECEIPTS_ROUTE) return notFound();
        recorded.push(receiptIdsIn(init));
        throw new TypeError('Network request failed');
      });
    await expect(
      reconcileOfflineWallet(db, grantClient(), AT_ISSUE),
    ).rejects.toThrow('Network request failed');
    expect(recorded).toEqual([[spent.receipt.receiptId]]);

    // Process death: the handle is dropped; the file is all that survives.
    first.close();
    const relaunched = createSqliteTestDb(file);
    useDb(relaunched);
    signInAs(OWNER, 'token-relaunch');

    const renderer = await render(<AnalyzeScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(copy).toContain('1 on hold');
    expect(copy).toContain('1 of 2 unspent');
    expect(copy).toContain('same receipt is presented again');
    expect(writes()).toEqual([]);
    expectCleanCopy(copy);

    const presented = serveReceipts('result_recorded');
    const drained = await reconcileOfflineWallet(db, grantClient(), AT_ISSUE);
    expect(presented).toEqual([[spent.receipt.receiptId]]);
    expect(drained.recovered).toBe(1);
    expect(drained.accepted).toBe(1);
    const truth = await ledgerTruth();
    expect(truth.allocation.consumedTickets).toBe(1);
    expect(truth.allocation.spendableTickets).toBe(1);
    expect(truth.wallet.hold).toBe(false);
    expect(await receiptRows()).toHaveLength(1);
    const journal = await db.execute(
      `SELECT state FROM offline_wallet_journal WHERE owner_key = ? ORDER BY opened_at`,
      [OWNER],
    );
    expect(journal.rows.map(row => row['state']).sort()).toEqual([
      'applied',
      'superseded',
    ]);
  });
});

describe('ATTACK 7 — the card keeps following the ledger across app lifecycle', () => {
  type ChangeListener = (state: AppStateStatus) => void;
  const appStateListeners = new Set<ChangeListener>();
  const originalAppState = AppState.currentState;

  function foreground() {
    AppState.currentState = 'active';
    for (const listener of [...appStateListeners]) listener('active');
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

  it('A20 two surfaces mounted at once share one follow-up timer, and unmounting one keeps the other following the ledger', async () => {
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

    serveReceipts('result_recorded');
    await act(async () => {
      await reconcileOfflineWallet(db, grantClient(), AT_ISSUE);
    });
    await advance(PENDING_RECEIPT_READ_CADENCE_MS + 1);
    expect(badgeOf(analyze)).toBe('READY');
    expect(textOf(card(analyze))).toContain('1 of 2 unspent');
    expect(textOf(card(analyze))).toContain('Nothing');
  });

  it('A21 a foreground transition that arrives while a read is still stalled does not publish the stale read over the fresh one', async () => {
    await holdGrant();
    const gated = gateFirstTransaction();
    mockDb = () => gated.db;
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    expect(badgeOf(renderer)).toBe('CHECKING');
    mockDb = () => db;
    await spend('op-1');
    await act(async () => {
      foreground();
    });
    await settle();
    expect(textOf(card(renderer))).toContain('1 of 2 unspent');
    gated.release();
    await settle();
    const copy = textOf(card(renderer));
    expect(copy).toContain('1 of 2 unspent');
    expect(copy).not.toContain('2 of 2');
    expect(copy).toContain('1 result waiting');
  });
});

describe('ATTACK 8 — copy and accessibility over the whole presenter matrix', () => {
  const LIVE: TrustedTimeLeaseVerdict = {
    kind: 'active',
    remainingMs: 2 * DAY_S * 1000,
  };
  const EXPIRED: TrustedTimeLeaseVerdict = { kind: 'expired' };
  const REASONS = [
    'no_trusted_time',
    'storage_invalid',
    'clock_rollback',
    'floor_only',
    'elapsed_unmeasured',
    'invalid_lease',
    'lease_ahead_of_clock',
  ] as const;

  function grantView(
    entitlementSource: 'identity_lifetime_free' | 'verified_store',
    execution: TrustedTimeLeaseVerdict,
    remaining: number,
    consumed: number,
  ): HeldOfflineGrantView {
    const pro = entitlementSource === 'verified_store';
    return {
      grantId: pro ? PRO_GRANT_ID : GRANT_ID,
      generation: 1,
      entitlementSource,
      installationKeyId: INSTALLATION_KEY,
      keyId: KEY_ID,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      entitlementExpiresAt: pro ? EXPIRES_AT : null,
      grantJwsSha256: 'e'.repeat(64),
      allocated: pro ? 0 : remaining + consumed,
      remaining: pro ? 0 : remaining,
      consumed: pro ? 0 : consumed,
      lifecycleSequence: consumed,
      execution,
    };
  }

  function pendingReceipt(
    phase: OfflineWalletPendingReceipt['phase'],
    index: number,
  ): OfflineWalletPendingReceipt {
    return {
      receiptId: `eeeeeeee-0000-4000-8000-00000000000${index}`,
      operationId: `op-${index}`,
      settlement: phase === 'held' ? 'held' : null,
      presentations: phase === 'queued' ? 0 : 1,
      phase,
    };
  }

  function state(
    grants: readonly HeldOfflineGrantView[],
    pending: readonly OfflineWalletPendingReceipt[],
    hold: boolean,
  ): OfflineJourneyState {
    let spendable = 0;
    let consumed = 0;
    for (const grant of grants) {
      spendable += grant.remaining;
      consumed += grant.consumed;
    }
    const allocation: OfflineAllocationSnapshot = {
      grants,
      spendableTickets: spendable,
      consumedTickets: consumed,
      pendingReceipts: pending.length,
    };
    const unanswered = pending.filter(
      receipt => receipt.phase === 'presented_unanswered',
    ).length;
    const wallet: OfflineWalletStatus = {
      pending,
      unansweredPresentations: hold ? Math.max(unanswered, 1) : unanswered,
      hold: hold || unanswered > 0,
    };
    return { kind: 'read', allocation, wallet };
  }

  const verdicts: readonly TrustedTimeLeaseVerdict[] = [
    LIVE,
    EXPIRED,
    ...REASONS.map((reason): TrustedTimeLeaseVerdict => ({
      kind: 'reconcile_required',
      reason,
    })),
  ];
  const grantSets: (readonly HeldOfflineGrantView[])[] = [[]];
  for (const verdict of verdicts) {
    for (const [remaining, consumed] of [
      [2, 0],
      [1, 1],
      [0, 2],
    ] as const) {
      grantSets.push([
        grantView('identity_lifetime_free', verdict, remaining, consumed),
      ]);
      grantSets.push([
        grantView('verified_store', LIVE, 0, 0),
        grantView('identity_lifetime_free', verdict, remaining, consumed),
      ]);
      grantSets.push([
        grantView('verified_store', EXPIRED, 0, 0),
        grantView('identity_lifetime_free', verdict, remaining, consumed),
      ]);
    }
    grantSets.push([grantView('verified_store', verdict, 0, 0)]);
  }
  const pendingSets: readonly (readonly OfflineWalletPendingReceipt[])[] = [
    [],
    [pendingReceipt('queued', 1)],
    [pendingReceipt('presented_unanswered', 1)],
    [pendingReceipt('held', 1)],
    [pendingReceipt('queued', 1), pendingReceipt('presented_unanswered', 2)],
    [pendingReceipt('presented_unanswered', 1), pendingReceipt('held', 2)],
    [
      pendingReceipt('queued', 1),
      pendingReceipt('presented_unanswered', 2),
      pendingReceipt('held', 3),
    ],
  ];

  const matrix: [string, OfflineJourneyState][] = [];
  for (const grants of grantSets) {
    for (const pending of pendingSets) {
      for (const hold of [false, true]) {
        const label =
          `${grants.map(g => `${g.entitlementSource}/${g.execution.kind}/${g.remaining}+${g.consumed}`).join(',') || 'none'}` +
          ` pending=${pending.map(p => p.phase).join(',') || 'none'} hold=${hold}`;
        matrix.push([label, state(grants, pending, hold)]);
      }
    }
  }

  it(`A22 every one of ${matrix.length} presenter states is typographically clean, dossier-compliant, plural-correct and key-unique`, () => {
    for (const [label, journey] of matrix) {
      const view = presentOfflineJourney(journey);
      const texts = [
        view.badge,
        view.title,
        ...view.rows.flatMap(row => [row.label, row.value]),
        ...view.notes,
      ];
      for (const text of texts) {
        for (const pattern of [
          ...FORBIDDEN_COPY,
          ...RENDER_ARTIFACTS,
          ...PLURAL_DISAGREEMENT,
          ...TYPOGRAPHY_ARTIFACTS,
        ]) {
          if (pattern.test(text)) {
            throw new Error(`${label}: "${text}" matches ${pattern}`);
          }
        }
        if (text.length === 0) throw new Error(`${label}: empty text`);
      }
      for (const note of view.notes) {
        if (!/[.!?]$/.test(note))
          throw new Error(`${label}: note lacks terminal punctuation: ${note}`);
      }
      if (new Set(view.notes).size !== view.notes.length)
        throw new Error(
          `${label}: duplicate note keys ${view.notes.join(' | ')}`,
        );
      if (new Set(view.rows.map(row => row.label)).size !== view.rows.length)
        throw new Error(`${label}: duplicate row keys`);
      if (view.badge !== view.badge.toUpperCase())
        throw new Error(`${label}: badge not uppercase`);
    }
  });

  it('A23 no presenter state announces a live Pro pass unless a Pro lease is live, and no state hides held tickets behind a Pro label', () => {
    for (const [label, journey] of matrix) {
      if (journey.kind !== 'read') continue;
      const view = presentOfflineJourney(journey);
      const proLive = journey.allocation.grants.some(
        grant =>
          grant.entitlementSource === 'verified_store' &&
          grant.execution.kind === 'active',
      );
      const held = journey.allocation.spendableTickets;
      const spent = journey.allocation.consumedTickets;
      const allocationRow = view.rows.find(row => row.label === 'Allocation');
      if (view.title === 'Pro offline pass active' && !proLive)
        throw new Error(`${label}: claims a live Pro pass`);
      if (held + spent > 0 && allocationRow?.value === 'Pro pass')
        throw new Error(`${label}: hides ${held} of ${held + spent} tickets`);
      if (
        held + spent > 0 &&
        allocationRow &&
        allocationRow.value !== `${held} of ${held + spent} unspent`
      )
        throw new Error(`${label}: allocation row ${allocationRow.value}`);
      if (!proLive && held > 0 && view.badge === 'SPENT')
        throw new Error(`${label}: SPENT with ${held} held`);
      if (view.badge === 'READY' && journey.wallet.hold)
        throw new Error(`${label}: READY under a HOLD`);
    }
  });

  it('A24 every line of the rendered HOLD card is reachable by VoiceOver in reading order (label, then its value), nothing is hidden or clipped, and the badge is text, not colour alone', async () => {
    await holdGrant();
    await spend('op-1');
    await presentAndLoseConnection();
    const renderer = await render(<SettingsScreen />);
    await settle();
    const node = card(renderer);
    const hidden = node.findAll(
      candidate =>
        candidate.props.accessibilityElementsHidden === true ||
        candidate.props.importantForAccessibility === 'no-hide-descendants' ||
        candidate.props.accessible === false,
    );
    expect(hidden).toEqual([]);
    const texts = node.findAllByType(Text).map(text => ({
      text: String(text.props.children),
      clipped: typeof text.props.numberOfLines === 'number',
    }));
    const order = texts.map(entry => entry.text);
    for (const label of ['Allocation', 'Pass ends', 'Waiting to sync']) {
      const at = order.indexOf(label);
      expect(at).toBeGreaterThan(-1);
      expect(order[at + 1]).toMatch(/\S/);
    }
    expect(order[order.indexOf('Allocation') + 1]).toBe('1 of 2 unspent');
    expect(order[order.indexOf('Waiting to sync') + 1]).toBe('1 on hold');
    const badge = badgeOf(renderer);
    expect(badge).toBe('ON HOLD');
    // Notes are full sentences; none may be clipped to a line count.
    const clippedNotes = texts.filter(
      entry => entry.clipped && entry.text !== badge,
    );
    expect(clippedNotes).toEqual([]);
  });

  it('A25 a refused receipt (the server returned the ticket) leaves the card stating exactly the ledger’s counts and no HOLD', async () => {
    await holdGrant();
    await spend('op-1');
    serveReceipts('unused_ticket_returned');
    const drained = await reconcileOfflineWallet(db, grantClient(), AT_ISSUE);
    expect(drained.refused).toBe(1);
    const truth = await ledgerTruth();
    expect(truth.wallet.hold).toBe(false);
    expect(truth.pending).toHaveLength(0);
    const renderer = await render(<SettingsScreen />);
    await settle();
    const copy = textOf(card(renderer));
    const held = truth.allocation.spendableTickets;
    const total = held + truth.allocation.consumedTickets;
    expect(copy).toContain(`${held} of ${total} unspent`);
    expect(copy).toContain('Nothing');
    expect(badgeOf(renderer)).toBe(held > 0 ? 'READY' : 'SPENT');
    expectCleanCopy(copy);
  });
});
