import React from 'react';
import { StyleSheet, Switch, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * Accessibility workflow audit — Settings → Notifications.
 *
 * Every control on the reminder screen is exercised the way VoiceOver would:
 * switches must carry a label + disabled state, presets must expose
 * `selected`, disabled presets/steppers must refuse activation, the denied
 * permission branch must offer a working recovery path, and the opt-in
 * button must be the only thing that requests OS permission.
 */

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});

const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack }),
  useFocusEffect: (effect: () => void) => {
    const React = jest.requireActual<typeof import('react')>('react');
    React.useEffect(() => {
      effect();
    }, [effect]);
  },
}));

const mockOpenSystemSettings = jest.fn(() => Promise.resolve());
jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => ({ openSystemSettings: mockOpenSystemSettings }),
}));

import { NotificationSettingsScreen } from '../../src/screens/NotificationSettingsScreen';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { DEFAULT_NOTIFICATION_PREFS } from '../../src/notifications/types';

const MIN_TARGET_PT = 44;

function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<NotificationSettingsScreen />);
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

function hostPressables(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' && typeof node.props.onClick === 'function',
  );
}

function byLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = hostPressables(renderer).filter(
    node => node.props.accessibilityLabel === label,
  );
  expect(matches.length).toBe(1);
  return matches[0]!;
}

function press(node: TestRenderer.ReactTestInstance) {
  node.props.onClick();
}

function minHeightOf(node: TestRenderer.ReactTestInstance): number {
  const flat = StyleSheet.flatten(node.props.style) ?? {};
  return Number(flat.minHeight ?? flat.height ?? 0);
}

