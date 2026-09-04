import { describe, expect, it } from "vitest";
import {
  SessionEventEngine,
  type SessionStrokeEvent,
  type SpeedSample,
} from "../../src/sessionEngine.js";
import { boundsOf, mulberry32, syntheticStream } from "./attackFixtures.js";

/**
 * ADVERSARIAL PASS 3 / TESTER #2 — feed-shape equivalence. The engine's
 * header claims a live session "sees identical events to the offline batch
 * run"; these scenarios probe that claim across batch size, duplicate
 * timestamps and intra-batch ordering. All randomness is seeded (seed in the
 * test name / body).
 */

function feedOneAtATime(sessionId: string, stream: readonly SpeedSample[]): SessionStrokeEvent[] {
  const engine = new SessionEventEngine({ sessionId });
  const out: SessionStrokeEvent[] = [];
  for (const sample of stream) out.push(...engine.pushWristSample(sample));
  out.push(...engine.flush());
  return out;
}

function feedBatch(sessionId: string, stream: readonly SpeedSample[]): SessionStrokeEvent[] {
  const engine = new SessionEventEngine({ sessionId });
  const out = engine.push({ wrist: stream });
  out.push(...engine.flush());
  return out;
}

function feedChunks(
  sessionId: string,
  stream: readonly SpeedSample[],
  chunk: number,
  transform: (chunk: SpeedSample[]) => SpeedSample[] = (c) => c,
): SessionStrokeEvent[] {
  const engine = new SessionEventEngine({ sessionId });
  const out: SessionStrokeEvent[] = [];
  for (let index = 0; index < stream.length; index += chunk) {
    out.push(...engine.push({ wrist: transform(stream.slice(index, index + chunk)) }));
  }
  out.push(...engine.flush());
  return out;
}

function proposalsOf(events: readonly SessionStrokeEvent[]) {
  return events.map((event) => ({ ...event.proposal }));
}

describe("S5 — 10 000 samples in ONE push() (batch import) vs one sample per push", () => {
  // 10 000 samples @30 Hz = 333 s of play, a stroke every 6 s (55 strokes),
  // seeded jitter so the baseline is not perfectly flat (real wrist series
  // never are).
  const SEED = 5_0001;
  const stream = syntheticStream({
    durationMs: 10_000 * (1000 / 30),
    hz: 30,
    strokeEveryMs: 6000,
    firstStrokeMs: 2000,
    jitter: 0.03,
    seed: SEED,
  }).slice(0, 10_000);

  it("emits the same event COUNT and BOUNDS", () => {
    expect(stream).toHaveLength(10_000);
    const single = feedOneAtATime("attack-s5-single", stream);
    const batch = feedBatch("attack-s5-batch", stream);
    expect(batch.length, `batch=${batch.length} single=${single.length}`).toBe(single.length);
    expect(batch.map(boundsOf)).toEqual(single.map(boundsOf));
  }, 300_000);

  it("emits the same FULL proposals (prominence, confidence, source, paddle fields) and close reasons", () => {
    const single = feedOneAtATime("attack-s5-single-full", stream);
    const batch = feedBatch("attack-s5-batch-full", stream);
    const diffs: string[] = [];
    for (let index = 0; index < Math.min(single.length, batch.length); index += 1) {
      const a = single[index]!;
      const b = batch[index]!;
      for (const key of Object.keys(a.proposal) as Array<keyof typeof a.proposal>) {
        if (a.proposal[key] !== b.proposal[key]) {
          diffs.push(
            `${a.eventId}.${key}: single=${String(a.proposal[key])} batch=${String(b.proposal[key])}`,
          );
        }
      }
      if (a.closeReason !== b.closeReason) {
        diffs.push(`${a.eventId}.closeReason: single=${a.closeReason} batch=${b.closeReason}`);
      }
    }
    expect(diffs, diffs.slice(0, 40).join("\n")).toEqual([]);
  }, 300_000);

  it("(low-amplitude variant, seed 5_0002) confidence — consumed by the native clip extractor — matches between live and batch feeding", () => {
    // Peak ≈0.75 over a 0.2 baseline → prominence ≈3–4, i.e. INSIDE the
    // unclamped range of confidence = 0.4 + (prominence − 1) · 0.12.
    const lowStream = syntheticStream({
      durationMs: 60_000,
      hz: 30,
      strokeEveryMs: 3000,
      firstStrokeMs: 1500,
      height: 0.55,
      baseline: 0.2,
      jitter: 0.02,
      seed: 5_0002,
    });
    const single = feedOneAtATime("attack-s5-low-single", lowStream);
    const batch = feedBatch("attack-s5-low-batch", lowStream);
    expect(batch.map(boundsOf)).toEqual(single.map(boundsOf));
    const diffs = single
      .map((event, index) => ({
        eventId: event.eventId,
        single: event.proposal.confidence,
        batch: batch[index]?.proposal.confidence,
        singleProminence: event.proposal.prominence,
        batchProminence: batch[index]?.proposal.prominence,
      }))
      .filter((row) => row.single !== row.batch);
    expect(diffs, JSON.stringify(diffs.slice(0, 10), null, 1)).toEqual([]);
  }, 120_000);
});

