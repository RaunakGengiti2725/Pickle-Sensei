/**
 * Fuzz: SQLite `kv` payloads → Zustand store hydrates and kv-backed readers.
 *
 * Every surface below reads ONE kv slot the app writes today. The harness
 * overwrites that slot with adversarial content (random bytes, truncated
 * JSON, retyped fields, future schema versions, hostile JSON, non-string
 * column values) and drives the real hydrate/reader. Contract under test:
 * no exception escapes a store or reader, `hydrated` always lands `true`,
 * and whatever the store keeps is either a well-formed record or a safe
 * default the UI can recover from.
 *
 * Scale: FUZZ_CASES (default 200) cases × 15 generators × 12 surfaces.
 * Replay one case: FUZZ_SEED=<seed> FUZZ_REPLAY=<surface>:<generator>:<index>
 * Report: artifacts/fuzz-mobile-persisted-state/<FUZZ_RUN_ID>/kv.json
 */
import { FuzzDb } from '../__fuzz__/support/fakeDb';
import {
  FUZZ_TEST_TIMEOUT_MS,
  FuzzRun,
  accepted,
  invariant,
  lenient,
  rejected,
  type CaseVerdict,
  type Surface,
} from '../__fuzz__/support/harness';
import {
  CONSISTENCY_LEDGER_TEMPLATE,
  LIVE_SESSION_SUMMARY_TEMPLATE,
  LOCAL_MODE_TEMPLATE,
  NOTIFICATION_PREFS_TEMPLATE,
  PENDING_NOTIFICATION_CHOICE_TEMPLATE,
  PENDING_PROFILE_TEMPLATE,
  PRACTICE_SET_TEMPLATE,
  PROFILE_TEMPLATE,
  RANK_RECORD_TEMPLATE,
  REVIEW_PROMPT_TEMPLATE,
  WALKTHROUGH_TEMPLATE,
} from '../__fuzz__/support/templates';
import {
  STRING_GENERATOR_NAMES,
  type GeneratedInput,
} from '../__fuzz__/support/generators';

const mockFuzzDb = new FuzzDb();
jest.mock('../src/data/db', () => ({ getDb: () => mockFuzzDb }));

