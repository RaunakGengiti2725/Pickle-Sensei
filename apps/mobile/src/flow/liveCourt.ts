import { analyzeClip } from '@pickle/analysis-pipeline';
import {
  INITIAL_COACH_STATE,
  selectCue,
  type CoachState,
  type CueDecision,
} from '@pickle/audio-coach-core';
import type {
  CheckpointKey,
  ShotAnalysis,
  ShotTypeSlug,
} from '@pickle/shared-types';
import type { VisionProviderSet } from '@pickle/vision-contracts';

/**
 * Live Court session engine (spec pp. 35–37): every rep → analyze → score →
 * cue. Pure TS core, driven by the screen; the same loop later moves against
 * the native rolling-buffer stroke trigger. Deterministic cue engine — no LLM.
 */

export interface LiveRep {
  repIndex: number;
  analysis: ShotAnalysis;
  cue: CueDecision;
  isPersonalBest: boolean;
}

export interface LiveSessionSummary {
  sessionId: string;
  validReps: number;
  lowConfidenceReps: number;
  startScore: number | null;
  endScore: number | null;
  bestScore: number | null;
  focusCheckpoint: CheckpointKey;
  focusStart: number | null;
  focusEnd: number | null;
  cuesSpoken: number;
}

export class LiveCourtEngine {
  private coachState: CoachState = INITIAL_COACH_STATE;
  private reps: LiveRep[] = [];
  private repCounter = 0;

  constructor(
    private readonly providers: VisionProviderSet,
    private readonly options: {
      sessionId: string;
      shotType: ShotTypeSlug;
      focusCheckpoint: CheckpointKey;
      handedness: 'right' | 'left' | 'ambidextrous';
      appVersion: string;
      modelBundleVersion: string;
      makeId: () => string;
    },
  ) {}

  /** Process one detected stroke window. */
  async onStroke(clip: {
    uri: string;
    durationMs: number;
    fps: number;
    width: number;
    height: number;
  }): Promise<LiveRep | null> {
    // Captured before the await: overlapping strokes must each keep their own
    // arrival-ordered index, whatever order their analyses settle in.
    const repIndex = ++this.repCounter;
    const result = await analyzeClip(this.providers, clip, {
      analysisId: this.options.makeId(),
      sessionId: this.options.sessionId,
      shotType: this.options.shotType,
      handedness: this.options.handedness,
      cameraView: 'side',
      appVersion: this.options.appVersion,
      modelBundleVersion: this.options.modelBundleVersion,
      capturedAtIso: new Date().toISOString(),
      focusCheckpoint: this.options.focusCheckpoint,
    });
    if (!result.ok) return null;
    const analysis = result.value;

    const focus = analysis.checkpoints.find(
      c => c.key === this.options.focusCheckpoint,
    );
    const previousBest = this.coachState.bestOverallScore;
    const { decision, nextState } = selectCue(this.coachState, {
      repIndex,
      resultKind: analysis.resultKind,
      overallScore: analysis.overallScore,
      focusCheckpoint: this.options.focusCheckpoint,
      focusScore: focus?.score ?? null,
      focusDirection: focus?.direction ?? 'none',
      focusSeverity: focus?.severity ?? 0,
    });
    this.coachState = nextState;
    const rep: LiveRep = {
      repIndex,
      analysis,
      cue: decision,
      isPersonalBest:
        analysis.overallScore !== null &&
        previousBest !== null &&
        analysis.overallScore > previousBest,
    };
    this.reps.push(rep);
    return rep;
  }

  allReps(): LiveRep[] {
    return [...this.reps];
  }

  summary(): LiveSessionSummary {
    const scored = this.reps.filter(r => r.analysis.resultKind === 'scored');
    const focusScores = scored
      .map(
        r =>
          r.analysis.checkpoints.find(
            c => c.key === this.options.focusCheckpoint,
          )?.score ?? null,
      )
      .filter((v): v is number => v !== null);
    const scores = scored
      .map(r => r.analysis.overallScore)
      .filter((v): v is number => v !== null);
    return {
      sessionId: this.options.sessionId,
      validReps: scored.length,
      lowConfidenceReps: this.reps.length - scored.length,
      startScore: scores[0] ?? null,
      endScore: scores[scores.length - 1] ?? null,
      bestScore: scores.length ? Math.max(...scores) : null,
      focusCheckpoint: this.options.focusCheckpoint,
      focusStart: focusScores[0] ?? null,
      focusEnd: focusScores[focusScores.length - 1] ?? null,
      cuesSpoken: this.reps.filter(r => r.cue.category !== 'SILENCE').length,
    };
  }
}
