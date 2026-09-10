// Builds the analysis-release-policy-v1 document for the 1.0 operational
// release of the existing on-device 2D analyzer, validates it with the shared
// contract, canonicalizes/digests it with the Edge function's own code and
// writes the exact bytes the operator installs. Run from the repository root:
//
//   npx --yes deno@2.5.6 run --config supabase/functions/api/deno.json \
//     --lock=supabase/functions/api/deno.lock --frozen --node-modules-dir=none \
//     --allow-read --allow-write tools/release-policy/build-1.0-operational-2d.ts
//
// Every sha256 below is the SHA-256 of a real artifact at the commit named in
// `RELEASE_COMMIT`: `blob` = raw file bytes (`git show <commit>:<path>`),
// `tree` = the deterministic `git ls-tree -r <commit> -- <path>` listing.
import {
  CAMERA_VIEWS,
  SHOT_TYPES,
} from "../../packages/shared-types/src/domain.ts";
import {
  type AnalysisReleaseInputDomain,
  type AnalysisReleasePolicyDocument,
  validateAnalysisReleasePolicy,
} from "../../packages/shared-types/src/analysisReleasePolicy.ts";
import {
  canonicalizeOfflineJson,
  digestCanonicalOfflineJson,
} from "../../supabase/functions/api/canonicalDigest.ts";

export const RELEASE_COMMIT = "dcbfc9cd830781f9dadc687ec090b222b4996406";

const artifact = (version: string, sha256: string) => ({ version, sha256 });

/** The on-device 2D mechanics stack exactly as it ships. */
const mechanicsLineage = {
  pipeline: artifact(
    "fusion-2",
    "cbd95b7d1d4db5bb67c108eee2bcdbefa8aca3b555d3efde1a32363e8d28f30f", // tree packages/analysis-pipeline/src
  ),
  definition: artifact(
    "sm-v1",
    "7c4f63efa7cc33c3c766948f3244ecbf94b475909d1cb578c820335a7f37433c", // tree packages/scoring/src
  ),
  model: artifact(
    "on-device-fusion-2",
    "c9fff4ee5e8cab986d69685d79b60464d00bb4a0125d3b7934449ff1b5e8adcf", // blob packages/model-registry/src/defaultManifest.ts
  ),
  preprocessing: artifact(
    "apple-vision-bodypose-1",
    "6d0b7a3ece9b814df6cec8e139670ffcb25442811920d60f65f0d87153256173", // tree native/vision-core/Sources
  ),
  calibration: artifact(
    "sm-v1-blueprint-hypothesis",
    "10bf53de31c1e33c5ed726c2780c33f2c71ca904ed7b0cb375d15d1a2cbdf0dc", // blob packages/scoring/src/config/v1.ts
  ),
  dataset: artifact(
    "pickle-real-v0.3",
    "8da130571db9a9d8508ae5547aa38d6a20982be5de2d38d3bbb8b1eb3c60a56c", // blob datasets/releases/pickle-real-v0.3/manifest.json
  ),
  validationReport: artifact(
    "release-readiness-2026-09-10-operational-no-accuracy-claim",
    "feb32e099d96d9c2738f64ce91471d9bbd1ef1195c01e34000e38c47440b2bd6", // blob docs/RELEASE_READINESS_2026-09-10.md
  ),
  supportedDomain: artifact(
    "capture-envelope-thresholds-v0.4-provisional",
    "c9f8c5ab697143079c0676d3a56937bfdab593ebba3a22ae78cd1f277497f526", // blob packages/capture-envelope/src/core.ts
  ),
};

/** The 1.0 analyzer produces NO technique benchmark: the pipeline has no
 * benchmark stage and Result always shows "Technique benchmark unavailable —
 * separate validation is required". The schema still requires this section,
 * so it binds the withholding contract itself and declares the narrowest
 * boundaries the contract allows; nothing in 1.0 can publish an interval. */
const benchmarkContract = artifact(
  "technique-benchmark-v1-withheld",
  "f9f3a90a8af1ea0341f8630c3e1effdddff3f300c30c5cf82eaf94778deeb221", // blob packages/shared-types/src/techniqueBenchmark.ts
);
const benchmarkLineage = {
  pipeline: mechanicsLineage.pipeline,
  definition: benchmarkContract,
  model: benchmarkContract,
  preprocessing: mechanicsLineage.preprocessing,
  calibration: benchmarkContract,
  dataset: mechanicsLineage.dataset,
  validationReport: mechanicsLineage.validationReport,
  supportedDomain: mechanicsLineage.supportedDomain,
};

/** Every shot type sm-v1 scores, both capture modes, every profile handedness
 * — but only the side view: 1.0 runs the analyzer with `cameraView: 'side'`
 * exclusively (AnalyzeScreen), so `rear_oblique` is not a shipping input. */
const SHIPPING_CAMERA_VIEWS = CAMERA_VIEWS.filter((view) => view === "side");
const supportedInputs: AnalysisReleaseInputDomain[] = [];
for (const shotType of SHOT_TYPES) {
  for (const cameraView of SHIPPING_CAMERA_VIEWS) {
    for (const handedness of ["right", "left", "ambidextrous"] as const) {
      for (
        const captureMode of [
          "automatic_pose_trigger",
          "imported_video",
        ] as const
      ) {
        supportedInputs.push({ shotType, cameraView, handedness, captureMode });
      }
    }
  }
}

export const document: AnalysisReleasePolicyDocument = {
  schemaVersion: "analysis-release-policy-v1",
  version: "1.0-operational-2d",
  validFrom: 1788998400, // 2026-09-10T00:00:00Z
  validUntil: 1820534400, // 2027-09-10T00:00:00Z
  mechanics: { lineage: mechanicsLineage },
  benchmark: {
    lineage: benchmarkLineage,
    uncertainty: {
      kind: "calibrated_prediction_interval",
      nominalCoverage: 0.5,
      coverageScope: "supported_slice",
      calibrationUnit: "player_session",
    },
    maximumIntervalWidth: 0.25,
    boundaryStep: 0.25,
    supportedIntervals: [{ lower: 2, upper: 2.25 }],
  },
  supportedInputs,
};

if (import.meta.main) {
  if (!validateAnalysisReleasePolicy(document)) {
    console.error("The document does not satisfy analysis-release-policy-v1.");
    Deno.exit(1);
  }
  const canonical = canonicalizeOfflineJson(document);
  const sha256 = await digestCanonicalOfflineJson(document);
  const outDir = "docs/release-policy";
  await Deno.mkdir(outDir, { recursive: true });
  await Deno.writeTextFile(
    `${outDir}/1.0-operational-2d.canonical.json`,
    canonical,
  );
  await Deno.writeTextFile(
    `${outDir}/1.0-operational-2d.sha256`,
    `${sha256}\n`,
  );
  console.log(JSON.stringify(document, null, 2));
  console.log(`\nsupportedInputs: ${supportedInputs.length}`);
  console.log(
    `canonical bytes: ${new TextEncoder().encode(canonical).byteLength}`,
  );
  console.log(`sha256: ${sha256}`);
}
