/**
 * STRESS `scr-settingsscreen` / lens `randomized-seeded` — SettingsScreen
 * rendered by the REAL RootNavigator (real NavigationContainer, native stack,
 * bottom tabs, PremiumTabBar and every route wrapper) on top of the REAL
 * zustand stores (auth, access, consent, notifications, consistency,
 * walkthrough, app profile, api session) and the BrandNoticeHost App.tsx
 * mounts beside the navigator. Only native seams are replaced: SQLite (`getDb`
 * throws like every jest suite), react-native-screens/reanimated/svg/gradient
 * primitives, `Linking.openURL` (RN preset mock, scripted per action), the
 * billing backend (`configureAccessStore` with a deferred `getAccess`) and
 * `globalThis.fetch` (deferred consent-status responses). Every screen the
 * navigator registers EXCEPT SettingsScreen is a marker stub with a Back
 * control, so the unit under test is the settings surface plus the routes it
 * pushes, not the destination screens.
 *
 * A seeded generator drives sequences of 5..60 legal / near-legal steps —
 * taps on every Settings control (rows, sign-out sheet, legal links, rate,
 * walkthrough), the tab bar, Back on the pushed route, plus the store
 * transitions the rest of the app performs while Settings is mounted (session
 * null/guest/synced/switch, profile edits, notification prefs + permission,
 * consistency snapshot, walkthrough dismiss) and the asynchronous world
 * (billing `getAccess` resolving with any ledger shape or rejecting, consent
 * status resolving ok / inactive / malformed / non-2xx / network failure,
 * `openURL` succeeding or failing). After EVERY step a reference model
 * transcribed from SettingsScreen.tsx, RootNavigator.tsx, accessStore.ts,
 * consentStore.ts and the AGENTS.md "free-rating ledger freshness" contract
 * predicts the rendered surface and the store side effects, and the real tree
 * is compared against it. Invariant ids (they appear in failure rows):
 *
 *  noThrow          no step throws out of react-test-renderer's act
 *  noConsoleError   React/RN log nothing through console.error
 *  route            focused route (stack top + active tab) matches the model:
 *                   Pro row → Paywall{source:'settings'} for synced/signed-out,
 *                   ConnectAccount for guests; rows → StreakCalendar /
 *                   NotificationSettings / ConsentSettings / ManageAccount;
 *                   walkthrough → Tabs/Home; ConnectAccount pops itself once
 *                   the session turns apple/google (route wrapper effect)
 *  accountCard      pill SIGNED OUT/LOCAL/SYNCED, name and caption follow the
 *                   session + onboarding first name exactly as coded
 *  membershipRow    "Sign in first" for guests; else Pro active / "N free
 *                   rating(s) left" from canStartRating+availableToReserve
 *                   (never `remaining`) / Upgrade required / Verify access
 *  rowsPresent      Connect account ⇔ guest; Manage account ⇔ synced; legal
 *                   rows ⇔ configured URLs; Rate row on iOS
 *  playerRows       Name/Gender/Playing level/Hitting hand/Current focus/
 *                   Consistency values follow profile + snapshot
 *  notificationsRow Off / Allow in system settings / Daily · h:mm / On
 *  consentRow       Manage until the ledger answered, then Training: …
 *  signOutSheet     sheet visible ⇔ model; Keep/Cancel/Close/back never sign
 *                   out; Confirm signs out exactly once and closes the sheet
 *  accessRefresh    backend getAccess called exactly once per focus gain /
 *                   guest→synced flip while focused, never for guests or the
 *                   signed-out state, never while a load is in flight
 *  accessStore      status + canonicalAccess evolve as accessStore.ts codes
 *                   (stale value kept while loading, dropped on reject,
 *                   configuration bumps discard in-flight answers)
 *  consentFetch     one GET /v1/me/consent/status per hydrate with an api
 *                   session (mount + every session change), no other fetch
 *  consentStore     availability/modelTrainingActive follow the response and
 *                   the "response belongs to the account still signed in" rule
 *  openUrl          legal rows open exactly the configured URL; Rate opens the
 *                   write-review deep link
 *  brandNotice      failed link → "<label> could not be opened"; failed rate →
 *                   "Rating unavailable right now"; dismissible; else none
 *  walkthrough      Replay raises the tour; dismiss lowers it
 *  copy             rendered text never mentions Android / Google Play /
 *                   guest mode / Live Court / competitors / accuracy %
 *  determinism      same seed twice → identical action list and trace
 *
 * Default campaign is 20 seeds (~1 min, suite speed). Full lens:
 *   STRESS_ITER=2000 npx jest --ci __tests__/stress/scr-settingsscreen
 * Replay one row with its full trace in the artifact:
 *   STRESS_SEED=<seed> npx jest --ci __tests__/stress/scr-settingsscreen
 * Artifact (seed → outcome table, minimized failing action lists, flake
 * rates): artifacts/stress/scr-settingsscreen/settingsScreen.randomizedSeeded.json
 */

jest.mock('react-native-safe-area-context', () => {
  const mock = jest.requireActual<{
    default: typeof import('react-native-safe-area-context');
  }>('react-native-safe-area-context/jest/mock');
  return mock.default;
});
jest.mock('react-native-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});
jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Line: Mock,
    Path: Mock,
    Polyline: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    Stop: Mock,
  };
});
jest.mock('react-native-reanimated', () => {
  const React = require('react');
  const { View } = require('react-native');
  const AnimatedView = (props: Record<string, unknown>) =>
    React.createElement(View, props);
  return {
    __esModule: true,
    default: {
      View: AnimatedView,
      createAnimatedComponent:
        (Component: React.ComponentType<Record<string, unknown>>) =>
        (props: Record<string, unknown>) =>
          React.createElement(Component, props),
    },
    Easing: {
      out: (fn: unknown) => fn,
      cubic: () => 0,
    },
    interpolate: () => 0,
    useAnimatedStyle: (updater: () => object) => updater(),
    useSharedValue: (init: unknown) => ({ value: init }),
    withTiming: (toValue: unknown) => toValue,
  };
});
jest.mock('../../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));
jest.mock('../../../src/notifications/service', () => ({
  __esModule: true,
  subscribeToNotificationPresses: jest.fn(() => () => undefined),
}));

// Legal URLs are a per-sequence configuration axis (present / absent).
let mockLegalPrivacyUrl: string | null = null;
let mockLegalTermsUrl: string | null = null;
jest.mock('../../../src/config/runtimeConfig', () => {
  const actual = jest.requireActual<
    typeof import('../../../src/config/runtimeConfig')
  >('../../../src/config/runtimeConfig');
  return {
    ...actual,
    getRuntimePublicConfig: () => ({
      ...actual.getRuntimePublicConfig(),
      legalPrivacyUrl: mockLegalPrivacyUrl,
      legalTermsUrl: mockLegalTermsUrl,
    }),
  };
});

// Every screen RootNavigator registers except SettingsScreen is a marker stub
// carrying one Back control (the destination's own back/close affordance).
// The Home stub also hands the harness the live tab navigation object so the
// route tree can be read exactly as React Navigation holds it.
type StubNavigation = {
  goBack: () => void;
  getParent: () => StubNavigation | undefined;
  getState: () => unknown;
  navigate: (...args: unknown[]) => void;
};
const mockCapturedNavigation: { tab: StubNavigation | null } = { tab: null };

function mockStubScreen(
  name: string,
  backProp?: 'onClose' | 'onBack',
): Record<string, React.ComponentType<Record<string, unknown>>> {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Pressable, Text, View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const { useNavigation } = jest.requireActual<
    typeof import('@react-navigation/native')
  >('@react-navigation/native');
  const Stub = (props: Record<string, unknown>) => {
    const navigation = useNavigation() as unknown as StubNavigation;
    if (name === 'HomeScreen') mockCapturedNavigation.tab = navigation;
    const back = () => {
      const handler = backProp ? props[backProp] : undefined;
      if (typeof handler === 'function') (handler as () => void)();
      else navigation.goBack();
    };
    return React.createElement(
      View,
      { testID: `stub:${name}` },
      React.createElement(
        Pressable,
        { accessibilityLabel: `stub-back:${name}`, onPress: back },
        React.createElement(Text, null, name),
      ),
    );
  };
  return { [name]: Stub };
}
jest.mock('../../../src/screens/HomeScreen', () =>
  mockStubScreen('HomeScreen'),
);
jest.mock('../../../src/screens/LibraryScreen', () =>
  mockStubScreen('LibraryScreen'),
);
jest.mock('../../../src/screens/ProgressScreen', () =>
  mockStubScreen('ProgressScreen'),
);
jest.mock('../../../src/screens/AnalyzeScreen', () =>
  mockStubScreen('AnalyzeScreen'),
);
jest.mock('../../../src/screens/DrillLibraryScreen', () =>
  mockStubScreen('DrillLibraryScreen'),
);
jest.mock('../../../src/screens/ResultScreen', () =>
  mockStubScreen('ResultScreen'),
);
jest.mock('../../../src/screens/ResultDetailsScreen', () =>
  mockStubScreen('ResultDetailsScreen'),
);
jest.mock('../../../src/screens/FormReviewScreen', () =>
  mockStubScreen('FormReviewScreen'),
);
jest.mock('../../../src/screens/StreakCalendarScreen', () =>
  mockStubScreen('StreakCalendarScreen'),
);
jest.mock('../../../src/screens/PaywallScreen', () =>
  mockStubScreen('PaywallScreen', 'onClose'),
);
jest.mock('../../../src/screens/SignInScreen', () =>
  mockStubScreen('SignInScreen', 'onBack'),
);
jest.mock('../../../src/screens/ManageAccountScreen', () =>
  mockStubScreen('ManageAccountScreen'),
);
jest.mock('../../../src/screens/ConsentSettingsScreen', () =>
  mockStubScreen('ConsentSettingsScreen'),
);
jest.mock('../../../src/screens/NotificationSettingsScreen', () =>
  mockStubScreen('NotificationSettingsScreen'),
);

import * as fs from 'fs';
import * as path from 'path';
import React from 'react';
import { Linking, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { RootNavigator } from '../../../src/navigation/RootNavigator';
import { BrandNoticeHost } from '../../../src/design/BrandNotice';
import { useAppStore, type Profile } from '../../../src/state/appStore';
import { useAuthStore, type AuthSession } from '../../../src/auth/authStore';
import {
  clearApiSession,
  establishApiSession,
} from '../../../src/account/apiSession';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../../src/state/accessStore';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
} from '../../../src/billing/types';
import { useConsentStore } from '../../../src/state/consentStore';
import { useNotificationStore } from '../../../src/notifications/notificationStore';
import {
  DEFAULT_NOTIFICATION_PREFS,
  formatReminderMinutes,
  type NotificationPrefs,
} from '../../../src/notifications/types';
import { useConsistencyStore } from '../../../src/consistency/store';
import {
  buildConsistencySnapshot,
  type ConsistencySnapshot,
} from '../../../src/consistency/engine';
import { useWalkthroughStore } from '../../../src/walkthrough/walkthroughStore';
import { getRuntimePublicConfig } from '../../../src/config/runtimeConfig';
import { plural } from '../../../src/util/plural';

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) + campaign plan
// ---------------------------------------------------------------------------

