import type { StrokeIntentEnvelope } from '@pickle/analysis-pipeline';
import {
  PHASES,
  SELECTABLE_TECHNIQUES_V1,
  SHOT_TYPES,
  type PhaseSpan,
  type ShotAnalysis,
  type ShotTypeSlug,
} from '@pickle/shared-types';
import type { ContactEstimate } from '@pickle/vision-geometry';
import {
  attemptChips,
  contactMarkerPresentation,
  contactHaloHalfWidthMs,
  effectivePhaseTimeline,
  isAbstainedResult,
  isModalityScopeFactor,
  measuredRows,
  phaseTimelineFromAnalysis,
  phaseTimelinePresentation,
  selectInsight,
  strokeResultHeader,
  visibleMeasuredRows,
  MEASURED_ROWS_COLLAPSED_COUNT,
  type AttemptRef,
  type StrokeResultEvidenceRecord,
  type TemporalPhasesV2,
} from '../src/components/strokeResultModel';
import {
  armTryAgain,
  consumeTryAgainHandoff,
  peekTryAgainHandoff,
  techniqueIntentFromHandoff,
  tryAgainFromResult,
  type TryAgainHandoff,
} from '../src/screens/tryAgainHandoff';

/**
 * E19 — property tests for the Result / Try Again state machine.
 *
 * Deterministic seeded generators (mulberry32) exercise the pure state
 * machine over hundreds of randomized cases per property, targeting the
 * stale-state bug classes: repeated attempts, prior-result contamination,
 * wrong target (intent) inheritance, and attempt sequencing. Every seed is
 * fixed so failures reproduce exactly.
 */

// ─── Seeded PRNG + generators ───────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[int(rng, 0, items.length - 1)];
  if (item === undefined) throw new Error('pick from empty list');
  return item;
}

function maybe<T>(rng: Rng, probability: number, value: () => T): T | null {
  return rng() < probability ? value() : null;
}

const CANONICALS = SELECTABLE_TECHNIQUES_V1.map(t => t.canonical);
const RUNS = 300;

function genPrediction(rng: Rng) {
  const label = pick(rng, ['FOREHAND', 'BACKHAND', 'OVERHEAD', 'UNKNOWN']);
  return {
    taxonomyVersion: 'pickleball-stroke-taxonomy-v3',
    classifierVersion: 'stroke-heuristic-2',
    label,
    leaf: maybe(rng, 0.5, () => pick(rng, [...CANONICALS, 'UNKNOWN'])),
    taxonomyDepth: pick(rng, [1, 2, 3] as const),
    confidence: rng(),
    evidence: [],
    limitingFactors: [],
  };
}

/** Random envelope — including corrupt-but-persistable shapes (a resolved
 * profile that does not correspond to the declaration), since stored records
 * are heterogeneous and the handoff must never launder them into an intent. */
function genEnvelope(rng: Rng): StrokeIntentEnvelope {
  const basis = pick(rng, [
    'declared',
    'predicted_l3',
    'predicted_family',
    'abstained',
  ] as const);
  const declaredStroke = basis === 'declared' ? pick(rng, SHOT_TYPES) : null;
  return {
    declaredStroke,
    predictedStroke: maybe(rng, 0.6, () => genPrediction(rng)),
    resolutionBasis: basis,
    resolvedProfileId: maybe(rng, 0.7, () =>
      pick(rng, [...CANONICALS, 'NOT_A_REGISTRY_ID']),
    ),
    resolvedProfileVersion: maybe(rng, 0.7, () => 'technique-profile-v1'),
    disagreement: null,
  };
}

function slugsForCanonical(canonical: string): ShotTypeSlug[] {
  return SELECTABLE_TECHNIQUES_V1.filter(
    t => t.canonical === canonical && t.legacySlug !== null,
  ).map(t => t.legacySlug as ShotTypeSlug);
}

// ─── Wrong target inheritance: tryAgainFromResult → techniqueIntentFromHandoff

