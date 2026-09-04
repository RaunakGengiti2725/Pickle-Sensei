/**
 * Adjudication repro (shared-packages-ops) — release record.
 *
 * (a) validateReleaseRecord lets a stage be PASSED with evidence "" / whitespace
 *     or with evaluatedAt null — the "never PASSED without evidence" invariant
 *     in releaseRecord.ts is only a `=== null` check.
 * (b) generateReleaseRecord pins services/api + packages/database/migrations,
 *     while AGENTS.md states the shipping backend is supabase/functions/api and
 *     the schema is supabase/migrations. Every test here FAILS on 4d812e1a.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot, generateReleaseRecord } from "../src/generateManifest.js";
import { validateReleaseRecord, type ReleaseRecord, type StageGate } from "../src/releaseRecord.js";

const REPO_ROOT = findRepoRoot(process.cwd());

const record = (): ReleaseRecord =>
  generateReleaseRecord({
    repoRoot: REPO_ROOT,
    commitSha: "4d812e1aa699014cc0521fd92fde66908043aaa8",
    generatedAtIso: "2026-01-01T00:00:00.000Z",
  });

function withGate(r: ReleaseRecord, stage: StageGate["stage"], patch: Partial<StageGate>) {
  return {
    ...r,
    stageGates: r.stageGates.map((g) => (g.stage === stage ? { ...g, ...patch } : g)),
  };
}

describe("adjudication: PASSED requires real evidence and an evaluation timestamp", () => {
  for (const evidence of ["", "   ", "\n\t"]) {
    it(`evidence ${JSON.stringify(evidence)} is rejected like null`, () => {
      const v = validateReleaseRecord(
        withGate(record(), "dev", {
          state: "PASSED",
          evidence,
          evaluatedAt: "2026-01-01T00:00:00Z",
        }),
      );
      expect(v.valid).toBe(false);
    });
  }

  it("PASSED with evidence but evaluatedAt null is rejected", () => {
    const v = validateReleaseRecord(
      withGate(record(), "dev", { state: "PASSED", evidence: "ci/run/1", evaluatedAt: null }),
    );
    expect(v.valid).toBe(false);
  });

  it("BLOCKED_EXTERNAL with blockedReason '' is rejected", () => {
    const v = validateReleaseRecord(
      withGate(record(), "physical-device", { state: "BLOCKED_EXTERNAL", blockedReason: "" }),
    );
    expect(v.valid).toBe(false);
  });
});

describe("adjudication: the generated record describes the shipping product", () => {
  it("backendRelease names the Supabase edge function, not services/api", () => {
    expect(record().backendRelease.serviceName).not.toMatch(/^@pickle\/api$|services\/api/);
  });

  it("databaseSchema pins the newest supabase/migrations file", () => {
    const supabase = readdirSync(join(REPO_ROOT, "supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(record().databaseSchema.latestMigration).toBe(supabase.at(-1));
  });
});
