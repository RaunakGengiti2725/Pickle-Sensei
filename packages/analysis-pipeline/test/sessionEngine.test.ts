import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BOUND_STABILITY_MS,
  SESSION_COMPLETION,
  SessionEventEngine,
  proposeStrokeEventsV2,
  type SessionStrokeEvent,
  type SpeedSample,
} from "../src/sessionEngine.js";

/**
 * The session engine moved here from swing-lab (Wave B / W6) so mobile can
 * consume it. Its full regression net — 13 unit/replay tests including the
 * dev-rally replay validation — lives in packages/swing-lab/test/
 * sessionEngine.test.ts and runs against THIS implementation through the
 * re-export shim. This file adds what only this package can assert:
 *
 *  1. the DRIFT GUARD for the in-module verbatim mirror of the canonical
 *     stroke-event-2 proposer (analysis-pipeline cannot depend on swing-lab,
 *     so the proposer travels as a byte-identical copy that must never
 *     diverge from packages/swing-lab/src/strokeEvents.ts);
 *  2. smoke coverage that the engine works from its new home.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_PATH = join(HERE, "../src/sessionEngine.ts");
const CANONICAL_PROPOSER_PATH = join(HERE, "../../swing-lab/src/strokeEvents.ts");
const BEGIN_MARKER = "// === BEGIN VERBATIM MIRROR: packages/swing-lab/src/strokeEvents.ts ===\n";
const END_MARKER = "// === END VERBATIM MIRROR: packages/swing-lab/src/strokeEvents.ts ===\n";

describe("stroke-event-2 proposer mirror — drift guard", () => {
  it("the mirrored section is byte-identical to packages/swing-lab/src/strokeEvents.ts", () => {
    const engineSource = readFileSync(ENGINE_PATH, "utf8");
    const canonicalSource = readFileSync(CANONICAL_PROPOSER_PATH, "utf8");
    const begin = engineSource.indexOf(BEGIN_MARKER);
    const end = engineSource.indexOf(END_MARKER);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(begin);
    const mirrored = engineSource.slice(begin + BEGIN_MARKER.length, end);
    // Byte-for-byte: any edit to either copy without the other fails here.
    expect(mirrored).toBe(canonicalSource);
  });
});

/** Speed series with gaussian-ish bumps (same helper as the swing-lab suite). */
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

describe("SessionEventEngine — smoke from its new home", () => {
  it("two clean strokes → two settle-closed, append-only events", () => {
    const engine = new SessionEventEngine({ sessionId: "ap-smoke-two" });
    const emitted: SessionStrokeEvent[] = [];
    for (const sample of speedBumps(
      [
        { peakMs: 1200, height: 2.0, halfWidthMs: 120 },
        { peakMs: 3500, height: 2.0, halfWidthMs: 120 },
      ],
      0,
      6000,
    )) {
      emitted.push(...engine.pushWristSample(sample));
    }
    expect(engine.flush()).toEqual([]);
    expect(emitted.map((event) => event.eventId)).toEqual(["E1", "E2"]);
    expect(emitted.map((event) => event.closeReason)).toEqual(["settle", "settle"]);
    for (const event of emitted) {
      expect(event.closedAtMs).toBeGreaterThanOrEqual(event.proposal.peakMs + BOUND_STABILITY_MS);
      expect(event.closedAtMs).toBeLessThanOrEqual(
        event.proposal.endMs + SESSION_COMPLETION.safetyMaxMs,
      );
      expect(event.state).toBe("pending");
      expect(event.analysis).toBeNull();
    }
  });

  it("per-event lifecycle: pending → processing → ready/abstained; proposals frozen", () => {
    const engine = new SessionEventEngine({ sessionId: "ap-smoke-lifecycle" });
    const emitted: SessionStrokeEvent[] = [];
    for (const sample of speedBumps([{ peakMs: 1500, height: 2.0, halfWidthMs: 120 }], 0, 5000)) {
      emitted.push(...engine.pushWristSample(sample));
    }
    expect(emitted.length).toBe(1);
    const eventId = emitted[0]!.eventId;
    expect(engine.markEvent(eventId, "processing").state).toBe("processing");
    const abstained = engine.markEvent(eventId, "abstained", {
      abstainReason: "NATIVE_CLIP_EXTRACTION_NOT_BUILT",
    });
    expect(abstained.state).toBe("abstained");
    expect(() => engine.markEvent("E99", "ready")).toThrow(/unknown session event/);
    expect(() => {
      (emitted[0]!.proposal as { startMs: number }).startMs = 0;
    }).toThrow();
  });
});

