import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type {
  PermissionState,
  SchedulerPort,
} from '../../../src/notifications/service';
import type { PlannedNotification } from '../../../src/notifications/types';
import { DEFAULT_NOTIFICATION_PREFS } from '../../../src/notifications/types';
import { setActiveDataOwner } from '../../../src/data/accountScope';

/**
 * Adversarial pass (mobile-settings-account, pass 3): the Notification
 * settings screen under permission denial, a system prompt that throws,
 * rapid repeated taps on "Turn on reminders", and a settings sheet that
 * refuses to open.
 */

const mockKvTable = new Map<string, string>();
jest.mock('../../../src/data/db', () => ({
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

const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const React = jest.requireActual<typeof import('react')>('react');
    React.useEffect(() => callback(), [callback]);
  },
}));

class FakeScheduler implements SchedulerPort {
  permission: PermissionState | Error = 'undetermined';
  requestResult: PermissionState | Error = 'granted';
  requestCalls = 0;
  requestGate: Promise<void> | null = null;
  openSettingsCalls = 0;
  openSettingsResult: Error | null = null;
  appliedPlans: PlannedNotification[][] = [];
  cancelAllCalls = 0;

  async permissionState(): Promise<PermissionState> {
    if (this.permission instanceof Error) throw this.permission;
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    this.requestCalls += 1;
    if (this.requestGate) await this.requestGate;
    if (this.requestResult instanceof Error) throw this.requestResult;
    this.permission = this.requestResult;
    return this.requestResult;
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    this.appliedPlans.push([...plan]);
  }
  async cancelAllPlanned(): Promise<void> {
    this.cancelAllCalls += 1;
  }
  async openSystemSettings(): Promise<void> {
    this.openSettingsCalls += 1;
    if (this.openSettingsResult) throw this.openSettingsResult;
  }
}

const mockScheduler = new FakeScheduler();
jest.mock('../../../src/notifications/service', () => {
  const actual = jest.requireActual<
    typeof import('../../../src/notifications/service')
  >('../../../src/notifications/service');
  return { ...actual, getScheduler: () => mockScheduler };
});
const scheduler = mockScheduler;

jest.mock('../../../src/consistency/store', () => ({
  computeConsistencySnapshot: async () => ({
    currentStreak: 0,
    trainedToday: false,
    totalActivities: 0,
    shieldsAvailable: 0,
    nextStreakMilestone: null,
  }),
}));

import { NotificationSettingsScreen } from '../../../src/screens/NotificationSettingsScreen';
import { useNotificationStore } from '../../../src/notifications/notificationStore';
import { Button } from '../../../src/design/components';

const owner = '55555555-5555-4555-8555-555555555555';

function render() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<NotificationSettingsScreen />);
  });
  return renderer;
}

function button(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = renderer.root
    .findAllByType(Button)
    .filter(node => node.props.label === label);
  return matches[0] ?? null;
}

function alerts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll(node => node.props.accessibilityRole === 'alert')
    .map(node =>
      Array.isArray(node.props.children)
        ? node.props.children.join('')
        : String(node.props.children),
    );
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  mockKvTable.clear();
  mockGoBack.mockClear();
  scheduler.permission = 'undetermined';
  scheduler.requestResult = 'granted';
  scheduler.requestCalls = 0;
  scheduler.requestGate = null;
  scheduler.openSettingsCalls = 0;
  scheduler.openSettingsResult = null;
  scheduler.appliedPlans = [];
  scheduler.cancelAllCalls = 0;
  setActiveDataOwner(owner);
  act(() => {
    useNotificationStore.setState({
      hydrated: true,
      ownerKey: owner,
      prefs: { ...DEFAULT_NOTIFICATION_PREFS },
      permission: 'undetermined',
      persistFailed: false,
      scheduleFailed: false,
    });
  });
});

