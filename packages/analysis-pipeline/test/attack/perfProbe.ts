/**
 * Standalone probe (not a vitest test): feed a 30 Hz synthetic wrist stream
 * ONE SAMPLE PER PUSH (exactly what apps/mobile LiveSessionFlow.pushSample
 * does) and print the mean per-push wall time per 1-minute window, up to the
 * requested duration. Run with:
 *   npx tsx packages/analysis-pipeline/test/attack/perfProbe.ts <minutes> <out.json>
 */
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { SessionEventEngine } from "../../src/sessionEngine.js";
import { syntheticStream } from "./attackFixtures.js";

const minutes = Number(process.argv[2] ?? "5");
const out = process.argv[3] ?? "/tmp/perfProbe.json";
const stream = syntheticStream({ durationMs: minutes * 60_000, seed: 20260904, jitter: 0.02 });
const engine = new SessionEventEngine({ sessionId: "perf-probe" });
const windows: Array<{
  minute: number;
  samples: number;
  meanPushMs: number;
  maxPushMs: number;
  eventsSoFar: number;
  cumulativeMs: number;
}> = [];
let windowStart = 0;
let windowTotal = 0;
let windowMax = 0;
let windowCount = 0;
let cumulative = 0;
let events = 0;
const started = performance.now();
for (let index = 0; index < stream.length; index += 1) {
  const sample = stream[index]!;
  const t0 = performance.now();
  events += engine.pushWristSample(sample).length;
  const dt = performance.now() - t0;
  cumulative += dt;
  windowTotal += dt;
  windowCount += 1;
  if (dt > windowMax) windowMax = dt;
  if (sample.timestampMs - windowStart >= 60_000 || index === stream.length - 1) {
    windows.push({
      minute: Math.round(sample.timestampMs / 60_000),
      samples: index + 1,
      meanPushMs: windowTotal / windowCount,
      maxPushMs: windowMax,
      eventsSoFar: events,
      cumulativeMs: cumulative,
    });
    console.log(JSON.stringify(windows[windows.length - 1]));
    windowStart = sample.timestampMs;
    windowTotal = 0;
    windowMax = 0;
    windowCount = 0;
  }
}
const wall = performance.now() - started;
const report = {
  commit: process.env.ATTACK_COMMIT ?? null,
  minutes,
  samples: stream.length,
  eventsClosed: events,
  totalWallMs: wall,
  windows,
};
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`done: ${stream.length} pushes, ${events} events, ${wall.toFixed(0)} ms wall → ${out}`);
