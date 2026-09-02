import type { StrokeIntentEnvelope } from '@pickle/analysis-pipeline';
import type {
  CheckpointKey,
  CheckpointScore,
  FaultDirection,
  PhaseKey,
  PhaseSpan,
  ScoreBand,
  ShotAnalysis,
} from '@pickle/shared-types';
import type { ContactEstimate } from '@pickle/vision-geometry';
import {
  ANALYSIS_TIMELINE_CAPTION,
  ANCHOR_FREE_CAPTION,
  MEASUREMENT_SCOPE_NOTE,
  MODALITY_SCOPE_FACTORS,
  abstentionLedger,
  analysisContactMs,
  attemptChips,
  contactHaloHalfWidthMs,
  contactMarkerPresentation,
  effectivePhaseTimeline,
  isAbstainedResult,
  isModalityScopeFactor,
  measuredRows,
  phaseTimelineFromAnalysis,
  phaseTimelinePresentation,
  selectInsight,
  strokeResultHeader,
  visibleMeasuredRows,
  type StrokeResultEvidenceRecord,
  type TemporalPhasesV2,
} from '../src/components/strokeResultModel';
import { coachingCue, fixList } from '../src/review/formReviewModel';

/**
 * W8 — canonical Stroke Result selectors.
 *
 * Every rendered element is honest-evidence gated: contact markers follow
 * the usable-result-v1 gate, phase strips render from a segmented
 * temporalPhasesV2 (including W5's anchor-free mode) or else from the
 * analysis' own measured phases, the ONE insight comes from the strongest
 * defensible evidence in fixed priority (a scored analysis' measured
 * checkpoints outrank the lab-chain records), structural modality tokens
 * are never phrased as a per-capture failure, and attempts never rank.
 */

// ─── Fixtures ───────────────────────────────────────────────────────────────

function phase(
  key: PhaseKey,
  startMs: number,
  endMs: number,
  representativeMs = startMs + (endMs - startMs) / 2,
): PhaseSpan {
  return { key, startMs, representativeMs, endMs, confidence: 0.8 };
}

/** The on-device segmenter's shape: ready | prepare | accelerate | contact
 * (peak ± half a sample) | follow_through | recover, clip-relative ms. */
const MEASURED_PHASES: PhaseSpan[] = [
  phase('ready', 2000, 2100),
  phase('prepare', 2100, 2250),
  phase('accelerate', 2250, 2384),
  phase('contact', 2384, 2416, 2400),
  phase('follow_through', 2416, 2600),
  phase('recover', 2600, 2700),
];

function checkpoint(
  key: CheckpointKey,
  score: number | null,
  band: ScoreBand,
  direction: FaultDirection,
  overrides: Partial<CheckpointScore> = {},
): CheckpointScore {
  return {
    key,
    score,
    confidence: 0.8,
    band,
    direction,
    severity: score === null ? 0 : (100 - score) / 100,
    applicable: true,
    ...overrides,
  };
}

/** A realistic scored read: three faults (contact worst, engine priority),
 * one inapplicable, one unscored, the rest green. */
const SCORED_CHECKPOINTS: CheckpointScore[] = [
  checkpoint('ready_position', 85, 'green', 'none'),
  checkpoint('athletic_base', 72, 'yellow', 'narrow'),
  checkpoint('preparation', 88, 'green', 'none'),
  checkpoint('paddle_set', 90, 'green', 'none'),
  checkpoint('swing_length', null, 'unscored', 'none'),
  checkpoint('sequencing', 82, 'green', 'none'),
  checkpoint('paddle_path', 61, 'red', 'low'),
  checkpoint('contact_position', 48, 'red', 'late'),
  checkpoint('face_wrist_stability', 30, 'red', 'unstable', {
    applicable: false,
  }),
  checkpoint('follow_through', 80, 'green', 'none'),
  checkpoint('recovery', 92, 'green', 'none'),
];

const ALL_GREEN_CHECKPOINTS: CheckpointScore[] = [
  checkpoint('ready_position', 85, 'green', 'none'),
  checkpoint('athletic_base', 79, 'green', 'none'),
  checkpoint('preparation', 88, 'green', 'none'),
  checkpoint('contact_position', 91, 'green', 'none'),
  checkpoint('follow_through', 83, 'green', 'none'),
];

/** Every on-device record carries the three structural modality tokens. */
const STRUCTURAL_FACTORS = [...MODALITY_SCOPE_FACTORS];

function scoredAnalysis(overrides: Partial<ShotAnalysis> = {}): ShotAnalysis {
  return analysisFixture({
    timestamps: { startMs: 2000, contactMs: 2400, endMs: 2700 },
    phases: MEASURED_PHASES.map(span => ({ ...span })),
    checkpoints: SCORED_CHECKPOINTS.map(cp => ({ ...cp })),
    priorityFix: {
      checkpoint: 'contact_position',
      reasonKey: 'lowest_score',
      severity: 0.52,
      confidence: 0.8,
    },
    ...overrides,
  });
}

function analysisFixture(overrides: Partial<ShotAnalysis> = {}): ShotAnalysis {
  return {
    id: 'analysis-1',
    sessionId: null,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-08-30T10:00:00.000Z',
    timestamps: { startMs: 2000, contactMs: null, endMs: 2700 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: 7.4,
    analysisConfidence: 0.82,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'on-device-fusion-1',
      poseModelVersion: 'apple-vision-bodypose-1',
      paddleModelVersion: 'none',
      strokeDetectorVersion: 'temporal-stroke-heuristic-2',
      phaseModelVersion: 'phase-heuristic-1',
      scoringModelVersion: 'scoring-1',
      shotConfigVersion: 'config-1',
    },
    source: 'real',
    ...overrides,
  };
}