interface Rng {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
  chance(p: number): boolean;
}

function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number =>
    min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    pick: items => {
      if (items.length === 0) throw new Error('pick() from an empty list');
      return items[int(0, items.length - 1)]!;
    },
    weighted: (items, weights) => {
      if (items.length === 0 || items.length !== weights.length) {
        throw new Error('weighted() needs one weight per item');
      }
      const total = weights.reduce((sum, w) => sum + w, 0);
      let roll = next() * total;
      for (let i = 0; i < items.length; i += 1) {
        roll -= weights[i]!;
        if (roll < 0) return items[i]!;
      }
      return items[items.length - 1]!;
    },
    chance: p => next() < p,
  };
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return parsed;
}

const STRESS_ITER = envInt('STRESS_ITER', 20);
const STRESS_SEED_BASE = envInt('STRESS_SEED_BASE', 1);
const STRESS_MIN_LEN = envInt('STRESS_MIN_LEN', 5);
const STRESS_MAX_LEN = envInt('STRESS_MAX_LEN', 60);
const STRESS_SEED_RAW = process.env['STRESS_SEED'];
const STRESS_SEED =
  STRESS_SEED_RAW === undefined || STRESS_SEED_RAW === ''
    ? null
    : envInt('STRESS_SEED', 0);
/** Every Nth seed is also re-run for the determinism check (1 = all). */
const STRESS_DETERMINISM_EVERY = Math.max(
  1,
  envInt('STRESS_DETERMINISM_EVERY', 1),
);
const CHUNK = 25;
const ARTIFACT_PATH = path.resolve(
  __dirname,
  '../../../artifacts/stress/scr-settingsscreen/settingsScreen.randomizedSeeded.json',
);

const SEEDS: readonly number[] =
  STRESS_SEED !== null
    ? [STRESS_SEED]
    : Array.from({ length: STRESS_ITER }, (_, i) => STRESS_SEED_BASE + i);

// ---------------------------------------------------------------------------
// World model
// ---------------------------------------------------------------------------

type SessionKind = 'null' | 'guest' | 'synced';

interface SyncedIdentity {
  provider: 'apple' | 'google';
  canonicalAppUserId: string;
  displayName: string | null;
  email: string | null;
  subject: string;
}

const IDENTITIES: readonly SyncedIdentity[] = [
  {
    provider: 'google',
    canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
    displayName: 'Alex Chen',
    email: 'alex@example.com',
    subject: 'google-sub-alex',
  },
  {
    provider: 'apple',
    canonicalAppUserId: '22222222-2222-4222-8222-222222222222',
    displayName: null,
    email: 'sam@privaterelay.appleid.com',
    subject: 'apple-sub-sam',
  },
  {
    provider: 'apple',
    canonicalAppUserId: '33333333-3333-4333-8333-333333333333',
    displayName: null,
    email: null,
    subject: '000123.abcdef.0456',
  },
  {
    provider: 'google',
    canonicalAppUserId: '44444444-4444-4444-8444-444444444444',
    displayName: '',
    email: 'empty-name@example.com',
    subject: 'google-sub-empty',
  },
  {
    provider: 'google',
    canonicalAppUserId: '55555555-5555-4555-8555-555555555555',
    displayName: 'Zoë Ångström-Ñuñez de la Peña Fitzgerald-Whitehouse',
    email: 'zoe@example.com',
    subject: 'google-sub-zoe',
  },
];

const GUEST_SESSION: AuthSession = {
  provider: 'guest',
  subject: 'local-only',
  canonicalAppUserId: null,
  localOnly: true,
  displayName: null,
  email: null,
};

function syncedSession(identity: SyncedIdentity): AuthSession {
  return {
    provider: identity.provider,
    subject: identity.subject,
    canonicalAppUserId: identity.canonicalAppUserId,
    localOnly: false,
    displayName: identity.displayName,
    email: identity.email,
  };
}

const FIRST_NAMES = ['Jordan', 'Mia', '', 'Élodie', 'x', 'Jean-Luc Picard'];
const GENDERS = ['female', 'male', 'nonbinary', 'prefer_not_to_say'] as const;
const SKILL_LEVELS = ['beginner', 'intermediate', 'advanced', '3.5', ''];
const HANDS = ['right', 'left', 'ambidextrous'] as const;
const CHECKPOINTS = [
  'ready_position',
  'athletic_base',
  'preparation',
  'paddle_set',
  'swing_length',
  'sequencing',
  'paddle_path',
  'contact_position',
  'face_wrist_stability',
  'follow_through',
  'recovery',
] as const;
const GENDER_LABELS: Record<(typeof GENDERS)[number], string> = {
  female: 'Female',
  male: 'Male',
  nonbinary: 'Non-binary',
  prefer_not_to_say: 'Prefer not to say',
};

function randomProfile(rng: Rng): Profile {
  const profile: Profile = {
    skillLevel: rng.pick(SKILL_LEVELS),
    handedness: rng.pick(HANDS),
    goal: rng.pick(['dinks', 'serve', 'all-around']),
    biggestProblem: rng.pick(['consistency', 'power']),
    focusCheckpoint: rng.pick(CHECKPOINTS),
  };
  if (rng.chance(0.6)) profile.firstName = rng.pick(FIRST_NAMES);
  if (rng.chance(0.6)) profile.gender = rng.pick(GENDERS);
  return profile;
}

