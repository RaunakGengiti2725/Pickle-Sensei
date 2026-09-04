/**
 * ADVERSARIAL HARNESS — LiveCourtEngine (dormant Live Court rep → analyze →
 * cue → summary loop) driven through the REAL analyzeClip + REAL cue engine
 * with the deterministic fixture vision providers wrapped for seeded latency
 * and seeded failures.
 *
 * Scenarios (evidence: artifacts/live-court-adversarial/<run>/engine/):
 *   E1  10 000 sequential strokes (seeded clip durations, ~10 % too short →
 *       stroke-detector failure): rep numbering, summary invariants, cue
 *       category matrix, per-rep cost, heap growth, determinism vs. a twin.
 *   E2  concurrent bursts (strokes arrive faster than analysis completes):
 *       does the rep number, cue state and personal-best flag follow the
 *       stroke that was analysed, or the completion order?
 *   E3  throwing provider mid-session: rejection surface + counter drift.
 *   E4  failed analyses are invisible to summary(): attempted vs. counted.
 *   E5  audio-coach-core selectCue() driven with 10 000 seeded observations
 *       (scored / low-confidence / severity / score mix, adversarial values):
 *       rule adherence (max consecutive corrections, stable cooldown, PB
 *       monotonicity, low-confidence guidance), category matrix, throws.
 *
 * Pure Node/Jest — nothing here is Apple runtime truth.
 */
import { LiveCourtEngine } from '../src/flow/liveCourt';
import {
  DEFAULT_CUE_RULES,
  INITIAL_COACH_STATE,
  selectCue,
  type CoachState,
  type RepObservation,
} from '@pickle/audio-coach-core';
import { createFixtureVisionProviderSet } from '../../../packages/vision-contracts/test/support/fixtureProvider';
import type { VisionProviderSet } from '@pickle/vision-contracts';
import {
  Evidence,
  heapSample,
  linearFit,
  nowMs,
} from '../harness/liveCourtAdversarial/evidence';
import { SeededRng } from '../harness/liveCourtAdversarial/prng';

declare const process: { env: Record<string, string | undefined> };
process.env.PICKLE_ENV = 'development';

const evidence = new Evidence('engine');
const STROKES = Number(process.env.LIVE_COURT_HARNESS_EVENTS ?? 10_000);

interface Clip {
  uri: string;
  durationMs: number;
  fps: number;
  width: number;
  height: number;
}

/** Seeded clip: 10 % are < 500 ms (fixture stroke detector → corrupted_media failure). */
function seededClip(rng: SeededRng, index: number): Clip {
  const tooShort = rng.chance(0.1);
  return {
    uri: `fixture://forehand/live/${index}`,
    durationMs: tooShort ? rng.int(100, 499) : rng.int(500, 2600),
    fps: 30,
    width: 720,
    height: 1280,
  };
}

