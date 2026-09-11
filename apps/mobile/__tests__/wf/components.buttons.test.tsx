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
  Dimensions,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import {
  Button,
  Card,
  CheckpointRow,
  EmptyState,
  ErrorState,
  Page,
  Pill,
  PressableScale,
  ScoreRing,
  ScreenHeader,
  TrendChart,
} from '../../src/design/components';
import { color, font, radius, space, type } from '../../src/design/tokens';
import { Icon } from '../../src/design/icons';
import { MascotMoment, MascotStage } from '../../src/design/MascotMoment';

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
  it('wraps a title only when opted in, retaining its typography and back target', () => {
    const onBack = jest.fn();
    const renderer = render(
      <ScreenHeader title="Consistency" onBack={onBack} />,
    );
    let title = renderer.root.findByType(Text);
    expect(title.props.numberOfLines).toBe(1);
    expect(title.props.allowFontScaling).not.toBe(false);
    expect(StyleSheet.flatten(title.props.style)).toMatchObject(type.h3);

    act(() => {
      renderer.update(
        <ScreenHeader title="Consistency" onBack={onBack} wrapTitle />,
      );
    });
    title = renderer.root.findByType(Text);
    expect(title.props.numberOfLines).toBeUndefined();
    expect(title.props.allowFontScaling).not.toBe(false);
    expect(title.props.maxFontSizeMultiplier).toBeUndefined();
    expect(StyleSheet.flatten(title.props.style)).toMatchObject({
      ...type.h3,
      alignSelf: 'stretch',
      textAlign: 'center',
    });
    const back = onlyPressable(renderer);
    expect(flat(back)).toMatchObject({ width: 44, height: 44 });
    click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it.each([1, 1.353, 2, 3.571])(
    'uses the whole title row at accessibility scale %s without shrinking text',
    fontScale => {
      const originalWindow = Dimensions.get('window');
      const originalScreen = Dimensions.get('screen');
      let renderer: ReactTestRenderer | undefined;
      const onBack = jest.fn();
      try {
        act(() =>
          Dimensions.set({
            window: { ...originalWindow, width: 375, height: 667, fontScale },
            screen: { ...originalScreen, fontScale },
          }),
        );
        renderer = render(
          <ScreenHeader title="Consistency" onBack={onBack} wrapTitle />,
        );
        const root = renderer.root.findByType(ScreenHeader)
          .children[0] as ReactTestInstance;
        const title = renderer.root.findByType(Text);
        let heading = title.parent;
        while (heading && heading.type !== View) heading = heading.parent;
        expect(heading).not.toBeNull();
        if (fontScale >= 2) {
          expect(StyleSheet.flatten(root.props.style)).toMatchObject({
            flexDirection: 'column',
            alignItems: 'stretch',
          });
          expect(StyleSheet.flatten(heading!.props.style)).toMatchObject({
            flex: 0,
            width: '100%',
            minWidth: 0,
          });
        } else {
          expect(StyleSheet.flatten(root.props.style)).toMatchObject({
            flexDirection: 'row',
          });
          expect(StyleSheet.flatten(heading!.props.style)).toMatchObject({
            flex: 1,
          });
        }
        expect(StyleSheet.flatten(title.props.style)).toMatchObject(type.h3);
        expect(title.props.numberOfLines).toBeUndefined();
        expect(title.props.allowFontScaling).not.toBe(false);
        expect(title.props.maxFontSizeMultiplier).toBeUndefined();
        const back = onlyPressable(renderer);
        expect(flat(back)).toMatchObject({ width: 44, height: 44 });
        click(back);
        expect(onBack).toHaveBeenCalledTimes(1);
        act(() =>
          renderer!.update(
            <ScreenHeader title="Consistency" onBack={onBack} />,
          ),
        );
        expect(
          StyleSheet.flatten(
            (
              renderer.root.findByType(ScreenHeader)
                .children[0] as ReactTestInstance
            ).props.style,
          ).flexDirection,
        ).toBe('row');
      } finally {
        act(() => {
          renderer?.unmount();
          Dimensions.set({ window: originalWindow, screen: originalScreen });
        });
      }
    },
  );

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

  it.each([0.82, 1])(
    'preserves exact default button geometry at font scale %s',
    fontScale => {
      jest
        .spyOn(Dimensions, 'get')
        .mockReturnValue({ width: 393, height: 852, scale: 3, fontScale });
      const renderer = render(
        <Button
          label="Re-analyze this stroke"
          icon="camera"
          variant="volt"
          onPress={jest.fn()}
        />,
      );
      const host = onlyPressable(renderer);
      const label = renderer.root.findByType(Text);
      const row = label.parent!;
      expect(flat(host)).toMatchObject({
        minHeight: 56,
        borderRadius: radius.pill,
        borderWidth: 1,
        overflow: 'hidden',
      });
      expect(flat(row)).toMatchObject({
        minHeight: 54,
        paddingHorizontal: space.lg,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: space.sm,
      });
      expect(flat(row).paddingVertical).toBe(space.sm);
      expect(StyleSheet.flatten(label.props.style)).toMatchObject({
        fontSize: type.bodyBold.fontSize,
        lineHeight: type.bodyBold.lineHeight,
      });
      expect(StyleSheet.flatten(label.props.style).flexShrink).toBe(1);
      expect(StyleSheet.flatten(label.props.style).textAlign).toBe('center');
      act(() => renderer.unmount());
    },
  );

  it.each([1.35, 2.64, 3.12, 3.571])(
    'fits full labels beside icons at font scale %s without font caps or new press behavior',
    fontScale => {
      jest
        .spyOn(Dimensions, 'get')
        .mockReturnValue({ width: 393, height: 852, scale: 3, fontScale });
      for (const variant of variants) {
        for (const compact of [false, true]) {
          const onPress = jest.fn();
          const renderer = render(
            <Button
              label="Re-analyze this stroke"
              icon="camera"
              variant={variant}
              compact={compact}
              onPress={onPress}
            />,
          );
          const host = onlyPressable(renderer);
          const label = renderer.root.findByType(Text);
          const row = label.parent!;
          expect(flat(host)).toMatchObject({
            minHeight: compact ? 46 : 56,
            borderRadius: radius.lg,
            borderWidth: 1,
            overflow: 'hidden',
          });
          expect(flat(row)).toMatchObject({
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
            gap: space.sm,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
          });
          expect(StyleSheet.flatten(label.props.style)).toMatchObject({
            flexShrink: 1,
            textAlign: 'center',
            fontSize: type.bodyBold.fontSize,
            lineHeight: type.bodyBold.lineHeight,
          });
          expect(label.props.maxFontSizeMultiplier).toBeUndefined();
          expect(label.props.allowFontScaling).not.toBe(false);
          expect(label.props.numberOfLines).toBeUndefined();
          expect(host.props.accessibilityLabel).toBe('Re-analyze this stroke');
          expect(texts(renderer)).toEqual(['Re-analyze this stroke']);
          expect(
            renderer.root.findAllByType(Icon).map(icon => icon.props.name),
          ).toEqual(
            variant === 'primary' || variant === 'volt' || variant === 'dark'
              ? ['camera', 'arrow']
              : ['camera'],
          );
          expect(meetsHitTarget(host)).toBe(true);
          expect(onPress).not.toHaveBeenCalled();
          click(host);
          expect(onPress).toHaveBeenCalledTimes(1);
          act(() =>
            renderer.update(
              <Button
                label="Re-analyze this stroke"
                icon="camera"
                variant={variant}
                compact={compact}
                onPress={onPress}
                disabled
              />,
            ),
          );
          click(onlyPressable(renderer));
          expect(onPress).toHaveBeenCalledTimes(1);
          act(() => renderer.unmount());
        }
      }
    },
  );

  it.each([1, 1.3, 1.35, 3.571])(
    'uses an opted-in large-text label without changing the accessibility name or press guards at %sx',
    fontScale => {
      jest
        .spyOn(Dimensions, 'get')
        .mockReturnValue({ width: 375, height: 667, scale: 2, fontScale });
      const onPress = jest.fn();
      const button = (disabled = false) => (
        <Button
          label="Open automatic camera"
          largeTextLabel="Open camera"
          icon="camera"
          variant="volt"
          onPress={onPress}
          disabled={disabled}
          testID="adaptive-camera"
        />
      );
      const renderer = render(button());
      const adapted = fontScale > 1.3;
      expect(texts(renderer)).toEqual([
        adapted ? 'Open camera' : 'Open automatic camera',
      ]);
      expect(
        renderer.root.findAllByType(Icon).map(icon => icon.props.name),
      ).toEqual(adapted ? [] : ['camera', 'arrow']);
      const label = renderer.root.findByType(Text);
      expect(label.props.maxFontSizeMultiplier).toBeUndefined();
      expect(label.props.numberOfLines).toBeUndefined();
      expect(label.props.adjustsFontSizeToFit).not.toBe(true);
      expect(label.props.allowFontScaling).not.toBe(false);
      expect(StyleSheet.flatten(label.props.style)).toMatchObject({
        fontSize: type.bodyBold.fontSize,
        lineHeight: type.bodyBold.lineHeight,
      });
      const host = onlyPressable(renderer);
      expect(host.props.accessibilityLabel).toBe('Open automatic camera');
      expect(host.props.testID).toBe('adaptive-camera');
      click(host);
      expect(onPress).toHaveBeenCalledTimes(1);
      act(() => renderer.update(button(true)));
      const disabled = onlyPressable(renderer);
      expect(disabled.props.accessibilityState.disabled).toBe(true);
      click(disabled);
      expect(onPress).toHaveBeenCalledTimes(1);
      act(() => renderer.unmount());
    },
  );

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
    expect(host.props.accessibilityState?.disabled).not.toBe(true);
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
    // Without onPress these are static, labelled text rows (not controls).
    expect(pressableHosts(renderer)).toHaveLength(0);
    const rows = renderer.root.findAll(
      n => typeof n.type === 'string' && n.props.accessibilityRole === 'text',
    );
    expect(rows.map(h => h.props.accessibilityLabel)).toEqual([
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
    expect(pressableHosts(renderer)).toHaveLength(0);
    const [host] = renderer.root.findAll(
      n => typeof n.type === 'string' && n.props.accessibilityRole === 'text',
    );
    if (!host) throw new Error('No static row rendered');
    expect(host.props.accessible).toBe(true);
    expect(host.props.accessibilityLabel).toBe('Contact point, 55 out of 100');
    expect(host.props.onClick).toBeUndefined();
    expect(host.props.onStartShouldSetResponder).toBeUndefined();
    expect(host.props.accessibilityState).toBeUndefined();
    expect(flat(host).opacity ?? 1).toBe(1);
    expect(texts(renderer)).toEqual(['Contact point', '55']);
    act(() => renderer.unmount());
  });
});

