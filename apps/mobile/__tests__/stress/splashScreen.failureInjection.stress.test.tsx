import React from 'react';
import { AccessibilityInfo, AppState, StatusBar, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * STRESS — scr-splashscreen · lens: failure-injection.
 *
 * Mounts the REAL App (SafeAreaProvider → QueryClientProvider →
 * RootErrorBoundary → Gate with the real auth/app/notification/consistency
 * stores, the real Welcome / SignIn screens, the real LoadingState /
 * ErrorState, and the real SplashScreen) and injects faults into every
 * dependency the intro touches while it is on screen:
 *
 *   native video player (react-native-video callbacks) · reduce-motion
 *   accessibility query · wall clock · Keychain · SQLite · fetch (launch
 *   refresh) · Google Sign-In SDK (legacy silent restore) · notification
 *   scheduler · StatusBar native stack · mount/unmount/AppState lifecycle
 *
 * Only native modules, `fetch` and process edges are doubled (see
 * `stress-harness/splash/faults.ts`); RootNavigator and OnboardingScreen are
 * text stubs exactly like every existing App-mounting suite, because the
 * navigator needs react-native-screens which has no jest runtime.
 *
 * Every iteration advances fake timers ≥ 60 s and records: whether the splash
 * got out of the way, whether a visible recovery control exists when
 * something failed, that completion fired at most once, that touches pass
 * through during the exit, that persisted state was not corrupted, and that
 * nothing failed silently (unhandled rejections, console errors).
 *
 * Scale knobs (all optional):
 *   STRESS_ITER=<n>            seeded random fault mixes on top of the sweep
 *                              (default 12; the campaign used 500)
 *   STRESS_SEED=<seed>         replay one seeded iteration
 *   STRESS_FAULT=<id[,id..]>  replay one catalogue sweep row / a fault set
 *   STRESS_INSTALL=<install>  install kind for STRESS_FAULT (default: sweep's)
 *   STRESS_ARTIFACT_DIR=<dir>  where the JSON/markdown tables go
 *                              (default <repo>/artifacts/stress-splash/)
 */

import {
  FAULT_CATALOG,
  FaultWorld,
  INSTALL_KINDS,
  defaultInstallFor,
  faultApplies,
  faultById,
  faultsConflict,
  makePrng,
  pick,
  type FaultSpec,
  type InstallKind,
} from '../../stress-harness/splash/faults';
import {
  fs,
  nodeProcess,
  path,
} from '../../xc-harness/lifecycle-persistence/nodeShim';

declare const __dirname: string;

// Unhandled promise rejections: the sandboxed `process` Jest hands a test file
// never receives Node's 'unhandledRejection' (jest#5620), so they cannot be
// recorded on a row. jest-circus instead fails the running test with the
// rejection's stack, which is a stricter oracle: a green run proves that no
// injected fault escaped a store as an unhandled rejection.

// ─── Module seams (native / process edges only) ──────────────────────────────

const API_BASE = 'https://api.example.test';
const mockWorld = { current: new FaultWorld(API_BASE) };

jest.mock('../../src/data/db', () => ({
  getDb: () => mockWorld.current.db.handle(),
}));

jest.mock('react-native-keychain', () => ({
  get ACCESSIBLE() {
    return mockWorld.current.keychain.module().ACCESSIBLE;
  },
  setGenericPassword: (...args: unknown[]) =>
    (
      mockWorld.current.keychain.module().setGenericPassword as (
        ...a: unknown[]
      ) => unknown
    )(...args),
  getGenericPassword: (...args: unknown[]) =>
    (
      mockWorld.current.keychain.module().getGenericPassword as (
        ...a: unknown[]
      ) => unknown
    )(...args),
  resetGenericPassword: (...args: unknown[]) =>
    (
      mockWorld.current.keychain.module().resetGenericPassword as (
        ...a: unknown[]
      ) => unknown
    )(...args),
}));

jest.mock('@react-native-google-signin/google-signin', () => ({
  get GoogleSignin() {
    return mockWorld.current.google.module().GoogleSignin;
  },
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
    legalPrivacyUrl: null,
    legalTermsUrl: null,
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
jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => {
    const scheduler = mockWorld.current.scheduler;
    return scheduler.port();
  },
  screenTargetFromNotificationData: () => null,
  subscribeToNotificationPresses: () => () => {},
  registerBackgroundNotificationHandler: () => {},
}));

jest.mock('react-native-safe-area-context', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  const passthrough = (props: { children?: React.ReactNode }) =>
    R.createElement(RN.View, null, props.children);
  return {
    SafeAreaProvider: passthrough,
    SafeAreaView: passthrough,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: {
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 0, bottom: 0, left: 0, right: 0 },
    },
  };
});
jest.mock('react-native-svg', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  const Mock = (props: { children?: React.ReactNode }) =>
    R.createElement(RN.View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Line: Mock,
    Path: Mock,
    Polyline: Mock,
    Polygon: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    RadialGradient: Mock,
    Stop: Mock,
    G: Mock,
    Ellipse: Mock,
    Text: Mock,
    TSpan: Mock,
  };
});
jest.mock('../../src/navigation/RootNavigator', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    RootNavigator: () => R.createElement(RN.Text, null, 'ROOT_NAVIGATOR'),
  };
});
jest.mock('../../src/screens/OnboardingScreen', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    OnboardingScreen: () => R.createElement(RN.Text, null, 'ONBOARDING'),
  };
});

import App, { RootErrorBoundary } from '../../App';
import {
  EXIT_MS,
  SKIP_AFTER_S,
  SplashScreen,
  WATCHDOG_MS,
} from '../../src/screens/SplashScreen';
import { useAuthStore } from '../../src/auth/authStore';
import { useAppStore } from '../../src/state/appStore';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { useConsistencyStore } from '../../src/consistency/store';
import { useWalkthroughStore } from '../../src/walkthrough/walkthroughStore';
import { clearApiSession } from '../../src/account/apiSession';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';

// ─── Constants ───────────────────────────────────────────────────────────────

const VAULT_SERVICE = 'com.picklesensei.auth.session';
const CANONICAL_ID = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const CANONICAL_OWNER = canonicalDataOwner(CANONICAL_ID);
const INITIAL_REFRESH = 'refresh-initial';
const HORIZON_MIN_MS = 60_000;
const SLICE_MS = 100;
const COARSE_SLICE_MS = 500;
const COARSE_AFTER_MS = 12_000;

const validProfile = {
  skillLevel: 'intermediate',
  handedness: 'right',
  goal: 'consistency',
  biggestProblem: 'popups',
  focusCheckpoint: 'contact_point',
};

function vaultRecord(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    provider: 'apple',
    canonicalAppUserId: CANONICAL_ID,
    refreshToken: INITIAL_REFRESH,
    email: 'pat@example.com',
    displayName: 'Pat Player',
    ...overrides,
  });
}

// ─── Scenario space ──────────────────────────────────────────────────────────

interface Scenario {
  name: string;
  seed: number | null;
  install: InstallKind;
  faults: string[];
  /** Press "Skip" the first slice at/after this ms in which it is visible. */
  skipAtMs: number | null;
  /** Natural playback length (ms) when no video fault dictates otherwise. */
  playbackMs: number;
  horizonMs: number;
}

type VideoEvent =
  | { at: number; type: 'progress'; payload: unknown }
  | { at: number; type: 'end' }
  | { at: number; type: 'error'; payload: unknown };

type Action =
  | { at: number; kind: 'clock-jump'; deltaMs: number; relativeToExit: boolean }
  | { at: number; kind: 'a11y'; value: unknown }
  | { at: number; kind: 'unmount' }
  | { at: number; kind: 'remount' }
  | { at: number; kind: 'appstate'; state: 'background' | 'active' }
  | { at: number; kind: 'video-after-unmount' };

function progressPayload(seconds: unknown): Record<string, unknown> {
  return { currentTime: seconds, playableDuration: 5, seekableDuration: 5 };
}

function normalPlayback(playbackMs: number, intervalMs = 100): VideoEvent[] {
  const events: VideoEvent[] = [];
  for (let t = intervalMs; t <= playbackMs; t += intervalMs) {
    events.push({
      at: t,
      type: 'progress',
      payload: progressPayload(t / 1000),
    });
  }
  events.push({ at: playbackMs, type: 'end' });
  return events;
}

