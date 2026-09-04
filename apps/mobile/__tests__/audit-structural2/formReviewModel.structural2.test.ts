import {
  CHECKPOINTS,
  FAULT_DIRECTIONS,
  SHOT_TYPES,
  type CheckpointKey,
  type CheckpointScore,
  type FaultDirection,
  type PhaseKey,
  type PhaseSpan,
  type ScoreBand,
  type ShotAnalysis,
} from '@pickle/shared-types';
import {
  buildFormReviewScript,
  coachingCue,
  directionPhrase,
  fixList,
  stopHeadline,
  strengthList,
} from '../../src/review';

/**
 * Structural audit #2 (mobile-results-review) — coaching-copy selectors.
 *
 * `repository.ts` casts stored analysis JSON straight to `ShotAnalysis`
 * (no validation), and `formReviewModel.ts` documents that it must tolerate
 * that ("Stored records are unvalidated JSON"). These probes push exactly the
 * unvalidated shapes the comments promise to survive — prototype-chain keys,
 * unknown bands/directions, inconsistent band/score pairs — through the
 * selectors ResultScreen and FormReviewPlayer render from, and pin the
 * copy bounds the player's layout relies on.
 */

function phase(key: PhaseKey, startMs: number, endMs: number): PhaseSpan {
  return {
    key,
    startMs,
    representativeMs: startMs + (endMs - startMs) / 2,
    endMs,
    confidence: 0.8,
  };
}

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

function analysis(
  checkpoints: CheckpointScore[],
  overrides: Partial<ShotAnalysis> = {},
): ShotAnalysis {
  return {
    id: 'a-1',
    shotType: 'forehand_drive',
    cameraView: 'side',
    createdAt: '2026-09-01T00:00:00.000Z',
    overallScore: 70,
    checkpoints,
    phases: [
      phase('ready', 0, 900),
      phase('contact', 1880, 1920),
      phase('follow_through', 1920, 2400),
    ],
    priorityFix: null,
    limitingFactors: [],
    ...overrides,
  } as ShotAnalysis;
}

const PROTOTYPE_KEYS = [
  'constructor',
  '__proto__',
  'toString',
  'hasOwnProperty',
];

function looksLikeLeakedInternals(text: string): boolean {
  return (
    text.includes('function ') ||
    text.includes('[object ') ||
    text.includes('undefined') ||
    text.includes('null') ||
    text.includes('NaN')
  );
}

describe('coaching copy bounds', () => {
  it('every cue for every checkpoint × direction × shot type is trimmed, non-empty and ≤ 120 chars (FormReviewPlayer reserves 3 body lines on that budget)', () => {
    let max = 0;
    for (const key of CHECKPOINTS) {
      for (const direction of FAULT_DIRECTIONS) {
        for (const shotType of SHOT_TYPES) {
          const cue = coachingCue(key, direction, shotType);
          expect(typeof cue).toBe('string');
          expect(cue.trim()).toBe(cue);
          expect(cue.length).toBeGreaterThan(0);
          expect(cue.length).toBeLessThanOrEqual(120);
          max = Math.max(max, cue.length);
        }
      }
    }
    expect(max).toBe(120);
  });

  it('every direction phrase is a short lowercase fragment usable mid-sentence', () => {
    for (const direction of FAULT_DIRECTIONS) {
      const phrase = directionPhrase(direction);
      expect(phrase.length).toBeGreaterThan(0);
      expect(phrase.length).toBeLessThanOrEqual(24);
      expect(phrase).toBe(phrase.trim());
    }
  });
});