jest.mock('../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: 'test-ios-client.apps.googleusercontent.com',
    googleWebClientId: 'test-web-client.apps.googleusercontent.com',
    appVersion: '1.0',
  }),
}));
jest.mock('../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    hasPlayServices: jest.fn(),
    signIn: jest.fn(),
    signInSilently: jest.fn(),
    hasPreviousSignIn: jest.fn(),
    signOut: jest.fn(),
    revokeAccess: jest.fn(),
  },
}));
jest.mock('../src/account/deviceContext', () => ({
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

import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  profileKeyForOwner,
  setActiveDataOwner,
} from '../src/data/accountScope';
import { getKv } from '../src/data/repository';
import {
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../src/state/appStore';
import {
  consistencyKeyForOwner,
  useConsistencyStore,
} from '../src/consistency/store';
import {
  PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
  useNotificationStore,
} from '../src/notifications/notificationStore';
import {
  DEFAULT_NOTIFICATION_PREFS,
  notificationPrefsKeyForOwner,
} from '../src/notifications/types';
import type { SchedulerPort } from '../src/notifications/service';
import {
  REVIEW_PROMPT_KV_KEY,
  parseReviewPromptState,
} from '../src/review/appStoreReview';
import {
  rankCelebrationKeyForOwner,
  useRankCelebrationStore,
} from '../src/progress/rankCelebration';
import {
  currentPracticeSetId,
  practiceSetKeyForOwner,
  resumeOrStartPracticeSet,
} from '../src/analysis/practiceSet';
import {
  WALKTHROUGH_KV_KEY,
  useWalkthroughStore,
} from '../src/walkthrough/walkthroughStore';
import { parseLiveSessionSummaryRecord } from '../src/flow/liveSessionSummary';
import { useAuthStore } from '../src/auth/authStore';
import { stopSessionKeeper } from '../src/account/sessionKeeper';
import type { PlayerRankSummary } from '@pickle/shared-types';

const OWNER = GUEST_DATA_OWNER;
const run = new FuzzRun('kv');

function seedKv(key: string, input: GeneratedInput): void {
  mockFuzzDb.reset();
  mockFuzzDb.kv.set(key, input.value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const PROFILE_REQUIRED = [
  'skillLevel',
  'handedness',
  'goal',
  'biggestProblem',
  'focusCheckpoint',
] as const;

function profileConforms(profile: unknown): string | null {
  if (!isPlainObject(profile)) return `profile is ${typeOf(profile)}`;
  for (const key of PROFILE_REQUIRED) {
    if (typeof profile[key] !== 'string') {
      return `profile.${key} is ${typeOf(profile[key])}`;
    }
  }
  return null;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function resetAppStore(): void {
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
  });
}

async function hydrateProfileVerdict(): Promise<CaseVerdict> {
  resetAppStore();
  await useAppStore.getState().hydrate();
  const state = useAppStore.getState();
  if (!state.hydrated) return invariant('hydrated stayed false');
  if (state.hydrateError) {
    return rejected(`hydrateError=${JSON.stringify(state.hydrateError)}`);
  }
  if (state.profile === null) return rejected('profile=null');
  const problem = profileConforms(state.profile);
  if (problem) {
    // HomeScreen.tsx:199-201 calls `profile.focusCheckpoint.replace(...)`
    // whenever the value is truthy — a truthy non-string here is a render
    // TypeError on the main screen, every launch, until the row is fixed.
    const focus = isPlainObject(state.profile)
      ? (state.profile as Record<string, unknown>)['focusCheckpoint']
      : undefined;
    const crashCapable = Boolean(focus) && typeof focus !== 'string';
    return invariant(
      `${crashCapable ? 'RENDER-CRASH-CAPABLE ' : ''}non-conforming profile hydrated with hydrateError=null: ${problem}`,
    );
  }
  return accepted();
}

const fakeScheduler: SchedulerPort = {
  permissionState: async () => 'granted',
  requestPermission: async () => 'granted',
  applyPlan: async () => {},
  cancelAllPlanned: async () => {},
  openSystemSettings: async () => {},
};
const notificationDeps = {
  scheduler: fakeScheduler,
  loadContext: async () => ({
    nowMs: Date.parse('2026-09-04T05:00:00.000Z'),
    streakDays: 3,
    practicedToday: false,
    hasAnyHistory: true,
    shieldsAvailable: 1,
  }),
};

function notificationPrefsConform(prefs: unknown): string | null {
  if (!isPlainObject(prefs)) return `prefs is ${typeOf(prefs)}`;
  if (prefs['version'] !== 1) return `version=${String(prefs['version'])}`;
  for (const key of [
    'enabled',
    'practiceReminder',
    'streakDefense',
    'weeklyRecap',
    'comeback',
    'promptDismissed',
  ]) {
    if (typeof prefs[key] !== 'boolean')
      return `${key} is ${typeOf(prefs[key])}`;
  }
  const minutes = prefs['practiceReminderMinutes'];
  if (
    typeof minutes !== 'number' ||
    !Number.isInteger(minutes) ||
    minutes < 0 ||
    minutes >= 24 * 60
  ) {
    return `practiceReminderMinutes=${String(minutes)}`;
  }
  return null;
}

const rankSummary: PlayerRankSummary = {
  rating: 5.4,
  tier: 'gold',
  tierLabel: 'Gold',
  division: 3,
  divisionLabel: 'III',
  techniqueCount: 2,
  scoredAnalysisCount: 6,
  techniques: [],
} as unknown as PlayerRankSummary;

const surfaces: Surface[] = [
  {
    name: 'appStore.profile',
    template: PROFILE_TEMPLATE,
    knownInvariant: {
      finding:
        'durable profile is JSON.parse-cast without shape validation (pending stash IS validated by parsePendingProfile)',
      files: [
        'apps/mobile/src/state/appStore.ts:182',
        'apps/mobile/src/screens/HomeScreen.tsx:199-201',
      ],
      detail: /non-conforming profile hydrated with hydrateError=null/,
    },
    run: async input => {
      seedKv(profileKeyForOwner(OWNER), input);
      return hydrateProfileVerdict();
    },
  },
  {
    name: 'appStore.pendingProfileStash',
    template: PENDING_PROFILE_TEMPLATE,
    run: async input => {
      seedKv(PENDING_ONBOARDING_PROFILE_KV_KEY, input);
      const verdict = await hydrateProfileVerdict();
      const stash = mockFuzzDb.kv.get(PENDING_ONBOARDING_PROFILE_KV_KEY);
      if (verdict.outcome === 'accepted' && stash !== '') {
        return invariant('adopted stash was not cleared');
      }
      return verdict;
    },
  },
  {
    name: 'consistencyStore.ledger',
    template: CONSISTENCY_LEDGER_TEMPLATE,
    run: async input => {
      seedKv(consistencyKeyForOwner(OWNER), input);
      useConsistencyStore.setState({
        hydrated: false,
        ownerKey: null,
        snapshot: null,
        loadError: false,
        celebration: null,
        daySecured: null,
      });
      await useConsistencyStore.getState().hydrate();
      const state = useConsistencyStore.getState();
      if (!state.hydrated) return invariant('hydrated stayed false');
      if (state.loadError) {
        return invariant('loadError=true from a kv ledger (UI shows error)');
      }
      if (!state.snapshot) return invariant('snapshot=null without loadError');
      const rawAfter = mockFuzzDb.kv.get(consistencyKeyForOwner(OWNER));
      if (typeof rawAfter === 'string' && rawAfter !== input.value) {
        try {
          JSON.parse(rawAfter);
        } catch {
          return invariant('store rewrote ledger slot with invalid JSON');
        }
      }
      const drillDayKept = '2026-08-30' in state.snapshot.days;
      return drillDayKept
        ? accepted(`streak=${state.snapshot.currentStreak}`)
        : rejected('ledger defaulted (drill dropped)');
    },
  },
  {
    name: 'notificationStore.prefs',
    template: NOTIFICATION_PREFS_TEMPLATE,
    run: async input => {
      seedKv(notificationPrefsKeyForOwner(OWNER), input);
      useNotificationStore.setState({
        hydrated: false,
        ownerKey: null,
        prefs: { ...DEFAULT_NOTIFICATION_PREFS },
        permission: 'unknown',
        persistFailed: false,
        scheduleFailed: false,
      });
      await useNotificationStore.getState().hydrate(notificationDeps);
      const state = useNotificationStore.getState();
      if (!state.hydrated) return invariant('hydrated stayed false');
      const problem = notificationPrefsConform(state.prefs);
      if (problem) return invariant(`malformed prefs kept: ${problem}`);
      if (state.scheduleFailed) return invariant('scheduleFailed=true');
      const same =
        JSON.stringify(state.prefs) ===
        JSON.stringify(NOTIFICATION_PREFS_TEMPLATE);
      return same ? accepted() : rejected('defaulted');
    },
  },
  {
    name: 'notificationStore.pendingOnboardingChoice',
    template: PENDING_NOTIFICATION_CHOICE_TEMPLATE,
    run: async input => {
      seedKv(PENDING_NOTIFICATION_ONBOARDING_KV_KEY, input);
      useNotificationStore.setState({
        hydrated: false,
        ownerKey: null,
        prefs: { ...DEFAULT_NOTIFICATION_PREFS },
        permission: 'unknown',
        persistFailed: false,
        scheduleFailed: false,
      });
      await useNotificationStore.getState().hydrate(notificationDeps);
      const state = useNotificationStore.getState();
      if (!state.hydrated) return invariant('hydrated stayed false');
      const problem = notificationPrefsConform(state.prefs);
      if (problem) return invariant(`malformed prefs kept: ${problem}`);
      const stash = mockFuzzDb.kv.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY);
      if (state.prefs.promptDismissed) {
        if (stash !== '') return invariant('adopted choice was not cleared');
        return accepted();
      }
      return rejected();
    },
  },
  {
    name: 'appStoreReview.promptState',
    template: REVIEW_PROMPT_TEMPLATE,
    run: async input => {
      seedKv(REVIEW_PROMPT_KV_KEY, input);
      const state = parseReviewPromptState(
        await getKv(mockFuzzDb, REVIEW_PROMPT_KV_KEY),
      );
      const isCount = (value: number) =>
        Number.isFinite(value) && value >= 0 && Math.floor(value) === value;
      if (
        state.version !== 1 ||
        !isCount(state.scoredAnalyses) ||
        !isCount(state.promptedCount) ||
        (state.lastPromptedAtIso !== null &&
          typeof state.lastPromptedAtIso !== 'string') ||
        (state.reviewedAtIso !== null &&
          typeof state.reviewedAtIso !== 'string')
      ) {
        return invariant(
          `malformed review state kept: ${JSON.stringify(state)}`,
        );
      }
      // Counters are telemetry only (shouldRequestReview reads reviewedAtIso);
      // a finite count past 2^53 just stops incrementing — tolerated, tracked.
      if (
        !Number.isSafeInteger(state.scoredAnalyses) ||
        !Number.isSafeInteger(state.promptedCount)
      ) {
        return lenient(
          `count beyond MAX_SAFE_INTEGER kept: ${JSON.stringify(state)}`,
        );
      }
      return JSON.stringify(state) === JSON.stringify(REVIEW_PROMPT_TEMPLATE)
        ? accepted()
        : rejected('defaulted');
    },
  },
  {
    name: 'rankCelebrationStore.storedRecord',
    template: RANK_RECORD_TEMPLATE,
    run: async input => {
      seedKv(rankCelebrationKeyForOwner(OWNER), input);
      useRankCelebrationStore.setState({ current: null, pending: null });
      useWalkthroughStore.setState({ visible: false, queued: false });
      await useRankCelebrationStore.getState().maybeCelebrate(rankSummary);
      const state = useRankCelebrationStore.getState();
      const written = mockFuzzDb.kv.get(rankCelebrationKeyForOwner(OWNER));
      if (typeof written !== 'string') {
        return invariant(`record slot left as ${typeOf(written)}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(written);
      } catch {
        return invariant('record slot rewritten with invalid JSON');
      }
      if (
        !isPlainObject(parsed) ||
        parsed['tier'] !== 'gold' ||
        parsed['rating'] !== 5.4
      ) {
        return invariant(`current rank not persisted: ${written.slice(0, 80)}`);
      }
      const celebration = state.current ?? state.pending;
      if (!celebration) return invariant('no ceremony for silver→gold');
      return celebration.fromTier === 'silver'
        ? accepted()
        : rejected(`fromTier=${String(celebration.fromTier)}`);
    },
  },
  {
    name: 'practiceSet.storedSet',
    template: PRACTICE_SET_TEMPLATE,
    run: async input => {
      seedKv(practiceSetKeyForOwner(OWNER), input);
      const nowIso = '2026-09-04T05:25:00.000Z';
      const live = await currentPracticeSetId(mockFuzzDb, nowIso);
      const resumed = await resumeOrStartPracticeSet(mockFuzzDb, {
        shotType: 'forehand_drive',
        nowIso,
      });
      if (
        typeof resumed.sessionId !== 'string' ||
        resumed.sessionId.length === 0
      ) {
        return invariant(
          `resume produced sessionId=${String(resumed.sessionId)}`,
        );
      }
      const written = mockFuzzDb.kv.get(practiceSetKeyForOwner(OWNER));
      if (typeof written !== 'string')
        return invariant('set slot not rewritten');
      try {
        JSON.parse(written);
      } catch {
        return invariant('set slot rewritten with invalid JSON');
      }
      if (live === null) return rejected('no live set; fresh set started');
      if (resumed.resumed && resumed.sessionId === live) return accepted();
      return lenient(`live=${live} but resumed=${String(resumed.resumed)}`);
    },
  },
  {
    name: 'walkthroughStore.deviceComplete',
    template: WALKTHROUGH_TEMPLATE,
    run: async input => {
      seedKv(WALKTHROUGH_KV_KEY, input);
      useWalkthroughStore.setState({ visible: false, queued: false });
      useRankCelebrationStore.setState({ current: null, pending: null });
      await useWalkthroughStore.getState().maybeShowFirstRun();
      const state = useWalkthroughStore.getState();
      const raw = mockFuzzDb.kv.get(WALKTHROUGH_KV_KEY);
      // getKv reads falsy column values ('' / 0 / null) as "unset" → the tour
      // shows once and the slot is rewritten with the canonical marker.
      if (state.visible || state.queued) {
        return raw === WALKTHROUGH_TEMPLATE || raw === '{"version":1}'
          ? rejected('unset marker → tour shown and marker rewritten')
          : invariant('tour shown but marker not rewritten');
      }
      return accepted('marker present → tour suppressed');
    },
  },
  {
    name: 'liveSessionSummary.record',
    template: LIVE_SESSION_SUMMARY_TEMPLATE,
    // Pure string parser; typed column values reach it through the
    // repository suite's listLiveSessionHistory surface.
    generators: STRING_GENERATOR_NAMES,
    run: input => {
      const record = parseLiveSessionSummaryRecord(input.value as string);
      if (record === null) return rejected();
      if (
        record.version !== 1 ||
        (record.source !== 'live' && record.source !== 'replay') ||
        !Number.isSafeInteger(record.strokeCount) ||
        record.strokeCount < 0 ||
        (record.startAverage !== null && !Number.isFinite(record.startAverage))
      ) {
        return invariant(`malformed summary kept: ${JSON.stringify(record)}`);
      }
      return accepted();
    },
  },
  {
    name: 'authStore.localMode',
    template: LOCAL_MODE_TEMPLATE,
    strictValid: true,
    run: async input => {
      seedKv('auth.local-mode', input);
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
      useAuthStore.setState({ session: null, hydrated: false });
      await useAuthStore.getState().hydrate();
      stopSessionKeeper();
      const state = useAuthStore.getState();
      setActiveDataOwner(OWNER);
      if (!state.hydrated) return invariant('hydrated stayed false');
      if (state.session === null) return rejected('signed out');
      if (state.session.localOnly !== true) {
        return invariant('non-local session from a kv marker');
      }
      return input.value === '{"version":1,"mode":"guest"}'
        ? accepted()
        : invariant(
            `non-canonical marker accepted as guest: ${JSON.stringify(input.value).slice(0, 80)}`,
          );
    },
  },
];

describe('fuzz: SQLite kv payloads → store hydration', () => {
  beforeAll(() => {
    setActiveDataOwner(OWNER);
  });
  afterAll(() => {
    stopSessionKeeper();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    const path = run.write();
    console.info(`[fuzz kv] report: ${path}\n${run.renderMatrix()}`);
  });

  for (const surface of surfaces) {
    (run.targets(surface.name) ? it : it.skip)(
      `${surface.name}: never throws, always lands hydrated with recoverable state`,
      async () => {
        const summary = await run.fuzzSurface(surface);
        expect(summary.cases).toBeGreaterThan(0);
        expect(run.assertions(surface)).toEqual([]);
      },
      FUZZ_TEST_TIMEOUT_MS,
    );
  }
});
