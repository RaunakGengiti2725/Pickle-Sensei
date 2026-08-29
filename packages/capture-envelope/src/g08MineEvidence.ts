import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { evaluateCaptureEnvelope } from "./envelope.js";
import { measureClip, probeClipStream, type MeasureWindow } from "./clipProbe.js";
import { CAPTURE_ENVELOPE_THRESHOLDS_VERSION } from "./thresholds.js";
import {
  computeBypassSignals,
  G08_SIGNALS_VERSION,
  type G08BypassSignals,
} from "./g08EvidenceSignals.js";
import { G08_BYPASS_FAMILIES, type G08BypassFamily } from "./g08LabelSchema.js";

/**
 * g08-f22-evidence miner: scan the legal on-disk corpus for NATURAL windows
 * resembling each label-dependent F22 bypass family and emit a review pack
 * for human labeling.
 *
 * Corpus scope (legal to open on this machine):
 *  - committed paddle-bench bundle clips EXCLUDING held-out cases
 *    (wm-dink-01, afn-vic-rally1 are never opened)
 *  - datasets/pickleball/dev-pool (dev_label_eligible per f11 intake)
 *  - datasets/ood/negatives (real rights-cleared footage; capture-quality
 *    review is permitted — the d08 policy forbids stroke/contact/ownership
 *    annotation, not capture-quality judgment)
 * Excluded:
 *  - datasets/pickleball/fresh-candidates (label-blind holdout candidates)
 *  - datasets/ood/derived (synthetic, not natural examples)
 *  - corpus recordings in datasets/corpus/recordings.json (media absent on
 *    this machine; gitignored run dirs)
 *
 * All candidates are Tier-C machine proposals. Ranking signals are mining
 * heuristics only; truth comes exclusively from the human label file.
 *
 * Usage: pnpm --filter @pickle/capture-envelope mine:g08
 * Output: datasets/experiments/wave-g/g08-review-pack.json
 *         datasets/experiments/wave-g/g08-review-frames/<candidateId>-*.jpg
 */

const repoRoot = resolve(import.meta.dirname, "../../..");
const outDir = join(repoRoot, "datasets", "experiments", "wave-g");
const framesDir = join(outDir, "g08-review-frames");
mkdirSync(framesDir, { recursive: true });

const HELD_OUT_CASES = new Set(["wm-dink-01", "afn-vic-rally1"]);
const WINDOW_MS = 4000;
const STEP_MS = 2000;
const TOP_K_PER_FAMILY = 6;
const MAX_PER_CLIP_PER_FAMILY = 2;
const REVIEW_FRAMES_PER_CANDIDATE = 3;

interface CorpusClip {
  clipId: string;
  clip: string;
  sessionKey: string;
  role: "bundle_clip" | "dev_pool" | "ood_negative";
}

const clips: CorpusClip[] = [];

const bundlesDir = join(repoRoot, "datasets", "paddle-bench", "bundles");
for (const entry of readdirSync(bundlesDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || HELD_OUT_CASES.has(entry.name)) continue;
  const clipPath = join(bundlesDir, entry.name, "clip.mp4");
  if (!existsSync(clipPath)) continue;
  clips.push({
    clipId: `bundle:${entry.name}`,
    clip: `datasets/paddle-bench/bundles/${entry.name}/clip.mp4`,
    sessionKey: entry.name.startsWith("afn-sasebo") ? "afn-sasebo-2025" : `bundle-${entry.name}`,
    role: "bundle_clip",
  });
}

const devPoolDir = join(repoRoot, "datasets", "pickleball", "dev-pool");
if (existsSync(devPoolDir)) {
  for (const name of readdirSync(devPoolDir)
    .filter((n) => n.endsWith(".mp4"))
    .sort()) {
    const id = name.replace(/\.mp4$/, "");
    clips.push({
      clipId: `devpool:${id}`,
      clip: `datasets/pickleball/dev-pool/${name}`,
      sessionKey: `devpool-${id}`,
      role: "dev_pool",
    });
  }
}

