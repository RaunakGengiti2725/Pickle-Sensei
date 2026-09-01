import {
  DEFAULT_LIVE_CUE_RULES,
  INITIAL_LIVE_COACH_STATE,
  selectLiveCue,
  sessionEndLine,
  sessionStartLine,
  type LiveCheckpointObservation,
  type LiveCoachSessionState,
  type LiveCueCategory,
  type LiveCueRules,
} from '@pickle/audio-coach-core';
import type { CheckpointKey } from '@pickle/shared-types';
import type { LiveSessionSnapshot, SessionEventView } from './session';
import { sessionScoreProgression } from './sessionProgress';

/**
 * LIVE SESSION COACH — the voice layer of Live Court.
 *
 * Consumes LiveSessionFlow snapshots, watches each stroke event reach a
 * terminal analysis outcome (the SAME canonical runCaptureAnalysis records
 * the rest of the product uses — never a parallel model), runs the
 * deterministic live cue policy over the analysis' checkpoints, and speaks
 * the cue through the voice port (native AVSpeechSynthesizer on iOS).
 *
 * Honesty rules carried through:
 *  - every spoken claim derives from a REAL analysis outcome (scored cue,
 *    honest "no read" for low-confidence/abstained, setup guidance);
 *  - an event is spoken about at most ONCE, in event order;
 *  - after the session ends the coach goes quiet — late-settling analyses
 *    still land in the summary, but nobody talks to an empty court;
 *  - muted/unavailable voice still logs the cue so the HUD caption can show
 *    it (deaf-friendly, silent-court friendly). `spoken` records the truth.
 */

export type SpokenCueCategory =
  | LiveCueCategory
  | 'SESSION_START'
  | 'SESSION_END';

export interface CoachVoicePort {
  available(): boolean;
  /**
   * Speaks a cue through the SELECTED coach voice. The category lets the
   * port apply real coaching speech behavior (urgent cues interrupt, calm
   * session lines queue, reduced feedback levels skip non-essential cues).
   * Returning false means the port deliberately did not voice this cue;
   * void/true both count as spoken (kept for existing simple ports).
   */
  speak(
    text: string,
    options?: { category?: SpokenCueCategory },
  ): boolean | void;
  stop(): void;
}

export interface SpokenCue {
  /** Stroke event this cue reacted to; null for session start/end lines. */
  eventId: string | null;
  category: SpokenCueCategory;
  text: string;
  targetCheckpoint: CheckpointKey | null;
  /** Session clock (ms) when the cue was produced. */
  atMs: number;
  /** True when the voice port actually spoke it (not muted, available). */
  spoken: boolean;
}

export interface LiveCoachRecap {
  cues: SpokenCue[];
  spokenCount: number;
  correctionsByCheckpoint: Partial<Record<CheckpointKey, number>>;
  /** The checkpoint corrected most often this session, if any. */
  topCorrection: CheckpointKey | null;
}

export interface LiveSessionCoachOptions {
  voice: CoachVoicePort;
  rules?: LiveCueRules;
  muted?: boolean;
  /** Observer for every produced cue (HUD captions). */
  onCue?: (cue: SpokenCue) => void;
}

/** True when the event carries a terminal analysis outcome the coach can
 * react to. Pending/processing events are not terminal — no cue yet. */
function terminalKind(
  event: SessionEventView,
): 'scored' | 'low_confidence' | 'abstained' | null {
  if (event.state === 'abstained') return 'abstained';
  if (event.state !== 'ready') return null;
  const result = event.analysis?.result ?? null;
  if (result === null) return 'low_confidence';
  if (result.resultKind === 'scored' && result.overallScore !== null) {
    return 'scored';
  }
  return 'low_confidence';
}

function checkpointObservations(
  event: SessionEventView,
): LiveCheckpointObservation[] {
  const result = event.analysis?.result ?? null;
  if (result === null) return [];
  return result.checkpoints.map(checkpoint => ({
    key: checkpoint.key,
    score: checkpoint.score,
    direction: checkpoint.direction,
    severity: checkpoint.severity,
    applicable: checkpoint.applicable,
  }));
}

export class LiveSessionCoach {
  private readonly voice: CoachVoicePort;
  private readonly rules: LiveCueRules;
  private readonly onCue: ((cue: SpokenCue) => void) | undefined;
  private state: LiveCoachSessionState = INITIAL_LIVE_COACH_STATE;
  private readonly consumedEventIds = new Set<string>();
  private readonly cues: SpokenCue[] = [];
  private repCounter = 0;
  private muted: boolean;
  private ended = false;

