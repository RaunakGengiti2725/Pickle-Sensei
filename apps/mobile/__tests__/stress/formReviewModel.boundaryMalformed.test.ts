import { CHECKPOINTS, PHASES, type ShotAnalysis } from '@pickle/shared-types';
import {
  POSE_FRAME_TOLERANCE_MS,
  REVIEW_JOINTS,
  buildFormReviewScript,
  coachingCue,
  directionPhrase,
  dominantSide,
  facingSign,
  fixList,
  jointHeatAt,
  poseFrameAt,
  reviewArrow,
  reviewVideoSize,
  stopHeadline,
  strengthList,
  type FormReviewScript,
  type ReviewPoseSequence,
  type ReviewStop,
  type ReviewStopCheckpoint,
} from '../../src/review/formReviewModel';
import {
  ALL_DIRECTIONS,
  PROTO_KEYS,
  ResultTable,
  Rng,
  brokenSummary,
  campaignPlan,
  invariant,
  jsonRoundTrip,
  mutateAnalysis,
  mutateSequenceTyped,
  prototypeFingerprint,
  runCase,
  safeString,
  validAnalysis,
  validSequence,
  weirdNumber,
} from '../../test-support/stress/reviewMalformed';

/**
 * STRESS · boundary/malformed input · formReviewModel.
 *
 * The model's own contract (file header + coachingCue/participatingCheckpoints
 * comments): stored analyses are UNVALIDATED JSON, every stop/headline/cue
 * traces to a scored checkpoint, a cue is ALWAYS a non-empty string, frames
 * are never invented. This suite feeds seeded malformed analyses and
 * well-typed-but-pathological sequences through every exported selector and
 * asserts the documented output shape — never a throw, never a fabricated
 * or non-string line.
 *
 * Scale: `STRESS_ITER=<n>` iterations per campaign (default keeps the suite
 * fast); replay one seed with `STRESS_SEED=<seed>`.
 */

const table = new ResultTable('formReviewModel');
const plan = campaignPlan(40);
const ARROW_DIRECTIONS = new Set([
  'up',
  'down',
  'forward',
  'back',
  'wider',
  'narrower',
  'steadier',
]);
const DIRECTION_PHRASE_SET = new Set(ALL_DIRECTIONS.map(directionPhrase));
DIRECTION_PHRASE_SET.add('was off target');

afterAll(() => {
  table.flush();
});

function isReviewJoint(value: unknown): boolean {
  return (REVIEW_JOINTS as readonly string[]).includes(value as string);
}

function checkStopCheckpoint(cp: ReviewStopCheckpoint, where: string): void {
  invariant(
    (CHECKPOINTS as readonly string[]).includes(cp.key),
    `${where}.key is a known checkpoint (got ${safeString(cp.key)})`,
  );
  invariant(
    typeof cp.name === 'string' && cp.name.length > 0,
    `${where}.name non-empty string`,
  );
  invariant(Number.isFinite(cp.score), `${where}.score finite`);
  invariant(
    Number.isFinite(cp.severity) && cp.severity >= 0 && cp.severity <= 1,
    `${where}.severity in [0,1]`,
  );
}

function checkHeadline(headline: unknown, where: string): void {
  invariant(
    typeof headline === 'string' && headline.length > 0,
    `${where} is a non-empty string (got ${safeString(headline)})`,
  );
  const text = headline as string;
  invariant(
    !text.includes('[object') && !text.includes('native code'),
    `${where} leaks a non-string interpolation: ${safeString(text)}`,
  );
  const phrase = text.split(' — ')[1];
  invariant(
    phrase !== undefined && DIRECTION_PHRASE_SET.has(phrase),
    `${where} ends in a known direction phrase (got ${safeString(text)})`,
  );
}

function checkCue(cue: unknown, where: string): void {
  invariant(
    typeof cue === 'string' && cue.length > 0,
    `${where} cue is a non-empty string (got ${safeString(cue)})`,
  );
}

