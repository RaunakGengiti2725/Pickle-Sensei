import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportDataset } from "../src/exportDataset.js";
import { validateAnnotation } from "../src/annotationSchema.js";
import { scorePaddleCase } from "../src/paddleBench.js";
import {
  BALL_GATES,
  resolveBallModality,
  windowBallObservations,
  type TrajectoryFile,
} from "../src/index.js";

function trajectoryFile(overrides: Partial<TrajectoryFile> = {}): TrajectoryFile {
  return {
    source: "apple-vision-trajectories-1",
    cameraAssumption: "stationary",
    pointTiming: "linear_over_time_range",
    trajectories: [
      {
        id: "traj-1",
        startMs: 1000,
        endMs: 1900,
        confidence: 0.9,
        points: Array.from({ length: 12 }, (_, index) => ({
          t: 1000 + index * 80,
          x: 0.2 + index * 0.05,
          y: 0.6 - index * 0.02,
        })),
      },
    ],
    ...overrides,
  };
}

const WINDOW = { startMs: 900, endMs: 2100 };

describe("resolveBallModality", () => {
  it("measures a clean, well-supported trajectory", () => {
    const { modality, diagnostics } = resolveBallModality({
      file: trajectoryFile(),
      window: WINDOW,
      videoDurationMs: 5000,
    });
    expect(modality.status).toBe("measured");
    if (modality.status !== "measured") return;
    expect(modality.data.observations.length).toBe(12);
    expect(modality.data.producedBy.providerId).toBe("ball.apple-vision-trajectories");
    expect(modality.data.continuity).toBeGreaterThan(0.5);
    expect(diagnostics.chosenId).toBe("traj-1");
  });

  it("rejects a noisy scene (moving camera) wholesale, with the rate in the reason", () => {
    const noisy = trajectoryFile({
      trajectories: Array.from({ length: 200 }, (_, index) => ({
        id: `noise-${index}`,
        startMs: index * 20,
        endMs: index * 20 + 100,
        confidence: 0.9,
        points: [
          { t: index * 20, x: 0.1, y: 0.1 },
          { t: index * 20 + 100, x: 0.2, y: 0.2 },
        ],
      })),
    });
    const { modality } = resolveBallModality({
      file: noisy,
      window: WINDOW,
      videoDurationMs: 4000, // 50 trajectories/second >> gate
    });
    expect(modality.status).toBe("unavailable");
    if (modality.status !== "unavailable") return;
    expect(modality.reason).toContain("trajectory_noise_scene_or_camera_motion");
  });

  it("rejects thin support instead of upgrading a blip into a ball track", () => {
    const blip = trajectoryFile({
      trajectories: [
        {
          id: "blip",
          startMs: 1400,
          endMs: 1480,
          confidence: 0.9,
          points: [
            { t: 1400, x: 0.5, y: 0.5 },
            { t: 1440, x: 0.52, y: 0.48 },
            { t: 1480, x: 0.54, y: 0.46 },
          ],
        },
      ],
    });
    const { modality } = resolveBallModality({
      file: blip,
      window: WINDOW,
      videoDurationMs: 5000,
    });
    expect(modality.status).toBe("unavailable");
    if (modality.status !== "unavailable") return;
    expect(modality.reason).toContain("trajectory_support_insufficient");
  });

  it("windowBallObservations returns time-sorted confident points only", () => {
    const file = trajectoryFile({
      trajectories: [
        ...trajectoryFile().trajectories,
        {
          id: "low-conf",
          startMs: 1000,
          endMs: 1500,
          confidence: BALL_GATES.minConfidence - 0.1,
          points: [{ t: 1200, x: 0.9, y: 0.9 }],
        },
      ],
    });
    const observations = windowBallObservations(file, WINDOW);
    expect(observations.length).toBe(12);
    expect(observations.every((entry, index, all) =>
      index === 0 || all[index - 1]!.timestampMs <= entry.timestampMs,
    )).toBe(true);
  });
});

describe("exportDataset", () => {
  function makeBundle(
    root: string,
    name: string,
    options: {
      consent: "granted" | "denied" | "not_asked";
      player?: string;
      annotated?: boolean;
      clip?: boolean;
      pose?: boolean;
    },
  ): void {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "capture.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: name,
        stroke: { declared: "forehand_drive", predicted: null },
        consent: {
          state: options.consent,
          termsVersion: options.consent === "granted" ? "v1" : null,
          decidedAtIso: null,
        },
      }),
    );
    if (options.player) {
      writeFileSync(join(dir, "player.json"), JSON.stringify({ playerId: options.player }));
    }
    if (options.clip !== false) writeFileSync(join(dir, "clip.mp4"), `video-bytes-${name}`);
    if (options.pose !== false) writeFileSync(join(dir, "pose.json"), `pose-bytes-${name}`);
    if (options.annotated) {
      mkdirSync(join(dir, "annotation"), { recursive: true });
      writeFileSync(join(dir, "annotation", "coach_a.json"), JSON.stringify({ annotatorId: "coach_a" }));
    }
  }

  it("exports only consented, labeled, complete bundles and reports every skip", () => {
    const root = mkdtempSync(join(tmpdir(), "swing-lab-export-"));
    makeBundle(root, "good-1", { consent: "granted", player: "p1", annotated: true });
    makeBundle(root, "good-2", { consent: "granted", player: "p2", annotated: true });
    makeBundle(root, "denied", { consent: "denied", player: "p3", annotated: true });
    makeBundle(root, "not-asked", { consent: "not_asked", player: "p4", annotated: true });
    makeBundle(root, "no-player", { consent: "granted", annotated: true });
    makeBundle(root, "no-labels", { consent: "granted", player: "p5" });
    makeBundle(root, "no-clip", { consent: "granted", player: "p6", annotated: true, clip: false });

    const outcome = exportDataset({ rootDir: root, datasetId: "test-ds", version: "1.0.0" });
    expect(outcome.included).toBe(2);
    expect(outcome.manifest?.provenance).toBe("consented_first_party");
    expect(outcome.manifest?.cases.map((entry) => entry.playerId).sort()).toEqual(["p1", "p2"]);
    const reasons = Object.fromEntries(outcome.skipped.map((skip) => [skip.bundle, skip.reason]));
    expect(reasons["denied"]).toBe("consent_not_granted");
    expect(reasons["not-asked"]).toBe("consent_not_granted"); // not_asked === denied
    expect(reasons["no-player"]).toBe("missing_player_id");
    expect(reasons["no-labels"]).toBe("missing_annotation");
    expect(reasons["no-clip"]).toBe("missing_clip");
    // Hashes are of the exact bytes.
    const first = outcome.manifest!.cases.find((entry) => entry.playerId === "p1")!;
    expect(first.videoSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.caseId).toBe(`case-${first.videoSha256.slice(0, 16)}`);
  });

  it("returns no manifest when nothing is exportable — never an empty 'dataset'", () => {
    const root = mkdtempSync(join(tmpdir(), "swing-lab-export-empty-"));
    makeBundle(root, "denied", { consent: "denied", player: "p1", annotated: true });
    const outcome = exportDataset({ rootDir: root, datasetId: "test-ds", version: "1.0.0" });
    expect(outcome.manifest).toBeNull();
    expect(outcome.included).toBe(0);
  });
});