describe('ErrorState "Try again" -> props.onRetry', () => {
  it('scrolls oversized recovery copy while keeping Retry outside the scrolling viewport', () => {
    jest
      .spyOn(Dimensions, 'get')
      .mockReturnValue({ width: 375, height: 667, scale: 2, fontScale: 3.571 });
    const renderer = render(
      <ErrorState
        title="The library could not be loaded"
        detail="Your saved drills remain available. Check your connection and try again."
        onRetry={jest.fn()}
      />,
    );
    const scroll = renderer.root.findByType(ScrollView);
    expect(scroll.props.scrollEnabled).toBe(true);
    const retry = onlyPressable(renderer);
    let ancestor = retry.parent;
    while (ancestor) {
      expect(ancestor.type).not.toBe(ScrollView);
      ancestor = ancestor.parent;
    }
    expect(meetsHitTarget(retry)).toBe(true);
    act(() => renderer.unmount());
  });

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

describe('Restrained visual primitives', () => {
  it('requests the registered iOS PostScript faces rather than asset filenames', () => {
    expect(font).toEqual({
      regular: 'Manrope-Regular',
      medium: 'Manrope-Medium',
      semibold: 'Manrope-SemiBold',
      bold: 'Manrope-Bold',
    });
    expect(type.hero.fontWeight).toBe('600');
    expect(type.body.fontWeight).toBe('400');
    expect(type.caption.fontWeight).toBe('500');
  });

  it('uses the shared card-score and display roles', () => {
    expect(type.score).toMatchObject({ fontSize: 30, lineHeight: 34 });
    expect(type.display).toMatchObject({ fontSize: 64, lineHeight: 66 });
  });

  it.each(['light', 'dark', 'court', 'soft'] as const)(
    '%s cards separate content without decorative elevation',
    tone => {
      const renderer = render(
        <Card tone={tone} testID="flat-card">
          <Text>Technique evidence</Text>
        </Card>,
      );
      const host = renderer.root.find(
        node =>
          typeof node.type === 'string' && node.props.testID === 'flat-card',
      );
      expect(flat(host).borderWidth).toBe(StyleSheet.hairlineWidth);
      expect(flat(host).shadowOpacity ?? 0).toBe(0);
      expect(flat(host).elevation ?? 0).toBe(0);
      expect(flat(host).borderRadius).toBe(radius.lg);
      act(() => renderer.unmount());
    },
  );

  it('keeps warning labels readable without removing their semantic treatment', () => {
    const renderer = render(<Pill label="Not read" tone="warn" />);
    expect(
      StyleSheet.flatten(renderer.root.findByType(Text).props.style).color,
    ).toBe(color.ink);
    act(() => renderer.unmount());
    const checkpoint = render(
      <CheckpointRow name="Preparation" score={70} band="yellow" />,
    );
    const value = checkpoint.root
      .findAllByType(Text)
      .find(node => node.props.children === 70);
    expect(StyleSheet.flatten(value!.props.style).color).toBe(color.ink);
    expect(
      checkpoint.root.findAll(
        node =>
          StyleSheet.flatten(node.props.style)?.backgroundColor === color.warn,
      ).length,
    ).toBeGreaterThan(0);
    act(() => checkpoint.unmount());
  });

  it('uses a solid score arc while presenting the estimated DUPR over the /10 reading', () => {
    const renderer = render(<ScoreRing score={7.1} dark />);
    expect(
      renderer.root.findAll(node => node.props.id === 'scoreGradient'),
    ).toHaveLength(0);
    expect(
      renderer.root.findAll(node => node.props.stroke === color.volt).length,
    ).toBeGreaterThan(0);
    // D-046: VoiceOver hears both figures and which is which; the caption
    // names the unit and the smaller line keeps the 0–10 score.
    expect(
      renderer.root.findAll(
        node =>
          node.props.accessibilityLabel ===
          'Estimated DUPR 3.40, technique score 7.1 out of 10',
      ).length,
    ).toBeGreaterThan(0);
    const texts = renderer.root
      .findAllByType(Text)
      .map(node => node.props.children);
    expect(texts).toContain('EST. DUPR');
    expect(texts).toContain('7.1 /10');
    act(() => renderer.unmount());
  });

  it('draws the exact trend without a gradient area wash', () => {
    const renderer = render(
      <TrendChart points={[2, 5, 8]} width={100} height={48} dark />,
    );
    expect(
      renderer.root.findAll(node => node.props.id === 'trendFill'),
    ).toHaveLength(0);
    const line = renderer.root.find(
      node => node.props.points === '0,36 50,24 100,12',
    );
    expect(line.props.stroke).toBe(color.volt);
    expect(line.props.fill).toBe('none');
    act(() => renderer.unmount());
  });

  it('keeps contextual guidance text-only unless artwork has an explicit placement', () => {
    const renderer = render(
      <MascotMoment
        pose="question"
        eyebrow="CAPTURE IN HAND"
        caption="Review your saved capture."
        accessibilityLabel="Legacy illustration description"
      />,
    );
    expect(renderer.root.findAllByType(Image).length).toBe(0);
    expect(texts(renderer)).toEqual([
      'CAPTURE IN HAND',
      'Review your saved capture.',
    ]);
    expect(
      renderer.root.findAll(
        node =>
          typeof node.type === 'string' &&
          node.props.accessibilityRole === 'image',
      ).length,
    ).toBe(0);
    act(() => renderer.unmount());
  });

  it('uses a compact functional mark instead of a mascot in recovery states', () => {
    const renderer = render(<MascotStage pose="reach" compact icon="lock" />);
    expect(renderer.root.findAllByType(Image).length).toBe(0);
    expect(renderer.root.findByType(Icon).props.name).toBe('lock');
    act(() => renderer.unmount());
  });

  it('uses court geometry rather than an AI sparkle for an empty training state', () => {
    const renderer = render(
      <EmptyState
        title="Your court is ready"
        body="Record your first stroke."
      />,
    );
    expect(renderer.root.findByType(Icon).props.name).toBe('court');
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
