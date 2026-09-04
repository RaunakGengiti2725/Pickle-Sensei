/**
 * ADVERSARIAL (xc-performance::XCP-1): the bounded reconciliation window must
 * keep push() cost independent of session length on the workload the fix
 * targets — a long, continuous rally. During a rally the smoothed wrist speed
 * never goes quiet between strokes, so the peak chain that decides the trim
 * cutoff never breaks; the window is expected to fall back to
 * CHAIN_RETENTION_CAP_MS (30 s) instead of growing without bound.
 *
 * Both assertions mirror test/adjudicateSessionEngineCost.test.ts (same
 * window size, same 1.5x shape bound) on a 60 fps rally with a stroke every
 * ~700 ms, and additionally compare the candidate against the 4d812e1a
 * full-history engine on the SAME sample stream: a bounded window must not
 * cost more than the unbounded engine it replaces.
 */
import { describe, expect, it } from "vitest";
import { SessionEventEngine } from "../../src/sessionEngine.js";
import { SessionEventEngine as BaselineEngine } from "./fixtures/sessionEngineBaseline4d812e1a.js";
import { lcg, type Sample } from "./fixtures/differentialHarness.js";

const FPS = 60;
const WINDOW = 1_000;
const DURATION_MS = 90_000;

function rallyStream(): Sample[] {
  const r = lcg(0xc0ffee);
  const strokes: Array<{ atMs: number; amp: number; w: number }> = [];
  let next = 800;
  while (next < DURATION_MS) {
    strokes.push({ atMs: next, amp: 2 + r() * 5, w: 70 + r() * 80 });
    next += 700 * (0.8 + 0.4 * r());
  }
  const out: Sample[] = [];
  let si = 0;
  for (let i = 0; i < (DURATION_MS / 1000) * FPS; i += 1) {
    const t = (i * 1000) / FPS;
    let v = 0.6 + 0.1 * r();
    while (si < strokes.length && strokes[si]!.atMs + 4 * strokes[si]!.w < t) si += 1;
    for (let k = si; k < strokes.length && strokes[k]!.atMs - 4 * strokes[k]!.w < t; k += 1) {
      const s = strokes[k]!;
      const d = t - s.atMs;
      v += s.amp * Math.exp(-(d * d) / (2 * s.w * s.w));
    }
    out.push({ timestampMs: t, value: v });
  }
  return out;
}

interface PushTarget {
  push(input: { wrist: readonly Sample[] }): unknown[];
  flush(): unknown[];
}

function measure(engine: PushTarget, stream: Sample[]) {
  const timingsUs: number[] = [];
  let closed = 0;
  for (const sample of stream) {
    const t0 = process.hrtime.bigint();
    closed += engine.push({ wrist: [sample] }).length;
    timingsUs.push(Number(process.hrtime.bigint() - t0) / 1000);
  }
  closed += engine.flush().length;
  const windows: number[] = [];
  for (let w = 0; w < stream.length; w += WINDOW) {
    const slice = timingsUs.slice(w, w + WINDOW);
    windows.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }
  return { closed, windows, totalMs: timingsUs.reduce((a, b) => a + b, 0) / 1000 };
}

describe("SessionEventEngine push() cost on a continuous rally (XCP-1)", () => {
  const stream = rallyStream();
  const candidate = measure(
    new SessionEventEngine({ sessionId: "rally", captureMeta: { fps: FPS, source: "live" } }),
    stream,
  );
  const baseline = measure(
    new BaselineEngine({ sessionId: "rally", captureMeta: { fps: FPS, source: "live" } }),
    stream,
  );
  console.log(
    `[rally ${DURATION_MS / 1000}s @${FPS}fps] candidate windows(us)=${candidate.windows.map((w) => w.toFixed(0)).join(",")} ` +
      `total=${candidate.totalMs.toFixed(0)}ms closed=${candidate.closed} | ` +
      `baseline windows(us)=${baseline.windows.map((w) => w.toFixed(0)).join(",")} ` +
      `total=${baseline.totalMs.toFixed(0)}ms closed=${baseline.closed}`,
  );

  it("emits the same number of events as the full-history engine", () => {
    expect(candidate.closed).toBe(baseline.closed);
  });

  it("final 1000-sample window costs at most 1.5x the first (bounded per-sample cost)", () => {
    const first = candidate.windows[0]!;
    const last = candidate.windows[candidate.windows.length - 1]!;
    expect(last).toBeLessThanOrEqual(first * 1.5);
  });

  it("spends at most 10% of the session wall time inside push()", () => {
    expect(candidate.totalMs).toBeLessThanOrEqual(DURATION_MS * 0.1);
  });

  it("is not slower than the unbounded 4d812e1a engine it replaces", () => {
    expect(candidate.totalMs).toBeLessThanOrEqual(baseline.totalMs);
  });
});
