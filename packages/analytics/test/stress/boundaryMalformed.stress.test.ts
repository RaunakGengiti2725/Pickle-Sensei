/**
 * Boundary / malformed-input stress campaign (lens `boundary-malformed`).
 *
 *   STRESS_ITER=3000 STRESS_MAX_STRING=65536 STRESS_OUT=/tmp/stress.json \
 *     pnpm --filter @pickle/analytics test -- test/stress
 *
 * Defaults are small so the file lives in the regular suite. Every row in the
 * JSON table is replayable from its seed with `runIteration(unit, seed, max)`.
 *
 * The campaign records BROKEN rows instead of throwing so a single failing
 * seed does not hide the rest of the table. The assertions below pin the
 * invariants that hold today (so a regression fails the suite) and pin the
 * KNOWN failing invariants as such (so a fix flips them, visibly). The
 * `ms` timing column is informational only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { runCampaign, runIteration, stableRows, type Row } from "./campaign.js";

const ITER = Number(process.env["STRESS_ITER"] ?? 300);
const MAX_STRING = Number(process.env["STRESS_MAX_STRING"] ?? 4096);
const BASE_SEED = Number(process.env["STRESS_SEED"] ?? 20260904);
const OUT = process.env["STRESS_OUT"];

/**
 * Invariants known to be violated at this revision. Each entry is a finding in
 * the stress report; when production code is fixed the corresponding
 * expectation below starts failing and the entry must be removed.
 */
const KNOWN_BROKEN = new Set<string>([
  "track_no_throw", // cyclic / deep / hostile values throw out of BufferedAnalytics.track
  "shape_validated", // non-object events and unknown names are buffered and sent
  "raw_signal_smuggling_blocked", // nested numeric arrays under keypoints/joints/... pass the guard
  "confusable_pii_flagged", // zero-width / fullwidth / colon-prefixed path variants pass the guard
  "pii_flagged", // non-ASCII e-mail and `blob:` URIs pass the guard
  "nfc_nfd_same_verdict", // same root cause: accented e-mail passes in both NFC and NFD
  "psi_finite_nonnegative", // computePsi → NaN for prototype-named labels
  "monitor_no_nan_and_alerts", // DriftMonitor.test → NaN psi → severity "stable", no alert
  "nan_not_binned", // numericBinLabel(NaN) → highest bin
  "record_non_object_no_throw", // DriftMonitor.record(null|undefined) throws TypeError
  "rate_card_validated", // computeCost accepts NaN/Infinity/negative rates
  "overflow_rejected_or_finite", // quantities near MAX_VALUE → "$Infinity" / non-integer micro-USD
  "scale_add_finite", // scaleUsage/addUsage overflow to Infinity
]);

function brokenOutside(rows: Row[], allowed: Set<string>): Row[] {
  return rows.filter((r) => r.outcome === "BROKEN" && !allowed.has(r.invariant));
}

describe(`boundary/malformed stress campaign (${ITER} iterations, maxString=${MAX_STRING}, seed=${BASE_SEED})`, () => {
  const result = runCampaign({ baseSeed: BASE_SEED, iterations: ITER, maxString: MAX_STRING });

  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(
      OUT,
      JSON.stringify(
        {
          revision: process.env["STRESS_REVISION"] ?? null,
          generatedAt: new Date().toISOString(),
          options: result.options,
          iterations: result.iterations,
          byOutcome: result.byOutcome,
          brokenByInvariant: result.brokenByInvariant,
          rows: result.rows,
        },
        null,
        1,
      ),
    );
  }

  it("executes every requested iteration", () => {
    expect(result.iterations).toBe(ITER);
    expect(result.rows.length).toBeGreaterThanOrEqual(ITER);
  });

  it("is deterministic: the same seed reproduces the same outcomes", () => {
    const again = runCampaign({
      baseSeed: BASE_SEED,
      iterations: Math.min(ITER, 200),
      maxString: MAX_STRING,
    });
    const first = stableRows(
      result.rows.filter((r) => again.rows.some((a) => a.seed === r.seed && a.unit === r.unit)),
    );
    expect(stableRows(again.rows)).toEqual(first);
  });

  it("holds every invariant that is not a known finding", () => {
    const unexpected = brokenOutside(result.rows, KNOWN_BROKEN);
    expect(unexpected, JSON.stringify(unexpected.slice(0, 10), null, 1)).toEqual([]);
  });

  it("never throws out of findPrivacyViolations for plain JSON-shaped input", () => {
    const rows = result.rows.filter((r) => r.invariant === "no_throw");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.outcome === "BROKEN")).toEqual([]);
  });

  it("never buffers or sends an event the guard flagged", () => {
    const rows = result.rows.filter((r) => r.invariant === "violation_never_written");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.outcome === "BROKEN")).toEqual([]);
  });

  it("enforces the string cap in UTF-16 code units, not codepoints or graphemes", () => {
    const rows = result.rows.filter((r) => r.invariant === "cap_is_utf16_code_units");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.outcome === "BROKEN")).toEqual([]);
  });

  it("keeps every drift window bounded and count-consistent under junk observations", () => {
    for (const invariant of [
      "window_bounded",
      "counts_consistent",
      "record_no_throw",
      "no_nan_in_outputs",
    ]) {
      const rows = result.rows.filter((r) => r.invariant === invariant);
      expect(rows.length, invariant).toBeGreaterThan(0);
      expect(
        rows.filter((r) => r.outcome === "BROKEN"),
        invariant,
      ).toEqual([]);
    }
  });

  it("rejects every invalid usage quantity with the typed cost_model error", () => {
    const rows = result.rows.filter(
      (r) =>
        r.invariant === "invalid_quantity_rejected" || r.invariant === "outputs_finite_integers",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.outcome === "BROKEN")).toEqual([]);
  });

  it("does not pollute Object.prototype through __proto__/constructor keys", () => {
    for (const invariant of ["no_prototype_pollution", "drift_label_no_pollution"]) {
      const rows = result.rows.filter((r) => r.invariant === invariant);
      expect(rows.length, invariant).toBeGreaterThan(0);
      expect(
        rows.filter((r) => r.outcome === "BROKEN"),
        invariant,
      ).toEqual([]);
    }
  });
});

