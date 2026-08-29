import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateFrameAnalyzability } from "@pickle/vision-geometry";
import { preAnalysisGate } from "@pickle/analysis-pipeline";
import { extractFrameStats } from "../src/frameStats.js";

/**
 * OOD gate against the REAL (non-synthetic) rights-cleared negative corpus in
 * datasets/ood/ (D08). Expectations below are the verdicts MEASURED on this
 * corpus (datasets/experiments/wave-d/d08-ood-measurements.json); the test
 * locks that measured behavior, it does not assert the gate is sufficient.
 *
 * Pose-conditioned signals (no_person_found, person_implausible_scale) cannot
 * run here: pose extraction is Apple-Vision/macOS-only, so pose is null and
 * only contract-level assertions are made about it. Negatives the pose-free
 * gate passes through are known findings — asserting they pass is honest
 * reporting, not endorsement.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const registryPath = join(root, "datasets", "ood", "registry.json");

interface RegistryItem {
  id: string;
  category: string;
  path: string;
}

const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
  items: RegistryItem[];
};

/**
 * Measured on Linux CPU, 2026-08-29, under frame-analyzability-2 (D3-11);
 * every id must appear in exactly one set.
 *
 * Under frame-analyzability-1 the five ids now listed as pass-through
 * findings were rejected by the median inter-frame-diff still_image_video
 * rule — but so were 5/6 legitimate fresh-candidate pickleball clips
 * (medians overlap: negatives 0.085-0.419 vs legitimate 0.095-0.777), so
 * that rule was blanket abstention, not detection. frame-analyzability-2
 * replaced it with a frozen-pair-fraction rule that keeps true slideshows
 * rejected without rejecting real footage; distinguishing other racket
 * sports from pickleball is content-level and remains pose/macOS territory
 * (see datasets/experiments/wave-d3/d3-11-rt-ood-gate-summary.json).
 */
const POSE_FREE_DETECTED = new Set<string>([]);
const KNOWN_PASS_THROUGH_FINDINGS = new Set([
  "yt--wE27MoX2AM-tennis",
  "yt-RpPe0h9cD5E-tennis",
  "yt-Iw55LinAF0U-badminton",
  "yt-zWQs7kTKcEY-emptycourt",
  "ia-HanfordS1957-titlecard",
  "yt-2wV0Gs9r384-tabletennis",
  "yt-BCJGL5E9huM-tabletennis",
  "commons-ronpaul-crowd",
  "ia-ProfileJ26-interview",
]);

describe("OOD gate on the real negative corpus (datasets/ood)", () => {
  it("registry covers every expectation and every file exists", () => {
    const ids = registry.items.map((item) => item.id).sort();
    expect(ids).toEqual([...POSE_FREE_DETECTED, ...KNOWN_PASS_THROUGH_FINDINGS].sort());
    for (const item of registry.items) {
      expect(existsSync(join(root, item.path))).toBe(true);
    }
  });

  for (const item of registry.items) {
    if (POSE_FREE_DETECTED.has(item.id)) {
      it(`abstains (no confident analysis) on ${item.id} via pose-free signals`, () => {
        const frame = evaluateFrameAnalyzability(extractFrameStats(join(root, item.path)));
        expect(frame.analyzable).toBe(false);
        const result = preAnalysisGate({ frame, pose: null, poseQuality: null });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.failure.kind).toBe("corrupted_media");
        expect(result.failure.code).toMatch(/^capture\.not_analyzable\./);
      });
    } else {
      it(`documents the pass-through finding on ${item.id} (pose-free signals insufficient)`, () => {
        const frame = evaluateFrameAnalyzability(extractFrameStats(join(root, item.path)));
        expect(frame.analyzable).toBe(true);
        const result = preAnalysisGate({ frame, pose: null, poseQuality: null });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // Contract-level pose assertion: with no pose input the gate must
        // report pose_presence and pose_capture_quality as NOT evaluated, so
        // downstream may not treat this as a cleared-for-analysis verdict.
        expect(result.value.notEvaluated).toContain("pose_presence");
        expect(result.value.notEvaluated).toContain("pose_capture_quality");
      });
    }
  }
});
