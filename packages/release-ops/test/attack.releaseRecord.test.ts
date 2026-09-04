import { describe, expect, it } from "vitest";
import { findRepoRoot, generateReleaseRecord } from "../src/generateManifest.js";
import {
  RELEASE_STAGES,
  validateReleaseRecord,
  type ReleaseRecord,
  type StageGate,
} from "../src/releaseRecord.js";

/**
 * Adversarial pass (shared-packages-ops #2, pass 3) against the release
 * record validator: gates that claim PASSED on hollow evidence, ordering
 * smuggling, prototype keys, timestamp garbage and key-collision false
 * positives. HELD cases assert the safe behaviour; FINDING cases pin what the
 * code does today so the repro is executable and the expected behaviour is
 * stated in the name.
 */

const REPO_ROOT = findRepoRoot(process.cwd());

function record(): ReleaseRecord {
  return generateReleaseRecord({
    repoRoot: REPO_ROOT,
    commitSha: "a".repeat(40),
    generatedAtIso: "2026-01-01T00:00:00.000Z",
  });
}

function withGate(
  base: ReleaseRecord,
  stage: StageGate["stage"],
  patch: Partial<StageGate>,
): ReleaseRecord {
  return {
    ...base,
    stageGates: base.stageGates.map((g) => (g.stage === stage ? { ...g, ...patch } : g)),
  };
}

describe("attack: PASSED on hollow evidence", () => {
  it("FINDING: evidence '' / '   ' / 'null' / zero-width space satisfy the PASSED-needs-evidence rule (only literal null is refused)", () => {
    for (const evidence of ["", "   ", "null", "\u200b", "\n"]) {
      const verdict = validateReleaseRecord(
        withGate(record(), "dev", { state: "PASSED", evidence, evaluatedAt: "x" }),
      );
      expect(verdict.valid, JSON.stringify(evidence)).toBe(true);
    }
    expect(
      validateReleaseRecord(withGate(record(), "dev", { state: "PASSED", evidence: null })).valid,
    ).toBe(false);
  });

  it("FINDING: coachReviewGate PASSED with evidence '' is valid — 'machine output is never coach evidence' is not enforced beyond null", () => {
    const base = record();
    const verdict = validateReleaseRecord({
      ...base,
      coachReviewGate: {
        ...base.coachReviewGate,
        state: "PASSED",
        evidence: "",
        blockedReason: null,
      },
    });
    expect(verdict.valid).toBe(true);
  });

  it("FINDING: PASSED with evaluatedAt null (never evaluated) is valid; evaluatedAt/generatedAtIso accept non-dates", () => {
    const passedNever = validateReleaseRecord(
      withGate(record(), "dev", { state: "PASSED", evidence: "ci://1", evaluatedAt: null }),
    );
    expect(passedNever.valid).toBe(true);
    const garbageTime = validateReleaseRecord({
      ...withGate(record(), "dev", {
        state: "PASSED",
        evidence: "ci://1",
        evaluatedAt: "yesterday-ish",
      }),
      generatedAtIso: "not a timestamp",
    });
    expect(garbageTime.valid).toBe(true);
  });

  it("FINDING: FAILED with blockedReason null and evidence null is valid — a failure carries no pointer to what failed", () => {
    expect(
      validateReleaseRecord(
        withGate(record(), "unit", { state: "FAILED", evidence: null, blockedReason: null }),
      ).valid,
    ).toBe(true);
  });
});

