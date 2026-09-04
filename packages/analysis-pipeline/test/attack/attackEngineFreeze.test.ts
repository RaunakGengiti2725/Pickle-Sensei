import { describe, expect, it } from "vitest";
import { SessionEventEngine, type SessionStrokeEvent } from "../../src/sessionEngine.js";
import { fakeAnalysis, syntheticStream } from "./attackFixtures.js";

/**
 * ADVERSARIAL PASS 3 / TESTER #2 — S4: the emitted proposal is
 * Object.freeze'd SHALLOWLY. Does any nested field survive the freeze, and is
 * the wrapper SessionStrokeEvent (returned by reference from push()) itself
 * protected against caller mutation?
 */

function closeOneEvent(sessionId: string): {
  engine: SessionEventEngine;
  event: SessionStrokeEvent;
} {
  const engine = new SessionEventEngine({ sessionId });
  const stream = syntheticStream({ durationMs: 7_000, strokeEveryMs: 3000, firstStrokeMs: 1500 });
  const closed = engine.push({ wrist: stream });
  expect(closed.length).toBeGreaterThan(0);
  return { engine, event: closed[0]! };
}

describe("S4 — shallow freeze of SessionStrokeEvent.proposal", () => {
  it("the frozen proposal contains no nested objects (nothing a shallow freeze could leave writable)", () => {
    const { event } = closeOneEvent("attack-freeze-shape");
    expect(Object.isFrozen(event.proposal)).toBe(true);
    const nested = Object.entries(event.proposal).filter(
      ([, value]) => typeof value === "object" && value !== null,
    );
    expect(
      nested,
      `nested (mutable-through-shallow-freeze) fields: ${JSON.stringify(nested)}`,
    ).toEqual([]);
    // Direct writes to top-level fields throw in strict (ESM) code.
    expect(() => {
      (event.proposal as { startMs: number }).startMs = -1;
    }).toThrow(TypeError);
    expect(() => {
      (event.proposal as { lowAmplitude?: true }).lowAmplitude = true;
    }).toThrow(TypeError);
  });

  it("the SessionStrokeEvent WRAPPER returned by push() is the engine's own record — caller writes leak into snapshot()", () => {
    const { engine, event } = closeOneEvent("attack-freeze-wrapper");
    const before = engine.snapshot().events[0]!;
    expect(before.state).toBe("pending");

    // 1. Reassigning the (frozen) proposal on the unfrozen wrapper.
    const forged = { ...event.proposal, startMs: 0, endMs: 999_999, peakMs: 5 };
    (event as { proposal: typeof forged }).proposal = forged;
    // 2. Bypassing markEvent's invariants: 'ready' with no AnalysisRecord.
    (event as { state: string }).state = "ready";
    // 3. Rewriting immutable emission facts.
    (event as { eventId: string }).eventId = "E999";
    (event as { closedAtMs: number }).closedAtMs = -42;

    const after = engine.snapshot().events[0]!;
    const leaked = {
      proposalBounds: after.proposal.startMs === 0 && after.proposal.endMs === 999_999,
      stateReadyWithoutAnalysis: after.state === "ready" && after.analysis === null,
      eventIdRewritten: after.eventId === "E999",
      closedAtRewritten: after.closedAtMs === -42,
    };
    // Contract under test: "closed events NEVER change retroactively" and
    // "'ready' requires a real AnalysisRecord" (sessionEngine.ts header +
    // markEvent doc). A caller must not be able to violate either without
    // going through markEvent.
    expect(leaked, JSON.stringify(leaked)).toEqual({
      proposalBounds: false,
      stateReadyWithoutAnalysis: false,
      eventIdRewritten: false,
      closedAtRewritten: false,
    });
  });

  it("snapshot() proposal copies are detached from the engine (control)", () => {
    const { engine } = closeOneEvent("attack-freeze-snapshot");
    const snap = engine.snapshot();
    (snap.events[0]!.proposal as { startMs: number }).startMs = -7;
    snap.events[0]!.state = "abstained";
    const again = engine.snapshot().events[0]!;
    expect(again.proposal.startMs).not.toBe(-7);
    expect(again.state).toBe("pending");
  });

  it("the AnalysisRecord attached via markEvent('ready') is shared by reference with snapshot() (informational)", () => {
    const { engine, event } = closeOneEvent("attack-freeze-analysis");
    const analysis = { ...fakeAnalysis, marker: "original" } as unknown as typeof fakeAnalysis;
    engine.markEvent(event.eventId, "processing");
    engine.markEvent(event.eventId, "ready", { analysis });
    const snapA = engine.snapshot().events[0]!.analysis as unknown as { marker: string };
    (analysis as unknown as { marker: string }).marker = "mutated-after-ready";
    const snapB = engine.snapshot().events[0]!.analysis as unknown as { marker: string };
    // Recorded, not asserted as a defect: the engine documents the slot as
    // "exactly what the analysis pipeline produces"; sharing is by design.
    expect(snapA.marker).toBe("mutated-after-ready");
    expect(snapB.marker).toBe("mutated-after-ready");
  });
});