function envelope(
  overrides: Partial<StrokeIntentEnvelope> = {},
): StrokeIntentEnvelope {
  return {
    declaredStroke: 'forehand_drive',
    predictedStroke: null,
    resolutionBasis: 'declared',
    resolvedProfileId: 'FOREHAND_DRIVE',
    resolvedProfileVersion: 'technique-profile-v1',
    disagreement: null,
    ...overrides,
  };
}

function estimatedContact(
  overrides: Partial<Extract<ContactEstimate, { status: 'estimated' }>> = {},
): ContactEstimate {
  return {
    status: 'estimated',
    estimatedContactMs: 2400,
    confidence: 0.7,
    ballConfirmed: false,
    paddleConfirmed: false,
    limitingFactors: [],
    supportingEvidence: [],
    ...overrides,
  };
}

function segmentedPhases(
  overrides: Partial<
    Extract<TemporalPhasesV2, { status: 'segmented' }>['boundaries']
  > = {},
): TemporalPhasesV2 {
  return {
    status: 'segmented',
    boundaries: {
      version: 'phase.paddle-temporal.v2 (heuristic, uncalibrated)',
      source: 'paddle',
      anchor: 'contact_estimate',
      confidence: 0.6,
      preparationStartMs: 2050,
      accelerationStartMs: 2200,
      contactMs: 2400,
      followThroughEndMs: 2600,
      recoveryEndMs: 2680,
      ...overrides,
    },
  };
}

// ─── §1.1 Title + honest source subtitle ────────────────────────────────────

describe('strokeResultHeader', () => {
  it('declared run: title from the declaration, "you chose this" subtitle', () => {
    const header = strokeResultHeader(
      { id: 'r1', strokeIntent: envelope(), result: null },
      analysisFixture(),
    );
    expect(header.title).toBe('Forehand drive');
    expect(header.subtitle).toBe('You chose this technique.');
    expect(header.tone).toBe('neutral');
  });

  it('declared-vs-predicted disagreement is a calm first-class line, declaration kept', () => {
    const header = strokeResultHeader(
      {
        id: 'r1',
        strokeIntent: envelope({
          disagreement: {
            declared: 'dink',
            predictedLabel: 'BACKHAND',
            basis: 'side_vs_declared',
          },
        }),
        result: null,
      },
      analysisFixture({ shotType: 'dink' }),
    );
    expect(header.title).toBe('Dink');
    expect(header.subtitle).toContain('Predicted BACKHAND');
    expect(header.subtitle).toContain('differs from your declared dink');
    expect(header.subtitle).toContain('neither overwrites the other');
    expect(header.tone).toBe('attention');
  });

  it('auto family read: family-level truth, no exact stroke claimed', () => {
    const header = strokeResultHeader(
      {
        id: 'r1',
        strokeIntent: envelope({
          declaredStroke: null,
          resolutionBasis: 'predicted_family',
          resolvedProfileId: 'SHARED_FOREHAND_SWING',
          predictedStroke: {
            taxonomyVersion: 'pickleball-stroke-taxonomy-v3',
            classifierVersion: 'stroke-heuristic-1 (uncalibrated)',
            label: 'FOREHAND',
            leaf: null,
            taxonomyDepth: 2,
            confidence: 0.6,
            evidence: [],
            limitingFactors: [],
          },
        }),
        result: null,
      },
      null,
    );
    expect(header.eyebrow).toBe('AUTO-DETECTED · FAMILY-LEVEL');
    expect(header.title).toBe('Forehand swing');
    expect(header.subtitle).toContain('exact stroke was not claimed');
  });

  it('abstention: no label invented', () => {
    const header = strokeResultHeader(
      {
        id: 'r1',
        strokeIntent: envelope({
          declaredStroke: null,
          resolutionBasis: 'abstained',
          resolvedProfileId: null,
          resolvedProfileVersion: null,
        }),
        result: null,
      },
      null,
    );
    expect(header.title).toBe('Stroke not identified');
    expect(header.subtitle).toContain('no label was invented');
  });

  it('record without a strokeIntent envelope claims no provenance', () => {
    const header = strokeResultHeader(null, analysisFixture());
    expect(header.title).toBe('Forehand drive');
    expect(header.subtitle).toBe('From your saved analysis on this device.');
  });
});

// ─── §1.2 Contact marker (usable-result-v1 gate) ────────────────────────────