describe('E19 — Try Again intent inheritance properties', () => {
  it('never fabricates a declaration: declared-null envelopes always re-arm AUTO', () => {
    const rng = mulberry32(0xe19_01);
    for (let run = 0; run < RUNS; run += 1) {
      const envelope = genEnvelope(rng);
      const handoff = tryAgainFromResult({ strokeIntent: envelope }, null);
      if (envelope.declaredStroke === null) {
        expect(handoff).toEqual({
          source: 'camera',
          declaredStroke: null,
          declaredCanonical: null,
          auto: true,
          sessionId: null,
        });
      } else {
        expect(handoff.auto).toBe(false);
        expect(handoff.declaredStroke).toBe(envelope.declaredStroke);
      }
    }
  });

  it('the re-armed canonical always belongs to the declared stroke (no cross-technique inheritance)', () => {
    const rng = mulberry32(0xe19_02);
    for (let run = 0; run < RUNS; run += 1) {
      const envelope = genEnvelope(rng);
      const handoff = tryAgainFromResult({ strokeIntent: envelope }, null);
      if (handoff.declaredCanonical !== null) {
        expect(handoff.declaredStroke).not.toBeNull();
        expect(slugsForCanonical(handoff.declaredCanonical)).toContain(
          handoff.declaredStroke,
        );
      }
    }
  });

  it('handoff → intent keeps canonical and slug consistent with the registry', () => {
    const rng = mulberry32(0xe19_03);
    for (let run = 0; run < RUNS; run += 1) {
      const envelope = genEnvelope(rng);
      const analysis = maybe(rng, 0.5, () => ({
        shotType: pick(rng, SHOT_TYPES),
      }));
      const useEnvelope = rng() < 0.8;
      const handoff = tryAgainFromResult(
        useEnvelope ? { strokeIntent: envelope } : null,
        analysis,
      );
      const intent = techniqueIntentFromHandoff(handoff);
      if (intent === null) continue;
      if (intent.source === 'auto') {
        expect(intent.canonical).toBeNull();
        expect(intent.legacySlug).toBeNull();
        expect(intent.confidence).toBeNull();
        continue;
      }
      expect(intent.source).toBe('tap');
      expect(intent.legacySlug).toBe(handoff.declaredStroke);
      expect(intent.confidence).toBe(1);
      if (intent.canonical !== null) {
        expect(slugsForCanonical(intent.canonical)).toContain(
          intent.legacySlug,
        );
      } else if (intent.legacySlug !== null) {
        // A null canonical is honest exactly when the slug is ambiguous or
        // unmapped in the selectable registry.
        const matches = SELECTABLE_TECHNIQUES_V1.filter(
          t => t.legacySlug === intent.legacySlug,
        );
        expect(matches.length).not.toBe(1);
      }
    }
  });

  it('regression: a mismatched resolvedProfileId never seeds another technique’s canonical', () => {
    // Found by the cross-technique inheritance property: a declared 'volley'
    // record whose (corrupt) resolvedProfileId said SERVE re-armed a
    // volley-slug/SERVE-canonical intent.
    const handoff = tryAgainFromResult(
      {
        strokeIntent: {
          declaredStroke: 'volley',
          predictedStroke: null,
          resolutionBasis: 'declared',
          resolvedProfileId: 'SERVE',
          resolvedProfileVersion: 'technique-profile-v1',
          disagreement: null,
        },
      },
      null,
    );
    expect(handoff).toEqual({
      source: 'camera',
      declaredStroke: 'volley',
      declaredCanonical: null,
      auto: false,
      sessionId: null,
    });
    // 'volley' is ambiguous in the registry, so the intent honestly carries
    // no canonical rather than the foreign SERVE profile.
    expect(techniqueIntentFromHandoff(handoff)?.canonical).toBeNull();
  });

  it('legacy rows (no envelope) re-declare exactly the analyzed shot, never a canonical', () => {
    const rng = mulberry32(0xe19_04);
    for (let run = 0; run < RUNS; run += 1) {
      const analysis = maybe(rng, 0.7, () => ({
        shotType: pick(rng, SHOT_TYPES),
      }));
      const handoff = tryAgainFromResult(null, analysis);
      expect(handoff.auto).toBe(false);
      expect(handoff.declaredStroke).toBe(analysis?.shotType ?? null);
      expect(handoff.declaredCanonical).toBeNull();
    }
  });
});

// ─── Handoff lifecycle: single-shot under arbitrary op sequences ────────────

