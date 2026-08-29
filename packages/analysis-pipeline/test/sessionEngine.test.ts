import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BOUND_STABILITY_MS,
  SESSION_COMPLETION,
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
const BEGIN_MARKER =
  "// === BEGIN VERBATIM MIRROR: packages/swing-lab/src/strokeEvents.ts ===\n";
const END_MARKER =
  "// === END VERBATIM MIRROR: packages/swing-lab/src/strokeEvents.ts ===\n";

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