function randomAccess(rng: Rng): CanonicalAccessState {
  if (rng.chance(0.25)) {
    return {
      premium: true,
      entitlements: ['pickle_sensei_pro'],
      freeRatings: {
        limit: 2,
        used: rng.int(0, 2),
        reserved: 0,
        remaining: rng.int(0, 2),
        availableToReserve: rng.int(0, 2),
      },
      canStartRating: true,
      paywallRequired: false,
    };
  }
  const used = rng.int(0, 2);
  const reserved = rng.int(0, 2 - used);
  const remaining = 2 - used;
  const availableToReserve = Math.max(0, remaining - reserved);
  // Near-legal: the two counters may disagree (a permit still syncing) and
  // canStartRating may not follow availableToReserve.
  const skewed = rng.chance(0.3);
  const canStartRating = skewed ? rng.chance(0.5) : availableToReserve > 0;
  return {
    premium: false,
    entitlements: [],
    freeRatings: {
      limit: 2,
      used,
      reserved,
      remaining: skewed ? rng.int(0, 2) : remaining,
      availableToReserve,
    },
    canStartRating,
    paywallRequired: !canStartRating,
  };
}

function randomSnapshot(rng: Rng): ConsistencySnapshot {
  const asOf = Date.UTC(2026, 2, 10, 18);
  const count = rng.int(0, 12);
  const activities = Array.from({ length: count }, () => {
    const daysAgo = rng.int(0, 9);
    return {
      kind: 'stroke' as const,
      atIso: new Date(
        asOf - daysAgo * 86_400_000 - rng.int(0, 3_600_000),
      ).toISOString(),
      shotType: rng.pick(['dink', 'serve', 'drive']),
      overallScore: rng.int(30, 95) / 10,
      resultKind: 'scored',
    };
  });
  return buildConsistencySnapshot(activities, {
    asOfIso: new Date(asOf).toISOString(),
    timeZone: 'UTC',
  });
}

type ConsentOutcome =
  'ok_active' | 'ok_inactive' | 'malformed' | 'http_error' | 'network_error';

type Action =
  | { kind: 'pressRow'; row: RowLabel }
  | { kind: 'pressLegal'; row: 'Privacy policy' | 'Terms of use'; ok: boolean }
  | { kind: 'pressRate'; ok: boolean }
  | { kind: 'pressWalkthrough' }
  | { kind: 'pressSignOut' }
  | {
      kind: 'sheet';
      control: 'keep' | 'cancel' | 'close' | 'requestClose' | 'confirm';
    }
  | { kind: 'stubBack' }
  | { kind: 'tab'; tab: 'Home' | 'Settings' | 'Library' | 'Performance' }
  | { kind: 'setSession'; session: SessionKind; identity: number }
  | { kind: 'setProfile'; profile: Profile | null }
  | { kind: 'resolveAccess'; index: number; value: CanonicalAccessState }
  | { kind: 'rejectAccess'; index: number }
  | { kind: 'resolveConsent'; index: number; outcome: ConsentOutcome }
  | {
      kind: 'setNotifications';
      prefs: Partial<NotificationPrefs>;
      permission: 'unknown' | 'granted' | 'denied' | 'undetermined';
    }
  | { kind: 'setConsistency'; snapshot: ConsistencySnapshot | null }
  | { kind: 'dismissNotice' }
  | { kind: 'dismissWalkthrough' }
  | { kind: 'flush' };

type RowLabel =
  | 'Pickle Sensei Pro'
  | 'Connect account'
  | 'Consistency'
  | 'Notifications'
  | 'Data & consent'
  | 'Manage account';

type RouteName =
  | 'Paywall'
  | 'ConnectAccount'
  | 'StreakCalendar'
  | 'NotificationSettings'
  | 'ConsentSettings'
  | 'ManageAccount';

type TabName = 'Home' | 'Library' | 'Add' | 'Performance' | 'Settings';

interface PendingAccess {
  configVersion: number;
  settled: boolean;
}
interface PendingConsent {
  canonicalAppUserId: string;
  settled: boolean;
}

interface Expected {
  route: { stack: string[]; tab: TabName };
  pill: string;
  accountName: string;
  accountCaption: string;
  avatar: string;
  membership: string;
  rows: {
    connect: boolean;
    manage: boolean;
    privacy: boolean;
    terms: boolean;
    rate: boolean;
  };
  player: {
    name: string;
    gender: string;
    level: string;
    hand: string;
    focus: string;
    consistency: string;
  };
  notifications: string;
  consent: string;
  sheetVisible: boolean;
  signOutCalls: number;
  getAccessCalls: number;
  access: { status: string; canonicalAccess: CanonicalAccessState | null };
  consentFetches: number;
  consentStore: { availability: string; modelTrainingActive: boolean };
  openUrl: string[];
  notice: string | null;
  walkthroughVisible: boolean;
}

interface SequenceConfig {
  backendConfigured: boolean;
  privacyUrl: string | null;
  termsUrl: string | null;
  initialSession: SessionKind;
  initialIdentity: number;
  initialProfile: Profile | null;
  initialAccess: CanonicalAccessState | null;
  initialSnapshot: ConsistencySnapshot | null;
}

/**
 * Reference model of the surface. Store-level fields are transcribed from the
 * store sources; screen-level fields from SettingsScreen.tsx.
 */
class Model {
  session: AuthSession | null = null;
  profile: Profile | null = null;
  backendConfigured: boolean;
  /** Mirrors accessStore's `dependencies !== null`. */
  accessConfigured = false;
  accessConfigVersion = 0;
  accessStatus: 'idle' | 'loading' | 'ready' | 'unconfigured' | 'error' =
    'idle';
  canonicalAccess: CanonicalAccessState | null = null;
  pendingAccess: PendingAccess[] = [];
  getAccessCalls = 0;
  apiUserId: string | null = null;
  consentAvailability: 'loading' | 'ready' | 'signed_out' | 'unavailable' =
    'loading';
  modelTrainingActive = false;
  pendingConsent: PendingConsent[] = [];
  consentFetches = 0;
  prefs: NotificationPrefs = { ...DEFAULT_NOTIFICATION_PREFS };
  permission: 'unknown' | 'granted' | 'denied' | 'undetermined' = 'unknown';
  snapshot: ConsistencySnapshot | null = null;
  stack: string[] = ['Tabs'];
  tab: TabName = 'Home';
  settingsMounted = false;
  sheetVisible = false;
  signOutCalls = 0;
  openUrl: string[] = [];
  notice: string | null = null;
  walkthroughVisible = false;
  privacyUrl: string | null;
  termsUrl: string | null;

  constructor(config: SequenceConfig) {
    this.backendConfigured = config.backendConfigured;
    this.privacyUrl = config.privacyUrl;
    this.termsUrl = config.termsUrl;
  }

  get syncedAccount(): boolean {
    return this.session !== null && !this.session.localOnly;
  }

  get settingsFocused(): boolean {
    return this.stack.length === 1 && this.tab === 'Settings';
  }

  get topRoute(): string {
    return this.stack[this.stack.length - 1]!;
  }

  /** SettingsScreen's useFocusEffect body. */
  refreshOnFocus(): void {
    if (!this.syncedAccount || this.accessStatus === 'loading') return;
    // accessStore.refreshAccess
    if (!this.accessConfigured) {
      this.accessStatus = 'unconfigured';
      this.canonicalAccess = null;
      return;
    }
    this.accessStatus = 'loading';
    this.getAccessCalls += 1;
    this.pendingAccess.push({
      configVersion: this.accessConfigVersion,
      settled: false,
    });
  }

  /** SettingsScreen's consent effect ([hydrateConsent, session]). */
  hydrateConsent(): void {
    if (this.apiUserId === null) {
      this.consentAvailability = 'signed_out';
      this.modelTrainingActive = false;
      return;
    }
    this.consentAvailability = 'loading';
    this.consentFetches += 1;
    this.pendingConsent.push({
      canonicalAppUserId: this.apiUserId,
      settled: false,
    });
  }

  private setFocus(nowFocused: boolean, wasFocused: boolean): void {
    if (nowFocused && !wasFocused) this.refreshOnFocus();
  }