describe('Notification settings — accessibility workflow', () => {
  const setPrefs = jest.fn(() => Promise.resolve());
  const refreshPermission = jest.fn(() => Promise.resolve());
  const requestPermissionAndEnable = jest.fn(() => Promise.resolve(true));

  beforeEach(() => {
    mockGoBack.mockClear();
    mockOpenSystemSettings.mockClear();
    setPrefs.mockClear();
    refreshPermission.mockClear();
    requestPermissionAndEnable.mockClear();
    act(() => {
      useNotificationStore.setState({
        hydrated: true,
        prefs: { ...DEFAULT_NOTIFICATION_PREFS, enabled: true },
        permission: 'granted',
        setPrefs,
        refreshPermission,
        requestPermissionAndEnable,
      });
    });
  });

  it('re-reads the OS permission on focus and the header Back goes back', () => {
    const renderer = renderScreen();
    expect(refreshPermission).toHaveBeenCalled();
    const back = byLabel(renderer, 'Back');
    expect(back.props.accessibilityRole).toBe('button');
    expect(back.props.hitSlop).toBeGreaterThanOrEqual(8);
    act(() => press(back));
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('every switch is labelled, mirrors disabled state, and patches one pref', () => {
    const renderer = renderScreen();
    const switches = renderer.root.findAllByType(Switch);
    expect(switches.map(s => s.props.accessibilityLabel)).toEqual([
      'All reminders',
      'Practice nudge',
      'Streak defense',
      'Weekly recap',
      'Welcome back',
    ]);
    for (const s of switches) {
      expect(s.props.accessibilityState).toEqual({ disabled: undefined });
      expect(s.props.disabled).toBeFalsy();
    }
    act(() => {
      switches[1]!.props.onValueChange(false);
    });
    expect(setPrefs).toHaveBeenLastCalledWith({ practiceReminder: false });
    act(() => {
      switches[0]!.props.onValueChange(false);
    });
    expect(setPrefs).toHaveBeenLastCalledWith({ enabled: false });
    act(() => renderer.unmount());
  });

  it('time presets expose selected state, a ≥44pt target, and patch the time', () => {
    const renderer = renderScreen();
    const presets = hostPressables(renderer).filter(node =>
      /^(Morning|Midday|Evening|Night), /.test(
        String(node.props.accessibilityLabel),
      ),
    );
    expect(presets.length).toBeGreaterThanOrEqual(3);
    // Default 5:30 PM is the Evening preset.
    const selected = presets.filter(
      p => p.props.accessibilityState?.selected === true,
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]!.props.accessibilityLabel).toBe('Evening, 5:30 PM');
    for (const p of presets) {
      expect(p.props.accessibilityRole).toBe('button');
      expect(p.props.accessibilityState?.disabled).toBeFalsy();
      expect(minHeightOf(p)).toBeGreaterThanOrEqual(MIN_TARGET_PT);
    }
    act(() => press(byLabel(renderer, 'Morning, 7:30 AM')));
    expect(setPrefs).toHaveBeenLastCalledWith({
      practiceReminderMinutes: 7 * 60 + 30,
    });
    act(() => renderer.unmount());
  });

  it('the ±30m steppers are labelled, ≥44pt, and wrap around midnight', () => {
    act(() => {
      useNotificationStore.setState({
        prefs: {
          ...DEFAULT_NOTIFICATION_PREFS,
          enabled: true,
          practiceReminderMinutes: 23 * 60 + 30,
        },
      });
    });
    const renderer = renderScreen();
    const later = byLabel(renderer, 'Reminder 30 minutes later');
    const earlier = byLabel(renderer, 'Reminder 30 minutes earlier');
    for (const n of [later, earlier]) {
      expect(n.props.accessibilityRole).toBe('button');
      expect(minHeightOf(n)).toBeGreaterThanOrEqual(MIN_TARGET_PT);
    }
    act(() => press(later));
    expect(setPrefs).toHaveBeenLastCalledWith({ practiceReminderMinutes: 0 });
    act(() => press(earlier));
    expect(setPrefs).toHaveBeenLastCalledWith({
      practiceReminderMinutes: 23 * 60,
    });
    act(() => renderer.unmount());
  });

  it('with the practice nudge off, presets and steppers are disabled and inert', () => {
    act(() => {
      useNotificationStore.setState({
        prefs: {
          ...DEFAULT_NOTIFICATION_PREFS,
          enabled: true,
          practiceReminder: false,
        },
      });
    });
    const renderer = renderScreen();
    const controls = [
      byLabel(renderer, 'Evening, 5:30 PM'),
      byLabel(renderer, 'Reminder 30 minutes earlier'),
      byLabel(renderer, 'Reminder 30 minutes later'),
    ];
    for (const c of controls) {
      expect(c.props.accessibilityState?.disabled).toBe(true);
      act(() => press(c));
    }
    expect(setPrefs).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('opt-in card: only "Turn on reminders" may request permission', () => {
    act(() => {
      useNotificationStore.setState({
        prefs: { ...DEFAULT_NOTIFICATION_PREFS, enabled: false },
      });
    });
    const renderer = renderScreen();
    expect(renderer.root.findAllByType(Switch)).toHaveLength(0);
    expect(allText(renderer)).toContain('Off by default.');
    const turnOn = byLabel(renderer, 'Turn on reminders');
    expect(turnOn.props.accessibilityRole).toBe('button');
    expect(minHeightOf(turnOn)).toBeGreaterThanOrEqual(MIN_TARGET_PT);
    act(() => press(turnOn));
    expect(requestPermissionAndEnable).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('denied permission: honest copy plus a working "Open system settings" path', () => {
    act(() => {
      useNotificationStore.setState({
        prefs: { ...DEFAULT_NOTIFICATION_PREFS, enabled: true },
        permission: 'denied',
      });
    });
    const renderer = renderScreen();
    const copy = allText(renderer);
    expect(copy).toContain('Notifications are off in system settings');
    expect(copy).toContain('Paused until notifications are allowed');
    const open = byLabel(renderer, 'Open system settings');
    expect(open.props.accessibilityRole).toBe('button');
    expect(minHeightOf(open)).toBeGreaterThanOrEqual(MIN_TARGET_PT);
    act(() => press(open));
    expect(mockOpenSystemSettings).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });
});