interface Plan {
  video: VideoEvent[];
  actions: Action[];
}

/** Turns the armed fault ids into a video script, scheduled actions and the
 * world's knobs. Pure given (scenario, world). */
function arm(scenario: Scenario, world: FaultWorld): Plan {
  const ids = new Set(scenario.faults);
  let video: VideoEvent[] = normalPlayback(scenario.playbackMs);
  const actions: Action[] = [];
  const nativeError = {
    error: { code: -11800, domain: 'AVFoundationErrorDomain' },
  };

  // ── video
  if (ids.has('video.error-immediate')) {
    video = [{ at: 0, type: 'error', payload: nativeError }];
  } else if (ids.has('video.error-after-2s')) {
    video = normalPlayback(2000).filter(e => e.type !== 'end');
    video.push({ at: 2000, type: 'error', payload: nativeError });
  } else if (ids.has('video.error-undefined-payload')) {
    video = [{ at: 300, type: 'error', payload: undefined }];
  } else if (ids.has('video.error-string-payload')) {
    video = [
      { at: 300, type: 'error', payload: 'AVFoundationErrorDomain -11800' },
    ];
  } else if (ids.has('video.stall-no-events')) {
    video = [];
  } else if (ids.has('video.stall-after-first-frame')) {
    video = [{ at: 200, type: 'progress', payload: progressPayload(0.2) }];
  } else if (ids.has('video.progress-nan')) {
    video = normalPlayback(scenario.playbackMs).map(e =>
      e.type === 'progress' ? { ...e, payload: progressPayload(NaN) } : e,
    );
  } else if (ids.has('video.progress-negative')) {
    video = [
      { at: 100, type: 'progress', payload: progressPayload(-5) },
      { at: 200, type: 'progress', payload: progressPayload(-1) },
      ...normalPlayback(scenario.playbackMs).filter(e => e.at > 200),
    ];
  } else if (ids.has('video.progress-empty-object')) {
    video = normalPlayback(scenario.playbackMs).map(e =>
      e.type === 'progress' ? { ...e, payload: {} } : e,
    );
  } else if (ids.has('video.progress-string-time')) {
    video = normalPlayback(scenario.playbackMs).map(e =>
      e.type === 'progress' ? { ...e, payload: progressPayload('2.5') } : e,
    );
  } else if (ids.has('video.progress-huge')) {
    video = [
      { at: 100, type: 'progress', payload: progressPayload(1e12) },
      ...normalPlayback(scenario.playbackMs).filter(e => e.at > 100),
    ];
  } else if (ids.has('video.progress-out-of-order')) {
    video = [3, 1, 2, 0, 4].map((s, i) => ({
      at: 100 * (i + 1),
      type: 'progress' as const,
      payload: progressPayload(s),
    }));
    video.push({ at: 600, type: 'end' });
  } else if (ids.has('video.progress-flood')) {
    video = [];
    for (let i = 0; i < 600; i += 1) {
      video.push({
        at: Math.floor(i / 60) * 100,
        type: 'progress',
        payload: progressPayload(i / 120),
      });
    }
    video.push(...normalPlayback(scenario.playbackMs).filter(e => e.at > 1000));
  } else if (ids.has('video.end-at-0ms')) {
    video = [{ at: 0, type: 'end' }];
  } else if (ids.has('video.end-twice')) {
    video = normalPlayback(scenario.playbackMs);
    video.push({ at: scenario.playbackMs + 100, type: 'end' });
  } else if (ids.has('video.end-then-error')) {
    video = normalPlayback(scenario.playbackMs);
    video.push({
      at: scenario.playbackMs + 50,
      type: 'error',
      payload: nativeError,
    });
  } else if (ids.has('video.error-then-end')) {
    video = normalPlayback(1000).filter(e => e.type !== 'end');
    video.push({ at: 1000, type: 'error', payload: nativeError });
    video.push({ at: 1050, type: 'end' });
  } else if (ids.has('video.late-end-30s')) {
    video = normalPlayback(1000).filter(e => e.type !== 'end');
    video.push({ at: 30_000, type: 'end' });
  } else if (ids.has('video.end-at-watchdog-tick')) {
    video = normalPlayback(WATCHDOG_MS, 100).filter(e => e.type !== 'end');
    video.push({ at: WATCHDOG_MS, type: 'end' });
  } else if (ids.has('video.progress-after-exit')) {
    video = [];
    for (let t = 100; t <= 20_000; t += 100) {
      video.push({
        at: t,
        type: 'progress',
        payload: progressPayload(t / 1000),
      });
    }
    video.push({ at: scenario.playbackMs, type: 'end' });
  } else if (ids.has('video.first-progress-at-7.9s')) {
    video = [
      {
        at: WATCHDOG_MS - 100,
        type: 'progress',
        payload: progressPayload(1.5),
      },
      { at: WATCHDOG_MS + 2000, type: 'end' },
    ];
  } else if (ids.has('video.callbacks-after-unmount')) {
    video = normalPlayback(scenario.playbackMs);
    actions.push({
      at: scenario.playbackMs + EXIT_MS + 1000,
      kind: 'video-after-unmount',
    });
  }

  // ── reduce motion
  if (ids.has('a11y.reduce-motion-true')) {
    actions.push({ at: 0, kind: 'a11y', value: true });
  }
  if (ids.has('a11y.reduce-motion-flip-mid-exit')) {
    actions.push({ at: 200, kind: 'a11y', value: true }); // relative to exit — resolved below
    actions[actions.length - 1] = {
      at: -200, // sentinel: 200 ms after the exit starts
      kind: 'a11y',
      value: true,
    };
  }
  if (ids.has('a11y.reduce-motion-storm')) {
    for (let i = 0; i < 50; i += 1) {
      actions.push({ at: 100 + i * 60, kind: 'a11y', value: i % 2 === 0 });
    }
  }
  if (ids.has('a11y.reduce-motion-event-null')) {
    actions.push({ at: 300, kind: 'a11y', value: null });
    actions.push({ at: 400, kind: 'a11y', value: undefined });
  }
  if (ids.has('a11y.reduce-motion-event-string')) {
    actions.push({ at: 300, kind: 'a11y', value: 'true' });
  }

  // ── clock
  if (ids.has('clock.jump-forward-1h-mid-fade')) {
    actions.push({
      at: 100,
      kind: 'clock-jump',
      deltaMs: 3_600_000,
      relativeToExit: true,
    });
  }
  if (ids.has('clock.jump-backward-5s-mid-fade')) {
    actions.push({
      at: 100,
      kind: 'clock-jump',
      deltaMs: -5_000,
      relativeToExit: true,
    });
  }
  if (ids.has('clock.jump-backward-1h-mid-fade')) {
    actions.push({
      at: 100,
      kind: 'clock-jump',
      deltaMs: -3_600_000,
      relativeToExit: true,
    });
  }
  if (ids.has('clock.jump-backward-1h-during-playback')) {
    actions.push({
      at: 500,
      kind: 'clock-jump',
      deltaMs: -3_600_000,
      relativeToExit: false,
    });
  }
  if (ids.has('clock.jump-forward-1d-at-launch')) {
    actions.push({
      at: 50,
      kind: 'clock-jump',
      deltaMs: 86_400_000,
      relativeToExit: false,
    });
  }

  // ── keychain
  const kc = world.keychain;
  if (ids.has('keychain.get-throws-sync')) kc.faults.get = 'throw';
  if (ids.has('keychain.get-rejects')) kc.faults.get = 'reject';
  if (ids.has('keychain.get-never-resolves')) kc.faults.get = 'never';
  if (ids.has('keychain.get-slow-5s')) {
    kc.faults.get = 'slow';
    kc.faults.getDelayMs = 5_000;
  }
  if (ids.has('keychain.get-slow-30s')) {
    kc.faults.get = 'slow';
    kc.faults.getDelayMs = 30_000;
  }
  const setVault = (password: string) =>
    kc.store.set(VAULT_SERVICE, { username: 'session', password });
  if (ids.has('keychain.record-not-json')) setVault('definitely not json');
  if (ids.has('keychain.record-truncated'))
    setVault('{"version":1,"provider":"app');
  if (ids.has('keychain.record-wrong-shape')) {
    setVault(vaultRecord({ version: 2, refreshToken: 12345 }));
  }
  if (ids.has('keychain.record-non-uuid-account')) {
    setVault(vaultRecord({ canonicalAppUserId: 'not-a-uuid' }));
  }
  if (ids.has('keychain.reset-rejects')) {
    setVault('definitely not json');
    kc.faults.reset = 'reject';
  }

  // ── sqlite
  const db = world.db;
  const profileKey = `profile:${
    scenario.install === 'existing-guest' ? 'device-guest' : CANONICAL_OWNER
  }`;
  if (ids.has('sqlite.open-throws')) db.faults.open = 'throw';
  if (ids.has('sqlite.get-rejects-all')) db.faults.get = 'reject';
  if (ids.has('sqlite.get-rejects-profile-only')) {
    db.faults.get = 'reject';
    db.faults.getKeys = [profileKey];
  }
  if (ids.has('sqlite.get-never-resolves')) db.faults.get = 'never';
  if (ids.has('sqlite.get-never-resolves-profile-only')) {
    db.faults.get = 'never';
    db.faults.getKeys = [profileKey];
  }
  if (ids.has('sqlite.get-slow-5s')) {
    db.faults.get = 'slow';
    db.faults.getDelayMs = 5_000;
  }
  if (ids.has('sqlite.get-slow-20s')) {
    db.faults.get = 'slow';
    db.faults.getDelayMs = 20_000;
    db.faults.getOnce = true;
  }
  if (ids.has('sqlite.rows-undefined')) db.faults.rows = 'rows-undefined';
  if (ids.has('sqlite.row-without-value')) db.faults.rows = 'row-without-value';
  if (ids.has('sqlite.value-object')) db.faults.rows = 'value-object';
  if (ids.has('sqlite.profile-not-json'))
    db.kv.set(profileKey, 'definitely not json');
  if (ids.has('sqlite.profile-truncated'))
    db.kv.set(profileKey, '{"skillLevel":"inter');
  if (ids.has('sqlite.local-mode-not-json'))
    db.kv.set('auth.local-mode', 'not json');
  if (ids.has('sqlite.set-rejects')) db.faults.set = 'reject';
  if (ids.has('sqlite.set-never-resolves')) db.faults.set = 'never';
  if (ids.has('sqlite.all-reject-after-open')) db.faults.allReject = true;

  // ── fetch
  const server = world.server;
  if (ids.has('fetch.refresh-401')) server.mode = 'refuse-401';
  if (ids.has('fetch.refresh-403')) server.mode = 'refuse-403';
  if (ids.has('fetch.refresh-500')) server.mode = 'error-500';
  if (ids.has('fetch.refresh-429')) server.mode = 'error-429';
  if (ids.has('fetch.network-error')) server.mode = 'network';
  if (ids.has('fetch.hang')) server.mode = 'hang';
  if (ids.has('fetch.malformed-200')) server.mode = 'malformed-200';
  if (ids.has('fetch.partial-200')) server.mode = 'partial-200';
  if (ids.has('fetch.slow-9s')) server.latencyMs = 9_000;
  if (ids.has('fetch.throws-sync')) server.mode = 'throw-sync';
  if (ids.has('fetch.undefined')) world.fetchUndefined = true;

  // ── google
  const google = world.google;
  if (ids.has('google.silent-rejects')) google.silent = 'reject';
  if (ids.has('google.silent-throws-sync')) google.silent = 'throw-sync';
  if (ids.has('google.silent-never-resolves')) google.silent = 'never';
  if (ids.has('google.silent-slow-20s')) {
    google.silent = 'slow';
    google.silentDelayMs = 20_000;
  }
  if (ids.has('google.silent-success-no-token'))
    google.silent = 'success-no-token';
  if (ids.has('google.configure-throws')) google.configureThrows = true;

  // ── scheduler
  if (ids.has('scheduler.module-missing')) world.scheduler.moduleMissing = true;
  if (ids.has('scheduler.permission-rejects'))
    world.scheduler.permissionRejects = true;
  if (ids.has('scheduler.apply-never')) world.scheduler.applyNever = true;

  // ── statusbar
  if (ids.has('statusbar.push-throws')) world.statusBar.pushThrows = true;
  if (ids.has('statusbar.pop-throws')) world.statusBar.popThrows = true;

  // ── lifecycle
  if (ids.has('lifecycle.unmount-mid-fade')) {
    actions.push({ at: -200, kind: 'unmount' }); // sentinel: 200 ms after exit starts
  }
  if (ids.has('lifecycle.unmount-before-watchdog')) {
    actions.push({ at: 3_000, kind: 'unmount' });
  }
  if (ids.has('lifecycle.remount-at-2s')) {
    actions.push({ at: 2_000, kind: 'remount' });
  }
  if (ids.has('lifecycle.remount-storm')) {
    for (let i = 0; i < 12; i += 1) {
      actions.push({ at: 300 + i * 150, kind: 'remount' });
    }
  }
  if (ids.has('lifecycle.background-during-intro')) {
    actions.push({ at: 1_000, kind: 'appstate', state: 'background' });
    actions.push({ at: 3_000, kind: 'appstate', state: 'active' });
  }

  video.sort((a, b) => a.at - b.at);
  return { video, actions };
}

