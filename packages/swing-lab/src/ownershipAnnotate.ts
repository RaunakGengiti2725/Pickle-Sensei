import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "./engine/corpus.js";
import {
  validateAnnotation,
  type SwingAnnotation,
  type PaddleFrameLabel,
} from "./annotationSchema.js";

/**
 * PADDLE OWNERSHIP ANNOTATION — prelabel-assisted, human-decided.
 *
 *   pnpm lab:own propose [--per-case N]   # pick dual-detection frames, render numbered boxes
 *   pnpm lab:own apply <verdicts.json>    # write human verdicts into bundle annotations
 *
 * The S3 ownership stage is the measured quality catastrophe (R .22 vs .96
 * oracle) and every ownership experiment so far was validated on FOUR dual
 * frames. This tool turns D-FINE detections (S0 recall 1.0 on visible
 * paddles) into candidate geometry so the human only decides OWNERSHIP:
 *
 *   verdict per numbered box: target | other | reject | ambiguous
 *
 * target/other → paddleFrames/otherPaddleFrames GOLD labels (point = box
 * center). reject → not a paddle (hard negative, kept in review sidecar).
 * ambiguous → legitimate truth, kept in sidecar, excluded from P/R.
 * Every applied file passes validateAnnotation and bumps revision.
 */

const PB = join(REPO_ROOT, "datasets/paddle-bench");
const REVIEW_DIR = join(PB, "ownership-review");

interface DetFrame {
  tMs: number;
  detections: Array<{ box: [number, number, number, number]; score: number; label: string }>;
}
interface DetsFile {
  video: { width: number; height: number };
  frames: DetFrame[];
}
interface BenchCase {
  id: string;
  video: string;
  labels: string;
  runDir: string;
  role?: string;
}

function loadBench(): BenchCase[] {
  return (JSON.parse(readFileSync(join(PB, "paddle-bench.json"), "utf8")) as { cases: BenchCase[] })
    .cases;
}

interface QueueFrame {
  caseId: string;
  tMs: number;
  videoPath: string;
  videoSize: { width: number; height: number };
  boxes: Array<{ index: number; boxPx: [number, number, number, number]; score: number }>;
  png: string;
}

function propose(perCase: number): void {
  mkdirSync(REVIEW_DIR, { recursive: true });
  const queue: QueueFrame[] = [];
  for (const benchCase of loadBench()) {
    const detsPath = join(
      PB,
      benchCase.runDir.replace(/^datasets\/paddle-bench\//, ""),
      "paddle-dets.json",
    );
    const resolvedDets = existsSync(detsPath)
      ? detsPath
      : resolve(PB, benchCase.runDir, "paddle-dets.json");
    if (!existsSync(resolvedDets)) continue;
    const dets = JSON.parse(readFileSync(resolvedDets, "utf8")) as DetsFile;
    const annotation = JSON.parse(
      readFileSync(resolve(PB, benchCase.labels), "utf8"),
    ) as SwingAnnotation;
    const alreadyLabeled = new Set(
      [...(annotation.paddleFrames ?? []), ...(annotation.otherPaddleFrames ?? [])].map((frame) =>
        Math.round(frame.tMs),
      ),
    );
    // Frames with ≥2 confident, spatially distinct detections = dual-paddle
    // candidates (the wrong-player measurement needs BOTH visible).
    const candidates = dets.frames
      .map((frame) => ({
        tMs: frame.tMs,
        boxes: frame.detections
          .filter((detection) => detection.score >= 0.3)
          .slice(0, 4)
          .filter((detection, index, list) =>
            list.every(
              (other, otherIndex) =>
                otherIndex >= index || boxDistance(detection.box, other.box) > 40,
            ),
          ),
      }))
      .filter((frame) => frame.boxes.length >= 2)
      .filter((frame) => !alreadyLabeled.has(Math.round(frame.tMs)));
    // Space them ≥400ms so labels aren't near-duplicates.
    const spaced: typeof candidates = [];
    for (const frame of candidates) {
      if (spaced.length === 0 || frame.tMs - spaced[spaced.length - 1]!.tMs >= 400)
        spaced.push(frame);
      if (spaced.length >= perCase) break;
    }
    const videoPath = resolve(PB, benchCase.video);
    for (const frame of spaced) {
      // Box index is encoded by COLOR (this ffmpeg build lacks drawtext):
      // 0=yellow · 1=lime · 2=red · 3=cyan. A small solid tab above each box
      // repeats the color for visibility on busy backgrounds.
      const draw: string[] = [];
      for (const [index, detection] of frame.boxes.entries()) {
        const [x0, y0, x1, y1] = detection.box;
        const color = ["yellow", "lime", "red", "cyan"][index % 4]!;
        draw.push(
          `drawbox=x=${Math.round(x0)}:y=${Math.round(y0)}:w=${Math.round(x1 - x0)}:h=${Math.round(y1 - y0)}:color=${color}@0.95:t=3`,
        );
        draw.push(
          `drawbox=x=${Math.round(x0)}:y=${Math.max(0, Math.round(y0) - 18)}:w=24:h=14:color=${color}@1:t=fill`,
        );
      }
      const png = join(REVIEW_DIR, `${benchCase.id}-${Math.round(frame.tMs)}.png`);
      execFileSync("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-ss",
        (frame.tMs / 1000).toFixed(3),
        "-i",
        videoPath,
        "-vf",
        draw.join(","),
        "-frames:v",
        "1",
        png,
      ]);
      queue.push({
        caseId: benchCase.id,
        tMs: frame.tMs,
        videoPath,
        videoSize: dets.video,
        boxes: frame.boxes.map((detection, index) => ({
          index,
          boxPx: detection.box,
          score: detection.score,
        })),
        png: png.replace(`${REPO_ROOT}/`, ""),
      });
    }
  }
  writeFileSync(
    join(REVIEW_DIR, "queue.json"),
    JSON.stringify({ generatedAtIso: new Date().toISOString(), frames: queue }, null, 2),
  );
  console.log(
    `ownership queue: ${queue.length} dual-detection frames → ${REVIEW_DIR.replace(`${REPO_ROOT}/`, "")}`,
  );
  for (const frame of queue)
    console.log(
      `  ${frame.caseId} @ ${Math.round(frame.tMs)}ms · ${frame.boxes.length} boxes · ${frame.png}`,
    );
}

