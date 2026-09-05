/**
 * STRESS · mod-live-court · lens boundary-malformed
 * Targets: LiveCourtEngine (apps/mobile/src/flow/liveCourt.ts),
 *          sessionScoreProgression + buildLiveSessionSummaryRecord →
 *          parseLiveSessionSummaryRecord round trip
 *          (apps/mobile/src/flow/liveSessionSummary.ts, sessionProgress.ts).
 *
 * Campaigns (seeded, replayable):
 *   E. LiveCourtEngine through the REAL analyzeClip pipeline with the
 *      deterministic fixture providers: hostile option ids (NUL, 64K,
 *      traversal, __proto__), unknown focus checkpoints, malformed clip
 *      objects (NaN/±Infinity/-0/negative/huge/wrong-type fields, empty
 *      object, hostile uris), 10k+ strokes; summary() must stay consistent
 *      with the returned reps and never throw.
 *   P. sessionScoreProgression + summary record build/parse over 10k+
 *      shuffled in-contract events (ordering, best-tie, delta, round trip)
 *      and over poisoned snapshot/recap fields (tabulated: what the durable
 *      record drops or zeroes).
 *
 * KNOWN FINDING F2 (gated, heavy — STRESS_LIVECOURT_SPREAD=1):
 *   `LiveCourtEngine.summary()` computes `Math.max(...scores)`; V8 throws
 *   RangeError "Maximum call stack size exceeded" once the spread exceeds the
 *   argument limit (~120–125k scored reps on Node 22). Pinned as
 *   `test.failing` behind the flag because the reproduction needs ~125k
 *   pipeline runs (~17 s, ~0.9 GB heap). Hermes' limit is UNKNOWN from Linux.
 *
 * Campaign size: STRESS_ITER (default 60 per campaign). Replay: STRESS_SEED.
 * Stroke volume: STRESS_LIVECOURT_REPS (default 2000; campaign ran 10k+).
 */
import type { CheckpointKey } from '@pickle/shared-types';
import { CHECKPOINTS } from '@pickle/shared-types';
import { createFixtureVisionProviderSet } from '../../../../packages/vision-contracts/test/support/fixtureProvider';
import { LiveCourtEngine, type LiveRep } from '../../src/flow/liveCourt';
import type { SessionEventView } from '../../src/flow/session';
import {
  buildLiveSessionSummaryRecord,
  parseLiveSessionSummaryRecord,
} from '../../src/flow/liveSessionSummary';
import { sessionScoreProgression } from '../../src/flow/sessionProgress';
import {
  EVENT_MALFORMATIONS,
  POISON_NUMBERS,
  POISON_STRINGS,
  PROTO_KEYS,
  campaignSeeds,
  chance,
  describeError,
  malformEvent,
  objectPrototypePolluted,
  pick,
  poisonValue,
  preview,
  randomInt,
  recordViolations,
  replayCommand,
  seededRandom,
  stressIterations,
  validEvent,
  validRecap,
  validSnapshot,
  writeStressTable,
  type EventMalformation,
  type Rng,
  type StressRow,
} from '../../testing/stress/liveCourtBoundary';

declare const process: { env: Record<string, string | undefined> };
process.env['PICKLE_ENV'] = 'development';

const SUITE = '__tests__/stress/liveCourtEngineSummary.stress.test.ts';
const ITER = stressIterations(60);
const REPS = Number(process.env['STRESS_LIVECOURT_REPS'] ?? '2000');
const SPREAD_REPRO = process.env['STRESS_LIVECOURT_SPREAD'] === '1';

const GOOD_CLIP = {
  uri: 'fixture://forehand/live',
  durationMs: 2400,
  fps: 30,
  width: 720,
  height: 1280,
};

type EngineOptions = ConstructorParameters<typeof LiveCourtEngine>[1];

