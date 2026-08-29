import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildBundle,
  importBundle,
  matchesSelection,
  parseBundle,
  serializeBundle,
} from "../src/experimentBundle.js";

const NOW = "2026-08-29T07:00:00.000Z";

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "exp-bundle-"));
  mkdirSync(join(root, "wave-c"), { recursive: true });
  mkdirSync(join(root, "wave-b", "W14-overlap"), { recursive: true });
  writeFileSync(join(root, "EXP-2026-08-28-cascade-waterfall.json"), '{"root":true}\n');
  writeFileSync(join(root, "wave-c", "c14-coach-portal-summary.json"), '{"ws":"C14"}\n');
  writeFileSync(join(root, "wave-c", "c01-summary.json"), '{"ws":"C01"}\n');
  writeFileSync(join(root, "wave-b", "W14-summary.json"), '{"ws":"W14"}\n');
  writeFileSync(join(root, "wave-b", "W14-overlap", "agreement.json"), '{"nested":true}\n');
  return root;
}

describe("matchesSelection", () => {
  it("filters by wave directory and workstream filename prefix", () => {
    expect(
      matchesSelection("wave-c/c14-summary.json", { waves: ["wave-c"], workstreams: [] }),
    ).toBe(true);
    expect(
      matchesSelection("wave-b/W14-summary.json", { waves: ["wave-c"], workstreams: [] }),
    ).toBe(false);
    expect(matchesSelection("wave-c/c14-summary.json", { waves: [], workstreams: ["C14"] })).toBe(
      true,
    );
    expect(matchesSelection("wave-c/c01-summary.json", { waves: [], workstreams: ["c14"] })).toBe(
      false,
    );
    expect(
      matchesSelection("wave-b/W14-overlap/agreement.json", { waves: [], workstreams: ["w14"] }),
    ).toBe(true);
    expect(matchesSelection("root.json", { waves: ["wave-c"], workstreams: [] })).toBe(false);
    expect(matchesSelection("root.json", { waves: [], workstreams: [] })).toBe(true);
  });
});

describe("buildBundle / parseBundle", () => {
  it("selects by wave + workstream and sorts files deterministically", () => {
    const root = fixtureRoot();
    const bundle = buildBundle(root, { waves: ["wave-c"], workstreams: ["c14"] }, NOW);
    expect(bundle.files.map((file) => file.path)).toEqual(["wave-c/c14-coach-portal-summary.json"]);
    const all = buildBundle(root, { waves: [], workstreams: [] }, NOW);
    expect(all.files.map((file) => file.path)).toEqual([
      "EXP-2026-08-28-cascade-waterfall.json",
      "wave-b/W14-overlap/agreement.json",
      "wave-b/W14-summary.json",
      "wave-c/c01-summary.json",
      "wave-c/c14-coach-portal-summary.json",
    ]);
  });

  it("refuses unknown bundle versions and corrupted digests", () => {
    expect(parseBundle({ bundleVersion: "experiment-bundle-v2", files: [] }).bundle).toBeNull();
    expect(parseBundle("nope").bundle).toBeNull();
    const root = fixtureRoot();
    const bundle = buildBundle(root, { waves: [], workstreams: [] }, NOW);
    const tampered = JSON.parse(serializeBundle(bundle)) as {
      files: Array<{ bytesBase64: string }>;
    };
    tampered.files[0]!.bytesBase64 = Buffer.from("tampered").toString("base64");
    const result = parseBundle(tampered);
    expect(result.bundle).toBeNull();
    expect(result.problems.join("\n")).toContain("sha256 mismatch");
  });

  it("refuses absolute and parent-escaping paths", () => {
    const root = fixtureRoot();
    const bundle = buildBundle(root, { waves: [], workstreams: [] }, NOW);
    const payload = JSON.parse(serializeBundle(bundle)) as { files: Array<{ path: string }> };
    payload.files[0]!.path = "../escape.json";
    expect(parseBundle(payload).bundle).toBeNull();
  });
});

describe("round trip (export → import → re-export byte-stable)", () => {
  it("reproduces the exact bytes and a byte-identical bundle", () => {
    const root = fixtureRoot();
    const bundle = buildBundle(root, { waves: [], workstreams: [] }, NOW);
    const serialized = serializeBundle(bundle);
    const parsed = parseBundle(JSON.parse(serialized));
    expect(parsed.problems).toEqual([]);
    const destination = mkdtempSync(join(tmpdir(), "exp-import-"));
    const report = importBundle(parsed.bundle!, destination);
    expect(report.conflicts).toEqual([]);
    expect(report.written).toHaveLength(5);
    for (const file of bundle.files) {
      const source = readFileSync(join(root, ...file.path.split("/")));
      const imported = readFileSync(join(destination, ...file.path.split("/")));
      expect(imported.equals(source)).toBe(true);
    }
    const reExported = buildBundle(destination, { waves: [], workstreams: [] }, NOW);
    expect(serializeBundle(reExported)).toBe(serialized);
  });

  it("is append-only: identical files are no-ops, differing files conflict and are kept", () => {
    const root = fixtureRoot();
    const bundle = buildBundle(root, { waves: ["wave-c"], workstreams: [] }, NOW);
    const destination = mkdtempSync(join(tmpdir(), "exp-import-"));
    mkdirSync(join(destination, "wave-c"), { recursive: true });
    writeFileSync(join(destination, "wave-c", "c01-summary.json"), '{"ws":"C01"}\n');
    writeFileSync(
      join(destination, "wave-c", "c14-coach-portal-summary.json"),
      '{"local":"truth"}\n',
    );
    const report = importBundle(bundle, destination);
    expect(report.unchanged).toEqual(["wave-c/c01-summary.json"]);
    expect(report.written).toEqual([]);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]!.path).toBe("wave-c/c14-coach-portal-summary.json");
    expect(readFileSync(join(destination, "wave-c", "c14-coach-portal-summary.json"), "utf8")).toBe(
      '{"local":"truth"}\n',
    );
  });

  it("dry-run reports without writing", () => {
    const root = fixtureRoot();
    const bundle = buildBundle(root, { waves: ["wave-b"], workstreams: [] }, NOW);
    const destination = mkdtempSync(join(tmpdir(), "exp-import-"));
    const report = importBundle(bundle, destination, { dryRun: true });
    expect(report.written).toHaveLength(2);
    expect(buildBundle(destination, { waves: [], workstreams: [] }, NOW).files).toEqual([]);
  });
});