describe("validateAnnotation", () => {
  const base = {
    schemaVersion: 1,
    captureBundle: "bundle-1",
    annotatorId: "coach_a",
    createdAtIso: "2026-08-27T00:00:00.000Z",
    revision: 1,
    stroke: "forehand_drive",
    handedness: "right",
    analyzable: true,
    notAnalyzableReason: null,
    phases: {
      preparationStartMs: 100,
      accelerationStartMs: 900,
      contactMs: 1200,
      followThroughEndMs: 1600,
    },
    faults: [{ checkpoint: "contact_position", severity: 2, note: "late" }],
    checkpointScores: { contact_position: 55, follow_through: null },
    overallScore: 62,
    annotatorConfidence: 0.8,
    notes: "",
    history: [],
  };

  it("accepts a complete structured annotation", () => {
    expect(validateAnnotation(base)).toEqual([]);
  });

  it("rejects unknown checkpoints, bad severities, and out-of-range values", () => {
    expect(
      validateAnnotation({
        ...base,
        faults: [{ checkpoint: "made_up", severity: 9, note: "" }],
        checkpointScores: { contact_position: 250 },
        annotatorConfidence: 3,
      }).length,
    ).toBeGreaterThanOrEqual(4);
  });

  it("validates paddle frame labels: visible needs a point, occluded must not carry one", () => {
    expect(
      validateAnnotation({
        ...base,
        paddleFrames: [
          { tMs: 100, point: { x: 0.5, y: 0.5 }, visibility: "visible" },
          { tMs: 200, point: null, visibility: "occluded" },
        ],
      }),
    ).toEqual([]);
    const bad = validateAnnotation({
      ...base,
      paddleFrames: [
        { tMs: 100, point: null, visibility: "visible" }, // missing point
        { tMs: 200, point: { x: 2, y: 0.5 }, visibility: "visible" }, // out of range
        { tMs: 300, point: { x: 0.5, y: 0.5 }, visibility: "occluded" }, // point not allowed
        { tMs: 400, point: null, visibility: "gone" }, // unknown visibility
      ],
    });
    expect(bad.length).toBeGreaterThanOrEqual(4);
  });
});

describe("scorePaddleCase", () => {
  const visible = (tMs: number, x: number, y: number) =>
    ({ tMs, point: { x, y }, visibility: "visible" }) as const;
  const occluded = (tMs: number) => ({ tMs, point: null, visibility: "occluded" }) as const;
  const prediction = (t: number, cx: number, cy: number) => ({
    t,
    x: cx - 0.03,
    y: cy - 0.04,
    w: 0.06,
    h: 0.08,
    conf: 0.7,
  });

  it("scores hits, misses, wrong locations, and false positives distinctly", () => {
    const result = scorePaddleCase(
      "case",
      [
        visible(1000, 0.5, 0.5), // hit (pred at 0.51, 0.5)
        visible(2000, 0.5, 0.5), // wrong location (pred at 0.8, 0.8)
        visible(3000, 0.5, 0.5), // miss (no pred within 40ms)
        occluded(4000), // false positive (pred exists)
        occluded(5000), // correct rejection
      ],
      [
        prediction(1010, 0.51, 0.5),
        prediction(2005, 0.8, 0.8),
        prediction(2900, 0.5, 0.5), // 100ms away → no match
        prediction(4030, 0.4, 0.4),
      ],
    );
    expect(result.hits).toBe(1);
    expect(result.wrongLocation).toBe(1);
    expect(result.misses).toBe(1);
    expect(result.falsePositives).toBe(1);
    expect(result.correctRejections).toBe(1);
    expect(result.precision).toBeCloseTo(1 / 3);
    expect(result.recall).toBeCloseTo(1 / 3);
    expect(result.meanCenterErrorNorm).toBeLessThan(0.02);
  });

  it("returns null metrics instead of fake zeros when nothing is labeled", () => {
    const result = scorePaddleCase("empty", [], []);
    expect(result.precision).toBeNull();
    expect(result.recall).toBeNull();
    expect(result.meanCenterErrorNorm).toBeNull();
  });
});
