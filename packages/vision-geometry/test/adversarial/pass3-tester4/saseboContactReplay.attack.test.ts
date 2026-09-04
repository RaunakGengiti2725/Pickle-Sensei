import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toLegacyPoseFrames } from "@pickle/swing-domain";
import {
  buildPlayerTracks,
  targetPoseSequence,
  type PeopleFile,
} from "../../../../swing-lab/src/playerTracker.js";
import {
  loadBallObservations,
  loadGoldEvents,
  replayAll,
} from "../../../eval/contactGoldReplay.js";
import { estimateContact, paddleOwnershipFromHandAffinity } from "../../../src/index.js";

/**
 * ADVERSARIAL PASS 3 / TESTER 4 — S4: replay the committed
 * wavea-sasebo-volleys gold event @52019ms through `replayAll()` with
 * `ownershipConditionedPosterior:true` and — because `replayAll()` exposes no
 * `paddleIdentityGate` option — through the underlying `estimateContact()`
 * with `paddleIdentityGate:true` on the identical inputs, and record whether
 * the committed 144ms wrong marker (confidence 0.683 in
 * datasets/experiments/wave-g/g02-f09-oracle-results.json) abstains or
 * persists. LINUX replay proxy over committed people.json; no dataset or
 * tolerance is written.
 */

const REPO = join(import.meta.dirname, "../../../../..");
const BUNDLE = "wavea-sasebo-volleys";
const GOLD_CONTACT_MS = 52019;
const PEOPLE_PATH = join(REPO, "datasets/paddle-bench/runs-wave-a", BUNDLE, "people.json");
const G02_PATH = join(REPO, "datasets/experiments/wave-g/g02-f09-oracle-results.json");

interface LegacyFrame {
  timestampMs: number;
  landmarks: Array<{ name: string; x: number; y: number; visibility: number }>;
}

/** Same construction as contactGoldReplay.ts (not exported there). */
function wristSeries(frames: LegacyFrame[]): Array<{ timestampMs: number; x: number; y: number }> {
  const series: Array<{ timestampMs: number; x: number; y: number }> = [];
  for (const frame of frames) {
    for (const name of ["left_wrist", "right_wrist"]) {
      const joint = frame.landmarks.find(
        (landmark) => landmark.name === name && landmark.visibility > 0.1,
      );
      if (joint) series.push({ timestampMs: frame.timestampMs, x: joint.x, y: joint.y });
    }
  }
  return series;
}

function wristSpeedPeakMs(frames: LegacyFrame[]): number | null {
  let best: { tMs: number; speed: number } | null = null;
  for (const name of ["left_wrist", "right_wrist"]) {
    let previous: { tMs: number; x: number; y: number } | null = null;
    for (const frame of frames) {
      const joint = frame.landmarks.find(
        (landmark) => landmark.name === name && landmark.visibility > 0.1,
      );
      if (!joint) continue;
      if (previous && frame.timestampMs > previous.tMs) {
        const dt = (frame.timestampMs - previous.tMs) / 1000;
        const speed = Math.hypot(joint.x - previous.x, joint.y - previous.y) / dt;
        if (!best || speed > best.speed) best = { tMs: frame.timestampMs, speed };
      }
      previous = { tMs: frame.timestampMs, x: joint.x, y: joint.y };
    }
  }
  return best?.tMs ?? null;
}

function saseboInputs(pad = 250) {
  const people = JSON.parse(readFileSync(PEOPLE_PATH, "utf8")) as PeopleFile;
  const tracks = buildPlayerTracks(people);
  const target = [...tracks].sort(
    (a, b) => b.coverage * b.meanTorsoSpan - a.coverage * a.meanTorsoSpan,
  )[0]!;
  const sequence = targetPoseSequence(people, target);
  const ball = loadBallObservations(BUNDLE);
  const event = loadGoldEvents().find(
    (candidate) => candidate.bundle === BUNDLE && candidate.contactMs === GOLD_CONTACT_MS,
  );
  if (!event) throw new Error("gold event @52019 not found");
  const startMs = event.eventStartMs - pad;
  const endMs = event.eventEndMs + pad;
  const frames = toLegacyPoseFrames(sequence).filter(
    (frame) => frame.timestampMs >= startMs && frame.timestampMs <= endMs,
  );
  return {
    sequence,
    event,
    ball,
    window: { startMs, endMs, peakMotionMs: wristSpeedPeakMs(frames) },
    targetWrists: wristSeries(frames),
  };
}