describe('contactMarkerPresentation', () => {
  it('estimated + ballConfirmed → marker with ball caption', () => {
    const marker = contactMarkerPresentation(
      estimatedContact({ ballConfirmed: true, confidence: 0.4 }),
    );
    expect(marker.kind).toBe('marker');
    if (marker.kind === 'marker') {
      expect(marker.contactMs).toBe(2400);
      expect(marker.confirmation).toBe('ball');
      expect(marker.caption).toBe('Ball-confirmed');
    }
  });

  it('estimated + paddleConfirmed → marker even below the confidence floor', () => {
    const marker = contactMarkerPresentation(
      estimatedContact({ paddleConfirmed: true, confidence: 0.3 }),
    );
    expect(marker.kind).toBe('marker');
    if (marker.kind === 'marker') expect(marker.confirmation).toBe('paddle');
  });

  it('both confirmations → ball_and_paddle caption', () => {
    const marker = contactMarkerPresentation(
      estimatedContact({ ballConfirmed: true, paddleConfirmed: true }),
    );
    if (marker.kind === 'marker') {
      expect(marker.confirmation).toBe('ball_and_paddle');
      expect(marker.caption).toBe('Ball + paddle confirmed');
    } else {
      throw new Error('expected marker');
    }
  });

  it('unconfirmed estimate at exactly 0.6 confidence → motion marker', () => {
    const marker = contactMarkerPresentation(
      estimatedContact({ confidence: 0.6 }),
    );
    expect(marker.kind).toBe('marker');
    if (marker.kind === 'marker') expect(marker.confirmation).toBe('motion');
  });

  it('unconfirmed estimate below 0.6 → NO marker, honest line instead', () => {
    const marker = contactMarkerPresentation(
      estimatedContact({ confidence: 0.59 }),
    );
    expect(marker.kind).toBe('not_established');
    if (marker.kind === 'not_established') {
      expect(marker.caption).toContain('Exact contact not established');
      expect(marker.caption).toContain('no marker is drawn');
    }
  });

  it('abstention → NO marker; reason surfaces in the honest line', () => {
    const marker = contactMarkerPresentation({
      status: 'abstained',
      reason: 'insufficient_evidence_mass',
    });
    expect(marker.kind).toBe('not_established');
    if (marker.kind === 'not_established') {
      expect(marker.caption).toContain('insufficient evidence mass');
    }
  });

  it('absent contact field (today’s on-device records) → honest line, nothing invented', () => {
    const marker = contactMarkerPresentation(undefined);
    expect(marker.kind).toBe('not_established');
  });

  it('halo width is visual uncertainty: monotonically wider as confidence drops', () => {
    expect(contactHaloHalfWidthMs(1)).toBeLessThan(contactHaloHalfWidthMs(0.7));
    expect(contactHaloHalfWidthMs(0.7)).toBeLessThan(
      contactHaloHalfWidthMs(0.3),
    );
    expect(contactHaloHalfWidthMs(1)).toBe(33);
    expect(contactHaloHalfWidthMs(0)).toBe(165);
  });
});

// ─── §1.2 Phase timeline (temporalPhasesV2 only, incl. anchor-free) ────────

describe('phaseTimelinePresentation', () => {
  it('anchored segmented → ordered colored segments plus a contact tick', () => {
    const timeline = phaseTimelinePresentation(segmentedPhases());
    expect(timeline.kind).toBe('segments');
    if (timeline.kind === 'segments') {
      expect(timeline.segments.map(segment => segment.key)).toEqual([
        'preparation',
        'acceleration',
        'follow_through',
        'recovery',
      ]);
      expect(timeline.contactTickMs).toBe(2400);
      expect(timeline.anchorFree).toBe(false);
      expect(timeline.caption).toBeNull();
    }
  });

  it('anchor-free (anchorBasis event_peak, contactMs null) → NO contact tick + motion-evidence caption', () => {
    const timeline = phaseTimelinePresentation(
      segmentedPhases({
        anchor: 'speed_peak',
        anchorBasis: 'event_peak',
        contactMs: null,
        motionPeakMs: 2380,
        source: 'wrist',
      }),
    );
    expect(timeline.kind).toBe('segments');
    if (timeline.kind === 'segments') {
      expect(timeline.contactTickMs).toBeNull();
      expect(timeline.anchorFree).toBe(true);
      expect(timeline.caption).toBe(ANCHOR_FREE_CAPTION);
      expect(timeline.segments.map(segment => segment.key)).toEqual([
        'preparation',
        'acceleration',
        'follow_through',
        'recovery',
      ]);
    }
  });

  it('anchor-free with in-process NaN contactMs and no motion peak → single swing segment, no tick', () => {
    const timeline = phaseTimelinePresentation(
      segmentedPhases({
        anchorBasis: 'event_peak',
        contactMs: Number.NaN,
        preparationStartMs: null,
        recoveryEndMs: null,
      }),
    );
    expect(timeline.kind).toBe('segments');
    if (timeline.kind === 'segments') {
      expect(timeline.segments.map(segment => segment.key)).toEqual(['swing']);
      expect(timeline.contactTickMs).toBeNull();
    }
  });

  it('abstained → no segments, reason carried', () => {
    const timeline = phaseTimelinePresentation({
      status: 'abstained',
      reason: 'PHASE_NO_MOTION_EVIDENCE',
    });
    expect(timeline).toEqual({
      kind: 'none',
      reason: 'PHASE NO MOTION EVIDENCE',
    });
  });

  it('absent field (today’s records) → nothing rendered, nothing claimed', () => {
    expect(phaseTimelinePresentation(undefined)).toEqual({
      kind: 'none',
      reason: null,
    });
  });

  it('disordered boundaries are withheld, not drawn', () => {
    const timeline = phaseTimelinePresentation(
      segmentedPhases({ contactMs: 2100 }), // before accelerationStartMs
    );
    expect(timeline.kind).toBe('none');
  });

  it('anchored output with a non-finite contact boundary is malformed → withheld', () => {
    const timeline = phaseTimelinePresentation(
      segmentedPhases({ contactMs: null }),
    );
    expect(timeline.kind).toBe('none');
  });
});

// ─── §1.2 Phase timeline from the analysis' MEASURED phases ────────────────

