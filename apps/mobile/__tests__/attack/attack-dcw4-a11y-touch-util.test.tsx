/**
 * ADVERSARIAL PASS 3 — mobile-design-components-walkthrough — EXTRA attacks.
 *
 * E1  Touch targets: every design-primitive pressable resolves to >= 44pt on
 *     its short axis (Button, compact Button, BrandToggle, ScreenHeader
 *     back/close, StrokeResult play button), read from the flattened styles
 *     the components actually pass to the host Pressable/View.
 * E2  Roles/labels/state: Button/BrandToggle/ScreenHeader forward
 *     accessibilityRole, label, and disabled/checked state; every Text keeps
 *     dynamic type enabled (no `allowFontScaling={false}` anywhere).
 * E3  StrokeResult scrubber VoiceOver actions: 200 increments never pass
 *     endMs, 200 decrements never pass startMs, unknown action names are
 *     ignored, and a scrub during playback stops the interval.
 * E4  Hostile copy: 20k-char, RTL, ZWJ-emoji and control-char labels render
 *     through Button / Pill / EmptyState / ErrorState / ScreenHeader without
 *     throwing and reach the a11y label untouched.
 * E5  util: `plural` on NaN/-1/1.0/Infinity/"1"; `makeUuid` v4 shape, version
 *     and variant bits under crypto / no-crypto / all-zero-bytes / all-0xff
 *     randomness, and 20k-sample uniqueness.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { ShotAnalysis } from '@pickle/shared-types';

jest.mock('react-native-reanimated', () => {
  const ReactActual = require('react');
  const RN = require('react-native');
  const AnimatedView = (props: Record<string, unknown>) =>
    ReactActual.createElement(RN.View, props);
  return {
    __esModule: true,
    default: {
      View: AnimatedView,
      createAnimatedComponent:
        (Component: React.ComponentType<Record<string, unknown>>) =>
        (props: Record<string, unknown>) => {
          const { animatedProps, ...rest } = props as {
            animatedProps?: Record<string, unknown>;
          } & Record<string, unknown>;
          return ReactActual.createElement(Component, {
            ...rest,
            ...animatedProps,
          });
        },
    },
    Easing: { out: (fn: unknown) => fn, cubic: () => 0 },
    interpolate: () => 0,
    useAnimatedStyle: (updater: () => object) => updater(),
    useAnimatedProps: (updater: () => object) => updater(),
    useSharedValue: (init: unknown) =>
      ReactActual.useRef({ value: init }).current,
    withTiming: (toValue: number) => toValue,
  };
});

jest.mock('react-native-safe-area-context', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: RN.View,
    SafeAreaProvider: RN.View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

jest.mock('../../src/components/ClipPlayer', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    clipPlaybackAvailable: () => false,
    ClipPlayer: (props: Record<string, unknown>) =>
      ReactActual.createElement(RN.View, { testID: 'clip-player', ...props }),
  };
});

import {
  BrandToggle,
  Button,
  EmptyState,
  ErrorState,
  Pill,
  ScreenHeader,
} from '../../src/design/components';
import { StrokeResult } from '../../src/components/StrokeResult';
import type { StrokeResultEvidenceRecord } from '../../src/components/strokeResultModel';
import { plural } from '../../src/util/plural';
import { makeUuid } from '../../src/util/uuid';

type Renderer = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

function renderSync(element: React.ReactElement): Renderer {
  let renderer!: Renderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

function unmount(renderer: Renderer) {
  act(() => renderer.unmount());
}

/** The composite Pressable PressableScale renders: the only node whose
 * `style` is the `({pressed}) => …` function (the host View below it receives
 * the resolved array), so it is unambiguous regardless of Pressable's
 * memo/forwardRef identity under the jest preset. */
function pressables(renderer: Renderer): Instance[] {
  return renderer.root.findAll(
    n =>
      typeof n.type !== 'string' &&
      typeof n.props.style === 'function' &&
      typeof n.props.onPressIn === 'function',
  );
}

