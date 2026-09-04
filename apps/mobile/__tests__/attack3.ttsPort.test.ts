/**
 * ADVERSARIAL PASS #3 — src/audio/tts.ts, the JS side of the TTS bridge.
 *
 * Linux can only prove the JS contract: how `tts` behaves when the native
 * module is absent (the "permission denied / module not linked" plane), when
 * it is present, and what it forwards. Nothing here claims AVSpeechSynthesizer
 * behaviour.
 */
import { NativeModules } from 'react-native';
import type { CoachVoicePort } from '../src/flow/liveSessionCoach';

type Native = { speak?: unknown; stop?: unknown; speakCue?: unknown };
const modules = NativeModules as { PickleAudioCoach?: Native };

function loadTts(native: Native | undefined) {
  if (native === undefined) delete modules.PickleAudioCoach;
  else modules.PickleAudioCoach = native;
  let loaded: typeof import('../src/audio/tts') | undefined;
  jest.isolateModules(() => {
    loaded =
      jest.requireActual<typeof import('../src/audio/tts')>('../src/audio/tts');
  });
  if (!loaded) throw new Error('tts module did not load');
  return loaded.tts;
}

afterEach(() => {
  delete modules.PickleAudioCoach;
});

describe('tts with the native module ABSENT (unlinked / denied plane)', () => {
  it('HELD: available() is false and speak()/stop() are silent no-ops', () => {
    const tts = loadTts(undefined);
    expect(tts.available()).toBe(false);
    expect(() => tts.speak('hello')).not.toThrow();
    expect(() => tts.stop()).not.toThrow();
  });

  it('HELD: a module object WITHOUT speak (partial link) reports unavailable', () => {
    const tts = loadTts({ stop: jest.fn() });
    expect(tts.available()).toBe(false);
    expect(() => tts.speak('x')).toThrow(TypeError); // native.speak is undefined → measured
  });

  it('HELD: tts satisfies CoachVoicePort structurally (speak returns void ⇒ coach records spoken:true when available)', () => {
    const port: CoachVoicePort = loadTts(undefined);
    expect(port.available()).toBe(false);
  });
});

describe('tts with a native module PRESENT', () => {
  it("BROKEN(P3): speak() forwards a hard-coded rate 0.5 and DROPS the caller's category — the native speakCue(text, {interruption}) policy is unreachable from JS", () => {
    const speak = jest.fn();
    const speakCue = jest.fn();
    const tts = loadTts({ speak, stop: jest.fn(), speakCue });
    expect(tts.available()).toBe(true);
    // LiveSessionCoach calls voice.speak(text, { category }) — the second arg is
    // discarded by tts.speak's (text) signature.
    (tts as CoachVoicePort).speak('Bend the knees more.', {
      category: 'CORRECTION',
    });
    expect(speak).toHaveBeenCalledWith('Bend the knees more.', 0.5);
    expect(speakCue).not.toHaveBeenCalled();
  });

  it('HELD: the module reference is captured at import; a module that disappears later is still called (measured; no re-resolution)', () => {
    const speak = jest.fn();
    const tts = loadTts({ speak, stop: jest.fn() });
    delete modules.PickleAudioCoach;
    expect(tts.available()).toBe(true);
    tts.speak('still bound');
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it('BROKEN: a native speak that throws propagates through tts.speak (no boundary here; see liveSessionCoach findings)', () => {
    const tts = loadTts({
      speak: () => {
        throw new Error('Exception in HostFunction: speak');
      },
      stop: jest.fn(),
    });
    expect(() => tts.speak('x')).toThrow('Exception in HostFunction: speak');
  });

  it('HELD: huge and unicode utterances are forwarded verbatim (no truncation/escaping in JS)', () => {
    const speak = jest.fn();
    const tts = loadTts({ speak, stop: jest.fn() });
    const huge = 'a'.repeat(1_000_000);
    const uni =
      'Bend the knees more. \u{1F3D3}\u200B\u202E\u0000 Contact \u00e9t\u00e9';
    tts.speak(huge);
    tts.speak(uni);
    expect(speak.mock.calls[0]?.[0]).toHaveLength(1_000_000);
    expect(speak.mock.calls[1]?.[0]).toBe(uni);
  });

  it('HELD: rapid speak/stop interleaving forwards every call in order (JS adds no queueing or debouncing)', () => {
    const calls: string[] = [];
    const tts = loadTts({
      speak: (t: string) => calls.push(`speak:${t}`),
      stop: () => calls.push('stop'),
    });
    for (let i = 0; i < 50; i += 1) {
      tts.speak(String(i));
      if (i % 3 === 0) tts.stop();
    }
    expect(calls).toHaveLength(50 + 17);
    expect(calls.slice(0, 4)).toEqual([
      'speak:0',
      'stop',
      'speak:1',
      'speak:2',
    ]);
  });
});
