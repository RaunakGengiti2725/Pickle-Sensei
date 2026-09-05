import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { create } from 'zustand';
import {
  capture,
  finishRow,
  planCampaign,
  summarize,
  writeJsonArtifact,
  type StressRow,
} from '../../stress-harness/mod-app-root/campaign';
import {
  malformedString,
  safeDescribe,
} from '../../stress-harness/mod-app-root/malformedCorpus';
import {
  chance,
  int,
  makePrng,
  pick,
  type Rng,
} from '../../stress-harness/mod-app-root/prng';

/**
 * STRESS `mod-app-root` / lens `boundary-malformed` — App.tsx root Gate
 * against MALFORMED STORE STATE, cold (mount) and warm (a second state
 * applied to the mounted tree, i.e. sign-in/sign-out/re-hydrate ordering).
 *
 * The Gate reads `useAuthStore` (hydrated, session) and `useAppStore`
 * (hydrated, ownerKey, profile, hydrateError, hydrate) and turns them into
 * exactly one surface: loading, welcome/sign-in/onboarding, profile-load
 * error, or the app. Every field is fed wrong types, malformed strings
 * (path traversal, null bytes, 64KB+, unicode normalization pairs, lone
 * surrogates, prototype-pollution keys, future schema versions, numeric
 * text, UUID lookalikes), null-prototype objects, arrays, primitives and
 * proxies. The only realistic external source is the Keychain session
 * record (`sessionVault.ts`), so `session` gets the widest corpus.
 *
 * Invariants per row (the whole <App/> is mounted, RootErrorBoundary
 * included — the Gate is never rendered bare):
 * - cold-no-escape          mounting never throws out of the renderer
 * - warm-no-escape          applying the second state never throws out
 * - never-blank             some product surface is painted after each
 *                           step (loading, a screen, the profile error, or
 *                           the boundary's ErrorState) — never a bare View
 * - no-hydrate-before-auth  appStore.hydrate() is never called while
 *                           authStore.hydrated is falsy (cold-launch order)
 * - app-needs-valid-owner   a real screen (welcome/sign-in/onboarding/app)
 *                           is only painted when appStore.hydrated is truthy
 *                           AND ownerKey is a valid owner ('device-guest',
 *                           'signed-out', or a canonical UUID) — malformed
 *                           owners never see product UI
 * - gate-throw-is-caught    if the Gate itself throws (e.g. a non-UUID
 *                           canonicalAppUserId reaches canonicalDataOwner),
 *                           the boundary's ErrorState is painted and exactly
 *                           one non-fatal crash event is recorded
 * - unmount-no-throw
 *
 * Replay one row: STRESS_SEED=<seed> npx jest --ci __tests__/stress/modAppRoot.gateStoreState
 * Full campaign:  STRESS_ITER=1000 npx jest --ci __tests__/stress/modAppRoot.gateStoreState
 */

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View, SafeAreaProvider: View };
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
jest.mock('../../src/screens/WelcomeScreen', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return { WelcomeScreen: () => R.createElement(RN.Text, null, 'WELCOME') };
});
jest.mock('../../src/screens/SignInScreen', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return { SignInScreen: () => R.createElement(RN.Text, null, 'SIGN_IN') };
});
jest.mock('../../src/screens/SplashScreen', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    SplashScreen: (props: { ready: boolean; onFinished: () => void }) => {
      R.useEffect(() => {
        if (props.ready) props.onFinished();
      }, [props.ready, props.onFinished]);
      return null;
    },
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

/** The Gate's view of the stores, deliberately untyped: this is the attack. */
interface LooseAppState {
  hydrated: unknown;
  ownerKey: unknown;
  profile: unknown;
  hydrateError: unknown;
  hydrate: () => Promise<void>;
}
interface LooseAuthState {
  hydrated: unknown;
  session: unknown;
  hydrate: () => Promise<void>;
}

const hydrateAppCalls: Array<{ authHydrated: unknown }> = [];
const mockUseAppStore = create<LooseAppState>(() => ({
  hydrated: false,
  ownerKey: null,
  profile: null,
  hydrateError: null,
  hydrate: async () => {
    hydrateAppCalls.push({
      authHydrated: mockUseAuthStore.getState().hydrated,
    });
  },
}));
jest.mock('../../src/state/appStore', () => ({
  useAppStore: (selector: (s: LooseAppState) => unknown) =>
    mockUseAppStore(selector),
}));
const mockUseAuthStore = create<LooseAuthState>(() => ({
  hydrated: false,
  session: null,
  hydrate: async () => {},
}));
jest.mock('../../src/auth/authStore', () => ({
  useAuthStore: (selector: (s: LooseAuthState) => unknown) =>
    mockUseAuthStore(selector),
}));

import App from '../../App';
import { stabilitySlo } from '../../src/analysis/stabilityTelemetry';
import { Button } from '../../src/design/components';

const CANONICAL = '55555555-5555-4555-8555-555555555555';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX8 = /^[0-9a-f]{8}$/;
const BOUNDARY_TITLE = 'Something went wrong';
const PROFILE_ERROR_TITLE = 'Your coaching profile couldn’t load';
const LOADING_LABELS = ['Loading your account', 'Getting things ready'];
const SCREENS = ['ROOT_NAVIGATOR', 'ONBOARDING', 'WELCOME', 'SIGN_IN'];

type Renderer = TestRenderer.ReactTestRenderer;

// ─── Malformed store-state corpus ─────────────────────────────────────────────

interface Drawn {
  label: string;
  value: unknown;
}

/** Wrong-typed stand-ins for a boolean flag. */
function malformedFlag(rng: Rng): Drawn {
  return pick(rng, [
    { label: 'true', value: true },
    { label: 'false', value: false },
    { label: 'undefined', value: undefined },
    { label: 'null', value: null },
    { label: 'string:"true"', value: 'true' },
    { label: 'string:"false"', value: 'false' },
    { label: 'string:empty', value: '' },
    { label: 'number:1', value: 1 },
    { label: 'number:0', value: 0 },
    { label: 'number:-0', value: -0 },
    { label: 'number:NaN', value: Number.NaN },
    { label: 'number:Infinity', value: Number.POSITIVE_INFINITY },
    { label: 'number:MAX_SAFE+1', value: Number.MAX_SAFE_INTEGER + 1 },
    { label: 'bigint:0n', value: BigInt(0) },
    { label: 'object:empty', value: {} },
    { label: 'array:empty', value: [] },
    { label: 'array:[false]', value: [false] },
    { label: 'object:null-proto', value: Object.create(null) as object },
    { label: 'symbol', value: Symbol('hydrated') },
    { label: 'function', value: () => true },
    { label: 'date:invalid', value: new Date(Number.NaN) },
  ] as const satisfies readonly Drawn[]);
}

/** Values for `ownerKey` / `canonicalAppUserId`-shaped fields. */
function malformedOwner(rng: Rng): Drawn {
  const roll = rng();
  if (roll < 0.2) return { label: 'valid-canonical', value: CANONICAL };
  if (roll < 0.28) return { label: 'valid-guest', value: 'device-guest' };
  if (roll < 0.36) return { label: 'valid-signed-out', value: 'signed-out' };
  if (roll < 0.42) return { label: 'null', value: null };
  if (roll < 0.46) return { label: 'undefined', value: undefined };
  if (roll < 0.5)
    return {
      label: 'valid-canonical-upper-padded',
      value: `  ${CANONICAL.toUpperCase()} `,
    };
  if (roll < 0.86) {
    const s = malformedString(rng);
    return { label: `${s.family}/${s.label}`, value: s.value };
  }
  return pick(rng, [
    { label: 'number:0', value: 0 },
    { label: 'number:NaN', value: Number.NaN },
    { label: 'number:1e309', value: Number.POSITIVE_INFINITY },
    { label: 'object:empty', value: {} },
    { label: 'array:[uuid]', value: [CANONICAL] },
    { label: 'object:null-proto', value: Object.create(null) as object },
    { label: 'boolean:true', value: true },
    { label: 'symbol', value: Symbol('owner') },
    { label: 'bigint', value: BigInt('55555555555555555555') },
  ] as const satisfies readonly Drawn[]);
}

function malformedProvider(rng: Rng): Drawn {
  const roll = rng();
  if (roll < 0.3) return { label: 'apple', value: 'apple' };
  if (roll < 0.45) return { label: 'google', value: 'google' };
  if (roll < 0.6) return { label: 'guest', value: 'guest' };
  if (roll < 0.85) {
    const s = malformedString(rng);
    return { label: `${s.family}/${s.label}`, value: s.value };
  }
  return pick(rng, [
    { label: 'undefined', value: undefined },
    { label: 'null', value: null },
    { label: 'string:GUEST', value: 'GUEST' },
    { label: 'string:guest\\0', value: 'guest\u0000' },
    { label: 'string:guest-nfd', value: 'gue\u0301st' },
    { label: 'array:[guest]', value: ['guest'] },
    { label: 'object:{}', value: {} },
    { label: 'number:2', value: 2 },
  ] as const satisfies readonly Drawn[]);
}

interface DrawnSession extends Drawn {
  /** What App.tsx's owner selection sees, for the oracle. */
  provider: unknown;
  canonicalAppUserId: unknown;
  truthy: boolean;
}

function malformedSession(rng: Rng): DrawnSession {
  const roll = rng();
  if (roll < 0.15)
    return {
      label: 'null',
      value: null,
      provider: undefined,
      canonicalAppUserId: undefined,
      truthy: false,
    };
  if (roll < 0.2)
    return {
      label: 'undefined',
      value: undefined,
      provider: undefined,
      canonicalAppUserId: undefined,
      truthy: false,
    };
  if (roll < 0.3) {
    const primitive = pick(rng, [
      { label: 'string:empty', value: '' },
      { label: 'string:"null"', value: 'null' },
      { label: 'string:json-session', value: '{"provider":"apple"}' },
      { label: 'number:0', value: 0 },
      { label: 'number:1', value: 1 },
      { label: 'number:NaN', value: Number.NaN },
      { label: 'boolean:true', value: true },
      { label: 'boolean:false', value: false },
      { label: 'bigint:1n', value: BigInt(1) },
      { label: 'symbol', value: Symbol('session') },
    ] as const satisfies readonly Drawn[]);
    const v = primitive.value;
    return {
      label: `primitive/${primitive.label}`,
      value: v,
      provider: undefined,
      canonicalAppUserId: undefined,
      truthy: Boolean(v),
    };
  }
  if (roll < 0.36) {
    const arr = pick(rng, [
      { label: 'array:empty', value: [] as unknown[] },
      { label: 'array:[session]', value: [{ provider: 'apple' }] },
    ] as const satisfies readonly Drawn[]);
    return {
      label: arr.label,
      value: arr.value,
      provider: undefined,
      canonicalAppUserId: undefined,
      truthy: true,
    };
  }
  // Object-shaped session with malformed fields.
  const provider = malformedProvider(rng);
  const owner = malformedOwner(rng);
  const shape = pick(rng, [
    'plain',
    'null-proto',
    'frozen',
    'json-roundtrip',
    'proto-pollution',
    'future-version',
    'extra-64kb-field',
  ] as const);
  let value: Record<string, unknown>;
  switch (shape) {
    case 'null-proto':
      value = Object.create(null) as Record<string, unknown>;
      value['provider'] = provider.value;
      value['canonicalAppUserId'] = owner.value;
      break;
    case 'frozen':
      value = Object.freeze({
        provider: provider.value,
        canonicalAppUserId: owner.value,
      });
      break;
    case 'json-roundtrip': {
      const parsed = capture(
        () =>
          JSON.parse(
            JSON.stringify({
              provider: provider.value,
              canonicalAppUserId: owner.value,
            }),
          ) as Record<string, unknown>,
      );
      value = parsed.threw
        ? { provider: provider.value, canonicalAppUserId: owner.value }
        : parsed.value;
      break;
    }
    case 'proto-pollution':
      value = JSON.parse(
        `{"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}},"provider":${JSON.stringify(
          typeof provider.value === 'string' ? provider.value : 'apple',
        )},"canonicalAppUserId":${JSON.stringify(
          typeof owner.value === 'string' ? owner.value : CANONICAL,
        )}}`,
      ) as Record<string, unknown>;
      break;
    case 'future-version':
      value = {
        version: 99,
        schema: 'session/v99',
        provider: provider.value,
        canonicalAppUserId: owner.value,
        refreshToken: 'x'.repeat(int(rng, 0, 4096)),
        unknownFutureField: { nested: [1, 2, 3] },
      };
      break;
    case 'extra-64kb-field':
      value = {
        provider: provider.value,
        canonicalAppUserId: owner.value,
        email: 'e'.repeat(65_537),
        displayName: '\u0000'.repeat(int(rng, 1, 64)),
      };
      break;
    default:
      value = { provider: provider.value, canonicalAppUserId: owner.value };
  }
  return {
    label: `${shape}{provider=${provider.label};id=${owner.label}}`,
    value,
    provider: value['provider'],
    canonicalAppUserId: value['canonicalAppUserId'],
    truthy: true,
  };
}

function malformedProfile(rng: Rng): Drawn {
  return pick(rng, [
    { label: 'null', value: null },
    { label: 'null', value: null },
    { label: 'valid', value: { skillLevel: '3.5' } },
    { label: 'valid', value: { skillLevel: '3.5' } },
    { label: 'undefined', value: undefined },
    { label: 'object:empty', value: {} },
    { label: 'array:empty', value: [] },
    { label: 'string:empty', value: '' },
    { label: 'string:json', value: '{"skillLevel":"3.5"}' },
    { label: 'number:0', value: 0 },
    { label: 'number:NaN', value: Number.NaN },
    { label: 'boolean:false', value: false },
    { label: 'object:null-proto', value: Object.create(null) as object },
    {
      label: 'object:future-schema',
      value: { schemaVersion: 42, skillLevel: { major: 3, minor: 5 } },
    },
    {
      label: 'object:huge',
      value: { skillLevel: '3.5', notes: 'n'.repeat(70_000) },
    },
  ] as const satisfies readonly Drawn[]);
}

function malformedHydrateError(rng: Rng): Drawn {
  const roll = rng();
  if (roll < 0.45) return { label: 'null', value: null };
  if (roll < 0.5) return { label: 'undefined', value: undefined };
  if (roll < 0.8) {
    const s = malformedString(rng);
    return { label: `${s.family}/${s.label}`, value: s.value };
  }
  return pick(rng, [
    { label: 'object:Error', value: new Error('hydrate failed') },
    { label: 'object:{message}', value: { message: 'x' } },
    { label: 'array:[msg]', value: ['x'] },
    { label: 'number:500', value: 500 },
    { label: 'number:NaN', value: Number.NaN },
    { label: 'boolean:true', value: true },
    { label: 'object:null-proto', value: Object.create(null) as object },
  ] as const satisfies readonly Drawn[]);
}

interface DrawnState {
  labels: Record<string, string>;
  auth: { hydrated: unknown; session: unknown };
  app: {
    hydrated: unknown;
    ownerKey: unknown;
    profile: unknown;
    hydrateError: unknown;
  };
  session: DrawnSession;
}

function drawState(rng: Rng): DrawnState {
  const authHydrated = malformedFlag(rng);
  const session = malformedSession(rng);
  const appHydrated = malformedFlag(rng);
  // Bias ownerKey toward "whatever the session implies" so the ready path
  // is actually reached often enough to be tested, not just the loading one.
  const ownerKey: Drawn = chance(rng, 0.4)
    ? impliedOwner(session)
    : malformedOwner(rng);
  const profile = malformedProfile(rng);
  const hydrateError = malformedHydrateError(rng);
  return {
    labels: {
      authHydrated: authHydrated.label,
      session: session.label,
      appHydrated: appHydrated.label,
      ownerKey: ownerKey.label,
      profile: profile.label,
      hydrateError: hydrateError.label,
    },
    auth: { hydrated: authHydrated.value, session: session.value },
    app: {
      hydrated: appHydrated.value,
      ownerKey: ownerKey.value,
      profile: profile.value,
      hydrateError: hydrateError.value,
    },
    session,
  };
}

/** The owner App.tsx would select for this session — or the throw it takes. */
function impliedOwner(session: DrawnSession): Drawn {
  if (!session.truthy)
    return { label: 'implied:signed-out', value: 'signed-out' };
  if (session.provider === 'guest')
    return { label: 'implied:guest', value: 'device-guest' };
  const id = session.canonicalAppUserId;
  if (typeof id === 'string' && id && UUID_PATTERN.test(id.trim())) {
    return { label: 'implied:canonical', value: id.trim().toLowerCase() };
  }
  if (id) return { label: 'implied:throws', value: 'signed-out' };
  return { label: 'implied:signed-out', value: 'signed-out' };
}

function isValidOwner(value: unknown): boolean {
  return (
    value === 'device-guest' ||
    value === 'signed-out' ||
    (typeof value === 'string' && UUID_PATTERN.test(value))
  );
}

// ─── Renderer helpers ─────────────────────────────────────────────────────────

function allText(renderer: Renderer): string {
  const probe = capture(() =>
    renderer.root
      .findAllByType(Text)
      .map(node => node.props.children as unknown)
      .flat()
      .filter((c): c is string => typeof c === 'string')
      .join('\n'),
  );
  return probe.threw ? '' : probe.value;
}

function tryAgainCount(renderer: Renderer): number {
  const probe = capture(
    () =>
      renderer.root
        .findAllByType(Button)
        .filter(node => node.props.label === 'Try again').length,
  );
  return probe.threw ? 0 : probe.value;
}

function classifySurface(renderer: Renderer | null): {
  surface:
    'loading' | 'screen' | 'profile-error' | 'boundary' | 'blank' | 'unknown';
  screen: string | null;
  text: string;
} {
  if (!renderer) return { surface: 'blank', screen: null, text: '' };
  const text = allText(renderer);
  const screen = SCREENS.find(marker => text.includes(marker)) ?? null;
  if (text.includes(BOUNDARY_TITLE) && tryAgainCount(renderer) >= 1)
    return { surface: 'boundary', screen, text };
  if (text.includes(PROFILE_ERROR_TITLE))
    return { surface: 'profile-error', screen, text };
  if (screen) return { surface: 'screen', screen, text };
  if (LOADING_LABELS.some(label => text.includes(label)))
    return { surface: 'loading', screen, text };
  if (text.trim() === '') return { surface: 'blank', screen, text };
  return { surface: 'unknown', screen, text };
}

function applyState(state: DrawnState) {
  mockUseAuthStore.setState({
    hydrated: state.auth.hydrated,
    session: state.auth.session,
  });
  mockUseAppStore.setState({
    hydrated: state.app.hydrated,
    ownerKey: state.app.ownerKey,
    profile: state.app.profile,
    hydrateError: state.app.hydrateError,
  });
}

type CrashEvent = Extract<
  ReturnType<typeof stabilitySlo.events>[number],
  { kind: 'crash' }
>;

function crashEventsSince(start: number): CrashEvent[] {
  return stabilitySlo
    .events()
    .slice(start)
    .filter((event): event is CrashEvent => event.kind === 'crash');
}

function pressTryAgain(renderer: Renderer) {
  const button = renderer.root
    .findAllByType(Button)
    .find(node => node.props.label === 'Try again');
  (button?.props as { onPress?: () => void } | undefined)?.onPress?.();
}

/**
 * Warm step: same tree, new state. A boundary still holding a cold catch is
 * released with one retry so the warm verdict is the Gate's, not the
 * boundary's memory.
 */
function warm(renderer: Renderer, state: DrawnState, releaseBoundary: boolean) {
  return capture(() => {
    act(() => {
      applyState(state);
    });
    if (releaseBoundary) {
      act(() => {
        pressTryAgain(renderer);
      });
    }
  });
}

/** Mount inside act(), returning the renderer or the escaped throw. */
function mount(element: React.ReactElement) {
  return capture(() => {
    let created!: Renderer;
    act(() => {
      created = TestRenderer.create(element);
    });
    return created;
  });
}

function reactHealthy(): boolean {
  const probe = mount(<Text>probe</Text>);
  if (probe.threw) return false;
  const text = allText(probe.value);
  capture(() => act(() => probe.value.unmount()));
  return text.includes('probe');
}

let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
const reactPoisonedAfterSeeds: number[] = [];

beforeAll(() => {
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

const plan = planCampaign('gate-store-state', 40);

function stepInvariants(
  renderer: Renderer | null,
  state: DrawnState,
  stepThrew: boolean,
  crashEvents: CrashEvent[],
) {
  const surface = classifySurface(renderer);
  // App.tsx only reaches canonicalDataOwner() once auth is hydrated and the
  // session carries a truthy non-guest canonicalAppUserId; a non-UUID there
  // throws out of the Gate's render.
  const gateShouldThrow =
    Boolean(state.auth.hydrated) &&
    impliedOwner(state.session).label === 'implied:throws';
  const gateThrowCaught = !gateShouldThrow
    ? true
    : surface.surface === 'boundary' &&
      crashEvents.length === 1 &&
      crashEvents[0]?.fatal === false &&
      HEX8.test(crashEvents[0].fingerprint);
  const appNeedsValidOwner =
    surface.surface !== 'screen' ||
    (Boolean(state.app.hydrated) && isValidOwner(state.app.ownerKey));
  return {
    surface,
    crashEvents: crashEvents.length,
    gateShouldThrow,
    // The boundary caught something the owner oracle did not predict (e.g. a
    // wrong-typed hydrateError rendered as a Text child). Observed, not an
    // invariant: those fields are store-internal, never externally sourced.
    boundaryUnpredicted: surface.surface === 'boundary' && !gateShouldThrow,
    invariants: {
      noEscape: !stepThrew,
      neverBlank: surface.surface !== 'blank' && surface.surface !== 'unknown',
      gateThrowCaught,
      appNeedsValidOwner,
    },
  };
}

function runIteration(seed: number): StressRow {
  const rng = makePrng(seed);
  const cold = drawState(rng);
  const warmState = drawState(rng);
  const started = Date.now();
  hydrateAppCalls.length = 0;

  // ── cold launch ──
  applyState(cold);
  let eventsBefore = stabilitySlo.events().length;
  const mounted = mount(<App />);
  const renderer = mounted.threw ? null : mounted.value;
  const coldStep = stepInvariants(
    renderer,
    cold,
    mounted.threw,
    crashEventsSince(eventsBefore),
  );
  const coldHydrateCalls = hydrateAppCalls.length;

  // ── warm transition (sign-in / sign-out / re-hydrate ordering) ──
  eventsBefore = stabilitySlo.events().length;
  const current = renderer;
  const releaseBoundary = coldStep.surface.surface === 'boundary';
  const warmOutcome = current
    ? warm(current, warmState, releaseBoundary)
    : ({ threw: false, value: undefined } as const);
  const warmStep = stepInvariants(
    current,
    warmState,
    warmOutcome.threw,
    crashEventsSince(eventsBefore),
  );

  // ── cold-launch ordering: appStore.hydrate never before auth hydrated ──
  const hydrateBeforeAuth = hydrateAppCalls.filter(
    call => !call.authHydrated,
  ).length;

  // ── unmount ──
  let unmountThrew: string | null = null;
  if (current) {
    const done = capture(() => {
      act(() => current.unmount());
    });
    if (done.threw) unmountThrew = done.error;
  }

  let reactPoisoned = false;
  if (mounted.threw || warmOutcome.threw || unmountThrew !== null) {
    reactPoisoned = !reactHealthy();
    if (reactPoisoned) reactPoisonedAfterSeeds.push(seed);
  }

  return finishRow({
    suite: plan.suite,
    scenario: 'cold-mount→warm-state→unmount',
    seed,
    inputs: {
      cold: cold.labels,
      warm: warmState.labels,
      coldSessionType: safeDescribe(cold.auth.session),
      warmSessionType: safeDescribe(warmState.auth.session),
    },
    observed: {
      coldSurface: coldStep.surface.surface,
      coldScreen: coldStep.surface.screen,
      coldThrew: mounted.threw ? mounted.error : null,
      coldCrashEvents: coldStep.crashEvents,
      coldGateShouldThrow: coldStep.gateShouldThrow,
      coldHydrateCalls,
      warmSurface: warmStep.surface.surface,
      warmScreen: warmStep.surface.screen,
      warmThrew: warmOutcome.threw ? warmOutcome.error : null,
      warmCrashEvents: warmStep.crashEvents,
      warmGateShouldThrow: warmStep.gateShouldThrow,
      warmReleasedBoundary: releaseBoundary,
      coldBoundaryUnpredicted: coldStep.boundaryUnpredicted,
      warmBoundaryUnpredicted: warmStep.boundaryUnpredicted,
      hydrateCallsTotal: hydrateAppCalls.length,
      hydrateBeforeAuth,
      unmountThrew,
      reactPoisoned,
    },
    invariants: {
      'cold-no-escape': coldStep.invariants.noEscape,
      'warm-no-escape': warmStep.invariants.noEscape,
      'never-blank':
        coldStep.invariants.neverBlank && warmStep.invariants.neverBlank,
      'no-hydrate-before-auth': hydrateBeforeAuth === 0,
      'app-needs-valid-owner':
        coldStep.invariants.appNeedsValidOwner &&
        warmStep.invariants.appNeedsValidOwner,
      'gate-throw-is-caught':
        coldStep.invariants.gateThrowCaught &&
        warmStep.invariants.gateThrowCaught,
      'unmount-no-throw': unmountThrew === null,
    },
    durationMs: Date.now() - started,
  });
}

describe(`Gate × malformed store state, cold + warm (${plan.iterations} seeds)`, () => {
  const rows: StressRow[] = [];
  const wallStart = Date.now();

  afterAll(() => {
    const summary = summarize(
      plan,
      rows,
      Date.now() - wallStart,
      row =>
        String((row.inputs['cold'] as Record<string, string>)['session']).split(
          '{',
        )[0] ?? 'n/a',
      row =>
        row.ok
          ? `held/${String(row.observed['coldSurface'])}→${String(row.observed['warmSurface'])}`
          : row.invariants['cold-no-escape'] === false ||
              row.invariants['warm-no-escape'] === false
            ? 'broken-escaped-root'
            : 'broken',
    );
    writeJsonArtifact('gate-store-state.rows.json', rows);
    writeJsonArtifact('gate-store-state.summary.json', {
      ...summary,
      reactPoisonedAfterSeeds,
      surfaces: rows.reduce<Record<string, number>>((acc, row) => {
        for (const key of ['coldSurface', 'warmSurface'] as const) {
          const k = `${key}:${String(row.observed[key])}`;
          acc[k] = (acc[k] ?? 0) + 1;
        }
        return acc;
      }, {}),
      gateThrowsPredicted: rows.filter(
        row =>
          row.observed['coldGateShouldThrow'] === true ||
          row.observed['warmGateShouldThrow'] === true,
      ).length,
      boundaryUnpredicted: rows
        .filter(
          row =>
            row.observed['coldBoundaryUnpredicted'] === true ||
            row.observed['warmBoundaryUnpredicted'] === true,
        )
        .map(row => ({
          seed: row.seed,
          cold: row.observed['coldBoundaryUnpredicted']
            ? row.inputs['cold']
            : null,
          warm: row.observed['warmBoundaryUnpredicted']
            ? row.inputs['warm']
            : null,
        })),
    });
  });

  it.each(plan.seeds.map(seed => [seed] as const))(
    'seed %d: malformed store state lands on one graceful surface',
    seed => {
      const row = runIteration(seed);
      rows.push(row);
      expect(row.failed).toEqual([]);
    },
  );
});
