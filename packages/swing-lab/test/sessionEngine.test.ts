import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePoseSequence, toLegacyPoseFrames, type PoseSequence } from "@pickle/swing-domain";
import { detectOfflineStrokeWindow } from "@pickle/vision-geometry";
import { REPO_ROOT } from "../src/engine/corpus.js";
import {
  buildPlayerTracks,
  initializeTargetFromSeed,
  targetPoseSequence,
  type PeopleFile,
} from "../src/playerTracker.js";
import { clampToScene, decideScene, type ScenesFile } from "../src/sceneValidity.js";
import { proposeStrokeEventsV2, type StrokeEventProposalV2 } from "../src/strokeEvents.js";
import {
  BOUND_STABILITY_MS,
  SESSION_COMPLETION,
  SessionEventEngine,
  type SessionStrokeEvent,
  type SpeedSample,
} from "../src/sessionEngine.js";

/** Speed series with gaussian-ish bumps (same helper as strokeEvents.test). */
function speedBumps(
  bumps: Array<{ peakMs: number; height: number; halfWidthMs: number }>,
  fromMs = 0,
  toMs = 8000,
  stepMs = 40,
): SpeedSample[] {
  const series: SpeedSample[] = [];
  for (let t = fromMs; t <= toMs; t += stepMs) {
    let value = 0.08; // idle baseline
    for (const bump of bumps) {
      value += bump.height * Math.exp(-0.5 * ((t - bump.peakMs) / bump.halfWidthMs) ** 2);
    }
    series.push({ timestampMs: t, value });
  }
  return series;
}

function streamPerSample(
  engine: SessionEventEngine,
  series: readonly SpeedSample[],
): SessionStrokeEvent[] {
  const emitted: SessionStrokeEvent[] = [];
  for (const sample of series) emitted.push(...engine.pushWristSample(sample));
  return emitted;
}

