import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * Splash overlay + Welcome screen contract:
 *  - the splash (an MP4 intro) never finishes before the intro is over
 *    (ended, skipped, errored or cut by WATCHDOG_MS), never before `ready`,
 *    and fires onFinished exactly once (re-renders cannot re-trigger it);
 *  - while mounted and not exiting it is a full-screen overlay that owns
 *    every touch (root pointerEvents 'auto'); while exiting it is 'none' so
 *    the live screen beneath takes over. Its only control is a "Skip" that
 *    appears after SKIP_AFTER_S seconds of playback — so the root is NOT an
 *    accessible/labelled node (that would hide Skip from VoiceOver); the
 *    intro itself is exposed as an image;
 *  - Welcome exposes exactly two wired controls with button roles and hints.
 * Mocks mirror `__tests__/splashScreen.test.tsx` (react-native-video is
 * auto-mocked from `__mocks__/`; StatusBar is mocked in jest.setup.js).
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

import {
  EXIT_MS,
  SKIP_AFTER_S,
  SplashScreen,
  WATCHDOG_MS,
} from '../../src/screens/SplashScreen';
import { WelcomeScreen } from '../../src/screens/WelcomeScreen';

type Renderer = TestRenderer.ReactTestRenderer;

/** Host (string-typed) nodes only, so a composite + its host count once. */
function hostNodes(renderer: Renderer, testID: string) {
  return renderer.root.findAll(
    node => node.props.testID === testID && typeof node.type === 'string',
  );
}

function splashRoot(renderer: Renderer) {
  const roots = hostNodes(renderer, 'splash-screen');
  expect(roots).toHaveLength(1);
  return roots[0]!;
}

function video(renderer: Renderer) {
  return hostNodes(renderer, 'splash-video')[0]!;
}

function skipButton(renderer: Renderer) {
  return renderer.root.findAll(
    node => node.props.testID === 'splash-skip' && node.props.onPress,
  )[0];
}

function renderSplash(ready: boolean, onFinished: () => void): Renderer {
  let renderer!: Renderer;
  act(() => {
    renderer = TestRenderer.create(
      <SplashScreen ready={ready} onFinished={onFinished} />,
    );
  });
  return renderer;
}

function play(renderer: Renderer, seconds: number) {
  act(() => {
    video(renderer).props.onProgress({
      currentTime: seconds,
      playableDuration: 5,
      seekableDuration: 5,
    });
  });
}

function endIntro(renderer: Renderer) {
  act(() => {
    video(renderer).props.onEnd();
  });
}

