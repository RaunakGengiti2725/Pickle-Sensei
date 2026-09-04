import { describe, expect, it } from "vitest";
import { generateSwingSequence } from "@pickle/evaluation";
import type { BallObservation, PoseSequence } from "@pickle/swing-domain";
import { assessPaddleTrackIdentity, estimateContact } from "../src/index.js";

/**
 * ADVERSARIAL PASS 3 / TESTER #2 — estimateContact (offlineStroke.ts).
 *
 * S2 order invariance, S3 zero-visibility wrist tether, S4 invalid ball
 * confidence, S5 paddleIdentityGate on unmeasurable tracks, S6 +10 s paddle
 * clock skew, plus extras (time-tie order dependence, duplicate timestamps,
 * hostile confidences, rapid repeats).
 *
 * Tests marked `it.fails` are REPRODUCED DEFECTS at the audited revision: the
 * body states the expected safe behaviour; vitest passes the case only while
 * the defect persists. When production is fixed, drop the `.fails` modifier.
 *
 * Seeded randomness: mulberry32(SEED), SEED = 20260904.
 */

const SEED = 20260904;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], rnd: () => number): T[] {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rnd() * (index + 1));
    [out[index], out[swap]] = [out[swap]!, out[index]!];
  }
  return out;
}

const SWING = generateSwingSequence();
const SEQUENCE = SWING.sequence;
const PEAK = SWING.window.peakMs;
const WINDOW = { startMs: SWING.window.startMs, endMs: SWING.window.endMs, peakMotionMs: PEAK };
const LAST_POSE_MS = SEQUENCE.frames[SEQUENCE.frames.length - 1]!.timestampMs;

/** Right wrist position of the synthetic swing at the motion peak. */
const RIGHT_WRIST_AT_PEAK = (() => {
  const frame = SEQUENCE.frames.reduce((best, candidate) =>
    Math.abs(candidate.timestampMs - PEAK) < Math.abs(best.timestampMs - PEAK) ? candidate : best,
  );
  const wrist = frame.landmarks.find((mark) => mark.name === "right_wrist")!;
  return { x: wrist.x, y: wrist.y };
})();

/** 12-sample ball track that reverses direction at `at` at time `peakMs`. */
function ballTurnAt(
  peakMs: number,
  at: { x: number; y: number },
  confidence = 0.8,
): BallObservation[] {
  const ball: BallObservation[] = [];
  for (let index = 0; index < 12; index += 1) {
    const t = peakMs - 180 + index * 30;
    const before = t <= peakMs;
    ball.push({
      frameIndex: index,
      timestampMs: t,
      x: before
        ? 0.9 - (0.9 - at.x) * ((t - (peakMs - 180)) / 180)
        : at.x + ((t - peakMs) / 180) * 0.5,
      y: before
        ? at.y - 0.1 + 0.1 * ((t - (peakMs - 180)) / 180)
        : at.y - ((t - peakMs) / 180) * 0.25,
      confidence,
    });
  }
  return ball;
}

/** 40-sample paddle speed ramp peaking (2.6 u/s) at `peakMs`, 20 ms cadence. */
function paddleSpeedRamp(peakMs: number) {
  return Array.from({ length: 40 }, (_, index) => {
    const t = peakMs - 400 + index * 20;
    return { timestampMs: t, value: Math.max(0, 2.6 - Math.abs(t - peakMs) / 90) };
  });
}

function paddleCentersAlong(
  speeds: ReadonlyArray<{ timestampMs: number }>,
  at: { x: number; y: number },
) {
  return speeds.map((sample) => ({ timestampMs: sample.timestampMs, x: at.x, y: at.y }));
}

/** Copy of the sequence with `landmarkName` moved to `at` with the given visibility on every frame. */
function withGhostLandmark(
  sequence: PoseSequence,
  landmarkName: string,
  at: { x: number; y: number },
  visibility: number,
): PoseSequence {
  return {
    ...sequence,
    frames: sequence.frames.map((frame) => ({
      ...frame,
      landmarks: frame.landmarks.map((mark) =>
        mark.name === landmarkName ? { ...mark, x: at.x, y: at.y, visibility } : mark,
      ),
    })),
  };
}

