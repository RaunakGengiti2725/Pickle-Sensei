/**
 * SessionEventEngine per-sample cost must be BOUNDED — independent of how
 * long the session has been running (xc-performance / XCP-1).
 *
 * Synthetic 60 fps wrist speed with a stroke burst every 1500 ms; per-sample
 * push() wall time is measured in 1000-sample windows. Before the trailing
 * reconciliation window existed, push() re-proposed over the entire
 * accumulated series, so the last window of a 90 s session cost ≥3× the
 * first (measured 213 µs → 2514 µs) and a 180 s session spent 77% of its
 * wall time inside push(). Node/x86 microseconds are a proxy — the pinned
 * facts are the SHAPE (last window ≈ first window) and the wall-time share.
 *
 * Reachability note: the in-tree callers are the dormant Live Court engine
 * (`apps/mobile/src/flow/session.ts`, no UI entry point since 2026-08-31),
 * replay tooling and swing-lab.
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

function report(label: string, totalMs: number, result: ReturnType<typeof run>): void {
  const { n, closed, windows, totalMsPush } = result;
  console.log(
    [
      `${label}: samples=${n} closedEvents=${closed} total_push_ms=${totalMsPush.toFixed(0)} ` +
        `(${((totalMsPush / totalMs) * 100).toFixed(1)}% of session wall time)`,
      "window\tmean_us\tp95_us",
      ...windows.map((w) => `${w.from}\t${w.meanUs.toFixed(0)}\t${w.p95Us.toFixed(0)}`),
    ].join("\n"),
  );
}

describe("SessionEventEngine per-sample cost vs accumulated session length", () => {
  it("per-sample push cost in the last 1000-sample window stays within 1.5× the first window over a 90 s session", () => {
    const result = run(90_000);
    report("90s", 90_000, result);
    const first = result.windows[0]!;
    const last = result.windows[result.windows.length - 1]!;
    expect(result.closed).toBeGreaterThan(0);
    expect(last.meanUs).toBeLessThanOrEqual(first.meanUs * 1.5);
  }, 120_000);

  it("a 180 s / 60 fps session spends ≤10% of its wall time inside push()", () => {
    const result = run(180_000);
    report("180s", 180_000, result);
    expect(result.closed).toBeGreaterThan(0);
    expect(result.totalMsPush).toBeLessThanOrEqual(180_000 * 0.1);
  }, 300_000);
});
