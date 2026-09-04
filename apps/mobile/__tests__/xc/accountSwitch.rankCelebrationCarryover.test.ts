/**
 * xc-journey-account-switch — FINDING PROBE (characterization pin).
 *
 * `useRankCelebrationStore` keeps the rank ceremony being shown (`current`)
 * or queued behind the walkthrough (`pending`) in module memory. Nothing in
 * `authStore.signOut()` / the owner switch clears it. The durable record is
 * owner-scoped and correct (`rank.celebrated:<owner>`), so this is purely
 * the IN-MEMORY overlay state — but it carries A's `PlayerRankSummary`
 * (rating, tier, technique count) across sign-out into B's session.
 *
 * Reachability: the ceremony is a blocking root Modal, so A cannot tap
 * Settings → Sign out while it shows. The reachable path is the IMPLICIT
 * sign-out — the session keeper's refresh is refused (401) while the Modal
 * is up (or while it is `pending` behind the walkthrough Modal). The device
 * then lands on the pre-auth flow with A's ceremony still mounted; when B
 * signs in on this device, B's first `maybeCelebrate` is suppressed by the
 * stale `current`/`pending` (`if (... get().current || get().pending)
 * return;`) AFTER B's record was already written — B's placement ceremony is
 * lost for good, and the overlay B dismisses shows A's rating.
 *
 * This file asserts the behaviour AS OBSERVED so the reproduction is pinned
 * and replayable. When `rankCelebration` clears `current`/`pending` on an
 * owner change, the assertions marked FINDING must be inverted (they will
 * fail, which is the signal that the finding is fixed).
 */
import { NativeModules } from 'react-native';
import * as Keychain from 'react-native-keychain';
import { useAuthStore } from '../../src/auth/authStore';
import { clearApiSession } from '../../src/account/apiSession';
import {
  refreshSessionNow,
  stopSessionKeeper,
} from '../../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
} from '../../src/data/accountScope';
import { getDb } from '../../src/data/db';
import { getKv } from '../../src/data/repository';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import { clearAccessStoreConfiguration } from '../../src/state/accessStore';
import { clearTrainingStoreConfiguration } from '../../src/training/store';
import {
  rankCelebrationKeyForOwner,
  useRankCelebrationStore,
} from '../../src/progress/rankCelebration';
import { useWalkthroughStore } from '../../src/walkthrough/walkthroughStore';
import {
  IDENTITY_A,
  IDENTITY_B,
  OWNER_A,
  OWNER_B,
  RANK_GOLD,
  RANK_SILVER,
  writeEvidence,
} from '../../testing/xc-account-switch/fixtures';
import {
  openRealSqlite,
  type RealSqliteHandle,
} from '../../testing/xc-account-switch/realSqlite';
import { FakeAccountServer } from '../../testing/xc-account-switch/fakeServer';

let mockHandle: RealSqliteHandle | null = null;
jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    if (!mockHandle) throw new Error('real sqlite handle not opened');
    return mockHandle;
  },
}));

const mockGoogleSignin = {
  configure: jest.fn(),
  hasPlayServices: jest.fn(),
  signIn: jest.fn(),
  signInSilently: jest.fn(),
  hasPreviousSignIn: jest.fn(),
  signOut: jest.fn(),
  revokeAccess: jest.fn(),
};
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: mockGoogleSignin,
}));

jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));

jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: 'test-ios-client.apps.googleusercontent.com',
    googleWebClientId: 'test-web-client.apps.googleusercontent.com',
    appVersion: '1.0',
  }),
}));

jest.mock('../../src/account/deviceContext', () => ({
  getAccountBootstrapEnvironment: () => ({
    locale: 'en-US',
    timezone: 'America/Los_Angeles',
    device: {
      platform: 'ios',
      osVersion: '18.5',
      appVersion: '1.0',
      model: 'iOS phone',
    },
  }),
}));

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

