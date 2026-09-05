import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PHASES, type ShotAnalysis, type VersionVector } from "@pickle/shared-types";
import {
  serializePoseSequence,
  type CanonicalPoseFrame,
  type PoseSequence,
} from "@pickle/swing-domain";
import {
  compareFormPair,
  FORM_COMPARISON_ACCEPTANCE as C,
  FORM_COMPARISON_EVALUATION_SCHEMA as E,
  type FormComparisonFiles,
  type FormComparisonInput,
  type FormComparisonOutcome,
  type FormComparisonPairMetadata,
  type FormComparisonRecordingMetadata,
  type FormComparisonResult,
  type ImagePoint,
} from "../src/formComparison.js";
import { runFormCompareCli } from "../src/cli/formCompare.js";

type Side = "before" | "after";
interface Fixture {
  analysis: ShotAnalysis;
  sequence: PoseSequence;
  metadata: FormComparisonRecordingMetadata;
}
type Pair = Record<Side, Fixture>;
const SIDES = ["before", "after"] as const;
const ENABLED = { enableOfflineExperiment: true };
const digest = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

function fixture(side: Side, offsetMs = 0, durationScale = 1): Fixture {
  const versionVector: VersionVector = {
    appVersion: "synthetic-app-1",
    modelBundleVersion: "synthetic-bundle-1",
    poseModelVersion: "synthetic-pose-1",
    paddleModelVersion: "synthetic-unavailable-1",
    strokeDetectorVersion: "synthetic-stroke-1",
    phaseModelVersion: "synthetic-phases-1",
    scoringModelVersion: "synthetic-unused-1",
    shotConfigVersion: "synthetic-config-1",
  };
  const startMs = 1000 + offsetMs;
  const phaseMs = 400 * durationScale;
  const sequence: PoseSequence = {
    schemaVersion: 1,
    format: "pickle.pose-sequence.v1",
    coordinateSystem: "normalized_image_top_left",
    producedBy: {
      providerId: "pose.synthetic-form-software-test",
      modelVersion: versionVector.poseModelVersion,
      runtime: "deterministic",
      executionTarget: "on_device",
      artifactHash: null,
    },
    video: { width: 1280, height: 720, fps: 25 },
    frames: Array.from({ length: 61 }, (_, index) => ({
      frameIndex: 100 + index,
      timestampMs: startMs + index * 40 * durationScale,
      confidence: 0.99,
      landmarks: [
        { name: "left_shoulder", x: 0.42, y: 0.3 },
        { name: "right_shoulder", x: 0.52, y: 0.3 },
        { name: "left_hip", x: 0.44, y: 0.55 },
        { name: "right_hip", x: 0.5, y: 0.55 },
        { name: "left_elbow", x: 0.38, y: 0.4 },
        { name: "left_wrist", x: 0.36, y: 0.49 },
        { name: "right_elbow", x: 0.58, y: 0.4 },
        {
          name: "right_wrist",
          x: 0.63 + 0.008 * Math.sin((index * Math.PI) / 30),
          y: 0.48 + 0.012 * Math.cos((index * Math.PI) / 30),
        },
      ].map((point) => ({ ...point, visibility: 0.99 })),
    })),
  };
  const analysis: ShotAnalysis = {
    id: `synthetic-${side}`,
    sessionId: "synthetic-session",
    shotType: "forehand_drive",
    cameraView: "side",
    handedness: "right",
    capturedAtIso: "2026-01-01T00:00:00.000Z",
    timestamps: { startMs, contactMs: startMs + 3.5 * phaseMs, endMs: startMs + 6 * phaseMs },
    phases: PHASES.map((key, index) => ({
      key,
      startMs: startMs + index * phaseMs,
      representativeMs: startMs + (index + 0.5) * phaseMs,
      endMs: startMs + (index + 1) * phaseMs,
      confidence: 0.99,
    })),
    measurements: [],
    checkpoints: [],
    overallScore: null,
    analysisConfidence: 0.99,
    resultKind: "low_confidence",
    guidance: null,
    priorityFix: null,
    versionVector,
    source: "fixture",
  };
  const metadata: FormComparisonRecordingMetadata = {
    analysisId: analysis.id,
    analysisSha256: "",
    poseSha256: "",
    playerId: "synthetic-player",
    sessionId: "synthetic-session",
    cameraView: "side",
    captureMode: "imported_video",
    handedness: "right",
    technique: "forehand_drive",
    versionVector: { ...versionVector },
    poseModel: { ...sequence.producedBy },
    review: {
      basis: "synthetic_fixture",
      evidenceId: `synthetic-review-${side}`,
      reviewerId: "synthetic-generator-not-a-human-reviewer",
      clipSha256: digest(`synthetic-clip-placeholder-${side}-no-video`),
      timebase: "original_clip_ms",
      cameraSetupId: "synthetic-fixed-camera",
      scenePointIds: ["synthetic-a", "synthetic-b", "synthetic-c"],
      rotationDegrees: 0,
      mirrored: false,
      frames: sequence.frames.map((frame) => ({
        frameIndex: frame.frameIndex,
        timestampMs: frame.timestampMs,
        playerId: "synthetic-player",
        trackId: `synthetic-track-${side}`,
        personCount: 1,
        identityAmbiguous: false,
        trackSwitch: false,
        cameraView: "side",
        cameraStable: true,
        occludedJoints: [],
        targetBox: { x: 0.2, y: 0.1, width: 0.6, height: 0.7 },
        scenePoints: [
          { x: 0.1, y: 0.1 },
          { x: 0.9, y: 0.1 },
          { x: 0.1, y: 0.9 },
        ],
      })),
    },
  };
  return { analysis, sequence, metadata };
}

