/**
 * Adversarial pass 3 — release manifest: evidence-less PASSED gates smuggled
 * through with empty strings, unparseable timestamps, and whether the
 * generated manifest actually pins the SHIPPING backend (supabase edge fn +
 * supabase/migrations, per AGENTS.md) rather than the legacy services/api.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot, generateReleaseRecord } from "../src/generateManifest.js";
import { validateReleaseRecord, type ReleaseRecord, type StageGate } from "../src/releaseRecord.js";

const REPO_ROOT = findRepoRoot(process.cwd());

function record(): ReleaseRecord {
  return generateReleaseRecord({
    repoRoot: REPO_ROOT,
    commitSha: "4d812e1aa699014cc0521fd92fde66908043aaa8",
    generatedAtIso: "2026-01-01T00:00:00.000Z",
  });
}

function withGate(
  r: ReleaseRecord,
  stage: StageGate["stage"],
  patch: Partial<StageGate>,
): ReleaseRecord {
  return {
    ...r,
    stageGates: r.stageGates.map((g) => (g.stage === stage ? { ...g, ...patch } : g)),
  };
}

describe("attack3: PASSED without real evidence", () => {
  it('evidence "" (empty string) must be rejected exactly like null', () => {
    const r = withGate(record(), "dev", {
      state: "PASSED",
      evidence: "",
      evaluatedAt: "2026-01-01T00:00:00Z",
    });
    const v = validateReleaseRecord(r);
    expect(v.valid, JSON.stringify(v.problems)).toBe(false);
  });

  it("whitespace-only evidence must be rejected", () => {
    const r = withGate(record(), "dev", {
      state: "PASSED",
      evidence: "   \n\t",
      evaluatedAt: "2026-01-01T00:00:00Z",
    });
    expect(validateReleaseRecord(r).valid).toBe(false);
  });

  it("PASSED with evidence but evaluatedAt=null (never evaluated) must be rejected", () => {
    const r = withGate(record(), "dev", {
      state: "PASSED",
      evidence: "ci://run/1",
      evaluatedAt: null,
    });
    expect(validateReleaseRecord(r).valid).toBe(false);
  });

  it("evaluatedAt that is not a parseable timestamp must be rejected", () => {
    const r = withGate(record(), "dev", {
      state: "PASSED",
      evidence: "ci://run/1",
      evaluatedAt: "yesterday-ish",
    });
    expect(validateReleaseRecord(r).valid).toBe(false);
  });

  it("coachReviewGate PASSED with empty evidence must be rejected", () => {
    const r: ReleaseRecord = {
      ...record(),
      coachReviewGate: {
        state: "PASSED",
        evidence: "",
        evaluatedAt: "2026-01-01T00:00:00Z",
        blockedReason: null,
      },
    };
    expect(validateReleaseRecord(r).valid).toBe(false);
  });
});

describe("attack3: stage ordering under duplicate / shuffled gates", () => {
  it("two gates for the same stage and one stage missing (still 11 entries) is rejected", () => {
    const r = record();
    const gates = [...r.stageGates];
    gates[10] = { ...gates[9]! }; // duplicate 'staged', drop 'full'
    expect(validateReleaseRecord({ ...r, stageGates: gates }).valid).toBe(false);
  });

  it("a later stage PASSED while physical-device is BLOCKED_EXTERNAL is rejected", () => {
    const r = withGate(record(), "internal", {
      state: "PASSED",
      evidence: "x",
      evaluatedAt: "2026-01-01T00:00:00Z",
    });
    expect(validateReleaseRecord(r).valid).toBe(false);
  });
});

describe("attack3: does the generated manifest describe the SHIPPING product?", () => {
  it("backendRelease pins the Supabase edge function, not the legacy services/api the app does not call", () => {
    const r = record();
    expect(r.backendRelease.serviceName, JSON.stringify(r.backendRelease)).not.toMatch(
      /^@pickle\/api$/,
    );
  });

  it("databaseSchema pins the latest applied supabase/migrations file, not packages/database", () => {
    const r = record();
    const supabaseLatest = readdirSync(join(REPO_ROOT, "supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .at(-1);
    expect(r.databaseSchema.latestMigration, `expected ${supabaseLatest}`).toBe(supabaseLatest);
  });

  it("the migration name validator accepts the production migration naming (YYYYMMDDHHMMSS_name.sql)", () => {
    const r: ReleaseRecord = {
      ...record(),
      databaseSchema: {
        latestMigration: "20260902150000_free_rating_identity_ledger.sql",
        migrationCount: 20,
      },
    };
    const v = validateReleaseRecord(r);
    expect(v.problems.filter((p) => p.includes("latestMigration"))).toEqual([]);
  });

  it("legacy migration prefixes are unambiguous (no two files share a NNNN_ prefix)", () => {
    const files = readdirSync(join(REPO_ROOT, "packages/database/migrations")).filter((f) =>
      f.endsWith(".sql"),
    );
    const byPrefix = new Map<string, string[]>();
    for (const f of files) {
      const p = f.slice(0, 4);
      byPrefix.set(p, [...(byPrefix.get(p) ?? []), f]);
    }
    const dupes = [...byPrefix.entries()].filter(([, v]) => v.length > 1);
    expect(dupes, "latestMigration is chosen by lexical sort among same-prefix files").toEqual([]);
  });
});