function seedInstall(install: InstallKind, world: FaultWorld): void {
  const { db, keychain, server } = world;
  switch (install) {
    case 'fresh':
      break;
    case 'existing-vault':
    case 'existing-vault-no-profile':
      keychain.store.set(VAULT_SERVICE, {
        username: 'session',
        password: vaultRecord(),
      });
      server.seed(INITIAL_REFRESH);
      if (install === 'existing-vault') {
        db.kv.set(`profile:${CANONICAL_OWNER}`, JSON.stringify(validProfile));
      }
      db.kv.set('walkthrough.device-complete', JSON.stringify({ version: 1 }));
      break;
    case 'existing-guest':
      db.kv.set(
        'auth.local-mode',
        JSON.stringify({ version: 1, mode: 'guest' }),
      );
      db.kv.set('profile:device-guest', JSON.stringify(validProfile));
      db.kv.set('walkthrough.device-complete', JSON.stringify({ version: 1 }));
      break;
    case 'legacy-google-flag':
      db.kv.set(
        'auth.last-provider',
        JSON.stringify({ version: 1, provider: 'google' }),
      );
      break;
  }
}

const STRESS_ITER = Number(nodeProcess.env['STRESS_ITER'] ?? 12);

function seededScenario(seed: number): Scenario {
  const rng = makePrng(seed);
  const install = pick(rng, INSTALL_KINDS);
  const candidates = FAULT_CATALOG.filter(f => faultApplies(f, install));
  const wanted = 1 + Math.floor(rng() * 3);
  const chosen: FaultSpec[] = [];
  for (let attempt = 0; attempt < 24 && chosen.length < wanted; attempt += 1) {
    const candidate = pick(rng, candidates);
    if (chosen.some(c => faultsConflict(c, candidate))) continue;
    chosen.push(candidate);
  }
  return {
    name: `seeded-${seed}`,
    seed,
    install,
    faults: chosen.map(c => c.id),
    skipAtMs:
      rng() < 0.5 ? pick(rng, [1_100, 1_500, 3_000, 6_000, 9_000]) : null,
    playbackMs: pick(rng, [3_000, 5_000, 7_000]),
    horizonMs: HORIZON_MIN_MS + pick(rng, [0, 5_000, 30_000]),
  };
}

function sweepScenario(spec: FaultSpec): Scenario {
  return {
    name: `sweep-${spec.id}`,
    seed: null,
    install: defaultInstallFor(spec),
    faults: [spec.id],
    skipAtMs: null,
    playbackMs: 5_000,
    horizonMs: HORIZON_MIN_MS,
  };
}

/** STRESS_FAULT=a,b[,c] (+ STRESS_INSTALL): replay a minimized fault set. */
function faultSetScenario(
  ids: readonly string[],
  install: InstallKind | undefined,
): Scenario {
  const specs = ids.map(faultById);
  return {
    name: `sweep-${ids.join('+')}`,
    seed: null,
    install: install ?? defaultInstallFor(specs[0]!),
    faults: [...ids],
    skipAtMs: null,
    playbackMs: 5_000,
    horizonMs: HORIZON_MIN_MS,
  };
}

