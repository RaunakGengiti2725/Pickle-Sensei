import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateFrameAnalyzability } from "@pickle/vision-geometry";
import { preAnalysisGate } from "@pickle/analysis-pipeline";
import { extractFrameStats } from "../src/frameStats.js";

/**
 * OOD gate against the derived/synthetic probe corpus in
 * datasets/ood/registry.json derivedItems (wave-e/e11-ood-expansion): still
 * images, still-image-as-video, program-generated graphics, corrupt/truncated
 * media, and extreme aspect ratios. Expectations are the verdicts MEASURED on
 * this corpus under frame-analyzability-3
 * (datasets/experiments/wave-e/e11-ood-gate-measurements.json); the test locks
 * that measured behavior, it does not assert the gate is sufficient.
 *
 * Pose-conditioned signals (no_person_found, person_implausible_scale) cannot
 * run here: pose extraction is Apple-Vision/macOS-only, so pose is null and
 * only contract-level assertions are made about it. Probes the pose-free gate
 * passes through are known findings — asserting they pass is honest reporting,
 * not endorsement.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const registryPath = join(root, "datasets", "ood", "registry.json");

interface RegistryEntry {
  id: string;
  category: string;
  path: string;
}

const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
  derivedItems: { items: RegistryEntry[] };
};

/**
 * Measured on Linux CPU, 2026-08-29, under frame-analyzability-3; every id
 * must appear in exactly one map/set. The value is the set of reason codes the
 * pose-free gate must emit for the id.
 */
const POSE_FREE_DETECTED = new Map<string, string[]>([
  ["derived-still-image", ["single_frame_clip"]],
  ["derived-still-image-video", ["still_image_video"]],
  ["derived-graphics-testsrc", ["static_overlay_suspected"]],
  ["derived-extreme-wide", ["implausible_aspect_ratio"]],
  ["derived-extreme-tall", ["implausible_aspect_ratio"]],
  ["derived-truncated", ["decoded_frame_deficit"]],
  ["derived-corrupt-bytes", ["single_frame_clip", "undecodable_media"]],
  ["derived-garbage", ["single_frame_clip", "undecodable_media"]],
]);
/**
 * Animated program-generated graphics carry real motion and texture, so no
 * pose-free frame statistic separates them from real footage; rejecting them
 * is pose/content-level territory (no person will be found on macOS).
 */
const KNOWN_PASS_THROUGH_FINDINGS = new Set(["derived-graphics-life"]);

describe("OOD gate on the derived probe corpus (datasets/ood derivedItems)", () => {
  it("registry covers every expectation and every file exists", () => {
    const ids = registry.derivedItems.items.map((item) => item.id).sort();
    expect(ids).toEqual([...POSE_FREE_DETECTED.keys(), ...KNOWN_PASS_THROUGH_FINDINGS].sort());
    for (const item of registry.derivedItems.items) {
      expect(existsSync(join(root, item.path))).toBe(true);
    }
  });

  for (const item of registry.derivedItems.items) {
    const expectedReasons = POSE_FREE_DETECTED.get(item.id);
    if (expectedReasons !== undefined) {
      it(`abstains (no confident analysis) on ${item.id} via pose-free signals`, () => {
        const frame = evaluateFrameAnalyzability(extractFrameStats(join(root, item.path)));
        expect(frame.analyzable).toBe(false);
        expect(frame.reasons).toEqual(expectedReasons);
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
