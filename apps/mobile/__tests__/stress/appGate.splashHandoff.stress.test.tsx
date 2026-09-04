import React from 'react';
import { StatusBar, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { Profile } from '../../src/state/profile';

/**
 * STRESS / rapid-interaction — SplashScreen inside the REAL App Gate.
 *
 * Renders `App` (SafeAreaProvider → QueryClientProvider → RootErrorBoundary →
 * Gate) with the real SplashScreen, the real appStore (in-memory kv with
 * seeded per-query latency) and a controllable auth store, then races the
 * launch handoff from a seeded plan: auth hydration landing early / late /
 * never, sessions of every kind (signed out, guest, canonical with and
 * without a profile), intro end / error / stall (watchdog), Skip tap bursts,
 * Welcome-CTA spam (double taps, both CTAs in one frame, taps during the exit
 * fade), Back / Finish spam on the next screen, and unmount mid-fade.
 *
 * Asserted every 100ms of fake time and after every event:
 *   - at most one splash-screen (and exactly as many splash-video) nodes
 *   - EXACTLY one Gate surface at a time (loading | Welcome | onboarding |
 *     sign-in | main app | profile error) — never two, never none
 *   - the splash leaves only after the modelled `ready && trigger` moment
 *     plus EXIT_MS, never while a loading surface is what's underneath (no
 *     orphan loading state), and never comes back
 *   - a Welcome / Back / Finish burst yields exactly one stage change
 *   - no console.error / console.warn, no unhandled rejections
 *
 * Replay: STRESS_SEED=<seed> npx jest __tests__/stress/appGate.splashHandoff
 * Scale:  STRESS_ITER=300 npx jest __tests__/stress/appGate.splashHandoff
 */

jest.mock('react-native-safe-area-context', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const Passthrough = (props: { children?: React.ReactNode }) =>
    R.createElement(View, null, props.children);
  return {
    SafeAreaProvider: Passthrough,
    SafeAreaView: Passthrough,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: {
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 0, bottom: 0, left: 0, right: 0 },
    },
  };
});

jest.mock('react-native-svg', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    R.createElement(View, null, props.children);
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
    G: Mock,
    Ellipse: Mock,
  };
});

// In-memory kv with seeded latency: every query resolves after
// `mockDb.latencyMs` of fake time, so appStore.hydrate() (several sequential
// reads) lands at a plan-dependent moment relative to the intro.
const mockDb = { kv: new Map<string, string>(), latencyMs: 0, queries: 0 };
jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    execute(sql: string, params: unknown[] = []) {
      mockDb.queries += 1;
      return new Promise<{ rows: { value: string }[] }>(resolve => {
        const run = () => {
          const statement = sql.trim().replace(/\s+/g, ' ');
          if (statement.startsWith('SELECT value FROM kv')) {
            const value = mockDb.kv.get(String(params[0]));
            resolve({ rows: value === undefined ? [] : [{ value }] });
            return;
          }
          if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
            mockDb.kv.set(String(params[0]), String(params[1]));
          }
          resolve({ rows: [] });
        };
        if (mockDb.latencyMs > 0) setTimeout(run, mockDb.latencyMs);
        else run();
      });
    },
    close() {},
  }),
}));