function controlScenario(install: InstallKind): Scenario {
  return {
    name: `control-${install}`,
    seed: null,
    install,
    faults: [],
    skipAtMs: null,
    playbackMs: 5_000,
    horizonMs: HORIZON_MIN_MS,
  };
}

// ─── Observation helpers ─────────────────────────────────────────────────────

type Renderer = TestRenderer.ReactTestRenderer;

function hostNodes(renderer: Renderer, testID: string) {
  return renderer.root.findAll(
    node => node.props['testID'] === testID && typeof node.type === 'string',
  );
}

function renderedText(renderer: Renderer | null): string {
  if (!renderer) return '<unmounted>';
  try {
    return renderer.root
      .findAllByType(Text)
      .map(node => {
        const children = node.props['children'] as unknown;
        return Array.isArray(children) ? children.join('') : String(children);
      })
      .join('|');
  } catch {
    return '<no-text>';
  }
}

function findRetryButton(renderer: Renderer | null) {
  if (!renderer) return null;
  const buttons = renderer.root.findAll(
    node =>
      node.props['accessibilityRole'] === 'button' &&
      typeof node.props['onPress'] === 'function' &&
      typeof node.type !== 'string',
  );
  for (const button of buttons) {
    const label = String(button.props['accessibilityLabel'] ?? '');
    const text = (() => {
      try {
        return button
          .findAllByType(Text)
          .map(n => String(n.props['children']))
          .join(' ');
      } catch {
        return '';
      }
    })();
    if (/try again|retry/i.test(`${label} ${text}`)) return button;
  }
  return null;
}

function skipButton(renderer: Renderer | null) {
  if (!renderer) return null;
  const found = renderer.root.findAll(
    node =>
      node.props['testID'] === 'splash-skip' &&
      typeof node.props['onPress'] === 'function',
  );
  return found[0] ?? null;
}

type ContentKind =
  | 'app'
  | 'onboarding'
  | 'welcome'
  | 'sign-in'
  | 'loading'
  | 'profile-error'
  | 'crash-boundary'
  | 'unmounted'
  | 'unknown';

function classifyContent(text: string): ContentKind {
  if (text === '<unmounted>') return 'unmounted';
  if (text.includes('Something went wrong')) return 'crash-boundary';
  if (text.includes('ROOT_NAVIGATOR')) return 'app';
  if (text.includes('ONBOARDING')) return 'onboarding';
  if (text.includes('couldn’t load')) return 'profile-error';
  if (
    text.includes('Getting things ready') ||
    text.includes('Loading your account')
  ) {
    return 'loading';
  }
  if (text.includes('Start your first read')) return 'welcome';
  if (text.includes('Continue with Apple')) return 'sign-in';
  return 'unknown';
}

function gateReady(): boolean {
  const auth = useAuthStore.getState();
  const app = useAppStore.getState();
  if (!auth.hydrated) return false;
  const desired =
    auth.session?.provider === 'guest'
      ? 'device-guest'
      : auth.session?.canonicalAppUserId
        ? canonicalDataOwner(auth.session.canonicalAppUserId)
        : SIGNED_OUT_DATA_OWNER;
  return app.hydrated && app.ownerKey === desired;
}

// ─── Process plumbing ────────────────────────────────────────────────────────

const appStateListeners = new Set<(state: string) => void>();
const a11yListeners = new Set<(value: unknown) => void>();
const consoleErrors: string[] = [];
let realConsoleError: typeof console.error;
const realFetch = globalThis.fetch;
let realStatusBarPush: typeof StatusBar.pushStackEntry;
let realStatusBarPop: typeof StatusBar.popStackEntry;
let statusBarPushes = 0;
let statusBarPops = 0;

function resetProcessState(): void {
  clearSyncRuntime();
  stopSessionKeeper();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    session: null,
    hydrated: false,
    busy: false,
    error: null,
    deletionCleanup: null,
    localDataError: null,
  });
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
  });
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
  });
  useConsistencyStore.setState({
    hydrated: false,
    ownerKey: null,
    snapshot: null,
    loadError: false,
    celebration: null,
    daySecured: null,
  });
  useWalkthroughStore.setState({ visible: false, queued: false });
}

