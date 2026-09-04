import { describe, expect, it } from "vitest";
import {
  REQUIRED_SEQUENCES,
  advance,
  declareIncident,
  escalate,
  isClosed,
  type Incident,
} from "../../src/index.js";

/**
 * KNOWN GAP probes surfaced by the long-run-leak stress campaign. Each `it.fails`
 * documents behaviour the stress reference model considers BROKEN; when the
 * gap is fixed the probe starts passing, vitest reports it as a failure, and
 * the probe must be flipped to a plain `it(...)` (which then pins the fix).
 *
 * Gap: `escalate()` enforces "severity only goes up" but not the two guards
 * `advance()` enforces — it neither refuses a terminal (closed) incident nor
 * a blank note. A closed P2 can therefore be silently reopened as P0 with an
 * empty note, and `isClosed()` flips back to false.
 */

function closedP2(): Incident {
  let incident = declareIncident({
    id: "SYNTHETIC-TEST-FIXTURE.inc-closed-p2",
    severity: "P2",
    failureClass: "queue_stall",
    title: "synthetic closed incident",
    detectionSource: "monitoring_alert",
    detectedAt: "2026-09-01T00:00:00.000Z",
    affectedSurfaces: ["analysis"],
    declaredBy: "SYNTHETIC-TEST-FIXTURE.oncall",
    note: "declared",
  });
  let minute = 1;
  for (const step of REQUIRED_SEQUENCES.P2.slice(1)) {
    incident = advance(incident, {
      step,
      at: `2026-09-01T00:${String(minute).padStart(2, "0")}:00.000Z`,
      actor: "SYNTHETIC-TEST-FIXTURE.oncall",
      note: `step ${step}`,
    });
    minute += 1;
  }
  return incident;
}

describe("incident-response known gaps", () => {
  it("precondition: the fixture incident is closed and advance() refuses to leave the terminal step", () => {
    const incident = closedP2();
    expect(isClosed(incident)).toBe(true);
    expect(() =>
      advance(incident, {
        step: "investigating",
        at: "2026-09-01T01:00:00.000Z",
        actor: "SYNTHETIC-TEST-FIXTURE.oncall",
        note: "reopen",
      }),
    ).toThrow(/terminal/);
  });

  it.fails(
    "KNOWN GAP: escalate() should refuse a closed incident like advance() does (currently reopens it)",
    () => {
      const incident = closedP2();
      expect(() =>
        escalate(incident, "P0", {
          at: "2026-09-01T01:00:00.000Z",
          actor: "SYNTHETIC-TEST-FIXTURE.oncall",
          note: "post-close escalation",
        }),
      ).toThrow();
    },
  );

  it.fails("KNOWN GAP: escalate() should require a non-empty note like advance() does", () => {
    const incident = declareIncident({
      id: "SYNTHETIC-TEST-FIXTURE.inc-blank-note",
      severity: "P2",
      failureClass: "queue_stall",
      title: "synthetic incident",
      detectionSource: "monitoring_alert",
      detectedAt: "2026-09-01T00:00:00.000Z",
      affectedSurfaces: [],
      declaredBy: "SYNTHETIC-TEST-FIXTURE.oncall",
      note: "declared",
    });
    expect(() =>
      escalate(incident, "P1", {
        at: "2026-09-01T00:01:00.000Z",
        actor: "SYNTHETIC-TEST-FIXTURE.oncall",
        note: "   ",
      }),
    ).toThrow();
  });
});
