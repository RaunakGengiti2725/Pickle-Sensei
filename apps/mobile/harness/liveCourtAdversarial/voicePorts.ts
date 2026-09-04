/**
 * Voice-port MODELS for the Live Court adversarial harness.
 *
 * The real port is native AVSpeechSynthesizer (ios/LocalPods/PickleNative/
 * Sources/PickleAudioCoach.swift) and cannot run on Linux. Everything here is
 * an explicit model of the JS-visible CoachVoicePort contract plus a virtual
 * clock queue whose interruption policies mirror the Swift module's three
 * documented modes ("immediate" / "word" / "enqueue"). Results are about the
 * cue stream the coach PRODUCES under overlap, not about Apple runtime truth.
 */
import type {
  CoachVoicePort,
  SpokenCueCategory,
} from '../../src/flow/liveSessionCoach';

export interface SpeakCall {
  seq: number;
  text: string;
  category: SpokenCueCategory | undefined;
}

/** Records every speak/stop call; `available` and `suppress` are adjustable. */
export class RecordingVoicePort implements CoachVoicePort {
  readonly calls: SpeakCall[] = [];
  stopCalls = 0;
  private seq = 0;

  constructor(
    private options: {
      available?: boolean;
      /** Return true to refuse the cue (speak() returns false). */
      suppress?: (category: SpokenCueCategory | undefined) => boolean;
      /** Throw on the Nth speak call (1-based). */
      throwOnCall?: number;
    } = {},
  ) {}

  setAvailable(available: boolean): void {
    this.options = { ...this.options, available };
  }

  available(): boolean {
    return this.options.available ?? true;
  }

  speak(
    text: string,
    options?: { category?: SpokenCueCategory },
  ): boolean | void {
    this.seq += 1;
    if (this.options.throwOnCall === this.seq) {
      throw new Error(`voice port failure injected on call ${this.seq}`);
    }
    if (this.options.suppress?.(options?.category)) return false;
    this.calls.push({ seq: this.seq, text, category: options?.category });
    return true;
  }

  stop(): void {
    this.stopCalls += 1;
  }
}

export type InterruptionPolicy = 'immediate' | 'word' | 'enqueue';

export interface UtteranceRecord {
  seq: number;
  text: string;
  category: SpokenCueCategory | undefined;
  enqueuedAtMs: number;
  durationMs: number;
  startedAtMs: number | null;
  endedAtMs: number | null;
  outcome:
    'completed' | 'cancelled' | 'never_started' | 'in_progress' | 'queued';
  /** Fraction of the utterance heard before cancellation (1 when completed). */
  heardFraction: number;
}

export interface SynthesizerModelOptions {
  /** Policy per category. Missing categories fall back to `defaultPolicy`. */
  policyFor?: (category: SpokenCueCategory | undefined) => InterruptionPolicy;
  defaultPolicy?: InterruptionPolicy;
  /** Speech duration model: ms per word (AVSpeech rate 0.5 ≈ 175 wpm ≈ 343ms/word). */
  msPerWord?: number;
  /** Fixed per-utterance overhead (audio session activation + synth start). */
  startupMs?: number;
}

/**
 * Virtual-clock synthesizer queue. `speak()` applies the interruption policy
 * exactly as PickleAudioCoach.speakResolved does: "immediate"/"word" call
 * stopSpeaking (which cancels the current utterance AND clears the queue —
 * AVSpeechSynthesizer semantics) then enqueue; "enqueue" appends. The "word"
 * mode is modelled as cancellation at the next word boundary.
 */
export class SynthesizerModelPort implements CoachVoicePort {
  readonly utterances: UtteranceRecord[] = [];
  stopCalls = 0;
  private nowMs = 0;
  private seq = 0;
  private current: UtteranceRecord | null = null;
  private queue: UtteranceRecord[] = [];
  private readonly msPerWord: number;
  private readonly startupMs: number;

  constructor(private readonly options: SynthesizerModelOptions = {}) {
    this.msPerWord = options.msPerWord ?? 343;
    this.startupMs = options.startupMs ?? 120;
  }

  now(): number {
    return this.nowMs;
  }

  available(): boolean {
    return true;
  }

  private durationFor(text: string): number {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    return this.startupMs + words * this.msPerWord;
  }

  private policy(category: SpokenCueCategory | undefined): InterruptionPolicy {
    return (
      this.options.policyFor?.(category) ??
      this.options.defaultPolicy ??
      'immediate'
    );
  }