describe('phaseTimelineFromAnalysis', () => {
  it('maps the on-device spans to ordered segments with the wrist-peak tick', () => {
    const timeline = phaseTimelineFromAnalysis(scoredAnalysis());
    expect(timeline.kind).toBe('segments');
    if (timeline.kind !== 'segments') return;
    // ready and contact are not segments; the rest map in measured order.
    expect(timeline.segments).toEqual([
      { key: 'preparation', startMs: 2100, endMs: 2250 },
      { key: 'acceleration', startMs: 2250, endMs: 2384 },
      { key: 'follow_through', startMs: 2416, endMs: 2600 },
      { key: 'recovery', startMs: 2600, endMs: 2700 },
    ]);
    expect(timeline.contactTickMs).toBe(2400); // contact.representativeMs
    expect(timeline.anchorFree).toBe(false);
    expect(timeline.source).toBe('wrist');
    expect(timeline.origin).toBe('analysis');
    expect(timeline.caption).toBe(ANALYSIS_TIMELINE_CAPTION);
  });

  it('a missing prepare/recover simply yields fewer segments', () => {
    const timeline = phaseTimelineFromAnalysis(
      scoredAnalysis({
        phases: MEASURED_PHASES.filter(
          span => span.key !== 'prepare' && span.key !== 'recover',
        ),
      }),
    );
    expect(timeline.kind).toBe('segments');
    if (timeline.kind !== 'segments') return;
    expect(timeline.segments.map(segment => segment.key)).toEqual([
      'acceleration',
      'follow_through',
    ]);
    expect(timeline.contactTickMs).toBe(2400);
  });

  it('falls back to timestamps.contactMs when no contact span exists, else anchor-free', () => {
    const noContactSpan = phaseTimelineFromAnalysis(
      scoredAnalysis({
        phases: MEASURED_PHASES.filter(span => span.key !== 'contact'),
      }),
    );
    expect(noContactSpan.kind).toBe('segments');
    if (noContactSpan.kind === 'segments') {
      expect(noContactSpan.contactTickMs).toBe(2400);
      expect(noContactSpan.anchorFree).toBe(false);
    }

    const noContactAtAll = phaseTimelineFromAnalysis(
      scoredAnalysis({
        timestamps: { startMs: 2000, contactMs: null, endMs: 2700 },
        phases: MEASURED_PHASES.filter(span => span.key !== 'contact'),
      }),
    );
    expect(noContactAtAll.kind).toBe('segments');
    if (noContactAtAll.kind === 'segments') {
      expect(noContactAtAll.contactTickMs).toBeNull();
      expect(noContactAtAll.anchorFree).toBe(true);
      expect(noContactAtAll.caption).toBe(ANCHOR_FREE_CAPTION);
    }

    const nanRepresentative = phaseTimelineFromAnalysis(
      scoredAnalysis({
        phases: MEASURED_PHASES.map(span =>
          span.key === 'contact'
            ? { ...span, representativeMs: Number.NaN }
            : span,
        ),
      }),
    );
    if (nanRepresentative.kind === 'segments') {
      expect(nanRepresentative.contactTickMs).toBe(2400); // timestamps
    } else {
      throw new Error('expected segments');
    }
  });

  it('nothing is drawn from null, empty, single-span or non-segment spans', () => {
    expect(phaseTimelineFromAnalysis(null)).toEqual({
      kind: 'none',
      reason: null,
    });
    expect(phaseTimelineFromAnalysis(undefined)).toEqual({
      kind: 'none',
      reason: null,
    });
    expect(phaseTimelineFromAnalysis(analysisFixture({ phases: [] }))).toEqual({
      kind: 'none',
      reason: null,
    });
    expect(
      phaseTimelineFromAnalysis(
        analysisFixture({ phases: [phase('prepare', 2100, 2250)] }),
      ).kind,
    ).toBe('none');
    // ready + contact only: two spans but no segment to draw.
    expect(
      phaseTimelineFromAnalysis(
        analysisFixture({
          phases: [phase('ready', 2000, 2100), phase('contact', 2384, 2416)],
        }),
      ).kind,
    ).toBe('none');
  });

  it('non-finite or disordered spans are withheld, never repaired', () => {
    expect(
      phaseTimelineFromAnalysis(
        analysisFixture({
          phases: [
            phase('prepare', 2100, Number.NaN),
            phase('accelerate', 2250, 2384),
          ],
        }),
      ).kind,
    ).toBe('none');
    const disordered = phaseTimelineFromAnalysis(
      analysisFixture({
        phases: [
          phase('accelerate', 2250, 2384),
          phase('prepare', 2100, 2250), // starts before the previous span ends
        ],
      }),
    );
    expect(disordered).toEqual({
      kind: 'none',
      reason: 'phase spans out of order',
    });
  });

  it('analysisContactMs prefers the measured contact span over the recorded trigger', () => {
    expect(analysisContactMs(scoredAnalysis())).toBe(2400);
    expect(
      analysisContactMs(
        scoredAnalysis({
          phases: MEASURED_PHASES.map(span =>
            span.key === 'contact' ? { ...span, representativeMs: 2390 } : span,
          ),
        }),
      ),
    ).toBe(2390);
    expect(
      analysisContactMs(
        analysisFixture({
          timestamps: { startMs: 2000, contactMs: 2410, endMs: 2700 },
        }),
      ),
    ).toBe(2410);
    expect(analysisContactMs(analysisFixture())).toBeNull();
    expect(analysisContactMs(null)).toBeNull();
  });
});

