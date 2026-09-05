import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareFormPair,
  formComparisonAbstention,
  FORM_COMPARISON_ACCEPTANCE,
  FORM_COMPARISON_EVALUATION_SCHEMA,
  type FormComparisonResult,
} from "../formComparison.js";

const FILE_FLAGS = [
  "--before-analysis",
  "--before-pose",
  "--after-analysis",
  "--after-pose",
  "--metadata",
] as const;
type FileFlag = (typeof FILE_FLAGS)[number];

const HELP = {
  workingDirectory: "repository root",
  usage:
    "pnpm --filter @pickle/swing-lab exec tsx src/cli/formCompare.ts --enable-offline --before-analysis /local/before.analysis.json --before-pose /local/before.pose.json --after-analysis /local/after.analysis.json --after-pose /local/after.pose.json --metadata /local/pair-review.json",
  criteriaCommand: "pnpm --filter @pickle/swing-lab exec tsx src/cli/formCompare.ts --criteria",
  analysisFormat: "Raw ShotAnalysis JSON, not a score summary or a mobile database row.",
  poseFormat:
    "Original canonical pose-sequence wire JSON accepted by parsePoseSequence; only normalized_image_top_left is supported.",
  metadataFormat:
    "FormComparisonPairMetadata exported in packages/swing-lab/src/formComparison.ts: schemaVersion=1, before/after with raw analysisSha256 + poseSha256, analysisId, playerId, nonempty sessionId, cameraView, captureMode (automatic_pose_trigger or imported_video), explicit left/right handedness, technique, all eight versionVector fields, original poseModel provenance, and independent review.",
  reviewFormat:
    "Each review needs basis (independent_frame_review for real or synthetic_fixture for fixtures), evidenceId, reviewerId, original clipSha256, timebase=original_clip_ms, fixed cameraSetupId, three shared scenePointIds, rotationDegrees=0, mirrored=false. Every in-window pose frame needs exact frameIndex/timestampMs, playerId, trackId, personCount=1, identityAmbiguous=false, trackSwitch=false, cameraView, cameraStable=true, occludedJoints, targetBox {x,y,width,height}, and three observed scenePoints [{x,y},...]. Coordinates are normalized-image. These are external observations, not defaults to fill in from analysis or pose.",
  trustBoundary:
    "The CLI verifies analysis/pose byte hashes and trace consistency, not the reviewer's truthfulness or the original video. Only poseModelVersion is carried in the pose bytes; other poseModel fields are caller declarations, not sidecar-verified provenance. Never manufacture review evidence to make a pair pass. Ordinary native sidecars alone abstain. No input discovery, video decoding, network calls, writes, app hooks or package exports.",
  output:
    "The CLI writes JSON to stdout. Direct Node/tsx execution exits 0 for a descriptive result/help and 2 for an abstention; pnpm may add runner diagnostics and translate a nonzero exit to 1. For JSON-only abstentions with exit 2, run node --import tsx src/cli/formCompare.ts with the same flags from packages/swing-lab.",
  validation:
    "Synthetic cases check software behavior, not measurement validation; real-data and coach validation, independent pair labels, same-condition repeatability data and measurement-uncertainty calibration are missing. The criteria export is requirements, not execution results or release authorization. No holdout was inspected for this protocol.",
};

async function localBytes(path: string): Promise<Uint8Array> {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) {
    throw new Error("Expected an explicit local filesystem path, not a URL.");
  }
  const file = await open(resolve(path), constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > FORM_COMPARISON_ACCEPTANCE.maxInputFileBytes) {
      throw new Error("Expected a regular local file within the 16 MiB input bound.");
    }
    const buffer = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, null);
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    const after = await file.stat();
    if (
      used !== stat.size ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    ) {
      throw new Error("Input file changed while reading; refusing a partial snapshot.");
    }
    return buffer.subarray(0, used);
  } finally {
    await file.close();
  }
}

export async function runFormCompareCli(argv: readonly string[]): Promise<
  | FormComparisonResult
  | typeof HELP
  | {
      acceptance: typeof FORM_COMPARISON_ACCEPTANCE;
      evaluationSchema: typeof FORM_COMPARISON_EVALUATION_SCHEMA;
    }
> {
  if (argv.length === 1 && argv[0] === "--help") return HELP;
  if (argv.length === 1 && argv[0] === "--criteria") {
    return {
      acceptance: FORM_COMPARISON_ACCEPTANCE,
      evaluationSchema: FORM_COMPARISON_EVALUATION_SCHEMA,
    };
  }
  if (!argv.includes("--enable-offline")) {
    return formComparisonAbstention(
      "insufficient_evidence",
      "experiment_disabled",
      "No files were opened. Pass --enable-offline explicitly; --help describes the independent evidence contract.",
    );
  }
  const paths = new Map<FileFlag, string>();
  let enabledCount = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--enable-offline") {
      enabledCount += 1;
      continue;
    }
    const value = argv[index + 1];
    if (
      !FILE_FLAGS.includes(flag as FileFlag) ||
      paths.has(flag as FileFlag) ||
      !value ||
      value.startsWith("--")
    ) {
      return formComparisonAbstention(
        "not_comparable",
        "cli_arguments_invalid",
        "Use each of the five file flags exactly once with a local path; unknown, duplicate and valueless flags are rejected. See --help.",
      );
    }
    paths.set(flag as FileFlag, value);
    index += 1;
  }
  if (enabledCount !== 1 || paths.size !== FILE_FLAGS.length) {
    return formComparisonAbstention(
      "not_comparable",
      "cli_arguments_invalid",
      "Exactly one --enable-offline and all five explicit input files are required. See --help.",
    );
  }
  try {
    const metadata: unknown = JSON.parse(
      Buffer.from(await localBytes(paths.get("--metadata")!)).toString("utf8"),
    );
    const [beforeAnalysis, beforePose, afterAnalysis, afterPose] = await Promise.all([
      localBytes(paths.get("--before-analysis")!),
      localBytes(paths.get("--before-pose")!),
      localBytes(paths.get("--after-analysis")!),
      localBytes(paths.get("--after-pose")!),
    ]);
    return compareFormPair(
      {
        before: { analysisBytes: beforeAnalysis, poseBytes: beforePose },
        after: { analysisBytes: afterAnalysis, poseBytes: afterPose },
        metadata,
      },
      { enableOfflineExperiment: true },
    );
  } catch {
    return formComparisonAbstention(
      "not_comparable",
      "local_input_unreadable",
      "A local input was unreadable, non-JSON metadata, changed while reading, non-regular, over the size bound or a URL. No fallback or remote fetch was attempted.",
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runFormCompareCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (
    "outcome" in result &&
    (result.outcome === "insufficient_evidence" || result.outcome === "not_comparable")
  ) {
    process.exitCode = 2;
  }
}
