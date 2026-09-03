/**
 * App Store compliance sweep — Settings hub (App Review 5.1.1(v), 3.1.2,
 * 5.6.1, 4.2).
 *
 * Walks every interactive Settings row as a reviewer would and asserts the
 * wired handler, the exact navigation target/params, and accessibility
 * props: Manage account (deletion entry) only for synced sessions, Pro →
 * Paywall {source: 'settings'} (or ConnectAccount for local sessions),
 * Privacy/Terms → the public legal URLs, Rate → the StoreKit helper only
 * (no custom nag UI), and the sign-out sheet's cancel/confirm branches.
 */
import React from 'react';
import { Linking, Modal, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

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
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
  // Settings re-reads the free-rating ledger on every focus; a mount is the
  // first focus.
  useFocusEffect: (callback: () => void | (() => void)) => {
    const React = jest.requireActual<typeof import('react')>('react');
    React.useEffect(() => callback(), [callback]);
  },
}));

const mockRateAppFromSettings = jest.fn<Promise<unknown>, []>(async () => ({
  outcome: 'requested',
}));
jest.mock('../../src/review/appStoreReview', () => ({
  rateAppFromSettings: () => mockRateAppFromSettings(),
}));

const mockReplay = jest.fn();
jest.mock('../../src/walkthrough/walkthroughStore', () => ({
  useWalkthroughStore: { getState: () => ({ replay: mockReplay }) },
}));

import { SettingsScreen } from '../../src/screens/SettingsScreen';
import { Button } from '../../src/design/components';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import { useConsentStore } from '../../src/state/consentStore';
import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';

const syncedSession: AuthSession = {
  provider: 'google',
  subject: '33333333-3333-4333-8333-333333333333',
  canonicalAppUserId: '33333333-3333-4333-8333-333333333333',
  localOnly: false,
  displayName: 'Sam Rivera',
  email: 'sam@example.com',
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

/** Innermost pressable whose label starts with `prefix` (SettingRow labels
 * are "<label>, <value>"). */
function rowsByLabelPrefix(
  renderer: TestRenderer.ReactTestRenderer,
  prefix: string,
) {
  return renderer.root.findAll(
    n =>
      typeof n.props.accessibilityLabel === 'string' &&
      n.props.accessibilityLabel.startsWith(prefix) &&
      typeof n.props.onPress === 'function' &&
      n.props.accessibilityRole === 'button',
  );
}

async function pressRow(
  renderer: TestRenderer.ReactTestRenderer,
  prefix: string,
) {
  const [row] = rowsByLabelPrefix(renderer, prefix);
  if (!row) throw new Error(`No settings row labeled ${prefix}`);
  await act(async () => {
    row.props.onPress();
  });
  return row;
}

function sheetButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const [button] = renderer.root
    .findAllByType(Button)
    .filter(node => node.props.label === label);
  if (!button) throw new Error(`No sheet button labeled ${label}`);
  return button;
}

function spyOnOpenUrl() {
  const spy = jest.spyOn(Linking, 'openURL');
  spy.mockClear();
  spy.mockResolvedValue(undefined);
  return spy;
}

