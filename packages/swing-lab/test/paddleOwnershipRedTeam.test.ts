import { describe, expect, it } from "vitest";
import {
  buildPaddleTracks,
  selectPrimaryPaddleTrack,
  type RawPaddleDetectionFile,
} from "../src/index.js";
import {
  wristSeries,
  type PaddleTrackCandidate,
  type TrackedPaddleObservation,
} from "../src/paddleTracker.js";

/**
 * WAVE-D3 RED TEAM — paddle OWNERSHIP (d3-03).
 *
 * All fixtures here are SYNTHETIC adversarial geometry (hand-built wrist
 * series and tracks with KNOWN ownership per time range), in the same style
 * as the flip-segmentation suite. Each measured break is documented as a
 * pair: the DEFAULT behavior (frozen — the break as found) and the
 * ownership-guard-v1 behavior (the fix, behind the flag).
 *
 * Confirmed break families (probe, 2026-08-29):
 *  RT-A dead zone: other wrist strictly closer (0.85–1.0×) → confidently
 *       claimed for the target with zero risk.
 *  RT-B evidence-gap handoff: handoff into an other-wrist pose dropout
 *       keeps the other player's 41-observation tail with zero risk.
 *  RT-C unverified ownership: other paddle sweeping the target's zone while
 *       the other player's wrists are never measured → tracked, zero risk.
 *  Crossing paddles (straight-through and bounce) were probed and are
 *  HANDLED honestly today — locked in as regressions below.
 */

const STEP_MS = 50;
const WINDOW = { startMs: 0, endMs: 4000 };
type Wrists = ReturnType<typeof wristSeries>;

/** Wrist series from a per-timestamp position function (null = unmeasured). */
function wristsOf(
  fn: (tMs: number) => { x: number; y: number } | null,
  endMs = WINDOW.endMs,
): Wrists {
  const series: Wrists = [];
  for (let tMs = 0; tMs <= endMs; tMs += STEP_MS) {
    const point = fn(tMs);
    series.push({ timestampMs: tMs, wrists: point ? [{ x: point.x, y: point.y }] : [] });
  }
  return series;
}

function observationAt(tMs: number, x: number, y: number, trackId = 1): TrackedPaddleObservation {
  return {
    timestampMs: tMs,
    box: { x: x - 0.03, y: y - 0.03, width: 0.06, height: 0.06 },
    center: { x, y },
    detectorScore: 0.5,
    trackId,
    confidence: 0.5,
    nearWrist: false,
  };
}

function trackObservations(
  startMs: number,
  endMs: number,
  at: (tMs: number) => { x: number; y: number },
  trackId = 1,
): TrackedPaddleObservation[] {
  const observations: TrackedPaddleObservation[] = [];
  for (let tMs = startMs; tMs <= endMs; tMs += STEP_MS) {
    const point = at(tMs);
    observations.push(observationAt(tMs, point.x, point.y, trackId));
  }
  return observations;
}

function candidateOf(
  trackId: number,
  observations: TrackedPaddleObservation[],
): PaddleTrackCandidate {
  return { trackId, observations, meanScore: 0.5, windowCoverage: 1, meanWristDistance: null };
}