  /** authStore + the sign-in / sign-out runtime effects around it. */
  applySession(kind: SessionKind, identityIndex: number): void {
    const wasSynced = this.syncedAccount;
    // `session` is a useEffect dependency: null → null is the only transition
    // that leaves the store value identical (every other set is a new object).
    const sessionChanged = !(this.session === null && kind === 'null');
    if (kind === 'synced') {
      const identity = IDENTITIES[identityIndex % IDENTITIES.length]!;
      // establishApiSession + configureAccessStore (bootstrap) — sign-in.
      this.apiUserId = identity.canonicalAppUserId;
      this.accessConfigured = true;
      this.accessConfigVersion += 1;
      this.accessStatus = 'idle';
      this.canonicalAccess = null;
      this.session = syncedSession(identity);
    } else {
      // clearSyncedRuntime(): api session + billing configuration gone.
      this.apiUserId = null;
      this.accessConfigured = false;
      this.accessConfigVersion += 1;
      this.accessStatus = 'idle';
      this.canonicalAccess = null;
      this.session = kind === 'guest' ? { ...GUEST_SESSION } : null;
    }
    if (this.settingsMounted) {
      // Effects run in declaration order: consent hydrate, then the focus
      // effect re-arms when `syncedAccount` changed identity.
      if (sessionChanged) this.hydrateConsent();
      if (this.settingsFocused && this.syncedAccount !== wasSynced) {
        this.refreshOnFocus();
      }
    }
    // ConnectAccountRoute pops itself when the provider turns apple/google.
    if (
      this.topRoute === 'ConnectAccount' &&
      this.session !== null &&
      this.session.provider !== 'guest'
    ) {
      this.popRoute();
    }
  }

  pushRoute(name: RouteName): void {
    const wasFocused = this.settingsFocused;
    this.stack.push(name);
    this.setFocus(this.settingsFocused, wasFocused);
  }

  popRoute(): void {
    if (this.stack.length <= 1) return;
    const wasFocused = this.settingsFocused;
    this.stack.pop();
    this.setFocus(this.settingsFocused, wasFocused);
  }

  switchTab(tab: TabName): void {
    const wasFocused = this.settingsFocused;
    this.tab = tab;
    if (tab === 'Settings' && !this.settingsMounted) {
      // Lazy tab mount: effects run for the first time.
      this.settingsMounted = true;
      this.hydrateConsent();
      this.refreshOnFocus();
      return;
    }
    this.setFocus(this.settingsFocused, wasFocused);
  }

  settleAccess(index: number, value: CanonicalAccessState | null): void {
    const pending = this.pendingAccess[index];
    if (!pending || pending.settled) return;
    pending.settled = true;
    if (pending.configVersion !== this.accessConfigVersion) return;
    if (value) {
      this.accessStatus = 'ready';
      this.canonicalAccess = value;
    } else {
      this.accessStatus = 'error';
      this.canonicalAccess = null;
    }
  }

  settleConsent(index: number, outcome: ConsentOutcome): void {
    const pending = this.pendingConsent[index];
    if (!pending || pending.settled) return;
    pending.settled = true;
    if (this.apiUserId !== pending.canonicalAppUserId) {
      if (this.apiUserId === null) {
        this.consentAvailability = 'signed_out';
        this.modelTrainingActive = false;
      }
      return;
    }
    if (outcome === 'ok_active' || outcome === 'ok_inactive') {
      this.consentAvailability = 'ready';
      this.modelTrainingActive = outcome === 'ok_active';
    } else {
      this.consentAvailability = 'unavailable';
      this.modelTrainingActive = false;
    }
  }

  expected(): Expected {
    const session = this.session;
    const profile = this.profile;
    const accountLabel =
      session === null
        ? '—'
        : session.provider === 'guest'
          ? 'Guest · this device'
          : (session.displayName ?? session.email ?? session.subject);
    const isGuest = session?.provider === 'guest';
    const accountName =
      isGuest && profile?.firstName ? profile.firstName : accountLabel;
    const accountCaption = isGuest
      ? profile?.firstName
        ? 'Guest · this device'
        : 'Progress stays on this phone until you connect an account.'
      : `${session?.provider ?? ''} account`;
    const access = this.canonicalAccess;
    const membershipLabel = access?.premium
      ? 'Pro active'
      : access
        ? access.canStartRating
          ? `${access.freeRatings.availableToReserve} free ${plural(
              access.freeRatings.availableToReserve,
              'rating',
            )} left`
          : 'Upgrade required'
        : 'Verify access';
    const notifications = !this.prefs.enabled
      ? 'Off'
      : this.permission === 'denied'
        ? 'Allow in system settings'
        : this.prefs.practiceReminder
          ? `Daily · ${formatReminderMinutes(this.prefs.practiceReminderMinutes)}`
          : 'On';
    const consent =
      this.consentAvailability !== 'ready'
        ? 'Manage'
        : this.modelTrainingActive
          ? 'Training: contributing'
          : 'Training: off';
    return {
      route: { stack: [...this.stack], tab: this.tab },
      pill:
        session === null
          ? 'SIGNED OUT'
          : session.provider === 'guest'
            ? 'LOCAL'
            : 'SYNCED',
      accountName,
      accountCaption,
      avatar: accountName.charAt(0).toUpperCase(),
      membership: session?.localOnly ? 'Sign in first' : membershipLabel,
      rows: {
        connect: session?.localOnly === true,
        manage: session !== null && !session.localOnly,
        privacy: this.privacyUrl !== null,
        terms: this.termsUrl !== null,
        rate: true,
      },
      player: {
        name: profile?.firstName ?? '—',
        gender: profile?.gender ? GENDER_LABELS[profile.gender] : '—',
        level: profile?.skillLevel ?? '—',
        hand: profile?.handedness ?? '—',
        focus: (profile?.focusCheckpoint ?? '—').replace(/_/g, ' '),
        consistency: this.snapshot
          ? `${this.snapshot.currentStreak} day streak · ${
              this.snapshot.earned.length
            } ${plural(this.snapshot.earned.length, 'badge')}`
          : '—',
      },
      notifications,
      consent,
      sheetVisible: this.sheetVisible,
      signOutCalls: this.signOutCalls,
      getAccessCalls: this.getAccessCalls,
      access: { status: this.accessStatus, canonicalAccess: access },
      consentFetches: this.consentFetches,
      consentStore: {
        availability: this.consentAvailability,
        modelTrainingActive: this.modelTrainingActive,
      },
      openUrl: [...this.openUrl],
      notice: this.notice,
      walkthroughVisible: this.walkthroughVisible,
    };
  }
}

// ---------------------------------------------------------------------------
// Action generation (legal / near-legal given the model state)
// ---------------------------------------------------------------------------

const FORBIDDEN_COPY = [
  /android/i,
  /google play/i,
  /guest mode/i,
  /live court/i,
  /swingvision/i,
  /pb vision/i,
  /selkirk/i,
  /joola/i,
  /\d+\s?%/,
];