function makeEngine(overrides: Partial<EngineOptions>): LiveCourtEngine {
  let counter = 0;
  return new LiveCourtEngine(createFixtureVisionProviderSet('forehand_drive'), {
    sessionId: '11111111-2222-4333-8444-555555555555',
    shotType: 'forehand_drive',
    focusCheckpoint: 'contact_position',
    handedness: 'right',
    appVersion: '0.1.0-stress',
    modelBundleVersion: 'fixture-1',
    makeId: () =>
      `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
    ...overrides,
  });
}

function hostileString(rng: Rng): string {
  return pick(rng, [...POISON_STRINGS, ...PROTO_KEYS]);
}

type Clip = Parameters<LiveCourtEngine['onStroke']>[0];

function malformedClip(rng: Rng): Clip {
  const clip: Record<string, unknown> = { ...GOOD_CLIP };
  const roll = rng();
  if (roll < 0.1) return {} as Clip;
  if (roll < 0.2) {
    for (const key of Object.keys(clip)) clip[key] = poisonValue(rng, true);
    return clip as unknown as Clip;
  }
  const field = pick(rng, ['uri', 'durationMs', 'fps', 'width', 'height']);
  clip[field] =
    field === 'uri'
      ? chance(rng, 0.8)
        ? hostileString(rng)
        : poisonValue(rng, true)
      : chance(rng, 0.8)
        ? pick(rng, POISON_NUMBERS)
        : poisonValue(rng, true);
  return clip as unknown as Clip;
}

function summaryViolations(
  engine: LiveCourtEngine,
  reps: readonly (LiveRep | null)[],
  strokes: number,
  focus: CheckpointKey,
): string[] {
  const out: string[] = [];
  const summary = engine.summary();
  const kept = reps.filter((rep): rep is LiveRep => rep !== null);
  const scored = kept.filter(rep => rep.analysis.resultKind === 'scored');
  const scores = scored
    .map(rep => rep.analysis.overallScore)
    .filter((score): score is number => score !== null);
  if (summary.validReps !== scored.length)
    out.push(`validReps ${summary.validReps}!=${scored.length}`);
  if (summary.lowConfidenceReps !== kept.length - scored.length) {
    out.push(
      `lowConfidenceReps ${summary.lowConfidenceReps}!=${kept.length - scored.length}`,
    );
  }
  if (summary.validReps + summary.lowConfidenceReps > strokes)
    out.push('reps exceed strokes');
  const best = scores.length ? Math.max(...scores) : null;
  if (summary.bestScore !== best)
    out.push(`bestScore ${String(summary.bestScore)}!=${String(best)}`);
  if (summary.startScore !== (scores[0] ?? null))
    out.push('startScore mismatch');
  if (summary.endScore !== (scores[scores.length - 1] ?? null))
    out.push('endScore mismatch');
  if (summary.focusCheckpoint !== focus) out.push('focusCheckpoint changed');
  const cued = kept.filter(rep => rep.cue.category !== 'SILENCE').length;
  if (summary.cuesSpoken !== cued)
    out.push(`cuesSpoken ${summary.cuesSpoken}!=${cued}`);
  let previous = 0;
  let runningBest: number | null = null;
  for (const rep of kept) {
    if (rep.repIndex <= previous) out.push('repIndex not increasing');
    previous = rep.repIndex;
    const score = rep.analysis.overallScore;
    const expectedPb =
      score !== null && runningBest !== null && score > runningBest;
    if (rep.isPersonalBest !== expectedPb)
      out.push(`isPersonalBest wrong at rep ${rep.repIndex}`);
    if (score !== null && (runningBest === null || score > runningBest))
      runningBest = score;
  }
  return out;
}

interface Outcome {
  row: StressRow;
  hardFailure: string | null;
}

type EngineFamily =
  'hostile_options' | 'malformed_clips' | 'volume' | 'mixed_stream';

async function runEngineSeed(seed: number): Promise<Outcome> {
  const rng = seededRandom(seed);
  const family: EngineFamily = pick(rng, [
    'hostile_options',
    'malformed_clips',
    'malformed_clips',
    'volume',
    'mixed_stream',
  ]);
  const focus = chance(rng, 0.85)
    ? pick(rng, CHECKPOINTS)
    : (hostileString(rng) as CheckpointKey);
  const overrides: Partial<EngineOptions> = { focusCheckpoint: focus };
  let detail = `focus=${preview(focus, 30)}`;
  if (family === 'hostile_options') {
    overrides.sessionId = hostileString(rng);
    if (chance(rng, 0.5)) overrides.appVersion = hostileString(rng);
    if (chance(rng, 0.5)) overrides.modelBundleVersion = hostileString(rng);
    if (chance(rng, 0.3))
      overrides.handedness = pick(rng, ['left', 'ambidextrous']);
    if (chance(rng, 0.5)) {
      const id = hostileString(rng);
      overrides.makeId = () => id;
    }
    detail += ` sessionId=${preview(overrides.sessionId, 30)}`;
  }
  const engine = makeEngine(overrides);
  const reps: (LiveRep | null)[] = [];
  const strokes =
    family === 'volume' ? REPS + randomInt(rng, 0, 500) : randomInt(rng, 0, 40);
  const clipOutcomes: Record<string, number> = {};
  try {
    for (let i = 0; i < strokes; i += 1) {
      const useBad =
        family === 'malformed_clips'
          ? chance(rng, 0.7)
          : family === 'mixed_stream'
            ? chance(rng, 0.25)
            : false;
      const clip = useBad
        ? malformedClip(rng)
        : { ...GOOD_CLIP, uri: `fixture://forehand/${seed}/${i}` };
      const rep = await engine.onStroke(clip);
      reps.push(rep);
      const key = useBad
        ? rep === null
          ? 'bad→null'
          : `bad→${rep.analysis.resultKind}`
        : 'good';
      clipOutcomes[key] = (clipOutcomes[key] ?? 0) + 1;
    }
    const violations = summaryViolations(engine, reps, strokes, focus);
    if (objectPrototypePolluted()) violations.push('prototype polluted');
    if (
      engine.summary().sessionId !==
      (overrides.sessionId ?? '11111111-2222-4333-8444-555555555555')
    ) {
      violations.push('sessionId not echoed verbatim');
    }
    detail += ` strokes=${strokes} ${JSON.stringify(clipOutcomes)}`;
    if (violations.length) {
      return {
        row: {
          seed,
          family,
          outcome: 'BROKEN:invariant',
          detail: `${detail} | ${violations.join('; ')}`,
        },
        hardFailure: violations.join('; '),
      };
    }
    return {
      row: { seed, family, outcome: 'HELD', detail },
      hardFailure: null,
    };
  } catch (error) {
    // The deterministic fixture provider is TEST SUPPORT, not product code: a
    // non-JSON poison (BigInt/Symbol) in a clip field that blows up inside
    // packages/vision-contracts/test/support is recorded, not counted as a
    // LiveCourtEngine failure.
    const stack = error instanceof Error ? (error.stack ?? '') : '';
    if (stack.includes('fixtureProvider')) {
      return {
        row: {
          seed,
          family,
          outcome: 'OBSERVED:fixture_provider_throw',
          detail: `${detail} ${describeError(error)}`,
        },
        hardFailure: null,
      };
    }
    return {
      row: {
        seed,
        family,
        outcome: 'BROKEN:throw',
        detail: `${detail} ${describeError(error)}`,
      },
      hardFailure: `engine threw ${describeError(error)}`,
    };
  }
}

