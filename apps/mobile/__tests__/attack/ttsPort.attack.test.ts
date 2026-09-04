/**
 * ADVERSARIAL PASS 3 / tester #4 — extra: the native TTS bridge port.
 * `src/audio/tts.ts` is the CoachVoicePort shape the Live Court coach speaks
 * through. Attack: native module missing (permission/entitlement denied or
 * pod not linked), partially present, and hostile text.
 */
describe('tts port — native AVSpeechSynthesizer bridge', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('react-native');
  });

  function loadWithNative(nativeModule: unknown) {
    jest.doMock('react-native', () => ({
      Platform: { OS: 'ios' },
      NativeModules: { PickleAudioCoach: nativeModule },
    }));
    return (
      jest.requireActual(
        '../../src/audio/tts',
      ) as typeof import('../../src/audio/tts')
    ).tts;
  }

  it('native module absent: available() is false and speak/stop are safe no-ops', () => {
    const tts = loadWithNative(undefined);
    expect(tts.available()).toBe(false);
    expect(() => tts.speak('Knees bent.')).not.toThrow();
    expect(() => tts.stop()).not.toThrow();
  });

  it('module present but without speak (older native build): reported unavailable, stop still safe', () => {
    const stop = jest.fn();
    const tts = loadWithNative({ stop });
    expect(tts.available()).toBe(false);
    expect(() => tts.speak('x')).not.toThrow();
    tts.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('module present: speak forwards the text with the fixed 0.5 rate; stop forwards', () => {
    const speak = jest.fn();
    const stop = jest.fn();
    const tts = loadWithNative({ speak, stop });
    expect(tts.available()).toBe(true);
    tts.speak('6.4. Knees bent.');
    expect(speak).toHaveBeenCalledWith('6.4. Knees bent.', 0.5);
    tts.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('hostile text (unicode, empty, 100 KB) is passed through verbatim — the port does not sanitize', () => {
    const speak = jest.fn();
    const tts = loadWithNative({ speak, stop: jest.fn() });
    const huge = 'a'.repeat(100_000);
    for (const text of ['', '🏓\u0000', '\u202e', huge]) tts.speak(text);
    expect(speak.mock.calls.map(call => call[0])).toEqual([
      '',
      '🏓\u0000',
      '\u202e',
      huge,
    ]);
  });

  it('a native speak() that throws propagates to the caller (no catch in the port)', () => {
    const tts = loadWithNative({
      speak: () => {
        throw new Error('AVAudioSession activation failed');
      },
      stop: jest.fn(),
    });
    expect(tts.available()).toBe(true);
    expect(() => tts.speak('Knees bent.')).toThrow(
      'AVAudioSession activation failed',
    );
  });
});
