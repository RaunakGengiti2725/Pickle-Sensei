import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createInitialCoachReviewGate,
  createInitialStageGates,
  findRepoRoot,
  generateReleaseRecord,
  validateReleaseRecord,
  type ReleaseRecord,
} from "../src/index.js";

/**
 * STRUCTURAL AUDIT (shared-packages-ops, pass 1).
 * Contract (releaseRecord.ts): "PASSED needs evidence"; the record "cannot
 * drift from the code it describes" (generateManifest.ts). AGENTS.md: the
 * production backend is supabase/functions/api and the production schema is
 * supabase/migrations (YYYYMMDDHHMMSS_*.sql).
 */

const repoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

function baseRecord(): ReleaseRecord {
  return generateReleaseRecord({
    repoRoot,
    commitSha: "4d812e1aa699014cc0521fd92fde66908043aaa8",
    generatedAtIso: "2026-09-04T00:00:00.000Z",
  });
}

describe("audit: gate evidence must be substantive", () => {
  it("a PASSED stage gate with empty-string evidence is rejected", () => {
    const record = baseRecord();
    const gates = createInitialStageGates();
    gates[0] = {
      ...gates[0]!,
      state: "PASSED",
      evidence: "",
      evaluatedAt: "2026-09-04T00:00:00.000Z",
    };
    const result = validateReleaseRecord({ ...record, stageGates: gates });
    expect(result.valid, result.problems.join("\n")).toBe(false);
  });

  it("a BLOCKED_EXTERNAL coach-review gate with empty-string reason is rejected", () => {
    const record = baseRecord();
    const gate = { ...createInitialCoachReviewGate(), blockedReason: "" };
    const result = validateReleaseRecord({ ...record, coachReviewGate: gate });
    expect(result.valid, result.problems.join("\n")).toBe(false);
  });
});

describe("audit: release truth describes the PRODUCTION planes", () => {
  it("backendRelease points at the Supabase edge function, not the legacy Fastify service", () => {
    const record = baseRecord();
    expect(existsSync(join(repoRoot, "supabase/functions/api/index.ts"))).toBe(true);
    expect(record.backendRelease.serviceName, JSON.stringify(record.backendRelease)).toMatch(
      /supabase|edge/i,
    );
  });

  it("databaseSchema.latestMigration is the newest supabase/migrations file", () => {
    const supabaseMigrations = readdirSync(join(repoRoot, "supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const newest = supabaseMigrations.at(-1);
    expect(newest).toBeDefined();
    const record = baseRecord();
    expect(record.databaseSchema.latestMigration).toBe(newest);
  });

  it("the validator can represent a Supabase migration filename at all", () => {
    const record = baseRecord();
    const result = validateReleaseRecord({
      ...record,
      databaseSchema: {
        latestMigration: "20260902150000_free_rating_identity_ledger.sql",
        migrationCount: 1,
      },
    });
    expect(result.valid, result.problems.join("\n")).toBe(true);
  });

  it("legacy migration numbering yields a unique latest migration", () => {
    // Several packages/database migrations share prefix 0019_; "latest" by
    // lexical sort is then an arbitrary pick among equals.
    const legacy = readdirSync(join(repoRoot, "packages/database/migrations")).filter((f) =>
      f.endsWith(".sql"),
    );
    const prefixes = legacy.map((f) => f.slice(0, 4));
    expect(new Set(prefixes).size, legacy.join(", ")).toBe(prefixes.length);
  });
});