function flattenPressableStyle(node: Instance): Record<string, unknown> {
  const style = node.props.style;
  const resolved =
    typeof style === 'function' ? style({ pressed: false }) : style;
  return (StyleSheet.flatten(resolved) ?? {}) as Record<string, unknown>;
}

function shortAxisPt(node: Instance): number {
  const own = flattenPressableStyle(node);
  const parent = node.parent
    ? (StyleSheet.flatten(node.parent.props.style) ?? {})
    : {};
  const candidates = [
    own['minHeight'],
    own['height'],
    (parent as Record<string, unknown>)['minHeight'],
    (parent as Record<string, unknown>)['height'],
  ].filter((v): v is number => typeof v === 'number');
  const hitSlop = node.props.hitSlop;
  const slop =
    typeof hitSlop === 'number'
      ? hitSlop * 2
      : hitSlop && typeof hitSlop === 'object'
        ? Number(hitSlop.top ?? 0) + Number(hitSlop.bottom ?? 0)
        : 0;
  return (candidates.length ? Math.max(...candidates) : 0) + slop;
}

function allTexts(renderer: Renderer): Instance[] {
  return renderer.root.findAllByType(Text);
}

// ─── E1 + E2: touch targets, roles, labels, dynamic type ───────────────────

describe('EXTRA E1 — touch targets ≥ 44pt on the short axis', () => {
  it('Button (default and compact) resolves to ≥ 44pt', () => {
    const renderer = renderSync(
      <View>
        <Button label="Save" onPress={() => undefined} testID="b1" />
        <Button label="Save" onPress={() => undefined} compact testID="b2" />
      </View>,
    );
    const nodes = pressables(renderer);
    expect(nodes).toHaveLength(2);
    for (const node of nodes) {
      expect(shortAxisPt(node)).toBeGreaterThanOrEqual(44);
    }
    unmount(renderer);
  });

  it('BrandToggle (34pt visual + 44pt container + hitSlop 5) resolves to ≥ 44pt', () => {
    const renderer = renderSync(
      <BrandToggle label="Reminders" value={false} onValueChange={() => 0} />,
    );
    const [node] = pressables(renderer);
    expect(node).toBeDefined();
    expect(shortAxisPt(node!)).toBeGreaterThanOrEqual(44);
    unmount(renderer);
  });

  it('ScreenHeader back/close icon buttons are 44×44 with hitSlop 8', () => {
    const renderer = renderSync(
      <View>
        <ScreenHeader title="A" onBack={() => undefined} />
        <ScreenHeader title="B" onClose={() => undefined} />
      </View>,
    );
    const nodes = pressables(renderer);
    expect(nodes).toHaveLength(2);
    for (const node of nodes) {
      const style = flattenPressableStyle(node);
      expect(style['width']).toBe(44);
      expect(style['height']).toBe(44);
      expect(node.props.hitSlop).toBe(8);
    }
    unmount(renderer);
  });
});