describe('effectivePhaseTimeline', () => {
  it('a segmented record wins over the analysis phases', () => {
    const timeline = effectivePhaseTimeline(
      { id: 'r1', temporalPhasesV2: segmentedPhases() },
      scoredAnalysis(),
    );
    expect(timeline.kind).toBe('segments');
    if (timeline.kind === 'segments') {
      expect(timeline.origin).toBe('record');
      expect(timeline.source).toBe('paddle');
    }
  });

  it('falls back to the analysis phases when the record has none (today’s on-device records)', () => {
    const timeline = effectivePhaseTimeline({ id: 'r1' }, scoredAnalysis());
    expect(timeline.kind).toBe('segments');
    if (timeline.kind === 'segments') {
      expect(timeline.origin).toBe('analysis');
      expect(timeline.contactTickMs).toBe(2400);
    }
    // record.result stands in when no separate analysis is passed.
    const fromRecordResult = effectivePhaseTimeline(
      { id: 'r1', result: scoredAnalysis() },
      null,
    );
    expect(fromRecordResult.kind).toBe('segments');
  });

  it('an abstained record with a malformed/absent analysis keeps its reason', () => {
    expect(
      effectivePhaseTimeline(
        {
          id: 'r1',
          temporalPhasesV2: {
            status: 'abstained',
            reason: 'PHASE_NO_MOTION_EVIDENCE',
          },
        },
        analysisFixture(),
      ),
    ).toEqual({ kind: 'none', reason: 'PHASE NO MOTION EVIDENCE' });
    // But measured analysis phases beat a record abstention.
    expect(
      effectivePhaseTimeline(
        {
          id: 'r1',
          temporalPhasesV2: { status: 'abstained', reason: 'no_paddle_track' },
        },
        scoredAnalysis(),
      ).kind,
    ).toBe('segments');
    expect(effectivePhaseTimeline(null, null)).toEqual({
      kind: 'none',
      reason: null,
    });
  });
});

// ─── §1.3 ONE insight — fixed priority ──────────────────────────────────────

