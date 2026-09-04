/**
 * STRUCTURAL AUDIT — apps/mobile/src/audio/tts.ts (pass 1, auditor #2).
 *
 * `tts.ts` is a plain available/speak/stop wrapper over the native
 * `PickleAudioCoach` module (AGENTS.md: "tts.ts is back to the plain
 * available/speak/stop port"; no JS callers in v1). These tests pin the JS-side
 * contract only — nothing here is a claim about AVSpeechSynthesizer or
 * AVAudioSession behaviour, which needs the Mac plane.
 *
 * Run: cd apps/mobile && npx jest --ci __tests__/audit.tts.holds.test.ts
 */
import { NativeModules } from 'react-native';

type NativeAudioCoachShape = {
  speak: jest.Mock;
  stop: jest.Mock;
  speakCue?: jest.Mock;
};

function loadTts(nativeModule: NativeAudioCoachShape | undefined) {
  jest.resetModules();
  if (nativeModule === undefined) {
    delete (NativeModules as Record<string, unknown>).PickleAudioCoach;
  } else {
    (NativeModules as Record<string, unknown>).PickleAudioCoach = nativeModule;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('../src/audio/tts') as typeof import('../src/audio/tts')).tts;
}

afterEach(() => {
  delete (NativeModules as Record<string, unknown>).PickleAudioCoach;
});

describe('HOLDS: tts.ts without the native module (JS-only / bridge missing)', () => {
  it('reports unavailable and speak/stop are silent no-ops (no throw, no crash)', () => {
    const tts = loadTts(undefined);
    expect(tts.available()).toBe(false);
    expect(() => tts.speak('hello')).not.toThrow();
    expect(() => tts.stop()).not.toThrow();
  });
});

describe('HOLDS: tts.ts with the native module present', () => {
  it('forwards speak(text) to the legacy speak(text, 0.5) path and stop() to stop()', () => {
    const native: NativeAudioCoachShape = {
      speak: jest.fn(),
      stop: jest.fn(),
      speakCue: jest.fn(),
    };
    const tts = loadTts(native);
    expect(tts.available()).toBe(true);
    tts.speak('6.4. Bend the knees more.');
    tts.stop();
    expect(native.speak).toHaveBeenCalledWith('6.4. Bend the knees more.', 0.5);
    expect(native.stop).toHaveBeenCalledTimes(1);
    // The port ignores cue categories: the native category-aware speakCue is
    // never reached from JS (dormant, per AGENTS.md).
    expect(native.speakCue).not.toHaveBeenCalled();
  });

  it('satisfies the LiveSessionCoach CoachVoicePort structurally: a speak() that returns void counts as spoken', () => {
    const native: NativeAudioCoachShape = { speak: jest.fn(), stop: jest.fn() };
    const tts = loadTts(native);
    // CoachVoicePort.speak may return void | boolean; void !== false → spoken.
    expect(tts.speak('x')).toBeUndefined();
  });

  it('a native handle that appears AFTER import is not picked up (handle captured once at module load)', () => {
    const tts = loadTts(undefined);
    expect(tts.available()).toBe(false);
    (NativeModules as Record<string, unknown>).PickleAudioCoach = {
      speak: jest.fn(),
      stop: jest.fn(),
    };
    // Documented behaviour of the current wrapper: the handle is resolved at
    // import time, so late registration is invisible to this instance.
    expect(tts.available()).toBe(false);
  });
});
