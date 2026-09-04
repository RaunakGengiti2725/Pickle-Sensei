/**
 * ADVERSARIAL PASS (native-swing-lab-camera-engine #2) — cost of consuming the
 * native `session_motion_sample` stream over a LONG live session.
 *
 * native/camera-engine SessionCaptureCoordinator emits one motion sample per
 * measurable pose frame (camera at 60 fps, Vision paced by `poseInFlight`) for
 * sessions of up to `maximumSessionSeconds = 1_800`. Every sample lands in
 * LiveSessionFlow.pushSample → SessionEventEngine.push, which re-runs
 * proposeStrokeEventsV2 over the ENTIRE accumulated wrist series (no window,
 * no pruning past the closed frontier). The attack measures per-sample cost
 * across a seeded, realistic-looking 30 fps wrist-speed series and pins the
 * property a per-frame consumer on the JS thread must have: bounded per-sample
 * cost that does not grow with session length.
 *
 * Seeded randomness: mulberry32(SEED) with SEED = 0x5eed_0003.
 * Set ATTACK_SCALING_OUT=/abs/path.json to also persist the measurement tables
 * (written as path.engine.json and path.flow.json).
 */
import { SessionEventEngine } from '@pickle/analysis-pipeline';
import {
  LiveSessionFlow,
  createPendingStubAnalysisProvider,
} from '../../src/flow/session';

// Node-only test file (same pattern as importedRealFootageAnalysis.test.ts):
// the RN tsconfig has no node types, so the host APIs are required as typed.
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

const SEED = 0x5eed_0003;
const FPS = 30;
const WINDOW = 1_000;
const WINDOWS = 6; // 6 000 samples ≈ 3.3 min of a 30-minute-capable session
const TOTAL = WINDOW * WINDOWS;

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

/** Idle jitter (~0.05) with a stroke burst (peak 1.5–3.0, ~400 ms) roughly
 * every 2.5–4 s — enough structure for the engine to close real events so the
 * frontier moves the way it does in a live rally. */
function syntheticWristSeries(
  count: number,
): Array<{ tMs: number; v: number }> {
  const rng = mulberry32(SEED);
  const series: Array<{ tMs: number; v: number }> = [];
  let nextStrokeAt = 2_000 + rng() * 1_500;
  let strokePeakMs = -1;
  let strokePeak = 0;
  for (let index = 0; index < count; index += 1) {
    const tMs = Math.round((index * 1000) / FPS);
    if (tMs >= nextStrokeAt) {
      strokePeakMs = tMs + 200;
      strokePeak = 1.5 + rng() * 1.5;
      nextStrokeAt = tMs + 2_500 + rng() * 1_500;
    }
    let v = 0.03 + rng() * 0.04;
    if (strokePeakMs >= 0) {
      const d = Math.abs(tMs - strokePeakMs);
      if (d <= 220) v += strokePeak * (1 - d / 220);
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
  const series = syntheticWristSeries(TOTAL);
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
  const lines = stats.map(
    s =>
      `${label} samples ${s.fromSample}-${s.toSample}: mean ${s.meanUs} us/push, max ${s.maxUs} us`,
  );
  console.log(lines.join('\n'));
  const out = env.ATTACK_SCALING_OUT;
  if (out) {
    writeFileSync(
      out.replace(/\.json$/, '') + `.${label}.json`,
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

describe('[attack] per-sample cost of the live motion stream over a long session', () => {
  jest.setTimeout(600_000);

  it(`SessionEventEngine.pushWristSample: mean cost of the last ${WINDOW} pushes stays within 2x of the first ${WINDOW} (bounded per-sample work, seed 0x${SEED.toString(16)})`, () => {
    const engine = new SessionEventEngine({
      sessionId: 'attack-scaling-engine',
      captureMeta: { startedAtIso: null, fps: FPS, source: 'live' },
    });
    const stats = measure(sample =>
      engine.pushWristSample({ timestampMs: sample.tMs, value: sample.v }),
    );
    report('engine', stats);
    const closed = engine.flush();
    const snapshot = engine.snapshot();
    // Sanity: the series produced real events (the frontier did move).
    expect(snapshot.events.length + closed.length).toBeGreaterThan(20);
    const first = stats[0]!.meanUs;
    const last = stats[WINDOWS - 1]!.meanUs;
    expect(last).toBeLessThanOrEqual(first * 2);
  });

  it(`LiveSessionFlow.pushSample (what connectNativeSessionMotionFeed calls per native event): same bound, ${TOTAL} samples`, () => {
    const flow = new LiveSessionFlow({
      sessionId: 'attack-scaling-flow',
      source: 'live',
      provider: createPendingStubAnalysisProvider(),
      fps: FPS,
    });
    const stats = measure(sample => flow.pushSample(sample));
    report('flow', stats);
    const snapshot = flow.end();
    expect(snapshot.strokeCount).toBeGreaterThan(20);
    const first = stats[0]!.meanUs;
    const last = stats[WINDOWS - 1]!.meanUs;
    expect(last).toBeLessThanOrEqual(first * 2);
  });
});
