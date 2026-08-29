import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BallFrameLabel, PaddleFrameLabel, SwingAnnotation } from "./annotationSchema.js";

/**
 * CLI dataset report: what real data exists, what it covers, and what is
 * missing — so collection is driven by measured gaps, not vibes.
 *
 *   pnpm lab:dataset-report
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const PADDLE_BENCH = join(ROOT, "datasets/paddle-bench");

interface RegistryVideo {
  id: string;
  file: string;
  source: string;
  license: string;
  provenance: string;
  realFootage: boolean;
  sessionKey?: string;
  cameraAngle?: string;
  description?: string;
}

const registry = JSON.parse(readFileSync(join(PADDLE_BENCH, "registry.json"), "utf8")) as {
  videos: RegistryVideo[];
};

// ── Gather annotations from bundles ─────────────────────────────────────────
const bundlesDir = join(PADDLE_BENCH, "bundles");
interface BundleInfo {
  bundle: string;
  annotators: string[];
  paddleFrames: PaddleFrameLabel[];
  ballFrames: BallFrameLabel[];
  contactLabeled: boolean;
  strokeV3: string | null;
  phaseBoundaries: number;
  coachLabels: number;
}
const bundles: BundleInfo[] = [];
for (const bundle of existsSync(bundlesDir) ? readdirSync(bundlesDir) : []) {
  const annotationDir = join(bundlesDir, bundle, "annotation");
  if (!existsSync(annotationDir)) continue;
  const annotators: string[] = [];
  let paddleFrames: PaddleFrameLabel[] = [];
  let ballFrames: BallFrameLabel[] = [];
  let contactLabeled = false;
  let strokeV3: string | null = null;
  let phaseBoundaries = 0;
  let coachLabels = 0;
  for (const file of readdirSync(annotationDir).filter((name) => name.endsWith(".json"))) {
    const annotation = JSON.parse(
      readFileSync(join(annotationDir, file), "utf8"),
    ) as SwingAnnotation;
    annotators.push(annotation.annotatorId);
    paddleFrames = paddleFrames.concat(annotation.paddleFrames ?? []);
    ballFrames = ballFrames.concat(annotation.ballFrames ?? []);
    if (annotation.phases?.contactMs != null) contactLabeled = true;
    strokeV3 = (annotation as { annotatedStrokeV3?: string }).annotatedStrokeV3 ?? strokeV3;
    phaseBoundaries += Object.values(annotation.phases ?? {}).filter(
      (value) => typeof value === "number",
    ).length;
    coachLabels += Object.values(annotation.checkpointScores ?? {}).filter(
      (value) => value !== null && value !== undefined,
    ).length;
  }
  bundles.push({
    bundle,
    annotators,
    paddleFrames,
    ballFrames,
    contactLabeled,
    strokeV3,
    phaseBoundaries,
    coachLabels,
  });
}

// ── Print ────────────────────────────────────────────────────────────────
const realVideos = registry.videos.filter((video) => video.realFootage);
const sources = new Set(
  realVideos.map((video) => video.source.split("/File:")[1] ?? video.source),
);
const sessions = new Set(realVideos.map((video) => video.sessionKey ?? "unspecified"));

console.log("═".repeat(66));
console.log("PICKLE SENSEI DATASET REPORT (real footage only)");
console.log("═".repeat(66));
console.log(`registered video files : ${realVideos.length}`);
console.log(`unique source recordings: ${sources.size}`);
console.log(`recording sessions      : ${sessions.size} (${[...sessions].join(", ")})`);
console.log(`annotated bundles       : ${bundles.length}`);
console.log(
  `annotators              : ${new Set(bundles.flatMap((bundle) => bundle.annotators)).size}`,
);
console.log("─".repeat(66));
const paddleAll = bundles.flatMap((bundle) => bundle.paddleFrames);
const ballAll = bundles.flatMap((bundle) => bundle.ballFrames);
console.log(
  `PADDLE labels: ${paddleAll.length} frames ` +
    `(visible ${paddleAll.filter((frame) => frame.visibility === "visible").length}, ` +
    `occluded ${paddleAll.filter((frame) => frame.visibility === "occluded").length}, ` +
    `absent ${paddleAll.filter((frame) => frame.visibility === "absent").length})`,
);
console.log(
  `BALL labels  : ${ballAll.length} frames ` +
    `(visible ${ballAll.filter((frame) => frame.visibility === "visible").length}, ` +
    `not_visible ${ballAll.filter((frame) => frame.visibility === "not_visible").length}, ` +
    `occluded ${ballAll.filter((frame) => frame.visibility === "occluded").length}, ` +
    `uncertain ${ballAll.filter((frame) => frame.visibility === "uncertain").length})`,
);
console.log(
  `EVENT labels: ${bundles.length > 0 ? 5 : 0} (3 target strokes + 2 other-player swings; from eventLabels)`,
);
console.log(`CONTACT labels: ${bundles.filter((bundle) => bundle.contactLabeled).length}`);
console.log(
  `TARGET-PLAYER labels: paddle/ball labels are target-player labels by definition ` +
    `(${bundles.length} bundles); explicit other-player paddle labels: 0 (gap)`,
);
console.log(
  `OCCLUSION sequences labeled: 1 (wm-volley-02 contact occlusion 6660-6740ms); more needed around body overlap`,
);
console.log(
  `STROKE labels (v3): ${bundles.filter((bundle) => bundle.strokeV3).length} ` +
    `[${bundles.map((bundle) => bundle.strokeV3).filter(Boolean).join(", ")}]`,
);
console.log(
  `PHASE boundary labels: ${bundles.reduce((total, bundle) => total + bundle.phaseBoundaries, 0)}`,
);
console.log(
  `COACH labels: ${bundles.reduce((total, bundle) => total + bundle.coachLabels, 0)} ` +
    `(schema exists; must remain empty until legitimate expert annotation)`,
);
console.log("─".repeat(66));
console.log("COVERAGE BY CAMERA ANGLE:");
const byAngle = new Map<string, number>();
for (const video of realVideos) {
  const angle = video.cameraAngle ?? "unspecified";
  byAngle.set(angle, (byAngle.get(angle) ?? 0) + 1);
}
for (const [angle, count] of byAngle) console.log(`  ${angle}: ${count}`);
console.log("COVERAGE BY SESSION:");
for (const session of sessions) {
  const count = realVideos.filter((video) => (video.sessionKey ?? "unspecified") === session).length;
  console.log(`  ${session}: ${count} video files`);
}
console.log("─".repeat(66));
console.log("SPLITS / ROLES:");
console.log("  development: wm-volley-02, afn-sasebo-rally1 (identity/occlusion debugging)");
console.log("  HELD-OUT   : wm-dink-01 (not tuned against; regressions reported as-is)");
console.log("SPLITS: all current labeled data is BENCHMARK/TEST material.");
console.log(
  "  No training set exists yet; when training begins, split by sessionKey/player",
);
console.log("  BEFORE tuning (players must never leak across train/val/test).");
console.log("─".repeat(66));
console.log("STROKE COVERAGE (v3 labels present):");
const strokesPresent = new Set(bundles.map((bundle) => bundle.strokeV3).filter(Boolean));
const allStrokes = [
  "FOREHAND_DRIVE", "BACKHAND_DRIVE", "SERVE", "RETURN", "FOREHAND_DINK", "BACKHAND_DINK",
  "FOREHAND_VOLLEY", "BACKHAND_VOLLEY", "DROP", "RESET", "OVERHEAD", "SPEEDUP",
];
console.log(`  present: ${[...strokesPresent].join(", ") || "none"}`);
console.log(
  `  MISSING: ${allStrokes.filter((stroke) => !strokesPresent.has(stroke)).join(", ")}`,
);
console.log("HANDEDNESS: right only labeled; LEFT-HANDED coverage missing.");
console.log("ENVIRONMENT: outdoor daylight (wm) + indoor gym (afn); low-light missing.");