// ─── Progression + durable record ──────────────────────────────────────────

type ProgressionFamily =
  | 'shuffled_valid'
  | 'ten_k_shuffled'
  | 'malformed_events'
  | 'poisoned_snapshot_fields'
  | 'poisoned_recap'
  | 'empty';

function progressionViolations(events: SessionEventView[]): string[] {
  const out: string[] = [];
  const progression = sessionScoreProgression(events);
  const scored = events
    .filter(
      event =>
        event.state === 'ready' &&
        event.analysis?.result?.resultKind === 'scored' &&
        event.analysis.result.overallScore !== null,
    )
    .sort((a, b) => a.index - b.index);
  if (progression.scoredCount !== scored.length) out.push('scoredCount');
  if (progression.points.length !== scored.length) out.push('points length');
  for (let i = 1; i < progression.points.length; i += 1) {
    const a = progression.points[i - 1];
    const b = progression.points[i];
    if (a && b && a.eventIndex > b.eventIndex)
      out.push('points not index-sorted');
  }
  const pending = events.filter(
    e => e.state === 'pending' || e.state === 'processing',
  ).length;
  if (progression.pendingCount !== pending) out.push('pendingCount');
  const noRead = events.filter(
    e =>
      e.state === 'abstained' ||
      (e.state === 'ready' &&
        e.analysis !== undefined &&
        (e.analysis === null ||
          e.analysis.result === null ||
          e.analysis.result.resultKind === 'low_confidence')),
  ).length;
  if (progression.noReadCount !== noRead)
    out.push(`noReadCount ${progression.noReadCount}!=${noRead}`);
  if (scored.length < 2 && progression.delta !== null)
    out.push('delta with <2 scored');
  if (
    scored.length === 0 &&
    (progression.startAverage !== null || progression.best !== null)
  ) {
    out.push('averages without scores');
  }
  if (progression.best) {
    const max = Math.max(...progression.points.map(p => p.score));
    const earliest = progression.points.find(p => p.score === max);
    if (
      progression.best.score !== max ||
      progression.best.eventId !== earliest?.eventId
    ) {
      out.push('best not earliest max');
    }
  }
  return out;
}