const oodDir = join(repoRoot, "datasets", "ood", "negatives");
if (existsSync(oodDir)) {
  for (const name of readdirSync(oodDir)
    .filter((n) => n.endsWith(".mp4"))
    .sort()) {
    const id = name.replace(/\.mp4$/, "");
    clips.push({
      clipId: `ood:${id}`,
      clip: `datasets/ood/negatives/${name}`,
      sessionKey: `ood-${id}`,
      role: "ood_negative",
    });
  }
}

interface WindowRow {
  clipId: string;
  clip: string;
  sessionKey: string;
  role: CorpusClip["role"];
  windowMs: { startMs: number; durationMs: number };
  signals: G08BypassSignals;
  envelopeOverall: string;
  envelopeFlaggedDimensions: string[];
}

const rows: WindowRow[] = [];
for (const clip of clips) {
  const clipPath = join(repoRoot, clip.clip);
  const info = probeClipStream(clipPath);
  const windows: MeasureWindow[] = [];
  if (info.durationMs <= WINDOW_MS) {
    windows.push({ startMs: 0, durationMs: info.durationMs });
  } else {
    for (let start = 0; start + WINDOW_MS <= info.durationMs; start += STEP_MS) {
      windows.push({ startMs: start, durationMs: WINDOW_MS });
    }
  }
  for (const window of windows) {
    const signals = computeBypassSignals(clipPath, window);
    if (signals.sampledFrameCount < 3) continue;
    const verdict = evaluateCaptureEnvelope(measureClip(clipPath, window));
    rows.push({
      clipId: clip.clipId,
      clip: clip.clip,
      sessionKey: clip.sessionKey,
      role: clip.role,
      windowMs: window,
      signals,
      envelopeOverall: verdict.overall,
      envelopeFlaggedDimensions: verdict.dimensions
        .filter((d) => d.status === "DEGRADED" || d.status === "UNSUPPORTED")
        .map((d) => `${d.dimension}:${d.status}`),
    });
  }
  process.stderr.write(`measured ${clip.clipId}: ${windows.length} windows\n`);
}

/** Family ranking definitions: score + direction. Higher score = stronger
 * resemblance; rows without the needed signal are excluded from the family. */
const FAMILY_SCORES: Record<G08BypassFamily, (r: WindowRow) => number | null> = {
  blur_masked_by_noise: (r) =>
    r.signals.grainSharpnessRatio !== null ? -r.signals.grainSharpnessRatio : null,
  bimodal_exposure: (r) => r.signals.bimodalClipScore,
  strobing_exposure: (r) => r.signals.temporalLumaStd,
  upscaled_content: (r) => (r.signals.hfEnergyRatio !== null ? -r.signals.hfEnergyRatio : null),
  tiny_subject: (r) =>
    r.signals.motionHeightFraction !== null &&
    r.signals.motionCoverage !== null &&
    r.signals.motionCoverage > 0.001
      ? -r.signals.motionHeightFraction
      : null,
  camera_shake: (r) => r.signals.globalShakeScore,
};

interface Candidate {
  candidateId: string;
  family: G08BypassFamily;
  rank: number;
  tier: "TIER_C_MACHINE_PROPOSED";
  clipId: string;
  clip: string;
  sessionKey: string;
  role: CorpusClip["role"];
  windowMs: { startMs: number; durationMs: number };
  rankingScore: number;
  signals: G08BypassSignals;
  envelopeOverall: string;
  envelopeFlaggedDimensions: string[];
  reviewFrames: string[];
  renderCommand: string;
}

