/**
 * ADVERSARIAL PASS 3 — mobile-design-components-walkthrough — scenario 1.
 *
 * ClipPlayer forwards `rate` to the PickleClipPlayerView native view. A
 * non-finite / non-positive rate handed to AVPlayer would stall (0), run
 * backwards (-1) or be rejected (NaN / Infinity), so the JS side must
 * sanitize every hostile value to real-time `1`. This suite registers a fake
 * native view (same Proxy pattern as flow-library-drills-video.clip-player)
 * and inspects the exact `rate` prop the host element receives.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

describe('ATTACK S1 — ClipPlayer hostile rate values against a mocked native view', () => {
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

  function nativeRate(rate: number | undefined) {
    const { ClipPlayer } = ClipPlayerModule;
    const renderer = render(
      <ClipPlayer
        uri="file:///clips/attack.mov"
        playing
        seekMs={-1}
        {...(rate === undefined ? {} : { rate })}
      />,
    );
    const native = renderer.root.find(
      n => String(n.type) === 'PickleClipPlayerView',
    );
    const forwarded = native.props.rate;
    act(() => renderer.unmount());
    return forwarded;
  }

  it('precondition: the fake native view is registered', () => {
    expect(ClipPlayerModule.clipPlaybackAvailable()).toBe(true);
  });

  it.each([
    ['NaN', Number.NaN],
    ['0', 0],
    ['-1', -1],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rate=%s forwards native rate 1', (_label, rate) => {
    expect(nativeRate(rate)).toBe(1);
  });

  it('extra: -Infinity, -0, tiny negative, undefined, and non-number casts all forward 1', () => {
    expect(nativeRate(Number.NEGATIVE_INFINITY)).toBe(1);
    expect(nativeRate(-0)).toBe(1);
    expect(nativeRate(-Number.MIN_VALUE)).toBe(1);
    expect(nativeRate(undefined)).toBe(1);
    // A JS caller that ignores the type (e.g. a JSON-decoded setting).
    expect(nativeRate('0.5' as unknown as number)).toBe(1);
    expect(nativeRate(null as unknown as number)).toBe(1);
    expect(nativeRate({} as unknown as number)).toBe(1);
  });

  it('extra: legitimate slow-motion and fast rates are forwarded untouched', () => {
    expect(nativeRate(0.25)).toBe(0.25);
    expect(nativeRate(0.5)).toBe(0.5);
    expect(nativeRate(1)).toBe(1);
    expect(nativeRate(2)).toBe(2);
    expect(nativeRate(Number.MIN_VALUE)).toBe(Number.MIN_VALUE);
  });

  it('extra: rapid re-renders alternating hostile and valid rates never leak a hostile value', () => {
    const { ClipPlayer } = ClipPlayerModule;
    const sequence = [
      0.5,
      Number.NaN,
      1,
      0,
      2,
      -1,
      0.25,
      Number.POSITIVE_INFINITY,
      1,
    ];
    const renderer = render(
      <ClipPlayer
        uri="file:///clips/attack.mov"
        playing
        seekMs={-1}
        rate={1}
      />,
    );
    const seen: number[] = [];
    for (const rate of sequence) {
      act(() => {
        renderer.update(
          <ClipPlayer
            uri="file:///clips/attack.mov"
            playing
            seekMs={-1}
            rate={rate}
          />,
        );
      });
      const native = renderer.root.find(
        n => String(n.type) === 'PickleClipPlayerView',
      );
      seen.push(native.props.rate);
    }
    expect(seen).toEqual([0.5, 1, 1, 1, 2, 1, 0.25, 1, 1]);
    for (const value of seen) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
    act(() => renderer.unmount());
  });

  it('extra: hostile seekMs values are forwarded as-is (documented: -1 = no seek) and never crash render', () => {
    const { ClipPlayer } = ClipPlayerModule;
    for (const seekMs of [Number.NaN, Number.POSITIVE_INFINITY, -5, 2 ** 53]) {
      const renderer = render(
        <ClipPlayer
          uri="file:///clips/attack.mov"
          playing
          seekMs={seekMs}
          rate={1}
        />,
      );
      const native = renderer.root.find(
        n => String(n.type) === 'PickleClipPlayerView',
      );
      // Pin the current contract so a silent change is visible.
      expect(Object.is(native.props.seekMs, seekMs)).toBe(true);
      act(() => renderer.unmount());
    }
  });
});
