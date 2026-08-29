import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateMacBenchResults } from "../src/resultsSchema.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function loadFixture(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(HERE, "fixtures/mac-bench-results.fixture.json"), "utf8"),
  ) as Record<string, unknown>;
}

describe("mac-bench-results-v1 schema validation", () => {
  it("accepts the committed fixture document", () => {
    expect(validateMacBenchResults(loadFixture())).toEqual([]);
  });

  it("rejects a wrong schema version", () => {
    const document = loadFixture();
    document.schemaVersion = "mac-bench-results-v2";
    expect(validateMacBenchResults(document)).toContainEqual(
      expect.stringContaining("schemaVersion"),
    );
  });

  it("requires a reason when cascade is null (absence must be explained)", () => {
    const document = loadFixture();
    document.cascade = null;
    document.cascadeUnmeasuredReason = null;
    expect(validateMacBenchResults(document)).toContainEqual(
      expect.stringContaining("cascadeUnmeasuredReason"),
    );
    document.cascadeUnmeasuredReason = "canonical run dirs absent on this box";
    expect(validateMacBenchResults(document)).toEqual([]);
  });

  it("rejects a stage summary with no samples", () => {
    const document = loadFixture();
    const stages = document.stages as Array<Record<string, unknown>>;
    stages[0]!.samples = [];
    expect(validateMacBenchResults(document)).toContainEqual(expect.stringContaining("samples"));
  });

  it("rejects a stage with neither cold nor warm summary", () => {
    const document = loadFixture();
    const stages = document.stages as Array<Record<string, unknown>>;
    stages[1]!.warm = null;
    expect(validateMacBenchResults(document)).toContainEqual(
      expect.stringContaining("at least one of cold/warm"),
    );
  });

  it("rejects malformed provenance and missing contract versions", () => {
    const document = loadFixture();
    (document.provenance as Record<string, unknown>).dirtyWorkingTree = "no";
    const cascade = document.cascade as Record<string, Record<string, unknown>>;
    delete cascade.usableResult!.contractVersion;
    const errors = validateMacBenchResults(document);
    expect(errors).toContainEqual(expect.stringContaining("dirtyWorkingTree"));
    expect(errors).toContainEqual(expect.stringContaining("usableResult"));
  });

  it("never throws on garbage input", () => {
    expect(validateMacBenchResults(null)).toEqual(["root: expected object"]);
    expect(validateMacBenchResults([1, 2])).toEqual(["root: expected object"]);
    expect(validateMacBenchResults("x").length).toBeGreaterThan(0);
  });
});
