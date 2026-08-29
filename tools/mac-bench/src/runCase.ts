import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StageSample } from "./latencyStats.js";

/**
 * runCase — one timed analyzeVideo invocation for one benchmark case,
 * appending per-stage samples to a stage-samples.jsonl.
 *
 *   npx tsx src/runCase.ts --case <id> --phase cold|warm --iteration <n> \
 *     --samples <stage-samples.jsonl> [--out-dir <dir>] [--reuse-extract]
 *
 * The case CLI (video, stroke, target tap) comes from the frozen
 * datasets/paddle-bench/regen-manifest.json — the SAME derivation lab:regen
 * uses, so a timed run is the canonical run, never a hand-tuned variant.
 * Absolute paths in the committed manifest belong to the canonical Mac; this
 * runner keeps only the path RELATIVE to datasets/paddle-bench so the
 * manifest works on any checkout.
 *
 * MEASUREMENT SEMANTICS (documented once, here):
 *  - Every invocation is a fresh OS process — 'cold' vs 'warm' is about
 *    on-disk caches, not process reuse.
 *  - cold  = run WITHOUT --reuse-extract into a scratch dir purged first
 *    (pose extraction + full python model load happen); intended as the
 *    first iteration after run-mac-bench.sh clears the scratch area.
 *  - warm  = subsequent runs; OS file cache, HF model cache, and python
 *    bytecode caches are populated. Extraction still reruns unless
 *    --reuse-extract is passed (run-mac-bench.sh does NOT pass it, so warm
 *    E2E remains a true end-to-end number).
 *  - e2e wall time is measured around the child process; per-stage numbers
 *    are the pipeline's own timings block from report.json (one source of
 *    truth — this runner never re-derives stage boundaries).
 *
 * Executing this requires the macOS-only Swift extractor; on Linux it fails
 * fast at spawn time with the extractor's own missing-binary error. The
 * sample-harvesting logic (harvestStageSamples) is pure and fixture-tested
 * on Linux.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const PB = join(REPO_ROOT, "datasets/paddle-bench");

interface ManifestEntry {
  id: string;
  video: string;
  stroke: string;
  outDir: string;
  targetTap: { x: number; y: number };
  expectedTargetTrackId: number;
  extraFlags: string[];
}

/** Stage timing keys harvested from report.json → stage names in the results
 * document. Keys absent from a report (stage not reached, flag off) are
 * skipped — absence stays honest, never recorded as 0. */
export const REPORT_TIMING_STAGES: ReadonlyArray<{ reportKey: string; stage: string }> = [
  { reportKey: "poseExtractMs", stage: "poseExtract" },
  { reportKey: "playerTrackMs", stage: "playerTrack" },
  { reportKey: "poseDerivativesMs", stage: "poseDerivatives" },
  { reportKey: "eventPrePassMs", stage: "eventPrePass" },
  { reportKey: "paddleDetectMs", stage: "paddleDetect" },
  { reportKey: "paddleDetectSparseMs", stage: "paddleDetectSparse" },
  { reportKey: "paddleDetectDenseMs", stage: "paddleDetectDense" },
  { reportKey: "paddleTrackMs", stage: "paddleTrack" },
  { reportKey: "ballCandidatesMs", stage: "ballCandidates" },
  { reportKey: "ballTrackMs", stage: "ballTrack" },
  { reportKey: "eventIsolationMs", stage: "eventIsolation" },
  { reportKey: "fusionAnalysisMs", stage: "fusionAnalysis" },
  { reportKey: "overlayRenderMs", stage: "overlayRender" },
];

export function harvestStageSamples(
  timings: Record<string, number>,
  e2eWallMs: number,
  caseId: string,
  phase: "cold" | "warm",
  iteration: number,
): StageSample[] {
  const samples: StageSample[] = [{ stage: "e2e", caseId, phase, iteration, wallMs: e2eWallMs }];
  for (const { reportKey, stage } of REPORT_TIMING_STAGES) {
    const value = timings[reportKey];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      samples.push({ stage, caseId, phase, iteration, wallMs: value });
    }
  }
  return samples;
}

/** Rebases a canonical-Mac absolute manifest path onto this checkout by its
 * datasets/paddle-bench-relative tail. Throws when the path is not under a
 * paddle-bench dir — that would mean the manifest changed shape. */
export function rebaseManifestPath(manifestPath: string, paddleBenchRoot: string): string {
  const marker = "datasets/paddle-bench/";
  const index = manifestPath.indexOf(marker);
  if (index < 0) {
    throw new Error(`manifest path is not under datasets/paddle-bench: ${manifestPath}`);
  }
  return join(paddleBenchRoot, manifestPath.slice(index + marker.length));
}

function flagValue(name: string, argv: readonly string[]): string | null {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) return null;
  return argv[index + 1] ?? null;
}

const isMain = process.argv[1]?.endsWith("runCase.ts");
if (isMain) {
  const argv = process.argv.slice(2);
  const caseId = flagValue("--case", argv);
  const phase = flagValue("--phase", argv);
  const iteration = Number(flagValue("--iteration", argv) ?? "1");
  const samplesPath = flagValue("--samples", argv);
  if (!caseId || (phase !== "cold" && phase !== "warm") || !samplesPath) {
    console.error(
      "usage: runCase --case <id> --phase cold|warm --iteration <n> --samples <jsonl> [--out-dir <dir>] [--reuse-extract]",
    );
    process.exit(2);
  }

  const manifest = JSON.parse(
    readFileSync(join(PB, "regen-manifest.json"), "utf8"),
  ) as ManifestEntry[];
  const entry = manifest.find((candidate) => candidate.id === caseId);
  if (!entry) {
    console.error(`case '${caseId}' not in regen-manifest.json`);
    process.exit(2);
  }

  const outDir = flagValue("--out-dir", argv) ?? rebaseManifestPath(entry.outDir, PB);
  if (flagValue("--out-dir", argv) && phase === "cold") {
    // Cold scratch runs start from nothing; canonical dirs are never purged.
    rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });

  const args = [
    "tsx",
    "src/analyzeVideo.ts",
    rebaseManifestPath(entry.video, PB),
    "--stroke",
    entry.stroke,
    "--target-tap",
    `${entry.targetTap.x},${entry.targetTap.y}`,
    "--out",
    outDir,
    ...(argv.includes("--reuse-extract") ? ["--reuse-extract"] : []),
    ...entry.extraFlags,
  ];
  const started = Date.now();
  execFileSync("npx", args, { cwd: join(REPO_ROOT, "packages/swing-lab"), stdio: "inherit" });
  const e2eWallMs = Date.now() - started;

  const report = JSON.parse(readFileSync(join(outDir, "report.json"), "utf8")) as {
    timings?: Record<string, number>;
  };
  const samples = harvestStageSamples(report.timings ?? {}, e2eWallMs, caseId, phase, iteration);
  appendFileSync(samplesPath, `${samples.map((sample) => JSON.stringify(sample)).join("\n")}\n`);
  console.log(
    `${caseId} [${phase} #${iteration}] e2e ${e2eWallMs}ms → ${samples.length} samples appended`,
  );
}