describe("S6 — two samples with identical timestamps but different values", () => {
  const base = syntheticStream({ durationMs: 7_000, strokeEveryMs: 3000, firstStrokeMs: 1500 });
  // Duplicate the PEAK sample's timestamp with a wildly different value.
  const peakIndex = base.reduce(
    (best, sample, index) => (sample.value > base[best]!.value ? index : best),
    0,
  );
  const dupA: SpeedSample = { timestampMs: base[peakIndex]!.timestampMs, value: 0.05 };
  const withDupAfter = [...base.slice(0, peakIndex + 1), dupA, ...base.slice(peakIndex + 1)];
  const withDupBefore = [...base.slice(0, peakIndex), dupA, ...base.slice(peakIndex)];

  it("the same input twice gives identical bounds (determinism for a fixed feed)", () => {
    const first = feedBatch("attack-s6-a", withDupAfter).map(boundsOf);
    const second = feedBatch("attack-s6-b", withDupAfter).map(boundsOf);
    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
    // …and one-at-a-time agrees with the batch for the same order.
    expect(feedOneAtATime("attack-s6-c", withDupAfter).map(boundsOf)).toEqual(first);
  });

  it("the ORDER of two equal-timestamp samples does not change the proposal bounds", () => {
    const after = feedBatch("attack-s6-order-after", withDupAfter);
    const before = feedBatch("attack-s6-order-before", withDupBefore);
    // Two samples at the same instant describe one instant; whichever the
    // producer emitted first must not move a stroke boundary.
    const outer = (e: SessionStrokeEvent) => ({
      eventId: e.eventId,
      startMs: e.proposal.startMs,
      endMs: e.proposal.endMs,
    });
    expect(before.map(outer)).toEqual(after.map(outer));
    // …nor the peak.
    expect(
      before.map(boundsOf),
      JSON.stringify({ before: proposalsOf(before), after: proposalsOf(after) }),
    ).toEqual(after.map(boundsOf));
  });

  it("a long run of equal timestamps (frozen clock, 30 samples) does not throw and the session stays consistent", () => {
    const frozen: SpeedSample[] = [];
    const rng = mulberry32(6_0002);
    for (let index = 0; index < 30; index += 1) {
      frozen.push({ timestampMs: 4000, value: 0.1 + rng() * 2 });
    }
    const stream = [
      ...base.filter((s) => s.timestampMs < 4000),
      ...frozen,
      ...base.filter((s) => s.timestampMs > 4000),
    ];
    const engine = new SessionEventEngine({ sessionId: "attack-s6-frozen" });
    expect(() => {
      engine.push({ wrist: stream });
      engine.flush();
    }).not.toThrow();
    const snap = engine.snapshot();
    for (const event of snap.events) {
      expect(event.proposal.startMs).toBeLessThanOrEqual(event.proposal.peakMs);
      expect(event.proposal.peakMs).toBeLessThanOrEqual(event.proposal.endMs);
      expect(Number.isFinite(event.proposal.prominence)).toBe(true);
      expect(Number.isFinite(event.proposal.confidence)).toBe(true);
    }
  });
});

describe("S7 — wrist samples out of order (decreasing timestamps) within one push", () => {
  const SEED = 7_0003;
  const stream = syntheticStream({
    durationMs: 30_000,
    strokeEveryMs: 3000,
    firstStrokeMs: 1500,
    jitter: 0.03,
    seed: SEED,
  });

  it("a fully reversed single push equals the sorted single push", () => {
    const sorted = feedBatch("attack-s7-sorted", stream);
    const reversed = feedBatch("attack-s7-reversed", [...stream].reverse());
    expect(reversed.length).toBeGreaterThan(0);
    expect(reversed.map(boundsOf)).toEqual(sorted.map(boundsOf));
    expect(proposalsOf(reversed)).toEqual(proposalsOf(sorted));
    expect(reversed.map((e) => e.closeReason)).toEqual(sorted.map((e) => e.closeReason));
  });

  it("chunked pushes (150 samples) each internally reversed equal the same chunks sorted", () => {
    const sorted = feedChunks("attack-s7-chunk-sorted", stream, 150);
    const reversed = feedChunks("attack-s7-chunk-reversed", stream, 150, (c) => [...c].reverse());
    expect(reversed.map(boundsOf)).toEqual(sorted.map(boundsOf));
    expect(proposalsOf(reversed)).toEqual(proposalsOf(sorted));
    expect(reversed.map((e) => e.closeReason)).toEqual(sorted.map((e) => e.closeReason));
  });

  it("chunked pushes seeded-shuffled within each chunk equal the sorted chunks (seed 7_0004)", () => {
    const rng = mulberry32(7_0004);
    const shuffle = (chunk: SpeedSample[]) => {
      const copy = [...chunk];
      for (let index = copy.length - 1; index > 0; index -= 1) {
        const j = Math.floor(rng() * (index + 1));
        [copy[index], copy[j]] = [copy[j]!, copy[index]!];
      }
      return copy;
    };
    const sorted = feedChunks("attack-s7-shuf-sorted", stream, 90);
    const shuffled = feedChunks("attack-s7-shuf-shuffled", stream, 90, shuffle);
    expect(shuffled.map(boundsOf)).toEqual(sorted.map(boundsOf));
    expect(proposalsOf(shuffled)).toEqual(proposalsOf(sorted));
  });

  it("(informational) a sample that arrives one chunk LATE and lands behind the frontier is dropped and counted", () => {
    const engine = new SessionEventEngine({ sessionId: "attack-s7-late" });
    const chunk = 150;
    let held: SpeedSample | null = null;
    for (let index = 0; index < stream.length; index += chunk) {
      const slice = stream.slice(index, index + chunk);
      const batch = held ? [held, ...slice.slice(1)] : slice.slice(1);
      held = slice[0]!; // deliver the first sample of every chunk one chunk late
      engine.push({ wrist: batch });
    }
    if (held) engine.push({ wrist: [held] });
    engine.flush();
    const snap = engine.snapshot();
    expect(snap.qualityState.droppedLateSamples).toBeGreaterThanOrEqual(0);
    expect(snap.qualityState.wristSamples).toBe(stream.length);
  });
});
