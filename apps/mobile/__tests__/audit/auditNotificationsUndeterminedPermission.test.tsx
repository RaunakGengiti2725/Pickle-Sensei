import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * Structural audit probe (mobile-settings-account, pass 1).
 *
 * State: reminders opted in (`prefs.enabled === true`, durable) while the OS
 * permission is `undetermined` — the phone was never asked. Reached when the
 * SQLite kv survives but the permission does not (device restore from an
 * iCloud/Finder backup: app data is restored, notification authorization is
 * per install). `syncNow` cancels everything for any non-granted permission,
 * so nothing is scheduled. The screen's header contract: "a revoked system
 * permission is surfaced with a recovery path, never silently worked
 * around." Denied → "Open system settings"; unknown → "Check again";
 * undetermined → ?
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
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => insets,
    initialWindowMetrics: null,
  };
});

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const ReactModule = jest.requireActual<typeof import('react')>('react');
    ReactModule.useEffect(() => callback(), [callback]);
  },
}));

const mockScheduler = {
  permissionState: jest.fn(async () => 'undetermined' as const),
  requestPermission: jest.fn(async () => 'granted' as const),
  applyPlan: jest.fn(async () => undefined),
  cancelAllPlanned: jest.fn(async () => undefined),
  openSystemSettings: jest.fn(async () => undefined),
};
jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => mockScheduler,
}));

import { NotificationSettingsScreen } from '../../src/screens/NotificationSettingsScreen';
import { SettingsScreen } from '../../src/screens/SettingsScreen';
import { Button } from '../../src/design/components';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { DEFAULT_NOTIFICATION_PREFS } from '../../src/notifications/types';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import { useConsentStore } from '../../src/state/consentStore';
import {
  clearAccessStoreConfiguration,
  useAccessStore,
} from '../../src/state/accessStore';

const syncedSession: AuthSession = {
  provider: 'apple',
  subject: '11111111-1111-4111-8111-111111111111',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function buttonLabels(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Button)
    .map(node => String(node.props.label));
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
  });
}

let mounted: TestRenderer.ReactTestRenderer | null = null;

beforeEach(() => {
  clearAccessStoreConfiguration();
  useAccessStore.setState({ status: 'idle' });
  useAuthStore.setState({ session: syncedSession, hydrated: true });
  useConsentStore.setState({
    availability: 'signed_out',
    modelTrainingActive: false,
    hydrate: jest.fn(() => Promise.resolve()),
  });
  useNotificationStore.setState({
    hydrated: true,
    ownerKey: syncedSession.canonicalAppUserId,
    prefs: {
      ...DEFAULT_NOTIFICATION_PREFS,
      enabled: true,
      practiceReminder: true,
      practiceReminderMinutes: 17 * 60 + 30,
    },
    permission: 'undetermined',
    persistFailed: false,
    scheduleFailed: false,
  });
});

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
});

describe('audit: reminders opted in while the OS permission is undetermined', () => {
  it('Notifications screen offers a way to ask for permission', async () => {
    await act(async () => {
      mounted = TestRenderer.create(<NotificationSettingsScreen />);
    });
    await flush();
    const renderer = mounted!;
    const copy = allText(renderer);
    expect(copy).toContain('Paused until notifications are allowed');
    const labels = buttonLabels(renderer);
    // Any of the existing recovery affordances would do: the opt-in CTA
    // (asks the OS), the denied-path system-settings button, or the
    // re-check button.
    const recovery = labels.filter(label =>
      /Turn on reminders|Open system settings|Check again|Allow notifications/i.test(
        label,
      ),
    );
    expect({ labels, recovery }).toEqual(
      expect.objectContaining({
        recovery: expect.arrayContaining([expect.any(String)]),
      }),
    );
  });

  it('Settings row does not claim a daily reminder when nothing is scheduled', async () => {
    await act(async () => {
      mounted = TestRenderer.create(<SettingsScreen />);
    });
    await flush();
    const renderer = mounted!;
    const rows = renderer.root.findAll(
      node =>
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.startsWith('Notifications, ') &&
        typeof node.props.onPress === 'function',
    );
    expect(rows.length).toBeGreaterThan(0);
    const value = String(rows[0]!.props.accessibilityLabel).replace(
      'Notifications, ',
      '',
    );
    // Nothing is planned (syncNow cancels for any non-granted permission);
    // "Daily · 5:30 PM" would be a promise the phone cannot keep.
    expect(value).not.toMatch(/^Daily/);
  });
});
