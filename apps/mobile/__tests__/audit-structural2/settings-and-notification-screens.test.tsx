import React from 'react';

// The mobile tsconfig has no Node types.
declare const process: {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
};
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * AUDIT PROBES (structural #2, mobile-settings-account) — screen level.
 *
 * A. SettingsScreen focus refresh when the access backend rejects (offline):
 *    no unhandled rejection, row degrades to "Verify access", the last good
 *    value is dropped (documented behaviour is "old value stays until the
 *    NEW one lands" — a failure is not a landing).
 * B. NotificationSettingsScreen with `prefs.enabled && permission ===
 *    'undetermined'` (restored SQLite prefs on a phone that was never asked):
 *    syncNow cancels everything, the master switch reads ON with a "Paused"
 *    caption, and the only control that requests permission ("Turn on
 *    reminders") is hidden because prefs.enabled is true.
 */

jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

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
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => insets,
    initialWindowMetrics: null,
  };
});

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: jest.fn() }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const ReactModule = jest.requireActual<typeof import('react')>('react');
    ReactModule.useEffect(() => callback(), [callback]);
  },
}));

class FakeScheduler implements SchedulerPort {
  permission: PermissionState = 'undetermined';
  appliedPlans: PlannedNotification[][] = [];
  cancelAllCalls = 0;
  requestCalls = 0;
  async permissionState(): Promise<PermissionState> {
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    this.requestCalls += 1;
    this.permission = 'granted';
    return 'granted';
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    this.appliedPlans.push([...plan]);
  }
  async cancelAllPlanned(): Promise<void> {
    this.cancelAllCalls += 1;
  }
  async openSystemSettings(): Promise<void> {}
}
const mockScheduler = new FakeScheduler();
jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => mockScheduler,
}));
jest.mock('../../src/consistency/store', () => ({
  ...jest.requireActual<typeof import('../../src/consistency/store')>(
    '../../src/consistency/store',
  ),
  computeConsistencySnapshot: async () => ({
    currentStreak: 0,
    trainedToday: false,
    totalActivities: 0,
    shieldsAvailable: 0,
    nextStreakMilestone: null,
  }),
}));

import type {
  PermissionState,
  SchedulerPort,
} from '../../src/notifications/service';
import type { PlannedNotification } from '../../src/notifications/types';
import {
  DEFAULT_NOTIFICATION_PREFS,
  notificationPrefsKeyForOwner,
} from '../../src/notifications/types';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { NotificationSettingsScreen } from '../../src/screens/NotificationSettingsScreen';
import { SettingsScreen } from '../../src/screens/SettingsScreen';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import { useConsentStore } from '../../src/state/consentStore';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
} from '../../src/billing/types';

const syncedSession: AuthSession = {
  provider: 'apple',
  subject: '11111111-1111-4111-8111-111111111111',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

const owner = '77777777-7777-4777-8777-777777777777';

function textContent(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node =>
      React.Children.toArray(node.props.children)
        .filter(child => typeof child === 'string')
        .join(''),
    )
    .join('\n');
}

function pressables(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll(node => typeof node.props.onPress === 'function')
    .map(
      node =>
        (node.props.accessibilityLabel as string | undefined) ??
        (node.props.label as string | undefined) ??
        '',
    )
    .filter(Boolean);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
}

let mounted: TestRenderer.ReactTestRenderer | null = null;
afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('AUDIT A: Settings focus refresh with the access backend offline', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  beforeAll(() => process.on('unhandledRejection', onUnhandled));
  afterAll(() => process.off('unhandledRejection', onUnhandled));

  it('does not throw and shows "Verify access"', async () => {
    clearAccessStoreConfiguration();
    useAuthStore.setState({ session: syncedSession });
    useConsentStore.setState({
      availability: 'signed_out',
      modelTrainingActive: false,
      hydrate: jest.fn(() => Promise.resolve()),
    });
    const clients: BillingAccessDependencies = {
      store: {
        configure: jest.fn(async () => undefined),
        loadPlans: jest.fn(async () => {
          throw new Error('unused');
        }),
        purchase: jest.fn(),
        restore: jest.fn(),
        readEntitlement: jest.fn(),
      },
      backend: {
        getAccess: jest.fn(async (): Promise<CanonicalAccessState> => {
          throw new TypeError('Network request failed');
        }),
        syncBilling: jest.fn(),
      },
    };
    configureAccessStore(clients);
    useAccessStore.setState({
      status: 'ready',
      canonicalAccess: {
        premium: false,
        entitlements: [],
        freeRatings: {
          limit: 2,
          used: 0,
          reserved: 0,
          remaining: 2,
          availableToReserve: 2,
        },
        canStartRating: true,
        paywallRequired: false,
      },
    });

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<SettingsScreen />);
    });
    mounted = renderer;
    await flush();

    const row = renderer.root.findAll(
      node =>
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.startsWith('Pickle Sensei Pro, ') &&
        typeof node.props.onPress === 'function',
    )[0]!;
    const state = useAccessStore.getState();
    console.log(
      JSON.stringify({
        probe: 'settings-focus-refresh-offline',
        rowLabel: row.props.accessibilityLabel,
        status: state.status,
        errorCode: state.error?.code,
        unhandledRejections: unhandled.length,
      }),
    );
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(unhandled).toHaveLength(0);
    expect(row.props.accessibilityLabel).toBe(
      'Pickle Sensei Pro, Verify access',
    );
    expect(state.error?.code).toBe('billing.backend_unavailable');
  });
});

describe('AUDIT B: Notification settings with enabled prefs and an undetermined permission', () => {
  beforeEach(() => {
    mockKvTable.clear();
    mockScheduler.permission = 'undetermined';
    mockScheduler.appliedPlans = [];
    mockScheduler.cancelAllCalls = 0;
    mockScheduler.requestCalls = 0;
    useNotificationStore.setState({
      hydrated: false,
      ownerKey: null,
      prefs: { ...DEFAULT_NOTIFICATION_PREFS },
      permission: 'unknown',
      persistFailed: false,
      scheduleFailed: false,
    });
  });

  it('offers a control that requests permission without first turning reminders off', async () => {
    mockKvTable.set(
      notificationPrefsKeyForOwner(owner),
      JSON.stringify({
        ...DEFAULT_NOTIFICATION_PREFS,
        enabled: true,
        promptDismissed: true,
      }),
    );
    setActiveDataOwner(owner);
    await useNotificationStore.getState().hydrate();
    expect(useNotificationStore.getState().permission).toBe('undetermined');
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<NotificationSettingsScreen />);
    });
    mounted = renderer;
    await flush();

    const copy = textContent(renderer);
    const controls = pressables(renderer);
    const requestControls = controls.filter(label =>
      /turn on reminders|allow notifications|check again|open system settings/i.test(
        label,
      ),
    );
    console.log(
      JSON.stringify({
        probe: 'notificationSettings-enabled-undetermined',
        cancelAllCalls: mockScheduler.cancelAllCalls,
        appliedPlans: mockScheduler.appliedPlans.length,
        masterCaptionPaused: copy.includes(
          'Paused until notifications are allowed',
        ),
        controls,
        requestControls,
      }),
    );
    expect(mockScheduler.appliedPlans).toHaveLength(0);
    expect(copy).toContain('Paused until notifications are allowed');
    expect(requestControls.length).toBeGreaterThan(0);
  });
});
