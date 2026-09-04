import { describe, expect, it } from "vitest";
import { SessionEventEngine, proposeStrokeEventsV2 } from "../src/sessionEngine.js";

/**
 * ADVERSARIAL (xc-cv::XC-CV-3 candidate 5ee6b8ea): the cadence de-jitter in
 * `smoothSpeedSeries` decides per CALL whether to retime the series
 * (`observedCadence(sorted).spreadMs <= jitterToleranceMs`). The streaming
 * `SessionEventEngine` calls the proposer over every growing PREFIX of the
 * session, so the decision (and the inter-quartile cadence it snaps to) can
 * differ between a prefix and the final batch series. The candidate comment
 * claims the retiming holds "for every prefix of it alike"; these fixtures
 * show it does not. On 4d812e1a (no retiming) every case below streams
 * identically to the batch proposer.
 *
 * Fixtures are fully deterministic (mulberry32 seeds) — no I/O.
 */

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

const BUMPS = [
  { peakMs: 1500, height: 2.2, halfWidthMs: 140 },
  { peakMs: 4200, height: 0.9, halfWidthMs: 180 },
  { peakMs: 7000, height: 1.6, halfWidthMs: 120 },
];

function trueSpeed(t: number): number {
  return BUMPS.reduce(
    (total, bump) =>
      total + bump.height * Math.exp(-0.5 * ((t - bump.peakMs) / bump.halfWidthMs) ** 2),
    0.08,
  );
}

/**
 * Wrist speed as `dominantWristSpeeds` / `SessionMotionStream` compute it:
 * displacement over the STAMPED interval. `fpsAt(trueMs)` gives the capture
 * cadence in effect at that moment; `jitterMs` is uniform integer-ms
 * timestamp wobble (Vision delivers integer-ms stamps).
 */
function series(options: {
  seed: number;
  jitterMs: number;
  fpsAt: (trueMs: number) => number;
  jitterUntilMs?: number;
  endMs: number;
}): Array<{ timestampMs: number; value: number }> {
  const random = mulberry32(options.seed);
  const out: Array<{ timestampMs: number; value: number }> = [];
  let prevTrue = 0;
  let prevStamp = 0;
  let trueMs = 0;
  while (trueMs <= options.endMs) {
    const jitterActive = options.jitterUntilMs === undefined || trueMs < options.jitterUntilMs;
    const wobble = jitterActive && options.jitterMs > 0 ? (random() * 2 - 1) * options.jitterMs : 0;
    let stamp = Math.round(trueMs + wobble);
    if (out.length > 0 && stamp <= prevStamp) stamp = prevStamp + 1;
    if (out.length === 0) {
      out.push({ timestampMs: stamp, value: trueSpeed(trueMs) });
    } else {
      const displacement = (trueSpeed(trueMs) * (trueMs - prevTrue)) / 1000;
      out.push({ timestampMs: stamp, value: (displacement * 1000) / (stamp - prevStamp) });
    }
    prevTrue = trueMs;
    prevStamp = stamp;
    trueMs += 1000 / options.fpsAt(trueMs);
  }
  return out;
}

const bounds = (event: { startMs: number; peakMs: number; endMs: number }) =>
  `${Math.round(event.startMs)}/${Math.round(event.peakMs)}/${Math.round(event.endMs)}`;

function batch(speeds: ReadonlyArray<{ timestampMs: number; value: number }>): string[] {
  return proposeStrokeEventsV2({
    paddleSpeeds: null,
    wristSpeeds: speeds,
    clipStartMs: speeds[0]!.timestampMs,
    clipEndMs: speeds[speeds.length - 1]!.timestampMs,
  }).events.map(bounds);
}

function streamed(speeds: ReadonlyArray<{ timestampMs: number; value: number }>): string[] {
  const engine = new SessionEventEngine({ sessionId: "attack", captureMeta: { source: "replay" } });
  const out: string[] = [];
  for (const sample of speeds) {
    for (const event of engine.pushWristSample(sample)) out.push(bounds(event.proposal));
  }
  for (const event of engine.flush()) out.push(bounds(event.proposal));
  return out;
}

describe("XC-CV-3 attack: streaming/batch parity under cadence de-jitter", () => {
  it("constant 60 fps with ±4 ms integer-ms jitter: the live engine and the batch proposer emit the same bounds (seeds 1–20)", () => {
    const mismatches: string[] = [];
    for (let seed = 1; seed <= 20; seed += 1) {
      const speeds = series({ seed, jitterMs: 4, fpsAt: () => 60, endMs: 9000 });
      const b = batch(speeds);
      const s = streamed(speeds);
      if (b.join(" | ") !== s.join(" | ")) {
        mismatches.push(`seed ${seed}: batch ${b.join(" | ")} ; streamed ${s.join(" | ")}`);
      }
    }
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });

  it("constant 30 fps with ±4–5 ms integer-ms jitter: the live engine and the batch proposer emit the same bounds (seeds 1–20)", () => {
    const mismatches: string[] = [];
    for (const jitterMs of [4, 5]) {
      for (let seed = 1; seed <= 20; seed += 1) {
        const speeds = series({ seed, jitterMs, fpsAt: () => 30, endMs: 9000 });
        const b = batch(speeds);
        const s = streamed(speeds);
        if (b.join(" | ") !== s.join(" | ")) {
          mismatches.push(
            `jitter ${jitterMs} seed ${seed}: batch ${b.join(" | ")} ; streamed ${s.join(" | ")}`,
          );
        }
      }
    }
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });

  it("capture cadence drops 60 → 30 fps mid-session (thermal throttle): events closed BEFORE the drop must not differ from the batch replay of the same samples", () => {
    // 60 fps ±2 ms until 3000 ms, then clean 30 fps. Only the first stroke
    // (peak 1500 ms) is closed before the cadence changes — the live engine
    // retimes the early prefix to 16.67 ms, the batch proposer sees a bimodal
    // 17/33 ms cadence (spreadMs 17 > 5) and does NOT retime the same samples.
    const mismatches: string[] = [];
    for (let seed = 1; seed <= 8; seed += 1) {
      const speeds = series({
        seed,
        jitterMs: 2,
        jitterUntilMs: 3000,
        fpsAt: (t) => (t < 3000 ? 60 : 30),
        endMs: 6000,
      });
      const b = batch(speeds);
      const s = streamed(speeds);
      if (b.join(" | ") !== s.join(" | ")) {
        mismatches.push(`seed ${seed}: batch ${b.join(" | ")} ; streamed ${s.join(" | ")}`);
      }
    }
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });
});
