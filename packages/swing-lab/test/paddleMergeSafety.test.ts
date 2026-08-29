import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildPaddleTracks,
  classifyMergeCandidate,
  enumerateMergeCandidatePairs,
  mergePaddleTracklets,
  sweepMergeCandidates,
  type MergeSafetyContext,
  type PaddleTrackCandidate,
  type RawPaddleDetectionFile,
} from "../src/index.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Committed raw detector artifacts for the two D-042 destructive cases
 *  (datasets/experiments/wave-a/H-logs, baseline stride-1 reruns) plus the
 *  stroke windows/peaks measured in the committed selection-forensics
 *  artifact (wave-a/B-selection-forensics.json). */
const DESTRUCTIVE_CASES = [
  {
    id: "afn-sasebo-rally2",
    dets: "datasets/experiments/wave-a/H-logs/baseline-rerun-afn-sasebo-rally2-dets.json",
    window: { startMs: 1302, endMs: 3603 },
    eventPeakMs: 2469,
    failure: "contact degraded 30→145ms under --merge-tracklets (D-042)",
  },
  {
    id: "afn-sasebo-rally1",
    dets: "datasets/experiments/wave-a/H-logs/baseline-rerun-afn-sasebo-rally1-dets.json",
    window: { startMs: 168, endMs: 3871 },
    eventPeakMs: 3403,
    failure: "fabricated target-gated 695ms contact under --merge-tracklets (D-042)",
  },
] as const;

function loadCase(caseSpec: (typeof DESTRUCTIVE_CASES)[number]): {
  candidates: PaddleTrackCandidate[];
  context: MergeSafetyContext;
} {
  const file = JSON.parse(
    readFileSync(join(REPO_ROOT, caseSpec.dets), "utf8"),
  ) as RawPaddleDetectionFile;
  const candidates = buildPaddleTracks(file, caseSpec.window);
  return {
    candidates,
    context: {
      // Pose extraction is Apple-Vision-only; no wrist series exists on this
      // platform. The classifier must treat that as missing evidence, never
      // as safety.
      wrists: [],
      otherWrists: [],
      window: caseSpec.window,
      eventPeakMs: caseSpec.eventPeakMs,
      frameIntervalMs: 1000 / file.video.fps,
    },
  };
}

describe("merge safety on the D-042 destructive cases (committed artifacts)", () => {
  for (const caseSpec of DESTRUCTIVE_CASES) {
    it(`${caseSpec.id}: every candidate pair is MERGE_UNSAFE or UNKNOWN — ${caseSpec.failure}`, () => {
      const { candidates, context } = loadCase(caseSpec);
      const pairs = enumerateMergeCandidatePairs(candidates);
      // The destructive merges were real: the link gate finds pairs here.
      expect(pairs.length).toBeGreaterThan(0);
      const sweep = sweepMergeCandidates(candidates, context);
      expect(sweep.candidatePairs).toBe(pairs.length);
      expect(sweep.counts.MERGE_SAFE).toBe(0);
      for (const report of sweep.reports) {
        expect(["MERGE_UNSAFE", "UNKNOWN"]).toContain(report.verdict);
      }
    });

    it(`${caseSpec.id}: the links mergePaddleTracklets would actually form are never MERGE_SAFE`, () => {
      const { candidates, context } = loadCase(caseSpec);
      const { links } = mergePaddleTracklets(candidates, caseSpec.window);
      expect(links).toBeGreaterThan(0);
      const sweep = sweepMergeCandidates(candidates, context);
      expect(sweep.counts.MERGE_SAFE).toBe(0);
    });
  }

  it("rally2: pairs bridging the event peak are MERGE_UNSAFE (the 30→145ms mechanism)", () => {
    const caseSpec = DESTRUCTIVE_CASES[0];
    const { candidates, context } = loadCase(caseSpec);
    const sweep = sweepMergeCandidates(candidates, context);
    const bridgingPeak = sweep.reports.filter(
      (report) => report.checks.eventLocality.status === "FAIL",
    );
    for (const report of bridgingPeak) {
      expect(report.verdict).toBe("MERGE_UNSAFE");
    }
  });

  it("gap frames carry PREDICTED provenance, never OBSERVED", () => {
    const { candidates, context } = loadCase(DESTRUCTIVE_CASES[0]);
    const sweep = sweepMergeCandidates(candidates, context);
    const withGap = sweep.reports.find((report) => report.gapMs > 2 * context.frameIntervalMs);
    expect(withGap).toBeDefined();
    const observedTimes = new Set<number>();
    for (const candidate of candidates) {
      for (const observation of candidate.observations) {
        observedTimes.add(observation.timestampMs);
      }
    }
    for (const frame of withGap!.bridgedFrames) {
      if (!observedTimes.has(frame.timestampMs)) {
        // Without wrist data a bridged frame can never be TRACKED either.
        expect(frame.provenance).toBe("PREDICTED");
      } else {
        expect(frame.provenance).toBe("OBSERVED");
      }
    }
  });
});

