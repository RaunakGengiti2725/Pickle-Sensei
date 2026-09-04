import { describe, expect, it } from "vitest";
import { generateSwingSequence } from "@pickle/evaluation";
import type { BallObservation } from "@pickle/swing-domain";
import {
  assessPaddleTrackIdentity,
  classifyStroke,
  estimateContact,
  type HeuristicPaddleObservation,
} from "../../src/index.js";
import { cloneSequence } from "./support.js";

/**
 * AUDIT PROBES — paddleTrackIdentity.ts boundaries / invalid points,
 * strokeHeuristicLite.ts invalid reference inputs, estimateContact input
 * order independence and ball-confidence range handling.
 */

function arcTrack(options: {
  fromMs: number;
  toMs: number;
  peakMs: number;
  base: { x: number; y: number };
  amplitude: number;
  stepMs?: number;
}) {
  const points: Array<{ timestampMs: number; x: number; y: number }> = [];
  for (let t = options.fromMs; t <= options.toMs; t += options.stepMs ?? 30) {
    const arc = Math.exp(-((t - options.peakMs) ** 2) / (2 * 100 * 100));
    points.push({
      timestampMs: t,
      x: options.base.x + options.amplitude * arc,
      y: options.base.y - 0.3 * options.amplitude * arc,
    });
  }
  return points;
}

const TORSO = 0.2;

describe("AUDIT assessPaddleTrackIdentity boundaries and invalid points", () => {
  const wrist = arcTrack({
    fromMs: 0,
    toMs: 2000,
    peakMs: 1000,
    base: { x: 0.5, y: 0.6 },
    amplitude: 0.2,
  });
  const ridingPaddle = wrist.map((p) => ({ ...p, x: p.x + 0.05, y: p.y - 0.03 }));

  it("riding paddle is target_consistent (baseline)", () => {
    const a = assessPaddleTrackIdentity({
      paddleCenters: ridingPaddle,
      targetWristTracks: [wrist],
      aspect: 1,
      torsoSpan: TORSO,
    });
    expect(a.verdict).toBe("target_consistent");
  });

  it("unsorted paddle timestamps must give the same verdict as sorted (order independence)", () => {
    const shuffled = [...ridingPaddle].reverse();
    const a = assessPaddleTrackIdentity({
      paddleCenters: shuffled,
      targetWristTracks: [wrist],
      aspect: 1,
      torsoSpan: TORSO,
    });
    console.log(`[audit] reversed paddle order → ${a.verdict} ${JSON.stringify(a.evidence)}`);
    expect(a.verdict).toBe("target_consistent");
  });

  it("a NaN paddle center must not poison targetSynchrony (evidence becomes NaN)", () => {
    const poisoned = ridingPaddle.map((p, i) => (i === 33 ? { ...p, x: Number.NaN } : p));
    const a = assessPaddleTrackIdentity({
      paddleCenters: poisoned,
      targetWristTracks: [wrist],
      aspect: 1,
      torsoSpan: TORSO,
    });
    console.log(`[audit] NaN center → ${a.verdict} ${JSON.stringify(a.evidence)}`);
    expect(a.verdict).not.toBe("foreign");
    expect(Number.isNaN(a.evidence.targetSynchrony ?? 0)).toBe(false);
  });

  it("exactly maxStepMs (400ms) gaps are still consecutive steps; 401ms are gaps (documents bound)", () => {
    const sparseWrist = arcTrack({
      fromMs: 0,
      toMs: 4000,
      peakMs: 2000,
      base: { x: 0.5, y: 0.6 },
      amplitude: 0.2,
      stepMs: 400,
    });
    const sparsePaddle = sparseWrist.map((p) => ({ ...p, x: p.x + 0.05 }));
    const at = assessPaddleTrackIdentity({
      paddleCenters: sparsePaddle,
      targetWristTracks: [sparseWrist],
      aspect: 1,
      torsoSpan: TORSO,
    });
    const over = assessPaddleTrackIdentity({
      paddleCenters: sparsePaddle.map((p) => ({ ...p, timestampMs: p.timestampMs * 1.0025 })),
      targetWristTracks: [sparseWrist.map((p) => ({ ...p, timestampMs: p.timestampMs * 1.0025 }))],
      aspect: 1,
      torsoSpan: TORSO,
    });
    console.log(
      `[audit] step=400 → ${at.verdict} samples=${at.evidence.paddleSamples}; step=401 → ${over.verdict} samples=${over.evidence.paddleSamples}`,
    );
    expect(over.verdict).toBe("undetermined");
    expect(at.verdict).not.toBe("foreign");
  });

  it("NaN torsoSpan / NaN aspect abstain (never foreign)", () => {
    const nanTorso = assessPaddleTrackIdentity({
      paddleCenters: ridingPaddle,
      targetWristTracks: [wrist],
      aspect: 1,
      torsoSpan: Number.NaN,
    });
    const nanAspect = assessPaddleTrackIdentity({
      paddleCenters: ridingPaddle,
      targetWristTracks: [wrist],
      aspect: Number.NaN,
      torsoSpan: TORSO,
    });
    console.log(`[audit] NaN torso → ${nanTorso.verdict}; NaN aspect → ${nanAspect.verdict}`);
    expect(nanTorso.verdict).toBe("undetermined");
    expect(nanAspect.verdict).not.toBe("foreign");
  });
});

