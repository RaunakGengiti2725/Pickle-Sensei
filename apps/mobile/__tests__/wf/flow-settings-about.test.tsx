import React from 'react';
import { Linking, Modal, NativeModules, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * Settings → About flow, driven the way a user would tap through it. Every
 * row on the Settings root is exercised: wired handler, navigation target and
 * params, the Rate row with and without APP_STORE_ID (deep link, sheet
 * fallback, store-page failure, missing StoreKit), legal links (valid URLs,
 * rejected openURL never throws into React), the sign-out sheet (cancel via
 * every affordance, confirm exactly once), and the AGENTS.md invariants for
 * this area (Manage account only for synced sessions, no Live Court rows,
 * legal URLs come from runtimeConfig).
 */

const mockKvTable = new Map<string, string>();
jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        const value = mockKvTable.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKvTable.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack }),
}));

// runtimeConfig is a module of constants; a mutable mirror lets the flow be
// driven both before and after APP_STORE_ID exists.
const LIVE_API_BASE_URL =
  'https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api';
interface MockRuntime {
  appStoreId: string | null;
  apiBaseUrl: string | null;
}
jest.mock('../../src/config/runtimeConfig', () => {
  const runtime: MockRuntime = {
    appStoreId: null,
    apiBaseUrl: 'https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api',
  };
  return {
    __mockRuntime: runtime,
    getRuntimePublicConfig: () => ({
      apiBaseUrl: runtime.apiBaseUrl,
      revenueCatPublicSdkKey: null,
      googleIosClientId: null,
      googleWebClientId: null,
      appVersion: '1.0',
      legalPrivacyUrl: runtime.apiBaseUrl
        ? `${runtime.apiBaseUrl}/privacy`
        : null,
      legalTermsUrl: runtime.apiBaseUrl ? `${runtime.apiBaseUrl}/terms` : null,
      appStoreId: runtime.appStoreId,
      appStoreWriteReviewUrl: runtime.appStoreId
        ? `https://apps.apple.com/app/id${runtime.appStoreId}?action=write-review`
        : null,
    }),
  };
});
const mockRuntime = (
  require('../../src/config/runtimeConfig') as { __mockRuntime: MockRuntime }
).__mockRuntime;

import { SettingsScreen } from '../../src/screens/SettingsScreen';
import { Button } from '../../src/design/components';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import { useAppStore } from '../../src/state/appStore';
import { useAccessStore } from '../../src/state/accessStore';
import { useConsentStore } from '../../src/state/consentStore';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { useConsistencyStore } from '../../src/consistency/store';
import { useWalkthroughStore } from '../../src/walkthrough/walkthroughStore';
import {
  REVIEW_PROMPT_KV_KEY,
  parseReviewPromptState,
} from '../../src/review/appStoreReview';

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

const mockRequestReview = jest.fn(() => Promise.resolve(true));
let openUrlSpy: jest.SpyInstance;

const mounted: TestRenderer.ReactTestRenderer[] = [];

function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<SettingsScreen />);
  });
  mounted.push(renderer);
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

/** RN's Pressable is where a11y props and onPress are resolved. */
function isPressable(node: TestRenderer.ReactTestInstance): boolean {
  if (typeof node.type === 'string') return false;
  const component = node.type as { displayName?: string; name?: string };
  return (component.displayName ?? component.name) === 'Pressable';
}

/** Pressable Settings rows carry `${label}, ${value}` as their a11y label. */
function rowsStartingWith(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  // The Pressable under PressableScale carries the resolved a11y props and
  // the press handler (the host View below it only has responder handlers).
  return renderer.root.findAll(
    node =>
      isPressable(node) &&
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith(`${label},`) &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole === 'button',
  );
}

