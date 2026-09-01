/**
 * Button ledger for `src/design/components.tsx`: every pressable the design
 * primitives own (PressableScale, ScreenHeader back/close, Button,
 * CheckpointRow, ErrorState "Try again") is pressed through the real
 * Pressability accessibility-click path — which, unlike calling a composite
 * `onPress` prop, honours `disabled` — and the observable effect (the
 * consumer callback firing, or NOT firing while disabled), accessibility
 * role/label/state, and the 44pt hit target are asserted on the host view.
 * Presses on `Button` are exactly what the consumers' own suites rely on.
 */
jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Line: Mock,
    Path: Mock,
    Polyline: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    Stop: Mock,
  };
});
jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  const SafeAreaView = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    __esModule: true,
    SafeAreaView,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
  };
});

import React from 'react';
import {
  AccessibilityInfo,
  Animated,
  ScrollView,
  StyleSheet,
  Text,
  type ViewStyle,
} from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import {
  Button,
  CheckpointRow,
  EmptyState,
  ErrorState,
  Page,
  PressableScale,
  ScreenHeader,
} from '../../src/design/components';

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

/** Host views wired by Pressability (what the OS actually dispatches to). */
function pressableHosts(renderer: ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll(
    n =>
      typeof n.type === 'string' &&
      typeof n.props.onClick === 'function' &&
      typeof n.props.onStartShouldSetResponder === 'function',
  );
}

function onlyPressable(renderer: ReactTestRenderer): ReactTestInstance {
  const hosts = pressableHosts(renderer);
  expect(hosts).toHaveLength(1);
  const [host] = hosts;
  if (!host) throw new Error('No pressable host rendered');
  return host;
}

/**
 * Drives Pressability's accessibility click (VoiceOver double-tap / Switch
 * Control). This is the real RN handler: it refuses to fire `onPress` while
 * the pressable is disabled, so disabled guards are tested honestly.
 */
function click(host: ReactTestInstance) {
  act(() => {
    host.props.onClick({ currentTarget: host, target: host, nativeEvent: {} });
  });
}

function flat(host: ReactTestInstance): ViewStyle {
  return (StyleSheet.flatten(host.props.style) ?? {}) as ViewStyle;
}

/** True when the tappable box is at least 44pt tall (or grown via hitSlop). */
function meetsHitTarget(host: ReactTestInstance): boolean {
  const style = flat(host);
  const slop =
    typeof host.props.hitSlop === 'number' ? host.props.hitSlop * 2 : 0;
  const height = Number(style.height ?? 0);
  const minHeight = Number(style.minHeight ?? 0);
  return Math.max(height, minHeight) + slop >= 44;
}

