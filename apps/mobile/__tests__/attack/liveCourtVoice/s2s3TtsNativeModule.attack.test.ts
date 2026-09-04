/**
 * ADVERSARIAL S2 + S3 (mobile-live-court-voice, pass 3) — tts.ts bridge under
 * a degraded / hostile native module. No tts.ts test existed before this.
 *
 * S2: NativeModules.PickleAudioCoach = { stop } (no speak) — the Swift module
 *     linked without the speak selector, or a partial mock. available() must
 *     be false (Never a silent fake), and stop() must still delegate so a
 *     mute/teardown can always cut an utterance.
 * S3: speak that throws (the RN bridge rejects an argument, the synthesizer
 *     raises) — tts.speak must be CONSISTENT: either always surface or always
 *     swallow, and whichever it does must be the same for stop().
 *
 * tts.ts captures `NativeModules.PickleAudioCoach` at import (L14), so each
 * case loads the module fresh inside jest.isolateModules.
 */
import { NativeModules } from 'react-native';

type Tts = typeof import('../../../src/audio/tts').tts;

function loadTts(nativeModule: unknown): Tts {
  let loaded: Tts | null = null;
  jest.isolateModules(() => {
    (NativeModules as Record<string, unknown>).PickleAudioCoach = nativeModule;
    loaded = jest.requireActual<{ tts: Tts }>('../../../src/audio/tts').tts;
  });
  if (loaded === null) throw new Error('tts did not load');
  return loaded;
}

afterEach(() => {
  delete (NativeModules as Record<string, unknown>).PickleAudioCoach;
});

describe('ADVERSARIAL S2: native module exposes stop() but no speak()', () => {
  it('available() is false while stop() still delegates to the native stop', () => {
    const stop = jest.fn();
    const tts = loadTts({ stop });
    expect(tts.available()).toBe(false);
    tts.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('speak() on the speak-less module: must not silently pretend to have spoken', () => {
    const stop = jest.fn();
    const tts = loadTts({ stop });
    // `native?.speak(...)` with speak undefined is a TypeError; a caller who
    // ignored available() learns about it loudly, which is the honest
    // behaviour for a "never a silent fake" bridge.
    expect(() => tts.speak('hello')).toThrow(TypeError);
    expect(stop).not.toHaveBeenCalled();
  });

  it('module absent entirely: available() false, speak/stop are safe no-ops', () => {
    const tts = loadTts(undefined);
    expect(tts.available()).toBe(false);
    expect(() => tts.speak('hello')).not.toThrow();
    expect(() => tts.stop()).not.toThrow();
  });

  it('module present with a non-function speak (e.g. a constant exported by mistake): available() must be false', () => {
    const tts = loadTts({ speak: true, stop: jest.fn() });
    // Boolean(native?.speak) is truthy for ANY non-falsy value, so a
    // misconfigured module reports "available" and speak() then throws.
    expect(tts.available()).toBe(false);
  });

  it('module late-attached AFTER import is not seen (import-time capture)', () => {
    const tts = loadTts(undefined);
    const speak = jest.fn();
    (NativeModules as Record<string, unknown>).PickleAudioCoach = {
      speak,
      stop: jest.fn(),
    };
    // Documents the capture semantics: a module registered after the first
    // import is invisible to this singleton for the process lifetime.
    expect(tts.available()).toBe(false);
    tts.speak('late');
    expect(speak).not.toHaveBeenCalled();
  });
});

describe('ADVERSARIAL S3: native speak throws', () => {
  const boom = new Error('AVSpeechSynthesizer: utterance rejected');

  it('tts.speak SURFACES the native error (does not swallow)', () => {
    const speak = jest.fn(() => {
      throw boom;
    });
    const stop = jest.fn();
    const tts = loadTts({ speak, stop });
    expect(tts.available()).toBe(true);
    expect(() => tts.speak('Bend the knees more.')).toThrow(boom);
    expect(speak).toHaveBeenCalledWith('Bend the knees more.', 0.5);
  });

  it('tts.stop is CONSISTENT with speak: a throwing native stop also surfaces', () => {
    const stop = jest.fn(() => {
      throw boom;
    });
    const tts = loadTts({ speak: jest.fn(), stop });
    expect(() => tts.stop()).toThrow(boom);
  });

  it('a throw on one utterance does not poison the next one (no cached failure state)', () => {
    let calls = 0;
    const speak = jest.fn(() => {
      calls += 1;
      if (calls === 1) throw boom;
    });
    const tts = loadTts({ speak, stop: jest.fn() });
    expect(() => tts.speak('first')).toThrow(boom);
    expect(() => tts.speak('second')).not.toThrow();
    expect(tts.available()).toBe(true);
    expect(speak).toHaveBeenCalledTimes(2);
  });

  it('rapid repeats: 1000 speak calls each reach the bridge exactly once with the fixed rate', () => {
    const speak = jest.fn();
    const tts = loadTts({ speak, stop: jest.fn() });
    for (let i = 0; i < 1000; i += 1) tts.speak(`cue ${i}`);
    expect(speak).toHaveBeenCalledTimes(1000);
    expect(new Set(speak.mock.calls.map(call => call[1]))).toEqual(
      new Set([0.5]),
    );
  });

  it('unicode / huge / empty text passes through untouched (bridge decides)', () => {
    const speak = jest.fn();
    const tts = loadTts({ speak, stop: jest.fn() });
    const huge = 'a'.repeat(1_000_000);
    tts.speak('');
    tts.speak('🥒 pickle — “quotes” \u0000');
    tts.speak(huge);
    expect(speak.mock.calls.map(call => call[0])).toEqual([
      '',
      '🥒 pickle — “quotes” \u0000',
      huge,
    ]);
  });
});