describe("SessionEventEngine — streaming segmentation (synthetic)", () => {
  it("two clean strokes → two settle-closed events, first closed before the second begins", () => {
    const series = speedBumps(
      [
        { peakMs: 1200, height: 2.0, halfWidthMs: 120 },
        { peakMs: 3500, height: 2.0, halfWidthMs: 120 },
      ],
      0,
      6000,
    );
    const engine = new SessionEventEngine({ sessionId: "unit-two-clean" });
    const emitted = streamPerSample(engine, series);
    expect(engine.flush()).toEqual([]); // both closed live, nothing left over
    expect(emitted.map((event) => event.eventId)).toEqual(["E1", "E2"]);
    expect(emitted.map((event) => event.closeReason)).toEqual(["settle", "settle"]);
    const [first, second] = emitted;
    // Settle emission waits for the boundary-reach cap (peak+1200) so the
    // end bound is frozen exactly once no future sample can move it.
    expect(first!.closedAtMs).toBeGreaterThanOrEqual(first!.proposal.peakMs + BOUND_STABILITY_MS);
    expect(first!.closedAtMs).toBeLessThanOrEqual(first!.proposal.peakMs + BOUND_STABILITY_MS + 80);
    // Recording never stops: E1 is closed and final BEFORE stroke #2 begins.
    expect(first!.closedAtMs).toBeLessThan(second!.proposal.startMs);
    expect(first!.proposal.endMs).toBeLessThan(second!.proposal.startMs);
    for (const event of emitted) {
      expect(event.proposal.startMs).toBeLessThanOrEqual(event.proposal.peakMs);
      expect(event.proposal.peakMs).toBeLessThanOrEqual(event.proposal.endMs);
      expect(event.closedAtMs).toBeLessThanOrEqual(
        event.proposal.endMs + SESSION_COMPLETION.safetyMaxMs,
      );
      expect(event.state).toBe("pending");
    }
  });

  it("rapid consecutive strokes split at the D-029 valley; the earlier event closes when the next crests", () => {
    const series = speedBumps(
      [
        { peakMs: 1000, height: 2.0, halfWidthMs: 80 },
        { peakMs: 1650, height: 2.2, halfWidthMs: 80 },
      ],
      0,
      4500,
    );
    const engine = new SessionEventEngine({ sessionId: "unit-rapid-valley" });
    const emitted = streamPerSample(engine, series);
    expect(engine.flush()).toEqual([]);
    expect(emitted.map((event) => event.closeReason)).toEqual(["next_stroke_valley", "settle"]);
    const [first, second] = emitted;
    // Split, not stretched: honest boundary between the two movements.
    expect(first!.proposal.endMs).toBeLessThanOrEqual(second!.proposal.startMs);
    // The valley close happens as the next stroke rises — long before any
    // settle/stability horizon for E1 (measured 1720ms on this series).
    expect(first!.closedAtMs).toBeLessThan(2000);
    expect(first!.closedAtMs).toBeLessThanOrEqual(
      first!.proposal.endMs + SESSION_COMPLETION.safetyMaxMs,
    );
  });

  it("continuous motion that never settles → the hard safety max closes it (recording continues)", () => {
    const series: SpeedSample[] = [];
    // Oscillation 1.8–2.4 u/s: never under the settle threshold, valleys too
    // shallow (≥60% of peak) for the valley rule → only safety can close.
    for (let t = 0; t <= 3000; t += 40) {
      series.push({ timestampMs: t, value: 2.1 + 0.3 * Math.sin((2 * Math.PI * t) / 500) });
    }
    for (let t = 3040; t <= 3400; t += 40) series.push({ timestampMs: t, value: 0.05 });
    series.push(...speedBumps([{ peakMs: 3800, height: 2.0, halfWidthMs: 120 }], 3440, 5400));
    const engine = new SessionEventEngine({ sessionId: "unit-never-settles" });
    const emitted = streamPerSample(engine, series);
    expect(engine.flush()).toEqual([]);
    expect(emitted.length).toBe(2);
    const [rally, after] = emitted;
    expect(rally!.closeReason).toBe("safety_max");
    // Bounds stay stroke-event-2's: the end walk is capped at peak+1200.
    expect(rally!.proposal.endMs).toBe(rally!.proposal.peakMs + BOUND_STABILITY_MS);
    // Closure at trigger+2500 (trigger = raw peak inside the proposal).
    expect(rally!.closedAtMs).toBeGreaterThan(
      rally!.proposal.peakMs + SESSION_COMPLETION.safetyMaxMs,
    );
    expect(rally!.closedAtMs).toBeLessThanOrEqual(
      rally!.proposal.peakMs + SESSION_COMPLETION.safetyMaxMs + 80,
    );
    expect(rally!.closedAtMs).toBeLessThanOrEqual(
      rally!.proposal.endMs + SESSION_COMPLETION.safetyMaxMs,
    );
    // The engine kept listening: the stroke after the dip is its own event.
    expect(after!.closeReason).toBe("settle");
    expect(after!.proposal.startMs).toBeGreaterThan(rally!.proposal.endMs);
  });

  it("single stroke then silence → settle closes it live (no flush needed), faster than the shipped fixed 1.5s", () => {
    const series = speedBumps([{ peakMs: 1500, height: 2.0, halfWidthMs: 120 }], 0, 5000);
    const engine = new SessionEventEngine({ sessionId: "unit-single" });
    const emitted = streamPerSample(engine, series);
    expect(emitted.length).toBe(1);
    expect(engine.flush()).toEqual([]);
    const event = emitted[0]!;
    expect(event.closeReason).toBe("settle");
    expect(event.closedAtMs).toBeGreaterThanOrEqual(event.proposal.peakMs + BOUND_STABILITY_MS);
    expect(event.closedAtMs).toBeLessThanOrEqual(event.proposal.peakMs + BOUND_STABILITY_MS + 80);
    // peak+1200 emission beats the shipped fixed post-roll (trigger+1500).
    expect(event.closedAtMs).toBeLessThan(event.proposal.peakMs + 1500);
  });

  it("late samples after close are dropped and counted — closed events NEVER change retroactively", () => {
    const series = speedBumps([{ peakMs: 1500, height: 2.0, halfWidthMs: 120 }], 0, 5000);
    const engine = new SessionEventEngine({ sessionId: "unit-append-only" });
    const emitted = streamPerSample(engine, series);
    expect(emitted.length).toBe(1);
    const before = JSON.parse(JSON.stringify(engine.snapshot().events));
    // A late, enormous sample inside the closed event's span: if it were
    // accepted it would re-bound/re-peak the event. It must be dropped.
    const returned = engine.push({ wrist: [{ timestampMs: 1400, value: 9.9 }] });
    expect(returned).toEqual([]);
    const snapshot = engine.snapshot();
    expect(snapshot.qualityState.droppedLateSamples).toBe(1);
    expect(snapshot.events).toEqual(before);
    // The emitted proposal is frozen — mutation attempts throw (strict mode).
    expect(() => {
      (emitted[0]!.proposal as { startMs: number }).startMs = 0;
    }).toThrow();
  });

  it("chunked feeding emits the same events as per-sample feeding (bounds + reasons)", () => {
    const series = speedBumps(
      [
        { peakMs: 1000, height: 2.0, halfWidthMs: 80 },
        { peakMs: 1650, height: 2.2, halfWidthMs: 80 },
      ],
      0,
      4500,
    );
    const perSample = new SessionEventEngine({ sessionId: "unit-chunk-a" });
    const emittedPerSample = streamPerSample(perSample, series);
    const chunked = new SessionEventEngine({ sessionId: "unit-chunk-b" });
    const emittedChunked: SessionStrokeEvent[] = [];
    for (let index = 0; index < series.length; index += 7) {
      emittedChunked.push(...chunked.push({ wrist: series.slice(index, index + 7) }));
    }
    const shape = (events: readonly SessionStrokeEvent[]) =>
      events.map((event) => ({
        eventId: event.eventId,
        startMs: event.proposal.startMs,
        endMs: event.proposal.endMs,
        peakMs: event.proposal.peakMs,
        closeReason: event.closeReason,
      }));
    expect(shape(emittedChunked)).toEqual(shape(emittedPerSample));
  });

  it("paddle evidence confirms/refines but can never re-bound a session event (D-030 streamed)", () => {
    const wrist = speedBumps([{ peakMs: 1500, height: 2.0, halfWidthMs: 120 }], 0, 5000);
    const paddle = speedBumps([{ peakMs: 1560, height: 2.6, halfWidthMs: 80 }], 0, 5000);
    const wristOnly = new SessionEventEngine({ sessionId: "unit-paddle-a" });
    const emittedWristOnly = streamPerSample(wristOnly, wrist);
    const withPaddle = new SessionEventEngine({ sessionId: "unit-paddle-b" });
    const emittedWithPaddle: SessionStrokeEvent[] = [];
    for (let index = 0; index < wrist.length; index += 1) {
      emittedWithPaddle.push(
        ...withPaddle.push({ wrist: [wrist[index]!], paddle: [paddle[index]!] }),
      );
    }
    expect(emittedWithPaddle.length).toBe(1);
    expect(emittedWristOnly.length).toBe(1);
    // Boundaries are body-defined — identical with and without the paddle.
    expect(emittedWithPaddle[0]!.proposal.startMs).toBe(emittedWristOnly[0]!.proposal.startMs);
    expect(emittedWithPaddle[0]!.proposal.endMs).toBe(emittedWristOnly[0]!.proposal.endMs);
    // The paddle confirms and refines the interior peak toward its own.
    expect(emittedWithPaddle[0]!.proposal.paddleConfirmed).toBe(true);
    expect(Math.abs(emittedWithPaddle[0]!.proposal.peakMs - 1560)).toBeLessThanOrEqual(40);
  });

  it("per-event analysis lifecycle: pending → processing → ready/abstained; unknown ids throw", () => {
    const engine = new SessionEventEngine({
      sessionId: "unit-lifecycle",
      target: { trackId: 1, seedMode: "user_tapped_person", confidence: 0.9 },
      captureMeta: { source: "replay", fps: 30 },
    });
    const emitted = streamPerSample(
      engine,
      speedBumps([{ peakMs: 1500, height: 2.0, halfWidthMs: 120 }], 0, 5000),
    );
    const eventId = emitted[0]!.eventId;
    expect(engine.markEvent(eventId, "processing").state).toBe("processing");
    const abstained = engine.markEvent(eventId, "abstained", {
      abstainReason: "CONTACT_DISAGREEMENT: spread 380ms",
    });
    expect(abstained.state).toBe("abstained");
    expect(abstained.abstainReason).toContain("CONTACT_DISAGREEMENT");
    expect(() => engine.markEvent("E99", "ready")).toThrow(/unknown session event/);
    const session = engine.snapshot();
    expect(session.sessionId).toBe("unit-lifecycle");
    expect(session.target.trackId).toBe(1);
    expect(session.events[0]!.state).toBe("abstained");
    expect(session.modelVersions.strokeEvents).toContain("stroke-event-2");
  });

  it("flush on an empty/idle stream emits nothing", () => {
    const engine = new SessionEventEngine({ sessionId: "unit-empty" });
    expect(engine.flush()).toEqual([]);
    engine.push({ wrist: speedBumps([], 0, 2000) }); // idle baseline only
    expect(engine.flush()).toEqual([]);
  });
});