function checkStop(stop: ReviewStop, index: number): void {
  const where = `stops[${index}]`;
  invariant(
    (PHASES as readonly string[]).includes(stop.phase),
    `${where}.phase known`,
  );
  invariant(stop.id === `stop-${stop.phase}`, `${where}.id derives from phase`);
  invariant(
    Number.isFinite(stop.atMs) &&
      Number.isFinite(stop.startMs) &&
      Number.isFinite(stop.endMs),
    `${where} times finite`,
  );
  invariant(stop.startMs <= stop.endMs, `${where}.startMs <= endMs`);
  invariant(
    typeof stop.title === 'string' && stop.title.length > 0,
    `${where}.title`,
  );
  invariant(
    stop.verdict === 'strong' ||
      stop.verdict === 'watch' ||
      stop.verdict === 'fix',
    `${where}.verdict`,
  );
  invariant(Array.isArray(stop.checkpoints), `${where}.checkpoints array`);
  stop.checkpoints.forEach((cp, i) =>
    checkStopCheckpoint(cp, `${where}.checkpoints[${i}]`),
  );
  for (let i = 1; i < stop.checkpoints.length; i += 1) {
    invariant(
      stop.checkpoints[i - 1]!.score <= stop.checkpoints[i]!.score,
      `${where}.checkpoints worst-first`,
    );
  }
  if (stop.checkpoints.length === 0) {
    invariant(stop.phase === 'contact', `${where} empty stop only at contact`);
    invariant(
      typeof stop.headline === 'string' && stop.headline.length > 0,
      `${where}.headline`,
    );
  } else {
    checkHeadline(stop.headline, `${where}.headline`);
  }
  checkCue(stop.cue, where);
  invariant(
    Array.isArray(stop.focusJoints) &&
      stop.focusJoints.length > 0 &&
      stop.focusJoints.every(isReviewJoint),
    `${where}.focusJoints ⊆ REVIEW_JOINTS`,
  );
  if (stop.arrow !== null) {
    invariant(isReviewJoint(stop.arrow.joint), `${where}.arrow.joint`);
    invariant(
      ARROW_DIRECTIONS.has(stop.arrow.direction),
      `${where}.arrow.direction`,
    );
    invariant(
      typeof stop.arrow.label === 'string' && stop.arrow.label.length > 0,
      `${where}.arrow.label`,
    );
    invariant(stop.verdict !== 'strong', `${where} strong stop has no arrow`);
  }
}

function checkScript(script: FormReviewScript): void {
  invariant(
    script.dominant === 'left' || script.dominant === 'right',
    'dominant side',
  );
  invariant(script.facing === 1 || script.facing === -1, 'facing sign');
  invariant(Array.isArray(script.stops), 'stops array');
  script.stops.forEach(checkStop);
  const phasesSeen = new Set<string>();
  for (const stop of script.stops) {
    invariant(
      !phasesSeen.has(stop.phase),
      `one stop per phase (${stop.phase})`,
    );
    phasesSeen.add(stop.phase);
  }
  for (let i = 1; i < script.stops.length; i += 1) {
    invariant(
      script.stops[i - 1]!.atMs <= script.stops[i]!.atMs,
      'stops ordered by atMs',
    );
  }
  for (const [joint, heat] of Object.entries(script.jointHeat)) {
    invariant(isReviewJoint(joint), `jointHeat key ${joint}`);
    invariant(
      typeof heat === 'number' && heat >= 0 && heat <= 1,
      `jointHeat[${joint}] in [0,1]`,
    );
  }
  if (script.strongest) checkStopCheckpoint(script.strongest, 'strongest');
  if (script.weakest) checkStopCheckpoint(script.weakest, 'weakest');
  if (script.strongest && script.weakest) {
    invariant(
      script.weakest.score <= script.strongest.score,
      'weakest <= strongest',
    );
  }
}

function checkHeat(script: FormReviewScript, tMs: number): void {
  const heat = jointHeatAt(script, tMs);
  for (const [joint, value] of Object.entries(heat)) {
    invariant(isReviewJoint(joint), `heatAt key ${joint}`);
    invariant(
      typeof value === 'number' && value >= 0 && value <= 1,
      `heatAt(${tMs})[${joint}] in [0,1] (got ${String(value)})`,
    );
  }
}

function pickSequence(rng: Rng, log: string[]): ReviewPoseSequence | null {
  const roll = rng.int(0, 3);
  if (roll === 0) {
    log.push('seq=null');
    return null;
  }
  const base = validSequence(rng, rng.pick([1, 2, 30, 60]));
  if (roll === 1) {
    log.push('seq=valid');
    return base;
  }
  const count = rng.int(1, 4);
  log.push(`seq=typedMutations×${count}`);
  return mutateSequenceTyped(rng, base, count, log);
}