describe('selectInsight priority', () => {
  const disagreementEnvelope = envelope({
    disagreement: {
      declared: 'forehand_drive',
      predictedLabel: 'BACKHAND',
      basis: 'side_vs_declared',
    },
  });

  it('disagreement beats every other evidence source', () => {
    const insight = selectInsight({
      strokeIntent: disagreementEnvelope,
      contact: estimatedContact({ ballConfirmed: true, paddleConfirmed: true }),
      temporalPhasesV2: segmentedPhases(),
      limitingFactors: ['paddle_track_missing'],
      analysis: scoredAnalysis(),
    });
    expect(insight.basis).toBe('disagreement');
    expect(insight.sentence).toContain('You declared forehand drive');
    expect(insight.sentence).toContain('BACKHAND');
  });

  it('a scored analysis outranks contact/timeline records: worst measured fault + matching cue', () => {
    const analysis = scoredAnalysis();
    const insight = selectInsight({
      strokeIntent: envelope(),
      contact: estimatedContact({ ballConfirmed: true }),
      temporalPhasesV2: segmentedPhases(),
      limitingFactors: STRUCTURAL_FACTORS,
      analysis,
    });
    expect(insight.basis).toBe('measured_fault');
    // Headline from the engine's own number and measured direction, then
    // the form-review cue for that direction, verbatim.
    expect(insight.sentence).toBe(
      'Contact position scored 48 — contact came late. ' +
        coachingCue('contact_position', 'late', 'forehand_drive'),
    );
    expect(insight.sentence).toBe(
      `${fixList(analysis, 1)[0]!.headline}. ${fixList(analysis, 1)[0]!.cue}`,
    );
    expect(insight.sentence).toBe(
      'Contact position scored 48 — contact came late. Meet the ball further ' +
        'out in front — start the swing earlier so contact happens ahead of ' +
        'your front hip.',
    );
    expect(insight.sentence).not.toContain('paddle track');
  });

  it('the engine’s priorityFix leads even when another checkpoint scored lower', () => {
    const insight = selectInsight({
      analysis: scoredAnalysis({
        priorityFix: {
          checkpoint: 'paddle_path',
          reasonKey: 'dependency',
          severity: 0.4,
          confidence: 0.8,
        },
      }),
    });
    expect(insight.basis).toBe('measured_fault');
    expect(
      insight.sentence.startsWith('Paddle path scored 61 — sat low.'),
    ).toBe(true);
  });

  it('every checkpoint green → measured_clean names the strongest with its score', () => {
    const insight = selectInsight({
      limitingFactors: STRUCTURAL_FACTORS,
      analysis: scoredAnalysis({
        checkpoints: ALL_GREEN_CHECKPOINTS,
        priorityFix: null,
      }),
    });
    expect(insight).toEqual({
      basis: 'measured_clean',
      sentence:
        'Every measured checkpoint held its target — strongest was Contact ' +
        'position at 91.',
    });
  });

  it('a scored result whose checkpoints carry no readable score claims nothing about them', () => {
    // No participating checkpoint: neither a fault nor "everything held" is
    // defensible, so the remaining chain decides (here: the timeline).
    const insight = selectInsight({
      strokeIntent: envelope(),
      temporalPhasesV2: segmentedPhases(),
      analysis: analysisFixture({ checkpoints: [] }),
    });
    expect(insight.basis).toBe('phase_timeline');
  });

  it('an unscored (low-confidence) analysis never takes the scored branch', () => {
    const insight = selectInsight({
      strokeIntent: envelope(),
      contact: estimatedContact({ ballConfirmed: true }),
      analysis: scoredAnalysis({
        resultKind: 'low_confidence',
        overallScore: null,
      }),
    });
    expect(insight.basis).toBe('contact_confirmation');
  });

  it('contact confirmation beats the phase timeline', () => {
    const insight = selectInsight({
      strokeIntent: envelope(),
      contact: estimatedContact({ ballConfirmed: true }),
      temporalPhasesV2: segmentedPhases(),
    });
    expect(insight.basis).toBe('contact_confirmation');
    expect(insight.sentence).toContain('ball-track evidence');
  });

  it('an undefensible contact falls through to the phase timeline', () => {
    const insight = selectInsight({
      strokeIntent: envelope(),
      contact: estimatedContact({ confidence: 0.3 }),
      temporalPhasesV2: segmentedPhases(),
    });
    expect(insight.basis).toBe('phase_timeline');
    expect(insight.sentence).toContain('paddle motion');
  });

  it('anchor-free timeline insight admits the missing contact', () => {
    const insight = selectInsight({
      strokeIntent: envelope(),
      temporalPhasesV2: segmentedPhases({
        anchorBasis: 'event_peak',
        contactMs: null,
        motionPeakMs: 2380,
      }),
    });
    expect(insight.basis).toBe('phase_timeline');
    expect(insight.sentence).toContain(
      'exact contact moment was not established',
    );
  });

  it('with nothing defensible, the insight is the abstention explanation', () => {
    const insight = selectInsight({
      strokeIntent: envelope({
        declaredStroke: null,
        resolutionBasis: 'abstained',
        resolvedProfileId: null,
        resolvedProfileVersion: null,
      }),
      limitingFactors: ['single_modality_pose_only'],
    });
    expect(insight.basis).toBe('abstention');
    expect(insight.sentence).toContain('didn’t guess');
    expect(insight.sentence).toContain('single modality pose only');
  });

  it('limiting factors alone produce an honest could-not-establish sentence', () => {
    const insight = selectInsight({
      limitingFactors: ['low_pose_confidence'],
    });
    expect(insight.basis).toBe('abstention');
    expect(insight.sentence).toContain('low pose confidence');
    expect(insight.sentence).toContain('Nothing was invented');
  });

  it('known machine tokens read as grammatical sentences, never raw tokens', () => {
    const checkpoint = selectInsight({
      limitingFactors: ['checkpoint_unobserved:face_wrist_stability'],
    });
    expect(checkpoint.sentence).toContain(
      'a read on the face / wrist stability checkpoint',
    );
    expect(checkpoint.sentence).not.toContain('unobserved:face');

    const confidence = selectInsight({
      limitingFactors: ['analysis_confidence_below_threshold'],
    });
    expect(confidence.sentence).toContain(
      'enough confidence to score this stroke',
    );
    expect(confidence.sentence).not.toContain('below threshold —');
  });

  it('structural modality tokens are NEVER the insight — they are scope, not a failure', () => {
    for (const token of MODALITY_SCOPE_FACTORS) {
      expect(isModalityScopeFactor(token)).toBe(true);
    }
    expect(isModalityScopeFactor('checkpoint_unobserved:recovery')).toBe(false);

    // Only structural tokens: the generic honest line, not "couldn't
    // establish a paddle track".
    const onlyStructural = selectInsight({
      limitingFactors: STRUCTURAL_FACTORS,
    });
    expect(onlyStructural).toEqual({
      basis: 'abstention',
      sentence:
        'Nothing beyond what is shown could be established from this ' +
        'capture — nothing was invented.',
    });

    // Structural tokens first, a per-analysis factor after: the per-analysis
    // factor is the insight.
    const mixed = selectInsight({
      limitingFactors: [
        ...STRUCTURAL_FACTORS,
        'checkpoint_unobserved:face_wrist_stability',
      ],
    });
    expect(mixed.sentence).toContain(
      'a read on the face / wrist stability checkpoint',
    );
    expect(mixed.sentence).not.toContain('paddle');
    expect(mixed.sentence).not.toContain('ball track');
    expect(mixed.sentence).not.toContain('court geometry');
  });

  it('abstained-intent insight uses the reason form of the first per-analysis token', () => {
    const abstained = envelope({
      declaredStroke: null,
      resolutionBasis: 'abstained',
      resolvedProfileId: null,
      resolvedProfileVersion: null,
    });
    const insight = selectInsight({
      strokeIntent: abstained,
      limitingFactors: [
        ...STRUCTURAL_FACTORS,
        'analysis_confidence_below_threshold',
      ],
    });
    expect(insight.sentence).toContain(
      'the read was limited by analysis confidence below the scoring threshold.',
    );
    expect(insight.sentence).not.toContain('paddle track');

    const structuralOnly = selectInsight({
      strokeIntent: abstained,
      limitingFactors: STRUCTURAL_FACTORS,
    });
    expect(structuralOnly.sentence).toBe(
      'We couldn’t identify this stroke and didn’t guess — the motion didn’t ' +
        'give the classifier enough to commit.',
    );
  });
});

// ─── §1.4 Measured rows ─────────────────────────────────────────────────────

