import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { PressableScale } from '../../src/design/components';
import TestRenderer, { act } from 'react-test-renderer';
import type { PermissionState } from '../../src/notifications/service';
import { DEFAULT_NOTIFICATION_PREFS } from '../../src/notifications/types';

type MockState = {
  hydrated: boolean;
  prefs: typeof DEFAULT_NOTIFICATION_PREFS;
  permission: PermissionState | 'unknown';
  requestPermissionAndEnable: () => Promise<boolean>;
  dismissPrompt: () => Promise<void>;
};

const mockRequest = jest.fn<Promise<boolean>, []>();
const mockDismiss = jest.fn<Promise<void>, []>(() => Promise.resolve());
const mockState: MockState = {
  hydrated: true,
  prefs: { ...DEFAULT_NOTIFICATION_PREFS },
  permission: 'undetermined',
  requestPermissionAndEnable: () => mockRequest(),
  dismissPrompt: () => mockDismiss(),
};

jest.mock('../../src/notifications/notificationStore', () => ({
  useNotificationStore: (selector: (s: MockState) => unknown) =>
    selector(mockState),
}));

import { NotificationPrimingCard } from '../../src/notifications/NotificationPrimingCard';

/**
 * Home priming card honesty: a failed or unresolved permission request must
 * leave visible feedback (never a silent no-op), the request cannot be
 * double-fired while in flight, and both actions meet the 44pt target.
 */

function render() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<NotificationPrimingCard />);
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

function pressable(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = renderer.root
    .findAllByType(PressableScale)
    .filter(node => node.props.accessibilityLabel === label);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function hostPressable(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const matches = renderer.root.findAll(
    node =>
      typeof node.type === 'string' && node.props.accessibilityLabel === label,
  );
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

function flushPromises() {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  mockRequest.mockReset();
  mockDismiss.mockClear();
  mockState.hydrated = true;
  mockState.prefs = { ...DEFAULT_NOTIFICATION_PREFS };
  mockState.permission = 'undetermined';
});

describe('NotificationPrimingCard (wf fix-15)', () => {
  it('renders both actions at least 44pt tall', () => {
    const renderer = render();
    for (const label of ['Turn on practice reminders', 'Not now']) {
      const node = pressable(renderer, label);
      const style = StyleSheet.flatten(node.props.style) as {
        minHeight?: number;
      };
      expect(style.minHeight).toBeGreaterThanOrEqual(44);
    }
  });

  it('shows an inline failure caption when the request resolves false without denial', async () => {
    mockRequest.mockResolvedValue(false);
    const renderer = render();
    expect(
      renderer.root.findAllByProps({ testID: 'notification-priming-failure' }),
    ).toHaveLength(0);

    await act(async () => {
      pressable(renderer, 'Turn on practice reminders').props.onPress();
    });
    await flushPromises();

    expect(mockRequest).toHaveBeenCalledTimes(1);
    const text = allText(renderer);
    expect(text).toContain('Reminders couldn’t be turned on');
    expect(text).toContain('Try again');
    expect(
      pressable(renderer, 'Turn on practice reminders').props.disabled,
    ).toBe(false);
  });

  it('disables both actions while the request is in flight and ignores repeat taps', async () => {
    let resolve!: (value: boolean) => void;
    mockRequest.mockImplementation(
      () =>
        new Promise<boolean>(r => {
          resolve = r;
        }),
    );
    const renderer = render();

    act(() => {
      pressable(renderer, 'Turn on practice reminders').props.onPress();
    });
    expect(allText(renderer)).toContain('Asking…');
    expect(
      pressable(renderer, 'Turn on practice reminders').props.disabled,
    ).toBe(true);
    expect(pressable(renderer, 'Not now').props.disabled).toBe(true);
    expect(
      hostPressable(renderer, 'Turn on practice reminders').props
        .accessibilityState,
    ).toMatchObject({ busy: true, disabled: true });

    act(() => {
      pressable(renderer, 'Turn on practice reminders').props.onPress();
    });
    expect(mockRequest).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve(false);
    });
    await flushPromises();
    expect(allText(renderer)).toContain('Reminders couldn’t be turned on');
    expect(pressable(renderer, 'Not now').props.disabled).toBe(false);
  });

  it('clears the failure caption on a later successful request', async () => {
    mockRequest.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const renderer = render();

    await act(async () => {
      pressable(renderer, 'Turn on practice reminders').props.onPress();
    });
    await flushPromises();
    expect(allText(renderer)).toContain('Reminders couldn’t be turned on');

    await act(async () => {
      pressable(renderer, 'Turn on practice reminders').props.onPress();
    });
    await flushPromises();
    expect(allText(renderer)).not.toContain('Reminders couldn’t be turned on');
    expect(allText(renderer)).toContain('Turn on');
  });

  it('stays hidden once the permission is denied and delegates Not now to the store', async () => {
    const renderer = render();
    await act(async () => {
      pressable(renderer, 'Not now').props.onPress();
    });
    expect(mockDismiss).toHaveBeenCalledTimes(1);

    mockState.permission = 'denied';
    act(() => {
      renderer.update(<NotificationPrimingCard />);
    });
    expect(renderer.root.findAllByType(PressableScale)).toHaveLength(0);
  });
});
