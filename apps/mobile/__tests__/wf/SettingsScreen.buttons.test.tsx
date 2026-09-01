import React from 'react';
import { Linking, Modal, Platform, StyleSheet, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * Button ledger for `src/screens/SettingsScreen.tsx`: every pressable the
 * screen can render is pressed here and its real observable effect asserted
 * (navigation target + params, store mutation, Linking / review call,
 * dialog open/close). Rows without a handler are asserted to be plain
 * (non-pressable) so no dead control ever ships (App Review 2.1).
 */

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
  };
});

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack }),
}));

const mockRateAppFromSettings = jest.fn<Promise<string>, unknown[]>();
jest.mock('../../src/review/appStoreReview', () => ({
  rateAppFromSettings: (...args: unknown[]) => mockRateAppFromSettings(...args),
}));

const PRIVACY_URL = 'https://api.example.test/privacy';
const TERMS_URL = 'https://api.example.test/terms';
let mockLegalPrivacyUrl: string | null = PRIVACY_URL;
let mockLegalTermsUrl: string | null = TERMS_URL;
jest.mock('../../src/config/runtimeConfig', () => {
  const actual = jest.requireActual<
    typeof import('../../src/config/runtimeConfig')
  >('../../src/config/runtimeConfig');
  return {
    getRuntimePublicConfig: () => ({
      ...actual.getRuntimePublicConfig(),
      appVersion: '9.9.9-test',
      legalPrivacyUrl: mockLegalPrivacyUrl,
      legalTermsUrl: mockLegalTermsUrl,
    }),
  };
});

import { SettingsScreen } from '../../src/screens/SettingsScreen';
import { Button, PressableScale } from '../../src/design/components';
import { useAppStore } from '../../src/state/appStore';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import { useConsentStore } from '../../src/state/consentStore';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { DEFAULT_NOTIFICATION_PREFS } from '../../src/notifications/types';
import { useConsistencyStore } from '../../src/consistency/store';
import { buildConsistencySnapshot } from '../../src/consistency/engine';
import { useAccessStore } from '../../src/state/accessStore';
import { useWalkthroughStore } from '../../src/walkthrough/walkthroughStore';

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

const snapshot = buildConsistencySnapshot(
  [
    {
      kind: 'stroke',
      atIso: '2026-03-09T10:00:00.000Z',
      shotType: 'dink',
      overallScore: 6.2,
      resultKind: 'scored',
    },
    {
      kind: 'stroke',
      atIso: '2026-03-10T09:00:00.000Z',
      shotType: 'serve',
      overallScore: 8.1,
      resultKind: 'scored',
    },
  ],
  { asOfIso: '2026-03-10T18:00:00.000Z', timeZone: 'UTC' },
);

let mockSignOut: jest.Mock<Promise<void>, []>;
let mockHydrateConsent: jest.Mock<Promise<void>, []>;

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

/** Composite nodes carrying a real onPress under the given a11y label. */
function pressables(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
}

function press(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = pressables(renderer, label);
  expect(matches.length).toBeGreaterThan(0);
  act(() => {
    matches[0]!.props.onPress();
  });
}

function sheetButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = renderer.root
    .findAllByType(Button)
    .filter(node => node.props.label === label);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

/** Row labels rendered by SettingRow are `${label}, ${value}`; find by label. */
function rowLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const prefix = `${label}, `;
  const matches = renderer.root.findAll(
    node =>
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith(prefix) &&
      typeof node.props.onPress === 'function',
  );
  return matches.length > 0
    ? String(matches[0]!.props.accessibilityLabel)
    : null;
}

