import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { evaluateCaptureQuality } from "../src/captureQuality.js";
import { evaluateFrameAnalyzability, type FrameStats } from "../src/frameAnalyzability.js";
import { createGeometryProviderSet } from "../src/index.js";
import {
  detectOfflineStrokeWindow,
  estimateContact,
  paddleOwnershipFromHandAffinity,
} from "../src/offlineStroke.js";
import { assessPaddleTrackIdentity } from "../src/paddleTrackIdentity.js";
import { GeometricPhaseSegmenter } from "../src/phaseSegmenter.js";
import { KNOWN_GAPS } from "./stress/boundaryMalformed/knownGaps.js";
import { nonFinitePaths, poisonNumbers } from "./stress/boundaryMalformed/malformed.js";
import { longWrist, syntheticBase, wristTrack } from "./stress/boundaryMalformed/scenarios.js";

/**
 * Minimized, seed-free reproductions of every entry in the known-gap catalogue
 * (`stress/boundaryMalformed/knownGaps.ts`). Each test asserts the DEFECT —
 * it fails the moment production code starts honouring the contract, which is
 * the signal to delete the catalogue entry so the campaign enforces it.
 *
 * All inputs are values the TypeScript signatures admit (`number` includes
 * NaN/±Infinity) built from the committed synthetic swing; nothing here is a
 * type-invalid call. The typed JSON ingress (`parsePoseSequence`) rejects
 * non-finite numbers, so the mobile sidecar path is guarded; these gaps are
 * reachable by in-process callers of the package only.
 */

const HAZARD_ENV = "STRESS_KNOWN_GAP_CHILD";
const THIS_FILE = fileURLToPath(import.meta.url);

function nan<T>(value: T): T {
  return poisonNumbers(value, Number.NaN);
}

function inf<T>(value: T): T {
  return poisonNumbers(value, Number.POSITIVE_INFINITY);
}

