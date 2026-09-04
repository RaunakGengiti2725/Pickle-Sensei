/**
 * Attack S3 companion (adversarial pass 3, tester #4): drive the regression
 * runner's real `executeBench` wrapper with a media-dependent bench definition
 * — the committed wm-volley-02 clip through extractFrameStats — and print the
 * BenchRecord it produces. Run once with ffmpeg on PATH and once without (the
 * shell harness does this) to show whether a bench that decodes media ends up
 * `failed` or silently emits zero-count metrics.
 *
 *   pnpm -s --filter @pickle/swing-lab exec tsx test/attack/benchMediaProbe.ts <out.json>
 *
 * Two probe benches are exercised:
 *   guarded  — throws when the decode yields no frames (what a media bench
 *              SHOULD do); expected status "failed" without ffmpeg.
 *   naive    — reports frameCount as a metric without checking (the
 *              zero-count failure mode the scenario looks for).
 * Nothing under datasets/ is written; the clip is only read.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { executeBench } from "../../../evaluation/src/regression/run.js";
import type { BenchDefinition } from "../../../evaluation/src/regression/benches.js";
import { extractFrameStats } from "../../src/frameStats.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const CLIP = join(REPO_ROOT, "datasets/paddle-bench/bundles/wm-volley-02/clip.mp4");

const outPath = process.argv[2];
if (!outPath) {
  console.error("usage: tsx benchMediaProbe.ts <out.json>");
  process.exit(2);
}

function probe(id: string, guarded: boolean): BenchDefinition {
  return {
    id,
    title: `attack probe: ${guarded ? "guarded" : "naive"} media bench over wm-volley-02`,
    kind: "in_process",
    command: "extractFrameStats(datasets/paddle-bench/bundles/wm-volley-02/clip.mp4)",
    cwd: REPO_ROOT,
    inputs: ["datasets/paddle-bench/bundles/wm-volley-02/clip.mp4"],
    caveats: ["attack harness only — not a committed bench"],
    run: () => {
      const stats = extractFrameStats(CLIP);
      if (guarded && stats.frameCount === 0) {
        throw new Error(
          `decoded 0 frames (decode errors: ${stats.decode?.errorCount ?? "n/a"}) — ffmpeg missing or clip undecodable`,
        );
      }
      return {
        metrics: {
          frame_count: stats.frameCount,
          inter_frame_pairs: stats.interFrameDiffs.length,
          decode_error_count: stats.decode?.errorCount ?? null,
        },
        labels: { clip: "wm-volley-02" },
      };
    },
  };
}

const records = [probe("attack_media_guarded", true), probe("attack_media_naive", false)].map(
  (definition) => executeBench(definition, () => null),
);
const ffmpegOnPath = spawnSync("ffmpeg", ["-version"]).status === 0;
const failed = records.filter((record) => record.status === "failed");
const report = {
  ffmpegOnPath,
  records: records.map(({ id, status, exitCode, error, metrics, labels }) => ({
    id,
    status,
    exitCode,
    error: error ? error.split("\n")[0] : null,
    metrics,
    labels,
  })),
  runnerWouldExit: failed.length > 0 ? 1 : 0,
};
writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
