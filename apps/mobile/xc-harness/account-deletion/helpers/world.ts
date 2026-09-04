/**
 * Runtime world for the deletion-journey harness: real authStore, real
 * SQLite-backed repository, real notification/consent/app stores, one fake
 * Edge Function, one fake OS notification scheduler and the Jest Keychain
 * mock. Test files own the `jest.mock` declarations (they must be hoisted in
 * the test module); this module only wires and inspects the real stores.
 */
import * as Keychain from 'react-native-keychain';
import { NativeModules } from 'react-native';
import { useAuthStore } from '../../../src/auth/authStore';
import { stopSessionKeeper } from '../../../src/account/sessionKeeper';
import { clearSyncRuntime } from '../../../src/data/syncRuntime';
import {
  clearApiSession,
  getApiSession,
} from '../../../src/account/apiSession';
import {
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { getDb } from '../../../src/data/db';
import { useAppStore } from '../../../src/state/appStore';
import { useNotificationStore } from '../../../src/notifications/notificationStore';
import { DEFAULT_NOTIFICATION_PREFS } from '../../../src/notifications/types';
import { useConsentStore } from '../../../src/state/consentStore';
import { useAccessStore } from '../../../src/state/accessStore';
import { FakeEdge, type FakeEdgeOptions } from './fakeEdge';
import { sqliteHandle } from './sqliteSingleton';
import { scheduler } from './schedulerSingleton';

export { sqliteHandle, scheduler };

export const SESSION_VAULT_SERVICE = 'com.picklesensei.auth.session';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

export interface World {
  edge: FakeEdge;
  clock: { nowMs: number };
}

const clock = { nowMs: Date.parse('2026-09-04T12:00:00.000Z') };
let edge: FakeEdge = new FakeEdge({ seed: 'unset', now: () => clock.nowMs });

export function currentEdge(): FakeEdge {
  return edge;
}

export function advanceClock(ms: number): void {
  clock.nowMs += ms;
}

/** Installed once per test file: routes `globalThis.fetch` to the current
 * fake edge so every real client (deletion, bootstrap, refresh, consent,
 * sync transport, access) hits the same stateful server. */
export function installGlobalFetch(): void {
  globalThis.fetch = ((url: string, init?: RequestInit) =>
    edge.fetch(url, init)) as typeof fetch;
}

export function installNativeAuth(subject: string): void {
  (NativeModules as { PickleAuth?: unknown }).PickleAuth = {
    signInWithApple: async () => ({
      user: subject,
      identityToken: `token-for:${subject}`,
      authorizationCode: `one-use-code-${subject}`,
      email: `${subject}@privaterelay.example`,
      givenName: 'Pat',
      familyName: 'Player',
    }),
  };
}

function closeDbIfOpen(): void {
  try {
    getDb().close();
  } catch {
    // No database yet.
  }
}

/** New device: empty SQLite, empty Keychain, new server unless `keepServer`. */
export function resetWorld(
  options: Partial<FakeEdgeOptions> & { seed: string; keepServer?: boolean },
): World {
  clock.nowMs = Date.parse('2026-09-04T12:00:00.000Z');
  if (!options.keepServer) {
    edge = new FakeEdge({ ...options, now: () => clock.nowMs });
  }
  closeDbIfOpen();
  sqliteHandle.reset();
  sqliteHandle.failOn = null;
  sqliteHandle.failRemaining = null;
  __keychainStore.clear();
  scheduler.permission = 'granted';
  scheduler.requestCalls = 0;
  scheduler.cancelAllCalls = 0;
  scheduler.appliedPlans = [];
  scheduler.pending = [];
  relaunchProcess();
  return { edge, clock };
}

/** Same device, new process: every in-memory store is back to its module
 * initial state; SQLite and Keychain contents persist. */
export function relaunchProcess(): void {
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  closeDbIfOpen();
  useAuthStore.setState({
    hydrated: false,
    session: null,
    busy: false,
    error: null,
    deletionCleanup: null,
  });
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
    lastShotType: 'forehand_drive',
  });
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: DEFAULT_NOTIFICATION_PREFS,
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
  });
  useConsentStore.setState({
    availability: 'loading',
    modelTrainingActive: false,
    lastActionAt: null,
    busy: false,
    error: null,
  });
  useAccessStore.setState({
    status: 'unconfigured',
    canonicalAccess: null,
    error: null,
  });
}

export function keychainSnapshot(): Array<{
  service: string;
  username: string;
  /** Field names only — never the values. */
  passwordFields: string[];
}> {
  return [...__keychainStore.entries()].map(([service, item]) => {
    let fields: string[] = [];
    try {
      const parsed = JSON.parse(item.password) as Record<string, unknown>;
      fields = Object.keys(parsed);
    } catch {
      fields = ['<opaque>'];
    }
    return { service, username: item.username, passwordFields: fields };
  });
}

export function processSnapshot() {
  const auth = useAuthStore.getState();
  const app = useAppStore.getState();
  const notifications = useNotificationStore.getState();
  const consent = useConsentStore.getState();
  const api = getApiSession();
  return {
    activeOwner: getActiveDataOwner(),
    auth: {
      hydrated: auth.hydrated,
      session: auth.session
        ? {
            provider: auth.session.provider,
            canonicalAppUserId: auth.session.canonicalAppUserId,
            localOnly: auth.session.localOnly,
          }
        : null,
      error: auth.error,
      deletionCleanup: auth.deletionCleanup,
    },
    apiSession: api
      ? {
          canonicalAppUserId: api.canonicalAppUserId,
          hasRefreshToken: Boolean(api.refreshToken),
        }
      : null,
    app: {
      hydrated: app.hydrated,
      ownerKey: app.ownerKey,
      hasProfile: app.profile !== null,
    },
    notifications: {
      ownerKey: notifications.ownerKey,
      prefs: notifications.prefs,
    },
    consent: {
      availability: consent.availability,
      modelTrainingActive: consent.modelTrainingActive,
    },
    scheduler: {
      cancelAllCalls: scheduler.cancelAllCalls,
      pendingCount: scheduler.pending.length,
    },
    keychain: keychainSnapshot(),
  };
}

export function heapNumbers() {
  const usage = process.memoryUsage();
  return {
    rssMb: Math.round((usage.rss / 1024 / 1024) * 10) / 10,
    heapUsedMb: Math.round((usage.heapUsed / 1024 / 1024) * 10) / 10,
    heapTotalMb: Math.round((usage.heapTotal / 1024 / 1024) * 10) / 10,
  };
}
