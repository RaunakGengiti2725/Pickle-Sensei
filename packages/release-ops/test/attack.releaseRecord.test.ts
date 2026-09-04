/**
 * Adversarial pass (shared-packages-ops #1, pass 3) — release manifest
 * validation and generation. `it(...)` = HELD / OBSERVED (pinned current
 * behaviour); `it.fails(...)` = EXPECTED contract that is currently broken.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot, generateReleaseRecord } from "../src/generateManifest.js";
import {
  RELEASE_STAGES,
  validateReleaseRecord,
  type ReleaseRecord,
  type StageGate,
} from "../src/releaseRecord.js";

const REPO_ROOT = findRepoRoot(process.cwd());

function record(): ReleaseRecord {
  return generateReleaseRecord({
    repoRoot: REPO_ROOT,
    commitSha: "4d812e1aa699014cc0521fd92fde66908043aaa8",
    generatedAtIso: "2026-09-04T12:00:00.000Z",
  });
}

function withGates(mutate: (gates: StageGate[]) => void): ReleaseRecord {
  const r = record();
  const gates = r.stageGates.map((g) => ({ ...g }));
  mutate(gates);
  return { ...r, stageGates: gates };
}

function passAll(gates: StageGate[], upTo: number, evidence: string): void {
  for (let i = 0; i <= upTo; i++) {
    gates[i] = { ...gates[i]!, state: "PASSED", evidence, evaluatedAt: "t", blockedReason: null };
  }
}

describe("evidence semantics", () => {
  it("OBSERVED: PASSED with evidence '' or whitespace is accepted — an empty string counts as evidence", () => {
    for (const evidence of ["", "   ", "\n"]) {
      const r = withGates((g) => passAll(g, 0, evidence));
      expect(validateReleaseRecord(r)).toEqual({ valid: true, problems: [] });
      const coach = {
        ...record(),
        coachReviewGate: {
          state: "PASSED" as const,
          evidence,
          evaluatedAt: "t",
          blockedReason: null,
        },
      };
      expect(validateReleaseRecord(coach).valid).toBe(true);
    }
  });

  it.fails("EXPECTED: PASSED requires non-blank evidence", () => {
    const r = withGates((g) => passAll(g, 0, ""));
    expect(validateReleaseRecord(r).valid).toBe(false);
  });

  it("OBSERVED: BLOCKED_EXTERNAL / NOT_EVALUABLE with blockedReason '' pass; PASSED with evaluatedAt null passes", () => {
    const r = withGates((g) => {
      g[5] = { ...g[5]!, blockedReason: "" };
      g[0] = { ...g[0]!, state: "NOT_EVALUABLE", blockedReason: "" };
      g[1] = { ...g[1]!, state: "PASSED", evidence: "ci#1", evaluatedAt: null };
    });
    // stage 1 PASSED while stage 0 unresolved is the only complaint
    expect(validateReleaseRecord(r).problems).toEqual([
      'stage "unit" cannot be PASSED while an earlier stage is unresolved',
    ]);
  });

  it("HELD: with physical-device BLOCKED_EXTERNAL by default, NO stage from 'internal' onward can be PASSED — the external gate really blocks", () => {
    const r = withGates((g) => {
      passAll(g, 4, "ci");
      g[6] = { ...g[6]!, state: "PASSED", evidence: "ci" };
    });
    expect(validateReleaseRecord(r).problems).toEqual([
      'stage "internal" cannot be PASSED while an earlier stage is unresolved',
    ]);
    const ok = withGates((g) => passAll(g, 10, "ci"));
    expect(validateReleaseRecord(ok).valid).toBe(true);
  });

  it("HELD: IN_PROGRESS / FAILED / NOT_RUN earlier stages all block a later PASSED; 'full' PASSED with everything else PASSED is the only all-green shape", () => {
    for (const state of ["IN_PROGRESS", "FAILED", "NOT_RUN"] as const) {
      const r = withGates((g) => {
        passAll(g, 10, "ci");
        g[3] = { ...g[3]!, state, evidence: null };
      });
      expect(validateReleaseRecord(r).problems).toContain(
        'stage "shadow" cannot be PASSED while an earlier stage is unresolved',
      );
    }
  });
});

describe("structural attacks", () => {
  it("HELD: stageGates with the right length but a duplicated stage replacing another is rejected", () => {
    const r = withGates((g) => {
      g[1] = { ...g[0]! };
    });
    expect(validateReleaseRecord(r).problems).toContain(
      'stageGates[1] must be for stage "unit" (canonical order)',
    );
  });

  it("HELD: stageGates as an array with 12 entries (extra 'full') or 10 entries is rejected", () => {
    const twelve = {
      ...record(),
      stageGates: [...record().stageGates, { ...record().stageGates[10]! }],
    };
    expect(validateReleaseRecord(twelve).problems).toContain(
      `stageGates must contain exactly one gate per stage (${RELEASE_STAGES.length})`,
    );
    const ten = { ...record(), stageGates: record().stageGates.slice(0, 10) };
    expect(validateReleaseRecord(ten).valid).toBe(false);
  });

  it("HELD: a non-object gate entry is reported and does not crash the earlier-unresolved scan", () => {
    const r = { ...record(), stageGates: [...record().stageGates] as unknown[] };
    r.stageGates[2] = null;
    const v = validateReleaseRecord(r);
    expect(v.valid).toBe(false);
    expect(v.problems).toContain("stageGates[2] must be an object");
  });

  it("OBSERVED: modelVersions duplicate detection keys on `${id}@${version}` — ids containing '@' collide: {a@b, c} vs {a, b@c} is a false duplicate", () => {
    const r = {
      ...record(),
      modelVersions: [
        { id: "a@b", version: "c", deploymentStatus: "active" },
        { id: "a", version: "b@c", deploymentStatus: "active" },
      ],
    };
    expect(validateReleaseRecord(r).problems).toContain(
      "modelVersions contains duplicate entry a@b@c",
    );
  });

  it("HELD: an uppercase / 39-char / 41-char / non-hex commit SHA is rejected", () => {
    for (const sha of [
      "A".repeat(40),
      "a".repeat(39),
      "a".repeat(41),
      "g".repeat(40),
      " " + "a".repeat(39),
    ]) {
      expect(validateReleaseRecord({ ...record(), commitSha: sha }).problems).toContain(
        "commitSha must be a full 40-hex commit SHA",
      );
    }
  });

  it("HELD: JSON round-trip of a valid record stays valid (no class instances / undefined leaks)", () => {
    const r = record();
    expect(validateReleaseRecord(JSON.parse(JSON.stringify(r)))).toEqual({
      valid: true,
      problems: [],
    });
  });

  it("HELD: featureFlags with `__proto__` / `constructor` keys from JSON.parse are validated like any other key", () => {
    const raw = JSON.stringify(record()).replace(
      '"featureFlags":{',
      '"featureFlags":{"__proto__":"x","constructor":1,',
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const v = validateReleaseRecord(parsed);
    expect(v.problems).toContain("featureFlags.__proto__ must be a boolean");
    expect(v.problems).toContain("featureFlags.constructor must be a boolean");
  });

  it("HELD: schemaVersion '1' (string) and 1.0000001 are rejected; 1 accepted", () => {
    expect(validateReleaseRecord({ ...record(), schemaVersion: "1" }).problems).toContain(
      "schemaVersion must be 1",
    );
    expect(validateReleaseRecord({ ...record(), schemaVersion: 1.0000001 }).problems).toContain(
      "schemaVersion must be 1",
    );
  });
});

describe("manifest coherence with the shipping product (INFERRED from AGENTS.md; values OBSERVED)", () => {
  it("OBSERVED: the manifest's backendRelease points at services/api (@pickle/api), not the production Supabase edge function", () => {
    const r = record();
    expect(r.backendRelease.serviceName).toBe("@pickle/api");
    expect(existsSync(join(REPO_ROOT, "supabase/functions/api/index.ts"))).toBe(true);
  });

  it("OBSERVED: databaseSchema is read from packages/database/migrations, NOT supabase/migrations; the 'latest' is chosen by lexical sort among THREE files sharing prefix 0019_", () => {
    const r = record();
    const pkgMigrations = readdirSync(join(REPO_ROOT, "packages/database/migrations")).filter((f) =>
      f.endsWith(".sql"),
    );
    const supabaseMigrations = readdirSync(join(REPO_ROOT, "supabase/migrations")).filter((f) =>
      f.endsWith(".sql"),
    );
    expect(r.databaseSchema.migrationCount).toBe(pkgMigrations.length);
    expect(r.databaseSchema.migrationCount).not.toBe(supabaseMigrations.length);
    const dupPrefix = pkgMigrations.filter((f) => f.startsWith("0019_"));
    expect(dupPrefix.length).toBeGreaterThan(1);
    expect(r.databaseSchema.latestMigration).toBe([...dupPrefix].sort().at(-1));
    // the production migration naming (YYYYMMDDHHMMSS_name.sql) is REJECTED by the manifest validator
    const supaLatest = [...supabaseMigrations].sort().at(-1)!;
    const v = validateReleaseRecord({
      ...r,
      databaseSchema: { latestMigration: supaLatest, migrationCount: supabaseMigrations.length },
    });
    expect(v.problems).toEqual(["databaseSchema.latestMigration must look like NNNN_name.sql"]);
  });
});
