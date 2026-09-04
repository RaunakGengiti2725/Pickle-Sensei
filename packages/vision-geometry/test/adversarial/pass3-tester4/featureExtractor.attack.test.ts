import { describe, expect, it } from "vitest";
import type { Measurement, PhaseSpan } from "@pickle/shared-types";
import { generateSwingSequence } from "@pickle/evaluation";
import {
  GeometricPhaseSegmenter,
  GeometryBiomechanicsExtractor,
  PoseGeometryFeatureExtractor,
} from "../../../src/index.js";
import {
  exactTorsoFrames,
  handBuiltPhases,
  legacyFramesOf,
  nonFiniteMeasurements,
  realSwingWithPhases,
  timestampsEvery,
} from "./support/attackFixtures.js";

/**
 * ADVERSARIAL PASS 3 / TESTER 4 — PoseGeometryFeatureExtractor +
 * GeometryBiomechanicsExtractor, against 4d812e1a. New files only.
 *
 * Convention (same as tester 3): `it(...)` = HELD, `it.fails(...)` = a
 * reproduced BROKEN expectation (the assertion states what SHOULD hold; the
 * suite stays green while the finding is pinned), followed by an `observed:`
 * case that records the actual behaviour as evidence.
 */

const COMMON = {
  paddleFrames: [],
  shotType: "forehand_drive" as const,
  handedness: "right" as const,
  cameraView: "side" as const,
};

function mutatePhase(
  phases: readonly PhaseSpan[],
  key: PhaseSpan["key"],
  patch: Partial<PhaseSpan>,
): PhaseSpan[] {
  return phases.map((phase) => (phase.key === key ? { ...phase, ...patch } : phase));
}