function pair(): Pair {
  return { before: fixture("before"), after: fixture("after") };
}

function seal(member: Fixture): FormComparisonFiles {
  const analysisBytes = Buffer.from(JSON.stringify(member.analysis));
  const poseBytes = Buffer.from(serializePoseSequence(member.sequence));
  member.metadata.analysisSha256 = digest(analysisBytes);
  member.metadata.poseSha256 = digest(poseBytes);
  return { analysisBytes, poseBytes };
}

function inputFor(p: Pair): FormComparisonInput {
  return {
    before: seal(p.before),
    after: seal(p.after),
    metadata: {
      schemaVersion: 1,
      before: p.before.metadata,
      after: p.after.metadata,
    } satisfies FormComparisonPairMetadata,
  };
}

function run(p: Pair): FormComparisonResult {
  return compareFormPair(inputFor(p), ENABLED);
}

function keepFrames(member: Fixture, keep: (frame: CanonicalPoseFrame) => boolean): void {
  member.sequence.frames = member.sequence.frames.filter(keep);
  const ids = new Set(member.sequence.frames.map((frame) => frame.frameIndex));
  member.metadata.review.frames = member.metadata.review.frames.filter((frame) =>
    ids.has(frame.frameIndex),
  );
}

function transform(member: Fixture, fn: (point: ImagePoint) => ImagePoint): void {
  for (const frame of member.sequence.frames) {
    for (const point of frame.landmarks) Object.assign(point, fn(point));
  }
}

function reason(result: FormComparisonResult, outcome: FormComparisonOutcome, code: string): void {
  expect(result.outcome, JSON.stringify(result.reasons)).toBe(outcome);
  expect(result.reasons.map((entry) => entry.code)).toContain(code);
}

function originalObservations(result: FormComparisonResult, p: Pair): void {
  expect(result.phases).toHaveLength(PHASES.length);
  for (const side of SIDES)
    expect(result.strokeTiming?.[side]).toMatchObject(p[side].analysis.timestamps);
  for (const phase of result.phases) {
    for (const side of SIDES) {
      const span = p[side].analysis.phases.find((entry) => entry.key === phase.phase)!;
      const frames = p[side].sequence.frames.filter(
        (frame) => frame.timestampMs >= span.startMs && frame.timestampMs <= span.endMs,
      );
      const observations = side === "before" ? phase.beforeTrajectory : phase.afterTrajectory;
      expect(
        observations.map(({ frameIndex, timestampMs }) => ({ frameIndex, timestampMs })),
      ).toEqual(frames.map(({ frameIndex, timestampMs }) => ({ frameIndex, timestampMs })));
      expect(phase.timing[side]).toMatchObject({ ...span, durationMs: span.endMs - span.startMs });
      for (const match of phase.matches) expect(observations).toContainEqual(match[side]);
    }
  }
}

