import { NativeModules } from 'react-native';

/**
 * AudioCoach TTS bridge → native AVSpeechSynthesizer module (ios/LocalPods).
 * Explicit availability: when the native module is missing the caller knows —
 * cues are shown on screen but not spoken. Never a silent fake.
 */

interface NativeAudioCoach {
  speak(text: string, rate: number): void;
  stop(): void;
}

const native: NativeAudioCoach | undefined = NativeModules.PickleAudioCoach as
  NativeAudioCoach | undefined;

export const tts = {
  available(): boolean {
    return Boolean(native?.speak);
  },
  speak(text: string): void {
    native?.speak(text, 0.5);
  },
  stop(): void {
    native?.stop();
  },
};
