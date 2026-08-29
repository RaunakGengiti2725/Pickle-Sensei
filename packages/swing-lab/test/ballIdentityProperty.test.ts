import { describe, expect, it } from "vitest";
import { generateSwingSequence } from "@pickle/evaluation";
import { buildBallTracks, selectPrimaryBallTrack, type BallCandidateFile } from "../src/index.js";

/**
 * PROPERTY: a second simultaneous ball (adjacent court / second rally) must
 * never silently switch identity into the target rally's track.
 *
 * Every synthetic candidate is tagged with its generating identity by exact
 * position. Across a grid of decoy geometries (crossing angle, offset, time
 * shift) plus deterministic seeded jitter, the selected primary track — and
 * any reacquired outgoing segment — must be composed of observations from
 * EXACTLY ONE identity. A mixed track is an identity switch: observations
 * from a different physical ball presented as the target rally's ball.
 */

const WINDOW = { startMs: 300, endMs: 1400 };

const ball = (x: number, y: number, area = 40) => ({
  x,
  y,
  areaPx: area,
  wNorm: 0.01,
  hNorm: 0.01,
  elong: 1.2,
  score: 500,
});

function candidateFile(frames: BallCandidateFile["frames"]): BallCandidateFile {
  return {
    schemaVersion: 1,
    generator: { version: "test", method: "test", scale: 0.5, note: "" },
    video: { path: "test.mp4", width: 1000, height: 1000, fps: 25, durationMs: 4000 },
    window: { startMs: 0, endMs: 4000 },
    backgroundActivity: { grid: 24, cells: new Array(24 * 24).fill(0) },
    timing: { framesProcessed: frames.length, wallSecTotal: 0, msPerFrame: 0 },
    frames,
  };
}

/** Deterministic LCG so the "property" sweep is reproducible. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

interface TaggedPoint {
  tMs: number;
  x: number;
  y: number;
  identity: "target" | "decoy";
}

function key(tMs: number, x: number, y: number): string {
  return `${tMs}:${x.toFixed(6)}:${y.toFixed(6)}`;
}

/** Linear flight sampled every 40ms with optional seeded jitter. */
function flight(
  identity: "target" | "decoy",
  startMs: number,
  count: number,
  x0: number,
  y0: number,
  dx: number,
  dy: number,
  jitter: number,
  random: () => number,
): TaggedPoint[] {
  const points: TaggedPoint[] = [];
  for (let index = 0; index < count; index += 1) {
    points.push({
      tMs: startMs + index * 40,
      x: x0 + index * dx + (random() - 0.5) * jitter,
      y: y0 + index * dy + (random() - 0.5) * jitter,
      identity,
    });
  }
  return points;
}

function buildFixture(points: TaggedPoint[]): {
  file: BallCandidateFile;
  identityOf: Map<string, "target" | "decoy">;
} {
  const identityOf = new Map<string, "target" | "decoy">();
  const byFrame = new Map<number, TaggedPoint[]>();
  for (const point of points) {
    identityOf.set(key(point.tMs, point.x, point.y), point.identity);
    byFrame.set(point.tMs, [...(byFrame.get(point.tMs) ?? []), point]);
  }
  const frames: BallCandidateFile["frames"] = [];
  for (let index = 0; index < 50; index += 1) {
    const tMs = index * 40;
    const framePoints = byFrame.get(tMs) ?? [];
    frames.push({
      tMs,
      candidates: framePoints.map((point) => ball(point.x, point.y)),
      rawComponentCount: framePoints.length,
    });
  }
  return { file: candidateFile(frames), identityOf };
}

function identitiesInTrack(
  observations: ReadonlyArray<{ timestampMs: number; x: number; y: number }>,
  identityOf: Map<string, "target" | "decoy">,
): Set<string> {
  const identities = new Set<string>();
  for (const observation of observations) {
    const identity = identityOf.get(key(observation.timestampMs, observation.x, observation.y));
    expect(identity).toBeDefined(); // every emitted point must be a measured candidate
    identities.add(identity!);
  }
  return identities;
}

describe("property: adjacent-court ball never switches identity into the target rally", () => {
  const { sequence } = generateSwingSequence();

  it("primary track stays single-identity across crossing/parallel/time-shifted decoys with jitter", () => {
    const scenarios: Array<{
      seed: number;
      decoyY0: number;
      decoyDy: number;
      decoyStartMs: number;
      jitter: number;
    }> = [];
    let seed = 1;
    for (const decoyY0 of [0.15, 0.35, 0.62, 0.8]) {
      for (const decoyDy of [-0.02, 0, 0.015, 0.03]) {
        for (const decoyStartMs of [320, 400, 480]) {
          for (const jitter of [0, 0.004]) {
            scenarios.push({ seed: seed++, decoyY0, decoyDy, decoyStartMs, jitter });
          }
        }
      }
    }
    let trackedRuns = 0;
    let mixedTracks = 0;
    for (const scenario of scenarios) {
      const random = lcg(scenario.seed);
      // Target rally ball: left→right through the play band at 1.0 u/s.
      const target = flight("target", 400, 20, 0.05, 0.5, 0.04, 0.002, scenario.jitter, random);
      // Decoy: a second simultaneous ball crossing the same image region.
      const decoy = flight(
        "decoy",
        scenario.decoyStartMs,
        20,
        0.95,
        scenario.decoyY0,
        -0.035,
        scenario.decoyDy,
        scenario.jitter,
        random,
      );
      const { file, identityOf } = buildFixture([...target, ...decoy]);
      const { gated, fragments, ablation } = buildBallTracks(file, sequence, WINDOW, null);
      const outcome = selectPrimaryBallTrack(gated, ablation, WINDOW, {
        paddleTrackExists: false,
        fragments,
      });
      if (outcome.status !== "tracked") continue; // abstaining is always allowed
      trackedRuns += 1;
      const identities = identitiesInTrack(outcome.track.observations, identityOf);
      if (identities.size > 1) {
        mixedTracks += 1;
        console.error(
          `identity switch: seed ${scenario.seed} decoyY0 ${scenario.decoyY0} ` +
            `decoyDy ${scenario.decoyDy} start ${scenario.decoyStartMs} jitter ${scenario.jitter}`,
        );
      }
    }
    expect(trackedRuns).toBeGreaterThan(0); // the sweep must actually exercise tracking
    expect(mixedTracks).toBe(0);
  });

  it("reacquisition never grabs the decoy when the target ball vanished mid-flight", () => {
    // Target dies mid-air (not at the body, not at the window edge); the
    // decoy keeps flying on the adjacent court. The corridor must not link
    // the decoy segment into the target rally (direction is incompatible).
    for (const seed of [11, 12, 13, 14, 15]) {
      const random = lcg(seed);
      const target = flight("target", 400, 8, 0.05, 0.5, 0.04, 0.002, 0.003, random);
      const decoy = flight("decoy", 760, 8, 0.4, 0.15, -0.035, -0.002, 0.003, random);
      const { file, identityOf } = buildFixture([...target, ...decoy]);
      const { gated, fragments, ablation } = buildBallTracks(file, sequence, WINDOW, null);
      const outcome = selectPrimaryBallTrack(gated, ablation, WINDOW, {
        paddleTrackExists: false,
        fragments,
      });
      if (outcome.status !== "tracked") continue;
      const identities = identitiesInTrack(outcome.track.observations, identityOf);
      expect(identities.size).toBe(1);
    }
  });
});