async function flush(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

// ─── Row shape ───────────────────────────────────────────────────────────────

interface Row {
  suite: string;
  scenario: string;
  seed: number | null;
  inputs: Record<string, unknown>;
  observed: Record<string, unknown>;
  invariants: Record<string, boolean>;
  ok: boolean;
  failed: string[];
  /** Fake-clock span the scenario covered (horizon + settle), in ms. */
  simulatedMs: number;
}

// ─── Per-scenario runner ─────────────────────────────────────────────────────

async function runScenario(scenario: Scenario): Promise<Row> {
  jest.setSystemTime(new Date('2026-03-01T09:00:00.000Z'));
  const t0 = Date.now();
  let clockSkew = 0; // ms the harness deliberately moved Date.now() by
  const rel = () => Date.now() - t0 - clockSkew;

  const world = new FaultWorld(API_BASE);
  world.bindClock(rel);
  mockWorld.current = world;
  seedInstall(scenario.install, world);
  const plan = arm(scenario, world);
  (globalThis as { fetch: unknown }).fetch = world.fetchUndefined
    ? undefined
    : world.server.fetch;
  const kvBefore = world.db.snapshot();
  const vaultBefore = world.keychain.store.get(VAULT_SERVICE)?.password ?? null;

  consoleErrors.length = 0;
  statusBarPushes = 0;
  statusBarPops = 0;
  resetProcessState();
  // Reduce Motion is a device setting the app caches for the process
  // lifetime (design/components.tsx); a prior scenario's `a11y.*` fault must
  // not turn this one's exit fade into a 0 ms cut.
  act(() => {
    for (const listener of [...a11yListeners]) listener(false);
  });

  // ── Observations.
  let renderer: Renderer | null = null;
  let mounts = 0;
  let mountedAt = 0;
  let splashPresentPrev = false;
  let splashExitsThisMount = 0;
  let splashReappeared = false;
  let readyAt: number | null = null;
  let skipVisibleAt: number | null = null;
  let skipPressedAt: number | null = null;
  let skipPressAttempts = 0;
  let splashGoneAt: number | null = null;
  let exitTriggerAt: number | null = null; // ready && (end|error|watchdog|skip)
  let firstPlaybackOverAt: number | null = null;
  let exitStartedAt: number | null = null; // first slice with pointerEvents none
  let pointerEventsDuringExitBad = 0;
  let errorBoundaryAt: number | null = null;
  let retryVisibleAt: number | null = null;
  let loadingVisibleAtHorizon = false;
  let splashPresentAtHorizon = false;
  let progressDeliveredMax = -Infinity;
  let deliveredVideoEvents = 0;
  let droppedVideoEvents = 0;
  let capturedVideoProps: Record<string, unknown> | null = null;
  let afterUnmountCallbackThrew: string | null = null;
  let unmountThrew: string | null = null;
  let unmountedByPlan = false;
  const contentTimeline: { at: number; content: ContentKind }[] = [];
  let lastContent: ContentKind | null = null;

  const mount = () => {
    mounts += 1;
    mountedAt = rel();
    splashExitsThisMount = 0;
    splashPresentPrev = false;
    if (mounts > 1) {
      // A remount plays the intro from scratch: the exit oracle judges the
      // newest SplashScreen instance, so per-instance marks start over.
      readyAt = null;
      firstPlaybackOverAt = null;
      skipVisibleAt = null;
      skipPressedAt = null;
      exitTriggerAt = null;
      exitStartedAt = null;
      splashGoneAt = null;
      progressDeliveredMax = -Infinity;
    }
    act(() => {
      renderer = TestRenderer.create(<App />);
    });
    world.log('mount', { n: mounts });
  };
  const unmount = () => {
    try {
      act(() => {
        renderer?.unmount();
      });
    } catch (error) {
      // Only an armed StatusBar fault can throw here (effect cleanup with no
      // boundary above the root); recorded, and the tree is gone either way.
      unmountThrew = error instanceof Error ? error.message : String(error);
    }
    renderer = null;
    world.log('unmount');
  };

  const observe = () => {
    const now = rel();
    const text = renderedText(renderer);
    const content = classifyContent(text);
    if (content !== lastContent) {
      contentTimeline.push({ at: now, content });
      lastContent = content;
    }
    const splashNodes = renderer ? hostNodes(renderer, 'splash-screen') : [];
    const splashPresent = splashNodes.length > 0;
    if (splashPresent && renderer) {
      const props = hostNodes(renderer, 'splash-video')[0]?.props;
      if (props) capturedVideoProps = props as Record<string, unknown>;
    }
    if (splashPresentPrev && !splashPresent) {
      splashExitsThisMount += 1;
      if (splashGoneAt === null) splashGoneAt = now;
      world.log('splash.gone');
    }
    if (!splashPresentPrev && splashPresent && splashExitsThisMount > 0) {
      splashReappeared = true;
    }
    splashPresentPrev = splashPresent;
    if (readyAt === null && gateReady()) {
      readyAt = now;
      world.log('gate.ready', { content });
    }
    if (renderer && skipVisibleAt === null && skipButton(renderer)) {
      skipVisibleAt = now;
      world.log('splash.skip-visible');
    }
    if (
      exitTriggerAt === null &&
      readyAt !== null &&
      (firstPlaybackOverAt !== null ||
        skipPressedAt !== null ||
        now >= mountedAt + WATCHDOG_MS)
    ) {
      exitTriggerAt = now;
    }
    if (splashPresent) {
      const pointerEvents = splashNodes[0]?.props['pointerEvents'];
      if (pointerEvents === 'none') {
        if (exitStartedAt === null) {
          exitStartedAt = now;
          world.log('splash.exiting');
        }
      } else if (
        exitTriggerAt !== null &&
        now >= exitTriggerAt + SLICE_MS &&
        mountedAt <= exitTriggerAt
      ) {
        // The mount whose exit was triggered still blocks touches. A later
        // remount plays the intro from scratch and is judged by its own gate.
        pointerEventsDuringExitBad += 1;
      }
    }
    if (content === 'crash-boundary' && errorBoundaryAt === null) {
      errorBoundaryAt = now;
      world.log('crash-boundary');
    }
    if (retryVisibleAt === null && findRetryButton(renderer)) {
      retryVisibleAt = now;
    }
  };

  const deliverVideo = (event: VideoEvent) => {
    const props = renderer
      ? hostNodes(renderer, 'splash-video')[0]?.props
      : undefined;
    if (!props) {
      droppedVideoEvents += 1;
      return;
    }
    deliveredVideoEvents += 1;
    act(() => {
      if (event.type === 'progress') {
        const time = (event.payload as { currentTime?: unknown } | undefined)
          ?.currentTime;
        if (typeof time === 'number' && time > progressDeliveredMax) {
          progressDeliveredMax = time;
        }
        (props['onProgress'] as (e: unknown) => void)(event.payload);
      } else if (event.type === 'end') {
        if (firstPlaybackOverAt === null) firstPlaybackOverAt = rel();
        (props['onEnd'] as () => void)();
      } else {
        if (firstPlaybackOverAt === null) firstPlaybackOverAt = rel();
        (props['onError'] as (e: unknown) => void)(event.payload);
      }
    });
  };

  const runAction = (action: Action) => {
    world.log(`action.${action.kind}`, { ...action });
    switch (action.kind) {
      case 'clock-jump':
        jest.setSystemTime(Date.now() + action.deltaMs);
        clockSkew += action.deltaMs;
        break;
      case 'a11y':
        act(() => {
          for (const listener of [...a11yListeners]) listener(action.value);
        });
        break;
      case 'unmount':
        unmount();
        unmountedByPlan = true;
        break;
      case 'remount':
        unmount();
        mount();
        break;
      case 'appstate':
        act(() => {
          for (const listener of [...appStateListeners]) listener(action.state);
        });
        break;
      case 'video-after-unmount': {
        const props = capturedVideoProps;
        if (
          !props ||
          (renderer && hostNodes(renderer, 'splash-video').length > 0)
        ) {
          break;
        }
        try {
          act(() => {
            (props['onProgress'] as (e: unknown) => void)(progressPayload(9));
            (props['onEnd'] as () => void)();
            (props['onError'] as (e: unknown) => void)({ error: {} });
          });
        } catch (error) {
          afterUnmountCallbackThrew =
            error instanceof Error ? error.message : String(error);
        }
        break;
      }
    }
  };

  // Relative actions fire `offset` ms after the exit fade is first observed:
  // clock jumps flagged `relativeToExit`, and the negative-`at` unmount sentinel.
  const isRelative = (a: Action) =>
    a.at < 0 || (a.kind === 'clock-jump' && a.relativeToExit);
  const relativeOffset = (a: Action) => Math.abs(a.at);
  const pendingRelative = plan.actions.filter(isRelative);
  const absoluteActions = plan.actions.filter(a => !isRelative(a));
  const firedRelative = new Set<Action>();

  mount();
  await flush(0);
  observe();

  let videoIndex = 0;
  let actionIndex = 0;
  let cursor = 0;
  while (cursor < scenario.horizonMs) {
    const slice = cursor < COARSE_AFTER_MS ? SLICE_MS : COARSE_SLICE_MS;
    const next = cursor + slice;
    // Everything scheduled inside (cursor, next] fires at the slice boundary.
    while (
      videoIndex < plan.video.length &&
      plan.video[videoIndex]!.at <= next
    ) {
      const event = plan.video[videoIndex]!;
      if (event.at <= cursor && cursor > 0) {
        videoIndex += 1;
        continue;
      }
      deliverVideo(event);
      videoIndex += 1;
    }
    while (
      actionIndex < absoluteActions.length &&
      absoluteActions[actionIndex]!.at <= next
    ) {
      runAction(absoluteActions[actionIndex]!);
      actionIndex += 1;
    }
    if (exitStartedAt !== null) {
      for (const action of pendingRelative) {
        if (firedRelative.has(action)) continue;
        if (rel() >= exitStartedAt + relativeOffset(action)) {
          firedRelative.add(action);
          runAction(action);
        }
      }
    }
    if (
      scenario.skipAtMs !== null &&
      skipPressedAt === null &&
      cursor >= scenario.skipAtMs &&
      renderer
    ) {
      const button = skipButton(renderer);
      skipPressAttempts += 1;
      if (button) {
        act(() => {
          (button.props['onPress'] as () => void)();
        });
        skipPressedAt = rel();
        world.log('splash.skip-pressed');
      }
    }
    await flush(slice);
    cursor = next;
    observe();
  }

  // ── Horizon state.
  const horizonText = renderedText(renderer);
  const horizonContent = classifyContent(horizonText);
  splashPresentAtHorizon = renderer
    ? hostNodes(renderer, 'splash-screen').length > 0
    : false;
  loadingVisibleAtHorizon = horizonContent === 'loading';
  const retryAtHorizon = findRetryButton(renderer) !== null;
  const sessionAtHorizon = useAuthStore.getState().session;
  const appAtHorizon = useAppStore.getState();
  const authAtHorizon = useAuthStore.getState();
  const notificationAtHorizon = useNotificationStore.getState();

  // A StatusBar fault still armed here never got its trigger (the overlay
  // never re-pushed); the harness' own teardown unmount is not the app.
  world.statusBar.pushThrows = false;
  world.statusBar.popThrows = false;
  if (renderer) unmount();
  await flush(0);
  const requestsInFlightAtTeardown = world.server.inFlight;
  world.server.dropConnections();
  await flush(0);
  resetProcessState();
  await flush(0);
  const pendingTimersUnderSkewedClock = jest.getTimerCount();
  if (clockSkew !== 0) {
    // Put the wall clock back where the fake timers think it is, then give a
    // wall-clock-keyed animation one exit's worth of frames to settle: a
    // timer that survives THAT is a leak of this scenario, not a stall that
    // would otherwise bleed into the next row's count.
    jest.setSystemTime(Date.now() - clockSkew);
    clockSkew = 0;
    await flush(EXIT_MS * 2);
  }
  const pendingTimers = jest.getTimerCount();
  (globalThis as { fetch: unknown }).fetch = realFetch;

  // ── Oracle.
  const ids = new Set(scenario.faults);
  const has = (prefix: string) => [...ids].some(id => id.startsWith(prefix));
  const kvAfter = world.db.snapshot();
  const vaultAfter = world.keychain.store.get(VAULT_SERVICE)?.password ?? null;
  const refusedByServer = world.server.refreshCalls.some(
    c => c.outcome === '401' || c.outcome === '403',
  );
  const vaultWasMalformed =
    ids.has('keychain.record-not-json') ||
    ids.has('keychain.record-truncated') ||
    ids.has('keychain.record-wrong-shape');
  const vaultWasNonUuid = ids.has('keychain.record-non-uuid-account');
  const profileRowCorrupt =
    ids.has('sqlite.profile-not-json') || ids.has('sqlite.profile-truncated');
  const renderFaultArmed = has('statusbar.');
  const lifecycleUnmounted = unmountedByPlan && renderer === null;
  const kvWrites = world.db.kvWrites();
  const kvWritesInvalid = kvWrites.filter(w => {
    if (w.value === '') return false;
    try {
      JSON.parse(w.value);
      return false;
    } catch {
      return true;
    }
  });
  const seededProfileKey = `profile:${
    scenario.install === 'existing-guest' ? 'device-guest' : CANONICAL_OWNER
  }`;
  const seededProfileBefore = kvBefore[seededProfileKey];
  const seededProfileAfter = kvAfter[seededProfileKey];
  const tokenInKv = kvWrites.some(w =>
    /refresh-|access-|refreshToken|bearerToken/.test(w.value),
  );
  const expectedExitDeadline =
    readyAt === null
      ? null
      : Math.max(
          readyAt,
          Math.min(
            firstPlaybackOverAt ?? Infinity,
            skipPressedAt ?? Infinity,
            mountedAt + WATCHDOG_MS,
          ),
        ) +
        EXIT_MS +
        1_000;

  const invariants: Record<string, boolean> = {};
  // The lens' headline: after ≥60 s of fake time nobody is stuck behind the
  // intro or on a spinner without a way out. A run the plan itself unmounted
  // has no screen to judge.
  invariants['noInfiniteWait60s'] = lifecycleUnmounted
    ? true
    : !splashPresentAtHorizon && !loadingVisibleAtHorizon;
  // Once the gate is ready and playback is over (end / error / watchdog /
  // skip), the intro gets out of the way within EXIT_MS (+ slack).
  invariants['splashExitsOnceReady'] =
    lifecycleUnmounted ||
    expectedExitDeadline === null ||
    (renderFaultArmed && errorBoundaryAt !== null)
      ? true
      : splashGoneAt !== null && splashGoneAt <= expectedExitDeadline;
  invariants['exitAtMostOnce'] = splashExitsThisMount <= 1 && !splashReappeared;
  invariants['skipVisibleAfter1s'] =
    progressDeliveredMax >= SKIP_AFTER_S &&
    !lifecycleUnmounted &&
    (splashGoneAt === null || splashGoneAt > 1_500)
      ? skipVisibleAt !== null
      : true;
  invariants['skipPressHonoured'] =
    skipPressedAt === null || readyAt === null || lifecycleUnmounted
      ? true
      : splashGoneAt !== null &&
        splashGoneAt <= Math.max(skipPressedAt, readyAt) + EXIT_MS + 1_000;
  invariants['touchPassThroughDuringExit'] = pointerEventsDuringExitBad === 0;
  // Effect throws are the only thing allowed to reach the crash boundary, and
  // when they do the boundary must offer its retry control.
  invariants['crashBoundaryOnlyForRenderFaults'] =
    errorBoundaryAt === null || renderFaultArmed;
  invariants['visibleRecoveryWhenErrorShown'] =
    horizonContent === 'crash-boundary' || horizonContent === 'profile-error'
      ? retryAtHorizon
      : true;
  // React reports a caught effect throw through console.error; when the
  // harness itself threw the (simulated) native error that line is the
  // boundary doing its job, not a silent failure.
  const unexpectedConsoleErrors = renderFaultArmed
    ? consoleErrors.filter(line => !line.includes('(simulated)'))
    : consoleErrors;
  invariants['noConsoleError'] = unexpectedConsoleErrors.length === 0;
  invariants['noDestructiveSql'] =
    world.db.destructiveStatements().length === 0;
  invariants['kvWritesWellFormed'] = kvWritesInvalid.length === 0 && !tokenInKv;
  // A seeded profile may only change if the run legitimately re-wrote it
  // (never when the row was unreadable / corrupt — the corrupt row must be
  // surfaced, not silently replaced).
  invariants['seededProfilePreserved'] =
    seededProfileBefore === undefined
      ? true
      : profileRowCorrupt
        ? seededProfileAfter === seededProfileBefore
        : seededProfileAfter === seededProfileBefore ||
          seededProfileAfter === JSON.stringify(appAtHorizon.profile);
  invariants['vaultOnlyClearedForRefusalOrMalformed'] =
    vaultBefore === null || vaultAfter !== null
      ? true
      : refusedByServer || vaultWasMalformed || vaultWasNonUuid;
  invariants['noFakeSuccess'] =
    (refusedByServer
      ? sessionAtHorizon === null && horizonContent !== 'app'
      : true) &&
    (profileRowCorrupt ? horizonContent !== 'app' : true) &&
    (vaultWasMalformed || vaultWasNonUuid ? horizonContent !== 'app' : true);
  invariants['videoCallbacksSafeAfterUnmount'] =
    afterUnmountCallbackThrew === null;
  invariants['statusBarStackBalanced'] = renderFaultArmed
    ? true
    : statusBarPushes === statusBarPops;
  invariants['noTimersLeakedAfterTeardown'] = pendingTimers === 0;

  const failed = Object.entries(invariants)
    .filter(([, held]) => !held)
    .map(([name]) => name);

  return {
    suite: 'stress-splash-failure-injection',
    scenario: scenario.name,
    seed: scenario.seed,
    inputs: {
      install: scenario.install,
      faults: scenario.faults,
      skipAtMs: scenario.skipAtMs,
      playbackMs: scenario.playbackMs,
      horizonMs: scenario.horizonMs,
    },
    observed: {
      readyAt,
      firstPlaybackOverAt,
      skipVisibleAt,
      skipPressedAt,
      skipPressAttempts,
      exitTriggerAt,
      exitStartedAt,
      splashGoneAt,
      expectedExitDeadline,
      splashPresentAtHorizon,
      loadingVisibleAtHorizon,
      horizonContent,
      horizonText: horizonText.slice(0, 240),
      retryAtHorizon,
      errorBoundaryAt,
      retryVisibleAt,
      contentTimeline,
      mounts,
      unmountedByPlan,
      deliveredVideoEvents,
      droppedVideoEvents,
      progressDeliveredMax: Number.isFinite(progressDeliveredMax)
        ? progressDeliveredMax
        : null,
      pointerEventsDuringExitBad,
      afterUnmountCallbackThrew,
      unmountThrew,
      statusBarPushes,
      statusBarPops,
      pendingTimers,
      pendingTimersUnderSkewedClock,
      requestsInFlightAtTeardown,
      notificationHydrated: notificationAtHorizon.hydrated,
      notificationScheduleFailed: notificationAtHorizon.scheduleFailed,
      consoleErrors: consoleErrors.slice(0, 5).map(e => e.slice(0, 200)),
      refreshCalls: world.server.refreshCalls.map(c => `${c.at}:${c.outcome}`),
      keychainOps: world.keychain.log.map(e => `${e.at}:${e.op}`),
      googleCalls: world.google.calls,
      sqlStatements: world.db.statements.length,
      kvWrites: kvWrites.map(w => w.key),
      vaultBefore: vaultBefore === null ? null : vaultBefore.slice(0, 40),
      vaultAfter: vaultAfter === null ? null : vaultAfter.slice(0, 40),
      session: sessionAtHorizon
        ? `${sessionAtHorizon.provider}:${sessionAtHorizon.canonicalAppUserId ?? '-'}`
        : null,
      authHydrated: authAtHorizon.hydrated,
      localDataError: authAtHorizon.localDataError?.code ?? null,
      appHydrated: appAtHorizon.hydrated,
      hydrateError: appAtHorizon.hydrateError,
      timeline: world.timeline.slice(0, 80),
    },
    invariants,
    ok: failed.length === 0,
    failed,
    simulatedMs: rel(),
  };
}

// ─── Direct-render prop faults (the screen's own contract with the Gate) ────

interface DirectCase {
  id: string;
  describe: string;
  run: () => Promise<Record<string, unknown> & { failed: string[] }>;
}

function directRender(
  ready: boolean,
  onFinished: () => void,
): { renderer: Renderer; update: (ready: boolean, cb?: () => void) => void } {
  let renderer!: Renderer;
  act(() => {
    renderer = TestRenderer.create(
      <RootErrorBoundary>
        <SplashScreen ready={ready} onFinished={onFinished} />
      </RootErrorBoundary>,
    );
  });
  return {
    renderer,
    update: (nextReady, cb) => {
      act(() => {
        renderer.update(
          <RootErrorBoundary>
            <SplashScreen ready={nextReady} onFinished={cb ?? onFinished} />
          </RootErrorBoundary>,
        );
      });
    },
  };
}

function videoProps(renderer: Renderer) {
  return hostNodes(renderer, 'splash-video')[0]?.props ?? null;
}

const DIRECT_CASES: DirectCase[] = [
  {
    id: 'props.onFinished-throws',
    describe: 'onFinished throws inside the Animated completion callback',
    run: async () => {
      consoleErrors.length = 0;
      let calls = 0;
      let thrown: string | null = null;
      const { renderer } = directRender(true, () => {
        calls += 1;
        throw new Error('navigation container not ready (simulated)');
      });
      try {
        act(() => {
          (videoProps(renderer)!['onEnd'] as () => void)();
        });
        await flush(EXIT_MS + 200);
        await flush(60_000);
      } catch (error) {
        thrown = error instanceof Error ? error.message : String(error);
      }
      const text = renderedText(renderer);
      const failed: string[] = [];
      if (calls !== 1) failed.push('onFinishedExactlyOnce');
      // A throw from the consumer must not leave a half-faded, uncontrollable
      // screen: either the boundary shows its retry or the throw surfaces.
      const boundary = text.includes('Something went wrong');
      if (!boundary && thrown === null) failed.push('consumerThrowSurfaced');
      act(() => renderer.unmount());
      return { calls, thrown, boundary, text: text.slice(0, 120), failed };
    },
  },
  {
    id: 'props.ready-flap',
    describe: 'ready flaps true→false→true across the exit',
    run: async () => {
      let calls = 0;
      const { renderer, update } = directRender(false, () => {
        calls += 1;
      });
      act(() => {
        (videoProps(renderer)!['onEnd'] as () => void)();
      });
      update(true);
      await flush(100);
      update(false);
      await flush(100);
      update(true);
      await flush(EXIT_MS + 200);
      await flush(60_000);
      const stillMounted = hostNodes(renderer, 'splash-screen').length > 0;
      const failed: string[] = [];
      if (calls !== 1) failed.push('onFinishedExactlyOnce');
      act(() => renderer.unmount());
      return { calls, stillMounted, failed };
    },
  },
  {
    id: 'props.rerender-storm-new-onFinished',
    describe: 'a fresh onFinished identity on 40 rerenders during the fade',
    run: async () => {
      let calls = 0;
      const { renderer, update } = directRender(true, () => {
        calls += 1;
      });
      act(() => {
        (videoProps(renderer)!['onEnd'] as () => void)();
      });
      for (let i = 0; i < 40; i += 1) {
        update(true, () => {
          calls += 1;
        });
        await flush(10);
      }
      await flush(EXIT_MS + 200);
      await flush(60_000);
      const failed: string[] = [];
      if (calls !== 1) failed.push('onFinishedExactlyOnce');
      act(() => renderer.unmount());
      return { calls, failed };
    },
  },
  {
    id: 'props.ready-after-60s',
    describe: 'ready only arrives after 60 s; playback ended at 5 s',
    run: async () => {
      let calls = 0;
      const { renderer, update } = directRender(false, () => {
        calls += 1;
      });
      await flush(5_000);
      act(() => {
        (videoProps(renderer)!['onEnd'] as () => void)();
      });
      await flush(60_000);
      const callsBeforeReady = calls;
      const skipVisible = skipButton(renderer) !== null;
      const heldFrame = hostNodes(renderer, 'splash-screen').length > 0;
      update(true);
      await flush(EXIT_MS + 200);
      const failed: string[] = [];
      if (callsBeforeReady !== 0) failed.push('holdsUntilReady');
      if (calls !== 1) failed.push('onFinishedExactlyOnce');
      if (!heldFrame) failed.push('holdsLastFrame');
      act(() => renderer.unmount());
      return { callsBeforeReady, calls, skipVisible, heldFrame, failed };
    },
  },
  {
    id: 'props.unmount-then-timers-fire',
    describe: 'unmount at 0 ms, then 60 s of timers (watchdog leak check)',
    run: async () => {
      let calls = 0;
      const before = jest.getTimerCount();
      const { renderer } = directRender(true, () => {
        calls += 1;
      });
      act(() => renderer.unmount());
      await flush(60_000);
      const after = jest.getTimerCount();
      const failed: string[] = [];
      if (calls !== 0) failed.push('noCompletionAfterUnmount');
      if (after > before) failed.push('noTimersLeaked');
      return { calls, timersBefore: before, timersAfter: after, failed };
    },
  },
];

// ─── Artifacts ───────────────────────────────────────────────────────────────

function artifactDir(): string {
  const configured = nodeProcess.env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(__dirname, '../../../../artifacts/stress-splash');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(name: string, value: unknown): string {
  const file = path.join(artifactDir(), name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}

function writeText(name: string, text: string): string {
  const file = path.join(artifactDir(), name);
  fs.writeFileSync(file, text);
  return file;
}

function markdown(rows: Row[]): string {
  const lines = [
    '| scenario | seed | install | faults | ok | failed | horizon content | splash gone at |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    const inputs = row.inputs as { install: string; faults: string[] };
    const observed = row.observed as {
      horizonContent: string;
      splashGoneAt: number | null;
    };
    lines.push(
      `| ${row.scenario} | ${row.seed ?? ''} | ${inputs.install} | ${inputs.faults.join(', ')} | ${
        row.ok ? 'HELD' : 'BROKEN'
      } | ${row.failed.join(', ')} | ${observed.horizonContent} | ${observed.splashGoneAt ?? '—'} |`,
    );
  }
  return lines.join('\n') + '\n';
}

// ─── Known deviations (every failing row must be exactly explained) ─────────

const KNOWN_DEVIATIONS = {
  'STRESS-SPLASH-FI-1':
    'No readiness watchdog behind the intro: when a launch dependency never settles (Keychain read, SQLite kv read, the kv write appStore.hydrate awaits, Google silent restore), `ready` never flips, the SplashScreen holds its last frame forever (Skip is shown but does nothing visible because the exit needs `ready`), and the Gate underneath stays on "Getting things ready" / "Loading your account" with no retry control. SplashScreen.tsx only watchdogs the PLAYER (WATCHDOG_MS); App.tsx Gate has no hydration deadline.',
  'STRESS-SPLASH-FI-2':
    'Exit fade keyed to the wall clock: the JS-driven `fade` timing (useNativeDriver: false) measures elapsed time with Date.now(), so a backward wall-clock step during the 520 ms cross-fade stalls the fade by the size of the step; `onFinished` is delayed (5 s step) or never delivered within the horizon (1 h step) and the transparent, pointerEvents="none" SplashScreen stays mounted with the player alive.',
} as const;
type DeviationId = keyof typeof KNOWN_DEVIATIONS;

const NEVER_SETTLES = new Set([
  'keychain.get-never-resolves',
  'sqlite.get-never-resolves',
  'sqlite.get-never-resolves-profile-only',
  'sqlite.set-never-resolves',
  'google.silent-never-resolves',
]);

const CLOCK_BACKWARD = new Set([
  'clock.jump-backward-5s-mid-fade',
  'clock.jump-backward-1h-mid-fade',
  'clock.jump-backward-1h-during-playback',
]);

function classifyDeviation(row: Row): DeviationId | null {
  const inputs = row.inputs as { faults: string[]; install: InstallKind };
  const observed = row.observed as {
    readyAt: number | null;
    splashPresentAtHorizon: boolean;
    loadingVisibleAtHorizon: boolean;
    exitStartedAt: number | null;
  };
  const explainedByNoReadiness = new Set([
    'noInfiniteWait60s',
    'noTimersLeakedAfterTeardown',
  ]);
  if (
    observed.readyAt === null &&
    inputs.faults.some(id => NEVER_SETTLES.has(id)) &&
    row.failed.every(name => explainedByNoReadiness.has(name))
  ) {
    return 'STRESS-SPLASH-FI-1';
  }
  const explainedByClock = new Set([
    'noInfiniteWait60s',
    'splashExitsOnceReady',
    'skipPressHonoured',
    'noTimersLeakedAfterTeardown',
  ]);
  if (
    observed.exitStartedAt !== null &&
    inputs.faults.some(id => CLOCK_BACKWARD.has(id)) &&
    row.failed.every(name => explainedByClock.has(name))
  ) {
    return 'STRESS-SPLASH-FI-2';
  }
  return null;
}

// ─── Suite ───────────────────────────────────────────────────────────────────

beforeAll(() => {
  jest.useFakeTimers();
  jest.spyOn(Math, 'random').mockReturnValue(0.5);
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _type: string,
    handler: (state: string) => void,
  ) => {
    appStateListeners.add(handler);
    return { remove: () => appStateListeners.delete(handler) };
  }) as unknown as typeof AppState.addEventListener);
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(((
    _type: string,
    handler: (value: unknown) => void,
  ) => {
    a11yListeners.add(handler);
    return { remove: () => a11yListeners.delete(handler) };
  }) as unknown as typeof AccessibilityInfo.addEventListener);
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockImplementation(() => Promise.resolve(false));
  realStatusBarPush = StatusBar.pushStackEntry;
  realStatusBarPop = StatusBar.popStackEntry;
  StatusBar.pushStackEntry = ((
    props: Parameters<typeof StatusBar.pushStackEntry>[0],
  ) => {
    // Only the overlay's own entry ({barStyle, animated: true}) is faulted —
    // App.tsx's <StatusBar barStyle="dark-content" /> sits above the boundary.
    if (
      mockWorld.current.statusBar.pushThrows &&
      props.barStyle === 'dark-content' &&
      props.animated === true
    ) {
      mockWorld.current.statusBar.pushThrows = false;
      throw new Error('RCTStatusBarManager unavailable (simulated)');
    }
    statusBarPushes += 1;
    return realStatusBarPush(props);
  }) as typeof StatusBar.pushStackEntry;
  StatusBar.popStackEntry = ((
    entry: Parameters<typeof StatusBar.popStackEntry>[0],
  ) => {
    statusBarPops += 1;
    if (
      mockWorld.current.statusBar.popThrows &&
      (entry as { barStyle?: { value?: string } } | null)?.barStyle?.value ===
        'dark-content'
    ) {
      mockWorld.current.statusBar.popThrows = false;
      throw new Error('RCTStatusBarManager unavailable (simulated)');
    }
    return realStatusBarPop(entry);
  }) as typeof StatusBar.popStackEntry;
  realConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(a => String(a)).join(' '));
  };
});

