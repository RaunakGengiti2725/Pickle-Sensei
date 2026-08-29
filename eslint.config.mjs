import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.js", "**/*.mjs", "!eslint.config.mjs"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    // React Native resolves static image assets via require() by design.
    files: ["apps/mobile/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    files: [
      "**/test/**/*.ts",
      "**/*.test.ts",
      "**/scripts/**/*.ts",
      "**/src/cli.ts",
      "**/eval/**/*.ts",
      // swing-lab is a terminal research bench; its entrypoints print reports.
      "packages/swing-lab/src/analyzeVideo.ts",
      "packages/swing-lab/src/exportDataset.ts",
      "packages/swing-lab/src/annotate.ts",
      "packages/swing-lab/src/paddleBench.ts",
      "packages/swing-lab/src/ballBench.ts",
      "packages/swing-lab/src/strokeBench.ts",
      "packages/swing-lab/src/datasetReport.ts",
      "packages/swing-lab/src/datasetRelease.ts",
      "packages/swing-lab/src/dataGaps.ts",
      "packages/swing-lab/src/mineVideo.ts",
      "packages/swing-lab/src/paddleWaterfall.ts",
      "packages/swing-lab/src/targetAcquisitionBench.ts",
      "packages/swing-lab/src/learningCurve.ts",
      "packages/swing-lab/src/learningCurveModality.ts",
      "packages/swing-lab/src/ownershipAnnotate.ts",
      "packages/swing-lab/src/eventCompletionBench.ts",
      "packages/swing-lab/src/cascadeWaterfall.ts",
      "packages/swing-lab/src/coverageRisk.ts",
      "packages/swing-lab/src/labelQueueV2.ts",
      "packages/swing-lab/src/coachReview.ts",
      "packages/swing-lab/src/corpusCheck.ts",
      "packages/swing-lab/src/strokeTaxonomyBench.ts",
      "packages/swing-lab/src/benchRegen.ts",
      "packages/swing-lab/src/contactForensics.ts",
      "packages/swing-lab/src/paddleSelectionForensics.ts",
      "packages/swing-lab/src/eventWindowSlice.ts",
      "packages/swing-lab/src/eventBoundsScout.ts",
      "packages/swing-lab/src/waveaValidate.ts",
      "packages/swing-lab/src/ballOcclusionBench.ts",
      "packages/swing-lab/src/eventFailureOracle.ts",
      "packages/swing-lab/src/experimentBundle.ts",
      "packages/swing-lab/src/oodNegativesMeasure.ts",
      "packages/swing-lab/src/ownershipBench.ts",
      "packages/swing-lab/src/paddleMergeSafetySweep.ts",
      "packages/swing-lab/src/detectSpanAudit.ts",
      "packages/swing-lab/src/ownershipGuardBench.ts",
      "packages/swing-lab/src/paddleS4StressReplay.ts",
      "packages/swing-lab/src/strokeHeuristicBench.ts",
      // mac-bench is a terminal benchmark harness; its CLIs print reports.
      "tools/mac-bench/src/**/*.ts",
      // One-off research scripts committed as per-workstream experiment evidence;
      // they are terminal CLIs that print their findings.
      "datasets/experiments/**/*.ts",
      // data-engine CLIs (acquire/factory/status/import/failure-mine) print reports.
      "packages/swing-lab/src/engine/**/*.ts",
    ],
    rules: {
      "no-console": "off",
    },
  },
);