  speak(
    text: string,
    options?: { category?: SpokenCueCategory },
  ): boolean | void {
    this.seq += 1;
    const record: UtteranceRecord = {
      seq: this.seq,
      text,
      category: options?.category,
      enqueuedAtMs: this.nowMs,
      durationMs: this.durationFor(text),
      startedAtMs: null,
      endedAtMs: null,
      outcome: 'queued',
      heardFraction: 0,
    };
    this.utterances.push(record);
    const policy = this.policy(options?.category);
    if (policy !== 'enqueue') {
      this.cancelAll(policy === 'word' ? 'word' : 'immediate');
    }
    this.queue.push(record);
    this.pump();
    return true;
  }

  /** Deliberate stop (mute / teardown): PickleAudioCoach.stop() → .word. */
  stop(): void {
    this.stopCalls += 1;
    this.cancelAll('word');
  }

  /** Advance the virtual clock, completing utterances as they finish. */
  advance(ms: number): void {
    const target = this.nowMs + ms;
    while (this.current) {
      const finishAt =
        (this.current.startedAtMs ?? this.nowMs) + this.current.durationMs;
      if (finishAt > target) break;
      this.nowMs = finishAt;
      this.current.endedAtMs = finishAt;
      this.current.outcome = 'completed';
      this.current.heardFraction = 1;
      this.current = null;
      this.pump();
    }
    this.nowMs = target;
  }

  /** Drain everything (end of scenario). */
  drain(): void {
    while (this.current || this.queue.length > 0) this.advance(60_000);
  }

  isSpeaking(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  private pump(): void {
    if (this.current) return;
    const next = this.queue.shift();
    if (!next) return;
    next.startedAtMs = this.nowMs;
    next.outcome = 'in_progress';
    this.current = next;
  }

  private cancelAll(boundary: 'immediate' | 'word'): void {
    if (this.current) {
      const started = this.current.startedAtMs ?? this.nowMs;
      let heardMs = this.nowMs - started;
      if (boundary === 'word') {
        // Finish the current word: round up to the next word boundary.
        const wordEnd =
          Math.ceil(Math.max(0, heardMs - this.startupMs) / this.msPerWord) *
            this.msPerWord +
          this.startupMs;
        heardMs = Math.min(this.current.durationMs, wordEnd);
      }
      this.current.endedAtMs = this.nowMs;
      this.current.outcome = 'cancelled';
      this.current.heardFraction = Math.max(
        0,
        Math.min(1, heardMs / this.current.durationMs),
      );
      this.current = null;
    }
    for (const queued of this.queue) {
      queued.outcome = 'never_started';
      queued.endedAtMs = this.nowMs;
    }
    this.queue = [];
  }
}

export interface SynthesizerMetrics {
  total: number;
  completed: number;
  cancelled: number;
  neverStarted: number;
  unfinished: number;
  completionRate: number;
  meanHeardFraction: number;
  /** Utterances heard to < 50%: the player got no usable cue. */
  underHalfHeard: number;
}

export function synthesizerMetrics(
  port: SynthesizerModelPort,
): SynthesizerMetrics {
  const all = port.utterances;
  const completed = all.filter(u => u.outcome === 'completed').length;
  const cancelled = all.filter(u => u.outcome === 'cancelled').length;
  const neverStarted = all.filter(u => u.outcome === 'never_started').length;
  const unfinished = all.filter(
    u => u.outcome === 'in_progress' || u.outcome === 'queued',
  ).length;
  const heard = all.reduce((sum, u) => sum + u.heardFraction, 0);
  return {
    total: all.length,
    completed,
    cancelled,
    neverStarted,
    unfinished,
    completionRate: all.length === 0 ? 1 : completed / all.length,
    meanHeardFraction: all.length === 0 ? 1 : heard / all.length,
    underHalfHeard: all.filter(u => u.heardFraction < 0.5).length,
  };
}

/** Category → policy mapping the CoachVoicePort docstring describes
 * ("urgent cues interrupt, calm session lines queue"). No JS port implements
 * it today (tts.ts is category-blind), so this is a MODEL of the intended
 * behaviour, used to compare against the shipped category-blind path. */
export function categoryAwarePolicy(
  category: SpokenCueCategory | undefined,
): InterruptionPolicy {
  switch (category) {
    case 'SESSION_START':
    case 'SESSION_END':
      return 'enqueue';
    case 'SETUP_GUIDANCE':
      return 'immediate';
    default:
      return 'word';
  }
}
