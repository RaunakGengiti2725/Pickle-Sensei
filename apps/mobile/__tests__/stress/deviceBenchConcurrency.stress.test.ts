/**
 * mod-capture / concurrency — `src/camera/deviceBench.ts` recorder under
 * seeded multi-actor interleavings.
 *
 * Scenario `multi_actor_recorder`: one DeviceBenchRecorder shared by a
 * thermal poller, an fps sampler, a memory poller, a capture finalizer and a
 * note writer — each on its OWN monotonic clock with a per-actor skew
 * offset (cross-series skew is legal) — interleaved through the seeded
 * scheduler, with two "exporter" actors calling `finalize()` concurrently
 * at seed-chosen points (double export). Invariants: every pushed sample
 * appears exactly once, in push order, in the export (no lost update, no
 * duplicate rows); `finalize()` is non-destructive and idempotent (two
 * exports of the same state are byte-identical); the export validates;
 * `durationMs` is the max timestamp across series; empty series carry
 * exactly the reason given, non-empty series carry null.
 *
 * Scenario `same_series_clock_skew`: two producers push into the SAME series
 * from skewed clocks (skew drawn per seed, including 0 and sub-frame
 * values). Reference model: the export must succeed iff the merged series
 * is monotonic non-decreasing; otherwise `finalize()` must throw naming the
 * FIRST offending sample index — never emit an out-of-order document and
 * never throw for an in-order one.
 *
 * Replay: STRESS_SEED=<seed> npx jest --ci __tests__/stress/deviceBenchConcurrency.stress.test.ts
 */
import {
  DeviceBenchRecorder,
  validateDeviceBenchExport,
  type DeviceBenchCaptureRefV1,
  type DeviceBenchExportV1,
  type FpsSampleV1,
  type MemorySampleV1,
  type ThermalSampleV1,
} from '../../src/camera/deviceBench';
import {
  describeFailures,
  flushMicrotasks,
  pick,
  randomInt,
  runCampaign,
  SeededScheduler,
  stableJson,
  type IterationResult,
  type Rng,
} from '../../testing/stress/harness';

const SUITE = 'deviceBenchConcurrency';

const INIT = {
  deviceModel: 'iPhone16,1',
  osVersion: 'iOS 18.5',
  appVersion: '0.1.0 (42)',
  startedAtIso: '2026-09-05T00:00:00.000Z',
};

const THERMAL_STATES = ['nominal', 'fair', 'serious', 'critical'] as const;

interface ActorClock {
  /** Per-actor skew offset (ms) relative to the bench origin. */
  offsetMs: number;
  nowMs: number;
}

function advance(clock: ActorClock, random: Rng): number {
  clock.nowMs += randomInt(random, 0, 1200);
  return clock.nowMs + clock.offsetMs;
}