function makeEngine(
  providers: VisionProviderSet,
  sessionId: string,
): LiveCourtEngine {
  let counter = 0;
  return new LiveCourtEngine(providers, {
    sessionId,
    shotType: 'forehand_drive',
    focusCheckpoint: 'contact_position',
    handedness: 'right',
    appVersion: '0.1.0-adversarial',
    modelBundleVersion: 'fixture-1',
    makeId: () =>
      `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
  });
}

/** Wrap the fixture set: seeded async latency on stroke detection, optional throw. */
function wrapProviders(
  base: VisionProviderSet,
  options: {
    delayMs?: (index: number) => number;
    throwOn?: (index: number) => boolean;
  } = {},
): VisionProviderSet & { calls: number } {
  let calls = 0;
  const wrapped = {
    ...base,
    get calls() {
      return calls;
    },
    stroke: {
      ...base.stroke,
      async detectStrokes(
        clip: Parameters<VisionProviderSet['stroke']['detectStrokes']>[0],
      ) {
        const index = calls;
        calls += 1;
        const delay = options.delayMs?.(index) ?? 0;
        if (delay > 0)
          await new Promise<void>(resolve =>
            setTimeout(() => resolve(), delay),
          );
        if (options.throwOn?.(index))
          throw new Error(`adversarial provider throw at call ${index}`);
        return base.stroke.detectStrokes(clip);
      },
    },
  };
  return wrapped as VisionProviderSet & { calls: number };
}

function categoryHistogram(cats: readonly string[]): Record<string, number> {
  return cats.reduce<Record<string, number>>(
    (acc, c) => ((acc[c] = (acc[c] ?? 0) + 1), acc),
    {},
  );
}

describe('LiveCourtEngine adversarial rep stream', () => {
  it(`E1 ${STROKES} sequential strokes through real analyzeClip + cue engine: numbering, summary invariants, cue matrix, cost, heap, determinism`, async () => {
    const seed = 0xe10001;
    const providers = wrapProviders(
      createFixtureVisionProviderSet('forehand_drive'),
    );
    const twin = wrapProviders(
      createFixtureVisionProviderSet('forehand_drive'),
    );
    const engine = makeEngine(providers, 'adv-e1');
    const twinEngine = makeEngine(twin, 'adv-e1-twin');
    const rng = new SeededRng(seed);
    const clips: Clip[] = Array.from({ length: STROKES }, (_, i) =>
      seededClip(rng, i),
    );
    const heap: ReturnType<typeof heapSample>[] = [heapSample('E1-start')];
    const perRep: Array<{ repsSoFar: number; meanUs: number; maxUs: number }> =
      [];
    let nulls = 0;
    let trailingNulls = 0;
    let bucketStart = nowMs();
    let bucketMax = 0;
    const repIndices: number[] = [];
    const twinCues: Array<string | null> = [];
    const t0 = nowMs();
    for (let i = 0; i < clips.length; i += 1) {
      const clip = clips[i]!;
      const t = nowMs();
      const rep = await engine.onStroke(clip);
      const dt = nowMs() - t;
      bucketMax = Math.max(bucketMax, dt);
      if (rep === null) {
        nulls += 1;
        trailingNulls += 1;
      } else {
        repIndices.push(rep.repIndex);
        trailingNulls = 0;
      }
      if ((i + 1) % 1000 === 0) {
        perRep.push({
          repsSoFar: i + 1,
          meanUs: ((nowMs() - bucketStart) * 1000) / 1000,
          maxUs: bucketMax * 1000,
        });
        bucketStart = nowMs();
        bucketMax = 0;
        heap.push(heapSample(`E1-after-${i + 1}`));
      }
    }
    const wallMs = nowMs() - t0;
    for (const clip of clips) {
      const rep = await twinEngine.onStroke(clip);
      if (rep !== null) twinCues.push(rep.cue.text);
    }
    const reps = engine.allReps();
    const summary = engine.summary();
    const cues = reps.map(r => r.cue.text ?? null);
    // Rep numbering: strictly increasing, and every gap is exactly a failed (null) stroke.
    const gaps = repIndices.reduce(
      (n, idx, i) => n + (i > 0 ? idx - repIndices[i - 1]! - 1 : idx - 1),
      0,
    );
    const result = {
      seed,
      strokesAttempted: clips.length,
      providerCalls: providers.calls,
      nullResults: nulls,
      repsKept: reps.length,
      repIndexStrictlyIncreasing: repIndices.every(
        (idx, i) => i === 0 || idx > repIndices[i - 1]!,
      ),
      repIndexGaps: gaps,
      lastRepIndex: repIndices[repIndices.length - 1] ?? null,
      allRepsOrderMatchesRepIndex:
        JSON.stringify(reps.map(r => r.repIndex)) ===
        JSON.stringify([...reps.map(r => r.repIndex)].sort((a, b) => a - b)),
      summary,
      summaryAddsUp:
        summary.validReps + summary.lowConfidenceReps === reps.length,
      attemptedMinusCounted:
        clips.length - (summary.validReps + summary.lowConfidenceReps),
      cueCategories: categoryHistogram(reps.map(r => r.cue.category)),
      personalBests: reps.filter(r => r.isPersonalBest).length,
      deterministicVsTwin: JSON.stringify(cues) === JSON.stringify(twinCues),
      wallMs,
      perRep,
      perRepFit: linearFit(perRep.map(r => ({ x: r.repsSoFar, y: r.meanUs }))),
      heap,
      heapDeltaMb: heap[heap.length - 1]!.heapUsedMb - heap[0]!.heapUsedMb,
      heapPerRepKb:
        ((heap[heap.length - 1]!.heapUsedMb - heap[0]!.heapUsedMb) * 1024) /
        Math.max(1, reps.length),
    };
    evidence.writeJson('E1-sequential-stream', result);
    evidence.log(
      `E1 attempted=${clips.length} kept=${reps.length} nulls=${nulls} gaps=${gaps} wall=${wallMs.toFixed(0)}ms heapΔ=${result.heapDeltaMb.toFixed(2)}MB cues=${JSON.stringify(result.cueCategories)}`,
    );
    expect(reps.length + nulls).toBe(clips.length);
    expect(result.repIndexStrictlyIncreasing).toBe(true);
    expect(gaps).toBe(nulls - trailingNulls);
    expect(result.lastRepIndex).toBe(clips.length - trailingNulls);
    expect(result.summaryAddsUp).toBe(true);
    // Pinned failure mode: failed analyses vanish — summary() cannot tell the
    // user how many strokes were attempted but produced nothing.
    expect(result.attemptedMinusCounted).toBe(nulls);
    expect(cues).toEqual(twinCues);
    expect(reps.length).toBeGreaterThan(STROKES * 0.8);
  });

  it('E2 concurrent bursts: rep number / cue state / personal best follow completion order, not stroke order', async () => {
    const seed = 0xe10002;
    const rng = new SeededRng(seed);
    const bursts = Math.max(1, Math.floor(STROKES / 200));
    const perBurst = 200;
    const delays: number[] = [];
    const providers = wrapProviders(
      createFixtureVisionProviderSet('forehand_drive'),
      {
        delayMs: index => delays[index] ?? 0,
      },
    );
    const engine = makeEngine(providers, 'adv-e2');
    const rows: Array<{
      burst: number;
      completionOrderDiffersFromCallOrder: boolean;
      duplicateRepIndices: number;
      distinctRepIndices: number;
      maxRepIndexShare: number;
    }> = [];
    let totalDuplicateRepIndices = 0;
    let strokeOrderMismatches = 0;
    let attempted = 0;
    for (let b = 0; b < bursts; b += 1) {
      const start = engine.allReps().length;
      const promises: Array<
        Promise<{ callOrder: number; repIndex: number | null }>
      > = [];
      for (let i = 0; i < perBurst; i += 1) {
        const callIndex = delays.length;
        delays.push(rng.int(0, 12));
        const clip = {
          ...seededClip(rng, callIndex),
          durationMs: rng.int(500, 2600),
        };
        attempted += 1;
        promises.push(
          engine.onStroke(clip).then(rep => ({
            callOrder: callIndex,
            repIndex: rep?.repIndex ?? null,
          })),
        );
      }
      const settled = await Promise.all(promises);
      const burstReps = engine.allReps().slice(start);
      const repIndexCounts = categoryHistogram(
        burstReps.map(r => String(r.repIndex)),
      );
      const dupes = Object.values(repIndexCounts).reduce(
        (n, c) => n + (c > 1 ? c - 1 : 0),
        0,
      );
      totalDuplicateRepIndices += dupes;
      // Stroke k of the burst should be rep (start + k + 1) — is it?
      for (const s of settled) {
        const expected = start + (s.callOrder - b * perBurst) + 1;
        if (s.repIndex !== expected) strokeOrderMismatches += 1;
      }
      rows.push({
        burst: b,
        completionOrderDiffersFromCallOrder:
          burstReps.some(
            (r, i) => i > 0 && r.repIndex < burstReps[i - 1]!.repIndex,
          ) || dupes > 0,
        duplicateRepIndices: dupes,
        distinctRepIndices: Object.keys(repIndexCounts).length,
        maxRepIndexShare: Math.max(...Object.values(repIndexCounts)) / perBurst,
      });
    }
    const reps = engine.allReps();
    const summary = engine.summary();
    const result = {
      seed,
      bursts,
      perBurst,
      attempted,
      repsKept: reps.length,
      totalDuplicateRepIndices,
      distinctRepIndicesOverall: new Set(reps.map(r => r.repIndex)).size,
      strokeOrderMismatches,
      strokeOrderMismatchRate: strokeOrderMismatches / attempted,
      summary,
      cueCategories: categoryHistogram(reps.map(r => r.cue.category)),
      personalBests: reps.filter(r => r.isPersonalBest).length,
      rows,
      delays,
    };
    evidence.writeJson('E2-concurrent-bursts', result);
    evidence.log(
      `E2 attempted=${attempted} kept=${reps.length} dupRepIdx=${totalDuplicateRepIndices} distinct=${result.distinctRepIndicesOverall} strokeOrderMismatches=${strokeOrderMismatches} (${(result.strokeOrderMismatchRate * 100).toFixed(1)}%)`,
    );
    expect(reps.length).toBe(attempted);
    expect(summary.validReps + summary.lowConfidenceReps).toBe(attempted);
    // Pinned failure mode (liveCourt.ts:67 vs :87/:97): repIndex is read from
    // the shared counter AFTER the await, so concurrent strokes share the
    // counter's latest value — duplicate rep numbers, and the number a stroke
    // gets depends on how many strokes arrived while it was being analysed.
    expect(totalDuplicateRepIndices).toBeGreaterThan(0);
    expect(result.distinctRepIndicesOverall).toBeLessThan(attempted);
    expect(strokeOrderMismatches).toBeGreaterThan(0);
  });

  it('E3 throwing provider mid-session: rejection surfaces, the counter is consumed, engine stays usable', async () => {
    const seed = 0xe10003;
    const rng = new SeededRng(seed);
    const throwEvery = 7;
    const providers = wrapProviders(
      createFixtureVisionProviderSet('forehand_drive'),
      {
        throwOn: index => index % throwEvery === throwEvery - 1,
      },
    );
    const engine = makeEngine(providers, 'adv-e3');
    const total = 700;
    let rejections = 0;
    let trailingRejections = 0;
    let nulls = 0;
    const messages = new Set<string>();
    for (let i = 0; i < total; i += 1) {
      const clip = { ...seededClip(rng, i), durationMs: rng.int(500, 2600) };
      try {
        const rep = await engine.onStroke(clip);
        if (rep === null) nulls += 1;
        trailingRejections = 0;
      } catch (error) {
        rejections += 1;
        trailingRejections += 1;
        messages.add(
          error instanceof Error
            ? error.message.replace(/\d+/g, 'N')
            : String(error),
        );
      }
    }
    const reps = engine.allReps();
    const summary = engine.summary();
    const result = {
      seed,
      total,
      throwEvery,
      rejections,
      nulls,
      repsKept: reps.length,
      lastRepIndex: reps[reps.length - 1]?.repIndex ?? null,
      counterDriftFromRejections:
        (reps[reps.length - 1]?.repIndex ?? 0) - reps.length,
      messages: [...messages],
      summary,
    };
    evidence.writeJson('E3-throwing-provider', result);
    evidence.log(
      `E3 total=${total} rejections=${rejections} kept=${reps.length} lastRepIndex=${result.lastRepIndex}`,
    );
    expect(rejections).toBe(total / throwEvery);
    expect(reps.length).toBe(total - rejections);
    // Rejected strokes still consume a rep number (counter increments before the await).
    expect(result.counterDriftFromRejections).toBe(
      rejections - trailingRejections,
    );
    expect(result.lastRepIndex).toBe(total - trailingRejections);
    expect(summary.validReps + summary.lowConfidenceReps).toBe(reps.length);
    const after = await engine.onStroke({
      uri: 'fixture://after',
      durationMs: 2000,
      fps: 30,
      width: 720,
      height: 1280,
    });
    expect(after).not.toBeNull();
  });

  it('E4 summary() has no field for failed analyses: attempted vs counted across failure rates', async () => {
    const seed = 0xe10004;
    const rows: Array<{
      failRate: number;
      attempted: number;
      nulls: number;
      counted: number;
      invisible: number;
    }> = [];
    for (const failRate of [0, 0.1, 0.5, 0.9]) {
      const rng = new SeededRng(seed ^ Math.round(failRate * 1000));
      const engine = makeEngine(
        wrapProviders(createFixtureVisionProviderSet('forehand_drive')),
        `adv-e4-${failRate}`,
      );
      const attempted = 300;
      let nulls = 0;
      for (let i = 0; i < attempted; i += 1) {
        const clip = {
          ...seededClip(rng, i),
          durationMs: rng.chance(failRate)
            ? rng.int(100, 499)
            : rng.int(500, 2600),
        };
        if ((await engine.onStroke(clip)) === null) nulls += 1;
      }
      const summary = engine.summary();
      const counted = summary.validReps + summary.lowConfidenceReps;
      rows.push({
        failRate,
        attempted,
        nulls,
        counted,
        invisible: attempted - counted,
      });
    }
    evidence.writeJson('E4-failed-analyses-invisible', {
      seed,
      rows,
      summaryFields: [
        'sessionId',
        'validReps',
        'lowConfidenceReps',
        'startScore',
        'endScore',
        'bestScore',
        'focusCheckpoint',
        'focusStart',
        'focusEnd',
        'cuesSpoken',
      ],
    });
    evidence.log(
      `E4 ${rows.map(r => `fail=${r.failRate}:invisible=${r.invisible}/${r.attempted}`).join(' ')}`,
    );
    for (const row of rows) expect(row.invisible).toBe(row.nulls);
    expect(rows[3]!.invisible).toBeGreaterThan(200);
  });

  it(`E5 audio-coach-core selectCue: ${STROKES} seeded observations incl. adversarial values — rule adherence and category matrix`, () => {
    const seed = 0xe10005;
    const rng = new SeededRng(seed);
    const directions: RepObservation['focusDirection'][] = [
      'none',
      'late',
      'early',
      'high',
      'low',
    ];
    let state: CoachState = INITIAL_COACH_STATE;
    const categories: string[] = [];
    const violations: Array<{
      repIndex: number;
      rule: string;
      detail: string;
    }> = [];
    const thrown: Array<{
      repIndex: number;
      observation: RepObservation;
      message: string;
    }> = [];
    let consecutiveCorrections = 0;
    let spokenCorrectionRun = 0;
    let maxSpokenCorrectionRun = 0;
    let lastStable: number | null = null;
    let bestSeen: number | null = null;
    const observations: RepObservation[] = [];
    for (let i = 1; i <= STROKES; i += 1) {
      const lowConf = rng.chance(0.15);
      const adversarial = rng.chance(0.02);
      const score = lowConf
        ? null
        : adversarial
          ? rng.pick([Number.NaN, Number.POSITIVE_INFINITY, -1, 11, 0])
          : Math.round(rng.float(2, 10) * 10) / 10;
      const severity = lowConf
        ? 0
        : adversarial
          ? rng.pick([Number.NaN, -0.5, 2, Number.POSITIVE_INFINITY])
          : rng.float(0, 0.8);
      const observation: RepObservation = {
        repIndex: i,
        resultKind: lowConf ? 'low_confidence' : 'scored',
        overallScore: score,
        focusCheckpoint: 'contact_position',
        focusScore: lowConf ? null : rng.float(20, 100),
        focusDirection: rng.pick(directions),
        focusSeverity: severity,
      };
      observations.push(observation);
      const before = state;
      try {
        const { decision, nextState } = selectCue(state, observation);
        state = nextState;
        categories.push(decision.category);
        if (
          decision.category === 'CORRECTION' ||
          decision.category === 'REPEAT'
        ) {
          spokenCorrectionRun += 1;
          maxSpokenCorrectionRun = Math.max(
            maxSpokenCorrectionRun,
            spokenCorrectionRun,
          );
          if (observation.resultKind === 'low_confidence') {
            // Setup guidance after a no-read streak resets the engine's counter by rule.
            consecutiveCorrections = 0;
          } else {
            consecutiveCorrections += 1;
            if (
              consecutiveCorrections >
              DEFAULT_CUE_RULES.maxConsecutiveCorrections
            ) {
              violations.push({
                repIndex: i,
                rule: 'maxConsecutiveCorrections',
                detail: `${consecutiveCorrections} in a row`,
              });
            }
          }
        } else {
          consecutiveCorrections = 0;
          spokenCorrectionRun = 0;
        }
        if (decision.category === 'STABLE') {
          if (
            lastStable !== null &&
            i - lastStable < DEFAULT_CUE_RULES.stableCooldownReps
          ) {
            violations.push({
              repIndex: i,
              rule: 'stableCooldownReps',
              detail: `gap ${i - lastStable}`,
            });
          }
          lastStable = i;
        }
        if (decision.category === 'PERSONAL_BEST') {
          if (
            bestSeen !== null &&
            !(
              observation.overallScore !== null &&
              observation.overallScore > bestSeen
            )
          ) {
            violations.push({
              repIndex: i,
              rule: 'personalBestMonotonic',
              detail: `score ${observation.overallScore} vs best ${bestSeen}`,
            });
          }
        }
        if (
          observation.overallScore !== null &&
          Number.isFinite(observation.overallScore)
        ) {
          bestSeen =
            bestSeen === null
              ? observation.overallScore
              : Math.max(bestSeen, observation.overallScore);
        }
        if (
          decision.text !== null &&
          /NaN|Infinity|undefined|null/.test(decision.text)
        ) {
          violations.push({
            repIndex: i,
            rule: 'nonFiniteInSpokenText',
            detail: decision.text,
          });
        }
      } catch (error) {
        thrown.push({
          repIndex: i,
          observation,
          message: error instanceof Error ? error.message : String(error),
        });
        state = before;
      }
    }
    const nanBest = Number.isNaN(state.bestOverallScore);
    const result = {
      seed,
      observations: STROKES,
      categories: categoryHistogram(categories),
      spokenRate: categories.filter(c => c !== 'SILENCE').length / STROKES,
      maxSpokenCorrectionRunIncludingSetupGuidance: maxSpokenCorrectionRun,
      violations,
      thrown,
      finalState: state,
      bestOverallScoreIsNaN: nanBest,
      bestOverallScoreIsInfinite:
        state.bestOverallScore !== null &&
        !Number.isFinite(state.bestOverallScore) &&
        !nanBest,
      firstAdversarialObservations: observations
        .filter(
          o => o.overallScore !== null && !Number.isFinite(o.overallScore),
        )
        .slice(0, 5),
    };
    evidence.writeJson('E5-cue-engine-stream', result);
    evidence.log(
      `E5 categories=${JSON.stringify(result.categories)} violations=${violations.length} thrown=${thrown.length} maxSpokenCorrectionRun=${maxSpokenCorrectionRun} bestNaN=${nanBest} bestInf=${result.bestOverallScoreIsInfinite}`,
    );
    expect(thrown).toHaveLength(0);
    expect(
      violations.filter(v => v.rule === 'stableCooldownReps'),
    ).toHaveLength(0);
    expect(
      violations.filter(v => v.rule === 'maxConsecutiveCorrections'),
    ).toHaveLength(0);
    // Pinned: an Infinity/NaN overall score poisons bestOverallScore for the rest
    // of the session (no PERSONAL_BEST can ever fire again) — no input validation.
    expect(result.bestOverallScoreIsInfinite || nanBest).toBe(true);
  });
});
