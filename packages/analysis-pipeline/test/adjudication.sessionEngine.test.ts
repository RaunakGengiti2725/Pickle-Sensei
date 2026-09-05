import { describe, expect, it } from "vitest";
import {
  PROPOSAL_WINDOW_MS,
  SESSION_COMPLETION,
  SessionEventEngine,
  proposeStrokeEventsV2,
  type SessionStrokeEvent,
  type SpeedSample,
} from "../src/sessionEngine.js";

/**
 * ADJUDICATION REPRO (area pkg-analysis-pipeline, baseline 4d812e1a).
 *
 * Each `it` asserts the EXPECTED behaviour; a failure at the baseline is the
 * reproduction. Synthetic wrist-speed streams only (clearly synthetic).
 *
 * The second block pins the semantics the bounded (windowed) reconciliation
 * must keep: the events of a long live stream are exactly the full-series
 * batch proposals, every event still closes within endMs + safetyMaxMs, and
 * a movement that only becomes proposable after a stronger stroke has left
 * the window is skipped as stale — recorded, never emitted.
 */

/** ~30 fps wrist-speed stream with one Gaussian stroke bump every 2.4 s. */
function liveStream(seconds: number, stepMs = 33): SpeedSample[] {
  const out: SpeedSample[] = [];
  for (let t = 0; t <= seconds * 1000; t += stepMs) {
    const phase = t % 2400;
    out.push({
      timestampMs: t,
      value: 0.08 + 2.0 * Math.exp(-0.5 * ((phase - 1200) / 120) ** 2),
    });
  }
  return out;
}

/** Idle baseline with explicit Gaussian bumps (same shape as the engine tests). */
function speedBumps(
  bumps: Array<{ peakMs: number; height: number; halfWidthMs: number }>,
  fromMs: number,
  toMs: number,
  stepMs = 40,
): SpeedSample[] {
  const out: SpeedSample[] = [];
  for (let t = fromMs; t <= toMs; t += stepMs) {
    let value = 0.08;
    for (const bump of bumps) {
      value += bump.height * Math.exp(-0.5 * ((t - bump.peakMs) / bump.halfWidthMs) ** 2);
    }
    out.push({ timestampMs: t, value });
  }
  return out;
}

function streamPerSample(
  engine: SessionEventEngine,
  series: readonly SpeedSample[],
): SessionStrokeEvent[] {
  const emitted: SessionStrokeEvent[] = [];
  for (const sample of series) emitted.push(...engine.pushWristSample(sample));
  return emitted;
}

describe("ADJ-AP-001 SessionEventEngine per-push cost must not grow with session length", () => {
  it("mean pushWristSample cost in minute 5 stays within 3x of minute 1 (30 fps live feed)", () => {
    const engine = new SessionEventEngine({ sessionId: "adj-push-cost" });
    const perMinute: Array<{ minute: number; meanMs: number; maxMs: number; events: number }> = [];
    let windowStart = 0;
    let cost = 0;
    let max = 0;
    let count = 0;
    for (const sample of liveStream(305)) {
      const t0 = performance.now();
      engine.pushWristSample(sample);
      const dt = performance.now() - t0;
      cost += dt;
      max = Math.max(max, dt);
      count += 1;
      if (sample.timestampMs - windowStart >= 60_000) {
        perMinute.push({
          minute: perMinute.length + 1,
          meanMs: cost / count,
          maxMs: max,
          events: engine.snapshot().events.length,
        });
        windowStart = sample.timestampMs;
        cost = 0;
        max = 0;
        count = 0;
      }
    }
    console.log(
      "ADJ-AP-001 per-minute push cost:",
      perMinute
        .map(
          (row) =>
            `m${row.minute} mean=${row.meanMs.toFixed(3)}ms max=${row.maxMs.toFixed(2)}ms events=${row.events}`,
        )
        .join(" | "),
    );
    const first = perMinute[0]!;
    const last = perMinute[perMinute.length - 1]!;
    expect(perMinute.length).toBe(5);
    expect(
      last.meanMs / first.meanMs,
      `per-push cost grew ${(last.meanMs / first.meanMs).toFixed(1)}x from minute 1 to minute ${last.minute}`,
    ).toBeLessThanOrEqual(3);
  }, 120_000);
});