describe("AUDIT classifyStroke invalid reference inputs", () => {
  const { sequence, window } = generateSwingSequence();
  const base = {
    sequence,
    window: { startMs: window.startMs, endMs: window.endMs },
    handedness: "right" as const,
    paddle: null,
    paddleSpeeds: null,
    wristSpeeds: null,
  };

  it("clean event-peak reference commits (baseline)", () => {
    const p = classifyStroke({ ...base, contactMs: null, eventPeakMs: window.peakMs });
    expect(p.label).not.toBe("UNKNOWN");
  });

  it("NaN contactMs must abstain, not commit", () => {
    const p = classifyStroke({ ...base, contactMs: Number.NaN });
    console.log(`[audit] NaN contactMs → ${p.label} ${JSON.stringify(p.limitingFactors)}`);
    expect(p.label).toBe("UNKNOWN");
  });

  it("contactMs far outside the window (never observed) must abstain", () => {
    const p = classifyStroke({ ...base, contactMs: window.endMs + 5000 });
    console.log(
      `[audit] out-of-window contactMs → ${p.label} ${JSON.stringify(p.limitingFactors)}`,
    );
    expect(p.label).toBe("UNKNOWN");
  });

  it("startMs === endMs degenerate window with a valid contact: documents behaviour", () => {
    const p = classifyStroke({
      ...base,
      window: { startMs: window.peakMs, endMs: window.peakMs },
      contactMs: window.peakMs,
    });
    console.log(
      `[audit] zero-length window → ${p.label} conf=${p.confidence} ${JSON.stringify(p.limitingFactors)}`,
    );
    expect(p.confidence).toBeLessThanOrEqual(1);
  });

  it("NaN paddle centers must not be used as the contact reference", () => {
    const paddle: HeuristicPaddleObservation[] = Array.from({ length: 11 }, (_, i) => ({
      timestampMs: window.peakMs - 200 + i * 40,
      center: { x: Number.NaN, y: Number.NaN },
    }));
    const clean = classifyStroke({ ...base, contactMs: window.peakMs });
    const p = classifyStroke({ ...base, contactMs: window.peakMs, paddle });
    console.log(
      `[audit] NaN paddle → ${p.label} conf=${p.confidence} evidence=${JSON.stringify(p.evidence)} limiting=${JSON.stringify(p.limitingFactors)}`,
    );
    // Either fall back to the wrist (same as clean) or abstain — never a NaN-driven label.
    expect([clean.label, "UNKNOWN"]).toContain(p.label);
    expect(p.limitingFactors).toContain("paddle_point_implausible_used_wrist");
  });

  it("off-image paddle center (x=5) far from every joint must not be trusted as the contact point", () => {
    const paddle: HeuristicPaddleObservation[] = Array.from({ length: 11 }, (_, i) => ({
      timestampMs: window.peakMs - 200 + i * 40,
      center: { x: 5, y: 0.7 },
    }));
    const clean = classifyStroke({ ...base, contactMs: window.peakMs });
    const p = classifyStroke({ ...base, contactMs: window.peakMs, paddle });
    console.log(
      `[audit] off-image paddle → ${p.label} conf=${p.confidence} evidence=${JSON.stringify(p.evidence)} limiting=${JSON.stringify(p.limitingFactors)}`,
    );
    expect([clean.label, "UNKNOWN"]).toContain(p.label);
  });
});

