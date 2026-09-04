/**
 * AUDIT — design primitives without direct coverage (components.tsx):
 * BrandToggle role/state/target, BrandDialog keys + close target + backdrop,
 * ScoreRing clamping, TrendChart geometry for degenerate input, and the
 * Pill/Stat/SectionTitle text roles. Tests prefixed PROBE encode the
 * expected contract and are allowed to fail on the audited revision; tests
 * prefixed VERIFIED pin behaviour that holds.
 */
import React from 'react';
import {
  AccessibilityInfo,
  Modal,
  StyleSheet,
  Text,
  type ViewStyle,
} from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

jest.mock('react-native-svg', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const make = (name: string) => {
    const Mock = (props: { children?: React.ReactNode }) =>
      ReactModule.createElement(View, { ...props, svgKind: name });
    Mock.displayName = name;
    return Mock;
  };
  return {
    __esModule: true,
    default: make('Svg'),
    Svg: make('Svg'),
    Circle: make('Circle'),
    Line: make('Line'),
    Path: make('Path'),
    Polyline: make('Polyline'),
    Rect: make('Rect'),
    Defs: make('Defs'),
    LinearGradient: make('LinearGradient'),
    Stop: make('Stop'),
  };
});
jest.mock('react-native-safe-area-context', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const SafeAreaView = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, props.children);
  return {
    __esModule: true,
    SafeAreaView,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
  };
});

import {
  BrandDialog,
  BrandToggle,
  Pill,
  ScoreRing,
  SectionTitle,
  Stat,
  TrendChart,
} from '../../src/design/components';
import { useReliableSafeAreaInsets } from '../../src/design/safeArea';

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

function flat(node: ReactTestInstance): ViewStyle {
  return (StyleSheet.flatten(node.props.style) ?? {}) as ViewStyle;
}

function hosts(renderer: ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props.onStartShouldSetResponder !== undefined,
  );
}

function click(host: ReactTestInstance) {
  act(() => {
    host.props.onClick({
      currentTarget: host,
      target: host,
      nativeEvent: {},
      stopPropagation: () => {},
    });
  });
}

function texts(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node => React.Children.toArray(node.props.children))
    .filter(
      (child): child is string | number =>
        typeof child === 'string' || typeof child === 'number',
    )
    .map(String);
}

