import { describe, expect, it } from "vitest";
import { deriveConsentStatus, type ConsentRecord } from "../src/consent.js";
import { resolveTechniqueIntent } from "../src/techniqueIntent.js";

/**
 * Structural audit #2 (shared-packages-ops) — reproducing tests. Each `it`
 * asserts the documented invariant; a failure on the audited commit is the
 * finding. Fixtures are synthetic (SYNTHETIC-TEST-FIXTURE pseudonyms).
 */

function record(overrides: Partial<ConsentRecord>): ConsentRecord {
  return {
    id: "SYNTHETIC-TEST-FIXTURE.record",
    subjectPseudonym: "SYNTHETIC-TEST-FIXTURE.subject",
    scope: "model_training",
    action: "granted",
    consentVersion: "model-training-v1",
    source: "mobile_settings",
    device: null,
    captureMode: "all_captures",
    strokeIntent: null,
    recordedAtIso: "2026-08-29T00:00:00.000Z",
    ...overrides,
  };
}

describe("AUDIT techniqueIntent: both sides in one utterance", () => {
  it("'forehand and backhand drive' is ambiguous, never a silent side guess", () => {
    const result = resolveTechniqueIntent("work on my forehand and backhand drive");
    expect(result.status, JSON.stringify(result)).toBe("ambiguous");
  });

  it("'backhand and forehand dinks' is ambiguous (side order must not matter)", () => {
    const result = resolveTechniqueIntent("both my backhand and forehand dinks");
    expect(result.status, JSON.stringify(result)).toBe("ambiguous");
  });
});

describe("AUDIT deriveConsentStatus: seq-less ordering must follow capture instant", () => {
  it("a withdrawal that happened LATER (in UTC) wins even when its ISO string sorts lexically earlier", () => {
    // grant at 2026-08-29T02:00:00+05:00 == 2026-08-28T21:00:00Z
    // withdrawal at 2026-08-28T23:00:00Z (2 hours AFTER the grant)
    const grant = record({ id: "g", recordedAtIso: "2026-08-29T02:00:00.000+05:00" });
    const withdrawal = record({
      id: "w",
      action: "withdrawn",
      recordedAtIso: "2026-08-28T23:00:00.000Z",
    });
    expect(Date.parse(withdrawal.recordedAtIso)).toBeGreaterThan(Date.parse(grant.recordedAtIso));
    const training = deriveConsentStatus([grant, withdrawal]).find(
      (s) => s.scope === "model_training",
    )!;
    expect(training.lastAction).toBe("withdrawn");
    expect(training.active).toBe(false);
  });

  it("derived status is a function of the record SET, not of input array order (mixed seq / seq-less rows)", () => {
    // The comparator falls back to recordedAtIso only when ONE side lacks seq,
    // which makes it non-transitive: g<w (seq), w<l (time), l<g (time).
    const grant = record({ id: "g", seq: 1, recordedAtIso: "2026-08-29T03:00:00.000Z" });
    const withdrawal = record({
      id: "w",
      seq: 2,
      action: "withdrawn",
      recordedAtIso: "2026-08-29T01:00:00.000Z",
    });
    const legacyGrant = record({ id: "l", recordedAtIso: "2026-08-29T02:00:00.000Z" });
    const permutations: ConsentRecord[][] = [
      [grant, withdrawal, legacyGrant],
      [grant, legacyGrant, withdrawal],
      [withdrawal, grant, legacyGrant],
      [withdrawal, legacyGrant, grant],
      [legacyGrant, grant, withdrawal],
      [legacyGrant, withdrawal, grant],
    ];
    const outcomes = new Set(
      permutations.map(
        (p) => deriveConsentStatus(p).find((s) => s.scope === "model_training")!.active,
      ),
    );
    expect([...outcomes], "active flag differs across input orderings").toHaveLength(1);
  });
});