afterAll(() => {
  console.error = realConsoleError;
  StatusBar.pushStackEntry = realStatusBarPush;
  StatusBar.popStackEntry = realStatusBarPop;
  (globalThis as { fetch: unknown }).fetch = realFetch;
  jest.useRealTimers();
});

describe('STRESS scr-splashscreen · failure-injection', () => {
  const rows: Row[] = [];
  const directRows: Record<string, unknown>[] = [];
  const seedFilter = nodeProcess.env['STRESS_SEED'];
  const faultFilter = nodeProcess.env['STRESS_FAULT'];

  const controls =
    seedFilter || faultFilter ? [] : INSTALL_KINDS.map(controlScenario);
  const installFilter = nodeProcess.env['STRESS_INSTALL'] as
    InstallKind | undefined;
  const sweep = seedFilter
    ? []
    : faultFilter
      ? [
          faultSetScenario(
            faultFilter.split(',').map(id => faultById(id.trim()).id),
            installFilter,
          ),
        ]
      : FAULT_CATALOG.map(sweepScenario);
  const seeded = seedFilter
    ? [seededScenario(Number(seedFilter))]
    : faultFilter
      ? []
      : Array.from({ length: STRESS_ITER }, (_, i) => seededScenario(5000 + i));

  for (const scenario of controls) {
    it(`control: ${scenario.name}`, async () => {
      const row = await runScenario(scenario);
      rows.push(row);
      expect(row.failed).toEqual([]);
    }, 120_000);
  }

  for (const scenario of sweep) {
    it(`sweep: ${scenario.faults[0]}`, async () => {
      rows.push(await runScenario(scenario));
    }, 120_000);
  }

  const CHUNK = 25;
  for (let start = 0; start < seeded.length; start += CHUNK) {
    const slice = seeded.slice(start, start + CHUNK);
    it(`seeded ${slice[0]!.seed}..${slice[slice.length - 1]!.seed}`, async () => {
      for (const scenario of slice) rows.push(await runScenario(scenario));
    }, 900_000);
  }

  if (!seedFilter && !faultFilter) {
    for (const direct of DIRECT_CASES) {
      it(`direct: ${direct.id}`, async () => {
        jest.setSystemTime(new Date('2026-03-01T09:00:00.000Z'));
        const result = await direct.run();
        directRows.push({
          id: direct.id,
          describe: direct.describe,
          ...result,
        });
        expect(result.failed).toEqual([]);
      }, 120_000);
    }
  }

  it('writes artifacts; every BROKEN row is a catalogued deviation', () => {
    const deviations: Record<DeviationId, Row[]> = {
      'STRESS-SPLASH-FI-1': [],
      'STRESS-SPLASH-FI-2': [],
    };
    const untriaged: Row[] = [];
    for (const row of rows) {
      if (row.ok) continue;
      const id = classifyDeviation(row);
      if (id) deviations[id].push(row);
      else untriaged.push(row);
    }
    const faultsExercised = new Set<string>();
    for (const row of rows) {
      for (const id of (row.inputs as { faults: string[] }).faults)
        faultsExercised.add(id);
    }
    const byInvariant: Record<string, { checked: number; failed: number }> = {};
    for (const row of rows) {
      for (const [name, held] of Object.entries(row.invariants)) {
        const slot = (byInvariant[name] ??= { checked: 0, failed: 0 });
        slot.checked += 1;
        if (!held) slot.failed += 1;
      }
    }
    const summary = {
      commit: nodeProcess.env['STRESS_COMMIT'] ?? null,
      node: nodeProcess.version,
      scenarios: rows.length,
      directCases: directRows.length,
      held: rows.filter(r => r.ok).length,
      broken: rows.filter(r => !r.ok).length,
      faultCatalogSize: FAULT_CATALOG.length,
      faultsExercised: faultsExercised.size,
      injectedFaultInstances: rows.reduce(
        (n, r) => n + (r.inputs as { faults: string[] }).faults.length,
        0,
      ),
      byInvariant,
      deviations: Object.fromEntries(
        Object.entries(deviations).map(([id, list]) => [
          id,
          {
            description: KNOWN_DEVIATIONS[id as DeviationId],
            rows: list.length,
            scenarios: list.map(r => ({
              scenario: r.scenario,
              seed: r.seed,
              failed: r.failed,
              inputs: r.inputs,
              horizonContent: (r.observed as { horizonContent: string })
                .horizonContent,
            })),
          },
        ]),
      ),
      untriaged: untriaged.map(r => ({
        scenario: r.scenario,
        seed: r.seed,
        failed: r.failed,
        inputs: r.inputs,
        observed: r.observed,
      })),
      replay:
        'cd apps/mobile && STRESS_SEED=<seed> npx jest --ci __tests__/stress/splashScreen.failureInjection.stress.test.tsx  (or STRESS_FAULT=<fault id>)',
    };
    const paths = [
      writeJson('splash-failure-injection.rows.json', rows),
      writeJson('splash-failure-injection.direct.json', directRows),
      writeJson('splash-failure-injection.summary.json', summary),
      writeText('splash-failure-injection.md', markdown(rows)),
    ];
    realConsoleError(
      JSON.stringify({
        suite: 'stress-splash-failure-injection',
        rows: rows.length,
        broken: summary.broken,
        untriaged: untriaged.length,
        deviations: Object.fromEntries(
          Object.entries(deviations).map(([k, v]) => [k, v.length]),
        ),
        paths,
      }),
    );
    expect(FAULT_CATALOG.length).toBeGreaterThanOrEqual(60);
    expect(
      untriaged.map(r => ({
        scenario: r.scenario,
        seed: r.seed,
        failed: r.failed,
      })),
    ).toEqual([]);
  });
});