describe("AUDIT estimateContact input order independence and ball confidence range", () => {
  const { sequence, window } = generateSwingSequence();
  const windowArg = { startMs: window.startMs, endMs: window.endMs, peakMotionMs: window.peakMs };
  const ref = sequence.frames.reduce((best, f) =>
    Math.abs(f.timestampMs - window.peakMs) < Math.abs(best.timestampMs - window.peakMs) ? f : best,
  );
  const wrist = ref.landmarks.find((m) => m.name === "right_wrist")!;
  const nearBall = (confidence: number): BallObservation[] =>
    Array.from({ length: 10 }, (_, index) => {
      const t = window.peakMs - 150 + index * 30;
      const before = index <= 5;
      return {
        frameIndex: index,
        timestampMs: t,
        x: before ? wrist.x - 0.15 + index * 0.03 : wrist.x + 0.03 - (index - 5) * 0.03,
        y: wrist.y,
        confidence,
      };
    });

  it("a plausible near-wrist ball turn is accepted (baseline)", () => {
    const e = estimateContact({ sequence, window: windowArg, ballObservations: nearBall(0.8) });
    expect(e.status).toBe("estimated");
    if (e.status !== "estimated") return;
    expect(e.ballConfirmed).toBe(true);
  });

  it("shuffled ball observation order yields a byte-identical estimate", () => {
    const ball = nearBall(0.8);
    const shuffled = [
      ball[7]!,
      ball[2]!,
      ball[9]!,
      ball[0]!,
      ball[5]!,
      ball[1]!,
      ball[8]!,
      ball[3]!,
      ball[6]!,
      ball[4]!,
    ];
    const a = estimateContact({ sequence, window: windowArg, ballObservations: ball });
    const b = estimateContact({ sequence, window: windowArg, ballObservations: shuffled });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("reversed pose frame order: documents that the PoseSequence 'ascending' precondition is relied upon, not validated", () => {
    // swing-domain PoseSequence.frames is documented "Ascending by timestampMs";
    // this probe only records what happens when a caller violates it.
    const reversed = cloneSequence(sequence);
    reversed.frames.reverse();
    const a = estimateContact({ sequence, window: windowArg, ballObservations: nearBall(0.8) });
    const b = estimateContact({
      sequence: reversed,
      window: windowArg,
      ballObservations: nearBall(0.8),
    });
    const brief = (e: typeof a) =>
      e.status === "estimated"
        ? `t=${e.estimatedContactMs} conf=${e.confidence.toFixed(3)} signals=${e.supportingEvidence.map((s) => s.signal).join(",")}`
        : `${e.status}`;
    console.log(`[audit] frames ascending: ${brief(a)}\n[audit] frames reversed : ${brief(b)}`);
    expect(a.status).toBe("estimated");
  });

  it("NaN ball confidence must not confirm the estimate", () => {
    const e = estimateContact({
      sequence,
      window: windowArg,
      ballObservations: nearBall(Number.NaN),
    });
    console.log(`[audit] NaN ball confidence → ${JSON.stringify(e).slice(0, 500)}`);
    expect(e.status).toBe("estimated");
    if (e.status !== "estimated") return;
    expect(e.ballConfirmed).toBe(false);
    expect(e.supportingEvidence.map((s) => s.signal)).not.toContain("ball_direction_change");
  });

  it("ball confidence > 1 must not weigh more than confidence 1", () => {
    const one = estimateContact({ sequence, window: windowArg, ballObservations: nearBall(1) });
    const huge = estimateContact({ sequence, window: windowArg, ballObservations: nearBall(50) });
    expect(one.status).toBe("estimated");
    expect(huge.status).toBe("estimated");
    if (one.status !== "estimated" || huge.status !== "estimated") return;
    console.log(`[audit] conf=1 → ${one.confidence}; conf=50 → ${huge.confidence}`);
    expect(huge.confidence).toBeLessThanOrEqual(one.confidence);
  });
});
