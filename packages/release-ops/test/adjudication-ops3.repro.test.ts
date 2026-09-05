import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateReleaseRecord } from "../src/index.js";

/**
 * Adjudication repro (stress area packages-ops-3, baseline 1fb0efd7).
 * Root cause: `readPackageVersion` does `JSON.parse(raw) as {...}` and then
 * reads `parsed.name` without checking that the parse produced an object, so
 * a package.json whose top-level value is `null` (or any primitive) throws a
 * native TypeError instead of the typed "missing name or version" error the
 * function already defines for malformed manifests.
 *
 * Replayed seed (tools/stress/boundary-malformed, origin/devin/stress-pkg-ops-bundle-boundary-malformed):
 *   2582407818 — apps/mobile/package.json := null
 *
 * This test asserts the EXPECTED contract and therefore FAILS on 1fb0efd7.
 */

function scaffoldRepo(mobilePackageJson: string): string {
  const root = mkdtempSync(join(tmpdir(), "release-ops-adjudicate-"));
  mkdirSync(join(root, "apps/mobile"), { recursive: true });
  mkdirSync(join(root, "services/api"), { recursive: true });
  mkdirSync(join(root, "packages/database/migrations"), { recursive: true });
  writeFileSync(join(root, "apps/mobile/package.json"), mobilePackageJson);
  writeFileSync(
    join(root, "services/api/package.json"),
    JSON.stringify({ name: "@pickle/api", version: "0.1.0" }),
  );
  writeFileSync(join(root, "packages/database/migrations/0001_init.sql"), "select 1;\n");
  return root;
}

describe("release-ops: malformed package.json is reported as a typed validation error", () => {
  it("seed 2582407818: a top-level JSON null in apps/mobile/package.json", () => {
    const root = scaffoldRepo("null");
    let caught: unknown = null;
    try {
      generateReleaseRecord({ repoRoot: root, commitSha: "0".repeat(40) });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect((caught as Error).message).toMatch(
      /apps\/mobile\/package\.json is missing name or version/,
    );
  });
});