describe('measuredRows', () => {
  it('derives rows only from fields that exist, with provenance labels', () => {
    const record: StrokeResultEvidenceRecord = {
      id: 'r1',
      strokeIntent: envelope({
        predictedStroke: {
          taxonomyVersion: 'pickleball-stroke-taxonomy-v3',
          classifierVersion: 'stroke-heuristic-1 (uncalibrated)',
          label: 'FOREHAND',
          leaf: null,
          taxonomyDepth: 2,
          confidence: 0.6,
          evidence: [],
          limitingFactors: [],
        },
      }),
      contact: estimatedContact({ ballConfirmed: true }),
      temporalPhasesV2: segmentedPhases(),
      result: null,
    };
    const rows = measuredRows({ analysis: analysisFixture(), record });
    const byKey = new Map(rows.map(row => [row.key, row]));
    expect(byKey.get('stroke_window')?.provenance).toBe('DETECTED');
    expect(byKey.get('contact_estimate')?.provenance).toBe('ESTIMATE');
    expect(byKey.get('contact_estimate')?.value).toContain('2400ms');
    expect(byKey.get('phase_timeline')?.provenance).toBe('MEASURED');
    expect(byKey.get('predicted_stroke')?.provenance).toBe('PREDICTED');
    expect(byKey.get('predicted_stroke')?.value).toBe('Forehand (family)');
  });

  it('no contact row when the marker is not defensible', () => {
    const rows = measuredRows({
      analysis: analysisFixture(),
      record: { id: 'r1', contact: estimatedContact({ confidence: 0.2 }) },
    });
    expect(rows.find(row => row.key === 'contact_estimate')).toBeUndefined();
  });

  it('the analysis’ measured phases add ONE phase row when the record has none', () => {
    const rows = measuredRows({
      analysis: scoredAnalysis(),
      record: {
        id: 'r1',
        uncertainty: { limitingFactors: STRUCTURAL_FACTORS },
      },
    });
    const phaseRows = rows.filter(row => row.key === 'phase_timeline');
    expect(phaseRows).toHaveLength(1);
    expect(phaseRows[0]).toEqual({
      key: 'phase_timeline',
      label: 'Swing phases',
      value: '4 measured from wrist motion',
      provenance: 'MEASURED',
    });
    // Nothing else is invented for a record without contact/prediction.
    expect(rows.map(row => row.key)).toEqual([
      'stroke_window',
      'phase_timeline',
    ]);
  });

  it('a segmented record and analysis phases together still yield exactly one phase row (the record’s)', () => {
    const rows = measuredRows({
      analysis: scoredAnalysis(),
      record: { id: 'r1', temporalPhasesV2: segmentedPhases() },
    });
    const phaseRows = rows.filter(row => row.key === 'phase_timeline');
    expect(phaseRows).toHaveLength(1);
    expect(phaseRows[0]?.value).toBe('4 measured from paddle motion');
  });

  it('no phase row when neither the record nor the analysis measured phases', () => {
    const rows = measuredRows({ analysis: analysisFixture(), record: null });
    expect(rows.find(row => row.key === 'phase_timeline')).toBeUndefined();
  });

  it('collapses beyond 4 rows and reports the hidden count', () => {
    const analysis = analysisFixture({
      measurements: [
        {
          metricKey: 'elbow_extension',
          value: 0.42,
          confidence: 0.8,
          unit: 'ratio',
          source: 'real',
        },
        {
          metricKey: 'swing_duration',
          value: 700,
          confidence: 0.9,
          unit: 'ms',
          source: 'real',
        },
        {
          metricKey: 'hip_rotation',
          value: 31,
          confidence: 0.7,
          unit: 'degrees',
          source: 'real',
        },
        {
          metricKey: 'knee_bend',
          value: 12,
          confidence: 0.7,
          unit: 'degrees',
          source: 'real',
        },
      ],
    });
    const rows = measuredRows({ analysis, record: null });
    expect(rows.length).toBe(5); // window + 4 measurements
    const collapsed = visibleMeasuredRows(rows, false);
    expect(collapsed.visible.length).toBe(4);
    expect(collapsed.hiddenCount).toBe(1);
    const expanded = visibleMeasuredRows(rows, true);
    expect(expanded.visible.length).toBe(5);
    expect(expanded.hiddenCount).toBe(0);
  });
});

// ─── §2 Attempt chips — navigate, never rank ────────────────────────────────

describe('attemptChips', () => {
  const attempts = [
    // Deliberately shuffled and carrying no scores: chips order by capture
    // time only. Ranking/comparison is BLOCKED_ON_VALIDATION.
    { analysisId: 'c', capturedAtIso: '2026-08-30T10:20:00Z', sessionId: 's1' },
    { analysisId: 'a', capturedAtIso: '2026-08-30T10:00:00Z', sessionId: 's1' },
    { analysisId: 'x', capturedAtIso: '2026-08-30T10:05:00Z', sessionId: 's2' },
    { analysisId: 'b', capturedAtIso: '2026-08-30T10:10:00Z', sessionId: 's1' },
  ];

  it('groups only the current session, in chronological capture order', () => {
    const chips = attemptChips(attempts, 'b');
    expect(chips.map(chip => chip.analysisId)).toEqual(['a', 'b', 'c']);
    expect(chips.map(chip => chip.label)).toEqual([
      'Attempt 1',
      'Attempt 2',
      'Attempt 3',
    ]);
    expect(chips.find(chip => chip.isCurrent)?.analysisId).toBe('b');
  });

  it('labels never rank: chronological position is the only ordering', () => {
    const chips = attemptChips(attempts, 'c');
    expect(chips[chips.length - 1]?.analysisId).toBe('c'); // latest, not "best"
  });

  it('a null sessionId groups with nothing', () => {
    const solo = attemptChips(
      [
        {
          analysisId: 'a',
          capturedAtIso: '2026-08-30T10:00:00Z',
          sessionId: null,
        },
      ],
      'a',
    );
    expect(solo).toEqual([]);
  });

  it('unknown current analysis yields no chips', () => {
    expect(attemptChips(attempts, 'missing')).toEqual([]);
  });
});

// ─── §4 Abstention ledger ───────────────────────────────────────────────────