const candidates: Candidate[] = [];
for (const family of G08_BYPASS_FAMILIES) {
  const scored = rows
    .map((row) => ({ row, score: FAMILY_SCORES[family](row) }))
    .filter((x): x is { row: WindowRow; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score);
  const perClip = new Map<string, number>();
  let rank = 0;
  for (const { row, score } of scored) {
    if (rank >= TOP_K_PER_FAMILY) break;
    const used = perClip.get(row.clipId) ?? 0;
    if (used >= MAX_PER_CLIP_PER_FAMILY) continue;
    perClip.set(row.clipId, used + 1);
    rank += 1;
    const candidateId = `g08-${family}-${String(rank).padStart(2, "0")}`;
    const frames: string[] = [];
    for (let i = 0; i < REVIEW_FRAMES_PER_CANDIDATE; i += 1) {
      const tMs =
        row.windowMs.startMs + ((i + 0.5) * row.windowMs.durationMs) / REVIEW_FRAMES_PER_CANDIDATE;
      const frameName = `${candidateId}-f${i + 1}.jpg`;
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-ss",
        (tMs / 1000).toFixed(3),
        "-i",
        join(repoRoot, row.clip),
        "-frames:v",
        "1",
        "-vf",
        "scale=320:-2",
        "-q:v",
        "6",
        join(framesDir, frameName),
      ]);
      frames.push(`datasets/experiments/wave-g/g08-review-frames/${frameName}`);
    }
    candidates.push({
      candidateId,
      family,
      rank,
      tier: "TIER_C_MACHINE_PROPOSED",
      clipId: row.clipId,
      clip: row.clip,
      sessionKey: row.sessionKey,
      role: row.role,
      windowMs: row.windowMs,
      rankingScore: score,
      signals: row.signals,
      envelopeOverall: row.envelopeOverall,
      envelopeFlaggedDimensions: row.envelopeFlaggedDimensions,
      reviewFrames: frames,
      renderCommand: `ffplay -ss ${(row.windowMs.startMs / 1000).toFixed(3)} -t ${(row.windowMs.durationMs / 1000).toFixed(3)} ${row.clip}`,
    });
  }
}

const pack = {
  reviewPack:
    "g08-f22-evidence review pack — Tier-C machine-proposed candidates for HUMAN capture-quality labeling of the label-dependent F22 bypass families",
  generatedBy: "packages/capture-envelope/src/g08MineEvidence.ts",
  date: new Date().toISOString().slice(0, 10),
  commit: execSync("git rev-parse HEAD", { cwd: repoRoot }).toString().trim(),
  signalsVersion: G08_SIGNALS_VERSION,
  thresholdsVersion: CAPTURE_ENVELOPE_THRESHOLDS_VERSION,
  tierStatement:
    "Every candidate here is a machine proposal (Tier-C). Nothing in this file is truth. Truth is exclusively human labels in g08-labels.json per g08-f22-evidence-labels-v1.",
  corpusScope: {
    clips: clips.map((c) => ({ clipId: c.clipId, clip: c.clip, role: c.role })),
    heldOutExcluded: [...HELD_OUT_CASES],
    freshCandidatesExcluded: "label-blind holdout candidates; never opened here",
    oodDerivedExcluded: "synthetic derivations, not natural examples",
    corpusRecordingsExcluded: "media absent on this machine (gitignored)",
  },
  windowing: {
    windowMs: WINDOW_MS,
    stepMs: STEP_MS,
    note: "clips shorter than one window measured whole",
  },
  ranking: {
    topKPerFamily: TOP_K_PER_FAMILY,
    maxPerClipPerFamily: MAX_PER_CLIP_PER_FAMILY,
    perFamilySignal: {
      blur_masked_by_noise: "ascending grainSharpnessRatio",
      bimodal_exposure: "descending bimodalClipScore",
      strobing_exposure: "descending temporalLumaStd",
      upscaled_content: "ascending hfEnergyRatio (display width >= 1280 only)",
      tiny_subject: "ascending motionHeightFraction (motionCoverage > 0.001)",
      camera_shake: "descending globalShakeScore",
    },
  },
  windowsMeasured: rows.length,
  candidates,
};

writeFileSync(join(outDir, "g08-review-pack.json"), `${JSON.stringify(pack, null, 2)}\n`);
process.stderr.write(
  `wrote g08-review-pack.json: ${candidates.length} candidates from ${rows.length} windows over ${clips.length} clips\n`,
);