async function multiActorIteration(
  _seed: number,
  random: Rng,
): Promise<IterationResult> {
  const violations: string[] = [];
  const scheduler = new SeededScheduler(random);
  const recorder = new DeviceBenchRecorder(INIT);

  const thermal: ThermalSampleV1[] = [];
  const fps: FpsSampleV1[] = [];
  const memory: MemorySampleV1[] = [];
  const captures: DeviceBenchCaptureRefV1[] = [];
  const notes: string[] = [];
  const exports: Array<{
    at: number;
    doc: DeviceBenchExportV1 | null;
    error: string | null;
  }> = [];

  const counts = {
    thermal: randomInt(random, 0, 12),
    fps: randomInt(random, 0, 12),
    memory: randomInt(random, 0, 12),
    captures: randomInt(random, 0, 4),
    notes: randomInt(random, 0, 3),
  };
  const clocks = {
    thermal: { offsetMs: randomInt(random, 0, 5000), nowMs: 0 },
    fps: { offsetMs: randomInt(random, 0, 5000), nowMs: 0 },
    memory: { offsetMs: randomInt(random, 0, 5000), nowMs: 0 },
    captures: { offsetMs: randomInt(random, 0, 5000), nowMs: 0 },
  };
  const reasons = {
    thermal: 'no thermal bridge in this build',
    fps: 'camera never started',
    memory: 'memory polling not wired',
  };

  const actor = async (
    label: string,
    n: number,
    push: (i: number) => void,
  ): Promise<void> => {
    for (let i = 0; i < n; i += 1) {
      await scheduler.hold(label, () => null);
      push(i);
    }
  };

  const snapshot = (): DeviceBenchExportV1 | null => {
    try {
      return recorder.finalize(reasons);
    } catch (error) {
      exports.push({
        at: -1,
        doc: null,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  const recorderSize = (): number =>
    thermal.length +
    fps.length +
    memory.length +
    captures.length +
    notes.length;

  const runs = [
    actor('thermal', counts.thermal, () => {
      const sample: ThermalSampleV1 = {
        tMs: advance(clocks.thermal, random),
        state: pick(random, THERMAL_STATES),
      };
      thermal.push(sample);
      recorder.pushThermal(sample);
    }),
    actor('fps', counts.fps, () => {
      const sample: FpsSampleV1 = {
        tMs: advance(clocks.fps, random),
        fps: pick(random, [0, 7.5, 24, 29.97, 30, 59.94, 60, 120, 240]),
        windowMs: randomInt(random, 1, 2000),
      };
      fps.push(sample);
      recorder.pushFps(sample);
    }),
    actor('memory', counts.memory, () => {
      const sample: MemorySampleV1 = {
        tMs: advance(clocks.memory, random),
        footprintBytes: randomInt(random, 0, 2_000_000_000),
      };
      memory.push(sample);
      recorder.pushMemory(sample);
    }),
    actor('captures', counts.captures, i => {
      const capture: DeviceBenchCaptureRefV1 = {
        clipUri: `file:///bench/${i}.mov`,
        finalizedAtMs: advance(clocks.captures, random),
        completionStrategy: random() < 0.5 ? 'fixed' : 'adaptive',
        telemetrySchemas:
          random() < 0.5 ? ['capture-completion-telemetry-v1'] : [],
      };
      captures.push(capture);
      recorder.pushCapture(capture);
    }),
    actor('notes', counts.notes, i => {
      const note = `note ${i}`;
      notes.push(note);
      recorder.addNote(note);
    }),
    // Two exporters: each finalizes at a seed-chosen point mid-run and the
    // pair must agree with a re-finalize of the same state.
    actor('exporterA', 1, () => {
      const first = snapshot();
      const second = snapshot();
      if (first && second && stableJson(first) !== stableJson(second)) {
        violations.push(
          'exporterA: back-to-back finalize() differ (not idempotent)',
        );
      }
      if (first) exports.push({ at: recorderSize(), doc: first, error: null });
    }),
    actor('exporterB', 1, () => {
      const doc = snapshot();
      if (doc) exports.push({ at: recorderSize(), doc, error: null });
    }),
  ];

  await flushMicrotasks();
  await scheduler.drain();
  await Promise.all(runs);

  // Final export against the reference model.
  const finalDoc = snapshot();
  if (!finalDoc) {
    violations.push(
      `final finalize() threw: ${exports[exports.length - 1]?.error ?? '?'}`,
    );
  } else {
    const errors = validateDeviceBenchExport(finalDoc);
    if (errors.length > 0)
      violations.push(`export invalid: ${errors.join('; ')}`);
    if (stableJson(finalDoc.thermal.samples) !== stableJson(thermal)) {
      violations.push('thermal series != pushed (lost/duplicated/reordered)');
    }
    if (stableJson(finalDoc.fps.samples) !== stableJson(fps)) {
      violations.push('fps series != pushed (lost/duplicated/reordered)');
    }
    if (stableJson(finalDoc.memory.samples) !== stableJson(memory)) {
      violations.push('memory series != pushed (lost/duplicated/reordered)');
    }
    if (stableJson(finalDoc.captures) !== stableJson(captures)) {
      violations.push('captures != pushed');
    }
    if (stableJson(finalDoc.notes) !== stableJson(notes)) {
      violations.push('notes != pushed');
    }
    for (const series of ['thermal', 'fps', 'memory'] as const) {
      const got = finalDoc[series].unavailableReason;
      const want =
        finalDoc[series].samples.length === 0 ? reasons[series] : null;
      if (got !== want)
        violations.push(`${series}.unavailableReason=${String(got)}`);
    }
    const maxT = Math.max(
      0,
      ...thermal.map(s => s.tMs),
      ...fps.map(s => s.tMs),
      ...memory.map(s => s.tMs),
      ...captures.map(c => c.finalizedAtMs),
    );
    if (finalDoc.durationMs !== maxT) {
      violations.push(`durationMs ${finalDoc.durationMs} != max tMs ${maxT}`);
    }
    // Non-destructive: an export mid-run must be a prefix of the final one.
    for (const snap of exports) {
      if (!snap.doc) {
        violations.push(`mid-run finalize() threw: ${snap.error}`);
        continue;
      }
      for (const series of ['thermal', 'fps', 'memory'] as const) {
        const prefix = finalDoc[series].samples.slice(
          0,
          snap.doc[series].samples.length,
        );
        if (stableJson(prefix) !== stableJson(snap.doc[series].samples)) {
          violations.push(
            `mid-run ${series} export is not a prefix of the final export`,
          );
        }
      }
      // A snapshot's own validity: the recorder must never hand out an
      // invalid document.
      const snapErrors = validateDeviceBenchExport(snap.doc);
      if (snapErrors.length > 0) {
        violations.push(`mid-run export invalid: ${snapErrors.join('; ')}`);
      }
    }
  }

  return {
    detail: {
      counts,
      offsets: {
        thermal: clocks.thermal.offsetMs,
        fps: clocks.fps.offsetMs,
        memory: clocks.memory.offsetMs,
        captures: clocks.captures.offsetMs,
      },
      settleOrder: scheduler.settledOrder,
      midRunExports: exports.length,
      durationMs: finalDoc?.durationMs ?? null,
    },
    violations,
  };
}

async function sameSeriesSkewIteration(
  _seed: number,
  random: Rng,
): Promise<IterationResult> {
  const violations: string[] = [];
  const scheduler = new SeededScheduler(random);
  const recorder = new DeviceBenchRecorder(INIT);
  const series = pick(random, ['thermal', 'fps', 'memory'] as const);
  // Skew between the two producers writing the same series. 0 and tiny
  // values exercise equal timestamps (legal: non-decreasing) and sub-frame
  // inversions.
  const skewMs = pick(random, [0, 0, 1, 4, 16, 33, 250, 1000, 5000]);
  const clockA: ActorClock = { offsetMs: 0, nowMs: 0 };
  const clockB: ActorClock = {
    offsetMs: random() < 0.5 ? skewMs : -skewMs,
    nowMs: 0,
  };
  const pushed: number[] = [];

  const push = (tMs: number): void => {
    pushed.push(tMs);
    if (series === 'thermal') recorder.pushThermal({ tMs, state: 'nominal' });
    else if (series === 'fps')
      recorder.pushFps({ tMs, fps: 60, windowMs: 1000 });
    else recorder.pushMemory({ tMs, footprintBytes: 100 });
  };
  const producer = async (label: string, clock: ActorClock, n: number) => {
    for (let i = 0; i < n; i += 1) {
      await scheduler.hold(label, () => null);
      // Small steps so the two clocks stay within skew range of each other.
      clock.nowMs += randomInt(random, 0, 40);
      push(clock.nowMs + clock.offsetMs);
    }
  };
  const runs = [
    producer('A', clockA, randomInt(random, 1, 10)),
    producer('B', clockB, randomInt(random, 1, 10)),
  ];
  await flushMicrotasks();
  await scheduler.drain();
  await Promise.all(runs);

  // Reference model: a negative timestamp is its own defect and does not
  // participate in the monotonic comparison; the first monotonic violation
  // is judged against the last non-negative predecessor.
  let firstBadIndex = -1;
  let lastGood = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < pushed.length; i += 1) {
    const t = pushed[i] as number;
    if (t < 0) continue;
    if (t < lastGood) {
      firstBadIndex = i;
      break;
    }
    lastGood = t;
  }
  const negativeIndex = pushed.findIndex(t => t < 0);
  const reasons = {
    thermal: 'unused',
    fps: 'unused',
    memory: 'unused',
  };
  const others = (['thermal', 'fps', 'memory'] as const).filter(
    s => s !== series,
  );
  const finalizeReasons = Object.fromEntries(others.map(s => [s, reasons[s]]));

  let doc: DeviceBenchExportV1 | null = null;
  let error: string | null = null;
  try {
    doc = recorder.finalize(finalizeReasons);
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  }
  const shouldThrow = firstBadIndex >= 0 || negativeIndex >= 0;
  if (shouldThrow && doc) {
    violations.push(
      `out-of-order/negative series (first bad index ${firstBadIndex}, negative ${negativeIndex}) was EXPORTED`,
    );
  }
  if (!shouldThrow && !doc) {
    violations.push(`monotonic series rejected: ${error}`);
  }
  if (shouldThrow && error) {
    const expectedMentions: string[] = [];
    if (firstBadIndex >= 0) {
      expectedMentions.push(
        `${series}.samples[${firstBadIndex}].tMs: not monotonically non-decreasing`,
      );
    }
    if (negativeIndex >= 0) {
      expectedMentions.push(
        `${series}.samples[${negativeIndex}].tMs: not a finite non-negative number`,
      );
    }
    for (const mention of expectedMentions) {
      if (!error.includes(mention)) {
        violations.push(
          `finalize() error does not name "${mention}": ${error}`,
        );
      }
    }
  }
  if (doc) {
    const exported = doc[series].samples.map(s => s.tMs);
    if (stableJson(exported) !== stableJson(pushed)) {
      violations.push('exported series != pushed order');
    }
  }
  // Recovery probe: after a refused finalize, the recorder offers no way to
  // drop the offending sample — every later finalize with the same state
  // must fail identically (documented behaviour, checked for determinism).
  if (shouldThrow) {
    let again: string | null = null;
    try {
      recorder.finalize(finalizeReasons);
    } catch (thrown) {
      again = thrown instanceof Error ? thrown.message : String(thrown);
    }
    if (again !== error)
      violations.push('refusal is not deterministic across calls');
  }

  return {
    detail: {
      series,
      skewMs,
      offsetB: clockB.offsetMs,
      pushed,
      firstBadIndex,
      negativeIndex,
      exported: doc !== null,
      error,
      settleOrder: scheduler.settledOrder,
    },
    violations,
  };
}

describe('mod-capture concurrency stress — device bench recorder', () => {
  it('multi_actor_recorder: interleaved producers + double export lose nothing', async () => {
    const table = await runCampaign(
      SUITE,
      'multi_actor_recorder',
      multiActorIteration,
    );
    expect(table.iterations).toBeGreaterThan(0);
    expect(describeFailures(table)).toBe('');
    expect(table.failingSeeds).toEqual([]);
  });

  it('same_series_clock_skew: skewed co-writers are exported iff monotonic, refused otherwise', async () => {
    const table = await runCampaign(
      SUITE,
      'same_series_clock_skew',
      sameSeriesSkewIteration,
    );
    expect(table.iterations).toBeGreaterThan(0);
    expect(describeFailures(table)).toBe('');
    expect(table.failingSeeds).toEqual([]);
  });
});