type SessionKind = 'signedOut' | 'guest' | 'canonical' | 'canonicalNoProfile';
interface MockSession {
  provider: 'guest' | 'apple';
  subject: string;
  canonicalAppUserId: string | null;
  localOnly: boolean;
  displayName: string | null;
  email: string | null;
}
interface MockAuthState {
  hydrated: boolean;
  session: MockSession | null;
  hydrate: () => Promise<void>;
}
// Auth hydration is released by the plan (see 'authHydrated' events) instead
// of resolving on its own; `pending` collects the release handles.
const mockAuth = {
  pending: [] as (() => void)[],
  sessionKind: 'signedOut' as SessionKind,
  hydrateCalls: 0,
};
jest.mock('../../src/auth/authStore', () => {
  const { create } = jest.requireActual<typeof import('zustand')>('zustand');
  const scope = jest.requireActual<
    typeof import('../../src/data/accountScope')
  >('../../src/data/accountScope');
  const useAuthStore = create<MockAuthState>(set => ({
    hydrated: false,
    session: null,
    hydrate: () =>
      new Promise<void>(resolve => {
        mockAuth.hydrateCalls += 1;
        mockAuth.pending.push(() => {
          const kind = mockAuth.sessionKind;
          if (kind === 'signedOut') {
            scope.setActiveDataOwner(scope.SIGNED_OUT_DATA_OWNER);
            set({ hydrated: true, session: null });
          } else if (kind === 'guest') {
            scope.setActiveDataOwner(scope.GUEST_DATA_OWNER);
            set({
              hydrated: true,
              session: {
                provider: 'guest',
                subject: 'local-only',
                canonicalAppUserId: null,
                localOnly: true,
                displayName: null,
                email: null,
              },
            });
          } else {
            const id = '33333333-3333-4333-8333-333333333333';
            scope.setActiveDataOwner(scope.canonicalDataOwner(id));
            set({
              hydrated: true,
              session: {
                provider: 'apple',
                subject: 'apple-subject',
                canonicalAppUserId: id,
                localOnly: false,
                displayName: null,
                email: null,
              },
            });
          }
          resolve();
        });
      }),
  }));
  return { useAuthStore };
});

const CANONICAL_ID = '33333333-3333-4333-8333-333333333333';
let mockApiSession: {
  apiBaseUrl: string;
  bearerToken: string;
  canonicalAppUserId: string;
  provider: 'apple';
} | null = null;
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockApiSession,
}));

let mockCanonicalProfile: Profile | null = null;
jest.mock('../../src/account/onboarding', () => ({
  fetchCanonicalOnboardingProfile: async () => mockCanonicalProfile,
  saveCanonicalOnboardingProfile: async (_s: unknown, profile: Profile) =>
    profile,
}));

