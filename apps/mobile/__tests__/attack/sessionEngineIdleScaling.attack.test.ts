/**
 * ADVERSARIAL PASS on the NSLC-02 fix (28402cb7, bounded retention behind the
 * closed-event frontier) — variant of sessionEngineScaling.attack.test.ts.
 *
 * The fix prunes wrist/paddle samples older than
 * `frontierMs − WRIST_RETENTION_BEHIND_FRONTIER_MS`, where `frontierMs` is the
 * endMs of the LAST EMITTED EVENT. The frontier only moves when an event
 * closes, so during any stretch of the live stream in which no stroke is
 * proposed (athlete waiting for a serve, walking to the court, sitting out a
 * game, the camera watching an empty half — motion below the 0.5 u/s
 * proposal floor) NOTHING is pruned and every push still re-proposes over the
 * whole stretch. Per-push cost is then bounded by the IDLE length, not by the
 * retention window: the original quadratic behaviour returns for exactly the
 * sessions where the JS thread has the least to do.
 *
 * Same harness and 2× bound as the original repro, same 6 000 samples (30 fps
 * ≈ 3.3 min; a 30-minute-capable session can idle far longer), but the wrist
 * series is idle jitter with sub-floor movement (peaks ≤ 0.25 u/s) — realistic
 * for a player standing/walking between points.
 *
 * Seeded randomness: mulberry32(SEED) with SEED = 0x5eed_0004.
 * Set ATTACK_SCALING_OUT=/abs/path.json to persist the measurement tables.
 */
import { SessionEventEngine } from '@pickle/analysis-pipeline';
import {
  LiveSessionFlow,
  createPendingStubAnalysisProvider,
} from '../../src/flow/session';

declare const require: (id: string) => unknown;
const { writeFileSync } = require('fs') as {
  writeFileSync: (path: string, data: string) => void;
};
const { performance } = require('perf_hooks') as {
  performance: { now: () => number };
};
const { env } = require('process') as {
  env: Record<string, string | undefined>;
};

const SEED = 0x5eed_0004;
const FPS = 30;
const WINDOW = 1_000;
const WINDOWS = 6;
const TOTAL = WINDOW * WINDOWS;
/** WRIST_RETENTION_BEHIND_FRONTIER_MS (sessionEngine.ts) in seconds — the
 * documented window: ~300 retained samples at 30 fps plus the open tail. */
const WRIST_RETENTION_S = 10;

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

/** Idle jitter (~0.05) plus gentle sub-floor movement (peak 0.10–0.25 u/s,
 * ~600 ms) every 2–4 s: wrist visible and measured, but never a swing. */
function idleWristSeries(count: number): Array<{ tMs: number; v: number }> {
  const rng = mulberry32(SEED);
  const series: Array<{ tMs: number; v: number }> = [];
  let nextMoveAt = 1_500 + rng() * 1_500;
  let movePeakMs = -1;
  let movePeak = 0;
  for (let index = 0; index < count; index += 1) {
    const tMs = Math.round((index * 1000) / FPS);
    if (tMs >= nextMoveAt) {
      movePeakMs = tMs + 300;
      movePeak = 0.1 + rng() * 0.15;
      nextMoveAt = tMs + 2_000 + rng() * 2_000;
    }
    let v = 0.03 + rng() * 0.04;
    if (movePeakMs >= 0) {
      const d = Math.abs(tMs - movePeakMs);
      if (d <= 300) v += movePeak * (1 - d / 300);
    }
    series.push({ tMs, v: Number(v.toFixed(4)) });
  }
  return series;
}

interface WindowStat {
  window: number;
  fromSample: number;
  toSample: number;
  meanUs: number;
  maxUs: number;
}

function measure(
  push: (sample: { tMs: number; v: number }) => void,
): WindowStat[] {
  const series = idleWristSeries(TOTAL);
  const stats: WindowStat[] = [];
  for (let w = 0; w < WINDOWS; w += 1) {
    let total = 0;
    let max = 0;
    for (let i = w * WINDOW; i < (w + 1) * WINDOW; i += 1) {
      const t0 = performance.now();
      push(series[i]!);
      const dt = (performance.now() - t0) * 1000;
      total += dt;
      if (dt > max) max = dt;
    }
    stats.push({
      window: w,
      fromSample: w * WINDOW,
      toSample: (w + 1) * WINDOW - 1,
      meanUs: Math.round(total / WINDOW),
      maxUs: Math.round(max),
    });
  }
  return stats;
}