/** Malformed analysis, optionally JSON-round-tripped (persisted-row realism:
 * NaN/Infinity become null, undefined disappears). */
function malformedAnalysis(rng: Rng, log: string[]): ShotAnalysis {
  const count = rng.int(1, 6);
  log.push(`analysisMutations×${count}`);
  let analysis = mutateAnalysis(rng, validAnalysis(rng), count, log);
  if (rng.chance(0.4)) {
    log.push('jsonRoundTrip');
    try {
      analysis = jsonRoundTrip(analysis);
    } catch {
      log.push('jsonRoundTrip.failed');
    }
  }
  return analysis;
}

describe('formReviewModel · boundary/malformed campaigns', () => {
  const fingerprint = prototypeFingerprint();

  it('buildFormReviewScript + jointHeatAt hold their contract under malformed analyses', () => {
    for (let i = 0; i < plan.iterations; i += 1) {
      runCase(table, 'buildFormReviewScript', plan.seedAt(i), (rng, log) => {
        const analysis = malformedAnalysis(rng, log);
        const sequence = pickSequence(rng, log);
        const snapshot = safeJson(analysis);
        const script = buildFormReviewScript(analysis, sequence);
        checkScript(script);
        for (const t of [
          NaN,
          Infinity,
          -Infinity,
          -0,
          0,
          1900,
          weirdNumber(rng),
          rng.float() * 4000,
        ]) {
          checkHeat(script, t);
        }
        invariant(safeJson(analysis) === snapshot, 'analysis not mutated');
        invariant(
          prototypeFingerprint() === fingerprint,
          'no prototype pollution',
        );
      });
    }
    expect(brokenSummary(table)).toBe(`0 broken of ${table.records.length}`);
  });

  it('fixList / strengthList return only scored, known checkpoints with string copy', () => {
    const before = table.records.length;
    for (let i = 0; i < plan.iterations; i += 1) {
      runCase(
        table,
        'fixList+strengthList',
        plan.seedAt(i, 0x5151),
        (rng, log) => {
          const analysis = malformedAnalysis(rng, log);
          const limit = rng.pick([
            undefined,
            0,
            1,
            3,
            11,
            -1,
            NaN,
            Infinity,
            -Infinity,
            2.5,
            1e9,
          ]);
          log.push(`limit=${String(limit)}`);
          const fixes =
            limit === undefined ? fixList(analysis) : fixList(analysis, limit);
          const strengths =
            limit === undefined
              ? strengthList(analysis)
              : strengthList(analysis, limit);
          // Array.prototype.slice coerces NaN → 0, so a NaN limit caps at 0.
          const capOf = (fallback: number) =>
            limit === undefined
              ? fallback
              : Number.isNaN(limit)
                ? 0
                : Math.max(0, limit);
          const cap = capOf(3);
          invariant(
            fixes.length <= cap,
            `fixList respects limit ${String(limit)}`,
          );
          const strengthCap = capOf(2);
          invariant(
            strengths.length <= strengthCap,
            `strengthList respects limit ${String(limit)}`,
          );
          const keys = new Set<string>();
          fixes.forEach((item, index) => {
            const where = `fixList[${index}]`;
            invariant(
              (CHECKPOINTS as readonly string[]).includes(item.key),
              `${where}.key known`,
            );
            invariant(!keys.has(item.key), `${where} unique key`);
            keys.add(item.key);
            invariant(Number.isFinite(item.score), `${where}.score finite`);
            invariant(
              item.band === 'red' || item.band === 'yellow',
              `${where}.band is a fault band (got ${safeString(item.band)})`,
            );
            checkHeadline(item.headline, `${where}.headline`);
            checkCue(item.cue, where);
            invariant(
              (PHASES as readonly string[]).includes(item.phase),
              `${where}.phase known`,
            );
            invariant(
              typeof item.isPriority === 'boolean',
              `${where}.isPriority`,
            );
          });
          strengths.forEach((cp, index) => {
            checkStopCheckpoint(cp, `strengthList[${index}]`);
            invariant(cp.band === 'green', `strengthList[${index}] is green`);
          });
          for (let k = 1; k < strengths.length; k += 1) {
            invariant(
              strengths[k - 1]!.score >= strengths[k]!.score,
              'strengths descending',
            );
          }
          invariant(
            prototypeFingerprint() === fingerprint,
            'no prototype pollution',
          );
        },
      );
    }
    expect(brokenSummary(table.since(before))).toBe(
      `0 broken of ${table.records.length - before}`,
    );
  });

  it('poseFrameAt / reviewVideoSize / dominantSide / facingSign never throw on pathological sequences', () => {
    const before = table.records.length;
    for (let i = 0; i < plan.iterations; i += 1) {
      runCase(table, 'poseSelectors', plan.seedAt(i, 0xa7a7), (rng, log) => {
        const sequence = pickSequence(rng, log);
        const analysis = malformedAnalysis(rng, log);
        for (const t of [
          NaN,
          Infinity,
          -Infinity,
          -0,
          0,
          weirdNumber(rng),
          rng.float() * 3000,
        ]) {
          const frame = poseFrameAt(sequence, t);
          if (frame !== null) {
            invariant(Number.isFinite(t), `poseFrameAt(${t}) must be null`);
            invariant(
              Math.abs(frame.timestampMs - t) <= POSE_FRAME_TOLERANCE_MS,
              `poseFrameAt(${t}) within tolerance (got ${frame.timestampMs})`,
            );
            invariant(
              sequence !== null && sequence.frames.includes(frame),
              'poseFrameAt returns a recorded frame, never a new one',
            );
          }
        }
        const size = reviewVideoSize(sequence);
        if (size !== null) {
          invariant(
            Number.isFinite(size.width) &&
              size.width > 0 &&
              Number.isFinite(size.height) &&
              size.height > 0 &&
              Number.isFinite(size.fps),
            `reviewVideoSize positive finite (got ${safeString(size)})`,
          );
        }
        const side = dominantSide(
          sequence,
          { startMs: weirdNumber(rng), endMs: weirdNumber(rng) },
          analysis.handedness,
        );
        invariant(side === 'left' || side === 'right', 'dominantSide');
        const facing = facingSign(sequence, analysis, side);
        invariant(facing === 1 || facing === -1, 'facingSign');
      });
    }
    expect(brokenSummary(table.since(before))).toBe(
      `0 broken of ${table.records.length - before}`,
    );
  });

  it('coachingCue / reviewArrow / directionPhrase / stopHeadline hold for every key×direction×shotType incl. prototype keys', () => {
    const before = table.records.length;
    const directions = [
      ...ALL_DIRECTIONS,
      ...PROTO_KEYS,
      '',
      'LATE',
      'contact_position',
    ];
    const shotTypes = [
      'serve',
      'dink',
      'volley',
      'overhead',
      'third_shot_drop',
      'forehand_drive',
      ...PROTO_KEYS,
      '',
      'unknown_shot',
    ];
    for (let i = 0; i < plan.iterations; i += 1) {
      runCase(table, 'cueVocabulary', plan.seedAt(i, 0xc0de), (rng, log) => {
        const key = rng.pick([
          ...CHECKPOINTS,
          ...PROTO_KEYS,
          'unknown_key',
          '',
        ]);
        const direction = rng.pick(directions);
        const shotType = rng.pick(shotTypes);
        log.push(
          `key=${key}`,
          `direction=${direction}`,
          `shotType=${shotType}`,
        );
        const cue = coachingCue(
          key as Parameters<typeof coachingCue>[0],
          direction as Parameters<typeof coachingCue>[1],
          shotType as Parameters<typeof coachingCue>[2],
        );
        checkCue(cue, `coachingCue(${key},${direction},${shotType})`);
        const arrow = reviewArrow(
          key as Parameters<typeof reviewArrow>[0],
          direction as Parameters<typeof reviewArrow>[1],
          rng.pick(['left', 'right']),
        );
        if (arrow !== null) {
          invariant(isReviewJoint(arrow.joint), 'arrow.joint');
          invariant(ARROW_DIRECTIONS.has(arrow.direction), 'arrow.direction');
        }
        const phrase = directionPhrase(
          direction as Parameters<typeof directionPhrase>[0],
        );
        invariant(
          typeof phrase === 'string' && DIRECTION_PHRASE_SET.has(phrase),
          `directionPhrase(${direction}) is a known phrase (got ${safeString(phrase)})`,
        );
        const headline = stopHeadline({
          key: key as ReviewStopCheckpoint['key'],
          name: 'Contact position',
          score: weirdNumber(rng),
          band: 'red',
          direction: direction as ReviewStopCheckpoint['direction'],
          severity: 0.5,
        });
        checkHeadline(headline, `stopHeadline(direction=${direction})`);
      });
    }
    expect(brokenSummary(table.since(before))).toBe(
      `0 broken of ${table.records.length - before}`,
    );
  });
});

