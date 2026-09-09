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
import type { TrustedTimeReading } from '../src/data/trustedTime';
import type { CapturedClip } from '../src/camera/capture';

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

let mockCaptureImpl: () => Promise<CapturedClip> = () =>
  Promise.reject(new Error('capture is not part of this test'));
jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    captureStrokeVideo: () => mockCaptureImpl(),
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
} from '../src/data/offlineCapabilities';
import { reconcileOfflineWallet } from '../src/data/offlineWallet';
import {
  closeSqliteTestDatabases,
  createSqliteTestDb,
} from '../testSupport/sqlite';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
const INSTALLATION_KEY = 'ios-install-key-1';
const ISSUER = 'https://api.example.test/functions/v1/api';
const KEY_ID = 'offline-grant-key-1';
const ARTIFACT = { version: 'v1', sha256: 'a'.repeat(64) };
const ISSUED_AT = 1_800_000_000;
const SIX_DAYS_S = 6 * 24 * 60 * 60;
const EXPIRES_AT = ISSUED_AT + SIX_DAYS_S;
const TICKETS = [
  'aaaaaaaa-0000-4000-8000-000000000001',
  'aaaaaaaa-0000-4000-8000-000000000002',
] as const;
const GRANT_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
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

function grantResponse(
  entitlementSource: 'identity_lifetime_free' | 'verified_store',
): Record<string, unknown> {
  const free = entitlementSource === 'identity_lifetime_free';
  const claims = {
    schemaVersion: OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
    protocolVersion: OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
    iss: ISSUER,
    aud: OFFLINE_GRANT_AUDIENCE,
    sub: OWNER,
    jti: GRANT_ID,
    installationKeyId: INSTALLATION_KEY,
    iat: ISSUED_AT,
    exp: EXPIRES_AT,
    capabilities: ['analyze_joint_output'],
    release: {
      policy: ARTIFACT,
      mechanicsModel: ARTIFACT,
      benchmarkModel: ARTIFACT,
    },
    entitlementSource,
    ...(free
      ? {
          allocation: {
            schemaVersion: OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION,
            allocationId: GRANT_ID,
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
            verifiedEntitlementExpiresAt: EXPIRES_AT + SIX_DAYS_S,
          },
        }),
  };
  const header = { alg: 'ES256', typ: OFFLINE_GRANT_JWS_TYPE, kid: KEY_ID };
  const compactJws = `${base64Url(JSON.stringify(header))}.${base64Url(
    JSON.stringify(claims),
  )}.${'A'.repeat(86)}`;
  return {
    grantId: GRANT_ID,
    generation: 1,
    entitlementSource,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    entitlementExpiresAt: free ? null : EXPIRES_AT + SIX_DAYS_S,
    ticketIds: free ? TICKETS : [],
    keyId: KEY_ID,
    grant: { schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION, compactJws },
  };
}

function issuedGrant(
  entitlementSource: 'identity_lifetime_free' | 'verified_store' =
    'identity_lifetime_free',
): IssuedOfflineGrant {
  const parsed = parseIssuedOfflineGrant(grantResponse(entitlementSource));
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

async function holdGrant(
  entitlementSource: 'identity_lifetime_free' | 'verified_store' =
    'identity_lifetime_free',
) {
  await holdOfflineGrant(db, issuedGrant(entitlementSource), BINDING);
}

async function spend(operationId: string) {
  return consumeOfflineAllocation(db, consumption(operationId), AT_ISSUE);
}

/** Presents the queued receipts and loses the connection before any answer
 * arrives: the journal entry stays `in_flight`, which the wallet reports as a
 * HOLD. Exactly the shipping drain path (`reconcileOfflineWallet`). */
async function presentAndLoseConnection() {
  fetchSpy = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => {
      throw new TypeError('Network request failed');
    });
  await expect(
    reconcileOfflineWallet(
      db,
      createOfflineGrantClient({ baseUrl: ISSUER, token: 'access-token' }),
      AT_ISSUE,
    ),
  ).rejects.toThrow('Network request failed');
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
    await holdGrant('verified_store');
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
});

describe('W05-04 Analyze surfaces the offline journey', () => {
  it('shows the held allocation and lease on the ready screen', async () => {
    await holdGrant();
    await spend('op-1');
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
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('ON HOLD');
    expect(copy).toContain('1 on hold');
    expectDossierCompliant(copy);
  });

  it('never shows another account’s allocation', async () => {
    await holdGrant();
    await spend('op-1');
    setActiveDataOwner(OTHER_OWNER);
    establishApiSession({
      apiBaseUrl: 'https://api.test',
      bearerToken: 'token-2',
      canonicalAppUserId: OTHER_OWNER,
      provider: 'apple',
    });
    const renderer = await render(<AnalyzeScreen />);
    await settle();
    const copy = textOf(card(renderer));
    expect(badgeOf(renderer)).toBe('NONE HELD');
    expect(copy).not.toContain('1 of 2');
    expect(copy).not.toContain('waiting');
  });
});