describe("RT-A: partner paddle closer than own (near-ownership dead zone)", () => {
  // Target wrist at x=0.5, other wrist at x=0.68, paddle parked at x=0.595:
  // target distance 0.095, other distance 0.085 — the other player's wrist
  // is STRICTLY closer, but at 0.89× the decisive test (0.85×) passes it.
  const targetWrists = wristsOf(() => ({ x: 0.5, y: 0.5 }));
  const otherWrists = wristsOf(() => ({ x: 0.68, y: 0.5 }));
  const deadZoneTrack = candidateOf(
    1,
    trackObservations(0, 4000, () => ({ x: 0.595, y: 0.5 })),
  );

  it("BREAK (default, frozen): confidently claims the track despite the other wrist being closer", () => {
    const outcome = selectPrimaryPaddleTrack([deadZoneTrack], targetWrists, WINDOW, otherWrists);
    expect(outcome.status).toBe("tracked");
    if (outcome.status !== "tracked") return;
    // The wrong-owner evidence is right there in the association record…
    expect(outcome.association.meanOtherWristDistance!).toBeLessThan(
      outcome.association.meanTargetWristDistance!,
    );
    // …yet nothing warns: zero risks. This is the measured break.
    expect(outcome.association.risks).toEqual([]);
  });

  it("FIX (ownership-guard-v1): abstains as ambiguous instead of guessing the owner", () => {
    const outcome = selectPrimaryPaddleTrack([deadZoneTrack], targetWrists, WINDOW, otherWrists, {
      ownershipGuard: true,
    });
    expect(outcome.status).toBe("untracked");
    if (outcome.status !== "untracked") return;
    expect(outcome.reason).toContain("paddle_ownership_ambiguous");
    expect(outcome.association!.risks.join()).toContain("PADDLE_OWNERSHIP_AMBIGUOUS");
  });

  it("guard does NOT abstain when the target's wrist is the closer one", () => {
    // Same geometry mirrored: paddle at 0.575 → target 0.075, other 0.105.
    const ours = candidateOf(
      1,
      trackObservations(0, 4000, () => ({ x: 0.575, y: 0.5 })),
    );
    const outcome = selectPrimaryPaddleTrack([ours], targetWrists, WINDOW, otherWrists, {
      ownershipGuard: true,
    });
    expect(outcome.status).toBe("tracked");
  });
});

describe("RT-B: paddle handoff into an other-wrist pose dropout", () => {
  // 0–1950ms the paddle rides the target's hand; at 2000ms it is handed to
  // the other player — whose wrists are unmeasured from then on (occlusion).
  // Flip-segmentation cannot see this handoff: flips require other-wrist
  // data. The receiving position (0.62, 0.58) is near enough to keep the
  // whole-track mean wrist distance under every gate.
  const targetWrists = wristsOf(() => ({ x: 0.5, y: 0.5 }));
  const otherWrists = wristsOf((tMs) => (tMs >= 2000 ? null : { x: 0.9, y: 0.9 }));
  const handoffTrack = () =>
    candidateOf(1, [
      ...trackObservations(0, 1950, () => ({ x: 0.52, y: 0.52 })),
      ...trackObservations(2000, 4000, () => ({ x: 0.62, y: 0.58 })),
    ]);

  it("BREAK (default, frozen): keeps the other player's post-handoff tail with zero risk", () => {
    const outcome = selectPrimaryPaddleTrack([handoffTrack()], targetWrists, WINDOW, otherWrists);
    expect(outcome.status).toBe("tracked");
    if (outcome.status !== "tracked") return;
    const tail = outcome.lab.observations.filter((observation) => observation.timestampMs >= 2000);
    expect(tail.length).toBe(41); // the other player's paddle, claimed as ours
    expect(outcome.association.risks).toEqual([]);
  });

  it("FIX (ownership-guard-v1): drops the unverifiable out-of-hand tail, keeps the verified head", () => {
    const outcome = selectPrimaryPaddleTrack([handoffTrack()], targetWrists, WINDOW, otherWrists, {
      ownershipGuard: true,
    });
    // NOT blanket abstention: the verified in-hand head still tracks.
    expect(outcome.status).toBe("tracked");
    if (outcome.status !== "tracked") return;
    expect(
      outcome.lab.observations.filter((observation) => observation.timestampMs >= 2000).length,
    ).toBe(0);
    expect(outcome.lab.observations.length).toBe(40); // 0–1950ms head intact
    expect(outcome.association.risks.join()).toContain("PADDLE_OWNERSHIP_EVIDENCE_GAP");
    expect(outcome.association.switchEvents.some((event) => event.atMs === 2000)).toBe(true);
  });

  it("guard keeps a no-other-evidence run that stays IN the target's hand", () => {
    // Same dropout, but the paddle never leaves the target's hand: an
    // in-hand run is plausibly ours even without other-wrist evidence.
    const inHand = candidateOf(
      1,
      trackObservations(0, 4000, () => ({ x: 0.52, y: 0.52 })),
    );
    const outcome = selectPrimaryPaddleTrack([inHand], targetWrists, WINDOW, otherWrists, {
      ownershipGuard: true,
    });
    expect(outcome.status).toBe("tracked");
    if (outcome.status !== "tracked") return;
    expect(outcome.lab.observations.length).toBe(81); // nothing dropped
  });
});

