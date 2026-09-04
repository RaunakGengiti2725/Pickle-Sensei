import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { Profile } from '../../src/state/profile';

/**
 * ADVERSARIAL PASS (mobile-launch-onboarding, tester #2, pass 3) — S7.
 *
 * The REAL RootNavigator (real HomeScreen, SettingsScreen, PremiumTabBar /
 * Coach action portal) mounted inside the REAL RootErrorBoundary, over the
 * REAL appStore hydrated from a legacy `profile` kv row written by a build
 * that predates `focusCheckpoint` (the S2 migration path). React Navigation
 * itself is replaced by transparent stubs that render every registered tab
 * screen at once so all Home/Coach/Settings surfaces are exercised in one
 * mount; heavy tabs that never read `focusCheckpoint` (Library, Performance)
 * and stack-only screens are stand-ins.
 *
 *   - focusCheckpoint undefined  → every surface must render a fallback and
 *                                  the boundary must NOT catch.
 *   - focusCheckpoint non-string → what happens when the un-validated row
 *                                  carries the wrong type.
 */

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    SafeAreaProvider: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
  };
});
jest.mock('react-native-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => {
  const React = require('react');
  return {
    NavigationContainer: (props: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, props.children),
    DefaultTheme: { dark: false, colors: {}, fonts: {} },
    createNavigationContainerRef: () => ({
      isReady: () => true,
      navigate: (...args: unknown[]) => mockNavigate(...args),
    }),
    useNavigation: () => ({
      navigate: mockNavigate,
      goBack: jest.fn(),
      getParent: () => ({ navigate: mockNavigate }),
    }),
    useFocusEffect: (callback: () => void | (() => void)) => {
      React.useEffect(() => callback(), [callback]);
    },
  };
});
jest.mock('@react-navigation/native-stack', () => {
  const React = require('react');
  return {
    createNativeStackNavigator: () => ({
      // Only the initial route ("Tabs", first child) is live, as in the app.
      Navigator: (props: { children?: React.ReactNode }) => {
        const [first] = React.Children.toArray(props.children);
        return first ?? null;
      },
      Screen: (props: { name: string; component: React.ComponentType }) =>
        React.createElement(props.component, {
          navigation: { navigate: mockNavigate },
          route: { name: props.name, params: undefined },
        }),
    }),
  };
});
const mockEmit = jest.fn(() => ({ defaultPrevented: false }));
jest.mock('@react-navigation/bottom-tabs', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    createBottomTabNavigator: () => ({
      Navigator: (props: {
        children?: React.ReactNode;
        tabBar: (barProps: unknown) => React.ReactNode;
      }) => {
        const routes = React.Children.toArray(props.children).map(
          (child: { props: { name: string } }) => ({
            key: `${child.props.name}-1`,
            name: child.props.name,
          }),
        );
        return React.createElement(
          View,
          null,
          props.children,
          props.tabBar({
            state: { index: 0, routes },
            navigation: {
              emit: mockEmit,
              navigate: mockNavigate,
              getParent: () => ({ navigate: mockNavigate }),
            },
            descriptors: {},
            insets: { top: 0, bottom: 0, left: 0, right: 0 },
          }),
        );
      },
      Screen: (props: { name: string; component: React.ComponentType }) =>
        React.createElement(props.component, {
          navigation: { navigate: mockNavigate },
          route: { name: props.name, params: undefined },
        }),
    }),
  };
});

