/**
 * STRUCTURAL AUDIT — apps/mobile/src/audio/tts.ts (the only production
 * CoachVoicePort). No test covered this module before. Holds are pinned; the
 * one probe asserts the port contract the coach relies on for its `spoken`
 * flag (a port that could not dispatch returns false). Native AVSpeech /
 * AVAudioSession behaviour is NOT asserted here — that is Apple-plane truth.
 */
import { NativeModules } from 'react-native';
import type { CoachVoicePort } from '../src/flow/liveSessionCoach';

type NativeShape = { speak: jest.Mock; stop: jest.Mock } | undefined;

function loadTts(nativeModule: NativeShape) {
  const registry = NativeModules as unknown as Record<string, unknown>;
  if (nativeModule === undefined) delete registry.PickleAudioCoach;
  else registry.PickleAudioCoach = nativeModule;
  let loaded: { tts: CoachVoicePort } | null = null;
  jest.isolateModules(() => {
    loaded = jest.requireActual('../src/audio/tts') as { tts: CoachVoicePort };
  });
  if (loaded === null) throw new Error('tts module did not load');
  return (loaded as { tts: CoachVoicePort }).tts;
}

afterEach(() => {
  delete (NativeModules as unknown as Record<string, unknown>).PickleAudioCoach;
});

describe('AUDIT tts — holds', () => {
  it('reports unavailable when the native module is absent and never throws on speak/stop', () => {
    const tts = loadTts(undefined);
    expect(tts.available()).toBe(false);
    expect(() => tts.speak('hello', { category: 'PRAISE' })).not.toThrow();
    expect(() => tts.stop()).not.toThrow();
  });

  it('forwards text to the native module at the fixed spoken rate and stop() to native stop', () => {
    const native = { speak: jest.fn(), stop: jest.fn() };
    const tts = loadTts(native);
    expect(tts.available()).toBe(true);
    tts.speak('Bend the knees more.', { category: 'CORRECTION' });
    tts.stop();
    expect(native.speak).toHaveBeenCalledWith('Bend the knees more.', 0.5);
    expect(native.stop).toHaveBeenCalledTimes(1);
  });

  it('is a structural CoachVoicePort (compile-time) and drops the cue category by design (AGENTS.md: plain port)', () => {
    const native = { speak: jest.fn(), stop: jest.fn() };
    const port: CoachVoicePort = loadTts(native);
    port.speak('Session over.', { category: 'SESSION_END' });
    expect(native.speak.mock.calls[0]).toHaveLength(2);
  });
});

describe('AUDIT tts — probe', () => {
  it('a native speak() that throws surfaces as a false return, not an exception into the coach', () => {
    const native = {
      speak: jest.fn(() => {
        throw new Error('native bridge rejected');
      }),
      stop: jest.fn(),
    };
    const tts = loadTts(native);
    let outcome: unknown = 'not-called';
    let thrown: unknown = null;
    try {
      outcome = tts.speak('hello', { category: 'PRAISE' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeNull();
    expect(outcome).toBe(false);
  });
});