describe("RT-C: target paddle occluded, other paddle in the target's zone, other wrists never measured", () => {
  // The only track is the OTHER player's paddle sweeping through the
  // target's zone (0.55, 0.55 — inside handAffinityRadius of the target
  // wrist) while the other player's wrists are never measured. Geometry
  // alone cannot prove ownership either way; the break is claiming it with
  // ZERO indication that ownership was never verified.
  const targetWrists = wristsOf(() => ({ x: 0.5, y: 0.5 }));
  const otherWristsNeverMeasured = wristsOf(() => null);
  const zoneTrack = () =>
    candidateOf(
      1,
      trackObservations(1000, 3000, () => ({ x: 0.55, y: 0.55 })),
    );

  it("BREAK (default, frozen): tracked with zero risks — reads as verified ownership", () => {
    const outcome = selectPrimaryPaddleTrack(
      [zoneTrack()],
      targetWrists,
      WINDOW,
      otherWristsNeverMeasured,
    );
    expect(outcome.status).toBe("tracked");
    if (outcome.status !== "tracked") return;
    expect(outcome.association.risks).toEqual([]);
  });

  it("FIX (ownership-guard-v1): carries PADDLE_OWNERSHIP_UNVERIFIED when other players exist but were never measured near the track", () => {
    // Other players ARE in the scene (measured early), but never overlap the
    // track's judged observations — ownership was never actually tested.
    const otherMeasuredElsewhere = wristsOf((tMs) => (tMs <= 200 ? { x: 0.9, y: 0.9 } : null));
    const outcome = selectPrimaryPaddleTrack(
      [zoneTrack()],
      targetWrists,
      WINDOW,
      otherMeasuredElsewhere,
      { ownershipGuard: true },
    );
    expect(outcome.status).toBe("tracked"); // in-hand → plausibly ours, no blanket abstention
    if (outcome.status !== "tracked") return;
    expect(outcome.association.risks.join()).toContain("PADDLE_OWNERSHIP_UNVERIFIED");
  });

  it("guard adds NO unverified risk in a genuinely single-player scene", () => {
    const outcome = selectPrimaryPaddleTrack([zoneTrack()], targetWrists, WINDOW, [], {
      ownershipGuard: true,
    });
    expect(outcome.status).toBe("tracked");
    if (outcome.status !== "tracked") return;
    expect(outcome.association.risks).toEqual([]);
  });
});

