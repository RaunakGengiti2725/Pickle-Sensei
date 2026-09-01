import React from 'react';
import { Image, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * ClipPlayer is the on-device capture player behind saved clips. Its
 * degradation must be honest: when the PickleClipPlayerView native view is
 * absent (this jest preset, or a build without the pod) it renders the REAL
 * captured poster still or a plain dark surface — never a fabricated frame,
 * never a spinner that cannot resolve. When the native view exists, every
 * callback is forwarded with the unwrapped native payload.
 */

function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

describe('ClipPlayer without the native view', () => {
  const { ClipPlayer, clipPlaybackAvailable } =
    require('../../src/components/ClipPlayer') as typeof import('../../src/components/ClipPlayer');

  it('reports playback unavailable under this preset', () => {
    expect(clipPlaybackAvailable()).toBe(false);
  });

  it('renders the captured poster still, labeled for screen readers', () => {
    const renderer = render(
      <ClipPlayer
        uri="file:///clips/cap-1.mov"
        posterUri="file:///clips/cap-1.jpg"
        playing
        seekMs={-1}
      />,
    );
    const image = renderer.root.findByType(Image);
    expect(image.props.source).toEqual({ uri: 'file:///clips/cap-1.jpg' });
    expect(image.props.accessibilityLabel).toBe('Captured clip poster');
    expect(image.props.resizeMode).toBe('cover');
    act(() => renderer.unmount());
  });

  it('renders a plain surface (no fake frame, no spinner) when no poster exists', () => {
    const renderer = render(
      <ClipPlayer uri="file:///clips/cap-1.mov" playing={false} seekMs={-1} />,
    );
    expect(renderer.root.findAllByType(Image)).toHaveLength(0);
    expect(renderer.root.findAllByType(View)).toHaveLength(1);
    expect(renderer.toJSON()).toEqual({
      type: 'View',
      props: { style: expect.anything() },
      children: null,
    });
    act(() => renderer.unmount());
  });
});

describe('ClipPlayer with the native view registered', () => {
  let ClipPlayerModule: typeof import('../../src/components/ClipPlayer');

  beforeAll(() => {
    jest.isolateModules(() => {
      jest.doMock('react-native', () => {
        const actual =
          jest.requireActual<typeof import('react-native')>('react-native');
        // react-native's index exposes lazy getters; spreading it would
        // force every native module. Override only the two lookups.
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

  it('reports playback available and forwards props + unwrapped callbacks', () => {
    const { ClipPlayer, clipPlaybackAvailable } = ClipPlayerModule;
    expect(clipPlaybackAvailable()).toBe(true);
    const onProgress = jest.fn();
    const onLoad = jest.fn();
    const onEnd = jest.fn();
    const renderer = render(
      <ClipPlayer
        uri="file:///clips/cap-1.mov"
        posterUri="file:///clips/cap-1.jpg"
        playing
        seekMs={1250}
        onProgress={onProgress}
        onLoad={onLoad}
        onEnd={onEnd}
      />,
    );
    const native = renderer.root.find(
      n => String(n.type) === 'PickleClipPlayerView',
    );
    expect(native.props.sourceUri).toBe('file:///clips/cap-1.mov');
    expect(native.props.playing).toBe(true);
    expect(native.props.seekMs).toBe(1250);
    // No poster is drawn over real frames.
    expect(renderer.root.findAllByType(Image)).toHaveLength(0);

    act(() => {
      native.props.onClipLoad({ nativeEvent: { durationMs: 4200 } });
      native.props.onClipProgress({ nativeEvent: { positionMs: 800 } });
      native.props.onClipEnd();
    });
    expect(onLoad).toHaveBeenCalledWith(4200);
    expect(onProgress).toHaveBeenCalledWith(800);
    expect(onEnd).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('tolerates absent callbacks', () => {
    const { ClipPlayer } = ClipPlayerModule;
    const renderer = render(
      <ClipPlayer uri="file:///clips/cap-2.mov" playing={false} seekMs={-1} />,
    );
    const native = renderer.root.find(
      n => String(n.type) === 'PickleClipPlayerView',
    );
    expect(() =>
      act(() => {
        native.props.onClipLoad({ nativeEvent: { durationMs: 1 } });
        native.props.onClipProgress({ nativeEvent: { positionMs: 1 } });
        native.props.onClipEnd();
      }),
    ).not.toThrow();
    act(() => renderer.unmount());
  });
});