function generateAction(rng: Rng, model: Model): Action {
  const choices: Action[] = [];
  const weights: number[] = [];
  const add = (action: Action, weight: number) => {
    choices.push(action);
    weights.push(weight);
  };

  const modalOpen = model.sheetVisible || model.notice !== null;
  const onTabs = model.stack.length === 1;

  if (model.settingsFocused && !modalOpen) {
    add({ kind: 'pressRow', row: 'Pickle Sensei Pro' }, 6);
    if (model.session?.localOnly) {
      add({ kind: 'pressRow', row: 'Connect account' }, 4);
    }
    add({ kind: 'pressRow', row: 'Consistency' }, 3);
    add({ kind: 'pressRow', row: 'Notifications' }, 3);
    add({ kind: 'pressRow', row: 'Data & consent' }, 3);
    if (model.syncedAccount)
      add({ kind: 'pressRow', row: 'Manage account' }, 3);
    if (model.privacyUrl) {
      add({ kind: 'pressLegal', row: 'Privacy policy', ok: true }, 2);
      add({ kind: 'pressLegal', row: 'Privacy policy', ok: false }, 2);
    }
    if (model.termsUrl) {
      add({ kind: 'pressLegal', row: 'Terms of use', ok: true }, 2);
      add({ kind: 'pressLegal', row: 'Terms of use', ok: false }, 2);
    }
    add({ kind: 'pressRate', ok: true }, 2);
    add({ kind: 'pressRate', ok: false }, 2);
    add({ kind: 'pressWalkthrough' }, 2);
    add({ kind: 'pressSignOut' }, 5);
  }
  if (model.sheetVisible) {
    add({ kind: 'sheet', control: 'keep' }, 3);
    add({ kind: 'sheet', control: 'cancel' }, 2);
    add({ kind: 'sheet', control: 'close' }, 2);
    add({ kind: 'sheet', control: 'requestClose' }, 1);
    add({ kind: 'sheet', control: 'confirm' }, 4);
  }
  if (model.notice !== null) add({ kind: 'dismissNotice' }, 6);
  if (!onTabs && !modalOpen) add({ kind: 'stubBack' }, 8);
  if (onTabs && !modalOpen) {
    add({ kind: 'tab', tab: 'Settings' }, model.tab === 'Settings' ? 1 : 8);
    add({ kind: 'tab', tab: 'Home' }, 2);
    add({ kind: 'tab', tab: 'Library' }, 1);
    add({ kind: 'tab', tab: 'Performance' }, 1);
  }
  if (model.walkthroughVisible) add({ kind: 'dismissWalkthrough' }, 3);

  // World / store transitions (happen regardless of what is on screen).
  const kinds: SessionKind[] = ['null', 'guest', 'synced'];
  add(
    {
      kind: 'setSession',
      session: rng.weighted(kinds, [1, 2, 4]),
      identity: rng.int(0, IDENTITIES.length - 1),
    },
    3,
  );
  add(
    {
      kind: 'setProfile',
      profile: rng.chance(0.15) ? null : randomProfile(rng),
    },
    2,
  );
  const openAccess = model.pendingAccess
    .map((p, i) => (p.settled ? -1 : i))
    .filter(i => i >= 0);
  if (openAccess.length > 0) {
    const index = rng.pick(openAccess);
    add({ kind: 'resolveAccess', index, value: randomAccess(rng) }, 7);
    add({ kind: 'rejectAccess', index }, 2);
  }
  const openConsent = model.pendingConsent
    .map((p, i) => (p.settled ? -1 : i))
    .filter(i => i >= 0);
  if (openConsent.length > 0) {
    const outcomes: ConsentOutcome[] = [
      'ok_active',
      'ok_inactive',
      'malformed',
      'http_error',
      'network_error',
    ];
    add(
      {
        kind: 'resolveConsent',
        index: rng.pick(openConsent),
        outcome: rng.weighted(outcomes, [3, 3, 1, 1, 1]),
      },
      5,
    );
  }
  add(
    {
      kind: 'setNotifications',
      prefs: {
        enabled: rng.chance(0.6),
        practiceReminder: rng.chance(0.6),
        practiceReminderMinutes: rng.pick([
          0,
          7 * 60,
          17 * 60 + 30,
          23 * 60 + 59,
          1439,
          720,
        ]),
      },
      permission: rng.pick(['unknown', 'granted', 'denied', 'undetermined']),
    },
    2,
  );
  add(
    {
      kind: 'setConsistency',
      snapshot: rng.chance(0.2) ? null : randomSnapshot(rng),
    },
    2,
  );
  add({ kind: 'flush' }, 1);

  return rng.weighted(choices, weights);
}

function generateConfig(rng: Rng): SequenceConfig {
  const initialSession = rng.weighted<SessionKind>(
    ['null', 'guest', 'synced'],
    [1, 3, 6],
  );
  return {
    backendConfigured: rng.chance(0.8),
    privacyUrl: rng.chance(0.8) ? 'https://api.example.test/privacy' : null,
    termsUrl: rng.chance(0.8) ? 'https://api.example.test/terms' : null,
    initialSession,
    initialIdentity: rng.int(0, IDENTITIES.length - 1),
    initialProfile: rng.chance(0.85) ? randomProfile(rng) : null,
    initialAccess:
      initialSession === 'synced' && rng.chance(0.5) ? randomAccess(rng) : null,
    initialSnapshot: rng.chance(0.6) ? randomSnapshot(rng) : null,
  };
}

// ---------------------------------------------------------------------------
// Real-world seams: deferred billing backend, deferred consent fetch
// ---------------------------------------------------------------------------

interface Deferred<T> {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

const world = {
  accessCalls: [] as Deferred<CanonicalAccessState>[],
  consentCalls: [] as Deferred<Response>[],
  fetchUrls: [] as string[],
  signOutCalls: 0,
  consoleErrors: [] as string[],
};

function backendDeferred(): BillingAccessDependencies {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => {
        throw new Error('plans are not part of the settings surface');
      }),
      purchase: jest.fn(),
      restore: jest.fn(),
      readEntitlement: jest.fn(),
    },
    backend: {
      getAccess: jest.fn(
        () =>
          new Promise<CanonicalAccessState>((resolve, reject) => {
            world.accessCalls.push({ resolve, reject });
          }),
      ),
      syncBilling: jest.fn(),
    },
  };
}

function installFetch(): void {
  globalThis.fetch = jest.fn((input: string | URL | Request) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    world.fetchUrls.push(url);
    return new Promise<Response>((resolve, reject) => {
      world.consentCalls.push({ resolve, reject });
    });
  }) as unknown as typeof fetch;
}

function consentResponse(outcome: ConsentOutcome): Response | Error {
  const okBody = (active: boolean) => ({
    subjectPseudonym: 'pseudo-1',
    scopes: [
      {
        scope: 'model_training',
        active,
        consentVersion: active ? 'model-training-v1' : null,
        lastAction: active ? 'granted' : null,
        lastActionAt: active ? '2026-03-01T00:00:00.000Z' : null,
      },
    ],
  });
  const response = (ok: boolean, body: unknown): Response =>
    ({
      ok,
      status: ok ? 200 : 503,
      json: async () => body,
    }) as unknown as Response;
  switch (outcome) {
    case 'ok_active':
      return response(true, okBody(true));
    case 'ok_inactive':
      return response(true, okBody(false));
    case 'malformed':
      return response(true, { scopes: 'not-a-list' });
    case 'http_error':
      return response(false, { error: 'unavailable' });
    case 'network_error':
      return new Error('network down');
  }
}

/** The in-memory effects of authStore.signOut that reach this surface. */
async function harnessSignOut(): Promise<void> {
  world.signOutCalls += 1;
  clearApiSession();
  clearAccessStoreConfiguration();
  useAuthStore.setState({ session: null, error: null, busy: false });
}

function applySessionToStores(kind: SessionKind, identityIndex: number): void {
  if (kind === 'synced') {
    const identity = IDENTITIES[identityIndex % IDENTITIES.length]!;
    establishApiSession({
      apiBaseUrl: 'https://api.example.test',
      bearerToken: 'test-bearer',
      canonicalAppUserId: identity.canonicalAppUserId,
      provider: identity.provider,
    });
    configureAccessStore(backendDeferred());
    useAuthStore.setState({ session: syncedSession(identity) });
  } else {
    clearApiSession();
    clearAccessStoreConfiguration();
    useAuthStore.setState({
      session: kind === 'guest' ? { ...GUEST_SESSION } : null,
    });
  }
}

// ---------------------------------------------------------------------------
// Rendering + observation
// ---------------------------------------------------------------------------

type Renderer = TestRenderer.ReactTestRenderer;

function Harness() {
  return (
    <>
      <RootNavigator />
      <BrandNoticeHost />
    </>
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  });
}

function textOf(children: unknown): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(textOf).join('');
  return '';
}

function pressables(renderer: Renderer, label: string) {
  return renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
}

function pressableWithPrefix(renderer: Renderer, prefix: string) {
  return renderer.root.findAll(
    node =>
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith(prefix) &&
      typeof node.props.onPress === 'function',
  );
}

function press(renderer: Renderer, label: string): void {
  const nodes = pressables(renderer, label);
  if (nodes.length === 0) throw new Error(`no pressable "${label}"`);
  nodes[0]!.props.onPress();
}

function pressPrefix(renderer: Renderer, prefix: string): void {
  const nodes = pressableWithPrefix(renderer, prefix);
  if (nodes.length === 0) throw new Error(`no pressable "${prefix}…"`);
  nodes[0]!.props.onPress();
}

function pressTab(renderer: Renderer, tab: TabName): void {
  const nodes = renderer.root.findAll(
    node =>
      node.props.accessibilityRole === 'tab' &&
      node.props.accessibilityLabel ===
        (tab === 'Performance' ? 'Progress' : tab) &&
      typeof node.props.onPress === 'function',
  );
  if (nodes.length === 0) throw new Error(`no tab "${tab}"`);
  nodes[0]!.props.onPress();
}