describe('E19 — handoff lifecycle model properties', () => {
  function genHandoff(rng: Rng): TryAgainHandoff {
    const auto = rng() < 0.5;
    return {
      source: 'camera',
      declaredStroke: auto ? null : pick(rng, SHOT_TYPES),
      declaredCanonical: null,
      auto,
      sessionId: rng() < 0.5 ? null : `set-${int(rng, 1, 9)}`,
    };
  }

  it('matches the single-slot reference model over random arm/peek/consume sequences', () => {
    const rng = mulberry32(0xe19_05);
    for (let run = 0; run < RUNS; run += 1) {
      consumeTryAgainHandoff(); // isolate runs
      let model: TryAgainHandoff | null = null;
      const steps = int(rng, 1, 20);
      for (let step = 0; step < steps; step += 1) {
        const op = pick(rng, ['arm', 'peek', 'consume'] as const);
        if (op === 'arm') {
          const handoff = genHandoff(rng);
          armTryAgain(handoff);
          model = handoff;
        } else if (op === 'peek') {
          expect(peekTryAgainHandoff()).toEqual(model);
        } else {
          expect(consumeTryAgainHandoff()).toEqual(model);
          model = null;
          // Single-shot: an immediate second consume is always empty.
          expect(consumeTryAgainHandoff()).toBeNull();
        }
      }
      consumeTryAgainHandoff();
    }
  });
});

// ─── Attempt sequencing: chips over random attempt sets ─────────────────────

describe('E19 — attempt chip sequencing properties', () => {
  function genAttempts(rng: Rng): AttemptRef[] {
    const count = int(rng, 1, 8);
    const attempts: AttemptRef[] = [];
    for (let i = 0; i < count; i += 1) {
      attempts.push({
        analysisId: `a${i}`,
        // Coarse timestamps force ties so the id tiebreak is exercised.
        capturedAtIso: `2026-08-30T10:0${int(rng, 0, 5)}:00Z`,
        sessionId: maybe(rng, 0.8, () => `s${int(rng, 1, 2)}`),
      });
    }
    return attempts;
  }

  function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = int(rng, 0, i);
      const a = copy[i]!;
      copy[i] = copy[j]!;
      copy[j] = a;
    }
    return copy;
  }

  it('labels are contiguous capture-order Attempt 1…N with exactly one current chip', () => {
    const rng = mulberry32(0xe19_06);
    for (let run = 0; run < RUNS; run += 1) {
      const attempts = genAttempts(rng);
      const current = pick(rng, attempts);
      const chips = attemptChips(attempts, current.analysisId);
      if (current.sessionId === null) {
        expect(chips).toEqual([]);
        continue;
      }
      expect(chips.map(chip => chip.label)).toEqual(
        chips.map((_, index) => `Attempt ${index + 1}`),
      );
      expect(chips.filter(chip => chip.isCurrent)).toHaveLength(1);
      expect(chips.find(chip => chip.isCurrent)?.analysisId).toBe(
        current.analysisId,
      );
      // Same session only, in capture order (id tiebreak).
      const sameSession = attempts.filter(
        attempt => attempt.sessionId === current.sessionId,
      );
      expect(chips).toHaveLength(sameSession.length);
      const byId = new Map(attempts.map(a => [a.analysisId, a]));
      for (let i = 1; i < chips.length; i += 1) {
        const previous = byId.get(chips[i - 1]!.analysisId)!;
        const chip = byId.get(chips[i]!.analysisId)!;
        const ordered =
          previous.capturedAtIso < chip.capturedAtIso ||
          (previous.capturedAtIso === chip.capturedAtIso &&
            previous.analysisId < chip.analysisId);
        expect(ordered).toBe(true);
      }
    }
  });

  it('chips are invariant under input permutation (no load-order contamination)', () => {
    const rng = mulberry32(0xe19_07);
    for (let run = 0; run < RUNS; run += 1) {
      const attempts = genAttempts(rng);
      const current = pick(rng, attempts);
      expect(attemptChips(shuffle(rng, attempts), current.analysisId)).toEqual(
        attemptChips(attempts, current.analysisId),
      );
    }
  });

  it('appending a LATER attempt never renumbers earlier attempts', () => {
    const rng = mulberry32(0xe19_08);
    for (let run = 0; run < RUNS; run += 1) {
      const attempts = genAttempts(rng).map(attempt => ({
        ...attempt,
        sessionId: 's1',
      }));
      const current = pick(rng, attempts);
      const before = attemptChips(attempts, current.analysisId);
      const later: AttemptRef = {
        analysisId: `z-late`,
        capturedAtIso: '2026-08-30T11:00:00Z',
        sessionId: 's1',
      };
      const after = attemptChips([...attempts, later], current.analysisId);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after[after.length - 1]).toEqual({
        analysisId: 'z-late',
        label: `Attempt ${before.length + 1}`,
        isCurrent: false,
      });
    }
  });
});

