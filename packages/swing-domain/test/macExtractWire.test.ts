import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePoseSequence, serializePoseSequence, sha256Hex } from "../src/index.js";

/**
 * Wire-contract check for a REAL `swing-lab extract` output directory produced
 * on the Mac runner (mac-full-verify artifacts: `swing-lab-extract/`).
 *
 * The artifacts are Mac-only, so this suite SKIPS LOUDLY unless
 * PICKLE_MAC_EXTRACT_DIR points at a downloaded extract directory
 * (e.g. `gh run download <id>` → `mac-full-verify-N/swing-lab-extract`).
 * Optionally set PICKLE_MAC_EXTRACT_PRIOR_DIR to a second run's extract of the
 * SAME fixture to assert byte-identical pose output across runs.
 *
 * Nothing here claims Apple runtime behaviour: it only asserts that what the
 * native CLI wrote is accepted, unrepaired, by the phone's own strict parser.
 */
const EXTRACT_DIR = process.env["PICKLE_MAC_EXTRACT_DIR"] ?? null;
const PRIOR_DIR = process.env["PICKLE_MAC_EXTRACT_PRIOR_DIR"] ?? null;
const present = EXTRACT_DIR !== null && existsSync(join(EXTRACT_DIR, "pose.json"));
const describeMac = present ? describe : describe.skip;

const PROVENANCE = {
  providerId: "pose.apple-vision",
  runtime: "vision_framework",
  executionTarget: "on_device",
  artifactHash: null,
} as const;

function readJson<T>(dir: string, name: string): T {
  return JSON.parse(readFileSync(join(dir, name), "utf8")) as T;
}

describeMac(
  "Mac swing-lab extract through the strict domain parser (SKIPPED unless PICKLE_MAC_EXTRACT_DIR is set)",
  () => {
    const dir = EXTRACT_DIR!;

    it("pose.json parses unrepaired, round-trips, and matches extract-meta counts", () => {
      const raw = readFileSync(join(dir, "pose.json"), "utf8");
      const parsed = parsePoseSequence(raw, PROVENANCE);
      if (!parsed.ok) throw new Error(parsed.failure.message);
      const sequence = parsed.value;
      expect(sequence.frames.length).toBeGreaterThan(0);
      for (let index = 1; index < sequence.frames.length; index += 1) {
        expect(sequence.frames[index]!.timestampMs).toBeGreaterThan(
          sequence.frames[index - 1]!.timestampMs,
        );
      }
      for (const frame of sequence.frames) {
        for (const mark of frame.landmarks) {
          expect(mark.x).toBeGreaterThanOrEqual(0);
          expect(mark.x).toBeLessThanOrEqual(1);
          expect(mark.y).toBeGreaterThanOrEqual(0);
          expect(mark.y).toBeLessThanOrEqual(1);
        }
      }
      const reparsed = parsePoseSequence(serializePoseSequence(sequence), PROVENANCE);
      expect(reparsed.ok).toBe(true);

      const meta = readJson<{ framesWithPose: number; framesSeen: number; poseMisses: number }>(
        dir,
        "extract-meta.json",
      );
      expect(meta.framesWithPose).toBe(sequence.frames.length);
      expect(meta.framesWithPose + meta.poseMisses).toBe(meta.framesSeen);
    });

    it("scenes.json scores/cuts are ordered and inside the frame range", () => {
      const scenes = readJson<{
        cuts: number[];
        scores: Array<{ t?: number; ms?: number } | number>;
        segments: Array<{ startMs: number; endMs: number }>;
      }>(dir, "scenes.json");
      for (let index = 1; index < scenes.cuts.length; index += 1) {
        expect(scenes.cuts[index]!).toBeGreaterThan(scenes.cuts[index - 1]!);
      }
      expect(scenes.segments.length).toBe(scenes.cuts.length + 1);
      for (let index = 1; index < scenes.segments.length; index += 1) {
        expect(scenes.segments[index]!.startMs).toBe(scenes.segments[index - 1]!.endMs);
      }
    });

    it("corrupted copies of the real artifact are rejected, never repaired", () => {
      const raw = JSON.parse(readFileSync(join(dir, "pose.json"), "utf8")) as {
        frames: Array<{ t: number }>;
      };
      raw.frames[1]!.t = raw.frames[0]!.t;
      const stale = parsePoseSequence(JSON.stringify(raw), PROVENANCE);
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.failure.code).toBe("pose_sequence.non_monotonic");
      expect(parsePoseSequence("", PROVENANCE).ok).toBe(false);
      expect(parsePoseSequence("{}", PROVENANCE).ok).toBe(false);
    });

    const itPrior = PRIOR_DIR !== null && existsSync(join(PRIOR_DIR, "pose.json")) ? it : it.skip;
    itPrior("two Mac runs on the same fixture write byte-identical pose.json", () => {
      const a = readFileSync(join(dir, "pose.json"), "utf8");
      const b = readFileSync(join(PRIOR_DIR!, "pose.json"), "utf8");
      expect(sha256Hex(a)).toBe(sha256Hex(b));
    });
  },
);
