import { describe, expect, it } from "vitest";
import type { StrokeEvent } from "@pickle/vision-contracts";
import { GeometricPhaseSegmenter } from "../src/phaseSegmenter.js";
import { generateSwing } from "@pickle/evaluation";

const stroke = (window: { startMs: number; endMs: number; peakMs: number }): StrokeEvent => ({
  startMs: window.startMs,
  endMs: window.endMs,
  contactMs: window.peakMs,
  shotTypeHypothesis: null,
  confidence: 0.9,
});

describe("GeometricPhaseSegmenter", () => {
  it("segments a swing into ordered, contiguous phases with contact at the speed peak", async () => {
    const swing = generateSwing();
    const segmenter = new GeometricPhaseSegmenter({ aspectRatio: 1 });
    const result = await segmenter.segmentPhases(swing.frames, [], stroke(swing.window));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const keys = result.value.map((span) => span.key);
    expect(keys).toEqual(["ready", "prepare", "accelerate", "contact", "follow_through"]);

    // Contiguous and ordered.
    for (let index = 1; index < result.value.length; index += 1) {
      const previous = result.value[index - 1]!;
      const current = result.value[index]!;
      expect(current.startMs).toBeGreaterThanOrEqual(previous.startMs);
      expect(current.startMs).toBeCloseTo(previous.endMs, 6);
      expect(current.endMs).toBeGreaterThanOrEqual(current.startMs);
    }

    // Contact lands near the constructed peak (within three frames at 60fps).
    const contact = result.value.find((span) => span.key === "contact")!;
    expect(Math.abs(contact.representativeMs - swing.window.peakMs)).toBeLessThanOrEqual(50);

    // The accelerate phase must sit inside the constructed forward-swing time.
    const accelerate = result.value.find((span) => span.key === "accelerate")!;
    expect(accelerate.startMs).toBeGreaterThanOrEqual(400); // after ready
    expect(accelerate.endMs).toBeLessThanOrEqual(swing.window.peakMs + 34);
  });

  it("abstains on idle motion instead of inventing phases", async () => {
    const swing = generateSwing();
    // Freeze the wrist: replace every frame's wrists with the first frame's.
    const first = swing.frames[0]!;
    const frozen = swing.frames.map((frame) => ({
      ...frame,
      landmarks: frame.landmarks.map((entry) =>
        entry.name.endsWith("wrist")
          ? {
              ...entry,
              x: first.landmarks.find((l) => l.name === entry.name)!.x,
              y: first.landmarks.find((l) => l.name === entry.name)!.y,
            }
          : entry,
      ),
    }));
    const segmenter = new GeometricPhaseSegmenter({ aspectRatio: 1 });
    const result = await segmenter.segmentPhases(frozen, [], stroke(swing.window));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("low_confidence");
  });

  it("abstains when too few pose frames overlap the window", async () => {
    const swing = generateSwing();
    const segmenter = new GeometricPhaseSegmenter({ aspectRatio: 1 });
    const result = await segmenter.segmentPhases(
      swing.frames.slice(0, 4),
      [],
      stroke(swing.window),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("phase.too_few_pose_frames");
  });

  it("does not claim return-to-ready from trailing clip time", async () => {
    const swing = generateSwing();
    const segmenter = new GeometricPhaseSegmenter({ aspectRatio: 1 });
    const result = await segmenter.segmentPhases(swing.frames, [], stroke(swing.window));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.some((phase) => phase.key === "recover")).toBe(false);
  });

  it.each(["before", "after", "contact"] as const)(
    "keeps %s boundaries inside actual observations",
    async (edge) => {
      const swing = generateSwing();
      const frames =
        edge === "before"
          ? swing.frames.filter((frame) => frame.timestampMs >= 200)
          : edge === "contact"
            ? swing.frames.filter((frame) => frame.timestampMs <= swing.window.peakMs)
            : swing.frames;
      const segmenter = new GeometricPhaseSegmenter({ aspectRatio: 1 });
      const result = await segmenter.segmentPhases(frames, [], {
        ...stroke(swing.window),
        endMs: swing.window.endMs + 3000,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      for (const phase of result.value) {
        expect(phase.startMs).toBeGreaterThanOrEqual(frames[0]!.timestampMs);
        expect(phase.endMs).toBeLessThanOrEqual(frames.at(-1)!.timestampMs);
        expect(phase.endMs).toBeGreaterThan(phase.startMs);
        expect(phase.representativeMs).toBeGreaterThanOrEqual(phase.startMs);
        expect(phase.representativeMs).toBeLessThanOrEqual(phase.endMs);
      }
    },
  );

  it("uses the actual per-call video aspect without mutating another analysis", async () => {
    const swing = generateSwing();
    const wideFrames = swing.frames.map((frame) => ({
      ...frame,
      landmarks: frame.landmarks.map((point) => ({ ...point, x: point.x / 2 })),
    }));
    const segmenter = new GeometricPhaseSegmenter({ aspectRatio: 1 });
    const reference = await segmenter.segmentPhases(swing.frames, [], stroke(swing.window));
    const incorrectSquare = await segmenter.segmentPhases(wideFrames, [], stroke(swing.window));
    expect(incorrectSquare).not.toEqual(reference);
    const [wide, square] = await Promise.all([
      segmenter.segmentPhases(wideFrames, [], stroke(swing.window), { width: 1280, height: 640 }),
      segmenter.segmentPhases(swing.frames, [], stroke(swing.window), { width: 640, height: 640 }),
    ]);
    expect(wide).toEqual(reference);
    expect(square).toEqual(reference);
  });

  it("uses observed sample timestamps for every representative frame", async () => {
    const swing = generateSwing();
    const result = await new GeometricPhaseSegmenter({ aspectRatio: 1 }).segmentPhases(
      swing.frames,
      [],
      stroke(swing.window),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const observed = new Set(swing.frames.map((frame) => frame.timestampMs));
    for (const phase of result.value) expect(observed.has(phase.representativeMs)).toBe(true);
  });

  it("requires measured video dimensions when no per-clip aspect was configured", async () => {
    const swing = generateSwing();
    const segmenter = new GeometricPhaseSegmenter();
    expect((await segmenter.segmentPhases(swing.frames, [], stroke(swing.window))).ok).toBe(false);
    for (const video of [
      { width: 0, height: 640 },
      { width: -1280, height: -640 },
      { width: 1280, height: Number.NaN },
    ]) {
      expect(
        (await segmenter.segmentPhases(swing.frames, [], stroke(swing.window), video)).ok,
      ).toBe(false);
    }
    expect(
      (
        await segmenter.segmentPhases(swing.frames, [], stroke(swing.window), {
          width: 640,
          height: 640,
        })
      ).ok,
    ).toBe(true);
  });

  it("is deterministic frame for frame", async () => {
    const swing = generateSwing();
    const segmenter = new GeometricPhaseSegmenter({ aspectRatio: 1 });
    const first = await segmenter.segmentPhases(swing.frames, [], stroke(swing.window));
    const second = await segmenter.segmentPhases(swing.frames, [], stroke(swing.window));
    expect(second).toEqual(first);
  });
});