if (process.env[HAZARD_ENV] === "contact_grid_unbounded") {
  // Child mode (spawned by the KG-09 test below with a capped heap): invoke the
  // hazard directly. This process is EXPECTED to die of OOM; if estimateContact
  // ever returns, the child exits 0 and the parent test fails.
  describe("known-gap child: estimateContact with a -Infinity window bound", () => {
    it(
      "runs the fusion grid loop (expected to exhaust the heap)",
      async () => {
        const base = syntheticBase(1);
        const result = await estimateContact({
          sequence: base.sequence,
          window: {
            startMs: Number.NEGATIVE_INFINITY,
            endMs: base.window.endMs,
            peakMotionMs: base.window.peakMs,
          },
          ballObservations: null,
        });
        console.warn(`contact_grid_unbounded: estimateContact returned ${result.status}`);
      },
      10 * 60 * 1000,
    );
  });
} else {
  describe("known gaps: boundary/malformed defects reproduced on the current code", () => {
    it("catalogue entries are unique and every one has a pin below", () => {
      const ids = KNOWN_GAPS.map((gap) => gap.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual([
        "KG-01",
        "KG-02",
        "KG-03",
        "KG-04",
        "KG-05",
        "KG-06",
        "KG-07",
        "KG-08",
        "KG-09",
      ]);
    });

    it("KG-02/KG-01: evaluateFrameAnalyzability says analyzable=true on all-NaN stats", () => {
      const stats: FrameStats = nan({
        frameCount: 120,
        durationMs: 4000,
        width: 640,
        height: 360,
        interFrameDiffs: Array.from({ length: 119 }, () => 5),
        spatialLumaStd: Array.from({ length: 120 }, () => 40),
        letterboxRowFraction: 0,
      });
      const report = evaluateFrameAnalyzability(stats);
      expect(report.analyzable).toBe(true);
      expect(report.reasons).toEqual([]);
      expect(nonFinitePaths(report)).toContain("$.stats.frameCount=NaN");
    });

    it("KG-02/KG-01: evaluateCaptureQuality says analyzable=true on an all-Infinity sequence", () => {
      const report = evaluateCaptureQuality(inf(syntheticBase(1).sequence));
      expect(report.analyzable).toBe(true);
      expect(report.reasons).toEqual([]);
      expect(nonFinitePaths(report).length).toBeGreaterThan(0);
    });

    it("KG-03/KG-01: GeometricPhaseSegmenter returns ok() phases with Infinity bounds", async () => {
      const base = syntheticBase(1);
      const frames = inf(base.frames);
      const segmenter = new GeometricPhaseSegmenter({ aspectRatio: 1 });
      const result = await segmenter.segmentPhases(frames, [], {
        startMs: Number.POSITIVE_INFINITY,
        endMs: Number.POSITIVE_INFINITY,
        contactMs: Number.POSITIVE_INFINITY,
        shotTypeHypothesis: null,
        confidence: Number.POSITIVE_INFINITY,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBeGreaterThan(0);
      expect(result.value.every((span) => !Number.isFinite(span.startMs))).toBe(true);
    });

    it("KG-04/KG-01: detectOfflineStrokeWindow returns ok() with NaN bounds and confidence", () => {
      const result = detectOfflineStrokeWindow(nan(syntheticBase(1).sequence));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(Number.isNaN(result.value.startMs)).toBe(true);
      expect(Number.isNaN(result.value.confidence)).toBe(true);
    });

    it("KG-05/KG-01: RecordedTriggerStrokeDetector emits an ok() NaN stroke window", async () => {
      const base = syntheticBase(1);
      const providers = createGeometryProviderSet({
        poseFrames: base.frames,
        poseModelVersion: "apple-vision-bodypose-1",
        trigger: {
          modelVersion: "temporal-trigger-1",
          startMs: Number.NaN,
          endMs: Number.NaN,
          peakMotionMs: Number.NaN,
          confidence: Number.NaN,
        },
        video: { width: base.video.width, height: base.video.height },
      });
      const strokes = await providers.stroke.detectStrokes({
        uri: "file:///captures/stroke.mov",
        durationMs: base.window.endMs,
        fps: base.video.fps,
        width: base.video.width,
        height: base.video.height,
      });
      expect(strokes.ok).toBe(true);
      if (!strokes.ok) return;
      expect(strokes.value).toHaveLength(1);
      expect(Number.isNaN(strokes.value[0]!.startMs)).toBe(true);
      expect(Number.isNaN(strokes.value[0]!.confidence)).toBe(true);
    });

    it("KG-06/KG-01: paddleOwnershipFromHandAffinity returns confidence NaN on NaN geometry", () => {
      const base = syntheticBase(1);
      const wrist = wristTrack(base, "right_wrist");
      const ownership = paddleOwnershipFromHandAffinity(
        nan({
          sequence: base.sequence,
          paddleCenters: wrist.map((p) => ({ timestampMs: p.timestampMs, x: p.x + 0.03, y: p.y })),
          targetWrists: wrist,
        }),
      );
      expect(ownership).not.toBeNull();
      expect(Number.isNaN(ownership!.confidence)).toBe(true);
    });

    it("KG-07: one NaN paddle sample makes evidence.targetSynchrony NaN", () => {
      const base = syntheticBase(1);
      const wrist = wristTrack(base, "right_wrist");
      const paddleCenters = wrist.map((p) => ({
        timestampMs: p.timestampMs,
        x: p.x + 0.03,
        y: p.y,
      }));
      const clean = assessPaddleTrackIdentity({
        paddleCenters,
        targetWristTracks: [wrist],
        aspect: 1,
        torsoSpan: 0.2,
      });
      expect(Number.isFinite(clean.evidence.targetSynchrony)).toBe(true);

      const poisoned = paddleCenters.map((p, index) =>
        index === 40 ? { ...p, x: Number.NaN } : p,
      );
      const assessment = assessPaddleTrackIdentity({
        paddleCenters: poisoned,
        targetWristTracks: [wrist],
        aspect: 1,
        torsoSpan: 0.2,
      });
      expect(Number.isNaN(assessment.evidence.targetSynchrony)).toBe(true);
    });

    it("KG-08: assessPaddleTrackIdentity throws RangeError on a 130k-sample wrist track", () => {
      const wrist = longWrist(130_000);
      const paddleCenters = wrist
        .slice(-200)
        .map((p) => ({ timestampMs: p.timestampMs, x: p.x + 0.03, y: p.y }));
      expect(() =>
        assessPaddleTrackIdentity({
          paddleCenters,
          targetWristTracks: [wrist],
          aspect: 1,
          torsoSpan: 0.2,
        }),
      ).toThrow(RangeError);
    });

    it(
      "KG-09 (hazard): estimateContact with a -Infinity window bound exhausts a 256 MiB heap",
      () => {
        const vitestBin = createRequire(import.meta.url).resolve("vitest/vitest.mjs");
        const child = spawnSync(process.execPath, [vitestBin, "run", THIS_FILE], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            [HAZARD_ENV]: "contact_grid_unbounded",
            NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=256`.trim(),
          },
          encoding: "utf8",
          timeout: 4 * 60 * 1000,
          maxBuffer: 64 * 1024 * 1024,
        });
        const transcript = `${child.stdout}\n${child.stderr}`;
        expect(transcript).not.toContain("contact_grid_unbounded: estimateContact returned");
        expect(
          child.status,
          `child exit status; transcript tail:\n${transcript.slice(-2000)}`,
        ).not.toBe(0);
        expect(transcript).toMatch(
          /heap out of memory|Channel closed|ERR_WORKER_OUT_OF_MEMORY|timed out|Unhandled/i,
        );
      },
      5 * 60 * 1000,
    );
  });
}
