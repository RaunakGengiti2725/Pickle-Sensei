import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PaddleFrameLabel } from "./annotationSchema.js";
import {
  buildPaddleTracks,
  mergePaddleTracklets,
  segmentTrackByWristOwnership,
  selectPrimaryPaddleTrack,
  TRACKER_GATES,
  wristSeries,
  type PaddleTrackCandidate,
  type RawPaddleDetectionFile,
  type TrackedPaddleObservation,
} from "./paddleTracker.js";
import {
  buildPlayerTracks,
  otherPlayersWrists,
  selectTargetPlayer,
  targetPoseSequence,
  type PeopleFile,
} from "./playerTracker.js";

/**
 * D4-01 — S4 SELECTION STRESS REPLAY on the expanded (wave C/D) gold.
 *
 * Replays the wave-B W1 segmented-selection code path
 * (selectPrimaryPaddleTrack + segmentTrackByWristOwnership, real functions,
 * never copies) against every paddle detection artifact reachable on this
 * Linux box, and accounts the S3→S4 loss waterfall per gold label:
 *
 *   S0 raw detections   any detection near the gold point (±40ms, r 0.08)
 *   S2 track formation  any merged track observation near the gold point
 *   S3 ownership        union of ownership-surviving tracks' KEPT segments
 *   S4 selection        the single selected track's kept observations
 *
 * Inputs per case family (all committed or reproducibly derived — see
 * datasets/experiments/wave-d4/d4-01-dets/PROVENANCE.md):
 *  - wavea-* cases: LINUX-CPU D-FINE detections regenerated from the
 *    SHA-256-verified corpus source videos over the committed
 *    runs-wave-a/<case>/window-meta.json windows; identity from the
 *    committed people.json (auto target policy); gold = the wave-C
 *    ownership annotation's paddleFrames (target-owned by construction).
 *  - core dev cases (afn-sasebo-rally1/rally2, wm-volley-02): committed
 *    baseline-rerun dets (wave-a H-logs). NO pose/people artifacts are
 *    committed for these cases, so wrists are EMPTY: ownership and
 *    flip-segmentation are structurally inert (disclosed as poseFree) —
 *    these rows measure the coverage×meanScore prior only.
 *  - held-out cases (wm-dink-01, afn-vic-rally1): NOT touched.
 *
 * Run:  cd packages/swing-lab && npx tsx src/paddleS4StressReplay.ts
 * Artifact: datasets/experiments/wave-d4/d4-01-s4-stress-replay.json
 */

const HIT_RADIUS = 0.08; // mirror paddleWaterfall.ts
const MATCH_TOLERANCE_MS = 40; // mirror paddleWaterfall.ts
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const PB = join(ROOT, "datasets/paddle-bench");
const WAVE_D4 = join(ROOT, "datasets/experiments/wave-d4");

interface CaseConfig {
  id: string;
  family: "wavea" | "core_dev";
  detsPath: string;
  peoplePath: string | null;
  window: { startMs: number; endMs: number } | null; // null → dets file window
  goldPath: string;
}

const CASES: CaseConfig[] = [
  ...[
    "wavea-944403-dink",
    "wavea-944403-smash",
    "wavea-faead-rally",
    "wavea-faead-feed",
    "wavea-marne-dig",
  ].map((id): CaseConfig => ({
    id,
    family: "wavea",
    detsPath: join(WAVE_D4, "d4-01-dets", `${id}-dets.json`),
    peoplePath: join(PB, "runs-wave-a", id, "people.json"),
    window: null,
    goldPath: join(PB, "bundles", id, "annotation", "devin-visual-v2-waveC-ownership.json"),
  })),
  ...["afn-sasebo-rally1", "afn-sasebo-rally2", "wm-volley-02"].map((id): CaseConfig => ({
    id,
    family: "core_dev",
    detsPath: join(ROOT, "datasets/experiments/wave-a/H-logs", `baseline-rerun-${id}-dets.json`),
    peoplePath: null,
    window: null,
    goldPath: join(PB, "bundles", id, "annotation", "devin-visual-v1.json"),
  })),
];

