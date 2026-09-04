import { describe, expect, it } from "vitest";
import type { Measurement, PhaseSpan, PoseFrame } from "@pickle/shared-types";
import type { StrokeEvent } from "@pickle/vision-contracts";
import { PoseGeometryFeatureExtractor } from "../../src/featureExtractor.js";
import { GeometricPhaseSegmenter } from "../../src/phaseSegmenter.js";
import { generateSwing } from "@pickle/evaluation";

/**
 * Attack on 9464e316 (ADJ-VG-04 candidate).
 *
 * The candidate clamps the outer phase spans to the MEASURED frames and its
 * adjudication fixture only measures pose on the ~2s swing, so a 60 000ms
 * window collapses back onto the swing. The native importer does not work
 * like that: PickleVideoCapture.swift runs Vision on every decimated frame
 * of the whole imported clip and writes a pose frame wherever a body was
 * detected, so a 60s clip of a player standing on court yields ~60s of
 * measured frames around a ~2s swing.
 *
 * ADJ-VG-04 acceptance #3: "A 60s imported clip containing a ~2s swing
 * produces the same phase spans and recovery_time_ms as the same frames
 * analysed with a tight window."  With full pose coverage that is false on
 * the candidate: recover.endMs still runs to the end of the clip and
 * recovery_time_ms (scored 0-1000ms in @pickle/scoring v1) is ~48.7s.
 */

const stroke = (window: {
  startMs: number;
  endMs: number;
  peakMs: number | null;
}): StrokeEvent => ({
  startMs: window.startMs,
  endMs: window.endMs,
  contactMs: window.peakMs,
  shotTypeHypothesis: null,
  confidence: 0.9,
});

const IMPORTED_CLIP_MS = 60_000;
const IMPORTED_WINDOW = { startMs: 0, endMs: IMPORTED_CLIP_MS, peakMs: null };

async function segment(
  frames: PoseFrame[],
  window: { startMs: number; endMs: number; peakMs: number | null },
): Promise<PhaseSpan[]> {
  const segmenter = new GeometricPhaseSegmenter({ aspectRatio: 1 });
  const result = await segmenter.segmentPhases(frames, [], stroke(window));
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error("segmentation failed");
  return result.value;
}

async function measure(
  frames: PoseFrame[],
  phases: PhaseSpan[],
): Promise<Map<string, Measurement>> {
  const extractor = new PoseGeometryFeatureExtractor({ aspectRatio: 1 });
  const measured = await extractor.extractMeasurements({
    poseFrames: frames,
    paddleFrames: [],
    phases,
    shotType: "forehand_drive",
    handedness: "right",
    cameraView: "side",
  });
  expect(measured.ok, JSON.stringify(measured)).toBe(true);
  if (!measured.ok) throw new Error("extraction failed");
  return new Map(measured.value.map((entry) => [entry.metricKey, entry]));
}

const byKey = (phases: PhaseSpan[], key: PhaseSpan["key"]): PhaseSpan => {
  const found = phases.find((entry) => entry.key === key);
  if (!found) throw new Error(`missing phase ${key}`);
  return found;
};

/** Pose on every frame of a 60s clip; the swing peaks ~10.7s in. */
function fullCoverageImportedClip() {
  const swing = generateSwing({ readyMs: 10_000, recoverMs: 48_580 });
  const frames = swing.frames;
  const last = frames[frames.length - 1]!.timestampMs;
  // sanity: this fixture really covers the clip, unlike the candidate's.
  expect(frames.length).toBeGreaterThan(3000);
  expect(last).toBeGreaterThan(IMPORTED_CLIP_MS - 1000);
  return swing;
}

describe("ADJ-VG-04 attack: imported clip with pose measured on every frame", () => {
  it("recover.endMs / recovery_time_ms match the tight-window analysis of the same frames", async () => {
    const swing = fullCoverageImportedClip();
    const tightWindow = {
      startMs: swing.window.peakMs - 1200,
      endMs: swing.window.peakMs + 1000,
      peakMs: null,
    };

    const imported = await segment(swing.frames, IMPORTED_WINDOW);
    const tight = await segment(swing.frames, tightWindow);

    // Inner spans agree (sanity — the swing itself is found identically).
    expect(byKey(imported, "contact").representativeMs).toBe(
      byKey(tight, "contact").representativeMs,
    );
    expect(byKey(imported, "follow_through").endMs).toBe(byKey(tight, "follow_through").endMs);

    const importedRecovery = (await measure(swing.frames, imported)).get("recovery_time_ms");
    const tightRecovery = (await measure(swing.frames, tight)).get("recovery_time_ms");
    expect(tightRecovery?.value).toBeDefined();

    // Acceptance #3: same recovery_time_ms for the same frames.
    // Candidate: imported = 48733ms (clip remainder), tight = 833ms.
    expect(importedRecovery?.value).toBe(tightRecovery?.value);
  });

  it("recovery_time_ms stays inside the scored 0-1000ms domain for a normal swing", async () => {
    const swing = fullCoverageImportedClip();
    const imported = await segment(swing.frames, IMPORTED_WINDOW);
    const recovery = (await measure(swing.frames, imported)).get("recovery_time_ms");
    expect(recovery?.value).toBeDefined();
    // ~48.7s of standing still after the swing is not a 48.7s recovery.
    expect(recovery!.value).toBeLessThanOrEqual(1000);
  });

  it("ready-position metrics are sampled next to the swing, not mid-clip", async () => {
    const swing = fullCoverageImportedClip();
    const tightWindow = {
      startMs: swing.window.peakMs - 1200,
      endMs: swing.window.peakMs + 1000,
      peakMs: null,
    };
    const imported = await segment(swing.frames, IMPORTED_WINDOW);
    const tight = await segment(swing.frames, tightWindow);

    // featureExtractor samples stance_width_ratio / knee_flexion_deg /
    // paddle_ready_height_ratio at ready.representativeMs.  Candidate puts
    // it at 5025ms (midpoint of 0..prepareStart) — 5s before the player
    // starts the shot — vs 9775ms with the tight window.
    const importedReady = byKey(imported, "ready");
    const tightReady = byKey(tight, "ready");
    expect(importedReady.representativeMs).toBe(tightReady.representativeMs);
  });
});
