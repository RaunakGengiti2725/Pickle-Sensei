import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findRepoRoot,
  generateReleaseRecord,
  IOS_PBXPROJ_PATH,
  readBackendReleaseRef,
  readMobileBuildRef,
  RELEASE_MANIFEST_PATH,
  RUNTIME_CONFIG_PATH,
} from "../src/generateManifest.js";
import { validateReleaseRecord } from "../src/releaseRecord.js";

/**
 * Adversarial probes for the RCD-06 fix (a8d88c65): copies of the REAL
 * manifest / runtimeConfig / pbxproj are mutated one dimension at a time and
 * the generator must either return the shipping identity or refuse loudly —
 * never emit a record that names a version the app does not carry.
 */

const REPO_ROOT = findRepoRoot(process.cwd());
const SOURCES = [RELEASE_MANIFEST_PATH, RUNTIME_CONFIG_PATH, IOS_PBXPROJ_PATH];
const roots: string[] = [];

function realTreeCopy(mutate: (root: string) => void = () => {}): string {
  const root = mkdtempSync(join(tmpdir(), "release-ops-attack-"));
  roots.push(root);
  for (const rel of SOURCES) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    cpSync(join(REPO_ROOT, rel), join(root, rel));
  }
  mutate(root);
  return root;
}

function rewrite(root: string, rel: string, edit: (source: string) => string): void {
  const path = join(root, rel);
  const before = readFileSync(path, "utf8");
  const after = edit(before);
  if (after === before) throw new Error(`mutation did not change ${rel}`);
  writeFileSync(path, after);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("readMobileBuildRef against copies of the real sources", () => {
  it("baseline: the real tree yields the manifest's marketing version + build", () => {
    const scheme = JSON.parse(readFileSync(join(REPO_ROOT, RELEASE_MANIFEST_PATH), "utf8")) as {
      versionScheme: { marketingVersion: string; buildNumber: number };
    };
    expect(readMobileBuildRef(realTreeCopy())).toEqual({
      appVersion: scheme.versionScheme.marketingVersion,
      buildNumber: String(scheme.versionScheme.buildNumber),
    });
  });

  it("tolerates CRLF line endings in runtimeConfig.ts and the pbxproj", () => {
    const root = realTreeCopy((r) => {
      rewrite(r, RUNTIME_CONFIG_PATH, (s) => s.replace(/\n/g, "\r\n"));
      rewrite(r, IOS_PBXPROJ_PATH, (s) => s.replace(/\n/g, "\r\n"));
    });
    expect(readMobileBuildRef(root)).toEqual({ appVersion: "1.0", buildNumber: "1" });
  });

  it("refuses when a second Xcode target carries a different MARKETING_VERSION", () => {
    const root = realTreeCopy((r) =>
      rewrite(
        r,
        IOS_PBXPROJ_PATH,
        (s) => s + "\n\t\t\t\tMARKETING_VERSION = 2.0;\n\t\t\t\tCURRENT_PROJECT_VERSION = 1;\n",
      ),
    );
    expect(() => readMobileBuildRef(root)).toThrow(/MARKETING_VERSION '2.0'/);
  });

  it("refuses a pbxproj MARKETING_VERSION with a PATCH component the manifest lacks", () => {
    const root = realTreeCopy((r) =>
      rewrite(r, IOS_PBXPROJ_PATH, (s) =>
        s.replace(/MARKETING_VERSION = 1\.0;/g, "MARKETING_VERSION = 1.0.0;"),
      ),
    );
    expect(() => readMobileBuildRef(root)).toThrow(/MARKETING_VERSION '1.0.0'/);
  });

  it("refuses a pbxproj CURRENT_PROJECT_VERSION of 1.0 against manifest buildNumber 1", () => {
    const root = realTreeCopy((r) =>
      rewrite(r, IOS_PBXPROJ_PATH, (s) =>
        s.replace(/CURRENT_PROJECT_VERSION = 1;/g, "CURRENT_PROJECT_VERSION = 1.0;"),
      ),
    );
    expect(() => readMobileBuildRef(root)).toThrow(/CURRENT_PROJECT_VERSION '1.0'/);
  });

  it("refuses a manifest whose buildNumber is a numeric string", () => {
    const root = realTreeCopy((r) =>
      rewrite(r, RELEASE_MANIFEST_PATH, (s) =>
        s.replace('"buildNumber": 1,', '"buildNumber": "1",'),
      ),
    );
    expect(() => readMobileBuildRef(root)).toThrow(/buildNumber must be a positive integer/);
  });

  it("refuses a manifest marketingVersion with a pre-release suffix", () => {
    const root = realTreeCopy((r) =>
      rewrite(r, RELEASE_MANIFEST_PATH, (s) =>
        s.replace('"marketingVersion": "1.0"', '"marketingVersion": "1.0-rc1"'),
      ),
    );
    expect(() => readMobileBuildRef(root)).toThrow(/marketingVersion must be MAJOR\.MINOR/);
  });

  it("refuses rather than guessing when runtimeConfig no longer declares APP_VERSION as a plain const", () => {
    const root = realTreeCopy((r) =>
      rewrite(r, RUNTIME_CONFIG_PATH, (s) =>
        s.replace("const APP_VERSION = '1.0';", "export const APP_VERSION = '1.0';"),
      ),
    );
    expect(() => readMobileBuildRef(root)).toThrow(/does not declare const APP_VERSION/);
  });

  it("never reports the RN template version from apps/mobile/package.json", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "apps/mobile/package.json"), "utf8")) as {
      version: string;
    };
    const ref = readMobileBuildRef(realTreeCopy());
    expect(ref.appVersion).not.toBe(pkg.version);
    expect(ref.buildNumber).not.toBeNull();
  });
});

describe("readBackendReleaseRef", () => {
  it("refuses an edge-function directory that exists but has no index.ts", () => {
    const root = mkdtempSync(join(tmpdir(), "release-ops-attack-backend-"));
    roots.push(root);
    mkdirSync(join(root, "supabase/functions/api"), { recursive: true });
    expect(() => readBackendReleaseRef(root, "c".repeat(40))).toThrow(/index\.ts not found/);
  });

  it("never names the legacy Fastify package", () => {
    const ref = readBackendReleaseRef(REPO_ROOT, "d".repeat(40));
    expect(ref.serviceName).not.toBe("@pickle/api");
    expect(ref.serviceName).toBe("supabase/functions/api");
  });
});

describe("generateReleaseRecord end to end", () => {
  it("a record with an injected non-SHA commit is rejected by validateReleaseRecord (backend version rides on it)", () => {
    const record = generateReleaseRecord({ repoRoot: REPO_ROOT, commitSha: "not-a-sha" });
    expect(record.backendRelease.version).toBe("not-a-sha");
    const verdict = validateReleaseRecord(record);
    expect(verdict.valid).toBe(false);
    expect(verdict.problems).toContain("commitSha must be a full 40-hex commit SHA");
  });

  it("is deterministic across repeated runs for the same inputs", () => {
    const opts = {
      repoRoot: REPO_ROOT,
      commitSha: "e".repeat(40),
      generatedAtIso: "2026-09-04T00:00:00.000Z",
    };
    expect(generateReleaseRecord(opts)).toEqual(generateReleaseRecord(opts));
  });
});