describe("S1 phase-set integrity: missing / overlapping / zero-duration phases", () => {
  it("control: real phases from the segmenter produce ≥ 10 finite measurements", async () => {
    const { frames, phases } = await realSwingWithPhases();
    const result = await new PoseGeometryFeatureExtractor({ aspectRatio: 1 }).extractMeasurements({
      ...COMMON,
      poseFrames: frames,
      phases,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeGreaterThanOrEqual(10);
    expect(nonFiniteMeasurements(result.value)).toEqual([]);
  });

  it("phases missing 'recover' → typed low_confidence features.missing_phase, no partial Measurement[]", async () => {
    const { frames, phases } = await realSwingWithPhases();
    const result = await new PoseGeometryFeatureExtractor({ aspectRatio: 1 }).extractMeasurements({
      ...COMMON,
      poseFrames: frames,
      phases: phases.filter((phase) => phase.key !== "recover"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("low_confidence");
    expect(result.failure.code).toBe("features.missing_phase");
    expect(result.failure.message).toContain('"recover"');
    expect("value" in result).toBe(false);
  });

  it("each of the six phases missing in turn → the same typed failure naming that phase", async () => {
    const { frames, phases } = await realSwingWithPhases();
    for (const missing of phases.map((phase) => phase.key)) {
      const result = await new PoseGeometryFeatureExtractor({
        aspectRatio: 1,
      }).extractMeasurements({
        ...COMMON,
        poseFrames: frames,
        phases: phases.filter((phase) => phase.key !== missing),
      });
      expect(result.ok, `missing ${missing}`).toBe(false);
      if (result.ok) continue;
      expect(result.failure.code).toBe("features.missing_phase");
      expect(result.failure.message).toContain(`"${missing}"`);
    }
  });

  it("empty phases[] → typed failure (never an empty ok([]))", async () => {
    const { frames } = await realSwingWithPhases();
    const result = await new PoseGeometryFeatureExtractor({ aspectRatio: 1 }).extractMeasurements({
      ...COMMON,
      poseFrames: frames,
      phases: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("features.missing_phase");
  });

  it.fails(
    "overlapping prepare/accelerate (prepare runs to the contact) → typed failure, not measurements from a contradictory phase set",
    async () => {
      const { frames, phases } = await realSwingWithPhases();
      const contact = phases.find((phase) => phase.key === "contact")!;
      const overlapping = mutatePhase(phases, "prepare", { endMs: contact.startMs });
      const result = await new PoseGeometryFeatureExtractor({
        aspectRatio: 1,
      }).extractMeasurements({ ...COMMON, poseFrames: frames, phases: overlapping });
      expect(result.ok).toBe(false);
    },
  );

  it("observed: overlapping prepare/accelerate is accepted and inflates backswing_length_norm vs the ordered set (evidence for the P3 above)", async () => {
    const { frames, phases } = await realSwingWithPhases();
    const contact = phases.find((phase) => phase.key === "contact")!;
    const extractor = new PoseGeometryFeatureExtractor({ aspectRatio: 1 });
    const ordered = await extractor.extractMeasurements({ ...COMMON, poseFrames: frames, phases });
    const overlapping = await extractor.extractMeasurements({
      ...COMMON,
      poseFrames: frames,
      phases: mutatePhase(phases, "prepare", { endMs: contact.startMs }),
    });
    expect(ordered.ok && overlapping.ok).toBe(true);
    if (!ordered.ok || !overlapping.ok) return;
    const backswing = (measurements: Measurement[]) =>
      measurements.find((entry) => entry.metricKey === "backswing_length_norm")!.value;
    expect(overlapping.value.every((entry) => entry.source === "real")).toBe(true);
    expect(backswing(overlapping.value)).toBeGreaterThan(backswing(ordered.value) * 1.2);
  });

  it.fails(
    "inverted prepare span (startMs > endMs) → typed failure, not a 'real' backswing_length_norm of 0",
    async () => {
      const { frames, phases } = await realSwingWithPhases();
      const prepare = phases.find((phase) => phase.key === "prepare")!;
      const inverted = mutatePhase(phases, "prepare", {
        startMs: prepare.endMs,
        endMs: prepare.startMs,
      });
      const result = await new PoseGeometryFeatureExtractor({
        aspectRatio: 1,
      }).extractMeasurements({ ...COMMON, poseFrames: frames, phases: inverted });
      expect(result.ok).toBe(false);
    },
  );

  it("observed: inverted prepare span yields ok() with backswing_length_norm === 0 marked source 'real' (evidence for the P3 above)", async () => {
    const { frames, phases } = await realSwingWithPhases();
    const prepare = phases.find((phase) => phase.key === "prepare")!;
    const result = await new PoseGeometryFeatureExtractor({ aspectRatio: 1 }).extractMeasurements({
      ...COMMON,
      poseFrames: frames,
      phases: mutatePhase(phases, "prepare", { startMs: prepare.endMs, endMs: prepare.startMs }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const backswing = result.value.find((entry) => entry.metricKey === "backswing_length_norm");
    expect(backswing).toBeDefined();
    expect(backswing!.value).toBe(0);
    expect(backswing!.source).toBe("real");
  });

  it.fails(
    "zero-duration contact (startMs === representativeMs === endMs) → typed failure, no partial Measurement[]",
    async () => {
      const { frames, phases } = await realSwingWithPhases();
      const contact = phases.find((phase) => phase.key === "contact")!;
      const zero = mutatePhase(phases, "contact", {
        startMs: contact.representativeMs,
        endMs: contact.representativeMs,
      });
      const result = await new PoseGeometryFeatureExtractor({
        aspectRatio: 1,
      }).extractMeasurements({ ...COMMON, poseFrames: frames, phases: zero });
      expect(result.ok).toBe(false);
    },
  );

  it("observed: zero-duration contact is accepted; measurements stay finite (the values are not corrupted, only unvalidated)", async () => {
    const { frames, phases } = await realSwingWithPhases();
    const contact = phases.find((phase) => phase.key === "contact")!;
    const result = await new PoseGeometryFeatureExtractor({ aspectRatio: 1 }).extractMeasurements({
      ...COMMON,
      poseFrames: frames,
      phases: mutatePhase(phases, "contact", {
        startMs: contact.representativeMs,
        endMs: contact.representativeMs,
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeGreaterThanOrEqual(10);
    expect(nonFiniteMeasurements(result.value)).toEqual([]);
  });

  it("duplicate phase keys: the LAST span of a key silently wins (no typed failure) — pinned as observed", async () => {
    const { frames, phases } = await realSwingWithPhases();
    const recover = phases.find((phase) => phase.key === "recover")!;
    const duplicated: PhaseSpan[] = [
      ...phases,
      { ...recover, endMs: recover.endMs + 5000 }, // second 'recover' span
    ];
    const extractor = new PoseGeometryFeatureExtractor({ aspectRatio: 1 });
    const result = await extractor.extractMeasurements({
      ...COMMON,
      poseFrames: frames,
      phases: duplicated,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const recovery = result.value.find((entry) => entry.metricKey === "recovery_time_ms")!;
    const baseline = await extractor.extractMeasurements({ ...COMMON, poseFrames: frames, phases });
    if (!baseline.ok) return;
    const baselineRecovery = baseline.value.find((e) => e.metricKey === "recovery_time_ms")!;
    expect(recovery.value).toBe(baselineRecovery.value + 5000);
  });

  it("phases with NaN bounds never leak NaN into a Measurement.value", async () => {
    const { frames, phases } = await realSwingWithPhases();
    const poisoned = phases.map((phase) => ({
      ...phase,
      startMs: Number.NaN,
      endMs: Number.NaN,
      representativeMs: Number.NaN,
    }));
    const result = await new PoseGeometryFeatureExtractor({ aspectRatio: 1 }).extractMeasurements({
      ...COMMON,
      poseFrames: frames,
      phases: poisoned,
    });
    if (result.ok) {
      expect(nonFiniteMeasurements(result.value)).toEqual([]);
    } else {
      expect(result.failure.kind).toBe("low_confidence");
    }
  });
});

describe("S2 torso-length gate: exactly 1e-4 / 9e-5 / 0", () => {
  const timestamps = timestampsEvery(20, 101); // 0..2000ms, 50 fps

  function extract(torsoLength: number) {
    return new PoseGeometryFeatureExtractor({ aspectRatio: 1 }).extractMeasurements({
      ...COMMON,
      poseFrames: exactTorsoFrames({ torsoLength, timestamps }),
      phases: handBuiltPhases(),
    });
  }

  it("precondition: the fixture's shoulder→hip distance is bit-exactly the requested torso length", () => {
    for (const torso of [1e-4, 9e-5, 0, 0.2]) {
      const frame = exactTorsoFrames({ torsoLength: torso, timestamps: [0] })[0]!;
      const at = (name: string) => frame.landmarks.find((mark) => mark.name === name)!;
      const shoulderMid = {
        x: (at("left_shoulder").x + at("right_shoulder").x) / 2,
        y: (at("left_shoulder").y + at("right_shoulder").y) / 2,
      };
      const hipMid = {
        x: (at("left_hip").x + at("right_hip").x) / 2,
        y: (at("left_hip").y + at("right_hip").y) / 2,
      };
      expect(Math.hypot(shoulderMid.x - hipMid.x, shoulderMid.y - hipMid.y)).toBe(torso);
    }
  });

  it("torso exactly 1e-4 passes the gate (>= 1e-4) and yields finite measurements", async () => {
    const result = await extract(1e-4);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeGreaterThan(0);
    expect(nonFiniteMeasurements(result.value)).toEqual([]);
  });

  it("torso exactly 9e-5 → typed features.torso_not_measured, no measurements", async () => {
    const result = await extract(9e-5);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("low_confidence");
    expect(result.failure.code).toBe("features.torso_not_measured");
  });

  it("torso exactly 0 → typed features.torso_not_measured, no measurements", async () => {
    const result = await extract(0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("features.torso_not_measured");
  });

  it("the gate is a hard step: 1e-4 - 1ulp fails, 1e-4 passes (no epsilon slop)", async () => {
    const belowByOneUlp = 1e-4 - Number.EPSILON * 1e-4;
    expect(belowByOneUlp).toBeLessThan(1e-4);
    const below = await extract(belowByOneUlp);
    expect(below.ok).toBe(false);
    const exact = await extract(1e-4);
    expect(exact.ok).toBe(true);
  });

  it("NaN torso (hip landmarks NaN) is not silently accepted as measurable — no NaN value survives", async () => {
    const frames = exactTorsoFrames({ torsoLength: 0.2, timestamps }).map((frame) => ({
      ...frame,
      landmarks: frame.landmarks.map((mark) =>
        mark.name.endsWith("hip") ? { ...mark, y: Number.NaN } : mark,
      ),
    }));
    const result = await new PoseGeometryFeatureExtractor({ aspectRatio: 1 }).extractMeasurements({
      ...COMMON,
      poseFrames: frames,
      phases: handBuiltPhases(),
    });
    if (result.ok) expect(nonFiniteMeasurements(result.value)).toEqual([]);
    else expect(result.failure.kind).toBe("low_confidence");
  });

  it("observed: a 1e-4 torso (1/10000 of the image) still emits source:'real' body-relative metrics of hundreds of torso-lengths (P3 — gate 800× below QUALITY_THRESHOLDS.minTorsoLengthNorm)", async () => {
    const result = await extract(1e-4);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byKey = new Map(result.value.map((entry) => [entry.metricKey, entry]));
    expect(byKey.get("backswing_length_norm")!.value).toBeGreaterThan(500);
    expect(byKey.get("follow_through_length_norm")!.value).toBeGreaterThan(500);
    expect(byKey.get("contact_forward_of_hip_norm")!.value).toBeGreaterThan(100);
    expect(byKey.get("paddle_set_forward_norm")!.value).toBeLessThan(-100);
    expect(result.value.every((entry) => entry.source === "real")).toBe(true);
    expect(result.value.length).toBe(15);
  });
});

describe("S5 aspect fallback parity: GeometryBiomechanicsExtractor(video.height 0) ≡ PoseGeometryFeatureExtractor({aspectRatio:1})", () => {
  async function pair(video: { width: number; height: number }) {
    const { sequence, window } = generateSwingSequence();
    const legacy = legacyFramesOf(sequence);
    const phases = await new GeometricPhaseSegmenter({ aspectRatio: 1 }).segmentPhases(legacy, [], {
      startMs: window.startMs,
      endMs: window.endMs,
      contactMs: window.peakMs,
      shotTypeHypothesis: "forehand_drive",
      confidence: 0.88,
    });
    if (!phases.ok) throw new Error(phases.failure.code);
    const degenerate = { ...sequence, video: { ...sequence.video, ...video } };
    const viaBiomech = await new GeometryBiomechanicsExtractor().extract({
      pose: degenerate,
      paddle: null,
      phases: phases.value,
      shotType: "forehand_drive",
      handedness: "right",
      cameraView: "side",
    });
    const direct = await new PoseGeometryFeatureExtractor({ aspectRatio: 1 }).extractMeasurements({
      ...COMMON,
      poseFrames: legacy,
      phases: phases.value,
    });
    return { viaBiomech, direct };
  }

  it("video.height 0 (width 1080): byte-identical JSON to the aspect-1 extractor, ≥ 10 measurements", async () => {
    const { viaBiomech, direct } = await pair({ width: 1080, height: 0 });
    expect(viaBiomech.ok).toBe(true);
    expect(JSON.stringify(viaBiomech)).toBe(JSON.stringify(direct));
    if (viaBiomech.ok) expect(viaBiomech.value.length).toBeGreaterThanOrEqual(10);
  });

  it("video.height -1080 and NaN also fall back to aspect 1 (byte-identical)", async () => {
    for (const height of [-1080, Number.NaN]) {
      const { viaBiomech, direct } = await pair({ width: 1080, height });
      expect(JSON.stringify(viaBiomech), `height ${String(height)}`).toBe(JSON.stringify(direct));
    }
  });

  it("control: a square video (1080x1080) is also byte-identical to aspect 1", async () => {
    const { viaBiomech, direct } = await pair({ width: 1080, height: 1080 });
    expect(JSON.stringify(viaBiomech)).toBe(JSON.stringify(direct));
  });

  it("rapid repeats: 25 extractions over height-0 input are byte-identical (stateless)", async () => {
    const first = JSON.stringify((await pair({ width: 1080, height: 0 })).viaBiomech);
    const all = await Promise.all(
      Array.from({ length: 25 }, () => pair({ width: 1080, height: 0 })),
    );
    expect(all.every((entry) => JSON.stringify(entry.viaBiomech) === first)).toBe(true);
  });

  it.fails(
    "video.width 0 (height 1080) should fall back to aspect 1 like height 0 does (or fail typed) — not aspect 0",
    async () => {
      const { viaBiomech, direct } = await pair({ width: 0, height: 1080 });
      if (!viaBiomech.ok) return; // a typed failure would also satisfy the contract
      expect(JSON.stringify(viaBiomech)).toBe(JSON.stringify(direct));
    },
  );

  it("observed: width 0 → aspect 0 collapses x; stance_width_ratio is dropped and forward metrics read 0 while the fallback path reads non-zero (evidence for the P2 above)", async () => {
    const { viaBiomech, direct } = await pair({ width: 0, height: 1080 });
    expect(viaBiomech.ok && direct.ok).toBe(true);
    if (!viaBiomech.ok || !direct.ok) return;
    const metric = (measurements: Measurement[], key: string) =>
      measurements.find((entry) => entry.metricKey === key);
    expect(metric(direct.value, "stance_width_ratio")).toBeDefined();
    expect(metric(viaBiomech.value, "contact_forward_of_hip_norm")?.value).toBe(0);
    expect(metric(direct.value, "contact_forward_of_hip_norm")!.value).not.toBe(0);
    expect(viaBiomech.value.every((entry) => entry.source === "real")).toBe(true);
  });

  it.fails(
    "video.width NaN (height 1080) should fall back to aspect 1 (or fail typed) — not propagate NaN geometry",
    async () => {
      const { viaBiomech, direct } = await pair({ width: Number.NaN, height: 1080 });
      if (!viaBiomech.ok) return;
      expect(JSON.stringify(viaBiomech)).toBe(JSON.stringify(direct));
    },
  );

  it("observed: width NaN → ok() with 3 metrics; hip_shoulder_lag_ms is 0 computed from NaN angles yet marked 'real'; no NaN reaches Measurement.value (filter holds, gate does not)", async () => {
    const { viaBiomech, direct } = await pair({ width: Number.NaN, height: 1080 });
    expect(viaBiomech.ok && direct.ok).toBe(true);
    if (!viaBiomech.ok || !direct.ok) return;
    expect(nonFiniteMeasurements(viaBiomech.value)).toEqual([]);
    expect(viaBiomech.value.map((entry) => entry.metricKey)).toEqual([
      "hip_shoulder_lag_ms",
      "contact_height_ratio",
      "recovery_time_ms",
    ]);
    const lag = viaBiomech.value.find((entry) => entry.metricKey === "hip_shoulder_lag_ms")!;
    expect(lag.value).toBe(0);
    expect(lag.source).toBe("real");
    expect(direct.value.length).toBeGreaterThanOrEqual(10);
  });
});
