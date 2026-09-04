import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot, generateReleaseRecord } from "../src/generateManifest.js";
import {
  validateReleaseRecord,
  type ReleaseRecord,
  type ReleaseStage,
  type StageGate,
} from "../src/releaseRecord.js";

/**
 * SPO-05 regression pins.
 *
 * A release record must never read "PASSED" on the strength of blank
 * evidence or an unevaluated gate, and it must describe the backend that
 * actually ships (the Supabase edge function + supabase/migrations), not the
 * legacy Fastify stack the mobile app does not call.
 */

const REPO_ROOT = findRepoRoot(process.cwd());
const SUPABASE_MIGRATION_PATTERN = /^\d{14}_[a-z0-9_]+\.sql$/;

function completeRecord(): ReleaseRecord {
  return generateReleaseRecord({
    repoRoot: REPO_ROOT,
    commitSha: "a".repeat(40),
    generatedAtIso: "2026-01-01T00:00:00.000Z",
  });
}

function withGate(
  record: ReleaseRecord,
  stage: ReleaseStage,
  patch: Partial<StageGate>,
): ReleaseRecord {
  return {
    ...record,
    stageGates: record.stageGates.map((gate) =>
      gate.stage === stage ? { ...gate, ...patch } : gate,
    ),
  };
}

function newestSupabaseMigration(): { latest: string; count: number } {
  const files = readdirSync(join(REPO_ROOT, "supabase/migrations"))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const latest = files[files.length - 1];
  if (latest === undefined) throw new Error("supabase/migrations is empty");
  return { latest, count: files.length };
}

describe("validateReleaseRecord — PASSED gates need real evidence", () => {
  it("accepts a PASSED dev gate with non-blank evidence and a parseable evaluatedAt", () => {
    const record = withGate(completeRecord(), "dev", {
      state: "PASSED",
      evidence: "ci://run/123",
      evaluatedAt: "2026-01-02T00:00:00.000Z",
    });
    const verdict = validateReleaseRecord(record);
    expect(verdict.problems).toEqual([]);
    expect(verdict.valid).toBe(true);
  });

  it("rejects a PASSED gate whose evidence is whitespace only, naming the gate", () => {
    for (const evidence of ["", "   ", "\n\t"]) {
      const record = withGate(completeRecord(), "dev", {
        state: "PASSED",
        evidence,
        evaluatedAt: "2026-01-02T00:00:00.000Z",
      });
      const verdict = validateReleaseRecord(record);
      expect(verdict.valid, `evidence ${JSON.stringify(evidence)} must be rejected`).toBe(false);
      const problems = verdict.problems.join("\n");
      expect(problems).toContain("dev");
      expect(problems).toMatch(/evidence/i);
    }
  });

  it("rejects a PASSED gate whose evaluatedAt is null, naming the gate", () => {
    const record = withGate(completeRecord(), "dev", {
      state: "PASSED",
      evidence: "ci://run/123",
      evaluatedAt: null,
    });
    const verdict = validateReleaseRecord(record);
    expect(verdict.valid).toBe(false);
    const problems = verdict.problems.join("\n");
    expect(problems).toContain("dev");
    expect(problems).toMatch(/evaluatedAt/);
  });

  it("rejects a PASSED gate whose evaluatedAt is not a parseable timestamp", () => {
    for (const evaluatedAt of ["", "   ", "yesterday", "2026-13-45T99:99:99Z"]) {
      const record = withGate(completeRecord(), "dev", {
        state: "PASSED",
        evidence: "ci://run/123",
        evaluatedAt,
      });
      const verdict = validateReleaseRecord(record);
      expect(verdict.valid, `evaluatedAt ${JSON.stringify(evaluatedAt)} must be rejected`).toBe(
        false,
      );
      expect(verdict.problems.join("\n")).toMatch(/evaluatedAt/);
    }
  });

  it("rejects BLOCKED_EXTERNAL / NOT_EVALUABLE gates whose blockedReason is blank", () => {
    for (const blockedReason of ["", "   ", "\n"]) {
      const blocked = withGate(completeRecord(), "physical-device", {
        state: "BLOCKED_EXTERNAL",
        blockedReason,
      });
      const blockedVerdict = validateReleaseRecord(blocked);
      expect(blockedVerdict.valid, `BLOCKED_EXTERNAL with ${JSON.stringify(blockedReason)}`).toBe(
        false,
      );
      expect(blockedVerdict.problems.join("\n")).toContain("physical-device");

      const notEvaluable = withGate(completeRecord(), "shadow", {
        state: "NOT_EVALUABLE",
        blockedReason,
      });
      const notEvaluableVerdict = validateReleaseRecord(notEvaluable);
      expect(notEvaluableVerdict.valid, `NOT_EVALUABLE with ${JSON.stringify(blockedReason)}`).toBe(
        false,
      );
      expect(notEvaluableVerdict.problems.join("\n")).toContain("shadow");
    }
  });

  it("applies the same evidence rules to the coach review gate", () => {
    const base = completeRecord();
    const blankEvidence = {
      ...base,
      coachReviewGate: {
        state: "PASSED" as const,
        evidence: "   ",
        evaluatedAt: "2026-01-02T00:00:00.000Z",
        blockedReason: null,
      },
    };
    const blankVerdict = validateReleaseRecord(blankEvidence);
    expect(blankVerdict.valid).toBe(false);
    expect(blankVerdict.problems.join("\n")).toContain("coachReviewGate");

    const neverEvaluated = {
      ...base,
      coachReviewGate: {
        state: "PASSED" as const,
        evidence: "docs/COACH_REVIEW_2026-01.md",
        evaluatedAt: null,
        blockedReason: null,
      },
    };
    const neverEvaluatedVerdict = validateReleaseRecord(neverEvaluated);
    expect(neverEvaluatedVerdict.valid).toBe(false);
    expect(neverEvaluatedVerdict.problems.join("\n")).toContain("coachReviewGate");
  });
});

describe("generateReleaseRecord — describes the backend that ships", () => {
  it("pins the Supabase edge function and the newest supabase/migrations file", () => {
    const record = completeRecord();
    const { latest, count } = newestSupabaseMigration();

    expect(record.backendRelease.serviceName).toBe("supabase/functions/api");
    expect(record.backendRelease.version.trim().length).toBeGreaterThan(0);

    expect(record.databaseSchema.latestMigration).toBe(latest);
    expect(record.databaseSchema.latestMigration).toMatch(SUPABASE_MIGRATION_PATTERN);
    expect(record.databaseSchema.migrationCount).toBe(count);

    const verdict = validateReleaseRecord(record);
    expect(verdict.problems).toEqual([]);
    expect(verdict.valid).toBe(true);

    const legacy = {
      ...record,
      databaseSchema: {
        latestMigration: "0019_training_eligibility_ledger.sql",
        migrationCount: 1,
      },
    };
    const legacyVerdict = validateReleaseRecord(legacy);
    expect(legacyVerdict.valid).toBe(false);
    expect(legacyVerdict.problems.join("\n")).toContain("latestMigration");
  });
});
