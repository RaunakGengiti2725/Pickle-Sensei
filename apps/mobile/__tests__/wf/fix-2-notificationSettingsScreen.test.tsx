import React from 'react';
import { Switch, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { PermissionState } from '../../src/notifications/service';
import type { PlannedNotification } from '../../src/notifications/types';
import { DEFAULT_NOTIFICATION_PREFS } from '../../src/notifications/types';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

/**
 * NotificationSettingsScreen must never show a control that does nothing or
 * a caption that claims a schedule which does not exist:
 *   - with the OS permission denied, the only CTA is the system-settings
 *     recovery path (iOS never re-prompts once denied);
 *   - a failed permission request, a failed save, a failed schedule apply
 *     and a failed settings deep-link each surface as copy on screen;
 *   - an unreadable permission ('unknown') is reported as paused with a
 *     retry, never as "scheduled".
 */

const mockKvTable = new Map<string, string>();
let mockKvWriteFails = false;

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        const value = mockKvTable.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        if (mockKvWriteFails) throw new Error('disk full');
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
  return { SafeAreaView: View };
});

const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack }),
  useFocusEffect: () => {},
}));

const mockScheduler = {
  permissionState: jest.fn<Promise<PermissionState>, []>(),
  requestPermission: jest.fn<Promise<PermissionState>, []>(),
  applyPlan: jest.fn<Promise<void>, [readonly PlannedNotification[]]>(),
  cancelAllPlanned: jest.fn<Promise<void>, []>(),
  openSystemSettings: jest.fn<Promise<void>, []>(),
};
jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => mockScheduler,
}));

jest.mock('../../src/consistency/store', () => ({
  computeConsistencySnapshot: async () => {
    throw new Error('no history in this test');
  },
}));

import { NotificationSettingsScreen } from '../../src/screens/NotificationSettingsScreen';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { Button } from '../../src/design/components';

const owner = '66666666-6666-4666-8666-666666666666';

let mounted: TestRenderer.ReactTestRenderer | null = null;

function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<NotificationSettingsScreen />);
  });
  mounted = renderer;
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

function buttons(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root
    .findAllByType(Button)
    .filter(node => node.props.label === label);
}

function switchFor(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root
    .findAllByType(Switch)
    .find(node => node.props.accessibilityLabel === label)!;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function seedStore(
  permission: PermissionState | 'unknown',
  prefs: Partial<typeof DEFAULT_NOTIFICATION_PREFS> = {},
) {
  useNotificationStore.setState({
    hydrated: true,
    ownerKey: owner,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS, ...prefs },
    permission,
    persistFailed: false,
    scheduleFailed: false,
  });
}

