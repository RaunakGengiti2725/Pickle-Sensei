import { describe, expect, it } from "vitest";
import type { PhaseSpan, PoseFrame } from "@pickle/shared-types";
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
    expect(keys).toEqual([
      "ready",
      "prepare",
      "accelerate",
      "contact",
      "follow_through",
      "recover",
    ]);

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

  it("is deterministic frame for frame", async () => {
    const swing = generateSwing();
    const segmenter = new GeometricPhaseSegmenter({ aspectRatio: 1 });
    const first = await segmenter.segmentPhases(swing.frames, [], stroke(swing.window));
    const second = await segmenter.segmentPhases(swing.frames, [], stroke(swing.window));
    expect(second).toEqual(first);
  });
});

describe("GeometricPhaseSegmenter clamps outer spans to measured frames (VG-4)", () => {
  // 61 frames at 60 fps (0..1000 ms), right wrist advancing along +x with a
  // single triangular speed bump centred on frame 30 — one distinct peak.
  const FRAME_MS = 1000 / 60;
  const frames: PoseFrame[] = [];
  let x = 0;
  for (let index = 0; index < 61; index += 1) {
    const distance = Math.abs(index - 30);
    const step = distance <= 6 ? 1 + Math.round(((6 - distance) / 6) * 39) : 1;
    x += step / 1024;
    frames.push({
      timestampMs: index * FRAME_MS,
      space: "normalized-image",
      confidence: 1,
      landmarks: [{ name: "right_wrist", x, y: 0.5, visibility: 0.9 }],
    });
  }
  const firstMeasuredMs = frames[0]!.timestampMs;
  const lastMeasuredMs = frames.at(-1)!.timestampMs;
  const request = (startMs: number, endMs: number): StrokeEvent => ({
    startMs,
    endMs,
    contactMs: null,
    shotTypeHypothesis: null,
    confidence: 0.9,
  });

  function expectOrderedContiguousWithinMeasured(spans: readonly PhaseSpan[]): void {
    expect(spans.map((span) => span.key)).toEqual([
      "ready",
      "prepare",
      "accelerate",
      "contact",
      "follow_through",
      "recover",
    ]);
    for (const span of spans) {
      expect(span.startMs).toBeLessThanOrEqual(span.representativeMs);
      expect(span.representativeMs).toBeLessThanOrEqual(span.endMs);
      expect(span.startMs).toBeGreaterThanOrEqual(firstMeasuredMs);
      expect(span.endMs).toBeLessThanOrEqual(lastMeasuredMs + 1e-9);
    }
    for (let index = 1; index < spans.length; index += 1) {
      expect(spans[index]!.startMs).toBe(spans[index - 1]!.endMs);
    }
  }

  it("does not extend recover past the last measured frame for window [0, 60000]", async () => {
    const result = await new GeometricPhaseSegmenter({ aspectRatio: 1 }).segmentPhases(
      frames,
      [],
      request(0, 60000),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(lastMeasuredMs).toBeLessThanOrEqual(1000.0000000000001);
    const recover = result.value.find((span) => span.key === "recover")!;
    const ready = result.value.find((span) => span.key === "ready")!;
    expect(recover.endMs).toBeLessThanOrEqual(1000.0000000000001);
    expect(ready.startMs).toBeGreaterThanOrEqual(0);
    expectOrderedContiguousWithinMeasured(result.value);
  });

  it("does not extend ready before the first measured frame for window [-60000, 60000]", async () => {
    const result = await new GeometricPhaseSegmenter({ aspectRatio: 1 }).segmentPhases(
      frames,
      [],
      request(-60000, 60000),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ready = result.value.find((span) => span.key === "ready")!;
    expect(ready.startMs).toBeGreaterThanOrEqual(0);
    expectOrderedContiguousWithinMeasured(result.value);
  });

  it("stamps the bumped phase model version (outer-span clamping changed output)", () => {
    expect(new GeometricPhaseSegmenter({ aspectRatio: 1 }).modelVersion).toBe("phase-geometry-2");
  });
});