type Point = { x: number; y: number };

function hits(
  labels: readonly PaddleFrameLabel[],
  centers: ReadonlyArray<{ tMs: number } & Point>,
): number {
  let count = 0;
  for (const label of labels) {
    if (!label.point) continue;
    const near = centers.some(
      (center) =>
        Math.abs(center.tMs - label.tMs) <= MATCH_TOLERANCE_MS &&
        Math.hypot(center.x - label.point!.x, center.y - label.point!.y) <= HIT_RADIUS,
    );
    if (near) count += 1;
  }
  return count;
}

const observationCenters = (observations: readonly TrackedPaddleObservation[]) =>
  observations.map((observation) => ({
    tMs: observation.timestampMs,
    x: observation.center.x,
    y: observation.center.y,
  }));

/** Kept (post-flip-segmentation) observations of a candidate, exactly as the
 *  selector keeps them (real segmentTrackByWristOwnership call). */
function keptObservations(
  candidate: PaddleTrackCandidate,
  wrists: ReturnType<typeof wristSeries>,
  otherWrists: ReturnType<typeof wristSeries>,
  window: { startMs: number; endMs: number },
): TrackedPaddleObservation[] {
  if (otherWrists.length === 0) return [...candidate.observations];
  const segments = segmentTrackByWristOwnership(
    candidate.observations,
    wrists,
    otherWrists,
    window,
  );
  const mixed = segments.some((segment) => segment.sustainedFlipRun);
  const targetOwned = segments.filter((segment) => segment.ownedByTarget);
  if (mixed && targetOwned.length > 0)
    return targetOwned.flatMap((segment) => segment.observations);
  return [...candidate.observations];
}

/** Track-level ownership verdict over kept observations (selector math). */
function ownedByOtherPlayer(
  kept: readonly TrackedPaddleObservation[],
  wrists: ReturnType<typeof wristSeries>,
  otherWrists: ReturnType<typeof wristSeries>,
  window: { startMs: number; endMs: number },
): boolean {
  const inWindow = kept.filter(
    (observation) =>
      observation.timestampMs >= window.startMs && observation.timestampMs <= window.endMs,
  );
  const judged = inWindow.length > 0 ? inWindow : kept;
  const nearest = (series: ReturnType<typeof wristSeries>, timestampMs: number): Point[] | null => {
    let best: (typeof series)[number] | null = null;
    let bestDelta = Infinity;
    for (const entry of series) {
      const delta = Math.abs(entry.timestampMs - timestampMs);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = entry;
      }
    }
    return best && bestDelta <= 60 && best.wrists.length > 0 ? best.wrists : null;
  };
  const targetDistances: number[] = [];
  const otherDistances: number[] = [];
  for (const observation of judged) {
    const target = nearest(wrists, observation.timestampMs);
    if (target) {
      targetDistances.push(
        Math.min(
          ...target.map((wrist) =>
            Math.hypot(wrist.x - observation.center.x, wrist.y - observation.center.y),
          ),
        ),
      );
    }
    const other = nearest(otherWrists, observation.timestampMs);
    if (other) {
      otherDistances.push(
        Math.min(
          ...other.map((wrist) =>
            Math.hypot(wrist.x - observation.center.x, wrist.y - observation.center.y),
          ),
        ),
      );
    }
  }
  if (targetDistances.length === 0 || otherDistances.length === 0) return false;
  const mean = (values: readonly number[]) =>
    values.reduce((total, value) => total + value, 0) / values.length;
  return mean(otherDistances) < mean(targetDistances) * TRACKER_GATES.otherOwnershipFactor;
}

