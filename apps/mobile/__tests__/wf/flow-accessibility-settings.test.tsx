import React from 'react';
import { Linking, Modal, StyleSheet, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * Accessibility workflow audit — Settings root.
 *
 * Drives every pressable on the Settings screen as VoiceOver would reach
 * it: each row must expose a button role + a self-describing label, sit on a
 * ≥44pt target, navigate to the documented route with the documented params,
 * and the destructive sign-out path must be a two-step (sheet) flow whose
 * cancel branch never signs the user out.
 */

jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack }),
  useFocusEffect: () => undefined,
}));

const mockRateAppFromSettings = jest.fn(() => Promise.resolve());
jest.mock('../../src/review/appStoreReview', () => ({
  rateAppFromSettings: () => mockRateAppFromSettings(),
}));

const mockReplay = jest.fn();
jest.mock('../../src/walkthrough/walkthroughStore', () => ({
  useWalkthroughStore: { getState: () => ({ replay: mockReplay }) },
}));

jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: null,
    googleWebClientId: null,
    appVersion: '1.0.0 (1)',
    legalPrivacyUrl: 'https://api.example.test/privacy',
    legalTermsUrl: 'https://api.example.test/terms',
  }),
}));

import { SettingsScreen } from '../../src/screens/SettingsScreen';
import { Button } from '../../src/design/components';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import { useAppStore } from '../../src/state/appStore';
import { useConsentStore } from '../../src/state/consentStore';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { DEFAULT_NOTIFICATION_PREFS } from '../../src/notifications/types';
import { useConsistencyStore } from '../../src/consistency/store';
import { useAccessStore } from '../../src/state/accessStore';

const MIN_TARGET_PT = 44;

const syncedSession: AuthSession = {
  provider: 'google',
  subject: '11111111-1111-4111-8111-111111111111',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
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

function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<SettingsScreen />);
  });
  return renderer;
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

/**
 * Host-level pressables: the native View each RN <Pressable> renders. Its
 * `onClick` is the accessibility-activate path (what VoiceOver double-tap
 * dispatches) and honours `disabled`, so tests press through it.
 */
function hostPressables(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' && typeof node.props.onClick === 'function',
  );
}

function press(node: TestRenderer.ReactTestInstance) {
  node.props.onClick();
}

