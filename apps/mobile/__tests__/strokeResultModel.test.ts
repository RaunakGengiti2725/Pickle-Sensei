import type { StrokeIntentEnvelope } from '@pickle/analysis-pipeline';
import type { ShotAnalysis } from '@pickle/shared-types';
import type { ContactEstimate } from '@pickle/vision-geometry';
import {
  ANCHOR_FREE_CAPTION,
  abstentionLedger,
  attemptChips,
  contactHaloHalfWidthMs,
  contactMarkerPresentation,
  isAbstainedResult,
  measuredRows,
  phaseTimelinePresentation,
  selectInsight,
  strokeResultHeader,
  visibleMeasuredRows,
  type StrokeResultEvidenceRecord,
  type TemporalPhasesV2,
} from '../src/components/strokeResultModel';

/**
 * W8 — canonical Stroke Result selectors.
 *
 * Every rendered element is honest-evidence gated: contact markers follow
 * the usable-result-v1 gate, phase strips render only from a segmented
 * temporalPhasesV2 (including W5's anchor-free mode), the ONE insight comes
 * from the strongest defensible evidence in fixed priority, and attempts
 * never rank.
 */

// ─── Fixtures ───────────────────────────────────────────────────────────────

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
    });
    expect(insight.basis).toBe('disagreement');
    expect(insight.sentence).toContain('You declared forehand drive');
    expect(insight.sentence).toContain('BACKHAND');
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
    expect(insight.sentence).toContain('exact contact moment was not established');
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
    expect(insight.sentence).toContain('nothing was invented');
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
      [{ analysisId: 'a', capturedAtIso: '2026-08-30T10:00:00Z', sessionId: null }],
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
    expect(
      isAbstainedResult({ id: 'r1', result: null }, null),
    ).toBe(true);
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
  });
});