// ─── Contact marker gate + halo ─────────────────────────────────────────────

describe('E19 — contact marker gate properties', () => {
  function genContact(rng: Rng): ContactEstimate {
    if (rng() < 0.3) {
      return {
        status: 'abstained',
        reason: pick(rng, ['insufficient evidence mass', 'modes competed']),
        limitingFactors: [],
      };
    }
    return {
      status: 'estimated',
      estimatedContactMs: rng() < 0.1 ? Number.NaN : Math.round(rng() * 10_000),
      confidence: rng() < 0.1 ? pick(rng, [-0.5, 1.5]) : rng(),
      ballConfirmed: rng() < 0.4,
      paddleConfirmed: rng() < 0.4,
      limitingFactors: [],
      supportingEvidence: [],
    };
  }

  it('marker iff estimated + (confirmation or confidence ≥ 0.6) + finite ms; halo always in [33, 165]', () => {
    const rng = mulberry32(0xe19_09);
    for (let run = 0; run < RUNS; run += 1) {
      const contact = maybe(rng, 0.9, () => genContact(rng));
      const presentation = contactMarkerPresentation(contact);
      const shouldMark =
        contact !== null &&
        contact.status === 'estimated' &&
        (contact.ballConfirmed ||
          contact.paddleConfirmed ||
          contact.confidence >= 0.6) &&
        Number.isFinite(contact.estimatedContactMs);
      expect(presentation.kind).toBe(shouldMark ? 'marker' : 'not_established');
      if (presentation.kind === 'marker') {
        expect(presentation.haloHalfWidthMs).toBeGreaterThanOrEqual(33);
        expect(presentation.haloHalfWidthMs).toBeLessThanOrEqual(165);
        expect(Number.isFinite(presentation.haloHalfWidthMs)).toBe(true);
      }
    }
  });

  it('halo width is monotone non-increasing in confidence', () => {
    const rng = mulberry32(0xe19_0a);
    for (let run = 0; run < RUNS; run += 1) {
      const low = rng();
      const high = low + rng() * (1 - low);
      expect(contactHaloHalfWidthMs(high)).toBeLessThanOrEqual(
        contactHaloHalfWidthMs(low),
      );
    }
  });
});

// ─── Phase timeline structural properties ───────────────────────────────────

describe('E19 — phase timeline properties', () => {
  function genPhases(rng: Rng): TemporalPhasesV2 {
    if (rng() < 0.2) {
      return { status: 'abstained', reason: 'too_few_pose_frames' };
    }
    const jitter = () => (rng() < 0.15 ? -int(rng, 1, 500) : int(rng, 0, 400));
    const base = int(rng, 0, 2000);
    const anchorFree = rng() < 0.4;
    const accelerationStartMs = base + jitter();
    const mid = accelerationStartMs + jitter();
    return {
      status: 'segmented',
      boundaries: {
        version: 'phase-temporal-v2',
        source: pick(rng, ['paddle', 'wrist'] as const),
        anchor: anchorFree ? 'speed_peak' : 'contact_estimate',
        anchorBasis: anchorFree ? 'event_peak' : 'contact_estimate',
        confidence: rng(),
        preparationStartMs: maybe(rng, 0.7, () => base - int(rng, 0, 300)),
        accelerationStartMs,
        contactMs: anchorFree ? null : mid,
        motionPeakMs: anchorFree && rng() < 0.8 ? mid : undefined,
        followThroughEndMs: mid + jitter(),
        recoveryEndMs: maybe(rng, 0.6, () => mid + int(rng, 0, 900)),
      },
    };
  }

  it('rendered segments are always positive-length, ordered and non-overlapping; anchor-free never draws a tick', () => {
    const rng = mulberry32(0xe19_0b);
    for (let run = 0; run < RUNS; run += 1) {
      const phases = genPhases(rng);
      const presentation = phaseTimelinePresentation(phases);
      if (presentation.kind !== 'segments') continue;
      for (const segment of presentation.segments) {
        expect(segment.endMs).toBeGreaterThan(segment.startMs);
      }
      for (let i = 1; i < presentation.segments.length; i += 1) {
        expect(presentation.segments[i]!.startMs).toBeGreaterThanOrEqual(
          presentation.segments[i - 1]!.endMs,
        );
      }
      if (presentation.anchorFree) {
        expect(presentation.contactTickMs).toBeNull();
        expect(presentation.caption).not.toBeNull();
      } else {
        expect(Number.isFinite(presentation.contactTickMs)).toBe(true);
      }
    }
  });
});