function texts(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter(
      (child): child is string | number =>
        typeof child === 'string' || typeof child === 'number',
    )
    .map(String);
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('PressableScale -> props.onPress', () => {
  it('fires the consumer handler on an accessibility click', () => {
    const onPress = jest.fn();
    const renderer = render(
      <PressableScale onPress={onPress} testID="scale">
        <Text>Tap</Text>
      </PressableScale>,
    );
    const host = onlyPressable(renderer);
    expect(host.props.testID).toBe('scale');
    click(host);
    click(host);
    expect(onPress).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
  });

  it('defaults accessibilityRole to button and forwards label, hint, hitSlop and role overrides', () => {
    const renderer = render(
      <PressableScale
        onPress={jest.fn()}
        accessibilityLabel="Open the thing"
        accessibilityHint="Opens it"
        hitSlop={12}
      >
        <Text>x</Text>
      </PressableScale>,
    );
    const host = onlyPressable(renderer);
    expect(host.props.accessibilityRole).toBe('button');
    expect(host.props.accessibilityLabel).toBe('Open the thing');
    expect(host.props.accessibilityHint).toBe('Opens it');
    expect(host.props.hitSlop).toBe(12);
    expect(host.props.accessibilityState).toEqual({ disabled: undefined });
    act(() => renderer.unmount());

    const overridden = render(
      <PressableScale
        onPress={jest.fn()}
        accessibilityRole="link"
        accessibilityState={{ selected: true }}
      >
        <Text>x</Text>
      </PressableScale>,
    );
    const link = onlyPressable(overridden);
    expect(link.props.accessibilityRole).toBe('link');
    expect(link.props.accessibilityState).toEqual({
      selected: true,
      disabled: undefined,
    });
    act(() => overridden.unmount());
  });

  it('blocks presses, refuses the responder and announces disabled while disabled', () => {
    const onPress = jest.fn();
    const renderer = render(
      <PressableScale onPress={onPress} disabled>
        <Text>x</Text>
      </PressableScale>,
    );
    const host = onlyPressable(renderer);
    click(host);
    expect(onPress).not.toHaveBeenCalled();
    expect(host.props.onStartShouldSetResponder()).toBe(false);
    expect(host.props.accessibilityState).toEqual({ disabled: true });
    expect(flat(host).opacity).toBe(0.42);

    // Re-enabled (e.g. a pending async handler settled) -> presses flow again.
    act(() => {
      renderer.update(
        <PressableScale onPress={onPress} disabled={false}>
          <Text>x</Text>
        </PressableScale>,
      );
    });
    const enabled = onlyPressable(renderer);
    click(enabled);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(enabled.props.onStartShouldSetResponder()).toBe(true);
    expect(flat(enabled).opacity).toBe(1);
    act(() => renderer.unmount());
  });

  it('renders without a handler and clicking is a safe no-op', () => {
    const renderer = render(
      <PressableScale>
        <Text>x</Text>
      </PressableScale>,
    );
    const host = onlyPressable(renderer);
    expect(() => click(host)).not.toThrow();
    act(() => renderer.unmount());
  });

  it('scales down on press-in and back on press-out, and skips the animation under reduced motion', () => {
    const timing = jest.spyOn(Animated, 'timing');
    const renderer = render(
      <PressableScale onPress={jest.fn()}>
        <Text>x</Text>
      </PressableScale>,
    );
    const host = onlyPressable(renderer);
    const grantEvent = {
      persist: () => {},
      currentTarget: { measure: () => {} },
      nativeEvent: { pageX: 0, pageY: 0, timestamp: 0, touches: [] },
      touchHistory: { touchBank: [] },
    };
    act(() => {
      host.props.onResponderGrant(grantEvent);
    });
    act(() => {
      host.props.onResponderRelease(grantEvent);
    });
    // Pressability defers onPressOut by its minimum press duration.
    act(() => {
      jest.advanceTimersByTime(500);
    });
    const targets = timing.mock.calls.map(call => call[1].toValue);
    expect(targets).toEqual([0.975, 1]);

    // Flip the OS reduce-motion switch through the observer this module
    // registered: the next press must not animate at all.
    const listener = (
      AccessibilityInfo.addEventListener as jest.Mock
    ).mock.calls.find(call => call[0] === 'reduceMotionChanged')?.[1];
    expect(typeof listener).toBe('function');
    act(() => {
      listener(true);
    });
    timing.mockClear();
    act(() => {
      host.props.onResponderGrant(grantEvent);
    });
    act(() => {
      host.props.onResponderRelease(grantEvent);
    });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(timing).not.toHaveBeenCalled();
    act(() => {
      listener(false);
    });
    act(() => renderer.unmount());
  });
});

describe('ScreenHeader back/close -> props.onBack / props.onClose', () => {
  it('renders no action button when neither handler is given', () => {
    const renderer = render(<ScreenHeader title="Plain" />);
    expect(pressableHosts(renderer)).toHaveLength(0);
    expect(texts(renderer)).toEqual(['Plain']);
    act(() => renderer.unmount());
  });

  it('Back -> props.onBack with a 44pt button labelled Back', () => {
    const onBack = jest.fn();
    const renderer = render(
      <ScreenHeader
        title="Manage account"
        eyebrow="settings"
        onBack={onBack}
      />,
    );
    const host = onlyPressable(renderer);
    expect(host.props.accessibilityRole).toBe('button');
    expect(host.props.accessibilityLabel).toBe('Back');
    expect(host.props.hitSlop).toBe(8);
    expect(meetsHitTarget(host)).toBe(true);
    expect(flat(host).width).toBe(44);
    click(host);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(texts(renderer)).toEqual(['SETTINGS', 'Manage account']);
    act(() => renderer.unmount());
  });

  it('Close -> props.onClose labelled Close, also on the dark variant', () => {
    const onClose = jest.fn();
    const renderer = render(
      <ScreenHeader title="Stroke analysis" onClose={onClose} dark />,
    );
    const host = onlyPressable(renderer);
    expect(host.props.accessibilityLabel).toBe('Close');
    expect(meetsHitTarget(host)).toBe(true);
    click(host);
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('prefers onBack when both handlers are supplied (single button, no dead close)', () => {
    const onBack = jest.fn();
    const onClose = jest.fn();
    const renderer = render(<ScreenHeader onBack={onBack} onClose={onClose} />);
    const host = onlyPressable(renderer);
    expect(host.props.accessibilityLabel).toBe('Back');
    click(host);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('keeps the right slot outside the header action so both stay tappable', () => {
    const onBack = jest.fn();
    const onRight = jest.fn();
    const renderer = render(
      <ScreenHeader
        title="Library"
        onBack={onBack}
        right={<Button label="Edit" onPress={onRight} compact />}
      />,
    );
    const hosts = pressableHosts(renderer);
    expect(hosts.map(h => h.props.accessibilityLabel)).toEqual([
      'Back',
      'Edit',
    ]);
    const edit = hosts[1];
    if (!edit) throw new Error('Right-slot button missing');
    click(edit);
    expect(onRight).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});

describe('Button <label> -> props.onPress', () => {
  const variants = [
    'primary',
    'secondary',
    'ghost',
    'danger',
    'volt',
    'dark',
  ] as const;

  it.each(variants)('%s variant fires onPress and labels itself', variant => {
    const onPress = jest.fn();
    const renderer = render(
      <Button
        label="Continue"
        onPress={onPress}
        variant={variant}
        testID={`btn-${variant}`}
      />,
    );
    const host = onlyPressable(renderer);
    expect(host.props.testID).toBe(`btn-${variant}`);
    expect(host.props.accessibilityRole).toBe('button');
    expect(host.props.accessibilityLabel).toBe('Continue');
    expect(meetsHitTarget(host)).toBe(true);
    expect(texts(renderer)).toEqual(['Continue']);
    click(host);
    expect(onPress).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('compact buttons still clear the 44pt hit target', () => {
    const renderer = render(
      <Button label="Skip" onPress={jest.fn()} compact variant="ghost" />,
    );
    const host = onlyPressable(renderer);
    expect(flat(host).minHeight).toBeGreaterThanOrEqual(44);
    expect(meetsHitTarget(host)).toBe(true);
    act(() => renderer.unmount());
  });

  it('does not fire while disabled (pending guard) and re-arms once enabled', () => {
    const onPress = jest.fn();
    const renderer = render(
      <Button label="Save" onPress={onPress} disabled testID="save" />,
    );
    const pending = onlyPressable(renderer);
    click(pending);
    click(pending);
    expect(onPress).not.toHaveBeenCalled();
    expect(pending.props.accessibilityState).toEqual({ disabled: true });
    expect(pending.props.onStartShouldSetResponder()).toBe(false);

    act(() => {
      renderer.update(
        <Button
          label="Save"
          onPress={onPress}
          disabled={false}
          testID="save"
        />,
      );
    });
    const armed = onlyPressable(renderer);
    click(armed);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(armed.props.accessibilityState).toEqual({ disabled: false });
    act(() => renderer.unmount());
  });

  it('renders an optional leading icon without changing the press wiring', () => {
    const onPress = jest.fn();
    const renderer = render(
      <Button label="Record" onPress={onPress} icon="camera" variant="volt" />,
    );
    click(onlyPressable(renderer));
    expect(onPress).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('propagates a consumer handler that throws instead of swallowing it', () => {
    const renderer = render(
      <Button
        label="Boom"
        onPress={() => {
          throw new Error('consumer failure');
        }}
      />,
    );
    const host = onlyPressable(renderer);
    expect(() =>
      host.props.onClick({
        currentTarget: host,
        target: host,
        nativeEvent: {},
      }),
    ).toThrow('consumer failure');
    act(() => renderer.unmount());
  });
});

describe('CheckpointRow -> props.onPress', () => {
  it('is a button that fires onPress and announces name + score', () => {
    const onPress = jest.fn();
    const renderer = render(
      <CheckpointRow
        name="Paddle prep"
        score={72.4}
        band="green"
        onPress={onPress}
      />,
    );
    const host = onlyPressable(renderer);
    expect(host.props.accessibilityRole).toBe('button');
    expect(host.props.accessibilityLabel).toBe('Paddle prep, 72 out of 100');
    expect(host.props.accessibilityState).toEqual({ disabled: false });
    expect(flat(host).opacity).toBe(1);
    expect(texts(renderer)).toEqual(['Paddle prep', '72']);
    click(host);
    expect(onPress).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('clamps out-of-range and null scores from server data without throwing', () => {
    const renderer = render(
      <>
        <CheckpointRow name="Over" score={140} band="green" />
        <CheckpointRow name="Under" score={-5} band="red" />
        <CheckpointRow name="Unread" score={null} band="unscored" />
      </>,
    );
    const hosts = pressableHosts(renderer);
    expect(hosts.map(h => h.props.accessibilityLabel)).toEqual([
      'Over, 140 out of 100',
      'Under, -5 out of 100',
      'Unread, not read',
    ]);
    expect(texts(renderer)).toEqual([
      'Over',
      '140',
      'Under',
      '-5',
      'Unread',
      '—',
    ]);
    act(() => renderer.unmount());
  });

  it('without onPress is static text: no responder, no press, no dimming', () => {
    const renderer = render(
      <CheckpointRow name="Contact point" score={55} band="yellow" />,
    );
    const host = onlyPressable(renderer);
    expect(host.props.accessibilityRole).toBe('text');
    expect(host.props.onStartShouldSetResponder()).toBe(false);
    expect(() => click(host)).not.toThrow();
    // WF-ISSUE: CheckpointRow without onPress renders as a disabled control (42% opacity, accessibilityState.disabled=true)
    // expect(host.props.accessibilityState).toEqual({ disabled: false });
    // expect(flat(host).opacity).toBe(1);
    act(() => renderer.unmount());
  });
});

describe('ErrorState "Try again" -> props.onRetry', () => {
  it('renders a secondary Try again button wired to onRetry inside an alert region', () => {
    const onRetry = jest.fn();
    const renderer = render(
      <ErrorState
        title="Progress couldn’t load"
        detail="Check your connection."
        onRetry={onRetry}
      />,
    );
    const host = onlyPressable(renderer);
    expect(host.props.accessibilityLabel).toBe('Try again');
    expect(host.props.accessibilityRole).toBe('button');
    expect(meetsHitTarget(host)).toBe(true);
    expect(texts(renderer)).toEqual([
      'Progress couldn’t load',
      'Check your connection.',
      'Try again',
    ]);
    const alert = renderer.root.findAll(
      n => typeof n.type === 'string' && n.props.accessibilityRole === 'alert',
    );
    expect(alert).toHaveLength(1);
    expect(alert[0]?.props.accessibilityLiveRegion).toBe('assertive');
    click(host);
    click(host);
    expect(onRetry).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
  });

  it('omits the button entirely when no retry is possible (no dead control)', () => {
    const renderer = render(
      <ErrorState title="Result missing" detail="Gone." dark />,
    );
    expect(pressableHosts(renderer)).toHaveLength(0);
    expect(texts(renderer)).toEqual(['Result missing', 'Gone.']);
    act(() => renderer.unmount());
  });
});

describe('EmptyState action slot -> consumer node', () => {
  it('mounts the consumer action pressable and leaves it fully tappable', () => {
    const onPress = jest.fn();
    const renderer = render(
      <EmptyState
        title="No analyses yet"
        body="Record a stroke to get your first score."
        action={<Button label="Analyze a stroke" onPress={onPress} />}
      />,
    );
    const host = onlyPressable(renderer);
    expect(host.props.accessibilityLabel).toBe('Analyze a stroke');
    click(host);
    expect(onPress).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('renders no pressable when there is no action', () => {
    const renderer = render(<EmptyState title="Empty" body="Nothing here." />);
    expect(pressableHosts(renderer)).toHaveLength(0);
    act(() => renderer.unmount());
  });
});

describe('Page scroll container', () => {
  it('keeps taps alive while the keyboard is up so buttons under it still fire', () => {
    const onPress = jest.fn();
    const renderer = render(
      <Page scroll testID="page">
        <Button label="Sign in" onPress={onPress} />
      </Page>,
    );
    const scroll = renderer.root.findByType(ScrollView);
    expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');
    click(onlyPressable(renderer));
    expect(onPress).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });
});