function allTexts(renderer: Renderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .map(node => textOf(node.props.children));
}

/** Value of a SettingRow: the Text following the label Text in its row. */
function rowValue(renderer: Renderer, label: string): string | null {
  const labelNodes = renderer.root.findAll(
    node => node.type === Text && textOf(node.props.children) === label,
  );
  for (const labelNode of labelNodes) {
    const parent = labelNode.parent;
    if (!parent) continue;
    const texts = parent.findAll(
      node => node.type === Text && node.parent === parent,
    );
    const index = texts.indexOf(labelNode);
    const value = texts[index + 1];
    if (value) return textOf(value.props.children);
  }
  return null;
}

interface RouteState {
  index: number;
  routes: { name: string; state?: RouteState }[];
}

function readRoute(): { stack: string[]; tab: TabName } {
  const tabNav = mockCapturedNavigation.tab;
  if (!tabNav) throw new Error('tab navigation not captured');
  const stackNav = tabNav.getParent();
  if (!stackNav) throw new Error('stack navigation not reachable');
  const root = stackNav.getState() as RouteState;
  const stack = root.routes.slice(0, root.index + 1).map(r => r.name);
  const tabsRoute = root.routes.find(r => r.name === 'Tabs');
  const tabState = tabsRoute?.state;
  const tab = tabState
    ? (tabState.routes[tabState.index]!.name as TabName)
    : 'Home';
  return { stack, tab };
}

interface Observed extends Expected {
  copyViolations: string[];
}

function observe(renderer: Renderer): Observed {
  const texts = allTexts(renderer);
  const pillIndex = texts.findIndex(
    t => t === 'SIGNED OUT' || t === 'LOCAL' || t === 'SYNCED',
  );
  const pill = pillIndex >= 0 ? texts[pillIndex]! : '<no pill>';
  const avatar = pillIndex >= 1 ? texts[pillIndex - 1]! : '<no avatar>';
  const accountName = pillIndex >= 0 ? (texts[pillIndex + 1] ?? '') : '<none>';
  const accountCaption =
    pillIndex >= 0 ? (texts[pillIndex + 2] ?? '') : '<none>';
  const accessState = useAccessStore.getState();
  const consentState = useConsentStore.getState();
  // Host node only: the BrandDialog composite carries the same testID prop
  // even while its Modal renders nothing.
  const noticeNodes = renderer.root.findAll(
    node =>
      node.props.testID === 'brand-notice' && typeof node.type === 'string',
  );
  let notice: string | null = null;
  if (noticeNodes.length > 0) {
    const noticeTexts = noticeNodes[0]!
      .findAllByType(Text)
      .map(node => textOf(node.props.children));
    notice =
      noticeTexts.find(
        t =>
          /^.+ could not be opened$/.test(t) ||
          t === 'Rating unavailable right now',
      ) ?? `<unexpected notice: ${noticeTexts.join(' | ')}>`;
  }
  const copyViolations = texts.filter(t =>
    FORBIDDEN_COPY.some(pattern => pattern.test(t)),
  );
  return {
    route: readRoute(),
    pill,
    accountName,
    accountCaption,
    avatar,
    membership: rowValue(renderer, 'Pickle Sensei Pro') ?? '<missing>',
    rows: {
      connect: pressableWithPrefix(renderer, 'Connect account,').length > 0,
      manage: pressableWithPrefix(renderer, 'Manage account,').length > 0,
      privacy: pressableWithPrefix(renderer, 'Privacy policy,').length > 0,
      terms: pressableWithPrefix(renderer, 'Terms of use,').length > 0,
      rate: pressableWithPrefix(renderer, 'Rate Pickle Sensei,').length > 0,
    },
    player: {
      name: rowValue(renderer, 'Name') ?? '<missing>',
      gender: rowValue(renderer, 'Gender') ?? '<missing>',
      level: rowValue(renderer, 'Playing level') ?? '<missing>',
      hand: rowValue(renderer, 'Hitting hand') ?? '<missing>',
      focus: rowValue(renderer, 'Current focus') ?? '<missing>',
      consistency: rowValue(renderer, 'Consistency') ?? '<missing>',
    },
    notifications: rowValue(renderer, 'Notifications') ?? '<missing>',
    consent: rowValue(renderer, 'Data & consent') ?? '<missing>',
    sheetVisible: pressables(renderer, 'Cancel sign out').length > 0,
    signOutCalls: world.signOutCalls,
    getAccessCalls: world.accessCalls.length,
    access: {
      status: accessState.status,
      canonicalAccess: accessState.canonicalAccess,
    },
    consentFetches: world.fetchUrls.length,
    consentStore: {
      availability: consentState.availability,
      modelTrainingActive: consentState.modelTrainingActive,
    },
    openUrl: (Linking.openURL as jest.Mock).mock.calls.map(call =>
      String(call[0]),
    ),
    notice,
    walkthroughVisible: useWalkthroughStore.getState().visible,
    copyViolations,
  };
}

interface Violation {
  invariant: string;
  detail: string;
}