/** Synthetic fragment on a constant-velocity path. */
function fragment(
  trackId: number,
  startMs: number,
  count: number,
  from: { x: number; y: number },
  velocity: { x: number; y: number },
  size = 0.06,
): PaddleTrackCandidate {
  const observations = Array.from({ length: count }, (_, index) => {
    const tMs = startMs + index * 33;
    const x = from.x + (velocity.x * (tMs - startMs)) / 1000;
    const y = from.y + (velocity.y * (tMs - startMs)) / 1000;
    return {
      timestampMs: tMs,
      box: { x: x - size / 2, y: y - size / 2, width: size, height: size },
      center: { x, y },
      detectorScore: 0.5,
      trackId,
      confidence: 0.5,
      nearWrist: true,
    };
  });
  return { trackId, observations, meanScore: 0.5, windowCoverage: 0.2, meanWristDistance: null };
}

/** Wrist series riding exactly with (or offset from) a fragment path. */
function wristsAlong(
  startMs: number,
  endMs: number,
  from: { x: number; y: number },
  velocity: { x: number; y: number },
  offset = 0.02,
): Array<{ timestampMs: number; wrists: Array<{ x: number; y: number }> }> {
  const series: Array<{ timestampMs: number; wrists: Array<{ x: number; y: number }> }> = [];
  for (let tMs = startMs; tMs <= endMs; tMs += 33) {
    series.push({
      timestampMs: tMs,
      wrists: [
        {
          x: from.x + (velocity.x * (tMs - startMs)) / 1000 + offset,
          y: from.y + (velocity.y * (tMs - startMs)) / 1000,
        },
      ],
    });
  }
  return series;
}

const WINDOW = { startMs: 0, endMs: 4000 };