beforeEach(() => {
  mockKvTable.clear();
  mockKvWriteFails = false;
  mockGoBack.mockClear();
  mockScheduler.permissionState.mockReset().mockResolvedValue('granted');
  mockScheduler.requestPermission.mockReset().mockResolvedValue('granted');
  mockScheduler.applyPlan.mockReset().mockResolvedValue(undefined);
  mockScheduler.cancelAllPlanned.mockReset().mockResolvedValue(undefined);
  mockScheduler.openSystemSettings.mockReset().mockResolvedValue(undefined);
  setActiveDataOwner(owner);
});

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('NotificationSettingsScreen (fix-2)', () => {
  it('hides the dead "Turn on reminders" CTA while the OS permission is denied', () => {
    seedStore('denied', { enabled: false });
    const renderer = renderScreen();
    expect(buttons(renderer, 'Turn on reminders')).toHaveLength(0);
    expect(buttons(renderer, 'Open system settings')).toHaveLength(1);
    expect(allText(renderer)).toContain(
      'Notifications are off in system settings',
    );
  });

  it('offers the CTA again once the permission is no longer denied', () => {
    seedStore('undetermined', { enabled: false });
    const renderer = renderScreen();
    expect(buttons(renderer, 'Turn on reminders')).toHaveLength(1);
    expect(buttons(renderer, 'Open system settings')).toHaveLength(0);
  });

  it('turns reminders on when the system grants permission', async () => {
    seedStore('undetermined', { enabled: false });
    const renderer = renderScreen();
    await act(async () => {
      buttons(renderer, 'Turn on reminders')[0]!.props.onPress();
    });
    await flush();
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);
    expect(buttons(renderer, 'Turn on reminders')).toHaveLength(0);
    expect(allText(renderer)).toContain(
      'Scheduled from your real practice history',
    );
  });

  it('disables the CTA while the permission request is pending', async () => {
    seedStore('undetermined', { enabled: false });
    let resolveRequest!: (state: PermissionState) => void;
    mockScheduler.requestPermission.mockImplementation(
      () =>
        new Promise<PermissionState>(resolve => {
          resolveRequest = resolve;
        }),
    );
    const renderer = renderScreen();
    await act(async () => {
      buttons(renderer, 'Turn on reminders')[0]!.props.onPress();
    });
    expect(buttons(renderer, 'Turn on reminders')[0]!.props.disabled).toBe(
      true,
    );
    await act(async () => {
      resolveRequest('granted');
    });
    await flush();
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);
  });

  it('explains a failed permission request instead of leaving the card unchanged', async () => {
    seedStore('undetermined', { enabled: false });
    mockScheduler.requestPermission.mockRejectedValue(
      new Error('bridge unavailable'),
    );
    const renderer = renderScreen();
    const before = allText(renderer);
    await act(async () => {
      buttons(renderer, 'Turn on reminders')[0]!.props.onPress();
    });
    await flush();
    const after = allText(renderer);
    expect(after).not.toBe(before);
    expect(after).toContain('Reminders weren’t turned on');
    expect(buttons(renderer, 'Turn on reminders')[0]!.props.disabled).toBe(
      false,
    );
    expect(buttons(renderer, 'Open system settings')).toHaveLength(1);
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
  });

  it('swaps to the denied recovery card when the system prompt is declined', async () => {
    seedStore('undetermined', { enabled: false });
    mockScheduler.requestPermission.mockResolvedValue('denied');
    const renderer = renderScreen();
    await act(async () => {
      buttons(renderer, 'Turn on reminders')[0]!.props.onPress();
    });
    await flush();
    expect(buttons(renderer, 'Turn on reminders')).toHaveLength(0);
    expect(buttons(renderer, 'Open system settings')).toHaveLength(1);
    expect(allText(renderer)).not.toContain('Reminders weren’t turned on');
  });

  it('reports an unreadable permission as paused with a retry, never as scheduled', async () => {
    seedStore('unknown', { enabled: true });
    const renderer = renderScreen();
    const copy = allText(renderer);
    expect(copy).not.toContain('Scheduled from your real practice history');
    expect(copy).toContain(
      'Paused — notification permission couldn’t be checked',
    );
    expect(copy).toContain('Couldn’t check notification permission');
    expect(buttons(renderer, 'Check again')).toHaveLength(1);

    await act(async () => {
      buttons(renderer, 'Check again')[0]!.props.onPress();
    });
    await flush();
    expect(useNotificationStore.getState().permission).toBe('granted');
    expect(mockScheduler.applyPlan).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).toContain(
      'Scheduled from your real practice history',
    );
    expect(buttons(renderer, 'Check again')).toHaveLength(0);
  });

  it('shows the paused caption for an undetermined permission while enabled', () => {
    seedStore('undetermined', { enabled: true });
    const copy = allText(renderScreen());
    expect(copy).not.toContain('Scheduled from your real practice history');
    expect(copy).toContain('Paused until notifications are allowed');
  });

  it('tells the player when a change could not be saved, then clears on the next save', async () => {
    seedStore('granted', { enabled: true });
    mockKvWriteFails = true;
    const renderer = renderScreen();
    await act(async () => {
      switchFor(renderer, 'Practice nudge').props.onValueChange(false);
    });
    await flush();
    expect(allText(renderer)).toContain('couldn’t be saved on this phone');

    mockKvWriteFails = false;
    await act(async () => {
      switchFor(renderer, 'Weekly recap').props.onValueChange(false);
    });
    await flush();
    expect(allText(renderer)).not.toContain('couldn’t be saved on this phone');
  });

  it('tells the player when the schedule could not be applied', async () => {
    seedStore('granted', { enabled: true });
    mockScheduler.applyPlan.mockRejectedValue(new Error('notifee down'));
    const renderer = renderScreen();
    await act(async () => {
      switchFor(renderer, 'Streak defense').props.onValueChange(false);
    });
    await flush();
    expect(allText(renderer)).toContain('Reminders couldn’t be scheduled');
    expect(useNotificationStore.getState().prefs.streakDefense).toBe(false);

    mockScheduler.applyPlan.mockResolvedValue(undefined);
    await act(async () => {
      switchFor(renderer, 'Streak defense').props.onValueChange(true);
    });
    await flush();
    expect(allText(renderer)).not.toContain('Reminders couldn’t be scheduled');
  });

  it('handles a failed settings deep-link with copy instead of an unhandled rejection', async () => {
    seedStore('denied', { enabled: false });
    mockScheduler.openSystemSettings.mockRejectedValue(
      new Error('no settings url'),
    );
    const renderer = renderScreen();
    await act(async () => {
      buttons(renderer, 'Open system settings')[0]!.props.onPress();
    });
    await flush();
    expect(allText(renderer)).toContain('Couldn’t open Settings from here');
    expect(mockScheduler.openSystemSettings).toHaveBeenCalledTimes(1);
  });
});