// ─── Analysis-phase timeline structural properties ──────────────────────────

describe('E19 — analysis phase timeline properties', () => {
  function genAnalysis(rng: Rng): ShotAnalysis {
    // Walk the canonical phase order with random gaps/lengths; sometimes
    // drop phases, sometimes corrupt a bound, sometimes shuffle the order.
    const spans: PhaseSpan[] = [];
    let cursor = int(rng, 0, 3000);
    for (const key of PHASES) {
      if (rng() < 0.2) continue;
      const startMs = cursor + (rng() < 0.3 ? int(rng, 0, 40) : 0);
      const length = rng() < 0.1 ? 0 : int(rng, 1, 600);
      const endMs = startMs + length;
      spans.push({
        key,
        startMs: rng() < 0.05 ? Number.NaN : startMs,
        representativeMs:
          rng() < 0.1 ? Number.NaN : startMs + Math.floor(length / 2),
        endMs: rng() < 0.05 ? Number.POSITIVE_INFINITY : endMs,
        confidence: rng(),
      });
      cursor = endMs;
    }
    if (rng() < 0.15 && spans.length > 1) {
      const i = int(rng, 0, spans.length - 1);
      const j = int(rng, 0, spans.length - 1);
      const a = spans[i]!;
      spans[i] = spans[j]!;
      spans[j] = a;
    }
    return {
      id: `a${int(rng, 0, 1e6)}`,
      sessionId: null,
      shotType: pick(rng, SHOT_TYPES),
      cameraView: 'side',
      handedness: 'right',
      capturedAtIso: '2026-09-01T10:00:00.000Z',
      timestamps: {
        startMs: 0,
        contactMs: maybe(rng, 0.7, () => int(rng, 0, 5000)),
        endMs: 5000,
      },
      phases: spans,
      measurements: [],
      checkpoints: [],
      overallScore: 7,
      analysisConfidence: 0.8,
      resultKind: 'scored',
      guidance: null,
      priorityFix: null,
      versionVector: {
        appVersion: '0.1.0',
        modelBundleVersion: 'on-device-fusion-1',
        poseModelVersion: 'apple-vision-bodypose-1',
        paddleModelVersion: 'none',
        strokeDetectorVersion: 'temporal-stroke-heuristic-2',
        phaseModelVersion: 'phase-geometry-1',
        scoringModelVersion: 'scoring-1',
        shotConfigVersion: 'config-1',
      },
      source: 'real',
    };
  }

  it('segments are positive-length, ordered, non-overlapping, never ready/contact; tick is finite iff not anchor-free', () => {
    const rng = mulberry32(0xe19_0e);
    for (let run = 0; run < RUNS; run += 1) {
      const analysis = genAnalysis(rng);
      const presentation = phaseTimelineFromAnalysis(analysis);
      if (presentation.kind !== 'segments') continue;
      expect(presentation.segments.length).toBeGreaterThan(0);
      expect(presentation.source).toBe('wrist');
      expect(presentation.origin).toBe('analysis');
      for (const segment of presentation.segments) {
        expect(segment.endMs).toBeGreaterThan(segment.startMs);
        expect(Number.isFinite(segment.startMs)).toBe(true);
        expect(Number.isFinite(segment.endMs)).toBe(true);
        expect([
          'preparation',
          'acceleration',
          'follow_through',
          'recovery',
        ]).toContain(segment.key);
      }
      for (let i = 1; i < presentation.segments.length; i += 1) {
        expect(presentation.segments[i]!.startMs).toBeGreaterThanOrEqual(
          presentation.segments[i - 1]!.endMs,
        );
      }
      if (presentation.anchorFree) {
        expect(presentation.contactTickMs).toBeNull();
      } else {
        expect(Number.isFinite(presentation.contactTickMs)).toBe(true);
      }
      expect(presentation.caption).not.toBeNull();
    }
  });

  it('a segmented record always wins; otherwise the analysis decides; result is deterministic', () => {
    const rng = mulberry32(0xe19_0f);
    for (let run = 0; run < RUNS; run += 1) {
      const analysis = genAnalysis(rng);
      const record: StrokeResultEvidenceRecord = {
        id: 'r',
        temporalPhasesV2: maybe(rng, 0.5, () => ({
          status: 'abstained' as const,
          reason: 'too_few_pose_frames',
        })),
      };
      const effective = effectivePhaseTimeline(record, analysis);
      const measured = phaseTimelineFromAnalysis(analysis);
      if (measured.kind === 'segments') {
        expect(effective).toEqual(measured);
      } else if (record.temporalPhasesV2) {
        expect(effective).toEqual(
          phaseTimelinePresentation(record.temporalPhasesV2),
        );
      } else {
        expect(effective).toEqual(measured);
      }
      expect(effectivePhaseTimeline(record, analysis)).toEqual(effective);
    }
  });

  it('the abstention insight never names a structural modality token', () => {
    const rng = mulberry32(0xe19_10);
    const tokens = [
      'paddle_track_unavailable',
      'ball_track_unavailable',
      'court_geometry_unavailable',
      'checkpoint_unobserved:recovery',
      'analysis_confidence_below_threshold',
      'low_pose_confidence',
    ];
    for (let run = 0; run < RUNS; run += 1) {
      const count = int(rng, 0, 5);
      const factors: string[] = [];
      for (let i = 0; i < count; i += 1) factors.push(pick(rng, tokens));
      const insight = selectInsight({ limitingFactors: factors });
      expect(insight.basis).toBe('abstention');
      expect(insight.sentence).not.toMatch(
        /paddle track|ball track|court geometry/,
      );
      const firstReal = factors.find(token => !isModalityScopeFactor(token));
      if (firstReal === undefined) {
        expect(insight.sentence).toContain('Nothing beyond what is shown');
      }
    }
  });
});