/** Copy of the sequence whose wrists never move (frozen at frame 0). */
function withFrozenWrists(sequence: PoseSequence): PoseSequence {
  const first = sequence.frames[0]!;
  return {
    ...sequence,
    frames: sequence.frames.map((frame) => ({
      ...frame,
      landmarks: frame.landmarks.map((mark) => {
        if (!mark.name.endsWith("wrist")) return mark;
        const origin = first.landmarks.find((candidate) => candidate.name === mark.name)!;
        return { ...mark, x: origin.x, y: origin.y };
      }),
    })),
  };
}

/** Walk any JSON-like value and assert every number in it is finite. */
function expectAllNumbersFinite(value: unknown, path: string): void {
  if (typeof value === "number") {
    expect(Number.isFinite(value), path).toBe(true);
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => expectAllNumbersFinite(entry, `${path}[${index}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      expectAllNumbersFinite(entry, `${path}.${key}`);
    }
  }
}

const NO_BALL = estimateContact({ sequence: SEQUENCE, window: WINDOW, ballObservations: null });
const NO_BALL_CONFIDENCE = NO_BALL.status === "estimated" ? NO_BALL.confidence : 0;

describe("control", () => {
  it("no-ball / no-paddle run is a wrist-only estimate at the peak capped at 0.55", () => {
    expect(NO_BALL.status).toBe("estimated");
    if (NO_BALL.status !== "estimated") return;
    expect(NO_BALL.estimatedContactMs).toBe(PEAK);
    expect(NO_BALL.confidence).toBeCloseTo(0.55, 6);
    expect(NO_BALL.ballConfirmed).toBe(false);
    expect(NO_BALL.paddleConfirmed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S2 — order invariance
// ─────────────────────────────────────────────────────────────────────────────
describe("S2 estimateContact is order-invariant over its array inputs", () => {
  const speeds = paddleSpeedRamp(PEAK);
  const centers = paddleCentersAlong(speeds, RIGHT_WRIST_AT_PEAK);
  const ball = ballTurnAt(PEAK, RIGHT_WRIST_AT_PEAK);
  const targetWrists = SEQUENCE.frames.map((frame) => {
    const wrist = frame.landmarks.find((mark) => mark.name === "right_wrist")!;
    return { timestampMs: frame.timestampMs, x: wrist.x, y: wrist.y };
  });
  const run = (
    ballInput: readonly BallObservation[],
    speedInput: typeof speeds,
    centerInput: typeof centers,
    wristInput: typeof targetWrists,
    paddleIdentityGate: boolean,
  ) =>
    JSON.stringify(
      estimateContact({
        sequence: SEQUENCE,
        window: WINDOW,
        ballObservations: ballInput,
        paddleSpeeds: speedInput,
        paddleCenters: centerInput,
        targetWrists: wristInput,
        paddleIdentityGate,
        includeFusionKernels: true,
      }),
    );

  for (const gate of [false, true]) {
    it(`shuffled ball + reversed paddleSpeeds/paddleCenters/targetWrists → byte-identical (paddleIdentityGate=${gate}, seed ${SEED})`, () => {
      const rnd = mulberry32(SEED);
      const canonical = run(ball, speeds, centers, targetWrists, gate);
      expect(JSON.parse(canonical).status).toBe("estimated");
      expect(JSON.parse(canonical).ballConfirmed).toBe(true);
      expect(JSON.parse(canonical).paddleConfirmed).toBe(true);
      for (let trial = 0; trial < 25; trial += 1) {
        const permuted = run(
          shuffle(ball, rnd),
          trial % 2 === 0 ? [...speeds].reverse() : shuffle(speeds, rnd),
          trial % 2 === 0 ? [...centers].reverse() : shuffle(centers, rnd),
          trial % 2 === 0 ? [...targetWrists].reverse() : shuffle(targetWrists, rnd),
          gate,
        );
        expect(permuted).toBe(canonical);
      }
    });
  }

  it("rapid repeats: 200 identical calls are byte-identical", () => {
    const first = run(ball, speeds, centers, targetWrists, true);
    for (let index = 0; index < 200; index += 1) {
      expect(run(ball, speeds, centers, targetWrists, true)).toBe(first);
    }
  });

  // Extra: two paddle centers equidistant in time from the peak, one in the
  // hand and one 2+ torso away. `paddleReachAt` (offlineStroke.ts ~612-625)
  // keeps the FIRST encountered among time-ties (strict `<`), so the array
  // order decides which center anchors the paddle modality.
  const tieCenters = [
    { timestampMs: PEAK - 10, x: RIGHT_WRIST_AT_PEAK.x, y: RIGHT_WRIST_AT_PEAK.y },
    { timestampMs: PEAK + 10, x: 0.05, y: 0.05 },
    ...centers.filter((center) => Math.abs(center.timestampMs - PEAK) > 60),
  ];

  it.fails(
    "time-tied paddle centers (peak-10 in hand, peak+10 foreign): output must not depend on array order",
    () => {
      const forward = run(ball, speeds, tieCenters, targetWrists, false);
      const reversed = run(ball, speeds, [...tieCenters].reverse(), targetWrists, false);
      expect(reversed).toBe(forward);
    },
  );

  it("observed: reversing time-tied paddle centers flips paddleConfirmed true→false and changes confidence (evidence for the finding above)", () => {
    const forward = JSON.parse(run(ball, speeds, tieCenters, targetWrists, false));
    const reversed = JSON.parse(run(ball, speeds, [...tieCenters].reverse(), targetWrists, false));
    expect(forward.status).toBe("estimated");
    expect(reversed.status).toBe("estimated");
    expect(forward.paddleConfirmed).toBe(true);
    expect(reversed.paddleConfirmed).toBe(false);
    expect(forward.confidence).not.toBe(reversed.confidence);
    expect(reversed.limitingFactors).toContain("no_paddle_evidence");
  });

  // Extra: two ball observations sharing one timestamp (two detections in one
  // frame). Array.prototype.sort is stable, so the input order survives the
  // timestamp sort and steers the direction-change kernel.
  const duplicated = [...ball, { ...ball[6]!, frameIndex: 99, x: 0.3, y: 0.2 }];

  it.fails("duplicate-timestamp ball observations: output must not depend on array order", () => {
    const rnd = mulberry32(SEED + 1);
    const forward = run(duplicated, speeds, centers, targetWrists, false);
    for (let trial = 0; trial < 10; trial += 1) {
      expect(run(shuffle(duplicated, rnd), speeds, centers, targetWrists, false)).toBe(forward);
    }
  });

  it("observed: shuffling duplicate-timestamp ball observations moves estimatedContactMs (evidence for the finding above)", () => {
    const rnd = mulberry32(SEED + 1);
    const forward = JSON.parse(run(duplicated, speeds, centers, targetWrists, false));
    const estimates = new Set<number>([forward.estimatedContactMs]);
    for (let trial = 0; trial < 10; trial += 1) {
      const permuted = JSON.parse(
        run(shuffle(duplicated, rnd), speeds, centers, targetWrists, false),
      );
      estimates.add(permuted.estimatedContactMs);
    }
    expect(estimates.size).toBeGreaterThan(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S3 — zero-visibility wrist landmark placed at the ball must not tether
// ─────────────────────────────────────────────────────────────────────────────
describe("S3 zero-visibility wrist landmark at the ball turn", () => {
  const FAR = { x: 0.1, y: 0.2 }; // > 1.7 torso from every visible wrist at the peak
  const farBall = ballTurnAt(PEAK, FAR);
  const control = estimateContact({
    sequence: SEQUENCE,
    window: WINDOW,
    ballObservations: farBall,
    includeFusionKernels: true,
  });

  it("control: a ball turn far from every VISIBLE wrist is rejected (abstains, ball never near target)", () => {
    expect(control.status).toBe("abstained");
    if (control.status !== "abstained") return;
    expect(control.limitingFactors).toContain("ball_turns_rejected_far_from_target");
  });

  for (const visibility of [0, 0.01, 0.1]) {
    it.fails(
      `left_wrist with visibility ${visibility} at the ball must not tether the turn (nearestTargetReference / nearestWristDistanceTo ignore visibility)`,
      () => {
        const ghosted = estimateContact({
          sequence: withGhostLandmark(SEQUENCE, "left_wrist", FAR, visibility),
          window: WINDOW,
          ballObservations: farBall,
          includeFusionKernels: true,
        });
        if (ghosted.status === "estimated") {
          expect(ghosted.ballConfirmed).toBe(false);
          expect(ghosted.confidence).toBeLessThanOrEqual(NO_BALL_CONFIDENCE);
          for (const evidence of ghosted.supportingEvidence) {
            expect(evidence.signal).not.toBe("ball_direction_change");
          }
        }
      },
    );
  }

  it("observed: visibility-0 left_wrist at the ball converts the abstention into ballConfirmed @0.93 tethered '0.00 torso from target wrist' (evidence for the finding above)", () => {
    const ghosted = estimateContact({
      sequence: withGhostLandmark(SEQUENCE, "left_wrist", FAR, 0),
      window: WINDOW,
      ballObservations: farBall,
      includeFusionKernels: true,
    });
    expect(ghosted.status).toBe("estimated");
    if (ghosted.status !== "estimated") return;
    expect(ghosted.ballConfirmed).toBe(true);
    expect(ghosted.confidence).toBeGreaterThan(0.9);
    expect(ghosted.estimatedContactMs).toBe(PEAK);
    const turn = ghosted.supportingEvidence.find(
      (entry) => entry.signal === "ball_direction_change",
    );
    expect(turn).toBeDefined();
    expect(turn!.detail).toContain("0.00 torso from target wrist");
    expect(
      ghosted.fusionKernels?.some((kernel) => kernel.note.includes("0.00 torso from target wrist")),
    ).toBe(true);
  });

  it("observed: the target right_wrist stays visible and far from the ball in the ghosted sequence (precondition)", () => {
    const ghosted = withGhostLandmark(SEQUENCE, "left_wrist", FAR, 0);
    const frame = ghosted.frames.find((candidate) => Math.abs(candidate.timestampMs - PEAK) <= 20)!;
    const right = frame.landmarks.find((mark) => mark.name === "right_wrist")!;
    const left = frame.landmarks.find((mark) => mark.name === "left_wrist")!;
    expect(right.visibility).toBeGreaterThan(0.5);
    expect(Math.hypot(right.x - FAR.x, right.y - FAR.y)).toBeGreaterThan(0.4);
    expect(left.visibility).toBe(0);
    expect(left.x).toBe(FAR.x);
  });

  // Same defect through the paddle reach gate: a paddle track 2+ torso from
  // every visible wrist is normally excluded (`paddle_track_beyond_reach`);
  // a visibility-0 wrist at the paddle re-admits it via nearestWristDistanceTo.
  const speeds = paddleSpeedRamp(PEAK);
  const foreignPaddle = paddleCentersAlong(speeds, { x: 0.02, y: 0.02 });
  const paddleControl = estimateContact({
    sequence: SEQUENCE,
    window: WINDOW,
    ballObservations: null,
    paddleSpeeds: speeds,
    paddleCenters: foreignPaddle,
    includeFusionKernels: true,
  });

  it("control: paddle track 2+ torso from every visible wrist → paddle_track_beyond_reach, paddle not confirmed", () => {
    expect(paddleControl.status).toBe("estimated");
    if (paddleControl.status !== "estimated") return;
    expect(paddleControl.limitingFactors).toContain("paddle_track_beyond_reach");
    expect(paddleControl.paddleConfirmed).toBe(false);
  });

  it.fails(
    "visibility-0 left_wrist at the foreign paddle must not re-admit the paddle track (nearestWristDistanceTo offlineStroke.ts:1559)",
    () => {
      const ghosted = estimateContact({
        sequence: withGhostLandmark(SEQUENCE, "left_wrist", { x: 0.02, y: 0.02 }, 0),
        window: WINDOW,
        ballObservations: null,
        paddleSpeeds: speeds,
        paddleCenters: foreignPaddle,
        includeFusionKernels: true,
      });
      expect(ghosted.status).toBe("estimated");
      if (ghosted.status !== "estimated") return;
      expect(ghosted.paddleConfirmed).toBe(false);
      expect(ghosted.limitingFactors).toContain("paddle_track_beyond_reach");
    },
  );

  it("observed: visibility-0 wrist at the foreign paddle → paddleConfirmed true @0.7, no reach rejection (evidence for the finding above)", () => {
    const ghosted = estimateContact({
      sequence: withGhostLandmark(SEQUENCE, "left_wrist", { x: 0.02, y: 0.02 }, 0),
      window: WINDOW,
      ballObservations: null,
      paddleSpeeds: speeds,
      paddleCenters: foreignPaddle,
      includeFusionKernels: true,
    });
    expect(ghosted.status).toBe("estimated");
    if (ghosted.status !== "estimated") return;
    expect(ghosted.paddleConfirmed).toBe(true);
    expect(ghosted.confidence).toBeGreaterThan(NO_BALL_CONFIDENCE);
    expect(ghosted.limitingFactors).not.toContain("paddle_track_beyond_reach");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S4 — ball observation confidence NaN / 1.5
// ─────────────────────────────────────────────────────────────────────────────
describe("S4 ball observations with invalid confidence", () => {
  const trusted = estimateContact({
    sequence: SEQUENCE,
    window: WINDOW,
    ballObservations: ballTurnAt(PEAK, RIGHT_WRIST_AT_PEAK, 0.8),
    includeFusionKernels: true,
  });

  it("control: confidence 0.8 ball turn at the wrist confirms the ball", () => {
    expect(trusted.status).toBe("estimated");
    if (trusted.status !== "estimated") return;
    expect(trusted.ballConfirmed).toBe(true);
    expect(trusted.confidence).toBeGreaterThan(0.9);
  });

  it("control: confidence 0.1 (below the 0.35 full-trust floor) is degraded and cannot confirm", () => {
    const degraded = estimateContact({
      sequence: SEQUENCE,
      window: WINDOW,
      ballObservations: ballTurnAt(PEAK, RIGHT_WRIST_AT_PEAK, 0.1),
      includeFusionKernels: true,
    });
    expect(degraded.status).toBe("estimated");
    if (degraded.status !== "estimated") return;
    expect(degraded.ballConfirmed).toBe(false);
    expect(degraded.confidence).toBeLessThanOrEqual(0.7);
  });

  for (const confidence of [Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
    it.fails(
      `confidence ${confidence} must be treated as unverified: cannot confirm, confidence <= no-ball run`,
      () => {
        const result = estimateContact({
          sequence: SEQUENCE,
          window: WINDOW,
          ballObservations: ballTurnAt(PEAK, RIGHT_WRIST_AT_PEAK, confidence),
          includeFusionKernels: true,
        });
        if (result.status !== "estimated") return; // abstention is acceptable
        expect(result.ballConfirmed).toBe(false);
        expect(result.confidence).toBeLessThanOrEqual(NO_BALL_CONFIDENCE);
      },
    );
  }

  for (const confidence of [Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
    it(`observed: confidence ${confidence} is fully trusted — ballConfirmed, confidence identical to the 0.8 run (evidence for the finding above)`, () => {
      const result = estimateContact({
        sequence: SEQUENCE,
        window: WINDOW,
        ballObservations: ballTurnAt(PEAK, RIGHT_WRIST_AT_PEAK, confidence),
        includeFusionKernels: true,
      });
      expect(result.status).toBe("estimated");
      if (result.status !== "estimated" || trusted.status !== "estimated") return;
      expect(result.ballConfirmed).toBe(true);
      expect(result.confidence).toBe(trusted.confidence);
      expect(result.confidence).toBeGreaterThan(NO_BALL_CONFIDENCE);
      const ballKernels = result.fusionKernels!.filter((kernel) =>
        kernel.signal.startsWith("ball_"),
      );
      expect(ballKernels.length).toBeGreaterThan(0);
      for (const kernel of ballKernels)
        expect(kernel.note).not.toContain("ball observation confidence");
    });
  }

  it("confidence -1 / -Infinity → cannot confirm (clamp01 floors to 0)", () => {
    for (const confidence of [-1, Number.NEGATIVE_INFINITY]) {
      const result = estimateContact({
        sequence: SEQUENCE,
        window: WINDOW,
        ballObservations: ballTurnAt(PEAK, RIGHT_WRIST_AT_PEAK, confidence),
        includeFusionKernels: true,
      });
      if (result.status !== "estimated") continue;
      expect(result.ballConfirmed).toBe(false);
      expect(result.confidence).toBeLessThanOrEqual(0.7);
    }
  });

  it("no NaN ever reaches the public output for any hostile confidence", () => {
    for (const confidence of [
      Number.NaN,
      1.5,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
    ]) {
      const result = estimateContact({
        sequence: SEQUENCE,
        window: WINDOW,
        ballObservations: ballTurnAt(PEAK, RIGHT_WRIST_AT_PEAK, confidence),
        includeFusionKernels: true,
      });
      expectAllNumbersFinite(result, `confidence=${confidence}`);
      if (result.status === "estimated") {
        expect(Number.isFinite(result.confidence)).toBe(true);
        expect(Number.isFinite(result.estimatedContactMs)).toBe(true);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S5 — paddleIdentityGate on unmeasurable tracks
// ─────────────────────────────────────────────────────────────────────────────
describe("S5 paddleIdentityGate:true with a 1-point track and a 5-point 401 ms-gap track", () => {
  const speeds = paddleSpeedRamp(PEAK);
  const singlePoint = [{ timestampMs: PEAK, x: RIGHT_WRIST_AT_PEAK.x, y: RIGHT_WRIST_AT_PEAK.y }];
  const gapped = [-2, -1, 0, 1, 2].map((step) => ({
    timestampMs: PEAK + step * 401,
    x: RIGHT_WRIST_AT_PEAK.x,
    y: RIGHT_WRIST_AT_PEAK.y,
  }));
  const targetWristTracks = SEQUENCE.frames.map((frame) => {
    const wrist = frame.landmarks.find((mark) => mark.name === "right_wrist")!;
    return { timestampMs: frame.timestampMs, x: wrist.x, y: wrist.y };
  });
  const identityInput = { targetWristTracks: [targetWristTracks], aspect: 1, torsoSpan: 0.22 };

  it("assessPaddleTrackIdentity: single-point track → 'undetermined' (no speed samples)", () => {
    const verdict = assessPaddleTrackIdentity({ paddleCenters: singlePoint, ...identityInput });
    expect(verdict.verdict).toBe("undetermined");
    expect(verdict.evidence.paddleSpeedSamples).toBe(0);
  });

  it("assessPaddleTrackIdentity: 5-point track with 401 ms gaps → 'undetermined' (every step exceeds maxStepMs 400)", () => {
    const verdict = assessPaddleTrackIdentity({ paddleCenters: gapped, ...identityInput });
    expect(verdict.verdict).toBe("undetermined");
    expect(verdict.evidence.paddleTrackGaps.count).toBe(4);
    expect(verdict.evidence.paddleTrackGaps.maxGapMs).toBe(401);
    expect(verdict.evidence.paddleSpeedSamples).toBe(0);
  });

  it("control: 5-point track with 400 ms steps is still fragmented (undetermined) — the gate cannot measure a 2.5 Hz track", () => {
    const at400 = gapped.map((center, index) => ({
      ...center,
      timestampMs: PEAK + (index - 2) * 400,
    }));
    const verdict = assessPaddleTrackIdentity({ paddleCenters: at400, ...identityInput });
    expect(verdict.verdict).toBe("undetermined");
  });

  const run = (paddleCenters: typeof singlePoint, paddleIdentityGate: boolean) =>
    estimateContact({
      sequence: SEQUENCE,
      window: WINDOW,
      ballObservations: null,
      paddleSpeeds: speeds,
      paddleCenters,
      paddleIdentityGate,
      includeFusionKernels: true,
    });

  for (const [label, track] of [
    ["single-point", singlePoint],
    ["5-point/401ms", gapped],
  ] as const) {
    it.fails(
      `${label} track under paddleIdentityGate:true must not confirm the paddle or lift confidence above the no-paddle run`,
      () => {
        const gated = run(track, true);
        expect(gated.status).toBe("estimated");
        if (gated.status !== "estimated") return;
        expect(gated.paddleConfirmed).toBe(false);
        expect(gated.confidence).toBeLessThanOrEqual(NO_BALL_CONFIDENCE);
      },
    );

    it(`observed: ${label} track → paddleConfirmed true @0.7 with gate on, byte-identical to gate off, identity verdict not surfaced (evidence for the finding above)`, () => {
      const gated = run(track, true);
      const ungated = run(track, false);
      expect(gated.status).toBe("estimated");
      if (gated.status !== "estimated") return;
      expect(gated.paddleConfirmed).toBe(true);
      expect(gated.confidence).toBeCloseTo(0.7, 6);
      expect(gated.confidence).toBeGreaterThan(NO_BALL_CONFIDENCE);
      expect(JSON.stringify(gated)).toBe(JSON.stringify(ungated));
      expect(gated.limitingFactors.some((factor) => factor.includes("identity"))).toBe(false);
    });
  }

  it("empty paddleCenters with paddleIdentityGate:true → gate skipped, paddle speed evidence still fused (documented: gate needs ≥1 center)", () => {
    const result = run([], true);
    expect(result.status).toBe("estimated");
    if (result.status !== "estimated") return;
    expect(result.paddleConfirmed).toBe(false);
    expect(result.limitingFactors).toContain("paddle_lost_at_contact");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S6 — paddle timestamps offset +10 s from the pose time base
// ─────────────────────────────────────────────────────────────────────────────
describe("S6 paddle track offset +10 s from the pose time base", () => {
  const OFFSET_MS = 10_000;
  const skewedSpeeds = paddleSpeedRamp(PEAK).map((sample) => ({
    ...sample,
    timestampMs: sample.timestampMs + OFFSET_MS,
  }));
  const skewedCenters = paddleCentersAlong(skewedSpeeds, RIGHT_WRIST_AT_PEAK);
  const wideWindow = {
    startMs: WINDOW.startMs,
    endMs: WINDOW.endMs + OFFSET_MS,
    peakMotionMs: PEAK,
  };

  it("window scoped to the pose: the remote paddle track contributes nothing (no paddle_speed_peak, confidence = no-ball run)", () => {
    const result = estimateContact({
      sequence: SEQUENCE,
      window: WINDOW,
      ballObservations: null,
      paddleSpeeds: skewedSpeeds,
      paddleCenters: skewedCenters,
      includeFusionKernels: true,
    });
    expect(result.status).toBe("estimated");
    if (result.status !== "estimated") return;
    expect(result.estimatedContactMs).toBe(PEAK);
    expect(result.paddleConfirmed).toBe(false);
    expect(result.limitingFactors).toContain("no_paddle_evidence");
    expect(result.supportingEvidence.some((entry) => entry.signal === "paddle_speed_peak")).toBe(
      false,
    );
    expect(result.confidence).toBeCloseTo(NO_BALL_CONFIDENCE, 6);
  });

  it("window widened over the skew, peakMotionMs given: abstains (multi-modal, 10000 ms apart) rather than estimating at the paddle peak", () => {
    const result = estimateContact({
      sequence: SEQUENCE,
      window: wideWindow,
      ballObservations: null,
      paddleSpeeds: skewedSpeeds,
      paddleCenters: skewedCenters,
      includeFusionKernels: true,
    });
    expect(result.status).toBe("abstained");
    if (result.status !== "abstained") return;
    expect(result.limitingFactors).toContain("contact_evidence_multimodal");
  });

  it("window widened, peakMotionMs given, wrists frozen: abstains contact_far_from_motion_peak", () => {
    const result = estimateContact({
      sequence: withFrozenWrists(SEQUENCE),
      window: wideWindow,
      ballObservations: null,
      paddleSpeeds: skewedSpeeds,
      paddleCenters: skewedCenters,
      includeFusionKernels: true,
    });
    expect(result.status).toBe("abstained");
    if (result.status !== "abstained") return;
    expect(result.limitingFactors).toContain("contact_far_from_motion_peak");
  });

  it.fails(
    "window widened, peakMotionMs null, wrists quiet: a paddle peak 9 s after the LAST pose frame must not become a confident contact",
    () => {
      const result = estimateContact({
        sequence: withFrozenWrists(SEQUENCE),
        window: { ...wideWindow, peakMotionMs: null },
        ballObservations: null,
        paddleSpeeds: skewedSpeeds,
        paddleCenters: skewedCenters,
        includeFusionKernels: true,
      });
      if (result.status !== "estimated") return; // abstention is the expected outcome
      expect(result.estimatedContactMs).toBeLessThanOrEqual(LAST_POSE_MS + 250);
      expect(result.paddleConfirmed).toBe(false);
    },
  );

  it("observed: paddle-only peak at +10 s is committed as estimatedContactMs=11100, paddleConfirmed @0.7, 9130 ms after the last pose frame (evidence for the finding above)", () => {
    const result = estimateContact({
      sequence: withFrozenWrists(SEQUENCE),
      window: { ...wideWindow, peakMotionMs: null },
      ballObservations: null,
      paddleSpeeds: skewedSpeeds,
      paddleCenters: skewedCenters,
      includeFusionKernels: true,
    });
    expect(result.status).toBe("estimated");
    if (result.status !== "estimated") return;
    expect(result.estimatedContactMs).toBe(PEAK + OFFSET_MS);
    expect(result.estimatedContactMs - LAST_POSE_MS).toBeGreaterThan(9000);
    expect(result.paddleConfirmed).toBe(true);
    expect(result.confidence).toBeCloseTo(0.7, 6);
    expect(result.supportingEvidence.map((entry) => entry.signal)).toEqual(["paddle_speed_peak"]);
  });

  it("negative skew (-10 s) with a pose-scoped window also contributes nothing", () => {
    const early = paddleSpeedRamp(PEAK).map((sample) => ({
      ...sample,
      timestampMs: sample.timestampMs - OFFSET_MS,
    }));
    const result = estimateContact({
      sequence: SEQUENCE,
      window: WINDOW,
      ballObservations: null,
      paddleSpeeds: early,
      paddleCenters: paddleCentersAlong(early, RIGHT_WRIST_AT_PEAK),
    });
    expect(result.status).toBe("estimated");
    if (result.status !== "estimated") return;
    expect(result.limitingFactors).toContain("no_paddle_evidence");
    expect(result.confidence).toBeCloseTo(NO_BALL_CONFIDENCE, 6);
  });
});
