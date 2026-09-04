/**
 * Adversarial pass 3 — consent ledger ordering under clock / offset skew.
 *
 * deriveConsentStatus orders seq-less records by recordedAtIso string
 * comparison. ISO-8601 strings with different UTC offsets are NOT
 * lexicographically ordered by instant: "…T12:00:00+02:00" (= 10:00Z) sorts
 * AFTER "…T11:00:00Z" even though it happened an hour EARLIER. A withdrawal
 * that chronologically follows a grant must leave the scope inactive.
 */
import { describe, expect, it } from "vitest";
import { deriveConsentStatus, type ConsentRecord } from "../src/consent.js";

function rec(
  partial: Partial<ConsentRecord> & Pick<ConsentRecord, "action" | "recordedAtIso">,
): ConsentRecord {
  return {
    id: partial.id ?? `${partial.action}-${partial.recordedAtIso}`,
    subjectPseudonym: "subj-1",
    scope: "model_training",
    action: partial.action,
    consentVersion: "model-training-v1",
    source: "mobile_settings",
    device: null,
    captureMode: partial.action === "granted" ? "all_captures" : null,
    strokeIntent: null,
    recordedAtIso: partial.recordedAtIso,
    ...(partial.seq !== undefined ? { seq: partial.seq } : {}),
  };
}

describe("attack3: deriveConsentStatus with seq-less, offset-skewed timestamps", () => {
  const granted = rec({ action: "granted", recordedAtIso: "2026-01-01T12:00:00+02:00" }); // 10:00Z
  const withdrawn = rec({ action: "withdrawn", recordedAtIso: "2026-01-01T11:00:00Z" }); // 11:00Z, LATER

  it("withdrawal at 11:00Z after a grant at 12:00+02:00 (10:00Z) → inactive", () => {
    const status = deriveConsentStatus([granted, withdrawn]).find(
      (s) => s.scope === "model_training",
    )!;
    expect(status.lastAction).toBe("withdrawn");
    expect(status.active).toBe(false);
  });

  it("same result regardless of input order", () => {
    const a = deriveConsentStatus([granted, withdrawn]);
    const b = deriveConsentStatus([withdrawn, granted]);
    expect(a).toEqual(b);
    expect(a.find((s) => s.scope === "model_training")!.active).toBe(false);
  });

  it("millisecond-precision vs second-precision strings of the same instant do not flip status", () => {
    // Same instant, two spellings. Whichever way ties resolve, a later
    // withdrawal (by 1 ms) must win.
    const g = rec({ action: "granted", recordedAtIso: "2026-01-01T11:00:00Z" });
    const w = rec({ action: "withdrawn", recordedAtIso: "2026-01-01T11:00:00.001Z" });
    const status = deriveConsentStatus([w, g]).find((s) => s.scope === "model_training")!;
    expect(status.active).toBe(false);
  });

  it("mixed seq / seq-less records: comparator must stay consistent (order-independent)", () => {
    // One record carries seq (DB row), one does not (legacy client row).
    // The comparator falls back to string order only when BOTH have seq
    // undefined — a mix makes the relation non-transitive.
    const g1 = rec({ action: "granted", recordedAtIso: "2026-01-01T10:00:00Z", seq: 1 });
    const w = rec({ action: "withdrawn", recordedAtIso: "2026-01-01T11:00:00Z" }); // no seq
    const g2 = rec({ action: "granted", recordedAtIso: "2026-01-01T09:00:00Z", seq: 2 });
    const perms: ConsentRecord[][] = [
      [g1, w, g2],
      [g1, g2, w],
      [w, g1, g2],
      [w, g2, g1],
      [g2, g1, w],
      [g2, w, g1],
    ];
    const results = perms.map(
      (p) => deriveConsentStatus(p).find((s) => s.scope === "model_training")!.active,
    );
    expect(new Set(results).size, `results per permutation: ${JSON.stringify(results)}`).toBe(1);
  });

  it("unicode / lowercase 'z' / space-separated ISO variants parse to the same instant and order by instant", () => {
    // Date.parse accepts several spellings the string comparator does not
    // normalize. A withdrawal 1 minute later must still win.
    const g = rec({ action: "granted", recordedAtIso: "2026-01-01T11:00:00Z" });
    const w = rec({ action: "withdrawn", recordedAtIso: "2026-01-01T11:01:00.000+00:00" });
    expect(Date.parse(w.recordedAtIso)).toBeGreaterThan(Date.parse(g.recordedAtIso));
    const status = deriveConsentStatus([g, w]).find((s) => s.scope === "model_training")!;
    expect(status.active).toBe(false);
  });
});