// Leaves outside the handoff: stand-ins that expose the same handlers.
jest.mock('../../src/navigation/RootNavigator', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    RootNavigator: () => R.createElement(RN.Text, null, 'ROOT_NAVIGATOR'),
  };
});
jest.mock('../../src/screens/SignInScreen', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SignInScreen: (props: { onBack?: () => void }) =>
      R.createElement(
        RN.View,
        null,
        R.createElement(RN.Text, null, 'SIGN_IN_SCREEN'),
        R.createElement(
          RN.Pressable,
          { accessibilityLabel: 'Back', onPress: props.onBack },
          R.createElement(RN.Text, null, 'Back'),
        ),
      ),
  };
});
jest.mock('../../src/screens/OnboardingScreen', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    OnboardingScreen: (props: {
      mode?: string;
      onBack?: () => void;
      onFinished?: () => void;
    }) =>
      R.createElement(
        RN.View,
        null,
        R.createElement(RN.Text, null, 'ONBOARDING'),
        props.onBack
          ? R.createElement(
              RN.Pressable,
              { accessibilityLabel: 'Back', onPress: props.onBack },
              R.createElement(RN.Text, null, 'Back'),
            )
          : null,
        props.onFinished
          ? R.createElement(
              RN.Pressable,
              { accessibilityLabel: 'Finish setup', onPress: props.onFinished },
              R.createElement(RN.Text, null, 'Finish setup'),
            )
          : null,
      ),
  };
});
jest.mock('../../src/components/RankUpCelebration', () => ({
  RankUpCelebration: () => null,
}));
jest.mock('../../src/consistency/StreakCelebration', () => ({
  StreakCelebration: () => null,
}));
jest.mock('../../src/walkthrough/FirstRunWalkthrough', () => ({
  FirstRunWalkthrough: () => null,
}));
jest.mock('../../src/walkthrough/walkthroughStore', () => {
  const state = { maybeShowFirstRun: async () => {} };
  return {
    useWalkthroughStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});
jest.mock('../../src/notifications/useNotificationBootstrap', () => ({
  useNotificationBootstrap: () => {},
}));
jest.mock('../../src/consistency/useConsistencyBootstrap', () => ({
  useConsistencyBootstrap: () => {},
}));

import App from '../../App';
import { useAuthStore } from '../../src/auth/authStore';
import {
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  EXIT_MS,
  SKIP_AFTER_S,
  WATCHDOG_MS,
} from '../../src/screens/SplashScreen';
import { useAppStore } from '../../src/state/appStore';
import {
  NoiseGuard,
  appendStressRecord,
  chance,
  mixSeed,
  pick,
  randomInt,
  seededRandom,
  sortEvents,
  stressCampaign,
  summarizeViolations,
  type TimedEvent,
} from '../../testing/stress/rapidInteraction';

const SUITE = 'appGate.splashHandoff';
const SEED_BASE = 42_000;
const DEFAULT_ITERATIONS = 25;
const HORIZON_MS = 10_000;
const SETTLE_MS = HORIZON_MS + 1_000;
const TICK_MS = 10;
const CHUNK_MS = 100;
const realNow: () => number = Date.now.bind(Date);

const PROFILE: Profile = {
  firstName: 'Dana',
  gender: 'female',
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
};

type Kind =
  'authHydrated' | 'progress' | 'end' | 'error' | 'skip' | 'tap' | 'unmount';

interface Plan {
  seed: number;
  sessionKind: SessionKind;
  dbLatencyMs: number;
  authHydrateAt: number | null;
  videoEndMs: number | null;
  events: TimedEvent<Kind>[];
}

type Label =
  | 'Start your first read'
  | 'I already have an account'
  | 'Back'
  | 'Finish setup';

function quantize(ms: number): number {
  return Math.round(ms / TICK_MS) * TICK_MS;
}

function buildPlan(seed: number): Plan {
  const random = seededRandom(mixSeed(seed));
  const events: TimedEvent<Kind>[] = [];

  const sessionKind = pick(random, [
    'signedOut',
    'signedOut',
    'guest',
    'canonical',
    'canonicalNoProfile',
  ] as const);
  const dbLatencyMs = pick(random, [0, 0, 20, 120, 400, 900]);
  const authHydrateAt = chance(random, 0.94)
    ? quantize(randomInt(random, 0, 7_500))
    : null;
  if (authHydrateAt !== null) {
    events.push({ t: authHydrateAt, kind: 'authHydrated', detail: {} });
  }

  const outcome = pick(random, [
    'end',
    'end',
    'end',
    'error',
    'stall',
    'endBurst',
  ] as const);
  const videoEndMs =
    outcome === 'stall' ? null : quantize(randomInt(random, 1_200, 7_000));
  const progressEveryMs = pick(random, [250, 500]);
  for (
    let t = progressEveryMs;
    t < (videoEndMs ?? HORIZON_MS);
    t += progressEveryMs
  ) {
    events.push({ t, kind: 'progress', detail: { currentTime: t / 1000 } });
  }
  if (videoEndMs !== null) {
    if (outcome === 'error') {
      events.push({ t: videoEndMs, kind: 'error', detail: {} });
    } else {
      events.push({
        t: videoEndMs,
        kind: 'end',
        detail: { burst: outcome === 'endBurst' ? randomInt(random, 2, 4) : 1 },
      });
    }
  }

  const skipBursts = randomInt(random, 0, 3);
  for (let i = 0; i < skipBursts; i += 1) {
    events.push({
      t: quantize(randomInt(random, 300, 9_500)),
      kind: 'skip',
      detail: {
        taps: randomInt(random, 1, 5),
        gapMs: pick(random, [0, 0, 10]),
      },
    });
  }

  // Welcome-CTA / Back / Finish spam: bursts land anywhere, including under
  // the overlay and during the exit fade; whatever control is on screen at
  // that moment (if any) receives the taps.
  const tapBursts = randomInt(random, 0, 5);
  for (let i = 0; i < tapBursts; i += 1) {
    const labels: Label[] = [];
    const n = randomInt(random, 1, 4);
    for (let k = 0; k < n; k += 1) {
      labels.push(
        pick(random, [
          'Start your first read',
          'Start your first read',
          'I already have an account',
          'Back',
          'Finish setup',
        ] as const),
      );
    }
    events.push({
      t: quantize(randomInt(random, 500, 9_800)),
      kind: 'tap',
      detail: { labels },
    });
  }

  const unmountAt = chance(random, 0.12)
    ? quantize(randomInt(random, 200, 9_500))
    : SETTLE_MS;
  events.push({ t: unmountAt, kind: 'unmount', detail: {} });

  return {
    seed,
    sessionKind,
    dbLatencyMs,
    authHydrateAt,
    videoEndMs,
    events: sortEvents(events).filter(e => e.t <= unmountAt),
  };
}

type Renderer = TestRenderer.ReactTestRenderer;

function hostNodes(renderer: Renderer, testID: string) {
  return renderer.root.findAll(
    node => node.props.testID === testID && typeof node.type === 'string',
  );
}

function isAncestor(
  ancestor: TestRenderer.ReactTestInstance,
  node: TestRenderer.ReactTestInstance,
): boolean {
  let current = node.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

/** Innermost composite nodes carrying onPress for a given match. */
function controls(
  renderer: Renderer,
  match: (props: Record<string, unknown>) => boolean,
) {
  const matches = renderer.root.findAll(
    node =>
      typeof node.props.onPress === 'function' &&
      match(node.props as Record<string, unknown>),
  );
  return matches.filter(
    node => !matches.some(other => other !== node && isAncestor(node, other)),
  );
}

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string | number => typeof c !== 'object')
    .join('\n');
}