function pressableByLabelPrefix(
  renderer: TestRenderer.ReactTestRenderer,
  prefix: string,
) {
  const matches = hostPressables(renderer).filter(node =>
    String(node.props.accessibilityLabel ?? '').startsWith(prefix),
  );
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

function minHeightOf(node: TestRenderer.ReactTestInstance): number {
  const flat = StyleSheet.flatten(node.props.style) ?? {};
  return Number(flat.minHeight ?? flat.height ?? 0);
}

describe('Settings root — accessibility workflow', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockGoBack.mockClear();
    mockRateAppFromSettings.mockClear();
    mockReplay.mockClear();
    act(() => {
      seedStores();
    });
  });

  function seedStores() {
    useAuthStore.setState({
      hydrated: true,
      session: syncedSession,
      busy: false,
      error: null,
      signOut: jest.fn(() => Promise.resolve()),
    });
    useAppStore.setState({
      hydrated: true,
      profile: {
        firstName: 'Alex',
        gender: 'female',
        skillLevel: 'intermediate',
        handedness: 'right',
        focusCheckpoint: 'contact_point',
      } as never,
    });
    useConsentStore.setState({
      availability: 'ready',
      modelTrainingActive: false,
      busy: false,
      error: null,
      hydrate: jest.fn(() => Promise.resolve()),
    });
    useNotificationStore.setState({
      prefs: { ...DEFAULT_NOTIFICATION_PREFS, enabled: true },
      permission: 'granted',
    });
    useConsistencyStore.setState({ snapshot: null });
    useAccessStore.setState({ canonicalAccess: null });
  }

  it('every pressable exposes a button role, a label and a ≥44pt target', () => {
    const renderer = renderScreen();
    const pressables = hostPressables(renderer);
    expect(pressables.length).toBeGreaterThanOrEqual(8);
    for (const node of pressables) {
      expect(node.props.accessibilityRole).toBe('button');
      expect(
        String(node.props.accessibilityLabel ?? '').length,
      ).toBeGreaterThan(0);
      expect(node.props.accessibilityState?.disabled).not.toBe(true);
      expect(minHeightOf(node)).toBeGreaterThanOrEqual(MIN_TARGET_PT);
    }
    act(() => renderer.unmount());
  });

  it('labels each row as "<label>, <value>" so the value is read by VoiceOver', () => {
    const renderer = renderScreen();
    const labels = hostPressables(renderer).map(
      n => n.props.accessibilityLabel as string,
    );
    expect(labels).toEqual(
      expect.arrayContaining([
        'Pickle Sensei Pro, Verify access',
        'Consistency, —',
        'Notifications, Daily · 5:30 PM',
        'Data & consent, Training: off',
        'App walkthrough, Replay',
        'Privacy policy, View',
        'Terms of use, View',
        'Manage account, Details',
        'Sign out',
      ]),
    );
    act(() => renderer.unmount());
  });

  it('read-only profile rows are static (not announced as buttons)', () => {
    const renderer = renderScreen();
    const labels = hostPressables(renderer).map(
      n => n.props.accessibilityLabel as string,
    );
    for (const staticRow of [
      'Name,',
      'Gender,',
      'Playing level,',
      'Hitting hand,',
      'Current focus,',
      'App version,',
      'Scoring model,',
    ]) {
      expect(labels.some(l => l.startsWith(staticRow))).toBe(false);
    }
    expect(allText(renderer)).toContain('Playing level');
    act(() => renderer.unmount());
  });

  it('navigates each row to its documented route with its params', () => {
    const renderer = renderScreen();
    const routes: Array<[string, unknown[]]> = [
      ['Pickle Sensei Pro', ['Paywall', { source: 'settings' }]],
      ['Consistency', ['StreakCalendar']],
      ['Notifications', ['NotificationSettings']],
      ['Data & consent', ['ConsentSettings']],
      ['Manage account', ['ManageAccount']],
    ];
    for (const [label, expected] of routes) {
      mockNavigate.mockClear();
      act(() => {
        press(pressableByLabelPrefix(renderer, label));
      });
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith(...expected);
    }
    act(() => renderer.unmount());
  });

  it('walkthrough replay lands on Home first, then re-arms the tour', () => {
    const renderer = renderScreen();
    act(() => {
      press(pressableByLabelPrefix(renderer, 'App walkthrough'));
    });
    expect(mockNavigate).toHaveBeenCalledWith('Tabs', { screen: 'Home' });
    expect(mockReplay).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('legal rows open the configured URLs (no dead end)', () => {
    const openURL = jest
      .spyOn(Linking, 'openURL')
      .mockImplementation(() => Promise.resolve());
    const renderer = renderScreen();
    act(() => {
      press(pressableByLabelPrefix(renderer, 'Privacy policy'));
      press(pressableByLabelPrefix(renderer, 'Terms of use'));
    });
    expect(openURL).toHaveBeenCalledWith('https://api.example.test/privacy');
    expect(openURL).toHaveBeenCalledWith('https://api.example.test/terms');
    openURL.mockRestore();
    act(() => renderer.unmount());
  });

  it('Rate Pickle Sensei hands off to StoreKit (no custom rating nag)', () => {
    const renderer = renderScreen();
    act(() => {
      press(pressableByLabelPrefix(renderer, 'Rate Pickle Sensei'));
    });
    expect(mockRateAppFromSettings).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).not.toMatch(/rate us 5 stars/i);
    act(() => renderer.unmount());
  });

  it('local-only sessions get Connect account and are steered there from Pro', () => {
    act(() => {
      useAuthStore.setState({ session: guestSession });
    });
    const renderer = renderScreen();
    act(() => {
      press(pressableByLabelPrefix(renderer, 'Connect account'));
    });
    expect(mockNavigate).toHaveBeenLastCalledWith('ConnectAccount');
    act(() => {
      press(
        pressableByLabelPrefix(renderer, 'Pickle Sensei Pro, Sign in first'),
      );
    });
    expect(mockNavigate).toHaveBeenLastCalledWith('ConnectAccount');
    // Server-account management is only offered to synced sessions.
    expect(
      hostPressables(renderer).some(n =>
        String(n.props.accessibilityLabel).startsWith('Manage account'),
      ),
    ).toBe(false);
    act(() => renderer.unmount());
  });

  it('sign out is two-step: the sheet cancels without signing out, confirms once', () => {
    const renderer = renderScreen();
    const signOut = useAuthStore.getState().signOut as jest.Mock;
    const modal = () => renderer.root.findByType(Modal);
    expect(modal().props.visible).toBe(false);

    act(() => {
      press(pressableByLabelPrefix(renderer, 'Sign out'));
    });
    expect(modal().props.visible).toBe(true);
    expect(allText(renderer)).toContain('Sign out of Pickle Sensei?');
    // The dialog traps VoiceOver focus and offers a labelled close control.
    expect(
      renderer.root.findAll(
        n =>
          typeof n.type === 'string' &&
          n.props.accessibilityViewIsModal === true,
      ),
    ).toHaveLength(1);
    const close = pressableByLabelPrefix(
      renderer,
      'Close sign out confirmation',
    );
    expect(close.props.accessibilityRole).toBe('button');
    const closeStyle = StyleSheet.flatten(close.props.style) ?? {};
    expect(Number(closeStyle.width)).toBeGreaterThanOrEqual(MIN_TARGET_PT);
    expect(Number(closeStyle.height)).toBeGreaterThanOrEqual(MIN_TARGET_PT);

    // Cancel branch: nothing signs out.
    const buttons = () => renderer.root.findAllByType(Button);
    act(() => {
      buttons()
        .find(b => b.props.label === 'Keep me signed in')!
        .props.onPress();
    });
    expect(modal().props.visible).toBe(false);
    expect(signOut).not.toHaveBeenCalled();

    // Backdrop cancel branch.
    act(() => {
      press(pressableByLabelPrefix(renderer, 'Sign out'));
    });
    act(() => {
      press(pressableByLabelPrefix(renderer, 'Cancel sign out'));
    });
    expect(modal().props.visible).toBe(false);
    expect(signOut).not.toHaveBeenCalled();

    // Hardware back cancels too (Android onRequestClose).
    act(() => {
      press(pressableByLabelPrefix(renderer, 'Sign out'));
    });
    act(() => {
      modal().props.onRequestClose();
    });
    expect(modal().props.visible).toBe(false);

    // Confirm branch: sheet closes first, signOut runs exactly once.
    act(() => {
      press(pressableByLabelPrefix(renderer, 'Sign out'));
    });
    act(() => {
      buttons()
        .find(b => b.props.label === 'Sign out')!
        .props.onPress();
    });
    expect(modal().props.visible).toBe(false);
    expect(signOut).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });
});