describe('BrandToggle', () => {
  it('VERIFIED: role=switch with checked+disabled state, hitSlop 5, 54×44 container, disabled swallows activation', () => {
    const onValueChange = jest.fn();
    const renderer = render(
      <BrandToggle label="Reminders" value onValueChange={onValueChange} />,
    );
    const [host] = hosts(renderer);
    expect(host).toBeDefined();
    expect(host!.props.accessibilityRole).toBe('switch');
    expect(host!.props.accessibilityLabel).toBe('Reminders');
    expect(host!.props.accessibilityState).toEqual({
      checked: true,
      disabled: undefined,
    });
    expect(host!.props.hitSlop).toBe(5);
    click(host!);
    expect(onValueChange).toHaveBeenCalledWith(false);

    // The Animated container owns the 54×44 footprint.
    let container: ReactTestInstance | null = host!.parent;
    while (container && typeof container.type !== 'string') {
      container = container.parent;
    }
    expect(container).not.toBeNull();
    expect(flat(container as ReactTestInstance)).toEqual(
      expect.objectContaining({ width: 54, height: 44 }),
    );

    act(() => {
      renderer.update(
        <BrandToggle
          label="Reminders"
          value={false}
          disabled
          onValueChange={onValueChange}
        />,
      );
    });
    const [disabledHost] = hosts(renderer);
    expect(disabledHost!.props.accessibilityState).toEqual({
      checked: false,
      disabled: true,
    });
    onValueChange.mockClear();
    click(disabledHost!);
    expect(onValueChange).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});

describe('BrandDialog', () => {
  const noop = () => {};

  it('PROBE: two actions sharing a label must render without a duplicate-key warning', () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const renderer = render(
      <BrandDialog
        visible
        title="Delete?"
        detail="This cannot be undone."
        onDismiss={noop}
        actions={[
          { label: 'Continue', onPress: noop },
          { label: 'Continue', variant: 'dark', onPress: noop },
        ]}
      />,
    );
    const keyWarnings = consoleError.mock.calls.filter(call =>
      String(call[0]).includes('same key'),
    );
    consoleError.mockRestore();
    act(() => renderer.unmount());
    expect(keyWarnings).toEqual([]);
  });

  it('VERIFIED: close button is a 44pt labelled button; backdrop is not an a11y element; both call onDismiss', () => {
    const onDismiss = jest.fn();
    const renderer = render(
      <BrandDialog
        visible
        title="Heads up"
        detail="Detail"
        onDismiss={onDismiss}
        actions={[{ label: 'Got it', onPress: noop }]}
        testID="dialog"
      />,
    );
    const pressables = hosts(renderer);
    const backdrop = pressables.find(node => node.props.accessible === false);
    expect(backdrop).toBeDefined();
    click(backdrop!);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    const close = pressables.find(
      node => node.props.accessibilityLabel === 'Close dialog',
    );
    expect(close).toBeDefined();
    expect(close!.props.accessibilityRole).toBe('button');
    expect(flat(close!)).toEqual(
      expect.objectContaining({ width: 44, height: 44 }),
    );
    click(close!);
    expect(onDismiss).toHaveBeenCalledTimes(2);

    const card = renderer.root.find(
      node => typeof node.type === 'string' && node.props.testID === 'dialog',
    );
    expect(card.props.accessibilityViewIsModal).toBe(true);
    expect(renderer.root.findByType(Modal).props.onRequestClose).toBe(
      onDismiss,
    );
    act(() => renderer.unmount());
  });

  it('VERIFIED: without onDismiss the backdrop is inert, no close button renders, and hardware back is a no-op', () => {
    const renderer = render(
      <BrandDialog
        visible
        title="Required"
        detail="Pick one"
        actions={[{ label: 'OK', onPress: noop }]}
      />,
    );
    const pressables = hosts(renderer);
    const backdrop = pressables.find(node => node.props.accessible === false);
    expect(backdrop).toBeDefined();
    expect(backdrop!.props.onStartShouldSetResponder()).toBe(false);
    expect(
      pressables.filter(
        node => node.props.accessibilityLabel === 'Close dialog',
      ),
    ).toHaveLength(0);
    const modal = renderer.root.findByType(Modal);
    expect(modal.props.onRequestClose).toBeUndefined();
    act(() => renderer.unmount());
  });
});

function sweepCircle(renderer: ReactTestRenderer): ReactTestInstance {
  const circles = renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props.svgKind === 'Circle' &&
      node.props.strokeDasharray !== undefined,
  );
  expect(circles).toHaveLength(1);
  return circles[0]!;
}

describe('ScoreRing', () => {
  it('VERIFIED: null score renders an em dash, "No technique score yet", and zero sweep', () => {
    const renderer = render(<ScoreRing score={null} size={100} />);
    const root = renderer.root.find(
      node =>
        typeof node.type === 'string' &&
        node.props.accessibilityLabel === 'No technique score yet',
    );
    expect(root).toBeDefined();
    expect(texts(renderer)).toContain('—');
    const circle = sweepCircle(renderer);
    const circumference = Number(circle.props.strokeDasharray);
    expect(circle.props.strokeDashoffset).toBeCloseTo(circumference, 6);
    act(() => renderer.unmount());
  });

  // Under reduced motion the ring seeds its shared value with the final
  // fraction, so the resting dash offset is observable through the
  // reanimated auto-mock (useAnimatedProps runs synchronously).
  function reducedMotionRing(score: number): ReactTestRenderer {
    const renderer = render(<ScoreRing score={5} size={100} />);
    const listener = (
      AccessibilityInfo.addEventListener as jest.Mock
    ).mock.calls.find(call => call[0] === 'reduceMotionChanged')?.[1];
    expect(typeof listener).toBe('function');
    act(() => {
      listener(true);
    });
    act(() => {
      renderer.update(<ScoreRing score={score} size={100} />);
    });
    return renderer;
  }

  afterEach(() => {
    const listener = (
      AccessibilityInfo.addEventListener as jest.Mock
    ).mock.calls.find(call => call[0] === 'reduceMotionChanged')?.[1];
    if (typeof listener === 'function') {
      act(() => {
        listener(false);
      });
    }
  });

  it('VERIFIED: scores above 10 clamp to a full ring while the label reports the real number', () => {
    const renderer = reducedMotionRing(12);
    const root = renderer.root.find(
      node =>
        typeof node.type === 'string' &&
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.startsWith('Technique score'),
    );
    expect(root.props.accessibilityLabel).toBe(
      'Technique score 12.0 out of 10',
    );
    const circle = sweepCircle(renderer);
    expect(circle.props.strokeDashoffset).toBeCloseTo(0, 6);
    act(() => renderer.unmount());
  });

  it('PROBE: a negative score must not produce a sweep offset beyond the track (fraction clamped ≥ 0)', () => {
    // components.tsx:601 — `Math.min(score / 10, 1)` has no lower bound.
    const renderer = reducedMotionRing(-3);
    const circle = sweepCircle(renderer);
    const circumference = Number(circle.props.strokeDasharray);
    const offset = Number(circle.props.strokeDashoffset);
    act(() => renderer.unmount());
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset).toBeLessThanOrEqual(circumference + 1e-9);
  });
});