function report(label: string, stats: WindowStat[]): void {
  console.log(
    stats
      .map(
        s =>
          `${label} samples ${s.fromSample}-${s.toSample}: mean ${s.meanUs} us/push, max ${s.maxUs} us`,
      )
      .join('\n'),
  );
  const out = env.ATTACK_SCALING_OUT;
  if (out) {
    writeFileSync(
      out.replace(/\.json$/, '') + `.idle.${label}.json`,
      JSON.stringify(
        {
          seed: SEED,
          fps: FPS,
          window: WINDOW,
          windows: WINDOWS,
          label,
          stats,
        },
        null,
        2,
      ),
    );
  }
}

describe('[attack] per-sample cost over an idle (no-stroke) stretch of a live session', () => {
  jest.setTimeout(600_000);

  it(`SessionEventEngine retained wrist series stays bounded by the documented window over ${TOTAL} idle samples (no event closes, so the frontier never moves)`, () => {
    const engine = new SessionEventEngine({
      sessionId: 'attack-idle-retention',
      captureMeta: { startedAtIso: null, fps: FPS, source: 'live' },
    });
    let maxRetained = 0;
    for (const sample of idleWristSeries(TOTAL)) {
      engine.pushWristSample({ timestampMs: sample.tMs, value: sample.v });
      maxRetained = Math.max(maxRetained, engine.retainedWristSampleCount());
    }
    const snapshot = engine.snapshot();
    console.log(
      `engine retained ${engine.retainedWristSampleCount()} of ${TOTAL} wrist samples (max ${maxRetained}) with ${snapshot.events.length} events emitted`,
    );
    // Precondition of the attack: the stretch really is idle.
    expect(snapshot.events.length).toBe(0);
    expect(snapshot.qualityState.wristSamples).toBe(TOTAL);
    // Window (10 s × 30 fps = 300) with generous slack for the open tail.
    expect(maxRetained).toBeLessThanOrEqual(2 * WRIST_RETENTION_S * FPS);
  });

  it(`SessionEventEngine.pushWristSample: mean cost of the last ${WINDOW} idle pushes stays within 2x of the first ${WINDOW}`, () => {
    const engine = new SessionEventEngine({
      sessionId: 'attack-idle-engine',
      captureMeta: { startedAtIso: null, fps: FPS, source: 'live' },
    });
    const stats = measure(sample =>
      engine.pushWristSample({ timestampMs: sample.tMs, value: sample.v }),
    );
    report('engine', stats);
    expect(engine.snapshot().events.length).toBe(0);
    const first = stats[0]!.meanUs;
    const last = stats[WINDOWS - 1]!.meanUs;
    expect(last).toBeLessThanOrEqual(first * 2);
  });

  it(`LiveSessionFlow.pushSample: same bound over the idle stretch, ${TOTAL} samples`, () => {
    const flow = new LiveSessionFlow({
      sessionId: 'attack-idle-flow',
      source: 'live',
      provider: createPendingStubAnalysisProvider(),
      fps: FPS,
    });
    const stats = measure(sample => flow.pushSample(sample));
    report('flow', stats);
    expect(flow.end().strokeCount).toBe(0);
    const first = stats[0]!.meanUs;
    const last = stats[WINDOWS - 1]!.meanUs;
    expect(last).toBeLessThanOrEqual(first * 2);
  });

  it(`after a real stroke closed (frontier set, window primed) an idle stretch of ${TOTAL} samples still grows the retained series past the window`, () => {
    const engine = new SessionEventEngine({
      sessionId: 'attack-idle-after-stroke',
      captureMeta: { startedAtIso: null, fps: FPS, source: 'live' },
    });
    // One clean stroke (peak 2.5 u/s at 1 s) followed by 2 s of quiet so it
    // settles and is emitted — the frontier now sits at its endMs.
    let tMs = 0;
    const closed: number[] = [];
    for (; tMs < 3_000; tMs += Math.round(1000 / FPS)) {
      const d = Math.abs(tMs - 1_000);
      const v = 0.04 + (d <= 200 ? 2.5 * (1 - d / 200) : 0);
      closed.push(
        ...engine
          .pushWristSample({ timestampMs: tMs, value: v })
          .map(e => e.proposal.endMs),
      );
    }
    expect(closed.length).toBe(1);
    const retainedAfterStroke = engine.retainedWristSampleCount();
    // Then the athlete waits (sub-floor movement only).
    let maxRetained = retainedAfterStroke;
    for (const sample of idleWristSeries(TOTAL)) {
      engine.pushWristSample({
        timestampMs: tMs + sample.tMs,
        value: sample.v,
      });
      maxRetained = Math.max(maxRetained, engine.retainedWristSampleCount());
    }
    console.log(
      `engine retained ${retainedAfterStroke} after the stroke, ${engine.retainedWristSampleCount()} after ${TOTAL} idle samples (max ${maxRetained}); events ${engine.snapshot().events.length}`,
    );
    expect(engine.snapshot().events.length).toBe(1);
    expect(maxRetained).toBeLessThanOrEqual(2 * WRIST_RETENTION_S * FPS);
  });
});