describe("replay of minimized failing seeds", () => {
  // Smallest seed per finding from the 3200-iteration campaign at 1fb0efd7 (base seed 20260904).
  const cases: Array<{
    unit: "guard" | "drift" | "cost";
    seed: number;
    invariant: string;
    detail: RegExp;
  }> = [
    { unit: "guard", seed: 20260915, invariant: "track_no_throw", detail: /deep: RangeError/ },
    { unit: "guard", seed: 20260991, invariant: "track_no_throw", detail: /cycle: RangeError/ },
    {
      unit: "guard",
      seed: 20261010,
      invariant: "track_no_throw",
      detail: /getter: Error: hostile getter/,
    },
    {
      unit: "guard",
      seed: 20260953,
      invariant: "track_no_throw",
      detail: /proxy: Error: hostile proxy/,
    },
    { unit: "guard", seed: 20260913, invariant: "shape_validated", detail: /string event sent=1/ },
    { unit: "guard", seed: 20260914, invariant: "shape_validated", detail: /name="" sent=1/ },
    {
      unit: "guard",
      seed: 20260912,
      invariant: "raw_signal_smuggling_blocked",
      detail: /under unlisted key/,
    },
    {
      unit: "guard",
      seed: 20260908,
      invariant: "confusable_pii_flagged",
      detail: /colon-prefixed absolute path/,
    },
    {
      unit: "guard",
      seed: 20260946,
      invariant: "confusable_pii_flagged",
      detail: /zero-width space before @/,
    },
    { unit: "guard", seed: 20261031, invariant: "pii_flagged", detail: /jos\u00e9@example\.com/ },
    { unit: "guard", seed: 20261050, invariant: "pii_flagged", detail: /blob:6b1e2c3d/ },
    {
      unit: "drift",
      seed: 21260906,
      invariant: "psi_finite_nonnegative",
      detail: /label=hasOwnProperty side=reference psi=NaN/,
    },
    {
      unit: "drift",
      seed: 21260906,
      invariant: "monitor_no_nan_and_alerts",
      detail: /"severity":"stable".*alerts=0/,
    },
    { unit: "drift", seed: 21260928, invariant: "nan_not_binned", detail: /fps NaN → ">=60"/ },
    {
      unit: "drift",
      seed: 21260979,
      invariant: "record_non_object_no_throw",
      detail: /record\(undefined\) → TypeError/,
    },
    {
      unit: "cost",
      seed: 22260957,
      invariant: "rate_card_validated",
      detail: /rate=NaN → total=NaN \$NaN/,
    },
    {
      unit: "cost",
      seed: 22260912,
      invariant: "rate_card_validated",
      detail: /rate=-1 → total=-1000000 \$-1\.000000/,
    },
    {
      unit: "cost",
      seed: 22260931,
      invariant: "overflow_rejected_or_finite",
      detail: /total=Infinity formatted=\$Infinity/,
    },
    { unit: "cost", seed: 22260913, invariant: "scale_add_finite", detail: /"storage":null/ },
  ];
  for (const c of cases) {
    it(`${c.unit} seed ${c.seed} reproduces ${c.invariant} (${c.detail.source.slice(0, 40)})`, () => {
      const rows = runIteration(c.unit, c.seed, MAX_STRING);
      const row = rows.find((r) => r.invariant === c.invariant);
      expect(row?.outcome, JSON.stringify(rows)).toBe("BROKEN");
      expect(row?.detail).toMatch(c.detail);
    });
  }
});