describe("offline paired form experiment: synthetic software invariants only", () => {
  it("exports fixed acceptance criteria with missing real labels and repeatability, not a release claim", async () => {
    expect(await runFormCompareCli(["--criteria"])).toEqual({ acceptance: C, evaluationSchema: E });
    expect(Object.isFrozen(C)).toBe(true);
    expect(Object.isFrozen(C.changeFloors)).toBe(true);
    expect(C).toMatchObject({
      enabledByDefault: false,
      applicationReachable: false,
      maxGapMs: 120,
      maxAnchorDistanceMs: 120,
    });
    expect(E).toMatchObject({
      artifactKind: "evaluation_requirements_not_execution_results",
      realPairCount: 0,
      coachReviewedPairCount: 0,
      realDataValidation: "missing",
      coachValidation: "missing",
      independentPairLabels: "missing",
      sameConditionRepeatabilityDataset: "missing",
      measurementUncertaintyCalibration: "missing",
      lockedHoldoutInspected: false,
      releaseAuthorized: false,
    });
    expect(E.allowedPartitions).toEqual(["synthetic_software_invariants"]);
    expect(E.passRule).toContain("contains no execution results");
    expect(E.passRule).toContain("does not validate measurements");
    expect(readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")).not.toMatch(
      /formComparison|formCompare/,
    );
  });

  it("does not touch inputs unless explicitly enabled", async () => {
    const input = {
      get metadata(): unknown {
        throw new Error("must not access");
      },
    } as FormComparisonInput;
    reason(compareFormPair(input), "insufficient_evidence", "experiment_disabled");
    reason(
      (await runFormCompareCli([
        "--metadata",
        "https://invalid.example/review.json",
      ])) as FormComparisonResult,
      "insufficient_evidence",
      "experiment_disabled",
    );
  });

  it("identity is deterministic, preserves every timestamp/index, and does not mutate input", () => {
    const p = pair();
    const input = inputFor(p);
    const snapshot = JSON.stringify(input);
    const result = compareFormPair(input, ENABLED);
    expect(result.outcome).toBe("no_reliable_change");
    expect(compareFormPair(input, ENABLED)).toEqual(result);
    expect(JSON.stringify(input)).toBe(snapshot);
    originalObservations(result, p);
    expect(
      result.phases.every(
        (phase) => phase.matches.length === 5 && phase.observedDelta?.wristRmsTorsoLengths === 0,
      ),
    ).toBe(true);
    expect(result.provenance?.before.reviewBasis).toBe("synthetic_fixture");
    expect(result.strokeTiming?.durationDeltaMs).toBe(0);
    expect(result.evidenceBoundary.validation).toContain("repeatability data");
    expect(result.evidenceBoundary.validation).toContain("not measurement validation");
    expect(result.evidenceBoundary.metadata).toContain(
      "Only poseModelVersion is carried in the pose bytes",
    );
    expect(result.evidenceBoundary.interpretation).toContain("unequal nearest-sample timing");
  });

  it("retains nullable stored contact timestamps without using them as verified event alignment", () => {
    const p = pair();
    p.before.analysis.timestamps.contactMs = null;
    p.after.analysis.timestamps.contactMs = 1137;
    const result = run(p);
    expect(result.outcome).toBe("no_reliable_change");
    originalObservations(result, p);
    expect(result.strokeTiming?.before).toHaveProperty("contactMs", null);
    expect(result.strokeTiming?.after).toHaveProperty("contactMs", 1137);
  });

  it("has an analytic 2D geometry baseline, not a score or an invented measurement", () => {
    const p = pair();
    for (const side of SIDES)
      for (const frame of p[side].sequence.frames) {
        Object.assign(
          frame.landmarks.find((point) => point.name === "right_elbow")!,
          { x: 0.62, y: 0.3 },
        );
        Object.assign(
          frame.landmarks.find((point) => point.name === "right_wrist")!,
          { x: 0.62, y: 0.4 },
        );
      }
    const result = run(p);
    expect(result.outcome).toBe("no_reliable_change");
    const observation = result.phases[0]!.matches[0]!.before;
    expect(observation.elbowAngleDeg).toBeCloseTo(90, 10);
    expect(observation.torsoImageHeights).toBeCloseTo(0.25, 10);
    expect(observation.wristTorso.x).toBeCloseTo(((0.62 - 0.47) * (1280 / 720)) / 0.25, 10);
    expect(observation.wristTorso.y).toBeCloseTo(-0.6, 10);
    expect(result).not.toHaveProperty("overallScore");
    expect(result).not.toHaveProperty("improvement");
  });

  it("body translation/uniform scale with a fixed synthetic scene does not force a change", () => {
    const p = pair();
    transform(p.after, ({ x, y }) => ({
      x: 0.5 + (x - 0.5) * 0.85 + 0.03,
      y: 0.5 + (y - 0.5) * 0.85 - 0.02,
    }));
    const result = run(p);
    expect(result.outcome).toBe("no_reliable_change");
    for (const phase of result.phases)
      expect(phase.observedDelta?.wristRmsTorsoLengths).toBeLessThan(1e-12);
  });

  it("different clip offsets are not timing changes, and nearest ties keep the earlier observed frame", () => {
    const p = { before: fixture("before"), after: fixture("after", 5000) };
    const result = run(p);
    expect(result.outcome).toBe("no_reliable_change");
    originalObservations(result, p);
    const match = result.phases[0]!.matches[1]!;
    expect(match.beforeTargetMs).toBe(1100);
    expect(match.before.timestampMs).toBe(1080);
    expect(match.afterTargetMs).toBe(6100);
    expect(match.after.timestampMs).toBe(6080);
    for (const phase of result.phases) {
      expect(phase.timing.durationDeltaMs).toBe(0);
      expect(phase.timing.representativeFromStrokeDeltaMs).toBe(0);
    }
  });

  it("preserves real phase/stroke durations when identical trajectories take twice as long", () => {
    const p = { before: fixture("before"), after: fixture("after", 5000, 2) };
    const result = run(p);
    expect(result.outcome).toBe("observed_change");
    originalObservations(result, p);
    expect(result.strokeTiming).toMatchObject({
      before: { startMs: 1000, endMs: 3400, durationMs: 2400 },
      after: { startMs: 6000, endMs: 10800, durationMs: 4800 },
      durationDeltaMs: 2400,
      exceedsEngineeringFloor: true,
    });
    for (const phase of result.phases) {
      expect(phase.timing.durationDeltaMs).toBe(400);
      expect(phase.observedDelta?.wristRmsTorsoLengths).toBe(0);
      expect(phase.observedDelta?.exceedsEngineeringFloor).toContain("stored_phase_duration");
    }
  });

  it("does not hide a stroke-duration delta just because each phase delta is below its floor", () => {
    const p = { before: fixture("before"), after: fixture("after", 0, 1.02) };
    p.after.analysis.phases[5]!.representativeMs -= 4;
    const result = run(p);
    expect(result.phases.every((phase) => phase.outcome === "no_reliable_change")).toBe(true);
    expect(result.strokeTiming?.durationDeltaMs).toBe(48);
    expect(result.outcome).toBe("observed_change");
  });

  it("reports signed observed wrist differences without calling either direction improvement", () => {
    const p = pair();
    for (const frame of p.after.sequence.frames)
      frame.landmarks.find((point) => point.name === "right_wrist")!.y -= 0.025;
    const result = run(p);
    const reverse = run({ before: p.after, after: p.before });
    expect(result.outcome).toBe("observed_change");
    expect(reverse.outcome).toBe("observed_change");
    expect(result.phases[0]!.matches[0]!.wristDeltaTorso.y).toBeCloseTo(-0.1, 10);
    expect(reverse.phases[0]!.matches[0]!.wristDeltaTorso.y).toBeCloseTo(0.1, 10);
    expect(result.evidenceBoundary.interpretation).toContain(
      "Observed change never means improvement",
    );
    expect(result.evidenceBoundary.interpretation).toContain(
      "wrist-speed peak is not actual ball contact",
    );
    for (const phase of result.phases)
      expect(phase.phaseMeaning).toBe(
        "stored_phase_label_only_not_verified_contact_or_event_truth",
      );
  });

  it("retains non-anchor observations without claiming whole-trajectory equivalence", () => {
    const p = pair();
    p.after.sequence.frames[1]!.landmarks.find((point) => point.name === "right_wrist")!.y -= 0.02;
    const result = run(p);
    expect(result.outcome).toBe("no_reliable_change");
    expect(result.phases[0]!.afterTrajectory[1]!.wristTorso.y).not.toBe(
      result.phases[0]!.beforeTrajectory[1]!.wristTorso.y,
    );
    expect(result.evidenceBoundary.interpretation).toContain("not whole-trajectory equivalence");
    originalObservations(result, p);
  });

  it("accepts independently declared left-handed identity without mirroring or choosing the busier wrist", () => {
    const p = pair();
    for (const side of SIDES) {
      p[side].analysis.handedness = "left";
      p[side].metadata.handedness = "left";
    }
    expect(run(p).outcome).toBe("no_reliable_change");
    p.after.sequence.frames[3]!.landmarks = p.after.sequence.frames[3]!.landmarks.filter(
      (point) => point.name !== "left_wrist",
    );
    reason(run(p), "insufficient_evidence", "required_joint_unobserved");
  });

  it("uses the existing 120 ms limit inclusively without filling missing samples", () => {
    const p = pair();
    keepFrames(p.after, (frame) => frame.frameIndex !== 103 && frame.frameIndex !== 104);
    const result = run(p);
    expect(result.outcome).toBe("no_reliable_change");
    originalObservations(result, p);
    expect(result.phases[0]!.afterTrajectory.map((frame) => frame.timestampMs)).not.toContain(1120);
    expect(result.phases[0]!.afterTrajectory.map((frame) => frame.timestampMs)).not.toContain(1160);
    p.after.sequence.frames[3]!.timestampMs += 1;
    p.after.metadata.review.frames[3]!.timestampMs += 1;
    reason(run(p), "insufficient_evidence", "pose_gap");
  });

  it("accepts an endpoint exactly 120 ms away but rejects 121 ms, never matching outside the phase", () => {
    const p = pair();
    keepFrames(p.after, (frame) => frame.frameIndex >= 103);
    const result = run(p);
    expect(result.outcome).toBe("no_reliable_change");
    expect(result.phases[0]!.matches[0]!.after.timestampMs).toBe(1120);
    p.after.sequence.frames[0]!.timestampMs += 1;
    p.after.metadata.review.frames[0]!.timestampMs += 1;
    reason(run(p), "not_comparable", "analysis_pose_timebase_mismatch");
  });

  it("abstains on native-style one-sample contact phases rather than inventing a trajectory", () => {
    const p = pair();
    p.after.analysis.phases[2]!.endMs = 2180;
    Object.assign(p.after.analysis.phases[3]!, {
      startMs: 2180,
      representativeMs: 2200,
      endMs: 2220,
    });
    p.after.analysis.phases[4]!.startMs = 2220;
    const result = run(p);
    reason(result, "insufficient_evidence", "phase_samples_insufficient");
    expect(result.phases[3]!.matches).toEqual([]);
    expect(result.phases[3]!.observedDelta).toBeNull();
    expect(result.phases[3]!.afterTrajectory).toHaveLength(1);
    originalObservations(result, p);
  });
});