// ─── REPLAY VALIDATION on the dev multi-stroke rally runs ─────────────────
//
// Reconstructs the wrist-speed series EXACTLY the way analyzeVideo.ts does
// (parse args L241–246 · target seed L279–293 · targetPoseSequence L317 ·
// scene restriction L352–379 · offline window L389–410 · dominantWristSpeeds
// L922–957 · full-clip proposals L509–516), streams it through the session
// engine one sample at a time, and diffs against the batch proposals and the
// recorded report.json artifact. Uses DEV-split runs only (splits.json pins
// afn-sasebo-2025-06 to dev); shadow is untouched.
//
// MEASURED tolerances encoded below (2026 replay of both runs):
//   engine-vs-batch bounds/peak: Δ = 0ms exactly (assertions are exact)
//   batch-vs-report bounds:      Δ = 0ms exactly
//   batch-vs-report peak:        0ms unrefined · −235.23ms on the one
//                                paddle-refined event (≤250ms bound,
//                                strokeEvents.ts L339)
//   emission lag closedAt−endMs: settle +701/+801 · valley +33 ·
//                                flush +101/+200 — all ≤ +2500 (safety)
//   causal-only extras: rally1 0 · rally2 1 (a 0.60 u/s movement at
//     67–1401ms proposed while it was the strongest motion seen, then
//     retro-suppressed from the acausal batch once the 6.87 u/s stroke
//     raised the relative floor; engine keeps it append-only + flags it)

