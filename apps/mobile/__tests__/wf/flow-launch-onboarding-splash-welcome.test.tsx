import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * Splash overlay + Welcome screen contract:
 *  - the splash never finishes before MIN_VISIBLE_MS, never before `ready`,
 *    and fires onFinished exactly once (re-renders cannot re-trigger it);
 *  - it is a non-interactive, labelled overlay (pointerEvents none);
 *  - Welcome exposes exactly two wired controls with button roles and hints.
 */

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    SafeAreaView: (props: { children?: React.ReactNode }) =>
      React.createElement(View, null, props.children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: {
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 0, bottom: 0, left: 0, right: 0 },
    },
  };
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
    G: Mock,
    Ellipse: Mock,
  };
});

let mockReducedMotion = true;
jest.mock('../../src/design/components', () => {
  const actual = jest.requireActual<
    typeof import('../../src/design/components')
  >('../../src/design/components');
  return {
    ...actual,
    useReducedMotion: () => mockReducedMotion,
  };
});

import { SplashScreen } from '../../src/screens/SplashScreen';
import { WelcomeScreen } from '../../src/screens/WelcomeScreen';

type Renderer = TestRenderer.ReactTestRenderer;

function isAncestor(
  ancestor: TestRenderer.ReactTestInstance,
  node: TestRenderer.ReactTestInstance,
): boolean {
  let current = node.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function pressables(renderer: Renderer, label: string) {
  const matches = renderer.root.findAll(
    node =>
      node.props?.accessibilityLabel === label &&
      typeof node.props?.onPress === 'function',
  );
  return matches.filter(
    node => !matches.some(other => other !== node && isAncestor(node, other)),
  );
}

describe('flow: launch-onboarding — SplashScreen', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockReducedMotion = true;
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('holds for MIN_VISIBLE_MS even when ready immediately, then finishes exactly once', () => {
    const onFinished = jest.fn();
    let renderer!: Renderer;
    act(() => {
      renderer = TestRenderer.create(
        <SplashScreen ready onFinished={onFinished} />,
      );
    });
    act(() => {
      jest.advanceTimersByTime(1100);
    });
    expect(onFinished).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(100);
    });
    act(() => {
      jest.runOnlyPendingTimers();
    });
    expect(onFinished).toHaveBeenCalledTimes(1);

    // Re-renders (new callback identity, prop flips) never re-fire it.
    const again = jest.fn();
    act(() => {
      renderer.update(<SplashScreen ready onFinished={again} />);
    });
    act(() => {
      renderer.update(<SplashScreen ready={false} onFinished={again} />);
    });
    act(() => {
      renderer.update(<SplashScreen ready onFinished={again} />);
    });
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(again).not.toHaveBeenCalled();
    expect(onFinished).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('never finishes while hydration is pending, then finishes once ready even long after the minimum', () => {
    const onFinished = jest.fn();
    let renderer!: Renderer;
    act(() => {
      renderer = TestRenderer.create(
        <SplashScreen ready={false} onFinished={onFinished} />,
      );
    });
    act(() => {
      jest.advanceTimersByTime(10_000);
    });
    expect(onFinished).not.toHaveBeenCalled();
    act(() => {
      renderer.update(<SplashScreen ready onFinished={onFinished} />);
    });
    act(() => {
      jest.runOnlyPendingTimers();
    });
    expect(onFinished).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('with motion enabled the exit fade still completes and reports once', () => {
    mockReducedMotion = false;
    const onFinished = jest.fn();
    let renderer!: Renderer;
    act(() => {
      renderer = TestRenderer.create(
        <SplashScreen ready onFinished={onFinished} />,
      );
    });
    act(() => {
      jest.advanceTimersByTime(1150);
    });
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(onFinished).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('is a non-interactive, labelled overlay (no controls to tap)', () => {
    let renderer!: Renderer;
    act(() => {
      renderer = TestRenderer.create(
        <SplashScreen ready={false} onFinished={() => {}} />,
      );
    });
    const overlay = renderer.root.findByProps({
      accessibilityLabel: 'Pickle Sensei is starting',
    });
    expect(overlay.props.pointerEvents).toBe('none');
    expect(overlay.props.accessible).toBe(true);
    expect(
      renderer.root.findAll(node => typeof node.props?.onPress === 'function'),
    ).toHaveLength(0);
    act(() => renderer.unmount());
  });
});

describe('flow: launch-onboarding — WelcomeScreen', () => {
  it('exposes exactly two wired controls, each a labelled button, and never renders a placeholder', () => {
    const onGetStarted = jest.fn();
    const onSignIn = jest.fn();
    let renderer!: Renderer;
    act(() => {
      renderer = TestRenderer.create(
        <WelcomeScreen onGetStarted={onGetStarted} onSignIn={onSignIn} />,
      );
    });

    const primary = pressables(renderer, 'Start your first read');
    expect(primary).toHaveLength(1);
    expect(primary[0]!.props.accessibilityRole).toBe('button');
    expect(primary[0]!.props.disabled).toBeFalsy();
    act(() => primary[0]!.props.onPress());
    expect(onGetStarted).toHaveBeenCalledTimes(1);
    expect(onSignIn).not.toHaveBeenCalled();

    const secondary = pressables(renderer, 'I already have an account');
    expect(secondary).toHaveLength(1);
    expect(secondary[0]!.props.accessibilityRole).toBe('button');
    expect(secondary[0]!.props.accessibilityHint).toBe(
      'Skip setup and go to sign-in',
    );
    act(() => secondary[0]!.props.onPress());
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(onGetStarted).toHaveBeenCalledTimes(1);

    // No other tappable surface exists (nothing that does nothing).
    const allPressables = renderer.root.findAll(
      node => typeof node.props?.onPress === 'function',
    );
    const labels = new Set(
      allPressables.map(node => node.props.accessibilityLabel),
    );
    expect([...labels].sort()).toEqual([
      'I already have an account',
      'Start your first read',
    ]);

    const text = renderer.root
      .findAllByType(Text)
      .map(node => node.props.children)
      .flat()
      .filter((c): c is string => typeof c === 'string')
      .join(' ');
    expect(text).toContain('See the stroke.');
    expect(text).toContain('Know the fix.');
    expect(text.toLowerCase()).not.toMatch(
      /lorem|todo|placeholder|coming soon/,
    );
    act(() => renderer.unmount());
  });
});