interface RejectionCase {
  name: string;
  code: string;
  outcome: "insufficient_evidence" | "not_comparable";
  mutate: (p: Pair) => void;
}
const rejects: RejectionCase[] = [
  {
    name: "absent capture mode",
    code: "capture_mode_required",
    outcome: "insufficient_evidence",
    mutate: (p) => {
      Reflect.deleteProperty(p.after.metadata, "captureMode");
    },
  },
  {
    name: "capture mode mismatch",
    code: "capture_mode_mismatch",
    outcome: "not_comparable",
    mutate: (p) => {
      p.after.metadata.captureMode = "automatic_pose_trigger";
    },
  },
  {
    name: "different player",
    code: "player_mismatch",
    outcome: "not_comparable",
    mutate: (p) => {
      p.after.metadata.playerId = "another-synthetic-player";
    },
  },
  {
    name: "different session",
    code: "session_mismatch",
    outcome: "not_comparable",
    mutate: (p) => {
      p.after.analysis.sessionId = p.after.metadata.sessionId = "another-session";
    },
  },
  {
    name: "no session",
    code: "invalid_metadata",
    outcome: "not_comparable",
    mutate: (p) => {
      p.after.metadata.sessionId = "";
    },
  },
  {
    name: "stored view contradicts reviewed view",
    code: "view_mismatch",
    outcome: "not_comparable",
    mutate: (p) => {
      p.after.metadata.cameraView = "rear_oblique";
    },
  },
  {
    name: "different independently reviewed view",
    code: "view_mismatch",
    outcome: "not_comparable",
    mutate: (p) => {
      p.after.analysis.cameraView = p.after.metadata.cameraView = "rear_oblique";
    },
  },
  {
    name: "different camera setup",
    code: "view_mismatch",
    outcome: "not_comparable",
    mutate: (p) => {
      p.after.metadata.review.cameraSetupId = "another-setup";
    },
  },
  {
    name: "different hand",
    code: "handedness_mismatch",
    outcome: "not_comparable",
    mutate: (p) => {
      p.after.analysis.handedness = p.after.metadata.handedness = "left";
    },
  },
  {
    name: "ambidextrous cannot choose a wrist",
    code: "handedness_mismatch",
    outcome: "not_comparable",
    mutate: (p) => {
      p.after.analysis.handedness = "ambidextrous";
    },
  },
  {
    name: "different technique",
    code: "technique_mismatch",
    outcome: "not_comparable",
    mutate: (p) => {
      p.after.analysis.shotType = p.after.metadata.technique = "dink";
    },
  },
  {
    name: "wrong analysis id",
    code: "analysis_identity_mismatch",
    outcome: "not_comparable",
    mutate: (p) => {
      p.after.metadata.analysisId = "not-this-analysis";
    },
  },
  {
    name: "synthetic review relabeled real",
    code: "review_source_mismatch",
    outcome: "not_comparable",
    mutate: (p) => {
      p.after.analysis.source = "real";
    },
  },
  {
    name: "different evidence sources",
    code: "source_mismatch",
    outcome: "not_comparable",
    mutate: (p) => {
      p.after.analysis.source = "real";
      p.after.metadata.review.basis = "independent_frame_review";
    },
  },
  {
    name: "native sidecar without independent review",
    code: "independent_review_required",
    outcome: "insufficient_evidence",
    mutate: (p) => {
      Reflect.deleteProperty(p.after.metadata, "review");
    },
  },
  {
    name: "missing reviewer",
    code: "independent_review_required",
    outcome: "insufficient_evidence",
    mutate: (p) => {
      p.after.metadata.review.reviewerId = "";
    },
  },
  {
    name: "bad clip hash",
    code: "independent_review_required",
    outcome: "insufficient_evidence",
    mutate: (p) => {
      p.after.metadata.review.clipSha256 = "not-sha256";
    },
  },
  {
    name: "incomplete review coverage",
    code: "review_coverage_missing",
    outcome: "insufficient_evidence",
    mutate: (p) => {
      p.after.metadata.review.frames.pop();
    },
  },
  {
    name: "review timestamp rebased",
    code: "review_timebase_mismatch",
    outcome: "not_comparable",
    mutate: (p) => {
      p.after.metadata.review.frames[0]!.timestampMs += 1;
    },
  },
  {
    name: "person count ambiguous",
    code: "track_continuity_unverified",
    outcome: "insufficient_evidence",
    mutate: (p) => {
      p.after.metadata.review.frames[1]!.personCount = 2;
    },
  },
  {
    name: "track id absent",
    code: "track_continuity_unverified",
    outcome: "insufficient_evidence",
    mutate: (p) => {
      p.after.metadata.review.frames[1]!.trackId = "";
    },
  },
  {
    name: "per-frame identity contradicts player",
    code: "track_continuity_unverified",
    outcome: "insufficient_evidence",
    mutate: (p) => {
      p.after.metadata.review.frames[1]!.playerId = "different-player";
    },
  },
  {
    name: "reviewed identity ambiguity",
    code: "track_continuity_unverified",
    outcome: "insufficient_evidence",
    mutate: (p) => {
      p.after.metadata.review.frames[1]!.identityAmbiguous = true;
    },
  },
  {
    name: "reviewed track switch",
    code: "track_continuity_unverified",
    outcome: "insufficient_evidence",
    mutate: (p) => {
      p.after.metadata.review.frames[1]!.trackSwitch = true;
    },
  },
  {
    name: "changed track id",
    code: "track_switch",
    outcome: "not_comparable",
    mutate: (p) => {
      p.after.metadata.review.frames[1]!.trackId = "second-track";
    },
  },
  {
    name: "unknown per-frame view despite stored side",
    code: "camera_view_unverified",
    outcome: "insufficient_evidence",
    mutate: (p) => {
      p.after.metadata.review.frames[1]!.cameraView = "unknown";
    },
  },
  {
    name: "camera not stationary",
    code: "camera_view_unverified",
    outcome: "insufficient_evidence",
    mutate: (p) => {
      p.after.metadata.review.frames[1]!.cameraStable = false;
    },
  },
  {
    name: "required occluded wrist",
    code: "required_joint_occluded",
    outcome: "insufficient_evidence",
    mutate: (p) => {
      p.after.metadata.review.frames[1]!.occludedJoints = ["right_wrist"];
    },
  },
  {
    name: "unknown occlusion label",
    code: "occlusion_review_missing",
    outcome: "insufficient_evidence",
    mutate: (p) => {
      p.after.metadata.review.frames[1]!.occludedJoints = ["not-a-joint"];
    },
  },
  {
    name: "pose outside reviewed target",
    code: "target_pose_mismatch",
    outcome: "not_comparable",
    mutate: (p) => {
      p.after.metadata.review.frames[1]!.targetBox.width = 0.1;
    },
  },
  {
    name: "scene moves within clip",
    code: "camera_motion",
    outcome: "not_comparable",
    mutate: (p) => {
      p.after.metadata.review.frames[1]!.scenePoints[0].x += 0.05;
    },
  },
  {
    name: "scene differs across clips",
    code: "camera_reference_mismatch",
    outcome: "not_comparable",
    mutate: (p) => {
      for (const frame of p.after.metadata.review.frames) frame.scenePoints[0].x += 0.05;
    },
  },
  {
    name: "collinear scene references",
    code: "camera_reference_degenerate",
    outcome: "insufficient_evidence",
    mutate: (p) => {
      p.after.metadata.review.frames[0]!.scenePoints[2] = { x: 0.5, y: 0.1 };
    },
  },
  {
    name: "low pose confidence",
    code: "pose_confidence_low",
    outcome: "insufficient_evidence",
    mutate: (p) => {
      p.after.sequence.frames[1]!.confidence = 0.29;
    },
  },
  {
    name: "low visibility",
    code: "required_joint_unobserved",
    outcome: "insufficient_evidence",
    mutate: (p) => {
      p.after.sequence.frames[1]!.landmarks[0]!.visibility = 0.29;
    },
  },
  {
    name: "missing dominant wrist",
    code: "required_joint_unobserved",
    outcome: "insufficient_evidence",
    mutate: (p) => {
      p.after.sequence.frames[1]!.landmarks.pop();
    },
  },
  {
    name: "duplicate joint",
    code: "invalid_pose_geometry",
    outcome: "not_comparable",
    mutate: (p) => {
      p.after.sequence.frames[1]!.landmarks.push({ ...p.after.sequence.frames[1]!.landmarks[0]! });
    },
  },
  {
    name: "out-of-image joint",
    code: "invalid_pose_geometry",
    outcome: "not_comparable",
    mutate: (p) => {
      p.after.sequence.frames[1]!.landmarks[0]!.x = 1.1;
    },
  },
  {
    name: "duplicate frame index",
    code: "invalid_pose_timebase",
    outcome: "not_comparable",
    mutate: (p) => {
      p.after.sequence.frames[1]!.frameIndex = p.after.sequence.frames[0]!.frameIndex;
    },
  },
  {
    name: "duplicate timestamp",
    code: "invalid_pose_sequence",
    outcome: "not_comparable",
    mutate: (p) => {
      p.after.sequence.frames[1]!.timestampMs = p.after.sequence.frames[0]!.timestampMs;
    },
  },
  {
    name: "unsafe timestamp",
    code: "invalid_pose_timebase",
    outcome: "not_comparable",
    mutate: (p) => {
      p.after.sequence.frames.at(-1)!.timestampMs = Number.MAX_SAFE_INTEGER + 1;
    },
  },
  {
    name: "implausibly short sample interval",
    code: "invalid_pose_timebase",
    outcome: "not_comparable",
    mutate: (p) => {
      p.after.sequence.frames[1]!.timestampMs = p.after.sequence.frames[0]!.timestampMs + 0.04;
    },
  },
  {
    name: "unsupported coordinates",
    code: "unsupported_coordinates",
    outcome: "not_comparable",
    mutate: (p) => {
      p.after.sequence.coordinateSystem = "image_pixels";
    },
  },
  {
    name: "bad video dimension",
    code: "invalid_video_metadata",
    outcome: "not_comparable",
    mutate: (p) => {
      p.after.sequence.video.width = C.maxVideoDimension + 1;
    },
  },
  {
    name: "bad nominal FPS",
    code: "invalid_video_metadata",
    outcome: "not_comparable",
    mutate: (p) => {
      p.after.sequence.video.fps = C.maxFps + 1;
    },
  },
  {
    name: "aspect mismatch",
    code: "camera_reference_mismatch",
    outcome: "not_comparable",
    mutate: (p) => {
      p.after.sequence.video.width = 720;
    },
  },
  {
    name: "empty sequence",
    code: "pose_evidence_missing",
    outcome: "insufficient_evidence",
    mutate: (p) => {
      p.after.sequence.frames = [];
    },
  },
  {
    name: "phase absent",
    code: "phase_evidence_missing",
    outcome: "insufficient_evidence",
    mutate: (p) => {
      p.after.analysis.phases.pop();
    },
  },
  {
    name: "unlabeled phase gap",
    code: "phase_coverage_missing",
    outcome: "insufficient_evidence",
    mutate: (p) => {
      p.after.analysis.phases[1]!.startMs += 10;
    },
  },
  {
    name: "uncovered stroke endpoint",
    code: "phase_coverage_missing",
    outcome: "insufficient_evidence",
    mutate: (p) => {
      p.after.analysis.timestamps.endMs += 1;
    },
  },
  {
    name: "overlapping phases",
    code: "invalid_phase_timebase",
    outcome: "not_comparable",
    mutate: (p) => {
      p.after.analysis.phases[1]!.startMs -= 1;
    },
  },
  {
    name: "representative outside phase",
    code: "invalid_phase_timebase",
    outcome: "not_comparable",
    mutate: (p) => {
      p.after.analysis.phases[1]!.representativeMs = 0;
    },
  },
  {
    name: "low phase confidence",
    code: "phase_confidence_low",
    outcome: "insufficient_evidence",
    mutate: (p) => {
      p.after.analysis.phases[3]!.confidence = 0.29;
    },
  },
  {
    name: "unbounded stroke window",
    code: "invalid_timebase",
    outcome: "not_comparable",
    mutate: (p) => {
      p.after.analysis.timestamps.endMs =
        p.after.analysis.timestamps.startMs + C.maxStrokeDurationMs + 1;
    },
  },
];