describe("RT-D: two paddles crossing mid-swing (probed — handled honestly today, locked in)", () => {
  function detectionFileOf(
    positions: Array<(tMs: number) => { x: number; y: number }>,
  ): RawPaddleDetectionFile {
    const frames: RawPaddleDetectionFile["frames"] = [];
    for (let tMs = 0; tMs <= WINDOW.endMs; tMs += STEP_MS) {
      frames.push({
        tMs,
        detections: positions.map((position) => {
          const point = position(tMs);
          return {
            box: [
              point.x * 1000 - 30,
              point.y * 1000 - 30,
              point.x * 1000 + 30,
              point.y * 1000 + 30,
            ] as [number, number, number, number],
            score: 0.7,
            label: "tennis racket",
          };
        }),
        extras: [],
      });
    }
    return {
      schemaVersion: 1,
      detector: {
        modelId: "synthetic",
        version: "synthetic",
        license: "n/a",
        device: "cpu",
        proxyLabels: ["tennis racket"],
        proxyNote: "synthetic red-team fixture",
        scoreFloor: 0.08,
      },
      video: { path: "synthetic.mp4", width: 1000, height: 1000, fps: 20, durationMs: 4000 },
      window: WINDOW,
      timing: {
        modelLoadSec: 0,
        framesProcessed: frames.length,
        inferenceSecTotal: 0,
        inferenceMsPerFrame: 0,
        wallSecTotal: 0,
      },
      frames,
    };
  }

  it("straight-through crossing: association follows each paddle through the cross", () => {
    const paddleA = (tMs: number) => ({ x: 0.2 + 0.6 * (tMs / 4000), y: 0.5 });
    const paddleB = (tMs: number) => ({ x: 0.8 - 0.6 * (tMs / 4000), y: 0.5 });
    const tracks = buildPaddleTracks(detectionFileOf([paddleA, paddleB]), WINDOW);
    expect(tracks.length).toBe(2);
    const targetWrists = wristsOf((tMs) => ({ x: paddleA(tMs).x, y: 0.53 }));
    const otherWrists = wristsOf((tMs) => ({ x: paddleB(tMs).x, y: 0.53 }));
    const outcome = selectPrimaryPaddleTrack(tracks, targetWrists, WINDOW, otherWrists, {
      ownershipGuard: true,
    });
    expect(outcome.status).toBe("tracked");
    if (outcome.status !== "tracked") return;
    // Every kept observation stays on paddle A's trajectory.
    for (const observation of outcome.lab.observations) {
      const expected = paddleA(observation.timestampMs);
      expect(
        Math.hypot(observation.center.x - expected.x, observation.center.y - expected.y),
      ).toBeLessThan(0.03);
    }
  });

  it("bounce crossing (identity swap): the swapped other-player tail is dropped, never claimed", () => {
    // Paddles approach, meet at 2000ms, and RETURN to their own sides.
    // Constant-velocity prediction goes straight through → the track ids
    // swap owners at the cross. Flip-segmentation must strip the tail.
    const paddleA = (tMs: number) => ({
      x: tMs <= 2000 ? 0.2 + 0.3 * (tMs / 2000) : 0.5 - 0.3 * ((tMs - 2000) / 2000),
      y: 0.5,
    });
    const paddleB = (tMs: number) => ({
      x: tMs <= 2000 ? 0.8 - 0.3 * (tMs / 2000) : 0.5 + 0.3 * ((tMs - 2000) / 2000),
      y: 0.5,
    });
    const tracks = buildPaddleTracks(detectionFileOf([paddleA, paddleB]), WINDOW);
    expect(tracks.length).toBe(2);
    // Confirm the adversarial premise: tracks went straight through (swap).
    const swapped = tracks.every((track) => {
      const first = track.observations[0]!.center.x;
      const last = track.observations[track.observations.length - 1]!.center.x;
      return Math.abs(last - first) > 0.5; // ended on the OTHER side
    });
    expect(swapped).toBe(true);
    const targetWrists = wristsOf((tMs) => ({ x: paddleA(tMs).x, y: 0.53 }));
    const otherWrists = wristsOf((tMs) => ({ x: paddleB(tMs).x, y: 0.53 }));
    for (const ownershipGuard of [false, true]) {
      const outcome = selectPrimaryPaddleTrack(tracks, targetWrists, WINDOW, otherWrists, {
        ownershipGuard,
      });
      expect(outcome.status).toBe("tracked");
      if (outcome.status !== "tracked") continue;
      // No kept observation may ride paddle B (the other player's paddle).
      const wrongOwner = outcome.lab.observations.filter((observation) => {
        const onB = paddleB(observation.timestampMs);
        const onA = paddleA(observation.timestampMs);
        const distanceB = Math.hypot(observation.center.x - onB.x, observation.center.y - onB.y);
        const distanceA = Math.hypot(observation.center.x - onA.x, observation.center.y - onA.y);
        return distanceB < 0.02 && distanceA > 0.05;
      });
      expect(wrongOwner.length).toBe(0);
      // The swap is visible as switch events, not silently absorbed.
      expect(outcome.association.switchEvents.length).toBeGreaterThan(0);
    }
  });
});
