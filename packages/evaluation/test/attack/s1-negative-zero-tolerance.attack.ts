/**
 * ATTACK S1 — hand-edit `absoluteTolerance` of `contact_replay.estimated` to
 * `-0` in a COPY of regression.tolerances.json and observe whether
 * `validateToleranceConfig` accepts it (`-0 < 0` is false in JS), then check
 * whether accepting it changes any comparator verdict.
 *
 * Also probes the neighbouring numeric edge cases the validator has to hold:
 * 1e400 (parses to Infinity), -1e-300, "0" (string), null, true, [].
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareSummaries, validateToleranceConfig } from "../../src/index.js";
import { bench, summary } from "../regressionFixtures.js";
import { TOLERANCES_PATH, makeTempDir, runCli, writeEvidence } from "./attackUtil.js";

const KEY = "contact_replay.estimated";

function tolerancesWithRawValue(rawJsonValue: string): string {
  const text = readFileSync(TOLERANCES_PATH, "utf8");
  const needle = new RegExp(
    `("${KEY.replace(".", "\\.")}"\\s*:\\s*\\{[^}]*"absoluteTolerance"\\s*:\\s*)([^,}\\s]+)`,
  );
  const match = needle.exec(text);
  if (!match) throw new Error(`could not locate ${KEY}.absoluteTolerance in ${TOLERANCES_PATH}`);
  return text.replace(needle, `$1${rawJsonValue}`);
}

describe("S1: absoluteTolerance = -0 for contact_replay.estimated", () => {
  const edited = tolerancesWithRawValue("-0");
  const parsed = JSON.parse(edited) as {
    metrics: Record<string, { absoluteTolerance: number; direction: string }>;
  };

  it("JSON.parse yields a genuine negative zero for the edited entry", () => {
    expect(Object.is(parsed.metrics[KEY]!.absoluteTolerance, -0)).toBe(true);
  });

  it("validateToleranceConfig ACCEPTS -0 (the `< 0` guard does not reject it)", () => {
    const result = validateToleranceConfig(parsed);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.is(result.value.metrics[KEY]!.absoluteTolerance, -0)).toBe(true);
    }
  });

  it("-0 and 0 tolerances produce byte-identical comparator verdicts (no semantic hole)", () => {
    const zero = validateToleranceConfig(JSON.parse(readFileSync(TOLERANCES_PATH, "utf8")));
    const negZero = validateToleranceConfig(parsed);
    if (!zero.ok || !negZero.ok) throw new Error("fixture tolerances failed validation");
    const baseline = summary();
    const scenarios: Array<{ label: string; estimated: number | null }> = [
      { label: "equal", estimated: 7 },
      { label: "plus_one", estimated: 8 },
      { label: "minus_one", estimated: 6 },
      { label: "tiny_plus", estimated: 7 + 1e-12 },
      { label: "tiny_minus", estimated: 7 - 1e-12 },
      { label: "null", estimated: null },
    ];
    const verdicts = scenarios.map((scenario) => {
      const candidate = summary({}, [
        bench({ metrics: { ...bench().metrics, estimated: scenario.estimated } }),
      ]);
      const a = compareSummaries(baseline, candidate, zero.value);
      const b = compareSummaries(baseline, candidate, negZero.value);
      const pick = (report: typeof a) => {
        const metric = report.metrics.find((entry) => entry.metric === KEY);
        return { status: metric?.status, failing: metric?.failing, exitCode: report.exitCode };
      };
      return { scenario: scenario.label, zero: pick(a), negZero: pick(b) };
    });
    for (const verdict of verdicts) {
      expect(verdict.negZero).toEqual(verdict.zero);
    }
    writeEvidence("s1-negative-zero-tolerance", {
      scenario: "S1",
      classification: "HELD (accepted, but -0 is numerically identical to 0 for every verdict)",
      acceptedByValidator: negZero.ok,
      objectIsNegativeZero: Object.is(negZero.value.metrics[KEY]!.absoluteTolerance, -0),
      jsonRoundTrip: JSON.stringify(negZero.value.metrics[KEY]!.absoluteTolerance),
      verdicts,
    });
  });

  it("the CLI accepts a --tolerances file carrying -0 and exits 0 on an identical candidate", () => {
    const dir = makeTempDir("attack-s1");
    const tolPath = join(dir, "tolerances-neg-zero.json");
    const basePath = join(dir, "baseline.json");
    const candPath = join(dir, "candidate.json");
    writeFileSync(tolPath, edited);
    writeFileSync(basePath, JSON.stringify(summary()));
    writeFileSync(candPath, JSON.stringify(summary({ runId: "cand" })));
    const result = runCli(["compare", basePath, candPath, "--tolerances", tolPath, "--json"]);
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as { exitCode: number };
    expect(report.exitCode).toBe(0);
  });

  it.each([
    ["1e400 (Infinity after JSON.parse)", "1e400"],
    ["-1e-300 (negative, non-zero)", "-1e-300"],
    ['"0" (string)', '"0"'],
    ["null", "null"],
    ["true", "true"],
    ["[] (array)", "[]"],
  ])("validator REJECTS absoluteTolerance = %s", (_label, raw) => {
    const result = validateToleranceConfig(JSON.parse(tolerancesWithRawValue(raw)));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("tolerance_value");
      expect(result.failure.message).toContain(`metrics.${KEY}.absoluteTolerance`);
    }
  });
});
