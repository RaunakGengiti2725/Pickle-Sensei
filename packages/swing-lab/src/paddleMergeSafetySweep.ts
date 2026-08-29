import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPaddleTracks, type RawPaddleDetectionFile } from "./paddleTracker.js";
import {
  MERGE_SAFETY_VERSION,
  sweepMergeCandidates,
  type MergeSafetyVerdict,
} from "./paddleMergeSafety.js";

/**
 * CORPUS SWEEP — merge-candidate safety over COMMITTED paddle-track
 * artifacts (`pnpm --filter @pickle/swing-lab merge:safety`).
 *
 * Canonical run dirs (datasets/paddle-bench/runs/) are gitignored and pose
 * extraction is Apple-Vision-only, so this sweep runs against the raw
 * detector artifacts that ARE committed and carries no wrist series: every
 * ownership-dependent check is honestly UNKNOWN here, which the classifier
 * treats as not-safe. Event peaks come from the committed selection
 * forensics artifact where the case is one of the five forensics cases.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

/** Stroke windows + event peaks measured in the committed forensics
 *  artifact (datasets/experiments/wave-a/B-selection-forensics.json). */
const FORENSICS_PATH = join(REPO_ROOT, "datasets/experiments/wave-a/B-selection-forensics.json");

const ARTIFACTS: Array<{ caseId: string; path: string }> = [
  {
    caseId: "afn-sasebo-rally1",
    path: "datasets/experiments/wave-a/H-logs/baseline-rerun-afn-sasebo-rally1-dets.json",
  },
  {
    caseId: "afn-sasebo-rally2",
    path: "datasets/experiments/wave-a/H-logs/baseline-rerun-afn-sasebo-rally2-dets.json",
  },
  {
    caseId: "wm-volley-02",
    path: "datasets/experiments/wave-a/H-logs/baseline-rerun-wm-volley-02-dets.json",
  },
  {
    caseId: "afn-sasebo-rally2",
    path: "datasets/experiments/wave-a/P-runs/P-detector-fresh1.json",
  },
  {
    caseId: "afn-sasebo-rally2",
    path: "datasets/experiments/wave-a/P-runs/P-detector-fresh2-warm.json",
  },
  {
    caseId: "afn-sasebo-rally2",
    path: "datasets/experiments/wave-a/P-runs/P-detector-fresh3-hfoffline.json",
  },
];

interface ForensicsFile {
  cases: Array<{
    id: string;
    window: { startMs: number; endMs: number; peakMotionMs: number };
  }>;
}

function main(): void {
  const forensics = JSON.parse(readFileSync(FORENSICS_PATH, "utf8")) as ForensicsFile;
  const forensicsByCase = new Map(forensics.cases.map((entry) => [entry.id, entry.window]));

  const totals: Record<MergeSafetyVerdict, number> = {
    MERGE_SAFE: 0,
    MERGE_UNSAFE: 0,
    UNKNOWN: 0,
  };
  let totalPairs = 0;
  const perArtifact: Array<Record<string, unknown>> = [];

  for (const artifact of ARTIFACTS) {
    const absolute = join(REPO_ROOT, artifact.path);
    if (!existsSync(absolute)) {
      perArtifact.push({ artifact: artifact.path, status: "missing" });
      continue;
    }
    const file = JSON.parse(readFileSync(absolute, "utf8")) as RawPaddleDetectionFile;
    const forensicsWindow = forensicsByCase.get(artifact.caseId) ?? null;
    const window = forensicsWindow
      ? { startMs: forensicsWindow.startMs, endMs: forensicsWindow.endMs }
      : { startMs: file.window.startMs, endMs: file.window.endMs };
    const candidates = buildPaddleTracks(file, window);
    const sweep = sweepMergeCandidates(candidates, {
      wrists: [], // pose is Apple-Vision-only; absent on this platform
      otherWrists: [],
      window,
      eventPeakMs: forensicsWindow ? forensicsWindow.peakMotionMs : null,
      frameIntervalMs: 1000 / file.video.fps,
    });
    totalPairs += sweep.candidatePairs;
    for (const verdict of Object.keys(totals) as MergeSafetyVerdict[]) {
      totals[verdict] += sweep.counts[verdict];
    }
    perArtifact.push({
      artifact: artifact.path,
      caseId: artifact.caseId,
      tracklets: candidates.length,
      candidatePairs: sweep.candidatePairs,
      counts: sweep.counts,
      eventPeakMs: forensicsWindow ? forensicsWindow.peakMotionMs : null,
      unsafeReasons: sweep.reports
        .filter((report) => report.verdict === "MERGE_UNSAFE")
        .map((report) => {
          const failing = Object.entries(report.checks)
            .filter(([, check]) => check.status === "FAIL")
            .map(([name]) => name);
          return {
            pair: `${report.fromTrackId}->${report.toTrackId}`,
            gapMs: Math.round(report.gapMs),
            failing,
          };
        }),
    });
  }

  console.log(
    JSON.stringify(
      {
        tool: "paddleMergeSafetySweep",
        version: MERGE_SAFETY_VERSION,
        wristEvidence: "absent (pose extraction is Apple-Vision-only; not run on this platform)",
        artifacts: perArtifact,
        totalCandidatePairs: totalPairs,
        totals,
      },
      null,
      2,
    ),
  );
}

main();
