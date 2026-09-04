import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BOUND_STABILITY_MS,
  SESSION_COMPLETION,
  SESSION_PROPOSAL_HORIZON_MS,
  SessionEventEngine,
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
 * ADJ-AP-001 regression: the proposer runs over a bounded trailing horizon,
 * not the whole session. What must NOT change: event ids/bounds/close
 * reasons for the strokes themselves (every proposer input is local to the
 * candidate), the append-only frontier, the accepted-sample accounting, and
 * the retro-suppression flag for events the proposer can still see. What
 * the horizon adds: samples older than the horizon are released, and a
 * late sample from beyond it is dropped + counted instead of re-inserted.
 */
describe("SessionEventEngine — bounded proposal horizon (ADJ-AP-001)", () => {
  function periodicStrokes(untilMs: number, periodMs = 2400): SpeedSample[] {
    const bumps: Array<{ peakMs: number; height: number; halfWidthMs: number }> = [];
    for (let peakMs = 1200; peakMs < untilMs - 1600; peakMs += periodMs) {
      bumps.push({ peakMs, height: 2.0, halfWidthMs: 110 });
    }
    return speedBumps(bumps, 0, untilMs, 33);
  }

  it("a stream several horizons long emits the same events as horizon-sized prefixes; ids stay append-only", () => {
    const durationMs = SESSION_PROPOSAL_HORIZON_MS * 4;
    const series = periodicStrokes(durationMs);
    const long = new SessionEventEngine({ sessionId: "ap-horizon-long" });
    const emitted: SessionStrokeEvent[] = [];
    for (const sample of series) emitted.push(...long.pushWristSample(sample));
    emitted.push(...long.flush());

    const expectedStrokes = Math.floor((durationMs - 1600 - 1200 + 2400 - 1) / 2400);
    expect(emitted.length).toBe(expectedStrokes);
    expect(emitted.map((event) => event.eventId)).toEqual(
      emitted.map((_, index) => `E${index + 1}`),
    );
    for (let index = 1; index < emitted.length; index += 1) {
      expect(emitted[index]!.proposal.startMs).toBeGreaterThanOrEqual(
        emitted[index - 1]!.proposal.endMs,
      );
    }
    // Every stroke well inside the stream is bounded identically whether the
    // proposer saw the whole session or only the horizon around it: replay
    // the samples of one horizon in isolation and compare the events there.
    const fromMs = SESSION_PROPOSAL_HORIZON_MS * 2;
    const toMs = SESSION_PROPOSAL_HORIZON_MS * 3;
    const isolated = new SessionEventEngine({ sessionId: "ap-horizon-isolated" });
    const isolatedEmitted: SessionStrokeEvent[] = [];
    for (const sample of series.filter((s) => s.timestampMs >= fromMs && s.timestampMs <= toMs)) {
      isolatedEmitted.push(...isolated.pushWristSample(sample));
    }
    isolatedEmitted.push(...isolated.flush());
    const inside = emitted.filter(
      (event) => event.proposal.startMs >= fromMs + 2000 && event.proposal.endMs <= toMs - 2000,
    );
    expect(inside.length).toBeGreaterThan(3);
    for (const event of inside) {
      const twin = isolatedEmitted.find((e) => e.proposal.peakMs === event.proposal.peakMs);
      expect(twin).toBeDefined();
      expect(twin!.proposal.startMs).toBe(event.proposal.startMs);
      expect(twin!.proposal.endMs).toBe(event.proposal.endMs);
      expect(twin!.closeReason).toBe(event.closeReason);
    }
    // Accounting covers the whole session, not just the retained horizon.
    const quality = long.snapshot().qualityState;
    expect(quality.wristSamples).toBe(series.length);
    expect(quality.droppedLateSamples).toBe(0);
    expect(quality.notes.filter((note) => note.includes("SESSION_EVENT_RETRO_SUPPRESSED"))).toEqual(
      [],
    );
  });

  it("a late sample from beyond the horizon is dropped and counted; the frontier and emitted events are untouched", () => {
    const series = periodicStrokes(SESSION_PROPOSAL_HORIZON_MS * 2);
    const engine = new SessionEventEngine({ sessionId: "ap-horizon-late" });
    const emitted: SessionStrokeEvent[] = [];
    for (const sample of series) emitted.push(...engine.pushWristSample(sample));
    const before = engine.snapshot();
    const lastMs = series[series.length - 1]!.timestampMs;
    // Behind the frontier AND beyond the horizon — dropped by the frontier
    // rule first; paddle has no frontier, so the horizon rule drops it.
    expect(
      engine.push({
        wrist: [{ timestampMs: lastMs - SESSION_PROPOSAL_HORIZON_MS - 1000, value: 9 }],
        paddle: [{ timestampMs: lastMs - SESSION_PROPOSAL_HORIZON_MS - 1000, value: 9 }],
      }),
    ).toEqual([]);
    const after = engine.snapshot();
    expect(after.qualityState.droppedLateSamples).toBe(before.qualityState.droppedLateSamples + 1);
    expect(after.qualityState.paddleSamples).toBe(before.qualityState.paddleSamples);
    expect(after.events.map((event) => event.proposal)).toEqual(
      before.events.map((event) => event.proposal),
    );
    expect(after.events.length).toBe(emitted.length);
  });

  it("retro-suppression is still flagged for a weak event the proposer can see, and never for one it cannot", () => {
    // Weak early stroke, then a much stronger one inside the same horizon →
    // flagged (relative floor). Then keep playing past a full horizon: the
    // weak event leaves the retained window and must not be re-judged.
    const series = speedBumps(
      [
        { peakMs: 1200, height: 0.7, halfWidthMs: 110 },
        { peakMs: 5000, height: 6.0, halfWidthMs: 110 },
      ],
      0,
      9000,
      33,
    );
    const engine = new SessionEventEngine({ sessionId: "ap-horizon-retro" });
    const emitted: SessionStrokeEvent[] = [];
    for (const sample of series) emitted.push(...engine.pushWristSample(sample));
    expect(emitted.length).toBe(2);
    const weak = emitted[0]!;
    expect(weak.proposal.peakSpeed).toBeLessThan(1);
    const notesAfterStrong = engine.snapshot().qualityState.notes;
    expect(
      notesAfterStrong.some(
        (note) =>
          note.includes("SESSION_EVENT_RETRO_SUPPRESSED") && note.includes(`: ${weak.eventId} `),
      ),
    ).toBe(true);
    const noteCount = notesAfterStrong.length;
    // Idle for more than a horizon: the weak event ages out of the window;
    // no new note may be added for it (it was recorded exactly once).
    for (const sample of speedBumps([], 9033, 9000 + SESSION_PROPOSAL_HORIZON_MS + 3000, 33)) {
      engine.pushWristSample(sample);
    }
    const notesAfterIdle = engine.snapshot().qualityState.notes;
    expect(notesAfterIdle.length).toBe(noteCount);
    expect(engine.eventState(weak.eventId)).toBe("pending");
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