describe('NotificationSettingsScreen — adversarial', () => {
  it('permission DENIED by the system prompt → prefs stay off, denied banner, no "didn’t confirm" alert', async () => {
    scheduler.requestResult = 'denied';
    const renderer = render();
    await settle();
    await act(async () => {
      button(renderer, 'Turn on reminders')!.props.onPress();
    });
    await settle();
    expect(scheduler.requestCalls).toBe(1);
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    expect(useNotificationStore.getState().permission).toBe('denied');
    expect(scheduler.appliedPlans).toEqual([]);
    expect(alerts(renderer)).toEqual([]);
    expect(button(renderer, 'Open system settings')).not.toBeNull();
    expect(button(renderer, 'Turn on reminders')).toBeNull();
    act(() => renderer.unmount());
  });

  it('system prompt THROWS → permission unknown, prefs off, the failure alert is shown with a settings escape', async () => {
    scheduler.requestResult = new Error('UNUserNotificationCenter unavailable');
    const renderer = render();
    await settle();
    await act(async () => {
      button(renderer, 'Turn on reminders')!.props.onPress();
    });
    await settle();
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    expect(useNotificationStore.getState().permission).toBe('unknown');
    expect(alerts(renderer)[0]).toContain('Reminders weren’t turned on');
    expect(button(renderer, 'Open system settings')).not.toBeNull();
    expect(button(renderer, 'Turn on reminders')!.props.disabled).toBe(false);
    act(() => renderer.unmount());
  });

  it('rapid repeated taps on Turn on reminders while the prompt is open → exactly one system prompt', async () => {
    let release!: () => void;
    scheduler.requestGate = new Promise<void>(r => {
      release = r;
    });
    const renderer = render();
    await settle();
    const turnOn = button(renderer, 'Turn on reminders')!;
    await act(async () => {
      turnOn.props.onPress();
    });
    expect(button(renderer, 'Turn on reminders')!.props.disabled).toBe(true);
    for (let i = 0; i < 10; i += 1) {
      await act(async () => {
        turnOn.props.onPress();
        button(renderer, 'Turn on reminders')!.props.onPress();
      });
    }
    expect(scheduler.requestCalls).toBe(1);
    release();
    await settle();
    await settle();
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);
    expect(useNotificationStore.getState().permission).toBe('granted');
    expect(scheduler.appliedPlans.length).toBe(1);
    act(() => renderer.unmount());
  });

  it('CHARACTERIZATION: two taps inside one batched tick request the system prompt TWICE (guard is closure state)', async () => {
    // `turnOnReminders` reads `requesting` from the render closure; two calls
    // batched into one tick both observe `false`.
    let release!: () => void;
    scheduler.requestGate = new Promise<void>(r => {
      release = r;
    });
    const renderer = render();
    await settle();
    const turnOn = button(renderer, 'Turn on reminders')!;
    await act(async () => {
      turnOn.props.onPress();
      turnOn.props.onPress();
    });
    // CHARACTERIZATION: both closures observe requesting === false, so the
    // system prompt is requested twice. iOS coalesces a second
    // requestAuthorization while the first alert is up, so the visible
    // effect is nil; the store still writes prefs twice.
    expect(scheduler.requestCalls).toBe(2);
    release();
    await settle();
    await settle();
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);
    act(() => renderer.unmount());
  });

  it('denied → Open system settings fails to open → the inline fallback instruction appears; a later success clears it', async () => {
    scheduler.permission = 'denied';
    act(() => {
      useNotificationStore.setState({ permission: 'denied' });
    });
    scheduler.openSettingsResult = new Error('Linking failed');
    const renderer = render();
    await settle();
    await act(async () => {
      button(renderer, 'Open system settings')!.props.onPress();
    });
    await settle();
    expect(scheduler.openSettingsCalls).toBe(1);
    expect(
      alerts(renderer).some(a => a.includes('Couldn’t open Settings')),
    ).toBe(true);
    scheduler.openSettingsResult = null;
    await act(async () => {
      button(renderer, 'Open system settings')!.props.onPress();
    });
    await settle();
    expect(
      alerts(renderer).some(a => a.includes('Couldn’t open Settings')),
    ).toBe(false);
    act(() => renderer.unmount());
  });

  it('permission check throwing on focus → "couldn’t be checked" state; Check again after recovery re-reads and schedules', async () => {
    act(() => {
      useNotificationStore.setState({
        prefs: { ...DEFAULT_NOTIFICATION_PREFS, enabled: true },
      });
    });
    scheduler.permission = new Error('notification center unavailable');
    const renderer = render();
    await settle();
    expect(useNotificationStore.getState().permission).toBe('unknown');
    expect(scheduler.appliedPlans).toEqual([]);
    expect(button(renderer, 'Check again')).not.toBeNull();
    scheduler.permission = 'granted';
    await act(async () => {
      button(renderer, 'Check again')!.props.onPress();
    });
    await settle();
    await settle();
    expect(useNotificationStore.getState().permission).toBe('granted');
    expect(scheduler.appliedPlans.length).toBe(1);
    act(() => renderer.unmount());
  });

  it('permission revoked in Settings while reminders are on → focus re-check shows the denied recovery path, prefs untouched', async () => {
    act(() => {
      useNotificationStore.setState({
        permission: 'granted',
        prefs: { ...DEFAULT_NOTIFICATION_PREFS, enabled: true },
      });
    });
    scheduler.permission = 'denied';
    const renderer = render();
    await settle();
    expect(useNotificationStore.getState().permission).toBe('denied');
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);
    expect(button(renderer, 'Open system settings')).not.toBeNull();
    expect(button(renderer, 'Turn on reminders')).toBeNull();
    // CHARACTERIZATION: the focus re-check only re-reads permission; it does
    // not re-plan, so nothing is cancelled here (iOS suppresses delivery for
    // a denied app anyway, and the next hydrate/setPrefs re-syncs).
    expect(scheduler.cancelAllCalls).toBe(0);
    expect(scheduler.appliedPlans).toEqual([]);
    act(() => renderer.unmount());
  });
});
