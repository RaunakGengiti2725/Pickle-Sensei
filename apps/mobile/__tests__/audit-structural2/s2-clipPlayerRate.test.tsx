/**
 * Structural audit #2: ClipPlayer's rate sanitiser and native error fallback
 * with the native view registered (module-load detection path).
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

describe('ClipPlayer with the native view registered', () => {
  let ClipPlayerModule: typeof import('../../src/components/ClipPlayer');

  beforeAll(() => {
    jest.isolateModules(() => {
      jest.doMock('react-native', () => {
        const actual =
          jest.requireActual<typeof import('react-native')>('react-native');
        const overrides: Record<string, unknown> = {
          UIManager: {
            getViewManagerConfig: (name: string) =>
              name === 'PickleClipPlayerView' ? { Commands: {} } : null,
          },
          requireNativeComponent: (name: string) => name,
        };
        return new Proxy(actual, {
          get: (target, prop: string) =>
            prop in overrides
              ? overrides[prop]
              : (target as unknown as Record<string, unknown>)[prop],
        });
      });
      ClipPlayerModule = require('../../src/components/ClipPlayer');
    });
  });

  afterAll(() => {
    jest.dontMock('react-native');
  });

  function nativeRate(rate: number | undefined): number {
    const { ClipPlayer } = ClipPlayerModule;
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(
        <ClipPlayer uri="file:///c.mov" playing seekMs={0} rate={rate} />,
      );
    });
    const native = root.root.find(
      n => String(n.type) === 'PickleClipPlayerView',
    );
    const value = native.props.rate as number;
    act(() => root.unmount());
    return value;
  }

  it.each([
    [undefined, 1],
    [Number.NaN, 1],
    [0, 1],
    [-0.5, 1],
    [Number.POSITIVE_INFINITY, 1],
    [Number.NEGATIVE_INFINITY, 1],
    [0.5, 0.5],
    [2, 2],
  ])('rate %p → native rate %p (verified invariant)', (input, expected) => {
    expect(nativeRate(input)).toBe(expected);
  });

  it('reports "unreadable" when the native error carries no message; tolerates absent callbacks (verified invariant)', () => {
    const { ClipPlayer } = ClipPlayerModule;
    const onError = jest.fn();
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(
        <ClipPlayer
          uri="file:///c.mov"
          playing={false}
          seekMs={0}
          onError={onError}
        />,
      );
    });
    const native = root.root.find(
      n => String(n.type) === 'PickleClipPlayerView',
    );
    act(() => {
      native.props.onClipError({ nativeEvent: {} });
    });
    expect(onError).toHaveBeenCalledWith('unreadable');
    act(() => root.unmount());

    act(() => {
      root = TestRenderer.create(
        <ClipPlayer uri="file:///c.mov" playing={false} seekMs={0} />,
      );
    });
    const bare = root.root.find(n => String(n.type) === 'PickleClipPlayerView');
    expect(() =>
      act(() => {
        bare.props.onClipError({ nativeEvent: { message: 'x' } });
        bare.props.onClipProgress({ nativeEvent: { positionMs: 10 } });
        bare.props.onClipLoad({ nativeEvent: { durationMs: 10 } });
        bare.props.onClipEnd();
      }),
    ).not.toThrow();
    act(() => root.unmount());
  });
});