const mockKv = new Map<string, string>();
jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/\s+/g, ' ');
      if (statement.startsWith('SELECT value FROM kv')) {
        const value = mockKv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKv.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => ({
    async permissionState() {
      return 'undetermined';
    },
    async requestPermission() {
      return 'denied';
    },
    async applyPlan() {},
    async cancelAllPlanned() {},
    async openSystemSettings() {},
  }),
  subscribeToNotificationPresses: () => () => {},
}));
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => null,
}));
jest.mock('../../src/progress/api', () => ({
  fetchCanonicalProgress: jest.fn(async () => null),
}));
jest.mock('../../src/progress/playerRank', () => {
  const actual = jest.requireActual<
    typeof import('../../src/progress/playerRank')
  >('../../src/progress/playerRank');
  return { ...actual, fetchPlayerRank: jest.fn(async () => null) };
});
jest.mock('../../src/progress/rankCelebration', () => {
  const state = { maybeCelebrate: async () => {} };
  return {
    useRankCelebrationStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});
jest.mock('../../src/consistency/store', () => {
  const state = {
    snapshot: null,
    refresh: async () => {},
    hydrated: true,
  };
  return {
    useConsistencyStore: Object.assign(
      (selector: (s: typeof state) => unknown) => selector(state),
      { getState: () => state },
    ),
  };
});
jest.mock('../../src/walkthrough/walkthroughStore', () => {
  const state = {
    maybeShowFirstRun: async () => {},
    replay: async () => {},
    replayWalkthrough: async () => {},
    visible: false,
  };
  return {
    useWalkthroughStore: Object.assign(
      (selector: (s: typeof state) => unknown) => selector(state),
      { getState: () => state },
    ),
  };
});
jest.mock('../../src/review/appStoreReview', () => ({
  rateAppFromSettings: async () => 'unavailable',
}));

// Tabs / stack screens that never read `focusCheckpoint` (INFERRED by grep
// over src/screens at 4d812e1a: only Home, Settings and Analyze read it) are
// stand-ins so the mount stays deterministic.
jest.mock('../../src/screens/LibraryScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    LibraryScreen: () => React.createElement(Text, null, 'LIBRARY_STUB'),
  };
});
jest.mock('../../src/screens/ProgressScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    ProgressScreen: () => React.createElement(Text, null, 'PROGRESS_STUB'),
  };
});
jest.mock('../../src/screens/AnalyzeScreen', () => ({
  AnalyzeScreen: () => null,
}));
jest.mock('../../src/screens/DrillLibraryScreen', () => ({
  DrillLibraryScreen: () => null,
}));
jest.mock('../../src/screens/ResultScreen', () => ({
  ResultScreen: () => null,
}));
jest.mock('../../src/screens/ResultDetailsScreen', () => ({
  ResultDetailsScreen: () => null,
}));
jest.mock('../../src/screens/FormReviewScreen', () => ({
  FormReviewScreen: () => null,
}));
jest.mock('../../src/screens/StreakCalendarScreen', () => ({
  StreakCalendarScreen: () => null,
}));
jest.mock('../../src/screens/PaywallScreen', () => ({
  PaywallScreen: () => null,
}));
jest.mock('../../src/screens/SignInScreen', () => ({
  SignInScreen: () => null,
}));
jest.mock('../../src/screens/ManageAccountScreen', () => ({
  ManageAccountScreen: () => null,
}));
jest.mock('../../src/screens/ConsentSettingsScreen', () => ({
  ConsentSettingsScreen: () => null,
}));
jest.mock('../../src/screens/NotificationSettingsScreen', () => ({
  NotificationSettingsScreen: () => null,
}));

import { RootErrorBoundary } from '../../App';
import { RootNavigator } from '../../src/navigation/RootNavigator';
import { stabilitySlo } from '../../src/analysis/stabilityTelemetry';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { useAppStore } from '../../src/state/appStore';
import { useAuthStore } from '../../src/auth/authStore';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { DEFAULT_NOTIFICATION_PREFS } from '../../src/notifications/types';

type Renderer = TestRenderer.ReactTestRenderer;

/** Legacy row from a build that predates focusCheckpoint. */
const legacyProfileWithoutFocus = {
  skillLevel: '3.0',
  handedness: 'left',
  goal: 'dinks',
  biggestProblem: 'consistency',
};

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string | number => typeof c !== 'object')
    .join('\n');
}

function pressables(renderer: Renderer, label: string) {
  return renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
}

async function settle() {
  await act(async () => {});
  await act(async () => {});
}

const mounted: Renderer[] = [];
async function mountNavigator(): Promise<Renderer> {
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <RootErrorBoundary>
        <RootNavigator />
      </RootErrorBoundary>,
    );
  });
  await settle();
  mounted.push(renderer);
  return renderer;
}

async function hydrateGuestFromLegacyRow(row: unknown) {
  mockKv.set('profile', JSON.stringify(row));
  setActiveDataOwner(GUEST_DATA_OWNER);
  await useAppStore.getState().hydrate();
}

let crashSpy: jest.SpyInstance;
let consoleError: jest.SpyInstance;
beforeEach(() => {
  mockKv.clear();
  mockNavigate.mockClear();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
  });
  useAuthStore.setState({
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
  useNotificationStore.setState({
    hydrated: true,
    ownerKey: GUEST_DATA_OWNER,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS, promptDismissed: true },
    permission: 'unknown',
  });
  crashSpy = jest.spyOn(stabilitySlo, 'record').mockImplementation(() => {});
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  crashSpy.mockRestore();
  consoleError.mockRestore();
  for (const renderer of mounted.splice(0)) {
    act(() => renderer.unmount());
  }
});