describe('PROBE: prototype-chain keys from unvalidated stored JSON', () => {
  it('coachingCue with an inherited-property DIRECTION still returns a real cue string', () => {
    for (const direction of PROTOTYPE_KEYS) {
      const cue = coachingCue(
        'athletic_base',
        direction as FaultDirection,
        'forehand_drive',
      );
      expect(typeof cue).toBe('string');
      expect(cue.length).toBeGreaterThan(0);
      expect(looksLikeLeakedInternals(cue)).toBe(false);
    }
  });

  it('coachingCue with an inherited-property SHOT TYPE still returns a real cue string', () => {
    for (const shotType of PROTOTYPE_KEYS) {
      const cue = coachingCue(
        'athletic_base',
        'narrow',
        shotType as ShotAnalysis['shotType'],
      );
      expect(typeof cue).toBe('string');
      expect(cue.length).toBeGreaterThan(0);
      expect(looksLikeLeakedInternals(cue)).toBe(false);
    }
  });

  it('directionPhrase / stopHeadline with an inherited-property direction reads as "off target", not as an Object internal', () => {
    for (const direction of PROTOTYPE_KEYS) {
      const phrase = directionPhrase(direction as FaultDirection);
      expect(typeof phrase).toBe('string');
      expect(looksLikeLeakedInternals(phrase)).toBe(false);
      const headline = stopHeadline({
        key: 'athletic_base',
        name: 'Athletic base',
        score: 60,
        band: 'yellow',
        direction: direction as FaultDirection,
        severity: 0.4,
      });
      expect(looksLikeLeakedInternals(headline)).toBe(false);
    }
  });

  it('fixList / buildFormReviewScript with inherited-property band+direction never throw and never leak internals into rendered copy', () => {
    for (const bad of PROTOTYPE_KEYS) {
      const a = analysis([
        checkpoint(
          'athletic_base',
          61,
          bad as ScoreBand,
          bad as FaultDirection,
        ),
        checkpoint('contact_position', 58, 'yellow', bad as FaultDirection),
        checkpoint('follow_through', 88, 'green', 'none'),
      ]);
      const fixes = fixList(a);
      for (const fix of fixes) {
        expect(typeof fix.cue).toBe('string');
        expect(fix.cue.length).toBeGreaterThan(0);
        expect(looksLikeLeakedInternals(fix.cue)).toBe(false);
        expect(looksLikeLeakedInternals(fix.headline)).toBe(false);
      }
      const script = buildFormReviewScript(a, null);
      for (const stop of script.stops) {
        expect(typeof stop.cue).toBe('string');
        expect(stop.cue.length).toBeGreaterThan(0);
        expect(looksLikeLeakedInternals(stop.cue)).toBe(false);
        expect(looksLikeLeakedInternals(stop.headline)).toBe(false);
      }
      expect(strengthList(a).map(cp => cp.key)).toEqual(['follow_through']);
    }
  });
});

describe('band / score consistency', () => {
  it("a finite score with band 'unscored' is neither a fix nor a strength (claims nothing)", () => {
    const a = analysis([
      checkpoint('athletic_base', 40, 'unscored', 'narrow'),
      checkpoint('contact_position', 95, 'unscored', 'none'),
    ]);
    expect(fixList(a)).toEqual([]);
    expect(strengthList(a)).toEqual([]);
  });

  it('a red checkpoint whose direction is none still lists as a fix with the keep-cue (no invented correction)', () => {
    const a = analysis([checkpoint('athletic_base', 30, 'red', 'none')]);
    const fixes = fixList(a);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]!.cue).toBe(
      coachingCue('athletic_base', 'none', 'forehand_drive'),
    );
    expect(fixes[0]!.headline).toContain('held its target');
  });

  it('priorityFix pointing at a GREEN checkpoint does not promote it into the fix list', () => {
    const a = analysis(
      [
        checkpoint('athletic_base', 90, 'green', 'none'),
        checkpoint('contact_position', 55, 'yellow', 'late'),
      ],
      {
        priorityFix: {
          checkpoint: 'athletic_base',
          reasonKey: 'lowest_score',
          severity: 0.1,
          confidence: 0.8,
        },
      },
    );
    expect(fixList(a).map(f => f.key)).toEqual(['contact_position']);
    expect(fixList(a)[0]!.isPriority).toBe(false);
  });
});