// ─── Prior-result contamination: selectors are pure and stateless ───────────

describe('E19 — selector purity (no prior-result contamination)', () => {
  function genRecord(rng: Rng): StrokeResultEvidenceRecord {
    return {
      id: `r${int(rng, 0, 1e6)}`,
      strokeIntent: maybe(rng, 0.8, () => genEnvelope(rng)),
      result: null,
      uncertainty: maybe(rng, 0.8, () => ({
        analysisConfidence: rng(),
        presentation: pick(rng, ['normal', 'hedged', 'abstain']),
        limitingFactors:
          rng() < 0.5 ? [pick(rng, ['paddle_track_missing', 'low_light'])] : [],
      })),
      contact: maybe(rng, 0.5, () => ({
        status: 'estimated' as const,
        estimatedContactMs: int(rng, 0, 9000),
        confidence: rng(),
        ballConfirmed: rng() < 0.5,
        paddleConfirmed: rng() < 0.5,
        limitingFactors: [],
        supportingEvidence: [],
      })),
    };
  }

  it('interleaved attempts derive identical views to isolated derivation (A,B,A ≡ A)', () => {
    const rng = mulberry32(0xe19_0c);
    for (let run = 0; run < RUNS; run += 1) {
      const a = genRecord(rng);
      const b = genRecord(rng);
      const first = {
        header: strokeResultHeader(a, null),
        rows: measuredRows({ analysis: null, record: a }),
        abstained: isAbstainedResult(a, null),
      };
      // Deriving another attempt in between must not change A's derivation.
      strokeResultHeader(b, null);
      measuredRows({ analysis: null, record: b });
      isAbstainedResult(b, null);
      expect(strokeResultHeader(a, null)).toEqual(first.header);
      expect(measuredRows({ analysis: null, record: a })).toEqual(first.rows);
      expect(isAbstainedResult(a, null)).toBe(first.abstained);
    }
  });

  it('visibleMeasuredRows never drops or duplicates rows', () => {
    const rng = mulberry32(0xe19_0d);
    for (let run = 0; run < RUNS; run += 1) {
      const record = genRecord(rng);
      const rows = measuredRows({ analysis: null, record });
      const expanded = visibleMeasuredRows(rows, true);
      expect(expanded.visible).toEqual(rows);
      expect(expanded.hiddenCount).toBe(0);
      const collapsed = visibleMeasuredRows(rows, false);
      expect(collapsed.visible.length + collapsed.hiddenCount).toBe(
        rows.length,
      );
      expect(collapsed.visible).toEqual(
        rows.slice(0, collapsed.visible.length),
      );
      if (rows.length <= MEASURED_ROWS_COLLAPSED_COUNT) {
        expect(collapsed.hiddenCount).toBe(0);
      }
    }
  });
});