function runProgressionSeed(seed: number): Outcome {
  const rng = seededRandom(seed);
  const family: ProgressionFamily = pick(rng, [
    'shuffled_valid',
    'shuffled_valid',
    'ten_k_shuffled',
    'malformed_events',
    'poisoned_snapshot_fields',
    'poisoned_recap',
    'empty',
  ]);
  const count =
    family === 'ten_k_shuffled'
      ? randomInt(rng, 10_000, 12_000)
      : family === 'empty'
        ? 0
        : randomInt(rng, 1, 60);
  const events: SessionEventView[] = [];
  for (let i = 0; i < count; i += 1) events.push(validEvent(rng, i));
  let detail = `events=${count}`;
  if (family === 'malformed_events') {
    const malformKind: EventMalformation = pick(rng, EVENT_MALFORMATIONS);
    const at = randomInt(rng, 0, count - 1);
    events[at] = malformEvent(rng, at, malformKind);
    detail += ` malformed=${malformKind}`;
  }
  // out-of-order views, as the lens demands
  for (let i = events.length - 1; i > 0; i -= 1) {
    const j = randomInt(rng, 0, i);
    const a = events[i];
    const b = events[j];
    if (a && b) {
      events[i] = b;
      events[j] = a;
    }
  }
  try {
    const violations =
      family === 'malformed_events' ? [] : progressionViolations(events);
    const progression = sessionScoreProgression(events);
    const snapshot = validSnapshot(rng, events, {
      durationMs: randomInt(rng, 0, 7_200_000),
      engineVersion: chance(rng, 0.7) ? 'stress-engine-1' : hostileString(rng),
    });
    const recap = chance(rng, 0.2) ? null : validRecap(rng);
    const loose = snapshot as unknown as Record<string, unknown>;
    const looseRecap = recap as unknown as Record<string, unknown> | null;
    if (family === 'poisoned_snapshot_fields') {
      const field = pick(rng, [
        'durationMs',
        'strokeCount',
        'engineVersion',
        'source',
      ]);
      loose[field] =
        field === 'engineVersion' || field === 'source'
          ? poisonValue(rng, true)
          : pick(rng, [...POISON_NUMBERS, 1234.5, 0.1]);
      detail += ` ${field}=${preview(loose[field], 30)}`;
    }
    if (family === 'poisoned_recap' && looseRecap) {
      const roll = rng();
      if (roll < 0.4) {
        looseRecap['spokenCount'] = pick(rng, POISON_NUMBERS);
        detail += ` spokenCount=${preview(looseRecap['spokenCount'])}`;
      } else if (roll < 0.7) {
        const corrections: Record<string, unknown> = {};
        for (let i = 0; i < randomInt(rng, 1, 4); i += 1) {
          corrections[hostileString(rng).slice(0, 40) || 'k'] = pick(rng, [
            ...POISON_NUMBERS,
            'three',
            null,
          ]);
        }
        looseRecap['correctionsByCheckpoint'] = corrections;
        detail += ' corrections=poison';
      } else {
        looseRecap['topCorrection'] = poisonValue(rng, true);
        detail += ` topCorrection=${preview(looseRecap['topCorrection'], 30)}`;
      }
    }
    const record = buildLiveSessionSummaryRecord(snapshot, progression, recap);
    const json = JSON.stringify(record);
    const parsed = parseLiveSessionSummaryRecord(json);
    let outcome = 'HELD';
    if (
      family === 'shuffled_valid' ||
      family === 'ten_k_shuffled' ||
      family === 'empty'
    ) {
      if (parsed === null)
        violations.push('in-contract record rejected by parser');
      else if (JSON.stringify(parsed) !== json) {
        violations.push(
          `round trip lossy: ${preview(parsed, 200)} vs ${preview(record, 200)}`,
        );
      } else if (recordViolations(parsed).length)
        violations.push(recordViolations(parsed).join(','));
    } else if (parsed === null) {
      outcome = 'HELD:poison_record_rejected';
    } else if (JSON.stringify(parsed) !== json) {
      const dropped = (Object.keys(record) as (keyof typeof record)[]).filter(
        key => JSON.stringify(parsed[key]) !== JSON.stringify(record[key]),
      );
      outcome = 'HELD:poison_normalized';
      detail += ` normalized=${dropped.join(',')}`;
    } else if (recordViolations(parsed).length) {
      outcome = 'OBSERVED:poison_survives_round_trip';
      detail += ` violations=${recordViolations(parsed).join(',')}`;
    }
    if (objectPrototypePolluted()) violations.push('prototype polluted');
    if (violations.length) {
      return {
        row: {
          seed,
          family,
          outcome: 'BROKEN:invariant',
          detail: `${detail} | ${violations.join('; ')}`,
        },
        hardFailure: violations.join('; '),
      };
    }
    return { row: { seed, family, outcome, detail }, hardFailure: null };
  } catch (error) {
    if (family === 'malformed_events') {
      return {
        row: {
          seed,
          family,
          outcome: 'OBSERVED:throw_on_out_of_contract',
          detail: `${detail} ${describeError(error)}`,
        },
        hardFailure: null,
      };
    }
    return {
      row: {
        seed,
        family,
        outcome: 'BROKEN:throw',
        detail: `${detail} ${describeError(error)}`,
      },
      hardFailure: `threw ${describeError(error)}`,
    };
  }
}