const SURFACES = [
  'Getting things ready',
  'Loading your account',
  'See the stroke.',
  'ONBOARDING',
  'SIGN_IN_SCREEN',
  'ROOT_NAVIGATOR',
  'couldn’t load',
] as const;

function surfacesOn(text: string): string[] {
  return SURFACES.filter(marker => text.includes(marker));
}

function statusStack(): unknown[] {
  return (StatusBar as unknown as { _propsStack: unknown[] })._propsStack;
}

interface Outcome {
  observed: Record<string, unknown>;
  violations: string[];
}

async function runIteration(plan: Plan): Promise<Outcome> {
  const violations: string[] = [];
  const guard = new NoiseGuard();
  guard.install();

  mockDb.kv.clear();
  mockDb.latencyMs = plan.dbLatencyMs;
  mockDb.queries = 0;
  mockAuth.pending = [];
  mockAuth.sessionKind = plan.sessionKind;
  mockAuth.hydrateCalls = 0;
  mockApiSession =
    plan.sessionKind === 'canonical' ||
    plan.sessionKind === 'canonicalNoProfile'
      ? {
          apiBaseUrl: 'https://stress.invalid',
          bearerToken: 'stress-bearer',
          canonicalAppUserId: CANONICAL_ID,
          provider: 'apple',
        }
      : null;
  mockCanonicalProfile = plan.sessionKind === 'canonical' ? PROFILE : null;
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({ hydrated: false, session: null });
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
  });
  statusStack().length = 0;

  let now = 0;
  let mounted = true;
  let unmountedAt: number | null = null;
  let skipUnlockedAt: number | null = null;
  let triggerAt: number | null = null;
  let readyAt: number | null = null;
  let armedAt: number | null = null;
  let splashGoneAt: number | null = null;
  let splashGoneSurface: string[] | null = null;
  let surfaceAtArm: string[] | null = null;
  let skipTaps = 0;
  let skipTapsDelivered = 0;
  let ctaTaps = 0;
  let ctaTapsDelivered = 0;
  let stageChanges = 0;
  const surfacesSeen = new Set<string>();
  let maxSplashNodes = 0;

  const modelReady = () => {
    const auth = useAuthStore.getState();
    const app = useAppStore.getState();
    return (
      auth.hydrated &&
      app.hydrated &&
      app.ownerKey !== null &&
      app.ownerKey === getActiveDataOwner()
    );
  };

  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(<App />);
  });

  let lastSurface: string | null = null;
  const check = (label: string) => {
    if (!mounted) return;
    const splash = hostNodes(renderer, 'splash-screen').length;
    const video = hostNodes(renderer, 'splash-video').length;
    maxSplashNodes = Math.max(maxSplashNodes, splash);
    if (splash > 1) violations.push(`${label}@${now}: ${splash} splash nodes`);
    if (video !== splash) {
      violations.push(`${label}@${now}: ${video} videos for ${splash} splash`);
    }
    const text = allText(renderer);
    const surfaces = surfacesOn(text);
    for (const s of surfaces) surfacesSeen.add(s);
    if (surfaces.length !== 1) {
      violations.push(
        `${label}@${now}: ${surfaces.length} Gate surfaces visible [${surfaces}]`,
      );
    }
    const surface = surfaces.join('+');
    if (lastSurface !== null && surface !== lastSurface) stageChanges += 1;
    lastSurface = surface;

    if (modelReady() && readyAt === null) readyAt = now;
    if (armedAt === null && readyAt !== null && triggerAt !== null) {
      armedAt = now;
      surfaceAtArm = surfaces;
    }
    if (splash === 0 && splashGoneAt === null) {
      splashGoneAt = now;
      splashGoneSurface = surfaces;
      if (armedAt === null) {
        violations.push(
          `${label}@${now}: splash left without ready && trigger (ready=${readyAt}, trigger=${triggerAt})`,
        );
      } else if (now < armedAt + EXIT_MS) {
        violations.push(
          `${label}@${now}: splash left ${armedAt + EXIT_MS - now}ms before the fade could finish`,
        );
      }
      if (
        surfaces.some(s => s.startsWith('Getting') || s.startsWith('Loading'))
      ) {
        violations.push(
          `${label}@${now}: splash left over a loading surface [${surfaces}]`,
        );
      }
    }
    if (splash > 0 && splashGoneAt !== null) {
      violations.push(`${label}@${now}: splash came back`);
    }
    if (
      splash > 0 &&
      armedAt !== null &&
      now > armedAt + EXIT_MS + CHUNK_MS + 2 * 16
    ) {
      violations.push(
        `${label}@${now}: splash still up ${now - armedAt}ms after arm (EXIT_MS=${EXIT_MS})`,
      );
    }
  };

  const advanceTo = async (t: number) => {
    while (now < t) {
      const toWatchdog = now < WATCHDOG_MS ? WATCHDOG_MS - now : CHUNK_MS;
      const step = Math.min(CHUNK_MS, t - now, toWatchdog);
      now += step;
      await act(async () => {
        jest.advanceTimersByTime(step);
      });
      if (now >= WATCHDOG_MS && triggerAt === null && splashGoneAt === null) {
        triggerAt = now;
      }
      check('tick');
    }
  };

  const videoProps = () => hostNodes(renderer, 'splash-video')[0]?.props;

  check('mount');
  for (const event of plan.events) {
    await advanceTo(event.t);
    if (!mounted) break;
    switch (event.kind) {
      case 'authHydrated': {
        await act(async () => {
          for (const release of mockAuth.pending.splice(0)) release();
        });
        break;
      }
      case 'progress': {
        const currentTime = event.detail.currentTime as number;
        await act(async () => {
          videoProps()?.onProgress({
            currentTime,
            playableDuration: 8,
            seekableDuration: 8,
          });
        });
        if (
          currentTime >= SKIP_AFTER_S &&
          skipUnlockedAt === null &&
          splashGoneAt === null
        ) {
          skipUnlockedAt = now;
        }
        break;
      }
      case 'end': {
        const burst = event.detail.burst as number;
        const props = videoProps();
        await act(async () => {
          for (let i = 0; i < burst; i += 1) props?.onEnd();
        });
        if (props && triggerAt === null) triggerAt = now;
        break;
      }
      case 'error': {
        const props = videoProps();
        await act(async () => {
          props?.onError({ error: { code: 1, domain: 'stress' } });
        });
        if (props && triggerAt === null) triggerAt = now;
        break;
      }
      case 'skip': {
        const taps = event.detail.taps as number;
        const gapMs = event.detail.gapMs as number;
        for (let i = 0; i < taps; i += 1) {
          skipTaps += 1;
          const skip = controls(
            renderer,
            props => props.testID === 'splash-skip',
          )[0];
          if (skip) {
            await act(async () => {
              skip.props.onPressIn?.();
              skip.props.onPressOut?.();
              skip.props.onPress();
            });
            skipTapsDelivered += 1;
            if (triggerAt === null) triggerAt = now;
          }
          if (gapMs > 0 && i < taps - 1) await advanceTo(now + gapMs);
          check('skip');
        }
        break;
      }
      case 'tap': {
        const labels = event.detail.labels as Label[];
        await act(async () => {
          for (const label of labels) {
            ctaTaps += 1;
            const node = controls(
              renderer,
              props => props.accessibilityLabel === label,
            )[0];
            if (node && !node.props.disabled) {
              ctaTapsDelivered += 1;
              node.props.onPress();
            }
          }
        });
        check('tap');
        break;
      }
      case 'unmount': {
        mounted = false;
        unmountedAt = now;
        await act(async () => {
          renderer.unmount();
        });
        break;
      }
      default:
        break;
    }
    if (mounted) check(event.kind);
  }

  if (mounted) {
    mounted = false;
    unmountedAt = now;
    await act(async () => {
      renderer.unmount();
    });
  }
  await act(async () => {
    jest.advanceTimersByTime(CHUNK_MS);
  });
  await act(async () => {
    jest.advanceTimersByTime(20_000);
  });

  const naturalUnmount = unmountedAt === SETTLE_MS;
  if (naturalUnmount && armedAt !== null && splashGoneAt === null) {
    violations.push(
      `splash never left although ready && trigger armed at ${armedAt}`,
    );
  }
  if (naturalUnmount && armedAt === null && splashGoneAt !== null) {
    violations.push(`splash left at ${splashGoneAt} with no handoff armed`);
  }
  if (mockAuth.hydrateCalls !== 1) {
    violations.push(`authStore.hydrate called ${mockAuth.hydrateCalls}×`);
  }
  const app = useAppStore.getState();
  if (app.hydrateError) {
    violations.push(`appStore.hydrateError = ${app.hydrateError}`);
  }
  if (statusStack().length !== 0) {
    violations.push(
      `after unmount: StatusBar stack has ${statusStack().length}`,
    );
  }

  guard.uninstall();
  violations.push(...guard.violations());

  return {
    violations,
    observed: {
      readyAt,
      triggerAt,
      armedAt,
      splashGoneAt,
      splashGoneSurface,
      surfaceAtArm,
      surfacesSeen: [...surfacesSeen],
      stageChanges,
      unmountedAt,
      naturalUnmount,
      skipUnlockedAt,
      skipTaps,
      skipTapsDelivered,
      ctaTaps,
      ctaTapsDelivered,
      maxSplashNodes,
      dbQueries: mockDb.queries,
      appHydrated: app.hydrated,
      appOwnerKey: app.ownerKey,
      appProfile: app.profile !== null,
      consoleErrors: guard.errors.length,
      consoleWarnings: guard.warnings.length,
      unhandledRejections: guard.rejections.length,
    },
  };
}

