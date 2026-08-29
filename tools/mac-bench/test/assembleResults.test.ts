import { describe, expect, it } from "vitest";
import {
  assembleResults,
  cascadeUnmeasuredReasonFor,
  parseStageSamplesJsonl,
  summarizeCascadeDocument,
} from "../src/assembleResults.js";
import type { MacBenchHost, MacBenchProvenance } from "../src/resultsSchema.js";

const host: MacBenchHost = {
  platform: "darwin",
  osVersion: "15.5",
  hardwareModel: "Mac15,6",
  nodeVersion: "v20.19.0",
  pythonVersion: "Python 3.11.9",
};

const provenance: MacBenchProvenance = {
  gitCommit: "abc123",
  gitBranch: "main",
  dirtyWorkingTree: false,
};

describe("parseStageSamplesJsonl", () => {
  it("parses valid JSONL, skipping blank lines", () => {
    const samples = parseStageSamplesJsonl(
      [
        '{"stage":"e2e","caseId":"a","phase":"cold","iteration":1,"wallMs":50000}',
        "",
        '{"stage":"paddleDetect","caseId":"a","phase":"warm","iteration":1,"wallMs":6000}',
        "",
      ].join("\n"),
    );
    expect(samples).toHaveLength(2);
    expect(samples[1]?.stage).toBe("paddleDetect");
  });

  it("rejects invalid JSON, invalid shapes, and empty files with line numbers", () => {
    expect(() => parseStageSamplesJsonl("not json")).toThrow(/line 1: invalid JSON/);
    expect(() =>
      parseStageSamplesJsonl(
        '{"stage":"e2e","caseId":"a","phase":"tepid","iteration":1,"wallMs":1}',
      ),
    ).toThrow(/line 1: not a valid StageSample/);
    expect(() =>
      parseStageSamplesJsonl(
        '{"stage":"e2e","caseId":"a","phase":"cold","iteration":1,"wallMs":-5}',
      ),
    ).toThrow(/line 1/);
    expect(() => parseStageSamplesJsonl("\n\n")).toThrow(/no samples/);
  });
});

describe("summarizeCascadeDocument", () => {
  it("copies lab:cascade counters verbatim, never recomputing", () => {
    const summary = summarizeCascadeDocument(
      {
        goldEvents: 5,
        unconditionalPass: { TARGET: 5 },
        conditionalSurvival: { TARGET: 5 },
        strictSurvival: { survived: 2, total: 5 },
        usableResult: { usable: 2, total: 5, contract: { version: "usable-result-v1" } },
        silentFailure: {
          silentFailures: 1,
          answeredTrials: 4,
          allTrials: 5,
          contract: { version: "silent-failure-v1" },
        },
      },
      "datasets/cascade/cascade-1.json",
    );
    expect(summary.usableResult).toEqual({
      usable: 2,
      total: 5,
      contractVersion: "usable-result-v1",
    });
    expect(summary.silentFailure.contractVersion).toBe("silent-failure-v1");
    expect(summary.sourceFile).toBe("datasets/cascade/cascade-1.json");
  });
});

describe("cascadeUnmeasuredReasonFor", () => {
  const zeroGold = {
    goldEvents: 0,
    unconditionalPass: { TARGET: 0 },
    conditionalSurvival: { TARGET: 0 },
    strictSurvival: { survived: 0, total: 0 },
    usableResult: { usable: 0, total: 0, contract: { version: "usable-result-v1" } },
    silentFailure: {
      silentFailures: 0,
      answeredTrials: 0,
      allTrials: 0,
      contract: { version: "silent-failure-v1.1" },
    },
  };

  it("turns a zero-gold-events cascade document into an explained absence", () => {
    const reason = cascadeUnmeasuredReasonFor(zeroGold, "datasets/cascade/cascade-0.json");
    expect(reason).toMatch(/0 gold events/);
    expect(reason).toContain("datasets/cascade/cascade-0.json");
  });

  it("returns null when the cascade document has gold events", () => {
    expect(
      cascadeUnmeasuredReasonFor({ ...zeroGold, goldEvents: 5 }, "datasets/cascade/cascade-5.json"),
    ).toBeNull();
  });
});

describe("assembleResults", () => {
  const samples = parseStageSamplesJsonl(
    '{"stage":"e2e","caseId":"a","phase":"cold","iteration":1,"wallMs":50000}\n' +
      '{"stage":"e2e","caseId":"a","phase":"warm","iteration":1,"wallMs":17000}',
  );

  it("assembles a document that passes its own schema validation", () => {
    const document = assembleResults({
      samples,
      host,
      provenance,
      plan: { caseIds: ["a"], coldIterations: 1, warmIterations: 1 },
      extractor: { built: true, buildWallMs: 40000, binaryPath: "/tmp/swing-lab" },
      cascade: null,
      cascadeUnmeasuredReason: "cascade intentionally skipped in this fixture",
      notes: [],
      generatedAtIso: "2026-08-29T00:00:00.000Z",
    });
    expect(document.schemaVersion).toBe("mac-bench-results-v1");
    expect(document.stages).toHaveLength(1);
    expect(document.stages[0]?.cold?.p50Ms).toBe(50000);
    expect(document.stages[0]?.warm?.p50Ms).toBe(17000);
  });

  it("refuses to assemble an unmeasured cascade without a reason", () => {
    expect(() =>
      assembleResults({
        samples,
        host,
        provenance,
        plan: { caseIds: ["a"], coldIterations: 1, warmIterations: 1 },
        extractor: { built: false, buildWallMs: null, binaryPath: null },
        cascade: null,
        cascadeUnmeasuredReason: null,
        notes: [],
      }),
    ).toThrow(/cascadeUnmeasuredReason/);
  });
});