describe("explicit abstention gates, not validated movement judgments", () => {
  it.each(rejects)("rejects $name", ({ mutate, outcome, code }) => {
    const p = pair();
    mutate(p);
    reason(run(p), outcome, code);
  });

  it.each(Object.keys(fixture("before").analysis.versionVector) as Array<keyof VersionVector>)(
    "rejects version mismatch in %s",
    (key) => {
      const p = pair();
      p.after.analysis.versionVector[key] = p.after.metadata.versionVector[key] =
        "different-version";
      if (key === "poseModelVersion")
        p.after.sequence.producedBy.modelVersion = p.after.metadata.poseModel.modelVersion =
          "different-version";
      reason(run(p), "not_comparable", "version_mismatch");
    },
  );

  it.each(["providerId", "runtime", "executionTarget", "artifactHash"] as const)(
    "rejects different original pose producer %s",
    (key) => {
      const p = pair();
      Object.assign(p.after.metadata.poseModel, {
        [key]: {
          providerId: "another-provider",
          runtime: "mediapipe",
          executionTarget: "server",
          artifactHash: digest("another-model"),
        }[key],
      });
      reason(run(p), "not_comparable", "version_mismatch");
    },
  );

  it.each([90, 180, 270] as const)(
    "rejects reviewed rotation %i instead of compensating",
    (rotation) => {
      const p = pair();
      p.after.metadata.review.rotationDegrees = rotation;
      reason(run(p), "not_comparable", "orientation_mismatch");
    },
  );

  it("rejects reviewed mirrors and observed mirrors even when metadata falsely denies them", () => {
    const p = pair();
    p.after.metadata.review.mirrored = true;
    reason(run(p), "not_comparable", "orientation_mismatch");
    p.after.metadata.review.mirrored = false;
    transform(p.after, ({ x, y }) => ({ x: 1 - x, y }));
    reason(run(p), "not_comparable", "projection_mismatch");
  });

  it.each([20, 90])(
    "rejects an observed %i degree rotation even with upright metadata",
    (degrees) => {
      const p = pair();
      const angle = (degrees * Math.PI) / 180;
      const aspect = 1280 / 720;
      transform(p.after, ({ x, y }) => ({
        x: 0.5 + ((x - 0.5) * aspect * Math.cos(angle) - (y - 0.5) * Math.sin(angle)) / aspect,
        y: 0.5 + (x - 0.5) * aspect * Math.sin(angle) + (y - 0.5) * Math.cos(angle),
      }));
      reason(
        run(p),
        "not_comparable",
        degrees === 90 ? "orientation_or_projection_mismatch" : "projection_mismatch",
      );
    },
  );

  it("rejects collapsed body scale and transient bone outliers without silently dropping frames", () => {
    const p = pair();
    for (const point of p.after.sequence.frames[1]!.landmarks)
      if (point.name.endsWith("_hip")) point.y = 0.3;
    reason(run(p), "insufficient_evidence", "degenerate_body_scale");
    const q = pair();
    const wrist = q.after.sequence.frames[1]!.landmarks.find(
      (point) => point.name === "right_wrist",
    )!;
    wrist.x = 0.58 + (wrist.x - 0.58) * 1.65;
    wrist.y = 0.4 + (wrist.y - 0.4) * 1.65;
    reason(run(q), "insufficient_evidence", "geometry_outlier");
  });

  it("rejects abrupt identity-like body jumps and shoulder-side switches despite clean review flags", () => {
    const p = pair();
    for (const point of p.after.sequence.frames[1]!.landmarks) point.x += 0.1;
    reason(run(p), "insufficient_evidence", "geometry_discontinuity");
    const q = pair();
    const joints = q.after.sequence.frames[1]!.landmarks;
    joints[0]!.x = 0.52;
    joints[1]!.x = 0.42;
    reason(run(q), "not_comparable", "projection_switch");
  });

  it("rejects missing, malformed and extra metadata rather than deriving it from cameraView", () => {
    for (const metadata of [null, {}, [], { schemaVersion: 2 }]) {
      reason(
        compareFormPair({ ...inputFor(pair()), metadata }, ENABLED),
        "insufficient_evidence",
        "independent_metadata_required",
      );
    }
    const p = pair();
    Object.assign(p.after.metadata.versionVector, { futureVersion: "unknown" });
    reason(run(p), "not_comparable", "invalid_metadata");
    expect(run(pair()).evidenceBoundary.metadata).toContain(
      "hardcoded to side, not measured view evidence",
    );
  });

  it("verifies exact bytes and before/after binding before parsing", () => {
    const input = inputFor(pair());
    input.after.poseBytes = Buffer.concat([input.after.poseBytes, Buffer.from(" ")]);
    reason(compareFormPair(input, ENABLED), "not_comparable", "artifact_hash_mismatch");
    const q = inputFor(pair());
    [q.before, q.after] = [q.after, q.before];
    reason(compareFormPair(q, ENABLED), "not_comparable", "artifact_hash_mismatch");
  });

  it.each(["analysis", "pose"] as const)(
    "rejects corrupt %s JSON even when its hash matches",
    (kind) => {
      const p = pair();
      const input = inputFor(p);
      input.after[`${kind}Bytes`] = Buffer.from("{");
      p.after.metadata[`${kind}Sha256`] = digest(input.after[`${kind}Bytes`]);
      reason(
        compareFormPair(input, ENABLED),
        "not_comparable",
        kind === "analysis" ? "invalid_analysis" : "invalid_pose_sequence",
      );
    },
  );

  it("uses the existing parser's wire/model version gates and never repairs them", () => {
    const p = pair();
    p.after.sequence.producedBy.modelVersion = "unexpected-model";
    reason(run(p), "not_comparable", "pose_model_mismatch");
    const input = inputFor(pair());
    const bytes = Buffer.from(
      JSON.stringify({
        ...(JSON.parse(Buffer.from(input.after.poseBytes).toString("utf8")) as object),
        schemaVersion: 2,
      }),
    );
    input.after.poseBytes = bytes;
    (input.metadata as FormComparisonPairMetadata).after.poseSha256 = digest(bytes);
    reason(compareFormPair(input, ENABLED), "not_comparable", "invalid_pose_sequence");
  });

  it("rejects oversized input and frame counts without inventing partial results", () => {
    const input = inputFor(pair());
    input.after.poseBytes = Buffer.alloc(C.maxInputFileBytes + 1);
    reason(compareFormPair(input, ENABLED), "not_comparable", "input_size_or_type");
    const p = pair();
    const first = p.after.sequence.frames[0]!;
    p.after.sequence.frames = Array.from({ length: C.maxFrames + 1 }, (_, index) => ({
      ...first,
      frameIndex: index,
      timestampMs: index * 40,
    }));
    reason(run(p), "insufficient_evidence", "pose_evidence_missing");
  });
});

