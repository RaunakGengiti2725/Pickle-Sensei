/**
 * Button ledger for WelcomeScreen — every pressable on the pre-auth landing,
 * pressed through its real handler and asserted against the observable
 * effect (the parent's callbacks, which App.tsx wires to the launch gate).
 *
 * Pressables:
 *   1. "Start your first read" (design Button, volt) -> props.onGetStarted
 *   2. "I already have an account" (PressableScale)  -> props.onSignIn
 *      (rendered only when the parent supplies onSignIn)
 *
 * Both handlers are synchronous callbacks with no async path, so the failure
 * coverage here is the contract that a missing optional handler removes the
 * control instead of leaving a dead tap target.
 */
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});
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

import React from 'react';
import {
  Dimensions,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
} from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { WelcomeScreen } from '../../src/screens/WelcomeScreen';
import { radius, space } from '../../src/design/tokens';
import {
  stageAfterGetStarted,
  stageAfterOnboarding,
  stageWhenLeavingOnboarding,
} from '../../src/flow/launchGate';

const START_LABEL = 'Start your first read';
const SIGN_IN_LABEL = 'I already have an account';
const mounted: TestRenderer.ReactTestRenderer[] = [];

beforeEach(() => {
  jest
    .spyOn(Dimensions, 'get')
    .mockReturnValue({ width: 393, height: 852, scale: 3, fontScale: 1 });
});
afterEach(() => {
  act(() => {
    for (const renderer of mounted.splice(0)) renderer.unmount();
  });
  jest.restoreAllMocks();
});

function render(props: { onGetStarted: () => void; onSignIn?: () => void }) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<WelcomeScreen {...props} />);
  });
  mounted.push(renderer);
  return renderer;
}

// RN exports Pressable as React.memo(Pressable); the test tree holds the
// inner component, so unwrap the memo to match the real press targets.
const PressableInner = (
  Pressable as unknown as { type: React.ComponentType<unknown> }
).type;

function pressables(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(PressableInner)
    .filter(node => typeof node.props.onPress === 'function');
}

function pressableByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
): ReactTestInstance {
  const matches = pressables(renderer).filter(
    node => node.props.accessibilityLabel === label,
  );
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join('\n');
}

function resolvedStyle(node: ReactTestInstance): Record<string, unknown> {
  const style =
    typeof node.props.style === 'function'
      ? node.props.style({ pressed: false })
      : node.props.style;
  return StyleSheet.flatten(style) as Record<string, unknown>;
}