describe("classifyMergeCandidate (synthetic checks)", () => {
  it("passes MERGE_SAFE only when every check is provably satisfied (positive control)", () => {
    const velocity = { x: 0.4, y: 0 };
    const a = fragment(1, 1000, 8, { x: 0.3, y: 0.5 }, velocity);
    const b = fragment(2, 1330, 8, { x: 0.432, y: 0.5 }, velocity);
    const context: MergeSafetyContext = {
      wrists: wristsAlong(900, 1700, { x: 0.26, y: 0.5 }, velocity),
      otherWrists: wristsAlong(900, 1700, { x: 0.9, y: 0.1 }, { x: 0, y: 0 }),
      window: WINDOW,
      eventPeakMs: 3500,
      frameIntervalMs: 33,
    };
    const report = classifyMergeCandidate(a, b, context);
    expect(report.checks.ownershipAgreement.status).toBe("PASS");
    expect(report.checks.targetCompatibility.status).toBe("PASS");
    expect(report.checks.eventLocality.status).toBe("PASS");
    expect(report.checks.motionContinuity.status).toBe("PASS");
    expect(report.checks.nonTargetContradiction.status).toBe("PASS");
    expect(report.verdict).toBe("MERGE_SAFE");
  });

  it("is MERGE_UNSAFE when the second fragment lives on another player's hand", () => {
    const velocity = { x: 0.4, y: 0 };
    const a = fragment(1, 1000, 8, { x: 0.3, y: 0.5 }, velocity);
    const b = fragment(2, 1330, 8, { x: 0.432, y: 0.5 }, velocity);
    const context: MergeSafetyContext = {
      // Target wrist tracks fragment A then stays back; the OTHER player's
      // wrist rides fragment B — the rally1 695ms shape (merged
      // other-player fragment).
      wrists: [
        ...wristsAlong(900, 1240, { x: 0.26, y: 0.5 }, velocity),
        ...wristsAlong(1273, 1700, { x: 0.3, y: 0.5 }, { x: 0, y: 0 }),
      ],
      otherWrists: wristsAlong(1300, 1700, { x: 0.42, y: 0.5 }, velocity, 0.01),
      window: WINDOW,
      eventPeakMs: 3500,
      frameIntervalMs: 33,
    };
    const report = classifyMergeCandidate(a, b, context);
    expect(report.checks.ownershipAgreement.status).toBe("FAIL");
    expect(report.verdict).toBe("MERGE_UNSAFE");
  });

  it("is MERGE_UNSAFE when the bridged gap overlaps the event peak (rally2 shape)", () => {
    const velocity = { x: 0.4, y: 0 };
    const a = fragment(1, 1000, 8, { x: 0.3, y: 0.5 }, velocity);
    const b = fragment(2, 1330, 8, { x: 0.432, y: 0.5 }, velocity);
    const context: MergeSafetyContext = {
      wrists: wristsAlong(900, 1700, { x: 0.26, y: 0.5 }, velocity),
      otherWrists: wristsAlong(900, 1700, { x: 0.9, y: 0.1 }, { x: 0, y: 0 }),
      window: WINDOW,
      eventPeakMs: 1300, // gap 1231–1330ms sits inside peak ± 300ms
      frameIntervalMs: 33,
    };
    const report = classifyMergeCandidate(a, b, context);
    expect(report.checks.eventLocality.status).toBe("FAIL");
    expect(report.verdict).toBe("MERGE_UNSAFE");
  });

  it("is MERGE_UNSAFE when velocities across the gap contradict", () => {
    const a = fragment(1, 1000, 8, { x: 0.3, y: 0.5 }, { x: 0.5, y: 0 });
    // Starts where A's tail is but moving the opposite way.
    const b = fragment(2, 1330, 8, { x: 0.42, y: 0.5 }, { x: -0.5, y: 0 });
    const context: MergeSafetyContext = {
      wrists: wristsAlong(900, 1700, { x: 0.38, y: 0.5 }, { x: 0, y: 0 }),
      otherWrists: wristsAlong(900, 1700, { x: 0.9, y: 0.1 }, { x: 0, y: 0 }),
      window: WINDOW,
      eventPeakMs: 3500,
      frameIntervalMs: 33,
    };
    const report = classifyMergeCandidate(a, b, context);
    expect(report.checks.motionContinuity.status).toBe("FAIL");
    expect(report.verdict).toBe("MERGE_UNSAFE");
  });

  it("is UNKNOWN, never MERGE_SAFE, without wrist evidence", () => {
    const velocity = { x: 0.4, y: 0 };
    const a = fragment(1, 1000, 8, { x: 0.3, y: 0.5 }, velocity);
    const b = fragment(2, 1330, 8, { x: 0.432, y: 0.5 }, velocity);
    const context: MergeSafetyContext = {
      wrists: [],
      otherWrists: [],
      window: WINDOW,
      eventPeakMs: 3500,
      frameIntervalMs: 33,
    };
    const report = classifyMergeCandidate(a, b, context);
    expect(report.checks.ownershipAgreement.status).toBe("UNKNOWN");
    expect(report.checks.targetCompatibility.status).toBe("UNKNOWN");
    expect(report.checks.nonTargetContradiction.status).toBe("UNKNOWN");
    expect(report.verdict).toBe("UNKNOWN");
  });

  it("is UNKNOWN without an event peak even when everything else passes", () => {
    const velocity = { x: 0.4, y: 0 };
    const a = fragment(1, 1000, 8, { x: 0.3, y: 0.5 }, velocity);
    const b = fragment(2, 1330, 8, { x: 0.432, y: 0.5 }, velocity);
    const context: MergeSafetyContext = {
      wrists: wristsAlong(900, 1700, { x: 0.26, y: 0.5 }, velocity),
      otherWrists: wristsAlong(900, 1700, { x: 0.9, y: 0.1 }, { x: 0, y: 0 }),
      window: WINDOW,
      eventPeakMs: null,
      frameIntervalMs: 33,
    };
    const report = classifyMergeCandidate(a, b, context);
    expect(report.checks.eventLocality.status).toBe("UNKNOWN");
    expect(report.verdict).toBe("UNKNOWN");
  });

  it("marks wrist-supported gap frames TRACKED and unsupported ones PREDICTED", () => {
    const velocity = { x: 0.4, y: 0 };
    const a = fragment(1, 1000, 8, { x: 0.3, y: 0.5 }, velocity);
    const b = fragment(2, 1462, 8, { x: 0.485, y: 0.5 }, velocity);
    const withWrists: MergeSafetyContext = {
      wrists: wristsAlong(900, 1900, { x: 0.26, y: 0.5 }, velocity),
      otherWrists: [],
      window: WINDOW,
      eventPeakMs: 3500,
      frameIntervalMs: 33,
    };
    const report = classifyMergeCandidate(a, b, withWrists);
    const gapFrames = report.bridgedFrames.filter((frame) => frame.provenance !== "OBSERVED");
    expect(gapFrames.length).toBeGreaterThan(0);
    expect(gapFrames.every((frame) => frame.provenance === "TRACKED")).toBe(true);

    const withoutWrists = classifyMergeCandidate(a, b, { ...withWrists, wrists: [] });
    const blindGapFrames = withoutWrists.bridgedFrames.filter(
      (frame) => frame.provenance !== "OBSERVED",
    );
    expect(blindGapFrames.every((frame) => frame.provenance === "PREDICTED")).toBe(true);
  });
});
