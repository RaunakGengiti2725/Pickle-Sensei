import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot, generateReleaseRecord } from "../src/generateManifest.js";
import {
  RELEASE_STAGES,
  validateReleaseRecord,
  type ReleaseRecord,
  type StageGate,
} from "../src/releaseRecord.js";

/**
 * Adversarial pass 3 (tester #4) — release-record validation attacks.
 *
 *   S8  PASSED internal gate while shadow IN_PROGRESS; duplicated unit stage
 *       — both rejected with DISTINCT messages.
 *   S9  databaseSchema.latestMigration = Supabase-style
 *       "20260831130000_form_weighted_rank.sql" — rejected (unrepresentable).
 *   +   what the generator actually pins as "the database" and "the backend".
 *
 * Convention: BROKEN scenarios state the EXPECTED behaviour under `it.fails`
 * (green while the defect exists, red once fixed — flip to `it` then), with a
 * sibling `it` that pins the currently-observed behaviour as the repro.
 */

const REPO_ROOT = findRepoRoot(process.cwd());

function completeRecord(): ReleaseRecord {
  return generateReleaseRecord({
    repoRoot: REPO_ROOT,
    commitSha: "a".repeat(40),
    generatedAtIso: "2026-01-01T00:00:00.000Z",
  });
}

function passed(stage: StageGate["stage"]): StageGate {
  return {
    stage,
    state: "PASSED",
    evidence: `artifacts/attack4/${stage}.json`,
    evaluatedAt: "2026-01-01T00:00:00.000Z",
    blockedReason: null,
  };
}

function withGates(mutate: (gates: StageGate[]) => StageGate[]): ReleaseRecord {
  const record = completeRecord();
  return { ...record, stageGates: mutate([...record.stageGates]) };
}