const isMain = process.argv[1]?.endsWith("paddleS4StressReplay.ts");
if (isMain) {
  interface CaseRow {
    id: string;
    family: string;
    poseFree: boolean;
    nGold: number;
    window: { startMs: number; endMs: number };
    tracks: { raw: number; merged: number };
    s4: { status: string; reason: string | null; winnerTrackId: number | null };
    waterfall: {
      s0Raw: number;
      s2Tracks: number;
      s3Ownership: number;
      s4Selected: number;
      s4SelectedFullTrack: number;
      lostAtSelection: number;
      lostToSegmentDeletion: number;
    };
    perLabel: Array<{
      tMs: number;
      s0: boolean;
      s2: boolean;
      s3: boolean;
      s4: boolean;
    }>;
  }

  const rows: CaseRow[] = [];
  for (const config of CASES) {
    if (!existsSync(config.detsPath)) {
      console.log(`SKIP ${config.id}: dets artifact absent (${config.detsPath})`);
      continue;
    }
    const dets = JSON.parse(readFileSync(config.detsPath, "utf8")) as RawPaddleDetectionFile;
    const window = config.window ?? dets.window;
    const gold = JSON.parse(readFileSync(config.goldPath, "utf8")) as {
      paddleFrames?: PaddleFrameLabel[];
    };
    const labels = (gold.paddleFrames ?? []).filter(
      (label) => label.visibility === "visible" && label.point,
    );
    if (labels.length === 0) {
      console.log(`SKIP ${config.id}: no visible gold paddleFrames in ${config.goldPath}`);
      continue;
    }

    let wrists: ReturnType<typeof wristSeries> = [];
    let otherWrists: ReturnType<typeof otherPlayersWrists> = [];
    if (config.peoplePath && existsSync(config.peoplePath)) {
      const people = JSON.parse(readFileSync(config.peoplePath, "utf8")) as PeopleFile;
      const playerTracks = buildPlayerTracks(people);
      const selection = selectTargetPlayer(playerTracks, { policy: "auto" }, null);
      if (selection.ok) {
        wrists = wristSeries(targetPoseSequence(people, selection.value.target));
        otherWrists = otherPlayersWrists(selection.value.allTracks, selection.value.target.trackId);
      }
    }
    const poseFree = wrists.length === 0;

    const rawTracks = buildPaddleTracks(dets, window);
    const { merged: candidates } = mergePaddleTracklets(rawTracks, window);
    const outcome = selectPrimaryPaddleTrack(candidates, wrists, window, otherWrists);

    // S0: every raw detection center (post size gates is S1; use truly raw).
    const { width, height } = dets.video;
    const rawCenters = dets.frames.flatMap((frame) =>
      frame.detections.map((detection) => ({
        tMs: frame.tMs,
        x: (detection.box[0] + detection.box[2]) / 2 / width,
        y: (detection.box[1] + detection.box[3]) / 2 / height,
      })),
    );

    // S3: kept observations of every candidate that survives ownership.
    const keptByTrack = candidates.map((candidate) => ({
      candidate,
      kept: keptObservations(candidate, wrists, otherWrists, window),
    }));
    const survivors = keptByTrack.filter(
      (entry) =>
        entry.kept.length >= TRACKER_GATES.minObservations &&
        !ownedByOtherPlayer(entry.kept, wrists, otherWrists, window),
    );

    // S4: the selector's actual pick, kept observations (outcome.lab) and
    // the same track's FULL observation list (segmentation-deletion delta).
    const winnerKept = outcome.status === "tracked" ? outcome.lab.observations : [];
    const winnerFull =
      outcome.status === "tracked"
        ? (candidates.find((candidate) => candidate.trackId === outcome.lab.trackId)
            ?.observations ?? [])
        : [];

    const s3Centers = survivors.flatMap((entry) => observationCenters(entry.kept));
    const perLabel = labels.map((label) => ({
      tMs: label.tMs,
      s0: hits([label], rawCenters) === 1,
      s2:
        hits(
          [label],
          candidates.flatMap((candidate) => observationCenters(candidate.observations)),
        ) === 1,
      s3: hits([label], s3Centers) === 1,
      s4: hits([label], observationCenters(winnerKept)) === 1,
    }));

    const row: CaseRow = {
      id: config.id,
      family: config.family,
      poseFree,
      nGold: labels.length,
      window,
      tracks: { raw: rawTracks.length, merged: candidates.length },
      s4: {
        status: outcome.status,
        reason: outcome.status === "untracked" ? outcome.reason : null,
        winnerTrackId: outcome.status === "tracked" ? outcome.lab.trackId : null,
      },
      waterfall: {
        s0Raw: perLabel.filter((entry) => entry.s0).length,
        s2Tracks: perLabel.filter((entry) => entry.s2).length,
        s3Ownership: perLabel.filter((entry) => entry.s3).length,
        s4Selected: perLabel.filter((entry) => entry.s4).length,
        s4SelectedFullTrack: hits(labels, observationCenters(winnerFull)),
        lostAtSelection:
          perLabel.filter((entry) => entry.s3).length - perLabel.filter((entry) => entry.s4).length,
        lostToSegmentDeletion:
          hits(labels, observationCenters(winnerFull)) -
          perLabel.filter((entry) => entry.s4).length,
      },
      perLabel,
    };
    rows.push(row);
  }

  // ── console report ──────────────────────────────────────────────────────
  console.log(
    "D4-01 S3→S4 LOSS WATERFALL (LINUX-CPU; wavea dets regenerated, core dets committed)",
  );
  console.log(
    "case                    fam      pose  n   S0  S2  S3  S4  lostSel  segDel  s4status",
  );
  const totals = { wavea: { n: 0, s3: 0, s4: 0 }, core_dev: { n: 0, s3: 0, s4: 0 } };
  for (const row of rows) {
    console.log(
      `${row.id.padEnd(24)}${row.family.padEnd(9)}${(row.poseFree ? "FREE" : "yes").padEnd(6)}` +
        `${String(row.nGold).padEnd(4)}${String(row.waterfall.s0Raw).padEnd(4)}` +
        `${String(row.waterfall.s2Tracks).padEnd(4)}${String(row.waterfall.s3Ownership).padEnd(4)}` +
        `${String(row.waterfall.s4Selected).padEnd(4)}${String(row.waterfall.lostAtSelection).padEnd(9)}` +
        `${String(row.waterfall.lostToSegmentDeletion).padEnd(8)}` +
        `${row.s4.status}${row.s4.reason ? ` (${row.s4.reason})` : ""}`,
    );
    const bucket = totals[row.family as "wavea" | "core_dev"];
    bucket.n += row.nGold;
    bucket.s3 += row.waterfall.s3Ownership;
    bucket.s4 += row.waterfall.s4Selected;
  }
  for (const [family, bucket] of Object.entries(totals)) {
    if (bucket.n === 0) continue;
    console.log(
      `TOTAL ${family}: S3 ${bucket.s3}/${bucket.n} → S4 ${bucket.s4}/${bucket.n} ` +
        `(lost at selection: ${bucket.s3 - bucket.s4})`,
    );
  }

  mkdirSync(WAVE_D4, { recursive: true });
  const artifactPath = join(WAVE_D4, "d4-01-s4-stress-replay.json");
  writeFileSync(
    artifactPath,
    JSON.stringify(
      {
        tool: "paddleS4StressReplay (D4-01)",
        generatedAtIso: new Date().toISOString(),
        measurementLabel: "LINUX-CPU",
        hitRadius: HIT_RADIUS,
        matchToleranceMs: MATCH_TOLERANCE_MS,
        notes: [
          "wavea dets regenerated on Linux CPU from SHA-256-verified corpus sources over committed window-meta windows",
          "core_dev rows are pose-free (no committed pose/people): ownership + flip-segmentation structurally inert, disclosed",
          "held-out cases untouched",
        ],
        cases: rows,
        totals,
      },
      null,
      2,
    ),
  );
  console.log(`written: ${artifactPath}`);
}
