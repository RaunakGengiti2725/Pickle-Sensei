import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * ADVERSARIAL PASS 3 / tester #4 — scenario S7 against 4d812e1a.
 *
 * Render throws inside RootNavigator with NON-Error values (a string, then a
 * plain object, then a few nastier ones: null, undefined, a Symbol-free
 * object with a throwing toString, a circular object). The REAL App +
 * RootErrorBoundary run; RootNavigator is replaced by a stub that throws
 * whatever the test hands it. Assertions: crashFingerprint (App.tsx:51-56)
 * is stable per input and distinct across inputs, and the boundary's retry
 * actually re-mounts the navigator.
 */

jest.mock('react-native-safe-area-context', () => {
  const ReactActual = require('react');
  const { View: RNView } = require('react-native');
  const passthrough = (props: { children?: React.ReactNode }) =>
    ReactActual.createElement(RNView, null, props.children);
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

jest.mock('../../../src/state/appStore', () => {
  const { create } = jest.requireActual<typeof import('zustand')>('zustand');
  const { focusForGoal } = jest.requireActual<
    typeof import('../../../src/state/profile')
  >('../../../src/state/profile');
  return {
    focusForGoal,
    useAppStore: create(() => ({
      hydrated: false,
      ownerKey: null,
      profile: null,
      hydrateError: null,
      onboardingBusy: false,
      onboardingError: null,
      lastShotType: 'forehand_drive',
      hydrate: async () => {},
      completeOnboarding: async () => {},
      completePreAuthOnboarding: async () => true,
    })),
  };
});

jest.mock('../../../src/auth/authStore', () => {
  const { create } = jest.requireActual<typeof import('zustand')>('zustand');
  return {
    useAuthStore: create(() => ({
      hydrated: false,
      session: null,
      busy: false,
      error: null,
      hydrate: async () => {},
      signInWithApple: () => {},
      signInWithGoogle: () => {},
      signOut: () => {},
      clearError: () => {},
    })),
  };
});

jest.mock('../../../src/notifications/notificationStore', () => {
  const state = { completeOnboardingStep: async () => true };
  return {
    useNotificationStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});
jest.mock('../../../src/walkthrough/walkthroughStore', () => {
  const { create } = jest.requireActual<typeof import('zustand')>('zustand');
  return {
    useWalkthroughStore: create(() => ({
      visible: false,
      maybeShowFirstRun: async () => {},
    })),
  };
});
jest.mock('../../../src/notifications/useNotificationBootstrap', () => ({
  useNotificationBootstrap: () => {},
}));
jest.mock('../../../src/consistency/useConsistencyBootstrap', () => ({
  useConsistencyBootstrap: () => {},
}));

/** What the stubbed RootNavigator throws on its next render; null = render. */
const mockNavigatorThrow: { value: unknown; armed: boolean; renders: number } =
  { value: null, armed: false, renders: 0 };
jest.mock('../../../src/navigation/RootNavigator', () => {
  const ReactActual = require('react');
  const { View: RNView } = require('react-native');
  return {
    __esModule: true,
    RootNavigator: () => {
      mockNavigatorThrow.renders += 1;
      if (mockNavigatorThrow.armed) {
        throw mockNavigatorThrow.value;
      }
      return ReactActual.createElement(RNView, { testID: 'RootNavigator' });
    },
  };
});
jest.mock('../../../src/components/RankUpCelebration', () => {
  const ReactActual = require('react');
  const { View: RNView } = require('react-native');
  return {
    __esModule: true,
    RankUpCelebration: () =>
      ReactActual.createElement(RNView, { testID: 'RankUpCelebration' }),
  };
});
jest.mock('../../../src/consistency/StreakCelebration', () => {
  const ReactActual = require('react');
  const { View: RNView } = require('react-native');
  return {
    __esModule: true,
    StreakCelebration: () =>
      ReactActual.createElement(RNView, { testID: 'StreakCelebration' }),
  };
});
jest.mock('../../../src/walkthrough/FirstRunWalkthrough', () => {
  const ReactActual = require('react');
  const { View: RNView } = require('react-native');
  return {
    __esModule: true,
    FirstRunWalkthrough: () =>
      ReactActual.createElement(RNView, { testID: 'FirstRunWalkthrough' }),
  };
});
jest.mock('../../../src/screens/SplashScreen', () => {
  const ReactActual = require('react');
  const { View: RNView } = require('react-native');
  return {
    __esModule: true,
    SplashScreen: () =>
      ReactActual.createElement(RNView, { testID: 'SplashScreen' }),
  };
});

import App, { RootErrorBoundary } from '../../../App';
import { useAppStore } from '../../../src/state/appStore';
import { useAuthStore, type AuthSession } from '../../../src/auth/authStore';
import { GUEST_DATA_OWNER } from '../../../src/data/accountScope';
import { stabilitySlo } from '../../../src/analysis/stabilityTelemetry';

const recordSpy = jest.spyOn(stabilitySlo, 'record');

const guestSession: AuthSession = {
  provider: 'guest',
  subject: 'guest',
  canonicalAppUserId: null,
  localOnly: true,
  displayName: null,
  email: null,
};

const profile = {
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
} as const;

type Renderer = TestRenderer.ReactTestRenderer;

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join('');
}

function hostMarkers(renderer: Renderer, testID: string) {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
}

function crashFingerprints(): string[] {
  return recordSpy.mock.calls
    .map(([event]) => event as { kind: string; fingerprint?: string })
    .filter(event => event.kind === 'crash')
    .map(event => event.fingerprint ?? '<missing>');
}

function pressRetry(renderer: Renderer) {
  const retry = renderer.root
    .findAll(
      node =>
        node.props?.accessibilityLabel === 'Try again' &&
        typeof node.props?.onPress === 'function',
    )
    .pop();
  expect(retry).toBeDefined();
  act(() => retry!.props.onPress());
}

/** Mount the real App with a signed-in guest whose profile is complete. */
function renderAppAtNavigator(): Renderer {
  useAppStore.setState({
    hydrated: true,
    ownerKey: GUEST_DATA_OWNER,
    profile,
    hydrateError: null,
  });
  useAuthStore.setState({ hydrated: true, session: guestSession });
  let renderer!: Renderer;
  act(() => {
    renderer = TestRenderer.create(<App />);
  });
  return renderer;
}

const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  recordSpy.mockClear();
  consoleError.mockClear();
  mockNavigatorThrow.value = null;
  mockNavigatorThrow.armed = false;
  mockNavigatorThrow.renders = 0;
});

