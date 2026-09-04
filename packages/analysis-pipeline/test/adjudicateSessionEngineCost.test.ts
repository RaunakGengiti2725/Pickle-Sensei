/**
 * Adjudication repro (xc-performance / perf-pipeline-throughput-memory):
 * SessionEventEngine.push() re-runs proposeStrokeEventsV2 over the ENTIRE
 * accumulated wrist series on every sample, so per-sample cost grows with
 * session length (quadratic total). Synthetic 60 fps wrist speed with a
 * stroke burst every 1500 ms; per-sample wall time measured in 1000-sample
 * windows. Node/x86 numbers are a proxy — the shape (later windows ≫ first)
 * is the pinned fact, not the absolute microseconds.
 *
 * Reachability note: the only in-tree callers are the dormant Live Court
 * engine (`apps/mobile/src/flow/session.ts`, no UI entry point since
 * 2026-08-31), replay tooling and swing-lab.
 */
import { describe, expect, it } from "vitest";
import { SessionEventEngine } from "../src/sessionEngine.js";

const FPS = 60;
const STROKE_EVERY_MS = 1_500;
const WINDOW = 1_000;

function run(totalMs: number) {
  const engine = new SessionEventEngine({
    sessionId: "adjudicate",
    captureMeta: { fps: FPS, source: "live" },
  });
  let seed = 1000;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const n = Math.floor((totalMs / 1000) * FPS);
  const timingsUs: number[] = [];
  let closed = 0;
  for (let i = 0; i < n; i += 1) {
    const t = (i * 1000) / FPS;
    const phase = t % STROKE_EVERY_MS;
    const bump = 6 * Math.exp(-((phase - 700) ** 2) / (2 * 120 ** 2));
    const v = 0.3 + 0.2 * rnd() + bump;
    const t0 = process.hrtime.bigint();
    closed += engine.pushWristSample({ timestampMs: t, value: v }).length;
    timingsUs.push(Number(process.hrtime.bigint() - t0) / 1000);
  }
  const windows: Array<{ from: number; meanUs: number; p95Us: number }> = [];
  for (let w = 0; w < n; w += WINDOW) {
    const slice = timingsUs.slice(w, w + WINDOW).sort((a, b) => a - b);
    windows.push({
      from: w,
      meanUs: slice.reduce((a, b) => a + b, 0) / slice.length,
      p95Us: slice[Math.floor(slice.length * 0.95)]!,
    });
  }
  const totalMsPush = timingsUs.reduce((a, b) => a + b, 0) / 1000;
  return { n, closed, windows, totalMsPush };
}

describe("adjudicate: SessionEventEngine per-sample cost vs accumulated session length", () => {
  it("per-sample push cost in the last 1000-sample window is ≥3× the first window over a 90 s session", () => {
    const { n, closed, windows, totalMsPush } = run(90_000);
    const first = windows[0]!;
    const last = windows[windows.length - 1]!;
    console.log(
      [
        `samples=${n} closedEvents=${closed} total_push_ms=${totalMsPush.toFixed(0)} (${((totalMsPush / 90_000) * 100).toFixed(1)}% of session wall time)`,
        "window\tmean_us\tp95_us",
        ...windows.map((w) => `${w.from}\t${w.meanUs.toFixed(0)}\t${w.p95Us.toFixed(0)}`),
      ].join("\n"),
    );
    expect(closed).toBeGreaterThan(0);
    expect(last.meanUs).toBeGreaterThan(first.meanUs * 3);
  }, 60_000);
});