describe("S8 stage-gate ordering", () => {
  it("baseline: the generated manifest validates", () => {
    expect(validateReleaseRecord(completeRecord())).toEqual({ valid: true, problems: [] });
  });

  it("internal PASSED while shadow IN_PROGRESS → rejected, names the offending stage", () => {
    const record = withGates((gates) =>
      gates.map((gate) => {
        if (["dev", "unit", "validation", "locked-test"].includes(gate.stage)) {
          return passed(gate.stage);
        }
        if (gate.stage === "shadow") {
          return { ...gate, state: "IN_PROGRESS", evaluatedAt: "2026-01-01T00:00:00.000Z" };
        }
        if (gate.stage === "internal") return passed("internal");
        return gate;
      }),
    );
    const result = validateReleaseRecord(record);
    expect(result.valid).toBe(false);
    expect(result.problems).toEqual([
      'stage "internal" cannot be PASSED while an earlier stage is unresolved',
    ]);
  });

  it("duplicated unit stage (replacing validation) → rejected with a DIFFERENT message", () => {
    const record = withGates((gates) =>
      gates.map((gate) => (gate.stage === "validation" ? { ...gate, stage: "unit" } : gate)),
    );
    const result = validateReleaseRecord(record);
    expect(result.valid).toBe(false);
    expect(result.problems).toEqual([
      'stageGates[2] must be for stage "validation" (canonical order)',
    ]);
    expect(result.problems.join("\n")).not.toMatch(/cannot be PASSED/);
  });

  it("duplicated unit stage (appended, 12 gates) → rejected by count AND order", () => {
    const record = withGates((gates) => [...gates, gates[1]!]);
    const result = validateReleaseRecord(record);
    expect(result.valid).toBe(false);
    expect(result.problems).toContain("stageGates must contain exactly one gate per stage (11)");
    // Order check compares only the first 11 positions, which are all correct
    // here — so the count message is the ONLY signal. Pinned.
    expect(result.problems).toEqual(["stageGates must contain exactly one gate per stage (11)"]);
  });

  it("pin: no problem message ever says 'duplicate' for stage gates (only for modelVersions)", () => {
    const record = withGates((gates) =>
      gates.map((gate) => (gate.stage === "validation" ? { ...gate, stage: "unit" } : gate)),
    );
    expect(validateReleaseRecord(record).problems.join(" ")).not.toMatch(/duplicate/);
  });

  it("both attacks at once → both messages present and distinct", () => {
    const record = withGates((gates) =>
      gates.map((gate) => {
        if (gate.stage === "validation") return { ...passed("unit") };
        if (["dev", "unit", "locked-test"].includes(gate.stage)) return passed(gate.stage);
        if (gate.stage === "shadow") return { ...gate, state: "IN_PROGRESS" };
        if (gate.stage === "internal") return passed("internal");
        return gate;
      }),
    );
    const result = validateReleaseRecord(record);
    expect(result.valid).toBe(false);
    expect(new Set(result.problems).size).toBe(result.problems.length);
    expect(result.problems).toContain(
      'stageGates[2] must be for stage "validation" (canonical order)',
    );
    expect(result.problems).toContain(
      'stage "internal" cannot be PASSED while an earlier stage is unresolved',
    );
  });

  it("every later stage PASSED while physical-device stays BLOCKED_EXTERNAL is rejected", () => {
    // With the default gate set, physical-device is BLOCKED_EXTERNAL, so
    // internal/beta/canary/staged/full can never be PASSED — pinned as the
    // honest default (a machine cannot pass a device gate).
    for (const stage of ["internal", "beta", "canary", "staged", "full"] as const) {
      const record = withGates((gates) =>
        gates.map((gate) =>
          gate.stage === stage ||
          RELEASE_STAGES.indexOf(gate.stage) < RELEASE_STAGES.indexOf("physical-device")
            ? passed(gate.stage)
            : gate,
        ),
      );
      const result = validateReleaseRecord(record);
      expect(result.valid, stage).toBe(false);
      expect(result.problems, stage).toEqual([
        `stage "${stage}" cannot be PASSED while an earlier stage is unresolved`,
      ]);
    }
  });

  it("PASSED with whitespace-only evidence is accepted (pin: evidence is not content-checked)", () => {
    const record = withGates((gates) =>
      gates.map((gate) => (gate.stage === "dev" ? { ...passed("dev"), evidence: " " } : gate)),
    );
    expect(validateReleaseRecord(record).valid).toBe(true);
  });

  it("FAILED then PASSED (validation FAILED, locked-test PASSED) is rejected", () => {
    const record = withGates((gates) =>
      gates.map((gate) => {
        if (["dev", "unit"].includes(gate.stage)) return passed(gate.stage);
        if (gate.stage === "validation") return { ...gate, state: "FAILED" };
        if (gate.stage === "locked-test") return passed("locked-test");
        return gate;
      }),
    );
    expect(validateReleaseRecord(record).problems).toEqual([
      'stage "locked-test" cannot be PASSED while an earlier stage is unresolved',
    ]);
  });
});