const campaign = stressCampaign(DEFAULT_ITERATIONS, SEED_BASE);

describe(`stress/rapid-interaction: App Gate splash handoff (${campaign.seeds.length} seeds × ${campaign.repeat})`, () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  for (const seed of campaign.seeds) {
    for (let run = 1; run <= campaign.repeat; run += 1) {
      test(`seed ${seed}${campaign.repeat > 1 ? ` run ${run}` : ''}`, async () => {
        const plan = buildPlan(seed);
        const started = realNow();
        const outcome = await runIteration(plan);
        appendStressRecord({
          suite: SUITE,
          seed,
          run,
          plan: {
            sessionKind: plan.sessionKind,
            dbLatencyMs: plan.dbLatencyMs,
            authHydrateAt: plan.authHydrateAt,
            videoEndMs: plan.videoEndMs,
            events: plan.events,
          },
          observed: outcome.observed,
          violations: outcome.violations,
          verdict: outcome.violations.length === 0 ? 'pass' : 'fail',
          durationMs: realNow() - started,
          atIso: new Date(realNow()).toISOString(),
        });
        if (outcome.violations.length > 0) {
          throw new Error(
            `seed ${seed} violated ${outcome.violations.length} invariant(s):${summarizeViolations(outcome.violations)}\nreplay: STRESS_SEED=${seed} npx jest __tests__/stress/appGate.splashHandoff`,
          );
        }
      });
    }
  }
});
