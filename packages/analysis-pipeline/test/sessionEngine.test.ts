import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BOUND_STABILITY_MS,
  SESSION_COMPLETION,
  SessionEventEngine,
  WRIST_RETENTION_BEHIND_FRONTIER_MS,
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
 * NSLC-02: the engine re-proposes on every push, so per-push cost is the size
 * of the series it proposes over. That series must be bounded by the
 * documented retention window behind the frontier — never by session length —
 * while ingestion accounting and the emitted events stay exactly what the
 * full-series run produces.
 */
describe("SessionEventEngine — bounded retention behind the frontier", () => {
  const STEP_MS = 40;
  const SESSION_MS = 60_000; // 6× the retention window
  const strokes = Array.from({ length: 29 }, (_, index) => ({
    peakMs: 1500 + index * 2000,
    height: 2.0,
    halfWidthMs: 120,
  }));
  const series = speedBumps(strokes, 0, SESSION_MS, STEP_MS);

  it("retained wrist series is bounded by the window while wristSamples counts every ingested sample", () => {
    const engine = new SessionEventEngine({ sessionId: "ap-bounded-retention" });
    let pushed = 0;
    let maxRetained = 0;
    let frontierMs = Number.NEGATIVE_INFINITY;
    for (const sample of series) {
      const closed = engine.pushWristSample(sample);
      pushed += 1;
      const last = closed[closed.length - 1];
      if (last) frontierMs = last.proposal.endMs;
      const retained = engine.retainedWristSampleCount();
      maxRetained = Math.max(maxRetained, retained);
      // Exactly the pushed samples newer than frontier − window survive.
      const cutoffMs = frontierMs - WRIST_RETENTION_BEHIND_FRONTIER_MS;
      const expected = series
        .slice(0, pushed)
        .filter((entry) => entry.timestampMs >= cutoffMs).length;
      expect(retained).toBe(expected);
      expect(engine.snapshot().qualityState.wristSamples).toBe(pushed);
    }
    expect(engine.snapshot().events.length).toBeGreaterThanOrEqual(20);
    // The window (10 s) plus the open tail past the frontier (a stroke's
    // settle + bound-stability wait, < 5 s) — far below the 1501 pushed.
    const documentedBound = (WRIST_RETENTION_BEHIND_FRONTIER_MS + 5000) / STEP_MS;
    expect(maxRetained).toBeLessThanOrEqual(documentedBound);
    expect(maxRetained).toBeLessThan(series.length / 2);
    expect(engine.retainedWristSampleCount()).toBeLessThanOrEqual(documentedBound);

    const snapshot = engine.snapshot();
    expect(snapshot.qualityState.wristSamples).toBe(series.length);
    expect(snapshot.qualityState.droppedLateSamples).toBe(0);
    expect(snapshot.qualityState.lastSampleMs).toBe(SESSION_MS);

    // A late sample behind the frontier is still dropped AND counted.
    expect(engine.pushWristSample({ timestampMs: 100, value: 3 })).toEqual([]);
    expect(engine.snapshot().qualityState.droppedLateSamples).toBe(1);
    expect(engine.snapshot().qualityState.wristSamples).toBe(series.length + 1);
    expect(engine.retainedWristSampleCount()).toBeLessThanOrEqual(documentedBound);
  });

  it("pruning changes no emitted event: streamed ids/bounds/reasons equal the full-series batch", () => {
    const engine = new SessionEventEngine({ sessionId: "ap-bounded-retention-equal" });
    const emitted: SessionStrokeEvent[] = [];
    for (const sample of series) emitted.push(...engine.pushWristSample(sample));
    emitted.push(...engine.flush());
    const batch = proposeStrokeEventsV2({
      paddleSpeeds: null,
      wristSpeeds: series,
      clipStartMs: 0,
      clipEndMs: SESSION_MS,
    }).events;
    expect(batch.length).toBe(strokes.length);
    expect(emitted.map((event) => event.eventId)).toEqual(batch.map((_, i) => `E${i + 1}`));
    expect(
      emitted.map((event) => [event.proposal.startMs, event.proposal.peakMs, event.proposal.endMs]),
    ).toEqual(batch.map((event) => [event.startMs, event.peakMs, event.endMs]));
    expect(new Set(emitted.map((event) => event.closeReason))).toEqual(new Set(["settle"]));
    expect(engine.snapshot().qualityState.notes).toEqual([]);
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
