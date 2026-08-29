import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPlayerTracks,
  initializeTargetFromSeed,
  type PeopleFile,
} from "./playerTracker.js";

/**
 * BENCH REGEN — versioned, reproducible regeneration of the gold-case run
 * artifacts that every bench (cascade, stroke, paddle, ball) reads.
 *
 *   pnpm lab:regen             # derive + verify the manifest (no reruns)
 *   pnpm lab:regen --exec all  # rerun lab:analyze for every case
 *   pnpm lab:regen --exec afn-sasebo-rally2 [ids…]
 *
 * WHY: the canonical runs were produced with ad-hoc `--target-tap x,y`
 * invocations that were never versioned — so nobody could regenerate a
 * report after a code change without guessing the tap. This tool derives
 * the tap FROM the existing canonical run (the target track's early torso
 * center), verifies the seed re-selects the same track, and freezes the
 * exact CLI per case in datasets/paddle-bench/regen-manifest.json.
 *
 * The manifest is derivation, not tuning: it reproduces the SAME target
 * identity the frozen reports already used.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const PB = join(REPO_ROOT, "datasets/paddle-bench");
const MANIFEST_PATH = join(PB, "regen-manifest.json");

interface ManifestEntry {
  id: string;
  video: string;
  stroke: string;
  outDir: string;
  targetTap: { x: number; y: number };
  expectedTargetTrackId: number;
  extraFlags: string[];
}

function deriveManifest(): ManifestEntry[] {
  const bench = (
    JSON.parse(readFileSync(join(PB, "paddle-bench.json"), "utf8")) as {
      cases: Array<{ id: string; video: string; runDir: string }>;
    }
  ).cases;
  const entries: ManifestEntry[] = [];
  for (const benchCase of bench) {
    const runDir = resolve(PB, benchCase.runDir);
    const report = JSON.parse(readFileSync(join(runDir, "report.json"), "utf8")) as {
      stroke: string;
      player?: { targetTrackId?: number };
    };
    const targetTrackId = report.player?.targetTrackId;
    if (targetTrackId === undefined) {
      console.error(`${benchCase.id}: no targetTrackId in canonical report — skipped`);
      continue;
    }
    const people = JSON.parse(readFileSync(join(runDir, "people.json"), "utf8")) as PeopleFile;
    const tracks = buildPlayerTracks(people);
    const target = tracks.find((track) => track.trackId === targetTrackId);
    if (!target) {
      console.error(`${benchCase.id}: track ${targetTrackId} not rebuilt from people.json — skipped`);
      continue;
    }
    // Try early-frame torso centers until the seed provably re-selects the
    // canonical track (the seed resolver uses the early-window median frame).
    const clipStart = target.frames[0]!.timestampMs;
    const early = target.frames.filter((frame) => frame.timestampMs <= clipStart + 1200);
    const candidates = [early[Math.floor(early.length / 2)], ...early].filter(
      (frame): frame is NonNullable<typeof frame> => !!frame,
    );
    let tap: { x: number; y: number } | null = null;
    for (const frame of candidates) {
      const seeded = initializeTargetFromSeed(tracks, {
        mode: "user_tapped_person",
        point: { x: frame.torsoMid.x, y: frame.torsoMid.y },
      });
      if (seeded.ok && seeded.value.identity.trackId === targetTrackId) {
        tap = { x: frame.torsoMid.x, y: frame.torsoMid.y };
        break;
      }
    }
    if (!tap) {
      console.error(`${benchCase.id}: NO tap point re-selects track ${targetTrackId} — needs human attention`);
      continue;
    }
    entries.push({
      id: benchCase.id,
      video: resolve(PB, benchCase.video),
      stroke: report.stroke,
      outDir: runDir,
      targetTap: { x: Number(tap.x.toFixed(4)), y: Number(tap.y.toFixed(4)) },
      expectedTargetTrackId: targetTrackId,
      extraFlags: [],
    });
    console.log(
      `${benchCase.id}: tap (${tap.x.toFixed(3)}, ${tap.y.toFixed(3)}) → track ${targetTrackId} ✓`,
    );
  }
  return entries;
}

export function regenCase(entry: ManifestEntry, flags: string[] = []): void {
  const args = [
    "src/analyzeVideo.ts",
    entry.video,
    "--stroke",
    entry.stroke,
    "--target-tap",
    `${entry.targetTap.x},${entry.targetTap.y}`,
    "--out",
    entry.outDir,
    "--reuse-extract",
    ...entry.extraFlags,
    ...flags,
  ];
  console.log(`\n── regen ${entry.id}: tsx ${args.join(" ")}`);
  execFileSync("npx", ["tsx", ...args], {
    cwd: join(REPO_ROOT, "packages/swing-lab"),
    stdio: "inherit",
  });
  const report = JSON.parse(readFileSync(join(entry.outDir, "report.json"), "utf8")) as {
    player?: { targetTrackId?: number };
  };
  if (report.player?.targetTrackId !== entry.expectedTargetTrackId) {
    throw new Error(
      `${entry.id}: regenerated targetTrackId ${report.player?.targetTrackId} ≠ expected ${entry.expectedTargetTrackId}`,
    );
  }
}

const isMain = process.argv[1]?.endsWith("benchRegen.ts");
if (isMain) {
  const argv = process.argv.slice(2);
  let manifest: ManifestEntry[];
  if (existsSync(MANIFEST_PATH) && !argv.includes("--rederive")) {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as ManifestEntry[];
    console.log(`manifest loaded (${manifest.length} cases) — pass --rederive to rebuild`);
  } else {
    manifest = deriveManifest();
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
    console.log(`written: ${MANIFEST_PATH.replace(`${REPO_ROOT}/`, "")}`);
  }
  const execIndex = argv.indexOf("--exec");
  if (execIndex >= 0) {
    const wanted = argv.slice(execIndex + 1).filter((argument) => !argument.startsWith("--"));
    const targets =
      wanted.length === 0 || wanted[0] === "all"
        ? manifest
        : manifest.filter((entry) => wanted.includes(entry.id));
    const passthrough = argv.filter((argument) => argument === "--merge-tracklets" || argument === "--full-scan");
    for (const entry of targets) regenCase(entry, passthrough);
    console.log(`\nregenerated ${targets.length} case(s)`);
  }
}