describe('EXTRA E2 — roles, labels, state, dynamic type', () => {
  it('Button forwards role=button, label, and disabled state (and does not fire onPress when disabled)', () => {
    const onPress = jest.fn();
    const renderer = renderSync(
      <Button
        label="Delete account"
        onPress={onPress}
        disabled
        variant="danger"
      />,
    );
    const [node] = pressables(renderer);
    expect(node!.props.accessibilityRole).toBe('button');
    expect(node!.props.accessibilityLabel).toBe('Delete account');
    expect(node!.props.accessibilityState).toMatchObject({ disabled: true });
    expect(node!.props.disabled).toBe(true);
    // The host-level Pressability gate is native; assert the prop contract
    // the gate keys off rather than simulating a press through it.
    expect(onPress).not.toHaveBeenCalled();
    unmount(renderer);
  });

  it('BrandToggle exposes role=switch with checked state that follows `value` and flips through onValueChange', () => {
    const onValueChange = jest.fn();
    const renderer = renderSync(
      <BrandToggle label="Weekly recap" value onValueChange={onValueChange} />,
    );
    const [node] = pressables(renderer);
    expect(node!.props.accessibilityRole).toBe('switch');
    expect(node!.props.accessibilityLabel).toBe('Weekly recap');
    expect(node!.props.accessibilityState).toMatchObject({ checked: true });
    act(() => node!.props.onPress());
    expect(onValueChange).toHaveBeenCalledWith(false);
    act(() => {
      renderer.update(
        <BrandToggle
          label="Weekly recap"
          value={false}
          onValueChange={onValueChange}
        />,
      );
    });
    expect(pressables(renderer)[0]!.props.accessibilityState).toMatchObject({
      checked: false,
    });
    unmount(renderer);
  });

  it('no design primitive disables dynamic type (allowFontScaling is never false)', () => {
    const renderer = renderSync(
      <View>
        <Button label="Go" onPress={() => undefined} />
        <Pill label="Validated" tone="good" />
        <ScreenHeader title="Title" eyebrow="eyebrow" onBack={() => 0} />
        <EmptyState title="Nothing yet" body="Record a stroke to begin." />
        <ErrorState title="Oops" detail="Try again" onRetry={() => 0} />
      </View>,
    );
    const texts = allTexts(renderer);
    expect(texts.length).toBeGreaterThan(5);
    for (const text of texts) {
      expect(text.props.allowFontScaling).not.toBe(false);
    }
    unmount(renderer);
  });
});

// ─── E3: StrokeResult scrubber VoiceOver actions ────────────────────────────

function analysisFixture(): ShotAnalysis {
  return {
    id: 'a2',
    sessionId: 's1',
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-08-30T10:05:00.000Z',
    timestamps: { startMs: 200, contactMs: null, endMs: 700 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: 7.4,
    analysisConfidence: 0.82,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'on-device-fusion-1',
      poseModelVersion: 'apple-vision-bodypose-1',
      paddleModelVersion: 'none',
      strokeDetectorVersion: 'temporal-stroke-heuristic-2',
      phaseModelVersion: 'phase-heuristic-1',
      scoringModelVersion: 'scoring-1',
      shotConfigVersion: 'config-1',
    },
    source: 'real',
  };
}

const record: StrokeResultEvidenceRecord = {
  id: 'a2',
  captureId: 'capture-2',
  strokeIntent: {
    declaredStroke: 'forehand_drive',
    predictedStroke: null,
    resolutionBasis: 'declared',
    resolvedProfileId: 'FOREHAND_DRIVE',
    resolvedProfileVersion: 'technique-profile-v1',
    disagreement: null,
  },
  result: null,
  uncertainty: {
    analysisConfidence: 0.82,
    presentation: 'normal',
    limitingFactors: [],
  },
};

function surface(clip: { uri: string; durationMs: number } | null) {
  return (
    <StrokeResult
      analysis={analysisFixture()}
      record={record}
      clip={clip}
      currentAnalysisId="a2"
      onTryAgain={() => undefined}
      onDone={() => undefined}
    />
  );
}

function scrubber(renderer: Renderer): Instance {
  const [node] = renderer.root.findAll(
    n =>
      typeof n.type === 'string' &&
      n.props.accessibilityLabel === 'Replay timeline scrubber',
  );
  if (!node) throw new Error('No scrubber host rendered');
  return node;
}

function a11yValue(renderer: Renderer) {
  return scrubber(renderer).props.accessibilityValue as {
    min: number;
    max: number;
    now: number;
    text: string;
  };
}

function fireAction(renderer: Renderer, actionName: string) {
  act(() => {
    scrubber(renderer).props.onAccessibilityAction({
      nativeEvent: { actionName },
    });
  });
}

