import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('../../src/design/components', () => ({
  ...jest.requireActual('../../src/design/components'),
  useReducedMotion: () => false,
}));

import { SplashScreen } from '../../src/screens/SplashScreen';

/**
 * App.tsx paints the first screen UNDER the splash as soon as hydration is
 * ready, so the opaque overlay must swallow touches for its whole lifetime
 * (minimum hold + exit fade) — otherwise an impatient tap on the logo lands
 * on an invisible Welcome / Home control and the user is routed somewhere
 * they never chose.
 */

function splashRoot(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.find(
    node =>
      typeof node.type === 'string' &&
      node.props.accessibilityLabel === 'Pickle Sensei is starting',
  );
}

function expectSwallowsTouches(renderer: TestRenderer.ReactTestRenderer) {
  const root = splashRoot(renderer);
  expect(root.props.pointerEvents).toBe('box-only');
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('SplashScreen touch interception (fix-30)', () => {
  test('blocks touches while hydration is still pending', () => {
    const onFinished = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <SplashScreen ready={false} onFinished={onFinished} />,
      );
    });

    expectSwallowsTouches(renderer);
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expectSwallowsTouches(renderer);
    expect(onFinished).not.toHaveBeenCalled();
  });

  test('keeps blocking touches through the minimum hold after ready flips', () => {
    const onFinished = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <SplashScreen ready={true} onFinished={onFinished} />,
      );
    });

    expectSwallowsTouches(renderer);
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expectSwallowsTouches(renderer);
    expect(onFinished).not.toHaveBeenCalled();
  });

  test('still blocks touches while mounted after the exit completes', () => {
    const onFinished = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <SplashScreen ready={false} onFinished={onFinished} />,
      );
    });
    act(() => {
      jest.advanceTimersByTime(1200);
    });
    expectSwallowsTouches(renderer);
    expect(onFinished).not.toHaveBeenCalled();

    act(() => {
      renderer.update(<SplashScreen ready={true} onFinished={onFinished} />);
    });
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(onFinished).toHaveBeenCalledTimes(1);
    expectSwallowsTouches(renderer);
  });
});
