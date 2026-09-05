import { describe, expect, it } from "vitest";
import {
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
 * ADJ-AP-001: the engine re-proposed the ENTIRE accumulated wrist series on
 * every push, so per-push cost grew linearly with session length (measured
 * 18–22x from minute 1 to minute 5 at 30 fps). The shipping caller
 * (apps/mobile/src/flow/session.ts) pushes one sample per frame on the JS
 * thread, so a 30-minute live session paid tens of ms per frame.
 */

const IDLE = 0.08;
const STROKE_PERIOD_MS = 2400;
const STROKE_PEAK_OFFSET_MS = 1200;

/** ~30 fps wrist-speed stream with one Gaussian stroke bump every 2.4 s. */
function liveStream(seconds: number, stepMs = 33): SpeedSample[] {
  const out: SpeedSample[] = [];
  for (let t = 0; t <= seconds * 1000; t += stepMs) {
    const phase = t % STROKE_PERIOD_MS;
    out.push({
      timestampMs: t,
      value: IDLE + 2.0 * Math.exp(-0.5 * ((phase - STROKE_PEAK_OFFSET_MS) / 120) ** 2),
    });
  }
  return out;
}

/** Instants of the synthetic stroke peaks that fall inside [fromMs, toMs]. */
function strokePeaksIn(fromMs: number, toMs: number): number[] {
  const peaks: number[] = [];
  for (let peak = STROKE_PEAK_OFFSET_MS; peak <= toMs; peak += STROKE_PERIOD_MS) {
    if (peak >= fromMs) peaks.push(peak);
  }
  return peaks;
}

/** Play for `playSeconds`, stand still (idle baseline) for `idleSeconds`,
 * then play again for `playSeconds` (+5 s so the last minute row closes) —
 * an athlete waiting between games. */
function playIdlePlayStream(playSeconds: number, idleSeconds: number, stepMs = 33): SpeedSample[] {
  const out: SpeedSample[] = [];
  const playMs = playSeconds * 1000;
  const idleEndMs = playMs + idleSeconds * 1000;
  const totalMs = idleEndMs + playMs + 5000;
  for (let t = 0; t <= totalMs; t += stepMs) {
    const playing = t < playMs || t >= idleEndMs;
    const phase = t % STROKE_PERIOD_MS;
    out.push({
      timestampMs: t,
      value: playing
        ? IDLE + 2.0 * Math.exp(-0.5 * ((phase - STROKE_PEAK_OFFSET_MS) / 120) ** 2)
        : IDLE,
    });
  }
  return out;
}

interface MinuteCost {
  minute: number;
  meanMs: number;
  maxMs: number;
  events: number;
}

/** Streams every sample through pushWristSample, measuring wall time per
 * push and aggregating it per stream-minute. Returns the per-minute rows and
 * every event the engine closed. */
function measurePerMinute(
  engine: SessionEventEngine,
  stream: readonly SpeedSample[],
): { perMinute: MinuteCost[]; emitted: SessionStrokeEvent[] } {
  const perMinute: MinuteCost[] = [];
  const emitted: SessionStrokeEvent[] = [];
  let windowStart = 0;
  let cost = 0;
  let max = 0;
  let count = 0;
  for (const sample of stream) {
    const t0 = performance.now();
    const closed = engine.pushWristSample(sample);
    const dt = performance.now() - t0;
    emitted.push(...closed);
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
  return { perMinute, emitted };
}

function formatRows(rows: readonly MinuteCost[]): string {
  return rows
    .map(
      (row) =>
        `m${row.minute} mean=${row.meanMs.toFixed(3)}ms max=${row.maxMs.toFixed(2)}ms events=${row.events}`,
    )
    .join(" | ");
}

describe("ADJ-AP-001 SessionEventEngine per-push cost must not grow with session length", () => {
  it("mean pushWristSample cost in minute 5 stays within 3x of minute 1 (30 fps live feed)", () => {
    const engine = new SessionEventEngine({ sessionId: "adj-push-cost" });
    const { perMinute } = measurePerMinute(engine, liveStream(305));
    console.log("ADJ-AP-001 per-minute push cost:", formatRows(perMinute));
    const first = perMinute[0]!;
    const last = perMinute[perMinute.length - 1]!;
    expect(perMinute.length).toBe(5);
    expect(
      last.meanMs / first.meanMs,
      `per-push cost grew ${(last.meanMs / first.meanMs).toFixed(1)}x from minute 1 to minute ${last.minute}`,
    ).toBeLessThanOrEqual(3);
  }, 120_000);

  it("a long idle stretch between games does not make the next game's pushes slower", () => {
    // 60 s play · 240 s standing still · 60 s play. Nothing closes during
    // the idle stretch, so the emission frontier does not move: a bound that
    // only counts samples PAST the frontier would still grow here.
    const engine = new SessionEventEngine({ sessionId: "adj-push-cost-idle" });
    const stream = playIdlePlayStream(60, 240);
    const { perMinute, emitted } = measurePerMinute(engine, stream);
    emitted.push(...engine.flush());
    console.log("ADJ-AP-001 play/idle/play push cost:", formatRows(perMinute));
    expect(perMinute.length).toBe(6);
    const first = perMinute[0]!;
    for (const row of perMinute.slice(1)) {
      expect(
        row.meanMs / first.meanMs,
        `minute ${row.minute} mean push cost is ${(row.meanMs / first.meanMs).toFixed(1)}x minute 1`,
      ).toBeLessThanOrEqual(3);
    }
    // Every stroke of both games is emitted; nothing during the idle stretch.
    const lastMs = stream[stream.length - 1]!.timestampMs;
    const firstGame = emitted.filter((event) => event.proposal.peakMs < 60_000);
    const secondGame = emitted.filter((event) => event.proposal.peakMs >= 300_000);
    expect(firstGame.length).toBe(strokePeaksIn(0, 60_000).length);
    expect(secondGame.length).toBe(strokePeaksIn(300_000, lastMs).length);
    expect(emitted.length).toBe(firstGame.length + secondGame.length);
  }, 120_000);

  it("every stroke of a 305 s session is still emitted exactly once, append-only", () => {
    const engine = new SessionEventEngine({ sessionId: "adj-push-cost-events" });
    const stream = liveStream(305);
    const emitted: SessionStrokeEvent[] = [];
    for (const sample of stream) emitted.push(...engine.pushWristSample(sample));
    emitted.push(...engine.flush());
    const lastMs = stream[stream.length - 1]!.timestampMs;
    const strokePeaks = strokePeaksIn(0, lastMs);
    expect(emitted.length).toBe(strokePeaks.length);
    expect(emitted.map((event) => event.eventId)).toEqual(
      strokePeaks.map((_, index) => `E${index + 1}`),
    );
    for (const [index, event] of emitted.entries()) {
      const peak = strokePeaks[index]!;
      expect(event.proposal.startMs).toBeLessThanOrEqual(peak);
      expect(event.proposal.endMs).toBeGreaterThanOrEqual(peak);
      expect(Math.abs(event.proposal.peakMs - peak)).toBeLessThanOrEqual(40);
      expect(event.closedAtMs).toBeGreaterThan(event.proposal.peakMs);
    }
    const snapshot = engine.snapshot();
    expect(snapshot.qualityState.wristSamples).toBe(stream.length);
    expect(snapshot.qualityState.droppedLateSamples).toBe(0);
    expect(snapshot.qualityState.lastSampleMs).toBe(lastMs);
  }, 120_000);

  it("a clip-length stream (< 30 s) still emits the batch proposer's events with EXACT bounds", () => {
    // Same speedBumps shape as the swing-lab replay suite: streaming must
    // stay indistinguishable from the offline batch run for short clips.
    const bumps = [
      { peakMs: 1500, height: 2.0, halfWidthMs: 120 },
      { peakMs: 4200, height: 1.4, halfWidthMs: 100 },
      { peakMs: 9800, height: 2.4, halfWidthMs: 140 },
      { peakMs: 16100, height: 0.9, halfWidthMs: 110 },
      { peakMs: 22600, height: 2.1, halfWidthMs: 120 },
    ];
    const series: SpeedSample[] = [];
    for (let t = 0; t <= 27_000; t += 40) {
      let value = IDLE;
      for (const bump of bumps) {
        value += bump.height * Math.exp(-0.5 * ((t - bump.peakMs) / bump.halfWidthMs) ** 2);
      }
      series.push({ timestampMs: t, value });
    }
    const batch = proposeStrokeEventsV2({
      paddleSpeeds: null,
      wristSpeeds: series,
      clipStartMs: series[0]!.timestampMs,
      clipEndMs: series[series.length - 1]!.timestampMs,
    }).events;
    expect(batch.length).toBe(bumps.length);

    const engine = new SessionEventEngine({ sessionId: "adj-clip-equivalence" });
    const emitted: SessionStrokeEvent[] = [];
    for (const sample of series) emitted.push(...engine.pushWristSample(sample));
    emitted.push(...engine.flush());
    expect(emitted.map((event) => [event.proposal.startMs, event.proposal.endMs])).toEqual(
      batch.map((event) => [event.startMs, event.endMs]),
    );
    expect(emitted.map((event) => event.proposal.peakMs)).toEqual(
      batch.map((event) => event.peakMs),
    );
    expect(engine.snapshot().qualityState.notes).toEqual([]);
  });

  it("a strong stroke minutes ago keeps setting the session's proposal floor and paddle normalization (batch-exact)", () => {
    // The proposer's floor is relative to the SESSION peak (30% of it) and
    // paddle confirmation normalizes by the session paddle maximum. Bounding
    // the retained history must not forget either: after a 6.0 smash, 1.5
    // dinks stay below the 1.8 floor for the rest of the session and 1.5
    // paddle peaks stay non-decisive against the 4.0 paddle maximum — exactly
    // as the offline batch run over the full series decides.
    const totalMs = 150_000;
    const smashMs = 5_000;
    const wrist: SpeedSample[] = [];
    const paddle: SpeedSample[] = [];
    const drives: number[] = [];
    const bumps: Array<{ peakMs: number; wrist: number; paddle: number }> = [
      { peakMs: smashMs, wrist: 6.0, paddle: 4.0 },
    ];
    for (let peak = 10_000, drive = true; peak <= totalMs - 5_000; peak += STROKE_PERIOD_MS) {
      bumps.push({ peakMs: peak, wrist: drive ? 2.5 : 1.5, paddle: 1.5 });
      if (drive) drives.push(peak);
      drive = !drive;
    }
    for (let t = 0; t <= totalMs; t += 33) {
      let wristValue = IDLE;
      let paddleValue = 0.05;
      for (const bump of bumps) {
        wristValue += bump.wrist * Math.exp(-0.5 * ((t - bump.peakMs) / 120) ** 2);
        paddleValue += bump.paddle * Math.exp(-0.5 * ((t - bump.peakMs) / 80) ** 2);
      }
      wrist.push({ timestampMs: t, value: wristValue });
      paddle.push({ timestampMs: t, value: paddleValue });
    }
    const batch = proposeStrokeEventsV2({
      paddleSpeeds: paddle,
      wristSpeeds: wrist,
      clipStartMs: 0,
      clipEndMs: totalMs,
    }).events;
    // Sanity: the batch itself proposes the smash + every drive and no dink
    // (peaks land on the 33 ms sample grid).
    expect(batch.length).toBe(1 + drives.length);
    for (const [index, expectedPeak] of [smashMs, ...drives].entries()) {
      expect(Math.abs(batch[index]!.peakMs - expectedPeak)).toBeLessThanOrEqual(33);
    }
    expect(batch.map((event) => event.paddleConfirmed)).toEqual([true, ...drives.map(() => false)]);

    const engine = new SessionEventEngine({ sessionId: "adj-session-floor" });
    const emitted: SessionStrokeEvent[] = [];
    for (let index = 0; index < wrist.length; index += 1) {
      emitted.push(...engine.push({ wrist: [wrist[index]!], paddle: [paddle[index]!] }));
    }
    emitted.push(...engine.flush());
    const view = (event: {
      startMs: number;
      endMs: number;
      peakMs: number;
      peakSpeed: number;
      paddleConfirmed: boolean;
      paddleSupport: number;
    }) => [
      event.startMs,
      event.endMs,
      event.peakMs,
      event.peakSpeed,
      event.paddleConfirmed,
      event.paddleSupport,
    ];
    expect(emitted.map((event) => view(event.proposal))).toEqual(batch.map(view));
    const quality = engine.snapshot().qualityState;
    expect(quality.notes).toEqual([]);
    expect(quality.wristSamples).toBe(wrist.length);
    expect(quality.paddleSamples).toBe(paddle.length);
  });
});