const PB_RUNS = join(REPO_ROOT, "datasets/paddle-bench/runs");

interface ReportShape {
  window: { startMs: number; endMs: number; peakMotionMs: number };
  player: { targetTrackId: number; aliasTrackIds: number[]; targetCoverage: number };
  events: {
    proposals: Array<{
      eventId: string;
      startMs: number;
      endMs: number;
      peakMs: number;
      paddleConfirmed: boolean;
      paddlePeakMs: number | null;
    }>;
  };
}

/** Mirror of analyzeVideo.ts dominantWristSpeeds (L922–957) — the local
 * function is not exported there; this copy is drift-guarded by the
 * batch-vs-report exactness assertions below. */
function mirrorDominantWristSpeeds(
  sequence: PoseSequence,
  window: { startMs: number; endMs: number },
): SpeedSample[] {
  const travel = { left: 0, right: 0 };
  const last: Record<string, { x: number; y: number } | undefined> = {};
  const perWrist: Record<"left" | "right", SpeedSample[]> = { left: [], right: [] };
  const legacy = toLegacyPoseFrames(sequence);
  for (const frame of legacy) {
    for (const sideName of ["left", "right"] as const) {
      const mark = frame.landmarks.find(
        (landmark) => landmark.name === `${sideName}_wrist` && landmark.visibility >= 0.25,
      );
      if (!mark) continue;
      const prior = last[sideName];
      if (prior) {
        const dtSec =
          perWrist[sideName].length > 0
            ? (frame.timestampMs - perWrist[sideName][perWrist[sideName].length - 1]!.timestampMs) /
              1000
            : 0.04;
        const step = Math.hypot(mark.x - prior.x, mark.y - prior.y);
        if (dtSec > 0 && dtSec <= 0.15) {
          perWrist[sideName].push({ timestampMs: frame.timestampMs, value: step / dtSec });
          if (frame.timestampMs >= window.startMs && frame.timestampMs <= window.endMs) {
            travel[sideName] += step;
          }
        }
      }
      last[sideName] = { x: mark.x, y: mark.y };
    }
  }
  return travel.right >= travel.left ? perWrist.right : perWrist.left;
}