  constructor(options: LiveSessionCoachOptions) {
    this.voice = options.voice;
    this.rules = options.rules ?? DEFAULT_LIVE_CUE_RULES;
    this.muted = options.muted ?? false;
    this.onCue = options.onCue;
  }

  voiceAvailable(): boolean {
    return this.voice.available();
  }

  isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.voice.stop();
  }

  /** Opening line — lets the player confirm they can hear the coach before
   * the first swing. The replay line is honest about being a demo. */
  sessionStarted(source: 'live' | 'replay'): void {
    const text =
      source === 'live'
        ? sessionStartLine()
        : 'Demo rally replay. In a live session I call out every swing.';
    this.emit({
      eventId: null,
      category: 'SESSION_START',
      text,
      targetCheckpoint: null,
      atMs: 0,
    });
  }

  /** React to every event that newly reached a terminal outcome, in event
   * order. Safe to call with every snapshot — each event speaks once. */
  consumeSnapshot(snapshot: LiveSessionSnapshot): void {
    if (this.ended) return;
    for (const event of snapshot.events) {
      if (this.consumedEventIds.has(event.eventId)) continue;
      const kind = terminalKind(event);
      if (kind === null) continue;
      this.consumedEventIds.add(event.eventId);
      this.repCounter += 1;
      const result = event.analysis?.result ?? null;
      const { decision, nextState } = selectLiveCue(
        this.state,
        {
          repIndex: this.repCounter,
          kind,
          overallScore: kind === 'scored' ? result?.overallScore ?? null : null,
          checkpoints: checkpointObservations(event),
        },
        this.rules,
      );
      this.state = nextState;
      this.emit({
        eventId: event.eventId,
        category: decision.category,
        text: decision.text,
        targetCheckpoint: decision.targetCheckpoint,
        atMs: snapshot.durationMs,
      });
    }
  }

  /** Closing line with the honest start→end movement, then silence. The
   * recap is registered so LiveSummary can show what the coach said. */
  sessionEnded(finalSnapshot: LiveSessionSnapshot): LiveCoachRecap {
    if (!this.ended) {
      this.ended = true;
      const progression = sessionScoreProgression(finalSnapshot.events);
      this.emit({
        eventId: null,
        category: 'SESSION_END',
        text: sessionEndLine({
          scoredCount: progression.scoredCount,
          startAverage: progression.startAverage,
          endAverage: progression.endAverage,
          best: progression.best?.score ?? null,
        }),
        atMs: finalSnapshot.durationMs,
        targetCheckpoint: null,
      });
      completedCoachRecaps.set(finalSnapshot.sessionId, this.recap());
    }
    return this.recap();
  }

  /** Unmount/teardown: cut any in-flight utterance. Keeps the log. */
  dispose(): void {
    this.ended = true;
    this.voice.stop();
  }

  lastCue(): SpokenCue | null {
    return this.cues.at(-1) ?? null;
  }

  recap(): LiveCoachRecap {
    const correctionsByCheckpoint: Partial<Record<CheckpointKey, number>> = {};
    for (const cue of this.cues) {
      if (
        (cue.category === 'CORRECTION' ||
          cue.category === 'REPEAT_CORRECTION') &&
        cue.targetCheckpoint !== null
      ) {
        correctionsByCheckpoint[cue.targetCheckpoint] =
          (correctionsByCheckpoint[cue.targetCheckpoint] ?? 0) + 1;
      }
    }
    let topCorrection: CheckpointKey | null = null;
    let topCount = 0;
    for (const [checkpoint, count] of Object.entries(
      correctionsByCheckpoint,
    ) as Array<[CheckpointKey, number]>) {
      if (count > topCount) {
        topCorrection = checkpoint;
        topCount = count;
      }
    }
    return {
      cues: [...this.cues],
      spokenCount: this.cues.filter(cue => cue.spoken).length,
      correctionsByCheckpoint,
      topCorrection,
    };
  }

  private emit(cue: Omit<SpokenCue, 'spoken'>): void {
    const canSpeak = !this.muted && this.voice.available();
    // `spoken` records the truth: a port that suppressed the cue (reduced
    // feedback level, dispatch failure) returns false and the caption says
    // so; simple void-returning ports keep their historical behavior.
    const spoke = canSpeak
      ? this.voice.speak(cue.text, { category: cue.category }) !== false
      : false;
    const record: SpokenCue = { ...cue, spoken: spoke };
    this.cues.push(record);
    this.onCue?.(record);
  }
}

// ─── Completed-session coach recap registry (LiveSummary reads this) ───────

const completedCoachRecaps = new Map<string, LiveCoachRecap>();

export function getCompletedCoachRecap(
  sessionId: string,
): LiveCoachRecap | null {
  return completedCoachRecaps.get(sessionId) ?? null;
}