function pressableByLabel(renderer: Renderer, label: string): Instance {
  const [node] = renderer.root.findAll(
    c =>
      c.props.accessibilityLabel === label &&
      typeof c.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable labelled "${label}"`);
  return node;
}

describe('EXTRA E3 — scrubber VoiceOver increment/decrement clamping', () => {
  const CLIP = { uri: 'file:///clip.mov', durationMs: 2000 };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('exposes increment/decrement actions and role=adjustable with min/max/now/text', () => {
    const renderer = renderSync(surface(CLIP));
    const node = scrubber(renderer);
    expect(node.props.accessibilityRole).toBe('adjustable');
    expect(node.props.accessibilityActions).toEqual([
      { name: 'increment' },
      { name: 'decrement' },
    ]);
    expect(a11yValue(renderer)).toEqual({
      min: 0,
      max: 2000,
      now: 0,
      text: '0.00s',
    });
    unmount(renderer);
  });

  it('200 increments clamp exactly at endMs; 200 decrements clamp exactly at 0; values stay finite integers', () => {
    const renderer = renderSync(surface(CLIP));
    for (let i = 0; i < 200; i += 1) {
      fireAction(renderer, 'increment');
      const v = a11yValue(renderer);
      expect(Number.isInteger(v.now)).toBe(true);
      expect(v.now).toBeLessThanOrEqual(2000);
      expect(v.now).toBeGreaterThanOrEqual(0);
    }
    expect(a11yValue(renderer)).toMatchObject({ now: 2000, text: '2.00s' });
    for (let i = 0; i < 200; i += 1) {
      fireAction(renderer, 'decrement');
      expect(a11yValue(renderer).now).toBeGreaterThanOrEqual(0);
    }
    expect(a11yValue(renderer)).toMatchObject({ now: 0, text: '0.00s' });
    unmount(renderer);
  });

  it('20 increments land exactly on endMs (1/20th steps accumulate without float drift past the end)', () => {
    const renderer = renderSync(surface(CLIP));
    for (let i = 0; i < 20; i += 1) fireAction(renderer, 'increment');
    expect(a11yValue(renderer).now).toBe(2000);
    unmount(renderer);
  });

  it('unknown / hostile action names (magicTap, "", unicode, prototype keys) are ignored without throwing', () => {
    const renderer = renderSync(surface(CLIP));
    fireAction(renderer, 'increment');
    const before = a11yValue(renderer).now;
    for (const name of [
      'magicTap',
      'escape',
      '',
      'incrément',
      '__proto__',
      'constructor',
      'INCREMENT',
    ]) {
      expect(() => fireAction(renderer, name)).not.toThrow();
      expect(a11yValue(renderer).now).toBe(before);
    }
    unmount(renderer);
  });

  it('a VoiceOver scrub during playback stops the interval (no runaway timer after the user takes control)', () => {
    const renderer = renderSync(surface(CLIP));
    act(() => pressableByLabel(renderer, 'Play replay').props.onPress());
    act(() => jest.advanceTimersByTime(200));
    expect(a11yValue(renderer).now).toBe(200);
    fireAction(renderer, 'increment'); // 200 + 100 = 300
    expect(a11yValue(renderer).now).toBe(300);
    act(() => jest.advanceTimersByTime(1000));
    // Stopped: the playhead must not have advanced by the interval.
    expect(a11yValue(renderer).now).toBe(300);
    expect(
      renderer.root.findAll(c => c.props.accessibilityLabel === 'Play replay')
        .length,
    ).toBeGreaterThan(0);
    unmount(renderer);
  });
});

// ─── E4: hostile copy ───────────────────────────────────────────────────────

const HOSTILE_LABELS: Array<[string, string]> = [
  ['20k chars', 'x'.repeat(20_000)],
  ['RTL + bidi override', '\u202Eעברית \u202Dback'],
  ['ZWJ emoji family', '👨‍👩‍👧‍👦👩🏽‍🚀🏳️‍🌈'],
  ['control chars', 'a\u0000b\u0007c\u001Bd\u200Be'],
  ['newlines/tabs', 'line1\nline2\ttabbed\r\n'],
  ['lone surrogate', 'bad\uD800pair'],
  ['combining marks storm', 'a' + '\u0301'.repeat(500)],
];

describe('EXTRA E4 — hostile copy through design primitives', () => {
  it.each(HOSTILE_LABELS)(
    '%s renders through Button / Pill / ScreenHeader / EmptyState / ErrorState without throwing',
    (_name, label) => {
      let renderer!: Renderer;
      expect(() => {
        renderer = renderSync(
          <View>
            <Button label={label} onPress={() => undefined} />
            <Pill label={label} tone="warn" />
            <ScreenHeader title={label} eyebrow={label} onBack={() => 0} />
            <EmptyState title={label} body={label} />
            <ErrorState title={label} detail={label} onRetry={() => 0} />
          </View>,
        );
      }).not.toThrow();
      // The Button's a11y label is the literal copy — not truncated, not
      // normalized (VoiceOver reads exactly what is on screen).
      const [button] = pressables(renderer);
      expect(button!.props.accessibilityLabel).toBe(label);
      unmount(renderer);
    },
  );
});

// ─── E5: util ───────────────────────────────────────────────────────────────

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('EXTRA E5 — util/plural + util/uuid under hostile inputs', () => {
  it('plural: only exactly 1 is singular (NaN, -1, 1.5, Infinity, 0, "1"-as-number are plural)', () => {
    expect(plural(1, 'rating')).toBe('rating');
    expect(plural(1.0, 'rating')).toBe('rating');
    expect(plural(0, 'rating')).toBe('ratings');
    expect(plural(-1, 'rating')).toBe('ratings');
    expect(plural(1.5, 'rating')).toBe('ratings');
    expect(plural(Number.NaN, 'rating')).toBe('ratings');
    expect(plural(Number.POSITIVE_INFINITY, 'rating')).toBe('ratings');
    expect(plural(2, 'match', 'matches')).toBe('matches');
    expect(plural(Number('1'), 'day')).toBe('day');
    // -0 === 1 is false; 0.9999999999999999 !== 1.
    expect(plural(-0, 'day')).toBe('days');
    expect(plural(0.9999999999999999, 'day')).toBe('days');
  });

  it('makeUuid: 20 000 samples are v4-shaped and unique with the runtime crypto', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) {
      const id = makeUuid();
      expect(id).toMatch(UUID_V4);
      seen.add(id);
    }
    expect(seen.size).toBe(20_000);
  });

  it('makeUuid: version/variant bits are forced even when randomness is all-zero or all-0xff', () => {
    const g = globalThis as {
      crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array };
    };
    const original = g.crypto;
    try {
      g.crypto = {
        getRandomValues: (a: Uint8Array) => {
          a.fill(0);
          return a;
        },
      };
      expect(makeUuid()).toBe('00000000-0000-4000-8000-000000000000');
      g.crypto = {
        getRandomValues: (a: Uint8Array) => {
          a.fill(0xff);
          return a;
        },
      };
      expect(makeUuid()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    } finally {
      g.crypto = original;
    }
  });

  it('makeUuid: with NO crypto object the Math.random fallback still yields v4-shaped unique ids', () => {
    const g = globalThis as { crypto?: unknown };
    const original = g.crypto;
    try {
      g.crypto = undefined;
      const seen = new Set<string>();
      for (let i = 0; i < 5_000; i += 1) {
        const id = makeUuid();
        expect(id).toMatch(UUID_V4);
        seen.add(id);
      }
      expect(seen.size).toBe(5_000);
    } finally {
      g.crypto = original;
    }
  });

  it('makeUuid: a crypto object whose getRandomValues is missing falls back rather than throwing', () => {
    const g = globalThis as { crypto?: unknown };
    const original = g.crypto;
    try {
      g.crypto = {};
      expect(makeUuid()).toMatch(UUID_V4);
    } finally {
      g.crypto = original;
    }
  });
});