function elapse(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

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

  it('holds until the intro is over even when ready immediately, then finishes exactly once', () => {
    const onFinished = jest.fn();
    const renderer = renderSplash(true, onFinished);
    // Ready from the first frame, but the intro is still playing: nothing
    // leaves — not even after a long wait short of the watchdog.
    elapse(WATCHDOG_MS - 1);
    expect(onFinished).not.toHaveBeenCalled();
    expect(splashRoot(renderer).props.pointerEvents).toBe('auto');

    endIntro(renderer);
    elapse(EXIT_MS + 50);
    expect(onFinished).toHaveBeenCalledTimes(1);

    // Re-renders (new callback identity, prop flips), a late watchdog and a
    // second end event never re-fire it.
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
    endIntro(renderer);
    elapse(WATCHDOG_MS + EXIT_MS);
    expect(again).not.toHaveBeenCalled();
    expect(onFinished).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('never finishes while hydration is pending — even after the intro ended and the watchdog fired — then finishes once ready', () => {
    const onFinished = jest.fn();
    const renderer = renderSplash(false, onFinished);
    endIntro(renderer);
    elapse(WATCHDOG_MS + 2_000);
    expect(onFinished).not.toHaveBeenCalled();
    // Still holding the last frame over an unpainted gate: the overlay keeps
    // owning every touch.
    expect(splashRoot(renderer).props.pointerEvents).toBe('auto');

    act(() => {
      renderer.update(<SplashScreen ready onFinished={onFinished} />);
    });
    elapse(EXIT_MS + 50);
    expect(onFinished).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('a stalled player is cut by the watchdog so the app is never stranded behind the intro', () => {
    const onFinished = jest.fn();
    const renderer = renderSplash(true, onFinished);
    elapse(WATCHDOG_MS - 1);
    elapse(EXIT_MS + 50);
    expect(onFinished).not.toHaveBeenCalled();
    elapse(1);
    elapse(EXIT_MS + 50);
    expect(onFinished).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('with motion enabled the exit cross-fade still completes, tails the sound off and reports once', () => {
    mockReducedMotion = false;
    const onFinished = jest.fn();
    const renderer = renderSplash(true, onFinished);
    expect(video(renderer).props.volume).toBe(1);
    endIntro(renderer);
    // Mid-fade: not yet reported, touches already pass through.
    elapse(EXIT_MS / 2);
    expect(onFinished).not.toHaveBeenCalled();
    expect(splashRoot(renderer).props.pointerEvents).toBe('none');
    elapse(EXIT_MS);
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(video(renderer).props.volume).toBe(0);
    act(() => renderer.unmount());
  });

  it('is a full-screen overlay that owns every touch while mounted, exposes the intro as an image (not a hidden root), and offers Skip as its only control after the first second', () => {
    const onFinished = jest.fn();
    const renderer = renderSplash(false, onFinished);
    const root = splashRoot(renderer);
    // Topmost in hit-testing: nothing under the overlay can be tapped.
    expect(root.props.pointerEvents).toBe('auto');
    // The root is deliberately NOT an accessible/labelled node — that would
    // hide the Skip control from VoiceOver. The intro is labelled instead.
    expect(root.props.accessible).toBeUndefined();
    expect(root.props.accessibilityLabel).toBeUndefined();
    expect(
      renderer.root.findAll(
        node => node.props?.accessibilityLabel === 'Pickle Sensei is starting',
      ),
    ).toHaveLength(0);
    const intro = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        node.props.accessibilityRole === 'image' &&
        node.props.accessibilityLabel === 'Pickle Sensei intro animation',
    );
    expect(intro).toHaveLength(1);
    expect(intro[0]!.props.accessible).toBe(true);

    // No control at all before SKIP_AFTER_S seconds of playback.
    expect(
      renderer.root.findAll(node => typeof node.props?.onPress === 'function'),
    ).toHaveLength(0);
    play(renderer, SKIP_AFTER_S / 2);
    expect(skipButton(renderer)).toBeUndefined();

    play(renderer, SKIP_AFTER_S);
    const skip = skipButton(renderer)!;
    expect(skip).toBeDefined();
    expect(skip.props.accessibilityLabel).toBe('Skip intro');
    // The innermost pressable (RN's Pressable) resolves role + disabled.
    const skipControl = pressables(renderer, 'Skip intro');
    expect(skipControl).toHaveLength(1);
    expect(skipControl[0]!.props.accessibilityRole).toBe('button');
    expect(skipControl[0]!.props.disabled).toBeFalsy();
    // Skip is the ONE control on the overlay.
    expect(
      new Set(
        renderer.root
          .findAll(node => typeof node.props?.onPress === 'function')
          .map(node => node.props.accessibilityLabel),
      ),
    ).toEqual(new Set(['Skip intro']));

    // Skipping before hydration only ends the intro; the overlay keeps
    // holding (and owning touches) until `ready`.
    act(() => skip.props.onPress());
    elapse(EXIT_MS + 50);
    expect(onFinished).not.toHaveBeenCalled();
    expect(splashRoot(renderer).props.pointerEvents).toBe('auto');

    act(() => {
      renderer.update(<SplashScreen ready onFinished={onFinished} />);
    });
    // Exiting: the live screen beneath takes over hit-testing.
    expect(splashRoot(renderer).props.pointerEvents).toBe('none');
    elapse(EXIT_MS + 50);
    expect(onFinished).toHaveBeenCalledTimes(1);
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
    // The link is the returning-player route to sign-in; setup itself is
    // never "skipped" (an account without a profile lands in the in-account
    // questionnaire), so the hint no longer promises that.
    expect(secondary[0]!.props.accessibilityHint).toBe(
      'Sign in to an existing account',
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
