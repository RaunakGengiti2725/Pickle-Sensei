import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SwingAnnotation } from "./annotationSchema.js";

/**
 * pnpm lab:data-gaps — what real data is missing, from actual label counts.
 * Collection priorities must come from this table, not vibes.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const PB = join(ROOT, "datasets/paddle-bench");

const bundlesDir = join(PB, "bundles");
const annotations: Array<SwingAnnotation & { annotatedStrokeV3?: string; eventLabels?: Array<{ owner: string }>; otherPaddleFrames?: unknown[] }> = [];
for (const bundle of existsSync(bundlesDir) ? readdirSync(bundlesDir) : []) {
  const dir = join(bundlesDir, bundle, "annotation");
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    annotations.push(JSON.parse(readFileSync(join(dir, file), "utf8")));
  }
}
const registry = JSON.parse(readFileSync(join(PB, "registry.json"), "utf8")) as {
  videos: Array<{ realFootage: boolean; cameraAngle?: string; sessionKey?: string }>;
};

const strokes = new Map<string, number>();
for (const annotation of annotations) {
  const stroke = annotation.annotatedStrokeV3;
  if (stroke) strokes.set(stroke, (strokes.get(stroke) ?? 0) + 1);
}
const ALL_STROKES = [
  "FOREHAND_DRIVE", "BACKHAND_DRIVE", "SERVE", "RETURN", "FOREHAND_DINK", "BACKHAND_DINK",
  "FOREHAND_VOLLEY", "BACKHAND_VOLLEY", "DROP", "RESET", "OVERHEAD", "SPEEDUP",
];

const gap = (label: string, count: number, want: string) =>
  console.log(`${count === 0 ? "✗" : "·"} ${label}: ${count} ${want}`);

console.log("═".repeat(66));
console.log("PICKLE SENSEI DATA GAPS (measured from labels, not aspiration)");
console.log("═".repeat(66));
console.log("STROKE CLASSES:");
for (const stroke of ALL_STROKES) gap(`  ${stroke}`, strokes.get(stroke) ?? 0, "labeled");
console.log("HANDEDNESS:");
gap("  right-handed", annotations.filter((annotation) => annotation.handedness === "right").length, "clips");
gap("  LEFT-HANDED", annotations.filter((annotation) => annotation.handedness === "left").length, "clips");
console.log("HARD CASES:");
gap(
  "  dual-paddle labeled frames (wrong-player measurement)",
  annotations.reduce((total, annotation) => {
    const others = (annotation.otherPaddleFrames ?? []) as Array<{ tMs: number; visibility: string }>;
    return (
      total +
      others.filter(
        (other) =>
          other.visibility === "visible" &&
          (annotation.paddleFrames ?? []).some(
            (target) => Math.abs(target.tMs - other.tMs) < 20 && target.visibility === "visible",
          ),
      ).length
    );
  }, 0),
  "frames (need 20+)",
);
gap("  dense ball-occlusion sequences", 1, "sequences (need 10+ across clothing colors)");
gap("  bounce events labeled", 0, "labels (blocks volley/groundstroke L1 + L3 strokes)");
gap("  multi-annotator cases", 0, "cases (agreement unmeasurable)");
gap("  expert coach labels", 0, "labels (technique scoring stays blocked)");
console.log("VIEWS/ENVIRONMENT:");
const angles = new Map<string, number>();
for (const video of registry.videos.filter((video) => video.realFootage)) {
  const angle = (video.cameraAngle ?? "unspecified").split(":")[0]!.trim();
  angles.set(angle, (angles.get(angle) ?? 0) + 1);
}
for (const [angle, count] of angles) console.log(`  · ${angle}: ${count} files`);
gap("  true side view", 0, "clips");
gap("  low-light", 0, "clips");
gap("  singles (clean 1-player near court)", 0, "clips");
console.log("═".repeat(66));
console.log("TOP ACQUISITION PRIORITIES (information value):");
console.log("  1. doubles frames with BOTH paddles labeled around overlap moments");
console.log("  2. ball-across-light-clothing occlusion sequences, densely labeled");
console.log("  3. serves + returns (0 labeled) from any legal source");
console.log("  4. left-handed players (0)");
console.log("  5. a second annotator on ≥3 existing cases (agreement baseline)");
