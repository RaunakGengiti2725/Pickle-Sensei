import { describe, expect, it } from "vitest";
import {
  HELD_OUT_CASES,
  buildReport,
  dedupeContacts,
  diagnose,
  groupAwareCurve,
  loadLatestCascade,
  loadSessionMap,
  mulberry32,
  ownershipSnapshots,
  type JoinedUnit,
} from "../src/learningCurveModality.js";
import { REPO_ROOT } from "../src/engine/corpus.js";

const unit = (id: string, group: string, correct: boolean): JoinedUnit => ({
  unitId: id,
  caseId: id,
  group,
  correct,
});

describe("groupAwareCurve", () => {
  it("is deterministic for a fixed seed", () => {
    const units = [
      unit("a1", "s1", true),
      unit("a2", "s1", false),
      unit("b1", "s2", true),
      unit("c1", "s3", true),
      unit("c2", "s3", false),
    ];
    const first = groupAwareCurve(units, 200, 7);
    const second = groupAwareCurve(units, 200, 7);
    expect(second).toEqual(first);
  });

  it("resamples whole sessions, never splitting a group's units", () => {
    // s1 is all-correct, s2 all-wrong: with k=1 every draw must be exactly 0 or 1,
    // which forces p5/p95 to sit on {0,1} — impossible if frames were split.
    const units = [
      unit("a1", "s1", true),
      unit("a2", "s1", true),
      unit("a3", "s1", true),
      unit("b1", "s2", false),
      unit("b2", "s2", false),
      unit("b3", "s2", false),
    ];
    const [k1] = groupAwareCurve(units, 500, 3);
    expect([0, 1]).toContain(k1!.accuracy.p5);
    expect([0, 1]).toContain(k1!.accuracy.p95);
  });

  it("pools accuracy across all groups at full k in a single draw", () => {
    const units = [unit("a1", "s1", true), unit("b1", "s2", false), unit("b2", "s2", false)];
    const points = groupAwareCurve(units, 100, 1);
    const last = points[points.length - 1]!;
    expect(last.resamples).toBe(1);
    expect(last.accuracy.mean).toBeCloseTo(1 / 3, 3);
  });

  it("returns an empty curve for zero units (no fabricated points)", () => {
    expect(groupAwareCurve([], 100, 1)).toEqual([]);
  });
});

describe("diagnose", () => {
  it("declares MEASUREMENT_LIMITED when joined units or groups are too few", () => {
    const joined = [unit("a", "s1", true), unit("b", "s2", false)];
    const verdict = diagnose({
      modality: "contact",
      devLabelUnits: 28,
      joined,
      curve: groupAwareCurve(joined),
      heldOut: [],
    });
    expect(verdict.classification).toBe("MEASUREMENT_LIMITED");
    expect(verdict.reasoning).toContain("PREDICTION coverage");
  });

  it("notes the domain-shift signature inside MEASUREMENT_LIMITED when held-out rows disagree", () => {
    const joined = [unit("a", "s1", true), unit("b", "s2", true)];
    const verdict = diagnose({
      modality: "contact",
      devLabelUnits: 28,
      joined,
      curve: groupAwareCurve(joined),
      heldOut: [{ correct: false }, { correct: false }],
    });
    expect(verdict.classification).toBe("MEASUREMENT_LIMITED");
    expect(verdict.reasoning).toContain("domain-shift signature");
  });

  it("declares DATA_LIMITED when the leave-one-group-out interval is wide", () => {
    const joined = [
      ...[1, 2, 3].map((i) => unit(`a${i}`, "s1", true)),
      ...[1, 2, 3].map((i) => unit(`b${i}`, "s2", false)),
      ...[1, 2, 3].map((i) => unit(`c${i}`, "s3", true)),
    ];
    const verdict = diagnose({
      modality: "event",
      devLabelUnits: 9,
      joined,
      curve: groupAwareCurve(joined),
      heldOut: [],
    });
    expect(verdict.classification).toBe("DATA_LIMITED");
  });

  it("declares MODEL_LIMITED on a low tight plateau", () => {
    // Every group has identical 50% accuracy: intervals collapse, plateau is low.
    const joined = ["s1", "s2", "s3", "s4"].flatMap((group) => [
      unit(`${group}-hit`, group, true),
      unit(`${group}-miss`, group, false),
    ]);
    const verdict = diagnose({
      modality: "stroke",
      devLabelUnits: 8,
      joined,
      curve: groupAwareCurve(joined),
      heldOut: [],
    });
    expect(verdict.classification).toBe("MODEL_LIMITED");
  });

  it("declares DOMAIN_SHIFT when held-out accuracy trails dev by >=0.25 at sufficient n", () => {
    const joined = ["s1", "s2", "s3"].flatMap((group) =>
      [1, 2].map((i) => unit(`${group}-${i}`, group, true)),
    );
    const verdict = diagnose({
      modality: "stroke",
      devLabelUnits: 6,
      joined,
      curve: groupAwareCurve(joined),
      heldOut: [{ correct: false }, { correct: false }],
    });
    expect(verdict.classification).toBe("DOMAIN_SHIFT");
  });
});

