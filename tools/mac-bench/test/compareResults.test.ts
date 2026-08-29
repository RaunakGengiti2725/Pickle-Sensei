import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compareResults } from "../src/compareResults.js";
import type { MacBenchResultsV1 } from "../src/resultsSchema.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function loadFixture(): MacBenchResultsV1 {
  return JSON.parse(
    readFileSync(join(HERE, "fixtures/mac-bench-results.fixture.json"), "utf8"),
  ) as MacBenchResultsV1;
}

describe("compareResults", () => {
  it("reports OK for identical runs", () => {
    const report = compareResults(loadFixture(), loadFixture());
    expect(report.verdict).toBe("OK");
    expect(report.regressions).toEqual([]);
    expect(report.improvements).toEqual([]);
  });

  it("flags a strict-survival drop as a cascade regression", () => {
    const newer = loadFixture();
    newer.cascade!.strictSurvival.survived = 1;
    const report = compareResults(loadFixture(), newer);
    expect(report.verdict).toBe("REGRESSION");
    expect(report.regressions).toContainEqual(
      expect.objectContaining({ kind: "cascade", metric: "strictSurvival.survived" }),
    );
  });

  it("flags a silent-failure RISE as a regression and a drop as improvement", () => {
    const worse = loadFixture();
    worse.cascade!.silentFailure.silentFailures = 3;
    expect(compareResults(loadFixture(), worse).regressions).toContainEqual(
      expect.objectContaining({ metric: "silentFailure.silentFailures" }),
    );
    const better = loadFixture();
    better.cascade!.silentFailure.silentFailures = 0;
    const report = compareResults(loadFixture(), better);
    expect(report.verdict).toBe("OK");
    expect(report.improvements).toContainEqual(
      expect.objectContaining({ metric: "silentFailure.silentFailures" }),
    );
  });

  it("flags per-stage conditional-survival drops", () => {
    const newer = loadFixture();
    newer.cascade!.conditionalSurvival.PHASE = 1;
    const report = compareResults(loadFixture(), newer);
    expect(report.regressions).toContainEqual(
      expect.objectContaining({ metric: "conditionalSurvival.PHASE" }),
    );
  });

  it("applies BOTH latency gates: ratio and absolute delta", () => {
    // +10000ms on warm p50 17000 → ratio 1.59 and delta > 50ms: regression.
    const slower = loadFixture();
    slower.stages[0]!.warm!.p50Ms = 27000;
    expect(compareResults(loadFixture(), slower).regressions).toContainEqual(
      expect.objectContaining({ metric: "e2e.warm.p50Ms" }),
    );
    // +40ms on warm p50 of a small stage (5800 → 5840): under the absolute
    // gate even though noise ratios could trip on tiny stages.
    const noisy = loadFixture();
    noisy.stages[1]!.warm!.p50Ms = 5840;
    expect(compareResults(loadFixture(), noisy).verdict).toBe("OK");
    // +1000ms on 17000 (5.9%): under the ratio gate despite delta > 50ms.
    const slightly = loadFixture();
    slightly.stages[0]!.warm!.p50Ms = 18000;
    expect(compareResults(loadFixture(), slightly).verdict).toBe("OK");
  });

  it("records big latency improvements without changing the verdict", () => {
    const faster = loadFixture();
    faster.stages[0]!.warm!.p50Ms = 11900;
    const report = compareResults(loadFixture(), faster);
    expect(report.verdict).toBe("OK");
    expect(report.improvements).toContainEqual(
      expect.objectContaining({ metric: "e2e.warm.p50Ms" }),
    );
  });

  it("refuses to compare across contract re-versions", () => {
    const reversioned = loadFixture();
    reversioned.cascade!.usableResult.contractVersion = "usable-result-v2";
    const report = compareResults(loadFixture(), reversioned);
    expect(report.verdict).toBe("NOT_COMPARABLE");
    expect(report.regressions).toContainEqual(
      expect.objectContaining({ kind: "comparability", metric: "usableResult.contractVersion" }),
    );
  });

  it("caveats one-sided cascade absence instead of fabricating a comparison", () => {
    const unmeasured = loadFixture();
    unmeasured.cascade = null;
    unmeasured.cascadeUnmeasuredReason = "runs absent";
    const report = compareResults(loadFixture(), unmeasured);
    expect(report.verdict).toBe("OK");
    expect(report.caveats).toContainEqual(expect.stringContaining("only one side"));
  });

  it("caveats dirty working trees and differing case lists", () => {
    const dirty = loadFixture();
    dirty.provenance.dirtyWorkingTree = true;
    dirty.plan.caseIds = ["wm-volley-02"];
    const report = compareResults(loadFixture(), dirty);
    expect(report.caveats).toContainEqual(expect.stringContaining("dirty working tree"));
    expect(report.caveats).toContainEqual(expect.stringContaining("case lists differ"));
  });

  it("caveats stages present on only one side", () => {
    const fewer = loadFixture();
    fewer.stages = fewer.stages.slice(0, 1);
    const report = compareResults(loadFixture(), fewer);
    expect(report.caveats).toContainEqual(expect.stringContaining("only in the old run"));
  });
});
