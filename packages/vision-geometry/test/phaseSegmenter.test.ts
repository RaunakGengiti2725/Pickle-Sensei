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

  it("contact frame index is invariant to monotone timestamp jitter below 0.3 frame interval (XCF-09)", async () => {
    const swing = generateSwing();
    const intervalMs = 1000 / swing.clip.fps;
    const segmenter = new GeometricPhaseSegmenter({ aspectRatio: 1 });
    const baseline = await segmenter.segmentPhases(swing.frames, [], stroke(swing.window));
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    const baselineContact = baseline.value.find((span) => span.key === "contact")!;
    const baselineIndex = nearestFrameIndex(swing.frames, baselineContact.representativeMs);

    // Deterministic LCG so the perturbation is reproducible; each frame moves
    // by at most JITTER_FRACTION of an interval, which keeps the order strict.
    const JITTER_FRACTION = 0.29;
    for (const seed of [1, 2, 3, 4, 5]) {
      let state = seed;
      const next = (): number => {
        state = (state * 1664525 + 1013904223) % 4294967296;
        return state / 4294967296;
      };
      const jittered = swing.frames.map((frame) => ({
        ...frame,
        timestampMs: frame.timestampMs + (2 * next() - 1) * JITTER_FRACTION * intervalMs,
      }));
      for (let index = 1; index < jittered.length; index += 1) {
        expect(jittered[index]!.timestampMs).toBeGreaterThan(jittered[index - 1]!.timestampMs);
      }

      const result = await segmenter.segmentPhases(jittered, [], stroke(swing.window));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const contact = result.value.find((span) => span.key === "contact")!;
      expect(nearestFrameIndex(jittered, contact.representativeMs)).toBe(baselineIndex);
      expect(result.value.map((span) => span.key)).toEqual(baseline.value.map((span) => span.key));
    }
  });
});

function nearestFrameIndex(
  frames: readonly { timestampMs: number }[],
  timestampMs: number,
): number {
  let bestIndex = 0;
  let bestDelta = Number.POSITIVE_INFINITY;
  frames.forEach((frame, index) => {
    const delta = Math.abs(frame.timestampMs - timestampMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIndex = index;
    }
  });
  return bestIndex;
}