describe('Settings hub controls', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockRateAppFromSettings.mockClear();
    mockReplay.mockClear();
    useAuthStore.setState({
      hydrated: true,
      session: syncedSession,
      busy: false,
      error: null,
      signOut: jest.fn(() => Promise.resolve()),
    });
    useConsentStore.setState({
      availability: 'ready',
      modelTrainingActive: false,
      busy: false,
      error: null,
      hydrate: jest.fn(() => Promise.resolve()),
    });
  });

  it('synced session: Manage account (deletion entry) is present and routes to ManageAccount', async () => {
    const renderer = renderScreen();
    expect(allText(renderer)).toContain('Account');
    await pressRow(renderer, 'Manage account,');
    expect(mockNavigate).toHaveBeenCalledWith('ManageAccount');
    act(() => renderer.unmount());
  });

  it('synced session: Pro row opens the Paywall with source=settings', async () => {
    const renderer = renderScreen();
    await pressRow(renderer, 'Pickle Sensei Pro,');
    expect(mockNavigate).toHaveBeenCalledWith('Paywall', {
      source: 'settings',
    });
    expect(rowsByLabelPrefix(renderer, 'Connect account,')).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('local-only session: no Manage account row; Pro and Connect rows both route to ConnectAccount', async () => {
    useAuthStore.setState({ session: guestSession });
    const renderer = renderScreen();
    expect(rowsByLabelPrefix(renderer, 'Manage account,')).toHaveLength(0);
    expect(allText(renderer)).toContain(
      'Progress stays on this phone until you connect an account.',
    );
    await pressRow(renderer, 'Connect account,');
    await pressRow(renderer, 'Pickle Sensei Pro, Sign in first');
    expect(mockNavigate.mock.calls).toEqual([
      ['ConnectAccount'],
      ['ConnectAccount'],
    ]);
    act(() => renderer.unmount());
  });

  it('Privacy policy and Terms of use rows open the public legal URLs', async () => {
    const openUrl = spyOnOpenUrl();
    const { legalPrivacyUrl, legalTermsUrl } = getRuntimePublicConfig();
    const renderer = renderScreen();
    await pressRow(renderer, 'Privacy policy,');
    await pressRow(renderer, 'Terms of use,');
    expect(openUrl.mock.calls.map(call => call[0])).toEqual([
      legalPrivacyUrl,
      legalTermsUrl,
    ]);
    expect(legalPrivacyUrl).toMatch(/^https:\/\/.+\/privacy$/);
    expect(legalTermsUrl).toMatch(/^https:\/\/.+\/terms$/);
    act(() => renderer.unmount());
  });

  it('Rate Pickle Sensei delegates to the StoreKit helper and draws no custom rating UI', async () => {
    const renderer = renderScreen();
    const before = allText(renderer);
    expect(before).not.toMatch(
      /enjoying|love the app|leave a review|stars?\b/i,
    );
    await pressRow(renderer, 'Rate Pickle Sensei,');
    expect(mockRateAppFromSettings).toHaveBeenCalledTimes(1);
    // Nothing new is drawn on the page — the OS owns the review sheet.
    expect(allText(renderer)).toBe(before);
    expect(renderer.root.findAllByType(Modal).some(m => m.props.visible)).toBe(
      false,
    );
    act(() => renderer.unmount());
  });

  it('Notifications, Data & consent, Consistency and Walkthrough rows all navigate to real routes', async () => {
    const renderer = renderScreen();
    await pressRow(renderer, 'Notifications,');
    await pressRow(renderer, 'Data & consent,');
    await pressRow(renderer, 'Consistency,');
    await pressRow(renderer, 'App walkthrough,');
    expect(mockNavigate.mock.calls).toEqual([
      ['NotificationSettings'],
      ['ConsentSettings'],
      ['StreakCalendar'],
      ['Tabs', { screen: 'Home' }],
    ]);
    expect(mockReplay).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('read-only rows (version, scoring model, profile facts) are not pressable', () => {
    const renderer = renderScreen();
    for (const prefix of [
      'App version,',
      'Scoring model,',
      'Name,',
      'Gender,',
      'Playing level,',
      'Hitting hand,',
      'Current focus,',
    ]) {
      expect(rowsByLabelPrefix(renderer, prefix)).toHaveLength(0);
    }
    expect(allText(renderer)).toContain(getRuntimePublicConfig().appVersion);
    act(() => renderer.unmount());
  });

  it('sign out: sheet opens, every cancel affordance keeps the session, confirm signs out once', async () => {
    const renderer = renderScreen();
    const signOut = useAuthStore.getState().signOut as jest.Mock;
    const sheet = () => renderer.root.findByType(Modal);

    const open = async () => {
      const [link] = renderer.root.findAll(
        n =>
          n.props.accessibilityLabel === 'Sign out' &&
          typeof n.props.onPress === 'function',
      );
      await act(async () => link!.props.onPress());
      expect(sheet().props.visible).toBe(true);
      expect(allText(renderer)).toContain('Sign out of Pickle Sensei?');
    };

    await open();
    await act(async () =>
      sheetButton(renderer, 'Keep me signed in').props.onPress(),
    );
    expect(sheet().props.visible).toBe(false);

    await open();
    const [backdrop] = renderer.root.findAll(
      n =>
        n.props.accessibilityLabel === 'Cancel sign out' &&
        typeof n.props.onPress === 'function',
    );
    await act(async () => backdrop!.props.onPress());
    expect(sheet().props.visible).toBe(false);

    await open();
    const [closeX] = renderer.root.findAll(
      n =>
        n.props.accessibilityLabel === 'Close sign out confirmation' &&
        typeof n.props.onPress === 'function',
    );
    await act(async () => closeX!.props.onPress());
    expect(sheet().props.visible).toBe(false);

    await open();
    await act(async () => sheet().props.onRequestClose());
    expect(sheet().props.visible).toBe(false);
    expect(signOut).not.toHaveBeenCalled();

    await open();
    await act(async () => sheetButton(renderer, 'Sign out').props.onPress());
    expect(sheet().props.visible).toBe(false);
    expect(signOut).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });
});