const committed = (() => {
  const artifact = JSON.parse(readFileSync(G02_PATH, "utf8")) as {
    conditions?: Array<{
      condition: string;
      rows: Array<{
        bundle: string;
        goldContactMs: number;
        status: string;
        estimatedContactMs: number | null;
        errorMs: number | null;
        confidence: number | null;
        limitingFactors: string[];
      }>;
    }>;
  };
  const text = JSON.stringify(artifact);
  const match = text.match(
    /"bundle":"wavea-sasebo-volleys","session":"dvids-sasebo","goldContactMs":52019,[^}]*?"status":"(\w+)","estimatedContactMs":(\d+|null),"errorMs":(\d+|null),"confidence":([\d.]+|null)/,
  );
  return match
    ? {
        status: match[1]!,
        estimatedContactMs: match[2] === "null" ? null : Number(match[2]),
        errorMs: match[3] === "null" ? null : Number(match[3]),
        confidence: match[4] === "null" ? null : Number(match[4]),
      }
    : null;
})();

describe.skipIf(!existsSync(PEOPLE_PATH))("S4 wavea-sasebo-volleys gold @52019ms", () => {
  it("committed g02 artifact records the wrong marker exactly as assigned: estimated 51875, error 144, confidence 0.683", () => {
    expect(committed).toEqual({
      status: "estimated",
      estimatedContactMs: 51875,
      errorMs: 144,
      confidence: 0.683,
    });
  });

  it("replayAll({ownershipConditionedPosterior:true}) @52019: the 144ms wrong marker PERSISTS (status estimated, 51875ms, conf 0.683, no_paddle_evidence) — ownership conditioning is a no-op with no paddle track", () => {
    const rows = replayAll({ ownershipConditionedPosterior: true });
    const row = rows.find(
      (candidate) =>
        candidate.event.bundle === BUNDLE && candidate.event.contactMs === GOLD_CONTACT_MS,
    );
    expect(row).toBeDefined();
    console.log(
      "[S4 replayAll ownershipConditionedPosterior:true @52019]",
      JSON.stringify({
        status: row!.status,
        estimatedContactMs: row!.estimatedContactMs,
        errorMs: row!.errorMs,
        confidence: row!.confidence,
        reason: row!.reason,
        limitingFactors: row!.limitingFactors,
        ballConfirmed: row!.ballConfirmed,
        supportingEvidence: row!.supportingEvidence,
      }),
    );
    expect(row!.status).toBe("estimated");
    expect(row!.estimatedContactMs).toBe(51875);
    expect(row!.errorMs).toBe(144);
    expect(row!.confidence).toBeCloseTo(0.683, 3);
    expect(row!.limitingFactors).toContain("no_paddle_evidence");
    expect(row!.ballConfirmed).toBe(true);
  });

  it("replayAll() with and without ownershipConditionedPosterior are byte-identical for every gold row (no paddle track anywhere → conditioning cannot act)", () => {
    const off = JSON.stringify(replayAll());
    const on = JSON.stringify(replayAll({ ownershipConditionedPosterior: true }));
    expect(on).toBe(off);
  });

  it("replayAll() does not accept paddleIdentityGate: an extra key is ignored and output is unchanged (the assigned combination is unreachable through replayAll)", () => {
    const baseline = JSON.stringify(replayAll({ ownershipConditionedPosterior: true }));
    const withGate = JSON.stringify(
      replayAll({
        ownershipConditionedPosterior: true,
        // deliberately outside the declared option type
        ...({ paddleIdentityGate: true } as Record<string, boolean>),
      }),
    );
    expect(withGate).toBe(baseline);
  });

  it("estimateContact() on the identical inputs with paddleIdentityGate:true + ownershipConditionedPosterior:true: the wrong marker PERSISTS byte-identically (identity gate requires paddleCenters, which are null on Linux)", () => {
    const inputs = saseboInputs();
    const ownership = paddleOwnershipFromHandAffinity({
      sequence: inputs.sequence,
      paddleCenters: null,
      targetWrists: inputs.targetWrists,
    });
    expect(ownership).toBeNull();
    const base = {
      sequence: inputs.sequence,
      window: inputs.window,
      ballObservations: inputs.ball.length > 0 ? inputs.ball : null,
      paddleSpeeds: null,
      paddleCenters: null,
      targetWrists: inputs.targetWrists,
      strokeFamily: inputs.event.family,
    };
    const plain = estimateContact(base);
    const gated = estimateContact({
      ...base,
      paddleIdentityGate: true,
      ownershipConditionedPosterior: true,
      paddleOwnershipConfidence: ownership?.confidence ?? null,
    });
    expect(JSON.stringify(gated)).toBe(JSON.stringify(plain));
    expect(gated.status).toBe("estimated");
    if (gated.status !== "estimated") return;
    expect(gated.estimatedContactMs).toBe(51875);
    expect(Math.abs(gated.estimatedContactMs - GOLD_CONTACT_MS)).toBe(144);
    expect(gated.confidence).toBeCloseTo(0.683, 3);
    expect(gated.limitingFactors).not.toContain("paddle_track_identity_foreign");
  });

  it("ownership confidence forced to 0 (fully-rejected paddle ownership) still cannot move the marker with no paddle track: byte-identical", () => {
    const inputs = saseboInputs();
    const base = {
      sequence: inputs.sequence,
      window: inputs.window,
      ballObservations: inputs.ball,
      paddleSpeeds: null,
      paddleCenters: null,
      targetWrists: inputs.targetWrists,
      strokeFamily: inputs.event.family,
    };
    const plain = JSON.stringify(estimateContact(base));
    for (const confidence of [0, 0.5, 1]) {
      const forced = JSON.stringify(
        estimateContact({
          ...base,
          paddleIdentityGate: true,
          ownershipConditionedPosterior: true,
          paddleOwnershipConfidence: confidence,
        }),
      );
      expect(forced, `paddleOwnershipConfidence=${confidence}`).toBe(plain);
    }
  });

  it("a synthetic paddle track riding the target wrist through the gold moment (oracle paddle): records whether paddle evidence can pull the marker toward 52019", () => {
    const inputs = saseboInputs();
    // Paddle center = target wrist offset by 0.02 (a hand-held paddle), for
    // every wrist sample inside the window; a genuine-ownership track.
    const paddleCenters = inputs.targetWrists.map((wrist) => ({
      timestampMs: wrist.timestampMs,
      x: wrist.x + 0.02,
      y: wrist.y - 0.02,
    }));
    const ownership = paddleOwnershipFromHandAffinity({
      sequence: inputs.sequence,
      paddleCenters,
      targetWrists: inputs.targetWrists,
    });
    expect(ownership).not.toBeNull();
    expect(ownership!.confidence).toBeGreaterThan(0.9);
    const estimate = estimateContact({
      sequence: inputs.sequence,
      window: inputs.window,
      ballObservations: inputs.ball,
      paddleSpeeds: null,
      paddleCenters,
      targetWrists: inputs.targetWrists,
      strokeFamily: inputs.event.family,
      paddleIdentityGate: true,
      ownershipConditionedPosterior: true,
      paddleOwnershipConfidence: ownership!.confidence,
    });
    console.log(
      "[S4 oracle paddle-on-wrist @52019]",
      JSON.stringify(
        estimate.status === "estimated"
          ? {
              status: estimate.status,
              estimatedContactMs: estimate.estimatedContactMs,
              errorMs: Math.abs(estimate.estimatedContactMs - GOLD_CONTACT_MS),
              confidence: estimate.confidence,
              limitingFactors: estimate.limitingFactors,
            }
          : {
              status: estimate.status,
              reason: estimate.reason,
              limitingFactors: estimate.limitingFactors,
            },
      ),
    );
    // A genuine paddle must never be declared foreign by the identity gate.
    expect(estimate.limitingFactors ?? []).not.toContain("paddle_track_identity_foreign");
    if (estimate.status === "estimated") {
      expect(Number.isFinite(estimate.confidence)).toBe(true);
      expect(estimate.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("rapid repeats: 5 consecutive replayAll() runs are byte-identical (no hidden state in the replay path)", () => {
    const first = JSON.stringify(replayAll({ ownershipConditionedPosterior: true }));
    for (let index = 0; index < 4; index += 1) {
      expect(JSON.stringify(replayAll({ ownershipConditionedPosterior: true }))).toBe(first);
    }
  });
});