describe("dedupeContacts", () => {
  it("merges records of the same strike (<=60ms apart) and keeps distinct strikes", () => {
    const unique = dedupeContacts([
      { caseId: "c1", contactMs: 1000 },
      { caseId: "c1", contactMs: 1040 },
      { caseId: "c1", contactMs: 2000 },
      { caseId: "c2", contactMs: 1000 },
    ]);
    expect(unique).toEqual([
      { caseId: "c1", contactMs: 1000 },
      { caseId: "c1", contactMs: 2000 },
      { caseId: "c2", contactMs: 1000 },
    ]);
  });
});

describe("mulberry32", () => {
  it("reproduces the same stream for the same seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe("committed-artifact integration", () => {
  it("maps every cascade case to a sessionKey", () => {
    const sessions = loadSessionMap(REPO_ROOT);
    const cascade = loadLatestCascade(REPO_ROOT);
    expect(cascade).not.toBeNull();
    for (const row of cascade!.rows) {
      expect(sessions.get(row.caseId), row.caseId).toBeTruthy();
    }
  });

  it("quotes ownership snapshots from the committed L-summary without recomputation", () => {
    const snapshots = ownershipSnapshots(REPO_ROOT);
    expect(snapshots.length).toBe(2);
    expect(snapshots[0]!.labelCount).toBeLessThan(snapshots[1]!.labelCount);
    for (const snapshot of snapshots) {
      expect(snapshot.accuracy).toBeGreaterThan(0);
      expect(snapshot.accuracy).toBeLessThanOrEqual(1);
      expect(snapshot.source).toContain("L-summary.json");
    }
  });

  it("builds a report with all four modalities and no held-out units in any curve join", () => {
    const report = buildReport(REPO_ROOT);
    expect(report.modalities.map((entry) => entry.modality)).toEqual([
      "ownership",
      "contact",
      "event",
      "stroke",
    ]);
    for (const entry of report.modalities) {
      for (const joined of entry.joined.perUnit) {
        for (const heldOut of HELD_OUT_CASES) {
          expect(joined.unitId.startsWith(heldOut)).toBe(false);
        }
      }
      // No fabricated points: a curve point can only exist where joined units exist.
      if (entry.joined.devUnits === 0) expect(entry.curve).toEqual([]);
      expect(entry.verdict.classification).toBeTruthy();
    }
  });

  it("finds the documented event gold label supply (34 = dev + held-out)", () => {
    const report = buildReport(REPO_ROOT);
    const event = report.modalities.find((entry) => entry.modality === "event")!;
    expect(event.labelSupply.devUnits + event.labelSupply.heldOutUnits).toBe(34);
  });
});