function reconstructRun(runDir: string): {
  report: ReportShape;
  wristSpeeds: SpeedSample[];
  batchEvents: StrokeEventProposalV2[];
} {
  const report = JSON.parse(readFileSync(join(runDir, "report.json"), "utf8")) as ReportShape;
  const meta = JSON.parse(readFileSync(join(runDir, "extract-meta.json"), "utf8")) as {
    video: { durationMs: number };
  };
  // Canonical parse — same strictness and provider args as the phone/lab.
  const parsed = parsePoseSequence(readFileSync(join(runDir, "pose.json"), "utf8"), {
    providerId: "pose.apple-vision",
    runtime: "vision_framework",
    executionTarget: "on_device",
    artifactHash: null,
  });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error("unreachable");
  // Target identity: replay the recorded run's target via a tap seed on the
  // recorded track's early torso; drift-guarded against report.player below.
  const peopleFile = JSON.parse(readFileSync(join(runDir, "people.json"), "utf8")) as PeopleFile;
  const tracks = buildPlayerTracks(peopleFile);
  const base = tracks.find((track) => track.trackId === report.player.targetTrackId);
  expect(base).toBeDefined();
  const early = base!.frames[Math.min(3, base!.frames.length - 1)]!;
  const seeded = initializeTargetFromSeed(tracks, {
    mode: "user_tapped_person",
    point: { x: early.torsoMid.x, y: early.torsoMid.y },
  });
  expect(seeded.ok).toBe(true);
  if (!seeded.ok) throw new Error("unreachable");
  expect(seeded.value.identity.trackId).toBe(report.player.targetTrackId);
  expect(seeded.value.identity.aliasTrackIds).toEqual(report.player.aliasTrackIds);
  expect(seeded.value.target.coverage).toBeCloseTo(report.player.targetCoverage, 10);
  let sequence = targetPoseSequence(peopleFile, seeded.value.target);
  // Scene validity: never analyze across a shot boundary.
  const scenesPath = join(runDir, "scenes.json");
  let analysisSegment: { startMs: number; endMs: number } | null = null;
  if (existsSync(scenesPath)) {
    const scenes = JSON.parse(readFileSync(scenesPath, "utf8")) as ScenesFile;
    const scene = decideScene(
      scenes,
      sequence.frames.map((frame) => frame.timestampMs),
    );
    if (scene.multiShot) {
      analysisSegment = scene.analysisSegment;
      sequence = {
        ...sequence,
        frames: sequence.frames.filter(
          (frame) =>
            frame.timestampMs >= scene.analysisSegment.startMs &&
            frame.timestampMs < scene.analysisSegment.endMs,
        ),
      };
    }
  }
  const window = detectOfflineStrokeWindow(sequence);
  expect(window.ok).toBe(true);
  if (!window.ok) throw new Error("unreachable");
  let strokeWindow = window.value;
  if (analysisSegment) {
    const clamped = clampToScene(strokeWindow, analysisSegment);
    expect(clamped).not.toBeNull();
    strokeWindow = { ...strokeWindow, startMs: clamped!.startMs, endMs: clamped!.endMs };
  }
  // Drift guard: the reconstructed window must equal the recorded artifact.
  expect(strokeWindow.startMs).toBe(report.window.startMs);
  expect(strokeWindow.endMs).toBe(report.window.endMs);
  expect(strokeWindow.peakMotionMs).toBe(report.window.peakMotionMs);
  const wristSpeeds = mirrorDominantWristSpeeds(sequence, strokeWindow);
  // Batch reference: same call shape as analyzeVideo L511 (wrist-only — the
  // paddle can only confirm/refine peaks, never re-bound; asserted below).
  const batch = proposeStrokeEventsV2({
    paddleSpeeds: null,
    wristSpeeds,
    clipStartMs: 0,
    clipEndMs: meta.video.durationMs,
  });
  expect(batch.source).toBe("wrist");
  return { report, wristSpeeds, batchEvents: batch.events };
}