describe('abstention state', () => {
  it('a result-null record is an abstention surface', () => {
    expect(isAbstainedResult({ id: 'r1', result: null }, null)).toBe(true);
  });

  it('a scored analysis is not', () => {
    expect(isAbstainedResult(null, analysisFixture())).toBe(false);
  });

  it('low-confidence results are abstentions (no invented score)', () => {
    expect(
      isAbstainedResult(
        null,
        analysisFixture({ resultKind: 'low_confidence', overallScore: null }),
      ),
    ).toBe(true);
  });

  it('ledger separates what held from what could not be established', () => {
    const ledger = abstentionLedger({
      record: {
        id: 'r1',
        strokeIntent: envelope({
          declaredStroke: null,
          resolutionBasis: 'predicted_family',
          resolvedProfileId: 'SHARED_FOREHAND_SWING',
          predictedStroke: {
            taxonomyVersion: 'pickleball-stroke-taxonomy-v3',
            classifierVersion: 'stroke-heuristic-1 (uncalibrated)',
            label: 'FOREHAND',
            leaf: null,
            taxonomyDepth: 2,
            confidence: 0.6,
            evidence: [],
            limitingFactors: [],
          },
        }),
        result: null,
        uncertainty: {
          analysisConfidence: 0,
          presentation: 'abstain',
          limitingFactors: ['paddle_track_missing'],
        },
      },
      analysis: null,
      clipPresent: true,
    });
    expect(ledger.held.join(' ')).toContain('forehand swing family');
    expect(ledger.held.join(' ')).toContain('clip was captured');
    expect(ledger.notEstablished.join(' ')).toContain(
      'The exact stroke inside that family.',
    );
    expect(ledger.notEstablished.join(' ')).toContain('exact contact moment');
    expect(ledger.notEstablished.join(' ')).toContain('technique score');
    expect(ledger.notEstablished.join(' ')).toContain('Paddle track missing');
    // An unknown (non-structural) token carries no scope footnote.
    expect(ledger.scope).toBeNull();
  });

  it('machine limiting-factor tokens render as human ledger lines; modality tokens become the ONE scope footnote', () => {
    const ledger = abstentionLedger({
      record: {
        id: 'r1',
        result: null,
        uncertainty: {
          analysisConfidence: 0,
          presentation: 'abstain',
          limitingFactors: [
            'paddle_track_unavailable',
            'ball_track_unavailable',
            'court_geometry_unavailable',
            'checkpoint_unobserved:face_wrist_stability',
            'checkpoint_unobserved:follow_through',
            'analysis_confidence_below_threshold',
          ],
        },
      },
      analysis: null,
      clipPresent: true,
    });
    const lines = ledger.notEstablished;
    // Structural modality tokens are the engine's scope, not gaps this
    // capture could have closed: no per-token "couldn't establish" lines.
    expect(lines).not.toContain('A paddle track for this swing.');
    expect(lines).not.toContain('A ball track for this swing.');
    expect(lines).not.toContain('Court geometry for this camera view.');
    expect(lines.join(' ')).not.toMatch(
      /paddle track|ball track|court geometry/i,
    );
    expect(ledger.scope).toBe(MEASUREMENT_SCOPE_NOTE);
    expect(ledger.scope).toBe(
      'Measured from 13 tracked body joints. Paddle-side checkpoints use your ' +
        'hitting wrist; the paddle, ball and court lines are not tracked in ' +
        'this version.',
    );
    // Per-analysis tokens still render as human lines.
    expect(lines).toContain(
      'The face / wrist stability checkpoint — not observed in this clip.',
    );
    expect(lines).toContain(
      'The follow-through checkpoint — not observed in this clip.',
    );
    expect(lines).toContain(
      'Enough analysis confidence to clear the scoring threshold.',
    );
    // The raw token forms never leak into the surface.
    expect(lines.join(' ')).not.toMatch(/unobserved:|_/);
  });

  it('a low-confidence analysis with measured phases: phases held, timing not listed as a gap', () => {
    const ledger = abstentionLedger({
      record: {
        id: 'r1',
        result: null,
        uncertainty: {
          analysisConfidence: 0.3,
          presentation: 'abstain',
          limitingFactors: [
            ...STRUCTURAL_FACTORS,
            'analysis_confidence_below_threshold',
          ],
        },
      },
      analysis: scoredAnalysis({
        resultKind: 'low_confidence',
        overallScore: null,
      }),
      clipPresent: false,
    });
    expect(ledger.held).toContain(
      'Swing phases were measured from real motion.',
    );
    expect(ledger.notEstablished).not.toContain('Phase timing for this swing.');
    expect(ledger.notEstablished).toContain(
      'A technique score — scoring stays withheld rather than invented.',
    );
    expect(ledger.scope).toBe(MEASUREMENT_SCOPE_NOTE);
  });

  it('the family-depth token never duplicates the ledger line the intent already added', () => {
    const ledger = abstentionLedger({
      record: {
        id: 'r1',
        strokeIntent: envelope({
          declaredStroke: null,
          resolutionBasis: 'predicted_family',
          resolvedProfileId: 'SHARED_FOREHAND_SWING',
          predictedStroke: {
            taxonomyVersion: 'pickleball-stroke-taxonomy-v3',
            classifierVersion: 'stroke-heuristic-1 (uncalibrated)',
            label: 'FOREHAND',
            leaf: null,
            taxonomyDepth: 2,
            confidence: 0.6,
            evidence: [],
            limitingFactors: [],
          },
        }),
        result: null,
        uncertainty: {
          analysisConfidence: 0,
          presentation: 'abstain',
          limitingFactors: [
            'auto_stroke_resolved_at_side_depth_no_leaf_for_scoring',
          ],
        },
      },
      analysis: null,
      clipPresent: false,
    });
    const familyLines = ledger.notEstablished.filter(line =>
      line.includes('exact stroke inside that family'),
    );
    expect(familyLines).toHaveLength(1);
    expect(ledger.notEstablished.join(' ')).not.toContain('side depth');
  });
});