function compare(expected: Expected, observed: Observed): Violation[] {
  const out: Violation[] = [];
  const check = (invariant: string, e: unknown, o: unknown) => {
    const es = JSON.stringify(e);
    const os = JSON.stringify(o);
    if (es !== os) {
      out.push({ invariant, detail: `expected ${es}, observed ${os}` });
    }
  };
  check('route', expected.route, observed.route);
  check(
    'accountCard',
    {
      pill: expected.pill,
      name: expected.accountName,
      caption: expected.accountCaption,
      avatar: expected.avatar,
    },
    {
      pill: observed.pill,
      name: observed.accountName,
      caption: observed.accountCaption,
      avatar: observed.avatar,
    },
  );
  check('membershipRow', expected.membership, observed.membership);
  check('rowsPresent', expected.rows, observed.rows);
  check('playerRows', expected.player, observed.player);
  check('notificationsRow', expected.notifications, observed.notifications);
  check('consentRow', expected.consent, observed.consent);
  check(
    'signOutSheet',
    { visible: expected.sheetVisible, calls: expected.signOutCalls },
    { visible: observed.sheetVisible, calls: observed.signOutCalls },
  );
  check('accessRefresh', expected.getAccessCalls, observed.getAccessCalls);
  check('accessStore', expected.access, observed.access);
  check('consentFetch', expected.consentFetches, observed.consentFetches);
  check('consentStore', expected.consentStore, observed.consentStore);
  check('openUrl', expected.openUrl, observed.openUrl);
  check('brandNotice', expected.notice, observed.notice);
  check(
    'walkthrough',
    expected.walkthroughVisible,
    observed.walkthroughVisible,
  );
  if (observed.copyViolations.length > 0) {
    out.push({
      invariant: 'copy',
      detail: `forbidden copy rendered: ${JSON.stringify(observed.copyViolations)}`,
    });
  }
  const foreignFetch = world.fetchUrls.filter(
    url => !url.endsWith('/v1/me/consent/status'),
  );
  if (foreignFetch.length > 0) {
    out.push({
      invariant: 'consentFetch',
      detail: `unexpected network calls: ${JSON.stringify(foreignFetch)}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sequence execution
// ---------------------------------------------------------------------------

interface StepRecord {
  step: number;
  action: Action;
  observed: Observed;
  violations: Violation[];
}

interface RunResult {
  seed: number;
  config: SequenceConfig;
  actions: Action[];
  trace: StepRecord[];
  violations: { step: number; invariant: string; detail: string }[];
  error: string | null;
  consoleErrors: string[];
}

function resetStores(): void {
  world.accessCalls = [];
  world.consentCalls = [];
  world.fetchUrls = [];
  world.signOutCalls = 0;
  world.consoleErrors = [];
  mockCapturedNavigation.tab = null;
  (Linking.openURL as jest.Mock).mockReset();
  // The RN jest preset installs `performance.now` (~100k calls per sequence)
  // and the NativeAnimatedModule / NativeEventEmitter / StatusBar natives as
  // jest.fn()s whose mock.calls retain every animation config, completion
  // callback and listener — and through them the unmounted fiber trees
  // (~11 MB + ~0.9 MB per sequence, OOM before seed 200 otherwise). Drop the
  // recorded calls (implementations survive) so heap stays flat across the
  // campaign; nothing in the model reads mock.calls across sequences.
  jest.clearAllMocks();
  clearApiSession();
  clearAccessStoreConfiguration();
  useAuthStore.setState({
    session: null,
    hydrated: true,
    busy: false,
    error: null,
    signOut: harnessSignOut,
  });
  useAppStore.setState({ profile: null, hydrated: true });
  useConsentStore.setState({
    availability: 'loading',
    modelTrainingActive: false,
    lastActionAt: null,
    busy: false,
    error: null,
  });
  useNotificationStore.setState({
    hydrated: true,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
  });
  useConsistencyStore.setState({ hydrated: true, snapshot: null });
  useWalkthroughStore.setState({ visible: false, queued: false });
}

function seedInitialState(config: SequenceConfig, model: Model): void {
  mockLegalPrivacyUrl = config.privacyUrl;
  mockLegalTermsUrl = config.termsUrl;
  useAppStore.setState({ profile: config.initialProfile });
  model.profile = config.initialProfile;
  useConsistencyStore.setState({ snapshot: config.initialSnapshot });
  model.snapshot = config.initialSnapshot;

  if (config.initialSession === 'synced') {
    const identity = IDENTITIES[config.initialIdentity % IDENTITIES.length]!;
    establishApiSession({
      apiBaseUrl: 'https://api.example.test',
      bearerToken: 'test-bearer',
      canonicalAppUserId: identity.canonicalAppUserId,
      provider: identity.provider,
    });
    model.apiUserId = identity.canonicalAppUserId;
    if (config.backendConfigured) {
      configureAccessStore(backendDeferred());
      model.accessConfigured = true;
      model.accessConfigVersion += 1;
      if (config.initialAccess) {
        // The rating flow already loaded a snapshot before Settings opened.
        useAccessStore.setState({
          status: 'ready',
          canonicalAccess: config.initialAccess,
        });
        model.accessStatus = 'ready';
        model.canonicalAccess = config.initialAccess;
      }
    }
    useAuthStore.setState({ session: syncedSession(identity) });
    model.session = syncedSession(identity);
  } else if (config.initialSession === 'guest') {
    useAuthStore.setState({ session: { ...GUEST_SESSION } });
    model.session = { ...GUEST_SESSION };
  }
}

async function performAction(
  renderer: Renderer,
  action: Action,
  model: Model,
): Promise<void> {
  switch (action.kind) {
    case 'pressRow': {
      await act(async () => pressPrefix(renderer, `${action.row},`));
      switch (action.row) {
        case 'Pickle Sensei Pro':
          model.pushRoute(
            model.session?.localOnly ? 'ConnectAccount' : 'Paywall',
          );
          break;
        case 'Connect account':
          model.pushRoute('ConnectAccount');
          break;
        case 'Consistency':
          model.pushRoute('StreakCalendar');
          break;
        case 'Notifications':
          model.pushRoute('NotificationSettings');
          break;
        case 'Data & consent':
          model.pushRoute('ConsentSettings');
          break;
        case 'Manage account':
          model.pushRoute('ManageAccount');
          break;
      }
      break;
    }
    case 'pressLegal': {
      const url =
        action.row === 'Privacy policy' ? model.privacyUrl : model.termsUrl;
      (Linking.openURL as jest.Mock).mockImplementationOnce(() =>
        action.ok
          ? Promise.resolve(true)
          : Promise.reject(new Error('no handler')),
      );
      await act(async () => pressPrefix(renderer, `${action.row},`));
      model.openUrl.push(String(url));
      if (!action.ok) model.notice = `${action.row} could not be opened`;
      break;
    }
    case 'pressRate': {
      const url = getRuntimePublicConfig().appStoreWriteReviewUrl;
      (Linking.openURL as jest.Mock).mockImplementationOnce(() =>
        action.ok
          ? Promise.resolve(true)
          : Promise.reject(new Error('no store')),
      );
      await act(async () => pressPrefix(renderer, 'Rate Pickle Sensei,'));
      if (url) model.openUrl.push(url);
      // No StoreKit native module in jest: a failed deep link ends unavailable.
      if (!url || !action.ok) model.notice = 'Rating unavailable right now';
      break;
    }
    case 'pressWalkthrough': {
      await act(async () => pressPrefix(renderer, 'App walkthrough,'));
      model.switchTab('Home');
      model.walkthroughVisible = true;
      break;
    }
    case 'pressSignOut': {
      await act(async () => press(renderer, 'Sign out'));
      model.sheetVisible = true;
      break;
    }
    case 'sheet': {
      await act(async () => {
        switch (action.control) {
          case 'keep':
            press(renderer, 'Keep me signed in');
            break;
          case 'cancel':
            press(renderer, 'Cancel sign out');
            break;
          case 'close':
            press(renderer, 'Close sign out confirmation');
            break;
          case 'requestClose': {
            const modal = renderer.root.findAll(
              node =>
                typeof node.props.onRequestClose === 'function' &&
                node.props.visible === true &&
                node.props.transparent === true,
            );
            if (modal.length === 0) throw new Error('no sign-out modal');
            modal[0]!.props.onRequestClose();
            break;
          }
          case 'confirm': {
            // The sheet's own "Sign out" button (the row is hidden behind the
            // modal on a device; in the tree both carry the same label, the
            // sheet's is the LAST one).
            const nodes = pressables(renderer, 'Sign out');
            if (nodes.length < 2) throw new Error('sheet confirm not found');
            nodes[nodes.length - 1]!.props.onPress();
            break;
          }
        }
      });
      model.sheetVisible = false;
      if (action.control === 'confirm') {
        model.signOutCalls += 1;
        model.applySession('null', 0);
      }
      break;
    }
    case 'stubBack': {
      const top = model.topRoute;
      const stubName =
        top === 'Paywall'
          ? 'PaywallScreen'
          : top === 'ConnectAccount'
            ? 'SignInScreen'
            : `${top}Screen`;
      await act(async () => press(renderer, `stub-back:${stubName}`));
      model.popRoute();
      break;
    }
    case 'tab': {
      await act(async () => pressTab(renderer, action.tab));
      model.switchTab(action.tab);
      break;
    }
    case 'setSession': {
      await act(async () =>
        applySessionToStores(action.session, action.identity),
      );
      model.applySession(action.session, action.identity);
      break;
    }
    case 'setProfile': {
      await act(async () => useAppStore.setState({ profile: action.profile }));
      model.profile = action.profile;
      break;
    }
    case 'resolveAccess': {
      const call = world.accessCalls[action.index];
      await act(async () => call?.resolve(action.value));
      model.settleAccess(action.index, action.value);
      break;
    }
    case 'rejectAccess': {
      const call = world.accessCalls[action.index];
      await act(async () => call?.reject(new Error('backend 503')));
      model.settleAccess(action.index, null);
      break;
    }
    case 'resolveConsent': {
      const call = world.consentCalls[action.index];
      const response = consentResponse(action.outcome);
      await act(async () => {
        if (response instanceof Error) call?.reject(response);
        else call?.resolve(response);
      });
      model.settleConsent(action.index, action.outcome);
      break;
    }
    case 'setNotifications': {
      const prefs: NotificationPrefs = {
        ...useNotificationStore.getState().prefs,
        ...action.prefs,
        version: 1,
      };
      await act(async () =>
        useNotificationStore.setState({ prefs, permission: action.permission }),
      );
      model.prefs = prefs;
      model.permission = action.permission;
      break;
    }
    case 'setConsistency': {
      await act(async () =>
        useConsistencyStore.setState({ snapshot: action.snapshot }),
      );
      model.snapshot = action.snapshot;
      break;
    }
    case 'dismissNotice': {
      await act(async () => press(renderer, 'Got it'));
      model.notice = null;
      break;
    }
    case 'dismissWalkthrough': {
      await act(async () => useWalkthroughStore.getState().dismiss());
      model.walkthroughVisible = false;
      break;
    }
    case 'flush':
      break;
  }
  await flush();
}

/**
 * Runs one sequence. When `fixedActions` is given the action list is replayed
 * verbatim (minimization / determinism); otherwise it is drawn from the seed.
 */
async function runSequence(
  seed: number,
  fixedActions?: Action[],
  fixedConfig?: SequenceConfig,
): Promise<RunResult> {
  const rng = makeRng(seed);
  const config = fixedConfig ?? generateConfig(rng);
  const length = rng.int(STRESS_MIN_LEN, STRESS_MAX_LEN);
  const model = new Model(config);
  const actions: Action[] = [];
  const trace: StepRecord[] = [];
  const violations: RunResult['violations'] = [];
  let error: string | null = null;

  const errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      world.consoleErrors.push(args.map(a => String(a)).join(' '));
    });

  resetStores();
  seedInitialState(config, model);

  const mounted: { renderer: Renderer | null } = { renderer: null };
  try {
    await act(async () => {
      mounted.renderer = TestRenderer.create(<Harness />);
    });
    const renderer = mounted.renderer;
    if (!renderer) throw new Error('renderer did not mount');
    await flush();
    // Step 0: the user opens the Settings tab (Settings mounts lazily).
    await act(async () => pressTab(renderer, 'Settings'));
    model.switchTab('Settings');
    await flush();
    const first = observe(renderer);
    const firstViolations = compare(model.expected(), first);
    trace.push({
      step: 0,
      action: { kind: 'tab', tab: 'Settings' },
      observed: first,
      violations: firstViolations,
    });
    for (const v of firstViolations) violations.push({ step: 0, ...v });

    const total = fixedActions ? fixedActions.length : length;
    for (let step = 1; step <= total; step += 1) {
      const action = fixedActions
        ? fixedActions[step - 1]!
        : generateAction(rng, model);
      actions.push(action);
      try {
        await performAction(renderer, action, model);
      } catch (cause) {
        error = `step ${step} ${action.kind}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`;
        violations.push({ step, invariant: 'noThrow', detail: error });
        break;
      }
      const observed = observe(renderer);
      const stepViolations = compare(model.expected(), observed);
      trace.push({ step, action, observed, violations: stepViolations });
      for (const v of stepViolations) violations.push({ step, ...v });
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    violations.push({ step: -1, invariant: 'noThrow', detail: error });
  } finally {
    const renderer = mounted.renderer;
    if (renderer) {
      await act(async () => renderer.unmount());
    }
    // Settle any promise the sequence left pending so it cannot leak into
    // the next one.
    for (const call of world.accessCalls)
      call.reject(new Error('sequence over'));
    for (const call of world.consentCalls)
      call.reject(new Error('sequence over'));
    await flush();
    // Drain a notice left visible so the host's pending-notice slot is empty.
    errorSpy.mockRestore();
  }
  if (world.consoleErrors.length > 0) {
    violations.push({
      step: -1,
      invariant: 'noConsoleError',
      detail: world.consoleErrors.slice(0, 3).join(' | '),
    });
  }
  return {
    seed,
    config,
    actions,
    trace,
    violations,
    error,
    consoleErrors: [...world.consoleErrors],
  };
}

function traceSignature(result: RunResult): string {
  return JSON.stringify({
    actions: result.actions,
    trace: result.trace.map(step => ({
      observed: step.observed,
      violations: step.violations,
    })),
  });
}

/** ddmin over the action list: the smallest list that still fails. */
async function minimize(result: RunResult): Promise<Action[]> {
  const fails = async (actions: Action[]): Promise<boolean> => {
    const replay = await runSequence(result.seed, actions, result.config);
    return replay.violations.length > 0;
  };
  let actions = [...result.actions];
  if (actions.length === 0) return actions;
  let granularity = 2;
  while (actions.length >= 2) {
    const chunkSize = Math.ceil(actions.length / granularity);
    let reduced = false;
    for (let start = 0; start < actions.length; start += chunkSize) {
      const candidate = [
        ...actions.slice(0, start),
        ...actions.slice(start + chunkSize),
      ];
      if (candidate.length > 0 && (await fails(candidate))) {
        actions = candidate;
        granularity = Math.max(granularity - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (granularity >= actions.length) break;
      granularity = Math.min(actions.length, granularity * 2);
    }
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

interface Row {
  seed: number;
  length: number;
  outcome: 'HELD' | 'BROKEN';
  invariants: string[];
  firstFailingStep: number | null;
  violations: RunResult['violations'];
  error: string | null;
  deterministic: boolean | null;
  minimizedActions: Action[] | null;
  flakeRate: string | null;
  heapUsedMb: number;
  config: SequenceConfig;
  trace?: StepRecord[];
}

function heapUsedMb(): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc) gc();
  return Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10;
}

const rows: Row[] = [];
const actionHistogram: Record<string, number> = {};

beforeAll(() => {
  installFetch();
});

afterAll(() => {
  const held = rows.filter(r => r.outcome === 'HELD').length;
  const artifact = {
    unit: 'scr-settingsscreen',
    lens: 'randomized-seeded',
    generatedAt: new Date().toISOString(),
    plan: {
      iterations: SEEDS.length,
      seedBase: STRESS_SEED_BASE,
      replaySeed: STRESS_SEED,
      minLen: STRESS_MIN_LEN,
      maxLen: STRESS_MAX_LEN,
      determinismEvery: STRESS_DETERMINISM_EVERY,
    },
    summary: {
      sequences: rows.length,
      steps: rows.reduce((sum, r) => sum + r.length, 0),
      held,
      broken: rows.length - held,
      deterministicChecked: rows.filter(r => r.deterministic !== null).length,
      nonDeterministic: rows.filter(r => r.deterministic === false).length,
      actionHistogram,
    },
    rows,
  };
  fs.mkdirSync(path.dirname(ARTIFACT_PATH), { recursive: true });
  fs.writeFileSync(ARTIFACT_PATH, JSON.stringify(artifact, null, 2));
});

async function runSeed(seed: number, index: number): Promise<Row> {
  const result = await runSequence(seed);
  for (const action of result.actions) {
    actionHistogram[action.kind] = (actionHistogram[action.kind] ?? 0) + 1;
  }
  const broken = result.violations.length > 0;
  const row: Row = {
    seed,
    length: result.actions.length,
    outcome: broken ? 'BROKEN' : 'HELD',
    invariants: [...new Set(result.violations.map(v => v.invariant))],
    firstFailingStep: broken ? result.violations[0]!.step : null,
    violations: result.violations,
    error: result.error,
    deterministic: null,
    minimizedActions: null,
    flakeRate: null,
    heapUsedMb: 0,
    config: result.config,
  };
  if (index % STRESS_DETERMINISM_EVERY === 0 || broken) {
    const again = await runSequence(seed);
    row.deterministic = traceSignature(again) === traceSignature(result);
  }
  if (broken) {
    row.trace = result.trace;
    let failures = 0;
    for (let i = 0; i < 10; i += 1) {
      const rerun = await runSequence(seed);
      if (rerun.violations.length > 0) failures += 1;
    }
    row.flakeRate = `${failures}/10`;
    row.minimizedActions = await minimize(result);
  } else if (STRESS_SEED !== null) {
    row.trace = result.trace;
  }
  row.heapUsedMb = heapUsedMb();
  return row;
}

describe('SettingsScreen randomized seeded long-run (real navigator + stores)', () => {
  const chunks: number[][] = [];
  for (let i = 0; i < SEEDS.length; i += CHUNK) {
    chunks.push(SEEDS.slice(i, i + CHUNK));
  }
  if (chunks.length === 0) {
    it('runs no sequences when STRESS_ITER=0', () => {
      expect(SEEDS).toHaveLength(0);
    });
  }
  chunks.forEach((chunk, chunkIndex) => {
    it(`seeds ${chunk[0]}..${chunk[chunk.length - 1]} hold every invariant`, async () => {
      const chunkRows: Row[] = [];
      for (let i = 0; i < chunk.length; i += 1) {
        const row = await runSeed(chunk[i]!, chunkIndex * CHUNK + i);
        rows.push(row);
        chunkRows.push(row);
      }
      const broken = chunkRows.filter(r => r.outcome === 'BROKEN');
      const nonDeterministic = chunkRows.filter(r => r.deterministic === false);
      expect(
        broken.map(r => ({
          seed: r.seed,
          invariants: r.invariants,
          firstFailingStep: r.firstFailingStep,
          first: r.violations[0],
          minimized: r.minimizedActions?.length,
          flakeRate: r.flakeRate,
        })),
      ).toEqual([]);
      expect(nonDeterministic.map(r => r.seed)).toEqual([]);
    }, 600_000);
  });
});