describe('formReviewModel · pinned boundary probes (deterministic repros)', () => {
  const analysisFixture = (): ShotAnalysis => validAnalysis(new Rng(7));

  function withCheckpoint(
    analysis: ShotAnalysis,
    checkpoint: ShotAnalysis['checkpoints'][number],
  ): ShotAnalysis {
    return {
      ...analysis,
      priorityFix: null,
      checkpoints: analysis.checkpoints.map(cp =>
        cp.key === checkpoint.key
          ? checkpoint
          : { ...cp, band: 'green', score: 90, applicable: true },
      ),
    };
  }

  it.each(PROTO_KEYS)(
    'directionPhrase(%p) reads as off target, not an Object.prototype member',
    direction => {
      const phrase = directionPhrase(direction as never);
      expect(typeof phrase).toBe('string');
      expect(phrase).toBe('was off target');
    },
  );

  it.each(PROTO_KEYS)(
    'coachingCue(ready_position, %p, dink) is a non-empty string',
    direction => {
      const cue = coachingCue('ready_position', direction as never, 'dink');
      expect(typeof cue).toBe('string');
      expect(cue.length).toBeGreaterThan(0);
    },
  );

  it.each(PROTO_KEYS)(
    'coachingCue(key=%p, late, dink) returns the neutral unknown-checkpoint line without throwing',
    key => {
      let cue: unknown;
      expect(() => {
        cue = coachingCue(key as never, 'late', 'dink');
      }).not.toThrow();
      expect(typeof cue).toBe('string');
    },
  );

  it.each(PROTO_KEYS)(
    'coachingCue(ready_position, low, shotType=%p) is a non-empty string',
    shotType => {
      const cue = coachingCue('ready_position', 'low', shotType as never);
      expect(typeof cue).toBe('string');
      expect(cue.length).toBeGreaterThan(0);
    },
  );

  it('fixList headline/cue stay strings when a persisted checkpoint carries direction "__proto__"', () => {
    const analysis = withCheckpoint(analysisFixture(), {
      key: 'contact_position',
      score: 40,
      band: 'red',
      direction: '__proto__' as never,
      severity: 0.6,
      applicable: true,
      confidence: 0.8,
    });
    const [fix] = fixList(jsonRoundTrip(analysis), 1);
    expect(fix).toBeDefined();
    expect(typeof fix?.headline).toBe('string');
    expect(fix?.headline).not.toContain('[object');
    expect(typeof fix?.cue).toBe('string');
  });

  it('buildFormReviewScript cue stays a string when a persisted shotType is "__proto__"', () => {
    const analysis = withCheckpoint(
      { ...analysisFixture(), shotType: '__proto__' as never },
      {
        key: 'ready_position',
        score: 40,
        band: 'red',
        direction: 'low',
        severity: 0.6,
        applicable: true,
        confidence: 0.8,
      },
    );
    const script = buildFormReviewScript(jsonRoundTrip(analysis), null);
    const ready = script.stops.find(stop => stop.phase === 'ready');
    expect(ready).toBeDefined();
    expect(typeof ready?.cue).toBe('string');
    expect((ready?.cue as string).length).toBeGreaterThan(0);
  });

  it('poseFrameAt on a sequence whose frames hold a null entry returns null or a frame (never throws)', () => {
    const sequence = {
      frames: [
        { timestampMs: 0, landmarks: [], confidence: 1 },
        null,
        { timestampMs: 66, landmarks: [], confidence: 1 },
      ],
    } as unknown as ReviewPoseSequence;
    expect(() => poseFrameAt(sequence, 33)).not.toThrow();
  });

  it('stopHeadline prints an in-range integer for -0 and rounds finite scores', () => {
    const headline = stopHeadline({
      key: 'contact_position',
      name: 'Contact position',
      score: -0,
      band: 'red',
      direction: 'late',
      severity: 1,
    });
    expect(headline).toBe('Contact position scored 0 — contact came late');
  });
});

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return '[unserializable]';
  }
}