const REPLAY_RUNS: Array<{
  runId: string;
  batchCount: number;
  causalOnlyExtras: number;
  closeReasons: string[];
}> = [
  {
    runId: "afn-sasebo-rally1",
    batchCount: 3,
    causalOnlyExtras: 0,
    closeReasons: ["settle", "next_stroke_valley", "flush"],
  },
  {
    runId: "afn-sasebo-rally2",
    batchCount: 2,
    causalOnlyExtras: 1,
    closeReasons: ["settle", "settle", "flush"],
  },
];

for (const expected of REPLAY_RUNS) {
  const runDir = join(PB_RUNS, expected.runId);
  describe.skipIf(!existsSync(join(runDir, "report.json")))(
    `session replay — ${expected.runId} (dev split)`,
    () => {
      it("wrist-only batch reproduces the recorded report proposals (bounds exact; peak ≤250ms paddle refinement)", () => {
        const { report, batchEvents } = reconstructRun(runDir);
        expect(batchEvents.length).toBe(report.events.proposals.length);
        expect(batchEvents.length).toBe(expected.batchCount);
        for (const [index, reportEvent] of report.events.proposals.entries()) {
          const batchEvent = batchEvents[index]!;
          expect(batchEvent.startMs).toBe(reportEvent.startMs);
          expect(batchEvent.endMs).toBe(reportEvent.endMs);
          const peakDelta = Math.abs(batchEvent.peakMs - reportEvent.peakMs);
          if (reportEvent.paddleConfirmed && reportEvent.paddlePeakMs !== null) {
            expect(peakDelta).toBeLessThanOrEqual(250); // strokeEvents.ts L339 refinement bound
          } else {
            expect(peakDelta).toBe(0);
          }
        }
      });

      it("streaming the series emits every batch event with EXACT bounds, no unemitted events, closure ≤ endMs+2500", () => {
        const { batchEvents, wristSpeeds } = reconstructRun(runDir);
        const engine = new SessionEventEngine({
          sessionId: `replay-${expected.runId}`,
          captureMeta: { source: "replay" },
        });
        const emitted = streamPerSample(engine, wristSpeeds);
        emitted.push(...engine.flush());

        // (a) every batch-proposed event is emitted with matching bounds —
        // measured Δ 0ms on both runs, asserted exactly.
        for (const batchEvent of batchEvents) {
          const match = emitted.find(
            (event) =>
              event.proposal.startMs <= batchEvent.peakMs &&
              batchEvent.peakMs <= event.proposal.endMs,
          );
          expect(match).toBeDefined();
          expect(match!.proposal.startMs).toBe(batchEvent.startMs);
          expect(match!.proposal.endMs).toBe(batchEvent.endMs);
          expect(match!.proposal.peakMs).toBe(batchEvent.peakMs);
        }

        // (b) no extra events beyond the measured causal-only divergence,
        // and every causal-only extra is FLAGGED, never silent.
        const extras = emitted.filter(
          (event) =>
            !batchEvents.some(
              (batchEvent) =>
                event.proposal.startMs <= batchEvent.peakMs &&
                batchEvent.peakMs <= event.proposal.endMs,
            ),
        );
        expect(extras.length).toBe(expected.causalOnlyExtras);
        const notes = engine.snapshot().qualityState.notes;
        for (const extra of extras) {
          expect(
            notes.some(
              (note) =>
                note.includes("SESSION_EVENT_RETRO_SUPPRESSED") && note.includes(extra.eventId),
            ),
          ).toBe(true);
        }

        // (c) emission time ≤ event end + 2500ms safety, for every event.
        for (const event of emitted) {
          expect(event.closedAtMs).toBeLessThanOrEqual(
            event.proposal.endMs + SESSION_COMPLETION.safetyMaxMs,
          );
        }

        // Close reasons as measured (documents live behavior of this replay).
        expect(emitted.map((event) => event.closeReason)).toEqual(expected.closeReasons);

        // Append-only ids in emission order.
        expect(emitted.map((event) => event.eventId)).toEqual(
          emitted.map((_, index) => `E${index + 1}`),
        );
      });
    },
  );
}