describe('WelcomeScreen button ledger', () => {
  test('renders exactly the two pressables, both in the ledger', () => {
    const renderer = render({
      onGetStarted: jest.fn(),
      onSignIn: jest.fn(),
    });
    const labels = pressables(renderer).map(
      node => node.props.accessibilityLabel,
    );
    expect(labels).toEqual([START_LABEL, SIGN_IN_LABEL]);
    const copy = allText(renderer);
    expect(copy).toContain(START_LABEL);
    expect(copy).toContain(SIGN_IN_LABEL);
  });

  test('"Start your first read" -> onGetStarted (once per tap)', () => {
    const onGetStarted = jest.fn();
    const onSignIn = jest.fn();
    const renderer = render({ onGetStarted, onSignIn });

    act(() => {
      pressableByLabel(renderer, START_LABEL).props.onPress();
    });

    expect(onGetStarted).toHaveBeenCalledTimes(1);
    expect(onSignIn).not.toHaveBeenCalled();

    act(() => {
      pressableByLabel(renderer, START_LABEL).props.onPress();
    });
    expect(onGetStarted).toHaveBeenCalledTimes(2);
  });

  test('"Start your first read" is enabled with a button role and >=44pt target', () => {
    const renderer = render({ onGetStarted: jest.fn() });
    const start = pressableByLabel(renderer, START_LABEL);
    expect(start.props.accessibilityRole).toBe('button');
    expect(start.props.disabled).toBeFalsy();
    expect(start.props.accessibilityState?.disabled).toBeFalsy();
    const style = resolvedStyle(start);
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
    expect(style.opacity).toBe(1);
  });

  test('"I already have an account" -> onSignIn (once per tap)', () => {
    const onGetStarted = jest.fn();
    const onSignIn = jest.fn();
    const renderer = render({ onGetStarted, onSignIn });

    act(() => {
      pressableByLabel(renderer, SIGN_IN_LABEL).props.onPress();
    });

    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(onGetStarted).not.toHaveBeenCalled();
  });

  test('"I already have an account" has role, label, hint and >=44pt target', () => {
    const renderer = render({ onGetStarted: jest.fn(), onSignIn: jest.fn() });
    const signIn = pressableByLabel(renderer, SIGN_IN_LABEL);
    expect(signIn.props.accessibilityRole).toBe('button');
    // Setup is never "skipped" (2026-09-01): the link is the returning
    // player's route to sign-in, and its hint says exactly that.
    expect(signIn.props.accessibilityHint).toBe(
      'Sign in to an existing account',
    );
    expect(signIn.props.disabled).toBeFalsy();
    const style = resolvedStyle(signIn);
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
    expect(style.opacity).toBe(1);
  });

  test('without onSignIn the secondary link is not rendered (no dead tap target)', () => {
    const onGetStarted = jest.fn();
    const renderer = render({ onGetStarted });
    const labels = pressables(renderer).map(
      node => node.props.accessibilityLabel,
    );
    expect(labels).toEqual([START_LABEL]);
    expect(allText(renderer)).not.toContain(SIGN_IN_LABEL);

    act(() => {
      pressableByLabel(renderer, START_LABEL).props.onPress();
    });
    expect(onGetStarted).toHaveBeenCalledTimes(1);
  });

  test('handlers can be swapped by a re-render without stale callbacks', () => {
    const first = jest.fn();
    const second = jest.fn();
    const renderer = render({ onGetStarted: first, onSignIn: first });
    act(() => {
      renderer.update(
        <WelcomeScreen onGetStarted={second} onSignIn={second} />,
      );
    });
    act(() => {
      pressableByLabel(renderer, START_LABEL).props.onPress();
      pressableByLabel(renderer, SIGN_IN_LABEL).props.onPress();
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(2);
  });

  describe('wired through the App.tsx launch gate', () => {
    // App.tsx: onGetStarted={() => setPreAuthStage(stageAfterGetStarted())}
    //          onSignIn={() => setPreAuthStage('signin')}
    // The gate takes NO device-history input: the "already onboarded device
    // → sign-in" short-circuit was removed 2026-09-01 (invest first, then
    // create the account), so the same button does the same thing on every
    // phone.
    function renderGate() {
      const setPreAuthStage = jest.fn();
      const renderer = render({
        onGetStarted: () => setPreAuthStage(stageAfterGetStarted()),
        onSignIn: () => setPreAuthStage('signin'),
      });
      return { renderer, setPreAuthStage };
    }

    test('Start -> onboarding questionnaire, always', () => {
      const { renderer, setPreAuthStage } = renderGate();
      act(() => {
        pressableByLabel(renderer, START_LABEL).props.onPress();
      });
      expect(setPreAuthStage).toHaveBeenCalledWith('onboarding');
      expect(setPreAuthStage).not.toHaveBeenCalledWith('signin');
      // Finishing the questionnaire is the only way on to sign-in; leaving
      // it from step one goes back here.
      expect(stageAfterOnboarding()).toBe('signin');
      expect(stageWhenLeavingOnboarding()).toBe('welcome');
    });

    test('the primary CTA cannot consult device history: stageAfterGetStarted takes no argument', () => {
      expect(stageAfterGetStarted.length).toBe(0);
      // Repeated taps (e.g. after backing out of step one) never drift to
      // sign-in — there is no state that could flip the answer.
      const { renderer, setPreAuthStage } = renderGate();
      for (let tap = 0; tap < 3; tap += 1) {
        act(() => {
          pressableByLabel(renderer, START_LABEL).props.onPress();
        });
      }
      expect(setPreAuthStage.mock.calls).toEqual([
        ['onboarding'],
        ['onboarding'],
        ['onboarding'],
      ]);
    });

    test('"I already have an account" -> sign-in (the explicit returning-player route)', () => {
      const { renderer, setPreAuthStage } = renderGate();
      act(() => {
        pressableByLabel(renderer, SIGN_IN_LABEL).props.onPress();
      });
      expect(setPreAuthStage).toHaveBeenCalledTimes(1);
      expect(setPreAuthStage).toHaveBeenCalledWith('signin');
    });
  });

  test.each([1, 1.118])(
    'responsive layout preserves the fitting non-scrolling identity and free-read contract at %sx',
    fontScale => {
      jest
        .spyOn(Dimensions, 'get')
        .mockReturnValue({ width: 393, height: 852, scale: 3, fontScale });
      const renderer = render({ onGetStarted: jest.fn(), onSignIn: jest.fn() });
      expect(renderer.root.findAllByType(ScrollView)).toHaveLength(0);
      const court = renderer.root.findAll(
        node =>
          typeof node.type === 'string' &&
          node.props.testID === 'welcome-court-story',
      )[0]!;
      expect(resolvedStyle(court)).toMatchObject({ flex: 1, minHeight: 270 });
      const hero = renderer.root
        .findAllByType(Text)
        .find(
          node =>
            Array.isArray(node.props.children) &&
            node.props.children.includes('See the stroke.'),
        )!;
      expect(resolvedStyle(hero)).toMatchObject({
        fontSize: 48,
        lineHeight: 50,
      });
      const text = allText(renderer);
      expect(text).toContain('Two scored technique reads free');
      expect(text).toContain('Unscored attempts don’t count');
      expect(text).toContain('Start your first read');
      expect(text).not.toMatch(/validated/i);
    },
  );

  test.each([
    [375, 667, 1],
    [375, 667, 2.64],
    [375, 667, 3.14],
    [393, 852, 3.12],
    [393, 852, 1.235],
  ])(
    'responsive layout at %sx%s/%sx keeps actions outside scrolling content and never caps copy',
    (width, height, fontScale) => {
      jest
        .spyOn(Dimensions, 'get')
        .mockReturnValue({ width, height, scale: 2, fontScale });
      const onGetStarted = jest.fn(),
        onSignIn = jest.fn();
      const renderer = render({ onGetStarted, onSignIn });
      const [scroll] = renderer.root.findAllByType(ScrollView);
      expect(scroll!.props.testID).toBe('welcome-content-scroll');
      expect(StyleSheet.flatten(scroll!.props.style)).toMatchObject({
        flex: 1,
        minHeight: 0,
      });
      for (const label of [START_LABEL, SIGN_IN_LABEL]) {
        expect(
          scroll!.findAll(node => node.props.accessibilityLabel === label),
        ).toHaveLength(0);
        expect(
          resolvedStyle(pressableByLabel(renderer, label)).minHeight,
        ).toBeGreaterThanOrEqual(44);
      }
      expect(
        scroll!.findAll(
          node =>
            typeof node.type === 'string' &&
            node.props.testID === 'welcome-free-copy',
        ),
      ).toHaveLength(1);
      const court = scroll!.findAll(
        node =>
          typeof node.type === 'string' &&
          node.props.testID === 'welcome-court-story',
      )[0]!;
      expect(resolvedStyle(court).flex).toBe(0);
      expect(
        resolvedStyle(pressableByLabel(renderer, START_LABEL)),
      ).toMatchObject({
        borderRadius: radius.lg,
        paddingVertical: space.sm,
      });
      for (const text of renderer.root.findAllByType(Text)) {
        expect(text.props.maxFontSizeMultiplier).toBeUndefined();
        expect(text.props.allowFontScaling).not.toBe(false);
        expect(text.props.numberOfLines).toBeUndefined();
      }
      act(() => {
        pressableByLabel(renderer, START_LABEL).props.onPress();
        pressableByLabel(renderer, SIGN_IN_LABEL).props.onPress();
      });
      expect(onGetStarted).toHaveBeenCalledTimes(1);
      expect(onSignIn).toHaveBeenCalledTimes(1);
      expect(allText(renderer)).toContain('Two scored technique reads free');
      expect(allText(renderer)).toContain('Unscored attempts don’t count');
    },
  );

  test('static copy carries no placeholder text', () => {
    const renderer = render({ onGetStarted: jest.fn(), onSignIn: jest.fn() });
    const copy = allText(renderer);
    expect(copy).toContain('See the stroke.');
    expect(copy).toContain('PRIVATE BY DEFAULT');
    expect(copy).not.toMatch(/TODO|lorem|placeholder|coming soon/i);
  });
});