/**
 * D3-06 red-team regressions (synthetic adversarial series via speedBumps).
 * Breaks found: (a) duplicate/late outcome signals could REWRITE a terminal
 * event state ('ready' → 'abstained', analysis cleared); (b) 'ready' was
 * accepted with no AnalysisRecord, so an unanalyzed event could be counted
 * as analyzed.
 */
describe("SessionEventEngine — D3-06 append-only outcome hardening", () => {
  function oneEvent(sessionId: string) {
    const engine = new SessionEventEngine({ sessionId });
    const emitted: SessionStrokeEvent[] = [];
    for (const sample of speedBumps([{ peakMs: 1500, height: 2.0, halfWidthMs: 120 }], 0, 5000)) {
      emitted.push(...engine.pushWristSample(sample));
    }
    expect(emitted.length).toBe(1);
    return { engine, eventId: emitted[0]!.eventId, analysis: emitted[0]!.analysis };
  }

  const fakeAnalysis = { id: "synthetic-analysis" } as unknown as NonNullable<
    SessionStrokeEvent["analysis"]
  >;

  it("terminal states are append-only: a second outcome signal throws, state survives", () => {
    const { engine, eventId } = oneEvent("d306-terminal");
    engine.markEvent(eventId, "processing");
    engine.markEvent(eventId, "ready", { analysis: fakeAnalysis });
    expect(() => engine.markEvent(eventId, "abstained", { abstainReason: "late dup" })).toThrow(
      /append-only/,
    );
    expect(() => engine.markEvent(eventId, "processing")).toThrow(/append-only/);
    const event = engine.snapshot().events[0]!;
    expect(event.state).toBe("ready");
    expect(event.analysis).toBe(fakeAnalysis);
  });

  it("'ready' without an AnalysisRecord is rejected — never counted as analyzed", () => {
    const { engine, eventId } = oneEvent("d306-ready-null");
    engine.markEvent(eventId, "processing");
    expect(() => engine.markEvent(eventId, "ready")).toThrow(/AnalysisRecord/);
    expect(() => engine.markEvent(eventId, "ready", { analysis: null })).toThrow(/AnalysisRecord/);
    expect(engine.snapshot().events[0]!.state).toBe("processing");
  });

  it("honest revert: processing → pending allowed; pending → pending rejected", () => {
    const { engine, eventId } = oneEvent("d306-revert");
    engine.markEvent(eventId, "processing");
    expect(engine.markEvent(eventId, "pending").state).toBe("pending");
    expect(() => engine.markEvent(eventId, "pending")).toThrow(/cannot revert/);
    expect(engine.eventState(eventId)).toBe("pending");
    expect(engine.eventState("E99")).toBeNull();
  });
});

/** Deterministic PRNG (mulberry32, same generator as the swing-lab harness). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * XC-CV-3 streaming/batch parity under timestamp jitter and cadence change
 * (adopted from the round-1 adversary, devin/attack-fix-5ee6b8ea).
 *
 * §EVENT IDENTITY: the live engine runs the canonical proposer over every
 * growing PREFIX of the session, so any statistic the proposer takes over the
 * WHOLE series (a global cadence estimate, a global de-jitter decision) makes
 * a prefix and the final batch series disagree about the same samples. The
 * fixtures below are fully deterministic — no I/O.
 */