const nativeModules = NativeModules as { PickleAuth?: unknown };
const server = new FakeAccountServer();
let realFetch: typeof fetch;

const evidence: {
  engine: string | null;
  scenarios: Array<Record<string, unknown>>;
} = { engine: null, scenarios: [] };

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  rounds = 200,
): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    if (await predicate()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function resetRuntime(): void {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  clearAccessStoreConfiguration();
  clearTrainingStoreConfiguration();
  useAuthStore.setState({
    hydrated: true,
    session: null,
    busy: false,
    error: null,
    deletionCleanup: null,
  });
  useRankCelebrationStore.setState({ current: null, pending: null });
  useWalkthroughStore.setState({ visible: false, queued: false });
}

/** A is signed in and the server then refuses A's refresh token. */
async function implicitSignOutOfA(): Promise<void> {
  server.revokeRefresh('A');
  refreshSessionNow();
  await waitFor(
    () => getActiveDataOwner() === SIGNED_OUT_DATA_OWNER,
    'implicit sign-out of A',
  );
  expect(useAuthStore.getState().session).toBeNull();
}

beforeAll(() => {
  mockHandle = openRealSqlite();
  evidence.engine = mockHandle.engine;
  realFetch = server.install();
  nativeModules.PickleAuth = {
    signInWithApple: jest.fn().mockResolvedValue({
      user: 'apple-user-opaque',
      identityToken: 'apple-identity-token',
      authorizationCode: 'one-use-apple-code',
      email: IDENTITY_A.email,
      givenName: 'Ada',
      familyName: 'Alpha',
    }),
  };
  mockGoogleSignin.hasPlayServices.mockResolvedValue(true);
  mockGoogleSignin.signOut.mockResolvedValue(null);
  mockGoogleSignin.revokeAccess.mockResolvedValue(null);
  mockGoogleSignin.hasPreviousSignIn.mockReturnValue(false);
  mockGoogleSignin.signIn.mockResolvedValue({
    type: 'success',
    data: {
      user: {
        id: 'google-uid-b',
        name: IDENTITY_B.displayName,
        email: IDENTITY_B.email,
      },
      idToken: 'google-id-token',
    },
  });
  __keychainStore.clear();
  resetRuntime();
});

afterAll(() => {
  resetRuntime();
  delete nativeModules.PickleAuth;
  globalThis.fetch = realFetch;
  const path = writeEvidence('rank-celebration-carryover.json', evidence);
  console.log(`[xc] rank celebration carry-over evidence → ${path}`);
  try {
    getDb().close();
  } catch {
    // best effort
  }
  mockHandle?.close();
});

beforeEach(async () => {
  resetRuntime();
  __keychainStore.clear();
  // Fresh durable records for both owners each scenario.
  const db = getDb();
  await db.execute('DELETE FROM kv WHERE key LIKE ?', ['rank.celebrated:%']);
});

describe('xc account switch — rank ceremony overlay state across an owner change', () => {
  it('durable record is owner-scoped: A gold, B silver, both placements (control)', async () => {
    await useAuthStore.getState().signInWithApple();
    expect(getActiveDataOwner()).toBe(OWNER_A);
    await useRankCelebrationStore.getState().maybeCelebrate(RANK_GOLD);
    expect(useRankCelebrationStore.getState().current?.toTier).toBe('gold');
    // A dismisses the Modal, then signs out explicitly.
    useRankCelebrationStore.getState().dismiss();
    await useAuthStore.getState().signOut();
    expect(useRankCelebrationStore.getState().current).toBeNull();

    await useAuthStore.getState().signInWithGoogle();
    expect(getActiveDataOwner()).toBe(OWNER_B);
    await useRankCelebrationStore.getState().maybeCelebrate(RANK_SILVER);
    const current = useRankCelebrationStore.getState().current;
    expect(current).toMatchObject({
      fromTier: null,
      toTier: 'silver',
      summary: { rating: RANK_SILVER.rating },
    });
    expect(await getKv(getDb(), rankCelebrationKeyForOwner(OWNER_A))).toContain(
      '"gold"',
    );
    expect(await getKv(getDb(), rankCelebrationKeyForOwner(OWNER_B))).toContain(
      '"silver"',
    );
    evidence.scenarios.push({
      scenario: 'control: A dismisses before explicit sign-out',
      bCurrent: current,
      leaked: false,
    });
  });

  it('FINDING: ceremony showing during an implicit sign-out survives into B and suppresses B placement', async () => {
    await useAuthStore.getState().signInWithApple();
    await useRankCelebrationStore.getState().maybeCelebrate(RANK_GOLD);
    expect(useRankCelebrationStore.getState().current?.toTier).toBe('gold');

    // The server refuses A's refresh while the ceremony Modal is up.
    await implicitSignOutOfA();

    // Observed: the overlay is still A's after sign-out.
    const afterSignOut = useRankCelebrationStore.getState().current;
    expect(afterSignOut).toMatchObject({
      toTier: 'gold',
      summary: { rating: RANK_GOLD.rating },
    }); // FINDING — expected: null

    await useAuthStore.getState().signInWithGoogle();
    expect(getActiveDataOwner()).toBe(OWNER_B);
    // Home resolves B's rank while A's ceremony is still mounted.
    await useRankCelebrationStore.getState().maybeCelebrate(RANK_SILVER);
    const bCurrent = useRankCelebrationStore.getState().current;
    const bRecord = await getKv(getDb(), rankCelebrationKeyForOwner(OWNER_B));

    // Observed: what B sees is A's summary; B's record is already written so
    // B's placement can never fire again.
    expect(bCurrent).toMatchObject({
      toTier: 'gold',
      summary: { rating: RANK_GOLD.rating, techniqueCount: 1 },
    }); // FINDING — expected: { fromTier: null, toTier: 'silver' }
    expect(bRecord).toContain('"silver"');
    useRankCelebrationStore.getState().dismiss();
    await useRankCelebrationStore.getState().maybeCelebrate(RANK_SILVER);
    expect(useRankCelebrationStore.getState().current).toBeNull(); // FINDING — B never gets a placement ceremony

    // The durable side stayed isolated (A's record untouched).
    expect(await getKv(getDb(), rankCelebrationKeyForOwner(OWNER_A))).toContain(
      '"gold"',
    );
    evidence.scenarios.push({
      scenario: 'implicit sign-out while ceremony showing',
      afterSignOutCurrent: afterSignOut,
      bCurrent,
      bRecord,
      bPlacementFiredLater: false,
      leaked: true,
    });
  });

  it('FINDING: ceremony PENDING behind the walkthrough during an implicit sign-out is raised for B', async () => {
    await useAuthStore.getState().signInWithApple();
    useWalkthroughStore.setState({ visible: true, queued: false });
    await useRankCelebrationStore.getState().maybeCelebrate(RANK_GOLD);
    expect(useRankCelebrationStore.getState().current).toBeNull();
    expect(useRankCelebrationStore.getState().pending?.toTier).toBe('gold');

    await implicitSignOutOfA();
    await useAuthStore.getState().signInWithGoogle();
    expect(getActiveDataOwner()).toBe(OWNER_B);
    // Observed: still A's pending ceremony on B's session.
    expect(useRankCelebrationStore.getState().pending?.toTier).toBe('gold'); // FINDING — expected: null

    // B dismisses the walkthrough: A's ceremony is raised on B's screen.
    useWalkthroughStore.getState().dismiss();
    const raised = useRankCelebrationStore.getState().current;
    expect(raised).toMatchObject({
      toTier: 'gold',
      summary: { rating: RANK_GOLD.rating },
    }); // FINDING — expected: null / B's own placement
    evidence.scenarios.push({
      scenario: 'implicit sign-out while ceremony pending behind walkthrough',
      raisedForB: raised,
      leaked: true,
    });
  });
});
