import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findRepoRoot, generateReleaseRecord } from "../src/generateManifest.js";
import {
  createInitialCoachReviewGate,
  createInitialStageGates,
  validateReleaseRecord,
  type ReleaseRecord,
} from "../src/releaseRecord.js";

/**
 * Structural audit #2 (shared-packages-ops) — reproducing tests for the
 * release record's truth contract against the repo it describes.
 */

const repoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

function validRecord(): ReleaseRecord {
  return generateReleaseRecord({
    repoRoot,
    commitSha: "4d812e1aa699014cc0521fd92fde66908043aaa8",
    generatedAtIso: "2026-08-29T00:00:00.000Z",
  });
}

describe("AUDIT release record: gate evidence must be real, not merely non-null", () => {
  it("a PASSED gate with an EMPTY evidence string is rejected", () => {
    const record = validRecord();
    const gates = createInitialStageGates();
    gates[0] = { ...gates[0]!, state: "PASSED", evidence: "", evaluatedAt: "2026-08-29T00:00:00Z" };
    const verdict = validateReleaseRecord({ ...record, stageGates: gates });
    expect(verdict.valid, verdict.problems.join("; ")).toBe(false);
  });

  it("a BLOCKED_EXTERNAL gate with an EMPTY blockedReason is rejected", () => {
    const record = validRecord();
    const coach = { ...createInitialCoachReviewGate(), blockedReason: "" };
    const verdict = validateReleaseRecord({ ...record, coachReviewGate: coach });
    expect(verdict.valid, verdict.problems.join("; ")).toBe(false);
  });
});

describe("AUDIT release record: databaseSchema must describe the PRODUCTION schema plane", () => {
  it("the generated manifest's latestMigration is a file under supabase/migrations (the deployed schema)", () => {
    const record = validRecord();
    const supabaseMigrations = join(repoRoot, "supabase", "migrations");
    expect(existsSync(supabaseMigrations)).toBe(true);
    expect(
      existsSync(join(supabaseMigrations, record.databaseSchema.latestMigration)),
      `manifest pins ${record.databaseSchema.latestMigration}, which is not a supabase/migrations file`,
    ).toBe(true);
  });

  it("the validator accepts a real production migration filename", () => {
    const supabaseMigrations = join(repoRoot, "supabase", "migrations");
    const latest = readdirSync(supabaseMigrations)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .at(-1);
    expect(latest).toBeDefined();
    const record = validRecord();
    const verdict = validateReleaseRecord({
      ...record,
      databaseSchema: { latestMigration: latest!, migrationCount: 1 },
    });
    expect(verdict.valid, verdict.problems.join("; ")).toBe(true);
  });

  it("the generated manifest's backendRelease names the Supabase edge function the app calls", () => {
    const record = validRecord();
    expect(
      record.backendRelease.serviceName,
      "backendRelease pins the legacy Fastify service, which apps/mobile does not call (AGENTS.md)",
    ).not.toBe("@pickle/api");
  });
});