describe("XC-CV-3: streaming/batch parity under jitter and a mid-session cadence change", () => {
  const BUMPS = [
    { peakMs: 1500, height: 2.2, halfWidthMs: 140 },
    { peakMs: 4200, height: 0.9, halfWidthMs: 180 },
    { peakMs: 7000, height: 1.6, halfWidthMs: 120 },
  ];
  const trueSpeed = (t: number) =>
    BUMPS.reduce(
      (total, bump) =>
        total + bump.height * Math.exp(-0.5 * ((t - bump.peakMs) / bump.halfWidthMs) ** 2),
      0.08,
    );

  /** Wrist speed as dominantWristSpeeds / SessionMotionStream compute it:
   * displacement over the STAMPED interval. `fpsAt(trueMs)` is the capture
   * cadence in effect at that moment; `jitterMs` is uniform integer-ms stamp
   * wobble (Vision delivers integer-ms stamps). */
  function series(options: {
    seed: number;
    jitterMs: number;
    fpsAt: (trueMs: number) => number;
    jitterUntilMs?: number;
    endMs: number;
  }): SpeedSample[] {
    const random = mulberry32(options.seed);
    const out: SpeedSample[] = [];
    let prevTrue = 0;
    let prevStamp = 0;
    let trueMs = 0;
    while (trueMs <= options.endMs) {
      const jitterActive = options.jitterUntilMs === undefined || trueMs < options.jitterUntilMs;
      const wobble =
        jitterActive && options.jitterMs > 0 ? (random() * 2 - 1) * options.jitterMs : 0;
      let stamp = Math.round(trueMs + wobble);
      if (out.length > 0 && stamp <= prevStamp) stamp = prevStamp + 1;
      if (out.length === 0) {
        out.push({ timestampMs: stamp, value: trueSpeed(trueMs) });
      } else {
        const displacement = (trueSpeed(trueMs) * (trueMs - prevTrue)) / 1000;
        out.push({ timestampMs: stamp, value: (displacement * 1000) / (stamp - prevStamp) });
      }
      prevTrue = trueMs;
      prevStamp = stamp;
      trueMs += 1000 / options.fpsAt(trueMs);
    }
    return out;
  }

  const bounds = (event: { startMs: number; peakMs: number; endMs: number }) =>
    `${Math.round(event.startMs)}/${Math.round(event.peakMs)}/${Math.round(event.endMs)}`;

  function batch(speeds: ReadonlyArray<SpeedSample>): string[] {
    return proposeStrokeEventsV2({
      paddleSpeeds: null,
      wristSpeeds: speeds,
      clipStartMs: speeds[0]!.timestampMs,
      clipEndMs: speeds[speeds.length - 1]!.timestampMs,
    }).events.map(bounds);
  }

  function streamed(speeds: ReadonlyArray<SpeedSample>): string[] {
    const engine = new SessionEventEngine({
      sessionId: "xc-cv-3-parity",
      captureMeta: { source: "replay" },
    });
    const out: string[] = [];
    for (const sample of speeds) {
      for (const event of engine.pushWristSample(sample)) out.push(bounds(event.proposal));
    }
    for (const event of engine.flush()) out.push(bounds(event.proposal));
    return out;
  }

  it("constant 60 fps with ±4 ms integer-ms jitter: identical bounds streamed vs batch (seeds 1–20)", () => {
    const mismatches: string[] = [];
    for (let seed = 1; seed <= 20; seed += 1) {
      const speeds = series({ seed, jitterMs: 4, fpsAt: () => 60, endMs: 9000 });
      const b = batch(speeds);
      const s = streamed(speeds);
      if (b.join(" | ") !== s.join(" | ")) {
        mismatches.push(`seed ${seed}: batch ${b.join(" | ")} ; streamed ${s.join(" | ")}`);
      }
    }
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });

  it("constant 30 fps with ±4–5 ms integer-ms jitter: identical bounds streamed vs batch (seeds 1–20)", () => {
    const mismatches: string[] = [];
    for (const jitterMs of [4, 5]) {
      for (let seed = 1; seed <= 20; seed += 1) {
        const speeds = series({ seed, jitterMs, fpsAt: () => 30, endMs: 9000 });
        const b = batch(speeds);
        const s = streamed(speeds);
        if (b.join(" | ") !== s.join(" | ")) {
          mismatches.push(
            `jitter ${jitterMs} seed ${seed}: batch ${b.join(" | ")} ; streamed ${s.join(" | ")}`,
          );
        }
      }
    }
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });

  it("capture cadence drops 60 → 30 fps mid-session (thermal throttle): events closed BEFORE the drop equal the batch replay of the same samples (seeds 1–8)", () => {
    const mismatches: string[] = [];
    for (let seed = 1; seed <= 8; seed += 1) {
      const speeds = series({
        seed,
        jitterMs: 2,
        jitterUntilMs: 3000,
        fpsAt: (t) => (t < 3000 ? 60 : 30),
        endMs: 6000,
      });
      const b = batch(speeds);
      const s = streamed(speeds);
      if (b.join(" | ") !== s.join(" | ")) {
        mismatches.push(`seed ${seed}: batch ${b.join(" | ")} ; streamed ${s.join(" | ")}`);
      }
    }
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });

  it("capture cadence drops 60 → 30 fps mid-session with jitter on BOTH sides: identical bounds streamed vs batch (seeds 1–8)", () => {
    const mismatches: string[] = [];
    for (let seed = 1; seed <= 8; seed += 1) {
      const speeds = series({
        seed,
        jitterMs: 2,
        fpsAt: (t) => (t < 6000 ? 60 : 30),
        endMs: 9000,
      });
      const b = batch(speeds);
      const s = streamed(speeds);
      if (b.join(" | ") !== s.join(" | ")) {
        mismatches.push(`seed ${seed}: batch ${b.join(" | ")} ; streamed ${s.join(" | ")}`);
      }
    }
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });
});