afterAll(() => consoleError.mockRestore());

describe('S7 — RootErrorBoundary vs non-Error throws inside RootNavigator', () => {
  it('a thrown STRING is caught, fingerprinted, and retry re-mounts the navigator', () => {
    mockNavigatorThrow.value = 'boom-string';
    mockNavigatorThrow.armed = true;
    const renderer = renderAppAtNavigator();
    expect(allText(renderer)).toContain('Something went wrong');
    expect(hostMarkers(renderer, 'RootNavigator')).toHaveLength(0);
    const fps = crashFingerprints();
    expect(fps).toHaveLength(1);
    expect(fps[0]).toMatch(/^[0-9a-f]{8}$/);

    mockNavigatorThrow.armed = false;
    pressRetry(renderer);
    expect(allText(renderer)).not.toContain('Something went wrong');
    expect(hostMarkers(renderer, 'RootNavigator')).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('a thrown plain OBJECT is caught and fingerprinted; retry that throws again records a second crash', () => {
    mockNavigatorThrow.value = { code: 'E_OBJ', nested: { a: 1 } };
    mockNavigatorThrow.armed = true;
    const renderer = renderAppAtNavigator();
    expect(allText(renderer)).toContain('Something went wrong');
    expect(crashFingerprints()).toHaveLength(1);

    // Retry while still broken → boundary catches again, same fingerprint.
    pressRetry(renderer);
    expect(allText(renderer)).toContain('Something went wrong');
    const fps = crashFingerprints();
    expect(fps).toHaveLength(2);
    expect(fps[1]).toBe(fps[0]);

    mockNavigatorThrow.armed = false;
    pressRetry(renderer);
    expect(hostMarkers(renderer, 'RootNavigator')).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('fingerprints are stable per value and distinct across string / object / Error / null / undefined', () => {
    const inputs: Array<[string, unknown]> = [
      ['string', 'boom-string'],
      ['object', { code: 'E_OBJ' }],
      ['error', new Error('boom-error')],
      ['null', null],
      ['undefined', undefined],
      ['number', 42],
      ['unicode-string', 'ボーム 💥 \u202Eboom'],
    ];
    const table: Record<string, string[]> = {};
    for (const [label, value] of inputs) {
      table[label] = [];
      for (let round = 0; round < 3; round += 1) {
        recordSpy.mockClear();
        mockNavigatorThrow.value = value;
        mockNavigatorThrow.armed = true;
        const renderer = renderAppAtNavigator();
        expect(allText(renderer)).toContain('Something went wrong');
        const fps = crashFingerprints();
        expect(fps).toHaveLength(1);
        table[label]!.push(fps[0]!);
        act(() => renderer.unmount());
      }
    }

    console.log(JSON.stringify({ probe: 'S7/fingerprints', table }));
    for (const fps of Object.values(table)) {
      expect(new Set(fps).size).toBe(1);
      expect(fps[0]).toMatch(/^[0-9a-f]{8}$/);
    }
    const firsts = Object.values(table).map(fps => fps[0]!);
    // String(null)='null' and String(undefined)='undefined' differ, and a
    // plain object stringifies to '[object Object]' — all distinct here.
    expect(new Set(firsts).size).toBe(firsts.length);
  });

  it('PROBE (documents observed behaviour): two DIFFERENT plain objects collapse to the same fingerprint ([object Object])', () => {
    const fpsA: string[] = [];
    for (const value of [{ code: 'E_A' }, { code: 'E_B', extra: [1, 2, 3] }]) {
      recordSpy.mockClear();
      mockNavigatorThrow.value = value;
      mockNavigatorThrow.armed = true;
      const renderer = renderAppAtNavigator();
      fpsA.push(crashFingerprints()[0]!);
      act(() => renderer.unmount());
    }

    console.log(JSON.stringify({ probe: 'S7/object-collision', fpsA }));
    // The scenario asks for "distinct" fingerprints. Two unrelated object
    // throws are indistinguishable in the stability SLO. Documented as a
    // probe; the boundary itself still recovers (see the tests above).
    expect(fpsA[0]).toBe(fpsA[1]);
  });

  it('CONTRACT (fails on 4d812e1a): hostile throwables (toString that throws, null-prototype object, circular, Symbol) — the boundary must not itself throw while fingerprinting', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular['self'] = circular;
    const inputs: Array<[string, unknown]> = [
      [
        'object-with-throwing-toString',
        {
          toString() {
            throw new Error('toString exploded');
          },
        },
      ],
      ['circular-object', circular],
      ['symbol', Symbol('boom')],
      ['null-prototype-object', Object.create(null)],
    ];
    const outcomes: Array<{ input: string; ok: boolean; detail?: string }> = [];
    for (const [label, value] of inputs) {
      recordSpy.mockClear();
      mockNavigatorThrow.value = value;
      mockNavigatorThrow.armed = true;
      let renderer: Renderer | null = null;
      try {
        act(() => {
          renderer = TestRenderer.create(
            <RootErrorBoundary>
              {React.createElement(
                jest.requireMock('../../../src/navigation/RootNavigator')
                  .RootNavigator,
              )}
            </RootErrorBoundary>,
          );
        });
        const fps = crashFingerprints();
        outcomes.push({
          input: label,
          ok: fps.length === 1 && /^[0-9a-f]{8}$/.test(fps[0]!),
          detail: fps.join(','),
        });
      } catch (error) {
        // The throw escaped RootErrorBoundary: in Release this is the
        // "dead app" the boundary exists to prevent.
        outcomes.push({
          input: label,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (renderer) act(() => renderer!.unmount());
      }
    }

    console.log(JSON.stringify({ probe: 'S7/hostile-throwables', outcomes }));
    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(true);
    }
  });

  it('rapid repeats: 20 throw→retry cycles keep the boundary alive and end mounted', () => {
    mockNavigatorThrow.value = 'flap';
    mockNavigatorThrow.armed = true;
    const renderer = renderAppAtNavigator();
    for (let i = 0; i < 20; i += 1) {
      expect(allText(renderer)).toContain('Something went wrong');
      mockNavigatorThrow.armed = i % 2 === 0; // alternate: still broken / fixed
      pressRetry(renderer);
      if (mockNavigatorThrow.armed) {
        expect(allText(renderer)).toContain('Something went wrong');
      } else {
        expect(hostMarkers(renderer, 'RootNavigator')).toHaveLength(1);
        mockNavigatorThrow.armed = true;
        // Force a Gate re-render (new profile identity) so the re-armed
        // navigator throws again.
        act(() => useAppStore.setState({ profile: { ...profile } }));
      }
    }
    mockNavigatorThrow.armed = false;
    pressRetry(renderer);
    expect(hostMarkers(renderer, 'RootNavigator')).toHaveLength(1);
    expect(crashFingerprints().every(fp => fp === crashFingerprints()[0])).toBe(
      true,
    );
    act(() => renderer.unmount());
  });
});