function boxDistance(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  return Math.hypot((a[0] + a[2]) / 2 - (b[0] + b[2]) / 2, (a[1] + a[3]) / 2 - (b[1] + b[3]) / 2);
}

interface Verdict {
  caseId: string;
  tMs: number;
  /** box index → target | other | reject | ambiguous */
  owners: Record<string, "target" | "other" | "reject" | "ambiguous">;
  note?: string;
}

function apply(verdictsPath: string): void {
  const queue = (
    JSON.parse(readFileSync(join(REVIEW_DIR, "queue.json"), "utf8")) as { frames: QueueFrame[] }
  ).frames;
  const verdicts = JSON.parse(readFileSync(verdictsPath, "utf8")) as Verdict[];
  const bench = loadBench();
  const review: Array<Verdict & { appliedAtIso: string }> = [];
  const byCase = new Map<string, Verdict[]>();
  for (const verdict of verdicts)
    byCase.set(verdict.caseId, [...(byCase.get(verdict.caseId) ?? []), verdict]);

  for (const [caseId, caseVerdicts] of byCase) {
    const benchCase = bench.find((entry) => entry.id === caseId);
    if (!benchCase) throw new Error(`unknown case ${caseId}`);
    const labelsPath = resolve(PB, benchCase.labels);
    const annotation = JSON.parse(readFileSync(labelsPath, "utf8")) as SwingAnnotation;
    annotation.paddleFrames ??= [];
    annotation.otherPaddleFrames ??= [];
    let added = 0;
    for (const verdict of caseVerdicts) {
      const queueFrame = queue.find(
        (frame) => frame.caseId === caseId && Math.round(frame.tMs) === Math.round(verdict.tMs),
      );
      if (!queueFrame) throw new Error(`${caseId}@${verdict.tMs}: not in queue`);
      for (const [indexRaw, owner] of Object.entries(verdict.owners)) {
        const box = queueFrame.boxes.find((entry) => entry.index === Number(indexRaw));
        if (!box) throw new Error(`${caseId}@${verdict.tMs}: box ${indexRaw} missing`);
        if (owner === "reject" || owner === "ambiguous") continue;
        const label: PaddleFrameLabel = {
          tMs: queueFrame.tMs,
          point: {
            x: Number(((box.boxPx[0] + box.boxPx[2]) / 2 / queueFrame.videoSize.width).toFixed(4)),
            y: Number(((box.boxPx[1] + box.boxPx[3]) / 2 / queueFrame.videoSize.height).toFixed(4)),
          },
          visibility: "visible",
        };
        (owner === "target" ? annotation.paddleFrames : annotation.otherPaddleFrames)!.push(label);
        added += 1;
      }
      review.push({ ...verdict, appliedAtIso: new Date().toISOString() });
    }
    annotation.paddleFrames.sort((a, b) => a.tMs - b.tMs);
    annotation.otherPaddleFrames.sort((a, b) => a.tMs - b.tMs);
    annotation.revision += 1;
    annotation.history = [
      ...(annotation.history ?? []),
      { revision: annotation.revision, savedAtIso: new Date().toISOString() },
    ];
    const problems = validateAnnotation(annotation);
    if (problems.length > 0)
      throw new Error(`${caseId}: annotation invalid after apply: ${problems.join("; ")}`);
    writeFileSync(labelsPath, JSON.stringify(annotation, null, 2));
    console.log(`✓ ${caseId}: +${added} ownership labels (revision ${annotation.revision})`);
  }
  const sidecar = join(REVIEW_DIR, "ownership-review.json");
  const existing = existsSync(sidecar)
    ? (JSON.parse(readFileSync(sidecar, "utf8")) as unknown[])
    : [];
  writeFileSync(sidecar, JSON.stringify([...existing, ...review], null, 2));
  console.log(`review provenance appended → ${sidecar.replace(`${REPO_ROOT}/`, "")}`);
}

const isMain = process.argv[1]?.endsWith("ownershipAnnotate.ts");
if (isMain) {
  const mode = process.argv[2];
  const flag = (name: string) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? (process.argv[index + 1] ?? null) : null;
  };
  if (mode === "propose") propose(Number(flag("--per-case") ?? 8));
  else if (mode === "apply" && process.argv[3]) apply(resolve(process.argv[3]!));
  else {
    console.error("usage: pnpm lab:own <propose [--per-case N] | apply <verdicts.json>>");
    process.exit(2);
  }
}