describe('TrendChart', () => {
  it('VERIFIED: fewer than two points renders the text fallback and no SVG', () => {
    const renderer = render(<TrendChart points={[7.5]} />);
    expect(texts(renderer)).toEqual([
      'Your trend appears after two scored reps.',
    ]);
    expect(
      renderer.root.findAll(
        node => typeof node.type === 'string' && node.props.svgKind === 'Svg',
      ),
    ).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('VERIFIED: in-range points produce finite polyline coordinates and a labelled chart', () => {
    const renderer = render(
      <TrendChart points={[4, 6, 8, 10]} width={300} height={60} />,
    );
    const svg = renderer.root.find(
      node => typeof node.type === 'string' && node.props.svgKind === 'Svg',
    );
    expect(svg.props.accessibilityLabel).toBe('Technique score trend');
    const polylines = renderer.root.findAll(
      node =>
        typeof node.type === 'string' && node.props.svgKind === 'Polyline',
    );
    expect(polylines).toHaveLength(2);
    for (const polyline of polylines) {
      const numbers = String(polyline.props.points).split(/[ ,]/).map(Number);
      expect(numbers.every(Number.isFinite)).toBe(true);
    }
    act(() => renderer.unmount());
  });

  it('PROBE: NaN / Infinity / negative points must not reach the SVG as non-finite or out-of-box coordinates', () => {
    // components.tsx:824-832 — `Math.min(p, max) / max` passes NaN straight
    // through and has no lower clamp.
    const renderer = render(
      <TrendChart
        points={[Number.NaN, 5, Number.POSITIVE_INFINITY, -4]}
        width={300}
        height={60}
      />,
    );
    const polylines = renderer.root.findAll(
      node =>
        typeof node.type === 'string' && node.props.svgKind === 'Polyline',
    );
    expect(polylines).toHaveLength(2);
    const offenders: string[] = [];
    for (const polyline of polylines) {
      for (const pair of String(polyline.props.points).split(' ')) {
        const [x, y] = pair.split(',').map(Number);
        if (!Number.isFinite(x) || !Number.isFinite(y) || y! < 0 || y! > 60) {
          offenders.push(pair);
        }
      }
    }
    act(() => renderer.unmount());
    expect(offenders).toEqual([]);
  });
});

describe('Pill / Stat / SectionTitle', () => {
  it('VERIFIED: render token-typed text, never disable font scaling', () => {
    const renderer = render(
      <>
        <Pill label="Validated" tone="good" />
        <Stat value="12" label="reps" />
        <SectionTitle title="Recent" />
      </>,
    );
    const textNodes = renderer.root.findAllByType(Text);
    expect(textNodes.length).toBeGreaterThanOrEqual(4);
    for (const node of textNodes) {
      expect(node.props.allowFontScaling).not.toBe(false);
    }
    expect(texts(renderer)).toEqual(
      expect.arrayContaining(['Validated', '12', 'reps', 'Recent']),
    );
    act(() => renderer.unmount());
  });
});

describe('useReliableSafeAreaInsets', () => {
  it('VERIFIED: with no initial window metrics and zero live insets, iOS falls back to 44/34', () => {
    let seen: { top: number; bottom: number } | null = null;
    function Probe() {
      seen = useReliableSafeAreaInsets();
      return null;
    }
    const renderer = render(<Probe />);
    expect(seen).toEqual({ top: 44, bottom: 34 });
    act(() => renderer.unmount());
  });
});