const tempDirs: string[] = [];
afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function localFixture(): { args: string[]; directory: string; metadataPath: string } {
  const directory = mkdtempSync(join(tmpdir(), "form-comparison-synthetic-"));
  tempDirs.push(directory);
  const input = inputFor(pair());
  const args = ["--enable-offline"];
  for (const side of SIDES)
    for (const kind of ["analysis", "pose"] as const) {
      const path = join(directory, `${side}.${kind}.json`);
      writeFileSync(path, input[side][`${kind}Bytes`]);
      args.push(`--${side}-${kind}`, path);
    }
  const metadataPath = join(directory, "pair-review.json");
  writeFileSync(metadataPath, JSON.stringify(input.metadata));
  args.push("--metadata", metadataPath);
  return { args, directory, metadataPath };
}

function cli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli/formCompare.ts", ...args], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    timeout: 10000,
  });
}

describe("local-file JSON CLI, no videos, uploads or network", () => {
  it("documents the existing workspace tsx entrypoint without requiring a package script", async () => {
    const command = "pnpm --filter @pickle/swing-lab exec tsx src/cli/formCompare.ts";
    expect(await runFormCompareCli(["--help"])).toMatchObject({
      workingDirectory: "repository root",
      usage: expect.stringContaining(`${command} --enable-offline`),
      criteriaCommand: `${command} --criteria`,
      output: expect.stringContaining("pnpm may add runner diagnostics"),
      validation: expect.stringContaining("not measurement validation"),
    });
  });

  it("runs the documented pnpm workspace entrypoint on a synthetic pair", () => {
    const files = localFixture();
    const process = spawnSync(
      "pnpm",
      ["--filter", "@pickle/swing-lab", "exec", "tsx", "src/cli/formCompare.ts", ...files.args],
      {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        encoding: "utf8",
        timeout: 10000,
      },
    );
    expect(process.error).toBeUndefined();
    expect(process.status, String(process.stderr)).toBe(0);
    expect(String(process.stderr)).toBe("");
    const result = JSON.parse(String(process.stdout)) as FormComparisonResult;
    expect(result.outcome).toBe("no_reliable_change");
    expect(result.phases).toHaveLength(6);
    expect(result.strokeTiming?.before).toHaveProperty("contactMs", 2400);
  });

  it("runs the actual Node entrypoint on five synthetic local files", () => {
    const files = localFixture();
    const beforeFiles = files.args
      .filter((value) => value.endsWith(".json"))
      .map((path) => digest(readFileSync(path)));
    const process = cli(files.args);
    expect(process.error).toBeUndefined();
    expect(process.status, String(process.stderr)).toBe(0);
    expect(String(process.stderr)).toBe("");
    const result = JSON.parse(String(process.stdout)) as FormComparisonResult;
    expect(result.outcome).toBe("no_reliable_change");
    expect(result.phases).toHaveLength(6);
    expect(result.provenance?.before.captureMode).toBe("imported_video");
    expect(
      files.args
        .filter((value) => value.endsWith(".json"))
        .map((path) => digest(readFileSync(path))),
    ).toEqual(beforeFiles);
  });

  it("emits JSON abstention and exit 2 for hash-tampered local files", () => {
    const files = localFixture();
    writeFileSync(join(files.directory, "after.pose.json"), "{}");
    const process = cli(files.args);
    expect(process.status, String(process.stderr)).toBe(2);
    reason(
      JSON.parse(String(process.stdout)) as FormComparisonResult,
      "not_comparable",
      "artifact_hash_mismatch",
    );
  });

  it("prints criteria without opening pair files and exits 2 when disabled", () => {
    const criteria = cli(["--criteria"]);
    expect(criteria.status, String(criteria.stderr)).toBe(0);
    expect(JSON.parse(String(criteria.stdout))).toEqual({ acceptance: C, evaluationSchema: E });
    const disabled = cli([]);
    expect(disabled.status).toBe(2);
    reason(
      JSON.parse(String(disabled.stdout)) as FormComparisonResult,
      "insufficient_evidence",
      "experiment_disabled",
    );
  });

  it.each([
    "https://invalid.example/review.json",
    "file:///tmp/review.json",
    "//server/review.json",
  ])("refuses nonlocal path %s without remote fallback", async (path) => {
    const files = localFixture();
    files.args[files.args.length - 1] = path;
    reason(
      (await runFormCompareCli(files.args)) as FormComparisonResult,
      "not_comparable",
      "local_input_unreadable",
    );
  });

  it.each(["--unknown", "--enable-offline", "--metadata"])(
    "rejects duplicate/unknown/valueless flag %s",
    async (flag) => {
      reason(
        (await runFormCompareCli([...localFixture().args, flag])) as FormComparisonResult,
        "not_comparable",
        "cli_arguments_invalid",
      );
    },
  );

  it("rejects invalid JSON, non-regular, missing and oversized local files", async () => {
    const files = localFixture();
    writeFileSync(files.metadataPath, "not-json");
    reason(
      (await runFormCompareCli(files.args)) as FormComparisonResult,
      "not_comparable",
      "local_input_unreadable",
    );
    for (const path of [files.directory, join(files.directory, "missing.json")]) {
      files.args[files.args.length - 1] = path;
      reason(
        (await runFormCompareCli(files.args)) as FormComparisonResult,
        "not_comparable",
        "local_input_unreadable",
      );
    }
    truncateSync(files.metadataPath, C.maxInputFileBytes + 1);
    files.args[files.args.length - 1] = files.metadataPath;
    reason(
      (await runFormCompareCli(files.args)) as FormComparisonResult,
      "not_comparable",
      "local_input_unreadable",
    );
  });
});