function flushMicrotasks() {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('SettingsScreen button ledger', () => {
  let openUrlSpy: jest.SpyInstance;

  beforeEach(() => {
    mockNavigate.mockClear();
    mockGoBack.mockClear();
    mockRateAppFromSettings.mockReset();
    mockRateAppFromSettings.mockResolvedValue('native_prompt');
    mockLegalPrivacyUrl = PRIVACY_URL;
    mockLegalTermsUrl = TERMS_URL;
    openUrlSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);

    mockSignOut = jest.fn(() => Promise.resolve());
    mockHydrateConsent = jest.fn(() => Promise.resolve());

    useAuthStore.setState({
      hydrated: true,
      session: syncedSession,
      busy: false,
      error: null,
      signOut: mockSignOut,
    });
    useAppStore.setState({
      profile: {
        firstName: 'Alex',
        gender: 'nonbinary',
        skillLevel: 'intermediate',
        handedness: 'right',
        goal: 'dinks',
        biggestProblem: 'consistency',
        focusCheckpoint: 'contact_position',
      },
    });
    useConsentStore.setState({
      availability: 'ready',
      modelTrainingActive: false,
      lastActionAt: null,
      busy: false,
      error: null,
      hydrate: mockHydrateConsent,
    });
    useNotificationStore.setState({
      prefs: { ...DEFAULT_NOTIFICATION_PREFS, enabled: true },
      permission: 'granted',
    });
    useConsistencyStore.setState({ snapshot });
    useAccessStore.setState({
      canonicalAccess: {
        premium: false,
        entitlements: [],
        freeRatings: {
          limit: 2,
          used: 1,
          reserved: 0,
          remaining: 1,
          availableToReserve: 1,
        },
        canStartRating: true,
        paywallRequired: false,
      },
    });
    useWalkthroughStore.setState({ visible: false });
  });

  afterEach(() => {
    openUrlSpy.mockRestore();
  });

  it('re-hydrates consent from the server ledger on mount', () => {
    const renderer = renderScreen();
    expect(mockHydrateConsent).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  describe('Membership', () => {
    it('Pickle Sensei Pro (synced) -> Paywall with source=settings', () => {
      const renderer = renderScreen();
      expect(rowLabel(renderer, 'Pickle Sensei Pro')).toBe(
        'Pickle Sensei Pro, 1 free rating left',
      );
      press(renderer, 'Pickle Sensei Pro, 1 free rating left');
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('Paywall', {
        source: 'settings',
      });
      act(() => renderer.unmount());
    });

    it('Pickle Sensei Pro reflects Pro / exhausted / unverified access honestly', () => {
      useAccessStore.setState({
        canonicalAccess: {
          premium: true,
          entitlements: ['pickle_sensei_pro'],
          freeRatings: {
            limit: 2,
            used: 2,
            reserved: 0,
            remaining: 0,
            availableToReserve: 0,
          },
          canStartRating: true,
          paywallRequired: false,
        },
      });
      let renderer = renderScreen();
      expect(rowLabel(renderer, 'Pickle Sensei Pro')).toBe(
        'Pickle Sensei Pro, Pro active',
      );
      act(() => renderer.unmount());

      useAccessStore.setState({
        canonicalAccess: {
          premium: false,
          entitlements: [],
          freeRatings: {
            limit: 2,
            used: 2,
            reserved: 0,
            remaining: 0,
            availableToReserve: 0,
          },
          canStartRating: false,
          paywallRequired: true,
        },
      });
      renderer = renderScreen();
      expect(rowLabel(renderer, 'Pickle Sensei Pro')).toBe(
        'Pickle Sensei Pro, Upgrade required',
      );
      act(() => renderer.unmount());

      useAccessStore.setState({ canonicalAccess: null });
      renderer = renderScreen();
      expect(rowLabel(renderer, 'Pickle Sensei Pro')).toBe(
        'Pickle Sensei Pro, Verify access',
      );
      press(renderer, 'Pickle Sensei Pro, Verify access');
      expect(mockNavigate).toHaveBeenCalledWith('Paywall', {
        source: 'settings',
      });
      act(() => renderer.unmount());
    });

    it('Connect account row is absent for synced sessions', () => {
      const renderer = renderScreen();
      expect(rowLabel(renderer, 'Connect account')).toBeNull();
      act(() => renderer.unmount());
    });

    it('guest: Connect account -> ConnectAccount', () => {
      useAuthStore.setState({ session: guestSession });
      const renderer = renderScreen();
      press(renderer, 'Connect account, For ratings');
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('ConnectAccount');
      act(() => renderer.unmount());
    });

    it('guest: Pickle Sensei Pro says "Sign in first" and -> ConnectAccount (never Paywall)', () => {
      useAuthStore.setState({ session: guestSession });
      const renderer = renderScreen();
      press(renderer, 'Pickle Sensei Pro, Sign in first');
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('ConnectAccount');
      expect(mockNavigate).not.toHaveBeenCalledWith(
        'Paywall',
        expect.anything(),
      );
      act(() => renderer.unmount());
    });
  });

  describe('Player', () => {
    it('Consistency -> StreakCalendar', () => {
      const renderer = renderScreen();
      expect(rowLabel(renderer, 'Consistency')).toBe(
        'Consistency, 2 day streak · 1 badge',
      );
      press(renderer, 'Consistency, 2 day streak · 1 badge');
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('StreakCalendar');
      act(() => renderer.unmount());
    });

    it('Consistency stays tappable with an honest placeholder before the first snapshot', () => {
      useConsistencyStore.setState({ snapshot: null });
      const renderer = renderScreen();
      press(renderer, 'Consistency, —');
      expect(mockNavigate).toHaveBeenCalledWith('StreakCalendar');
      act(() => renderer.unmount());
    });

    it('profile rows are informational (no dead pressables) and survive a null profile', () => {
      useAppStore.setState({ profile: null });
      useAuthStore.setState({ session: guestSession });
      const renderer = renderScreen();
      for (const label of [
        'Name',
        'Gender',
        'Playing level',
        'Hitting hand',
        'Current focus',
        'App version',
        'Scoring model',
      ]) {
        expect(rowLabel(renderer, label)).toBeNull();
      }
      const copy = allText(renderer);
      expect(copy).toContain('Guest · this device');
      expect(copy).toContain(
        'Progress stays on this phone until you connect an account.',
      );
      expect(copy).toContain('9.9.9-test');
      act(() => renderer.unmount());
    });
  });

  describe('Reminders & Privacy', () => {
    it('Notifications -> NotificationSettings', () => {
      const renderer = renderScreen();
      expect(rowLabel(renderer, 'Notifications')).toBe(
        'Notifications, Daily · 5:30 PM',
      );
      press(renderer, 'Notifications, Daily · 5:30 PM');
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('NotificationSettings');
      act(() => renderer.unmount());
    });

    it('Notifications value names the OS block instead of pretending they are on', () => {
      useNotificationStore.setState({ permission: 'denied' });
      let renderer = renderScreen();
      press(renderer, 'Notifications, Allow in system settings');
      expect(mockNavigate).toHaveBeenCalledWith('NotificationSettings');
      act(() => renderer.unmount());

      useNotificationStore.setState({
        prefs: { ...DEFAULT_NOTIFICATION_PREFS, enabled: false },
      });
      renderer = renderScreen();
      press(renderer, 'Notifications, Off');
      expect(mockNavigate).toHaveBeenLastCalledWith('NotificationSettings');
      act(() => renderer.unmount());
    });

    it('Data & consent -> ConsentSettings (value from the server ledger)', () => {
      const renderer = renderScreen();
      press(renderer, 'Data & consent, Training: off');
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('ConsentSettings');
      act(() => renderer.unmount());
    });

    it('Data & consent stays reachable while the ledger is loading / unavailable', () => {
      useConsentStore.setState({ availability: 'unavailable' });
      const renderer = renderScreen();
      press(renderer, 'Data & consent, Manage');
      expect(mockNavigate).toHaveBeenCalledWith('ConsentSettings');
      act(() => renderer.unmount());
    });
  });

  describe('About', () => {
    it('Rate Pickle Sensei -> rateAppFromSettings (iOS only)', async () => {
      const renderer = renderScreen();
      press(renderer, 'Rate Pickle Sensei, App Store');
      await flushMicrotasks();
      expect(mockRateAppFromSettings).toHaveBeenCalledTimes(1);
      expect(mockNavigate).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });

    it('Rate Pickle Sensei: an "unavailable" outcome leaves the row untouched', async () => {
      mockRateAppFromSettings.mockResolvedValue('unavailable');
      const renderer = renderScreen();
      const before = allText(renderer);
      press(renderer, 'Rate Pickle Sensei, App Store');
      await flushMicrotasks();
      expect(mockRateAppFromSettings).toHaveBeenCalledTimes(1);
      // The outcome is discarded by the screen, so nothing can change.
      expect(allText(renderer)).toBe(before);
      // WF-ISSUE: "Rate Pickle Sensei" gives no feedback when StoreKit
      // declines / the app id is unset — the correct behavior would be
      // user-visible copy here (e.g. a "Not available yet" value).
      act(() => renderer.unmount());
    });

    it('Rate Pickle Sensei row is hidden off iOS', () => {
      const original = Platform.OS;
      Object.defineProperty(Platform, 'OS', {
        value: 'android',
        configurable: true,
      });
      try {
        const renderer = renderScreen();
        expect(rowLabel(renderer, 'Rate Pickle Sensei')).toBeNull();
        act(() => renderer.unmount());
      } finally {
        Object.defineProperty(Platform, 'OS', {
          value: original,
          configurable: true,
        });
      }
    });

    it('App walkthrough -> lands on Tabs/Home and raises the tour overlay', () => {
      const renderer = renderScreen();
      expect(useWalkthroughStore.getState().visible).toBe(false);
      press(renderer, 'App walkthrough, Replay');
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('Tabs', { screen: 'Home' });
      expect(useWalkthroughStore.getState().visible).toBe(true);
      act(() => renderer.unmount());
    });

    it('Privacy policy -> Linking.openURL(legalPrivacyUrl)', () => {
      const renderer = renderScreen();
      press(renderer, 'Privacy policy, View');
      expect(openUrlSpy).toHaveBeenCalledTimes(1);
      expect(openUrlSpy).toHaveBeenCalledWith(PRIVACY_URL);
      act(() => renderer.unmount());
    });

    it('Terms of use -> Linking.openURL(legalTermsUrl)', () => {
      const renderer = renderScreen();
      press(renderer, 'Terms of use, View');
      expect(openUrlSpy).toHaveBeenCalledTimes(1);
      expect(openUrlSpy).toHaveBeenCalledWith(TERMS_URL);
      act(() => renderer.unmount());
    });

    it('legal rows never render without a URL (no dead links)', () => {
      mockLegalPrivacyUrl = null;
      mockLegalTermsUrl = null;
      const renderer = renderScreen();
      expect(rowLabel(renderer, 'Privacy policy')).toBeNull();
      expect(rowLabel(renderer, 'Terms of use')).toBeNull();
      act(() => renderer.unmount());
    });
  });

  describe('Account', () => {
    it('Manage account -> ManageAccount for synced sessions', () => {
      const renderer = renderScreen();
      press(renderer, 'Manage account, Details');
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('ManageAccount');
      act(() => renderer.unmount());
    });

    it('Manage account is absent for guests (no server account to manage)', () => {
      useAuthStore.setState({ session: guestSession });
      const renderer = renderScreen();
      expect(rowLabel(renderer, 'Manage account')).toBeNull();
      act(() => renderer.unmount());
    });
  });

  describe('Sign out', () => {
    it('Sign out row opens the confirmation sheet without signing out', () => {
      const renderer = renderScreen();
      expect(renderer.root.findByType(Modal).props.visible).toBe(false);
      expect(allText(renderer)).not.toContain('Sign out of Pickle Sensei?');
      press(renderer, 'Sign out');
      expect(renderer.root.findByType(Modal).props.visible).toBe(true);
      expect(allText(renderer)).toContain('Sign out of Pickle Sensei?');
      expect(mockSignOut).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });

    it('confirm "Sign out" calls authStore.signOut once and closes the sheet', async () => {
      const renderer = renderScreen();
      press(renderer, 'Sign out');
      const confirm = sheetButton(renderer, 'Sign out');
      act(() => {
        confirm.props.onPress();
      });
      await flushMicrotasks();
      expect(mockSignOut).toHaveBeenCalledTimes(1);
      expect(renderer.root.findByType(Modal).props.visible).toBe(false);
      // Sheet is gone, so a second tap on the confirm button is impossible.
      expect(
        renderer.root
          .findAllByType(Button)
          .filter(node => node.props.label === 'Sign out'),
      ).toHaveLength(0);
      act(() => renderer.unmount());
    });

    it('"Keep me signed in" cancels', () => {
      const renderer = renderScreen();
      press(renderer, 'Sign out');
      act(() => {
        sheetButton(renderer, 'Keep me signed in').props.onPress();
      });
      expect(renderer.root.findByType(Modal).props.visible).toBe(false);
      expect(mockSignOut).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });

    it('close (X) button cancels', () => {
      const renderer = renderScreen();
      press(renderer, 'Sign out');
      press(renderer, 'Close sign out confirmation');
      expect(renderer.root.findByType(Modal).props.visible).toBe(false);
      expect(mockSignOut).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });

    it('backdrop tap cancels', () => {
      const renderer = renderScreen();
      press(renderer, 'Sign out');
      press(renderer, 'Cancel sign out');
      expect(renderer.root.findByType(Modal).props.visible).toBe(false);
      expect(mockSignOut).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });

    it('hardware back (Modal onRequestClose) cancels', () => {
      const renderer = renderScreen();
      press(renderer, 'Sign out');
      act(() => {
        renderer.root.findByType(Modal).props.onRequestClose();
      });
      expect(renderer.root.findByType(Modal).props.visible).toBe(false);
      expect(mockSignOut).not.toHaveBeenCalled();
      act(() => renderer.unmount());
    });
  });

  describe('accessibility and hit targets', () => {
    it('every PressableScale on the screen (sheet open) is a labelled button with a >=44pt target', () => {
      useAuthStore.setState({ session: guestSession });
      const renderer = renderScreen();
      press(renderer, 'Sign out');
      const nodes = renderer.root.findAllByType(PressableScale);
      // Guest layout: Connect account, Pro, Consistency, Notifications,
      // Data & consent, Rate, Walkthrough, Privacy, Terms, Sign out row,
      // dialog X, Keep me signed in, Sign out (confirm).
      expect(nodes).toHaveLength(13);
      for (const node of nodes) {
        expect(typeof node.props.onPress).toBe('function');
        expect(typeof node.props.accessibilityLabel).toBe('string');
        expect(node.props.accessibilityLabel.length).toBeGreaterThan(0);
        expect(node.props.disabled).toBeFalsy();
        const flat = StyleSheet.flatten(node.props.style) ?? {};
        const height = Number(flat.minHeight ?? flat.height ?? 0);
        expect(height).toBeGreaterThanOrEqual(44);
      }
      act(() => renderer.unmount());
    });

    it('synced layout swaps Connect account for Manage account (13 pressables)', () => {
      const renderer = renderScreen();
      press(renderer, 'Sign out');
      const labels = renderer.root
        .findAllByType(PressableScale)
        .map(node => String(node.props.accessibilityLabel));
      expect(labels).toEqual([
        'Pickle Sensei Pro, 1 free rating left',
        'Consistency, 2 day streak · 1 badge',
        'Notifications, Daily · 5:30 PM',
        'Data & consent, Training: off',
        'Rate Pickle Sensei, App Store',
        'App walkthrough, Replay',
        'Privacy policy, View',
        'Terms of use, View',
        'Manage account, Details',
        'Sign out',
        'Close sign out confirmation',
        'Keep me signed in',
        'Sign out',
      ]);
      act(() => renderer.unmount());
    });
  });
});