function row(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = rowsStartingWith(renderer, label);
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

function pressable(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = renderer.root.findAll(
    node =>
      isPressable(node) &&
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

function sheetButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = renderer.root
    .findAllByType(Button)
    .filter(node => node.props.label === label);
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

function signOutSheet(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findByType(Modal);
}

function storedReviewState() {
  return parseReviewPromptState(mockKvTable.get(REVIEW_PROMPT_KV_KEY) ?? null);
}

beforeEach(() => {
  mockKvTable.clear();
  mockNavigate.mockClear();
  mockGoBack.mockClear();
  mockRuntime.appStoreId = null;
  mockRuntime.apiBaseUrl = LIVE_API_BASE_URL;
  mockRequestReview.mockClear();
  mockRequestReview.mockResolvedValue(true);
  (NativeModules as { PickleStoreReview?: unknown }).PickleStoreReview = {
    requestReview: mockRequestReview,
  };
  openUrlSpy = jest
    .spyOn(Linking, 'openURL')
    .mockImplementation(() => Promise.resolve());

  useAuthStore.setState({
    hydrated: true,
    session: syncedSession,
    busy: false,
    error: null,
    signOut: jest.fn(() => Promise.resolve()),
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
  useConsentStore.setState({
    availability: 'ready',
    modelTrainingActive: false,
    busy: false,
    error: null,
    hydrate: jest.fn(() => Promise.resolve()),
  });
  useNotificationStore.setState({ permission: 'unknown' });
  useConsistencyStore.setState({ snapshot: null });
  useWalkthroughStore.setState({ visible: false });
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    if (renderer.toJSON() !== null) act(() => renderer.unmount());
  }
  openUrlSpy.mockRestore();
});

afterAll(() => {
  delete (NativeModules as { PickleStoreReview?: unknown }).PickleStoreReview;
});

describe('Settings root — rows, handlers and navigation targets', () => {
  it('renders the synced account, every section, and the version row', () => {
    const renderer = renderScreen();
    const copy = allText(renderer);
    expect(copy).toContain('Settings');
    expect(copy).toContain('Alex Chen');
    expect(copy).toContain('google account');
    for (const section of [
      'Membership',
      'Player',
      'Reminders',
      'Privacy',
      'About',
      'Account',
    ]) {
      expect(copy).toContain(section);
    }
    expect(copy).toContain('App version');
    expect(copy).toContain('1.0');
    expect(copy).toContain('Scoring model');
    expect(copy).toContain('1 free rating left');
    // Consent hydrates on mount so the row never shows a hard-coded claim.
    expect(useConsentStore.getState().hydrate).toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('every pressable row is a button with a "label, value" a11y label; info rows are not buttons', () => {
    const renderer = renderScreen();
    for (const label of [
      'Pickle Sensei Pro',
      'Consistency',
      'Notifications',
      'Data & consent',
      'Rate Pickle Sensei',
      'App walkthrough',
      'Privacy policy',
      'Terms of use',
      'Manage account',
    ]) {
      expect(rowsStartingWith(renderer, label)).toHaveLength(1);
    }
    // Read-only player facts and the version row are plain rows — nothing
    // that looks tappable but does nothing (App Review 2.1 / 4.2).
    for (const label of [
      'Name',
      'Gender',
      'Playing level',
      'Hitting hand',
      'Current focus',
      'App version',
      'Scoring model',
    ]) {
      expect(rowsStartingWith(renderer, label)).toHaveLength(0);
    }
    act(() => renderer.unmount());
  });

  it('navigates each row to its declared root-stack route with the right params', () => {
    const renderer = renderScreen();
    act(() => row(renderer, 'Pickle Sensei Pro').props.onPress());
    expect(mockNavigate).toHaveBeenLastCalledWith('Paywall', {
      source: 'settings',
    });
    act(() => row(renderer, 'Consistency').props.onPress());
    expect(mockNavigate).toHaveBeenLastCalledWith('StreakCalendar');
    act(() => row(renderer, 'Notifications').props.onPress());
    expect(mockNavigate).toHaveBeenLastCalledWith('NotificationSettings');
    act(() => row(renderer, 'Data & consent').props.onPress());
    expect(mockNavigate).toHaveBeenLastCalledWith('ConsentSettings');
    act(() => row(renderer, 'Manage account').props.onPress());
    expect(mockNavigate).toHaveBeenLastCalledWith('ManageAccount');
    act(() => renderer.unmount());
  });

  it('App walkthrough lands on Home and raises the tour without touching the seen record', () => {
    const renderer = renderScreen();
    act(() => row(renderer, 'App walkthrough').props.onPress());
    expect(mockNavigate).toHaveBeenLastCalledWith('Tabs', { screen: 'Home' });
    expect(useWalkthroughStore.getState().visible).toBe(true);
    expect(mockKvTable.has('walkthrough.device-complete')).toBe(false);
    act(() => renderer.unmount());
  });

  it('shows the membership state honestly for premium, exhausted and unverified access', () => {
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
    expect(allText(renderer)).toContain('Pro active');
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
    expect(allText(renderer)).toContain('Upgrade required');
    act(() => renderer.unmount());

    useAccessStore.setState({ canonicalAccess: null });
    renderer = renderScreen();
    expect(allText(renderer)).toContain('Verify access');
    act(() => renderer.unmount());
  });

  it('reflects reminder state: off, denied permission, daily time', () => {
    useNotificationStore.setState({
      prefs: {
        ...useNotificationStore.getState().prefs,
        enabled: false,
      },
    });
    let renderer = renderScreen();
    expect(row(renderer, 'Notifications').props.accessibilityLabel).toBe(
      'Notifications, Off',
    );
    act(() => renderer.unmount());

    useNotificationStore.setState({
      permission: 'denied',
      prefs: { ...useNotificationStore.getState().prefs, enabled: true },
    });
    renderer = renderScreen();
    expect(row(renderer, 'Notifications').props.accessibilityLabel).toBe(
      'Notifications, Allow in system settings',
    );
    act(() => renderer.unmount());

    useNotificationStore.setState({
      permission: 'granted',
      prefs: {
        ...useNotificationStore.getState().prefs,
        enabled: true,
        practiceReminder: true,
        practiceReminderMinutes: 18 * 60 + 30,
      },
    });
    renderer = renderScreen();
    expect(row(renderer, 'Notifications').props.accessibilityLabel).toMatch(
      /^Notifications, Daily · /,
    );
    act(() => renderer.unmount());
  });
});

describe('Settings root — guest (local-only) sessions', () => {
  beforeEach(() => {
    useAuthStore.setState({ session: guestSession });
  });

  it('greets the guest by first name and offers Connect account instead of Manage account', () => {
    const renderer = renderScreen();
    const copy = allText(renderer);
    expect(copy).toContain('Alex');
    expect(copy).toContain('Guest · this device');
    expect(copy).toContain('LOCAL');
    expect(rowsStartingWith(renderer, 'Manage account')).toHaveLength(0);
    expect(copy).not.toContain('Account details');
    act(() => row(renderer, 'Connect account').props.onPress());
    expect(mockNavigate).toHaveBeenLastCalledWith('ConnectAccount');
    act(() => renderer.unmount());
  });

  it('routes the Pro row to ConnectAccount (never the paywall) while local-only', () => {
    const renderer = renderScreen();
    const pro = row(renderer, 'Pickle Sensei Pro');
    expect(pro.props.accessibilityLabel).toBe(
      'Pickle Sensei Pro, Sign in first',
    );
    act(() => pro.props.onPress());
    expect(mockNavigate).toHaveBeenLastCalledWith('ConnectAccount');
    expect(mockNavigate).not.toHaveBeenCalledWith('Paywall', expect.anything());
    act(() => renderer.unmount());
  });

  it('a guest without an onboarding name sees the honest local-storage caption', () => {
    useAppStore.setState({ profile: null });
    const renderer = renderScreen();
    const copy = allText(renderer);
    expect(copy).toContain(
      'Progress stays on this phone until you connect an account.',
    );
    expect(copy).toContain('—');
    act(() => renderer.unmount());
  });
});

describe('About — legal links', () => {
  it('Privacy policy and Terms open the runtimeConfig URLs, which are well-formed https URLs on the API origin', () => {
    const renderer = renderScreen();
    act(() => row(renderer, 'Privacy policy').props.onPress());
    act(() => row(renderer, 'Terms of use').props.onPress());
    expect(openUrlSpy).toHaveBeenCalledTimes(2);
    const [privacyUrl] = openUrlSpy.mock.calls[0] as [string];
    const [termsUrl] = openUrlSpy.mock.calls[1] as [string];
    for (const target of [privacyUrl, termsUrl]) {
      const parsed = new URL(target);
      expect(parsed.protocol).toBe('https:');
      expect(target.startsWith(LIVE_API_BASE_URL)).toBe(true);
    }
    expect(privacyUrl.endsWith('/privacy')).toBe(true);
    expect(termsUrl.endsWith('/terms')).toBe(true);
    act(() => renderer.unmount());
  });

  it('a rejected openURL never throws into the press handler or unmounts the screen', async () => {
    // The rejection is pre-observed here because SettingsScreen fires
    // `void Linking.openURL(url)` without attaching its own handler; Jest
    // would otherwise fail the test on the unhandled rejection. On iOS an
    // https URL cannot be refused, so the visible behaviour is: no crash.
    const rejectedOpens: Promise<void>[] = [];
    openUrlSpy.mockImplementation(() => {
      const rejected = Promise.reject<void>(new Error('No handler for URL'));
      rejected.catch(() => undefined);
      rejectedOpens.push(rejected);
      return rejected;
    });
    const renderer = renderScreen();
    expect(() => row(renderer, 'Privacy policy').props.onPress()).not.toThrow();
    expect(() => row(renderer, 'Terms of use').props.onPress()).not.toThrow();
    await act(async () => {
      await Promise.resolve();
    });
    expect(rejectedOpens).toHaveLength(2);
    // Screen is intact and still interactive after the failure.
    expect(rowsStartingWith(renderer, 'Privacy policy')).toHaveLength(1);
    expect(rowsStartingWith(renderer, 'Terms of use')).toHaveLength(1);
    expect(allText(renderer)).toContain('About');
    act(() => renderer.unmount());
  });
});

describe('About — Rate Pickle Sensei', () => {
  it('is an iOS-only row on the About card', () => {
    const renderer = renderScreen();
    const rate = row(renderer, 'Rate Pickle Sensei');
    expect(rate.props.accessibilityLabel).toBe('Rate Pickle Sensei, App Store');
    act(() => renderer.unmount());
  });

  it('without APP_STORE_ID: asks StoreKit for the in-app sheet, never opens a URL, never marks reviewed', async () => {
    mockRuntime.appStoreId = null;
    const renderer = renderScreen();
    await act(async () => {
      row(renderer, 'Rate Pickle Sensei').props.onPress();
    });
    expect(mockRequestReview).toHaveBeenCalledTimes(1);
    expect(openUrlSpy).not.toHaveBeenCalled();
    expect(storedReviewState().reviewedAtIso).toBeNull();
    act(() => renderer.unmount());
  });

  it('with APP_STORE_ID: deep-links to the write-review page and durably ends the per-analysis asks', async () => {
    mockRuntime.appStoreId = '6743210987';
    const renderer = renderScreen();
    await act(async () => {
      row(renderer, 'Rate Pickle Sensei').props.onPress();
    });
    expect(openUrlSpy).toHaveBeenCalledTimes(1);
    const [target] = openUrlSpy.mock.calls[0] as [string];
    expect(target).toBe(
      'https://apps.apple.com/app/id6743210987?action=write-review',
    );
    const parsed = new URL(target);
    expect(parsed.protocol).toBe('https:');
    expect(parsed.host).toBe('apps.apple.com');
    expect(parsed.searchParams.get('action')).toBe('write-review');
    expect(mockRequestReview).not.toHaveBeenCalled();
    expect(storedReviewState().reviewedAtIso).not.toBeNull();
    act(() => renderer.unmount());
  });

  it('with APP_STORE_ID but the store page unreachable: falls back to the sheet and does not mark reviewed', async () => {
    mockRuntime.appStoreId = '6743210987';
    openUrlSpy.mockImplementation(() =>
      Promise.reject(new Error('store unavailable')),
    );
    const renderer = renderScreen();
    await act(async () => {
      row(renderer, 'Rate Pickle Sensei').props.onPress();
    });
    expect(openUrlSpy).toHaveBeenCalledTimes(1);
    expect(mockRequestReview).toHaveBeenCalledTimes(1);
    expect(storedReviewState().reviewedAtIso).toBeNull();
    act(() => renderer.unmount());
  });

  it('with StoreKit missing and no APP_STORE_ID the tap resolves without crashing (silent no-op today)', async () => {
    delete (NativeModules as { PickleStoreReview?: unknown }).PickleStoreReview;
    const renderer = renderScreen();
    await act(async () => {
      row(renderer, 'Rate Pickle Sensei').props.onPress();
    });
    expect(openUrlSpy).not.toHaveBeenCalled();
    expect(mockRequestReview).not.toHaveBeenCalled();
    // The row is still there; nothing changed for the user.
    expect(rowsStartingWith(renderer, 'Rate Pickle Sensei')).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('a refused StoreKit request is swallowed, not surfaced as a crash', async () => {
    mockRequestReview.mockRejectedValue(new Error('no scene'));
    const renderer = renderScreen();
    await act(async () => {
      row(renderer, 'Rate Pickle Sensei').props.onPress();
    });
    expect(mockRequestReview).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).toContain('About');
    act(() => renderer.unmount());
  });
});

describe('Sign out sheet', () => {
  it('is closed until the Sign out row is pressed, then confirms exactly once', async () => {
    const renderer = renderScreen();
    expect(signOutSheet(renderer).props.visible).toBe(false);

    act(() => pressable(renderer, 'Sign out').props.onPress());
    expect(signOutSheet(renderer).props.visible).toBe(true);
    expect(allText(renderer)).toContain('Sign out of Pickle Sensei?');

    const confirm = sheetButton(renderer, 'Sign out');
    await act(async () => {
      confirm.props.onPress();
    });
    expect(useAuthStore.getState().signOut).toHaveBeenCalledTimes(1);
    // Sheet closes immediately — no lingering spinner, no second confirm.
    expect(signOutSheet(renderer).props.visible).toBe(false);
    act(() => renderer.unmount());
  });

  it('every cancel affordance closes the sheet without signing out', () => {
    const renderer = renderScreen();
    const open = () => {
      act(() => pressable(renderer, 'Sign out').props.onPress());
      expect(signOutSheet(renderer).props.visible).toBe(true);
    };

    open();
    act(() => sheetButton(renderer, 'Keep me signed in').props.onPress());
    expect(signOutSheet(renderer).props.visible).toBe(false);

    open();
    act(() => pressable(renderer, 'Cancel sign out').props.onPress());
    expect(signOutSheet(renderer).props.visible).toBe(false);

    open();
    act(() =>
      pressable(renderer, 'Close sign out confirmation').props.onPress(),
    );
    expect(signOutSheet(renderer).props.visible).toBe(false);

    open();
    act(() => signOutSheet(renderer).props.onRequestClose());
    expect(signOutSheet(renderer).props.visible).toBe(false);

    expect(useAuthStore.getState().signOut).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('the dialog is announced as modal and the sign-out row is a labelled button', () => {
    const renderer = renderScreen();
    const signOutRow = pressable(renderer, 'Sign out');
    expect(signOutRow.props.accessibilityRole).toBe('button');
    act(() => signOutRow.props.onPress());
    const modalViews = renderer.root.findAll(
      node => node.props.accessibilityViewIsModal === true,
    );
    expect(modalViews.length).toBeGreaterThan(0);
    act(() => renderer.unmount());
  });
});

describe('AGENTS.md invariants for settings-about', () => {
  it('Live Court stays unreachable: no Live Court, coach voice or gameplay rows', () => {
    const renderer = renderScreen();
    const copy = allText(renderer);
    expect(copy).not.toMatch(/Live Court/i);
    expect(copy).not.toMatch(/Coach voice/i);
    expect(copy).not.toMatch(/Gameplay/i);
    for (const call of mockNavigate.mock.calls) {
      expect(['LiveCourt', 'LiveSummary', 'GameplayProgress']).not.toContain(
        call[0],
      );
    }
    act(() => renderer.unmount());
  });

  it('no custom rating nag is drawn — the only rating surface is the single About row', () => {
    const renderer = renderScreen();
    const copy = allText(renderer);
    expect(copy.match(/Rate Pickle Sensei/g)).toHaveLength(1);
    expect(copy).not.toMatch(/enjoying|leave a review|5 stars/i);
    act(() => renderer.unmount());
  });

  it('the Technique Score disclaimer is present (not a verified DUPR)', () => {
    const renderer = renderScreen();
    expect(allText(renderer)).toContain(
      'Technique Score is coaching feedback—not a verified DUPR or player rating.',
    );
    act(() => renderer.unmount());
  });

  it('legal rows are hidden (never a dead tap) when the API origin is unconfigured', () => {
    mockRuntime.apiBaseUrl = null;
    const renderer = renderScreen();
    expect(rowsStartingWith(renderer, 'Privacy policy')).toHaveLength(0);
    expect(rowsStartingWith(renderer, 'Terms of use')).toHaveLength(0);
    // About card still has its remaining rows.
    expect(rowsStartingWith(renderer, 'Rate Pickle Sensei')).toHaveLength(1);
    expect(allText(renderer)).toContain('App version');
    act(() => renderer.unmount());
  });
});