describe("attack: gate ordering and stage smuggling", () => {
  it("HELD: 'full' PASSED while 'physical-device' is BLOCKED_EXTERNAL is refused (no skipping the Apple gate)", () => {
    let r = record();
    for (const stage of RELEASE_STAGES) {
      if (stage === "physical-device") continue;
      r = withGate(r, stage, { state: "PASSED", evidence: "ci://1" });
    }
    const verdict = validateReleaseRecord(r);
    expect(verdict.valid).toBe(false);
    expect(verdict.problems.join("\n")).toMatch(
      /"internal" cannot be PASSED while an earlier stage is unresolved/,
    );
  });

  it("HELD: a duplicated stage replacing another, an unknown stage, a reordered list and a 12th gate are all refused", () => {
    const base = record();
    const gates = [...base.stageGates];
    const dup = { ...base, stageGates: gates.map((g, i) => (i === 10 ? { ...gates[0]! } : g)) };
    expect(validateReleaseRecord(dup).valid).toBe(false);
    const unknown = {
      ...base,
      stageGates: gates.map((g, i) =>
        i === 10 ? { ...g, stage: "prod" as StageGate["stage"] } : g,
      ),
    };
    expect(validateReleaseRecord(unknown).valid).toBe(false);
    const reordered = { ...base, stageGates: [...gates].reverse() };
    expect(validateReleaseRecord(reordered).valid).toBe(false);
    const extra = { ...base, stageGates: [...gates, { ...gates[0]! }] };
    expect(validateReleaseRecord(extra).valid).toBe(false);
  });

  it("HELD: state strings are exact — 'passed', 'PASSED ', 'Passed' are refused", () => {
    for (const state of ["passed", "PASSED ", "Passed"]) {
      expect(
        validateReleaseRecord(
          withGate(record(), "dev", { state: state as StageGate["state"], evidence: "x" }),
        ).valid,
        state,
      ).toBe(false);
    }
  });

  it("HELD: commitSha must be 40 lowercase hex — uppercase, 39 chars, 41 chars, and a 40-char non-hex string are refused", () => {
    for (const sha of ["A".repeat(40), "a".repeat(39), "a".repeat(41), "g".repeat(40)]) {
      expect(validateReleaseRecord({ ...record(), commitSha: sha }).valid, sha).toBe(false);
    }
  });
});

describe("attack: key collisions and prototype keys", () => {
  it("FINDING: modelVersions duplicate detection joins id@version with '@' — {id:'a@b',version:'c'} and {id:'a',version:'b@c'} are a false duplicate", () => {
    const base = record();
    const verdict = validateReleaseRecord({
      ...base,
      modelVersions: [
        { id: "a@b", version: "c", deploymentStatus: "active" },
        { id: "a", version: "b@c", deploymentStatus: "active" },
      ],
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.problems.join("\n")).toMatch(/duplicate entry a@b@c/);
  });

  it("HELD: __proto__ / constructor keys in featureFlags and profile versions are validated as ordinary keys (JSON-sourced)", () => {
    const base = record();
    const flags = JSON.parse('{"__proto__": true, "constructor": "yes"}') as Record<
      string,
      boolean
    >;
    const v = validateReleaseRecord({ ...base, featureFlags: flags });
    expect(v.valid).toBe(false);
    expect(v.problems).toContain("featureFlags.constructor must be a boolean");
    const profiles = JSON.parse('{"__proto__": ""}') as Record<string, string>;
    expect(
      validateReleaseRecord({ ...base, techniqueAnalysisProfileVersions: profiles }).problems,
    ).toContain("techniqueAnalysisProfileVersions.__proto__ must be a non-empty string");
  });

  it("HELD: an array, null, a string and a Date are refused as the record", () => {
    for (const bad of [[], null, "record", new Date(0)]) {
      const v = validateReleaseRecord(bad);
      expect(v.valid).toBe(false);
    }
  });

  it("HELD: migrationCount 0 / -1 / 1.5 / NaN / '3' refused; latestMigration with uppercase or path refused", () => {
    const base = record();
    for (const count of [0, -1, 1.5, Number.NaN, "3"]) {
      expect(
        validateReleaseRecord({
          ...base,
          databaseSchema: { ...base.databaseSchema, migrationCount: count as number },
        }).valid,
        String(count),
      ).toBe(false);
    }
    for (const mig of ["0001_Init.sql", "../0001_init.sql", "0001_init.SQL", "20260101_x.sql"]) {
      expect(
        validateReleaseRecord({
          ...base,
          databaseSchema: { ...base.databaseSchema, latestMigration: mig },
        }).valid,
        mig,
      ).toBe(false);
    }
  });
});
