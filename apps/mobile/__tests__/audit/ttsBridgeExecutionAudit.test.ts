/**
 * Execution audit harness (pass 2 of 3) — `apps/mobile/src/audio/tts.ts`.
 *
 * The TTS bridge had 0% statement coverage in every existing suite (no JS
 * caller, no test). These tests pin what CAN be established on Linux: the
 * availability contract when the native module is absent (the "audio
 * permission/availability denied" analogue) and the exact arguments the
 * wrapper forwards when it is present. Nothing here claims
 * AVSpeechSynthesizer behaviour.
 *
 * New file only — production code is unchanged.
 */
import { NativeModules } from 'react-native';
import type { CoachVoicePort } from '../../src/flow/liveSessionCoach';

type Tts = typeof import('../../src/audio/tts').tts;

function loadTts(nativeModule: Record<string, unknown> | undefined): Tts {
  const modules = NativeModules as Record<string, unknown>;
  if (nativeModule === undefined) {
    delete modules.PickleAudioCoach;
  } else {
    modules.PickleAudioCoach = nativeModule;
  }
  let loaded!: Tts;
  jest.isolateModules(() => {
    loaded = jest.requireActual<{ tts: Tts }>('../../src/audio/tts').tts;
  });
  return loaded;
}

afterEach(() => {
  delete (NativeModules as Record<string, unknown>).PickleAudioCoach;
});

describe('tts bridge with the native module ABSENT (availability denied)', () => {
  it('reports unavailable and never throws on speak()/stop()', () => {
    const tts = loadTts(undefined);
    expect(tts.available()).toBe(false);
    expect(() => tts.speak('Paddle up.')).not.toThrow();
    expect(() => tts.stop()).not.toThrow();
  });

  it('a module object without speak() is also "unavailable" (partial bridge)', () => {
    const tts = loadTts({ stop: jest.fn() });
    expect(tts.available()).toBe(false);
    expect(() => tts.speak('x')).toThrow(); // speak is not a function
  });

  it('satisfies CoachVoicePort structurally, so LiveSessionCoach can consume it caption-only', () => {
    const tts = loadTts(undefined);
    const port: CoachVoicePort = tts;
    expect(port.available()).toBe(false);
  });
});

describe('tts bridge with the native module PRESENT', () => {
  it('forwards text with the fixed legacy rate 0.5 and stop() verbatim', () => {
    const speak = jest.fn();
    const stop = jest.fn();
    const tts = loadTts({ speak, stop });
    expect(tts.available()).toBe(true);
    tts.speak('Bend your knees.');
    tts.speak('');
    tts.stop();
    expect(speak.mock.calls).toEqual([
      ['Bend your knees.', 0.5],
      ['', 0.5],
    ]);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('availability is captured at module load, not per call (a late-registered module stays invisible)', () => {
    const tts = loadTts(undefined);
    (NativeModules as Record<string, unknown>).PickleAudioCoach = {
      speak: jest.fn(),
      stop: jest.fn(),
    };
    expect(tts.available()).toBe(false);
  });
});