describe("ADJ-AP-001 bounded reconciliation keeps the session semantics", () => {
  it("a 305 s live stream emits exactly the full-series batch proposals (bounds exact, ids sequential, closure ≤ endMs+2500)", () => {
    const series = liveStream(305);
    const engine = new SessionEventEngine({ sessionId: "adj-equivalence" });
    const emitted = streamPerSample(engine, series);
    emitted.push(...engine.flush());
    const batch = proposeStrokeEventsV2({
      paddleSpeeds: null,
      wristSpeeds: series,
      clipStartMs: series[0]!.timestampMs,
      clipEndMs: series[series.length - 1]!.timestampMs,
    }).events;
    expect(batch.length).toBeGreaterThan(100);
    expect(
      emitted.map((event) => [event.proposal.startMs, event.proposal.peakMs, event.proposal.endMs]),
    ).toEqual(batch.map((event) => [event.startMs, event.peakMs, event.endMs]));
    expect(emitted.map((event) => event.eventId)).toEqual(
      emitted.map((_, index) => `E${index + 1}`),
    );
    for (const event of emitted) {
      expect(event.closedAtMs).toBeLessThanOrEqual(
        event.proposal.endMs + SESSION_COMPLETION.safetyMaxMs,
      );
    }
    const quality = engine.snapshot().qualityState;
    expect(quality.wristSamples).toBe(series.length);
    expect(quality.droppedLateSamples).toBe(0);
    expect(quality.lastSampleMs).toBe(series[series.length - 1]!.timestampMs);
    expect(quality.notes).toEqual([]);
  });

  it("a movement that only becomes proposable after a stronger stroke leaves the window is skipped as stale — recorded, never emitted", () => {
    // 6 u/s stroke at 2 s suppresses the 0.6 u/s movement at 4 s (30% relative
    // floor). Once the strong stroke has retired from the window the weak one
    // would surface ~8 s after its own peak — far past any live candidate.
    const series = speedBumps(
      [
        { peakMs: 2000, height: 6.0, halfWidthMs: 120 },
        { peakMs: 4000, height: 0.6, halfWidthMs: 120 },
      ],
      0,
      4000 + PROPOSAL_WINDOW_MS + 5000,
    );
    const engine = new SessionEventEngine({ sessionId: "adj-stale" });
    const emitted = streamPerSample(engine, series);
    emitted.push(...engine.flush());
    expect(emitted.map((event) => Math.round(event.proposal.peakMs))).toEqual([2000]);
    const notes = engine.snapshot().qualityState.notes;
    const stale = notes.filter((note) => note.startsWith("SESSION_STALE_PROPOSAL_IGNORED"));
    expect(stale.length).toBe(1);
    expect(stale[0]).toContain("peak 4000ms");
    expect(notes.filter((note) => note.startsWith("SESSION_EVENT_RETRO_SUPPRESSED"))).toEqual([]);
  });

  it("samples arriving behind the retired window are dropped and counted, never re-proposed", () => {
    const series = speedBumps(
      [{ peakMs: 1500, height: 2.0, halfWidthMs: 120 }],
      0,
      PROPOSAL_WINDOW_MS + 5000,
    );
    const engine = new SessionEventEngine({ sessionId: "adj-retired" });
    const emitted = streamPerSample(engine, series);
    expect(emitted.length).toBe(1);
    const before = JSON.parse(JSON.stringify(engine.snapshot().events));
    expect(
      engine.push({
        wrist: [{ timestampMs: 100, value: 9.9 }],
        paddle: [{ timestampMs: 100, value: 9.9 }],
      }),
    ).toEqual([]);
    const snapshot = engine.snapshot();
    expect(snapshot.events).toEqual(before);
    expect(snapshot.qualityState.droppedLateSamples).toBe(2);
    expect(snapshot.qualityState.wristSamples).toBe(series.length + 1);
    expect(snapshot.qualityState.paddleSamples).toBe(0);
    expect(engine.activeProposal()).toBeNull();
  });
});