describe("S9 Supabase migration names", () => {
  it("'20260831130000_form_weighted_rank.sql' is rejected by MIGRATION_PATTERN", () => {
    const record = completeRecord();
    const result = validateReleaseRecord({
      ...record,
      databaseSchema: {
        latestMigration: "20260831130000_form_weighted_rank.sql",
        migrationCount: 40,
      },
    });
    expect(result.valid).toBe(false);
    expect(result.problems).toEqual([
      "databaseSchema.latestMigration must look like NNNN_name.sql",
    ]);
  });

  it("EVERY real production migration under supabase/migrations is unrepresentable", () => {
    const files = readdirSync(join(REPO_ROOT, "supabase/migrations")).filter((f) =>
      f.endsWith(".sql"),
    );
    expect(files.length).toBeGreaterThan(0);
    const record = completeRecord();
    for (const file of files) {
      const result = validateReleaseRecord({
        ...record,
        databaseSchema: { latestMigration: file, migrationCount: files.length },
      });
      expect(result.valid, file).toBe(false);
    }
  });

  it("REPRO: the generator pins packages/database (legacy Fastify DB), not supabase/migrations", () => {
    const record = completeRecord();
    const legacy = readdirSync(join(REPO_ROOT, "packages/database/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(record.databaseSchema.latestMigration).toBe(legacy.at(-1));
    expect(record.databaseSchema.migrationCount).toBe(legacy.length);
    // …and pins services/api (which the shipping app does not call — AGENTS.md)
    // as "the backend release".
    const api = JSON.parse(readFileSync(join(REPO_ROOT, "services/api/package.json"), "utf8")) as {
      name: string;
    };
    expect(record.backendRelease.serviceName).toBe(api.name);
  });

  it("REPRO: 'latest' legacy migration is ambiguous — many files share the same NNNN prefix", () => {
    const legacy = readdirSync(join(REPO_ROOT, "packages/database/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const latest = legacy.at(-1)!;
    const prefix = latest.slice(0, 4);
    const siblings = legacy.filter((f) => f.startsWith(`${prefix}_`));
    // VERIFIED on 4d812e1a: 8 migrations share prefix 0019; the "latest" is
    // whichever sorts last alphabetically, not whichever was applied last.
    expect(siblings.length).toBeGreaterThan(1);
  });

  it.fails(
    "EXPECTED: the release record can represent the production (Supabase) schema (BROKEN, P2)",
    () => {
      const record = completeRecord();
      const prod = readdirSync(join(REPO_ROOT, "supabase/migrations"))
        .filter((f) => f.endsWith(".sql"))
        .sort();
      const result = validateReleaseRecord({
        ...record,
        databaseSchema: { latestMigration: prod.at(-1), migrationCount: prod.length },
      });
      expect(result.valid).toBe(true);
    },
  );

  it("pattern edge cases: pin what the four-digit grammar accepts", () => {
    const record = completeRecord();
    const check = (name: string): boolean =>
      validateReleaseRecord({
        ...record,
        databaseSchema: { latestMigration: name, migrationCount: 1 },
      }).valid;
    expect(check("0019_training_eligibility_ledger.sql")).toBe(true);
    expect(check("0019_Training.sql")).toBe(false); // uppercase
    expect(check("019_x.sql")).toBe(false); // 3 digits
    expect(check("00019_x.sql")).toBe(false); // 5 digits
    expect(check("0019_x.SQL")).toBe(false);
    expect(check("0019_.sql")).toBe(false);
    expect(check("0019_x.sql\n")).toBe(false); // trailing newline: $ is not multiline
    expect(check("0019_x-y.sql")).toBe(false);
  });
});

describe("extra: validator robustness", () => {
  it("prototype-polluting keys in featureFlags are validated like any other key", () => {
    const record = completeRecord();
    const flags = JSON.parse('{"__proto__": true, "constructor": false}') as Record<
      string,
      boolean
    >;
    const result = validateReleaseRecord({ ...record, featureFlags: flags });
    expect(result.valid).toBe(true);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("stageGates given as a non-array object with numeric keys is rejected", () => {
    const record = completeRecord();
    const gatesObj = Object.fromEntries(record.stageGates.map((g, i) => [String(i), g]));
    const result = validateReleaseRecord({ ...record, stageGates: gatesObj });
    expect(result.valid).toBe(false);
    expect(result.problems).toContain("stageGates must be an array");
  });

  it("commitSha: uppercase hex, 39 chars, 41 chars, and a trailing newline are all rejected", () => {
    const record = completeRecord();
    for (const sha of ["A".repeat(40), "a".repeat(39), "a".repeat(41), `${"a".repeat(40)}\n`]) {
      expect(validateReleaseRecord({ ...record, commitSha: sha }).valid, JSON.stringify(sha)).toBe(
        false,
      );
    }
  });

  it("generatedAtIso is not checked for being a date (pin)", () => {
    const record = completeRecord();
    expect(validateReleaseRecord({ ...record, generatedAtIso: "yesterday" }).valid).toBe(true);
  });

  it("migrationCount below the real count is accepted (pin: no cross-check against the tree)", () => {
    const record = completeRecord();
    expect(
      validateReleaseRecord({
        ...record,
        databaseSchema: { ...record.databaseSchema, migrationCount: 1 },
      }).valid,
    ).toBe(true);
  });
});