describe('S7 — RootNavigator with a profile whose focusCheckpoint is undefined', () => {
  it('precondition: the legacy row hydrates (S2 path) into a Profile with focusCheckpoint === undefined — no shape validation adds a default', async () => {
    await hydrateGuestFromLegacyRow(legacyProfileWithoutFocus);
    const profile = useAppStore.getState().profile as Profile;
    expect(profile).toEqual(legacyProfileWithoutFocus);
    expect(profile.focusCheckpoint).toBeUndefined();
    expect(mockKv.get(`profile:${GUEST_DATA_OWNER}`)).toBe(
      JSON.stringify(legacyProfileWithoutFocus),
    );
    expect(mockKv.get('profile')).toBe('');
  });

  it('HELD: Home renders without the "Chosen focus" card, Settings shows "—", the Coach bar renders, and RootErrorBoundary never catches', async () => {
    await hydrateGuestFromLegacyRow(legacyProfileWithoutFocus);
    const renderer = await mountNavigator();
    const text = allText(renderer);

    expect(text).not.toContain('Something went wrong');
    expect(crashSpy).not.toHaveBeenCalled();

    // Home — real screen, loaded (not stuck on the loading affordance).
    expect(text).not.toContain('Loading your court');
    expect(text).not.toContain('Your court couldn’t load');
    expect(text).toContain('SELF · 3.0');
    expect(text).not.toContain('Chosen focus');
    expect(text).not.toContain('undefined');
    expect(
      renderer.root.findAll(
        n =>
          typeof n.props.accessibilityLabel === 'string' &&
          n.props.accessibilityLabel.startsWith('Self-selected focus'),
      ),
    ).toHaveLength(0);

    // Settings — real screen, explicit fallback for the missing focus.
    expect(text).toContain('Current focus');
    expect(text).toContain('—');
    expect(text).toContain('3.0');
    expect(text).toContain('left');

    // Coach — real PremiumTabBar center button present and pressable.
    expect(text).toContain('COACH');
    expect(pressables(renderer, 'Open coach actions')).toHaveLength(1);
  });

  it('HELD: opening the Coach action portal with the focus-less profile lists all three actions and closes cleanly', async () => {
    await hydrateGuestFromLegacyRow(legacyProfileWithoutFocus);
    const renderer = await mountNavigator();
    await act(async () => {
      pressables(renderer, 'Open coach actions')[0]!.props.onPress();
    });
    await settle();
    const text = allText(renderer);
    expect(text).toContain('Auto Analyze');
    expect(text).toContain('Import Video');
    expect(text).toContain('Drill Library');
    expect(text).not.toContain('Something went wrong');

    await act(async () => {
      pressables(renderer, 'Close coach actions')[0]!.props.onPress();
    });
    await settle();
    expect(pressables(renderer, 'Open coach actions')).toHaveLength(1);
    expect(crashSpy).not.toHaveBeenCalled();
  });

  it('HELD: focusCheckpoint === null (JSON null in the row) is also tolerated by Home and Settings', async () => {
    await hydrateGuestFromLegacyRow({
      ...legacyProfileWithoutFocus,
      focusCheckpoint: null,
    });
    const renderer = await mountNavigator();
    const text = allText(renderer);
    expect(text).not.toContain('Something went wrong');
    expect(text).not.toContain('Chosen focus');
    expect(text).toContain('Current focus');
    expect(crashSpy).not.toHaveBeenCalled();
  });

  it('HELD: an unknown-but-string focus ("legacy_focus") renders verbatim (humanised) rather than throwing', async () => {
    await hydrateGuestFromLegacyRow({
      ...legacyProfileWithoutFocus,
      focusCheckpoint: 'legacy_focus',
    });
    const renderer = await mountNavigator();
    const text = allText(renderer);
    expect(text).not.toContain('Something went wrong');
    expect(text).toContain('Chosen focus');
    expect(text).toContain('legacy focus');
    expect(crashSpy).not.toHaveBeenCalled();
  });
});

describe('S7 corrupt-type variant — focusCheckpoint present but not a string', () => {
  it.each([
    ['number', 42],
    ['object', { key: 'contact_position' }],
    ['array', ['contact_position']],
  ])(
    'FINDING: focusCheckpoint as %s passes hydrate un-validated and crashes Home/Settings (.replace) into RootErrorBoundary; "Try again" cannot recover because the store keeps the bad row',
    async (_label, badFocus) => {
      await hydrateGuestFromLegacyRow({
        ...legacyProfileWithoutFocus,
        focusCheckpoint: badFocus,
      });
      expect(useAppStore.getState().hydrateError).toBeNull();
      expect(useAppStore.getState().profile).toEqual({
        ...legacyProfileWithoutFocus,
        focusCheckpoint: badFocus,
      });

      const renderer = await mountNavigator();
      expect(allText(renderer)).toContain('Something went wrong');
      expect(crashSpy).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'crash', fatal: false }),
      );
      expect(consoleError.mock.calls.flat().join('\n')).toMatch(
        /replace is not a function/,
      );

      // Boundary retry → same row → same throw.
      const retry = renderer.root.findAll(
        n =>
          n.props.label === 'Try again' &&
          typeof n.props.onPress === 'function',
      );
      expect(retry.length).toBeGreaterThan(0);
      await act(async () => {
        retry[0]!.props.onPress();
      });
      await settle();
      expect(allText(renderer)).toContain('Something went wrong');
      expect(crashSpy).toHaveBeenCalledTimes(2);
    },
  );
});
