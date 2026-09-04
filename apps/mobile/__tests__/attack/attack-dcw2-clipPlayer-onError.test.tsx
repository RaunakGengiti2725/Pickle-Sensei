/**
 * ADVERSARIAL PASS 3 (tester #2) — mobile-design-components-walkthrough — S1.
 *
 * ClipPlayer forwards the native `onClipError` event as
 * `props.onError?.(event.nativeEvent.message ?? 'unreadable')`. The native
 * view (PickleClipPlayer.swift) always sends `{message}`, but the JS contract
 * says "message?: string" — so a `{}` payload must degrade to 'unreadable'
 * and a hostile `nativeEvent: null` / missing `nativeEvent` must never throw
 * out of a native event handler (an uncaught exception in an event handler
 * is a red-box in dev and a JS crash in release).
 *
 * The native view is registered through the same UIManager Proxy pattern the
 * other clip-player suites use so the real `NativeClipPlayer` branch renders.
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

type NativeErrorHandler = (event: unknown) => void;

describe('ATTACK S1 — ClipPlayer onClipError with degenerate nativeEvent payloads', () => {
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

  function mountWithSpy() {
    const { ClipPlayer } = ClipPlayerModule;
    const onError = jest.fn<void, [string]>();
    const renderer = render(
      <ClipPlayer
        uri="file:///clips/attack.mov"
        playing={false}
        seekMs={-1}
        onError={onError}
      />,
    );
    const native = renderer.root.find(
      n => String(n.type) === 'PickleClipPlayerView',
    );
    const fire = native.props.onClipError as NativeErrorHandler;
    return { renderer, onError, fire };
  }

  it('precondition: the fake native view is registered and renders', () => {
    expect(ClipPlayerModule.clipPlaybackAvailable()).toBe(true);
    const { renderer, fire } = mountWithSpy();
    expect(typeof fire).toBe('function');
    act(() => renderer.unmount());
  });

  it('nativeEvent={} → callback receives "unreadable" and nothing throws', () => {
    const { renderer, onError, fire } = mountWithSpy();
    expect(() => act(() => fire({ nativeEvent: {} }))).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('unreadable');
    act(() => renderer.unmount());
  });

  it('nativeEvent={message: undefined} → "unreadable"', () => {
    const { renderer, onError, fire } = mountWithSpy();
    expect(() =>
      act(() => fire({ nativeEvent: { message: undefined } })),
    ).not.toThrow();
    expect(onError).toHaveBeenCalledWith('unreadable');
    act(() => renderer.unmount());
  });

  it('nativeEvent=null → callback receives "unreadable" and nothing throws', () => {
    const { renderer, onError, fire } = mountWithSpy();
    let thrown: unknown = null;
    try {
      act(() => fire({ nativeEvent: null }));
    } catch (error) {
      thrown = error;
    }
    // Record the exact failure mode for the report before asserting.
    if (thrown) {
      console.log(
        `[ATTACK S1] nativeEvent=null threw: ${String(
          (thrown as Error).message,
        )}`,
      );
    }
    expect(thrown).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('unreadable');
    act(() => renderer.unmount());
  });

  it('event without a nativeEvent key at all → "unreadable" and nothing throws', () => {
    const { renderer, onError, fire } = mountWithSpy();
    let thrown: unknown = null;
    try {
      act(() => fire({}));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeNull();
    expect(onError).toHaveBeenCalledWith('unreadable');
    act(() => renderer.unmount());
  });

  it('a real message (unicode, huge) is forwarded verbatim', () => {
    const { renderer, onError, fire } = mountWithSpy();
    const unicode = 'файл повреждён 🎾'.repeat(1);
    const huge = 'x'.repeat(100_000);
    act(() => fire({ nativeEvent: { message: unicode } }));
    act(() => fire({ nativeEvent: { message: huge } }));
    expect(onError).toHaveBeenNthCalledWith(1, unicode);
    expect(onError).toHaveBeenNthCalledWith(2, huge);
    act(() => renderer.unmount());
  });

  it('empty-string message is passed through (not replaced by "unreadable") — documents the ?? contract', () => {
    const { renderer, onError, fire } = mountWithSpy();
    act(() => fire({ nativeEvent: { message: '' } }));
    // `??` only substitutes null/undefined; an empty string reaches the
    // consumer unchanged. Recorded as behaviour, not asserted as a bug.
    expect(onError).toHaveBeenCalledWith('');
    act(() => renderer.unmount());
  });

  it('rapid repeat: 200 degenerate events in a row never throw and each reports "unreadable"', () => {
    const { renderer, onError, fire } = mountWithSpy();
    act(() => {
      for (let i = 0; i < 200; i++) {
        fire(i % 2 === 0 ? { nativeEvent: {} } : { nativeEvent: undefined });
      }
    });
    expect(onError).toHaveBeenCalledTimes(200);
    expect(onError.mock.calls.every(([m]) => m === 'unreadable')).toBe(true);
    act(() => renderer.unmount());
  });

  it('no onError prop: degenerate events are swallowed silently', () => {
    const { ClipPlayer } = ClipPlayerModule;
    const renderer = render(
      <ClipPlayer uri="file:///clips/attack.mov" playing={false} seekMs={-1} />,
    );
    const native = renderer.root.find(
      n => String(n.type) === 'PickleClipPlayerView',
    );
    const fire = native.props.onClipError as NativeErrorHandler;
    expect(() => act(() => fire({ nativeEvent: {} }))).not.toThrow();
    expect(() => act(() => fire({ nativeEvent: null }))).not.toThrow();
    act(() => renderer.unmount());
  });
});