describe('stress · LiveCourtEngine · hostile options / malformed clips / volume', () => {
  const seeds = campaignSeeds('engine', ITER);

  test(`summary stays consistent and never throws across ${seeds.length} seeded sessions`, async () => {
    const rows: StressRow[] = [];
    const failures: string[] = [];
    for (const seed of seeds) {
      const { row, hardFailure } = await runEngineSeed(seed);
      rows.push(row);
      if (hardFailure)
        failures.push(
          `seed=${seed} [${row.family}] ${hardFailure}\n  replay: ${replayCommand(SUITE, seed)}`,
        );
    }
    const table = writeStressTable(SUITE, 'engine', rows);
    expect(table.iterations).toBe(seeds.length);
    expect(failures).toEqual([]);
  }, 600_000);

  test('deterministic replay: same seed → identical row', async () => {
    const seed = seeds[0];
    if (seed === undefined) throw new Error('no seeds');
    expect((await runEngineSeed(seed)).row).toEqual(
      (await runEngineSeed(seed)).row,
    );
  }, 120_000);

  test('unknown shotType is a typed rejection (null rep), not a throw', async () => {
    const engine = makeEngine({
      shotType: '../../etc/passwd' as EngineOptions['shotType'],
    });
    await expect(engine.onStroke(GOOD_CLIP)).resolves.toBeNull();
    expect(engine.summary().validReps).toBe(0);
  });

  test('makeId throwing propagates out of onStroke (documents current behaviour)', async () => {
    const engine = makeEngine({
      makeId: () => {
        throw new Error('id generator failed');
      },
    });
    await expect(engine.onStroke(GOOD_CLIP)).rejects.toThrow(
      'id generator failed',
    );
  });

  // F2 — minimized reproduction of the spread-argument crash. Expected:
  // summary() returns a value for any rep count. Observed: RangeError once
  // scored reps exceed V8's spread argument limit. Gated: ~125k pipeline runs.
  (SPREAD_REPRO ? test.failing : test.skip)(
    'F2: summary() survives 125k scored reps (STRESS_LIVECOURT_SPREAD=1)',
    async () => {
      const engine = makeEngine({});
      const reps = 125_000;
      for (let i = 0; i < reps; i += 1) await engine.onStroke(GOOD_CLIP);
      let thrown: unknown = null;
      try {
        engine.summary();
      } catch (error) {
        thrown = error;
      }
      writeStressTable(SUITE, 'f2-spread', [
        {
          seed: reps,
          family: 'summary_spread',
          outcome: thrown === null ? 'HELD' : `BROKEN:F2_summary_throw`,
          detail:
            thrown === null
              ? `reps=${reps}`
              : `reps=${reps} ${describeError(thrown)}`,
        },
      ]);
      expect(thrown).toBeNull();
    },
    600_000,
  );
});

describe('stress · sessionScoreProgression + summary record round trip', () => {
  const seeds = campaignSeeds('progression', ITER);

  test(`ordering/best/delta/round-trip hold across ${seeds.length} seeded event sets`, () => {
    const rows: StressRow[] = [];
    const failures: string[] = [];
    for (const seed of seeds) {
      const { row, hardFailure } = runProgressionSeed(seed);
      rows.push(row);
      if (hardFailure)
        failures.push(
          `seed=${seed} [${row.family}] ${hardFailure}\n  replay: ${replayCommand(SUITE, seed)}`,
        );
    }
    const table = writeStressTable(SUITE, 'progression', rows);
    expect(table.iterations).toBe(seeds.length);
    expect(failures).toEqual([]);
    expect(table.outcomes['HELD'] ?? 0).toBeGreaterThan(0);
  }, 600_000);

  test('deterministic replay: same seed → identical row', () => {
    const seed = seeds[0];
    if (seed === undefined) throw new Error('no seeds');
    expect(runProgressionSeed(seed).row).toEqual(runProgressionSeed(seed).row);
  });
});
