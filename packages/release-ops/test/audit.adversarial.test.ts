/**
 * Audit harness (execution pass 2, shared-packages-ops). New file only; no
 * production code changed. `it.fails` cases pin REPRODUCED defects — they
 * pass while the defect exists and start failing once it is fixed.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXTERNALLY_BLOCKED_STAGES,
  RELEASE_STAGES,
  findRepoRoot,
  generateReleaseRecord,
  validateReleaseRecord,
  type ReleaseRecord,
  type StageGate,
} from "../src/index.js";

const REPO_ROOT = findRepoRoot(process.cwd());

function record(): ReleaseRecord {
  return generateReleaseRecord({
    repoRoot: REPO_ROOT,
    commitSha: "b".repeat(40),
    generatedAtIso: "2026-09-04T00:00:00.000Z",
  });
}

function withGates(base: ReleaseRecord, mutate: (gates: StageGate[]) => void): ReleaseRecord {
  const gates = base.stageGates.map((g) => ({ ...g }));
  mutate(gates);
  return { ...base, stageGates: gates };
}

describe("audit: validateReleaseRecord gate semantics", () => {
  it.fails("FINDING: PASSED gate with evidence '' and evaluatedAt null is accepted", () => {
    const r = withGates(record(), (g) => {
      g[0] = { ...g[0]!, state: "PASSED", evidence: "", evaluatedAt: null, blockedReason: null };
    });
    expect(validateReleaseRecord(r).valid).toBe(false);
  });

  it.fails("FINDING: BLOCKED_EXTERNAL / NOT_EVALUABLE with blockedReason '' is accepted", () => {
    const r = withGates(record(), (g) => {
      const i = RELEASE_STAGES.indexOf("physical-device");
      g[i] = { ...g[i]!, blockedReason: "" };
    });
    expect(validateReleaseRecord(r).valid).toBe(false);
  });

  it.fails("FINDING: generatedAtIso / evaluatedAt are not checked for ISO-8601 shape", () => {
    const r = withGates({ ...record(), generatedAtIso: "yesterday" }, (g) => {
      g[0] = { ...g[0]!, state: "PASSED", evidence: "ci#1", evaluatedAt: "soon" };
    });
    expect(validateReleaseRecord(r).valid).toBe(false);
  });

  it("holds: fresh record validates; every stage present once in canonical order; external gates blocked", () => {
    const r = record();
    expect(validateReleaseRecord(r)).toEqual({ valid: true, problems: [] });
    expect(r.stageGates.map((g) => g.stage)).toEqual([...RELEASE_STAGES]);
    for (const g of r.stageGates) {
      if (EXTERNALLY_BLOCKED_STAGES.includes(g.stage)) {
        expect(g.state).toBe("BLOCKED_EXTERNAL");
        expect(g.blockedReason).toBeTruthy();
      } else {
        expect(g.state).toBe("NOT_RUN");
      }
    }
  });

  it("holds: no stage after physical-device can be PASSED while it stays BLOCKED_EXTERNAL", () => {
    const r = withGates(record(), (g) => {
      for (const gate of g) {
        if (gate.stage === "physical-device") continue;
        gate.state = "PASSED";
        gate.evidence = "ci#1";
        gate.evaluatedAt = "2026-09-04T00:00:00.000Z";
      }
    });
    const v = validateReleaseRecord(r);
    expect(v.valid).toBe(false);
    expect(v.problems.some((p) => p.includes('"internal" cannot be PASSED'))).toBe(true);
  });

  it("holds: duplicate/missing/out-of-order stages, extra gates, and unknown states are rejected", () => {
    const base = record();
    const dup = withGates(base, (g) => {
      g[1] = { ...g[0]! };
    });
    expect(validateReleaseRecord(dup).valid).toBe(false);
    const extra = { ...base, stageGates: [...base.stageGates, base.stageGates[0]!] };
    expect(validateReleaseRecord(extra).valid).toBe(false);
    const swapped = withGates(base, (g) => {
      [g[2], g[3]] = [g[3]!, g[2]!];
    });
    expect(validateReleaseRecord(swapped).valid).toBe(false);
    const bogus = withGates(base, (g) => {
      g[0] = { ...g[0]!, state: "GREEN" as StageGate["state"] };
    });
    expect(validateReleaseRecord(bogus).valid).toBe(false);
  });

  it("holds: hostile shapes (null, array, prototype-less, garbage fields) never throw", () => {
    for (const input of [
      null,
      undefined,
      [],
      "x",
      1,
      Object.create(null),
      { schemaVersion: "1" },
    ]) {
      expect(() => validateReleaseRecord(input)).not.toThrow();
      expect(validateReleaseRecord(input).valid).toBe(false);
    }
    const garbage = {
      ...record(),
      modelVersions: [null, 1, { id: "" }, { id: "a", version: "1" }],
      techniqueAnalysisProfileVersions: { x: 3 },
      featureFlags: { f: "yes" },
      databaseSchema: { latestMigration: "20260902_x.sql", migrationCount: 0.5 },
      coachReviewGate: null,
    } as unknown;
    const v = validateReleaseRecord(garbage);
    expect(v.valid).toBe(false);
    expect(v.problems.length).toBeGreaterThanOrEqual(7);
  });
});

describe("audit: generated release record coherence with the shipping product", () => {
  it.fails(
    "FINDING: mobileBuild.appVersion comes from apps/mobile/package.json, not the store MARKETING_VERSION asserted by release:check",
    () => {
      const r = record();
      const pbxproj = readFileSync(
        join(REPO_ROOT, "apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj"),
        "utf8",
      );
      const marketing = /MARKETING_VERSION = ([^;]+);/.exec(pbxproj)![1]!;
      const build = /CURRENT_PROJECT_VERSION = ([^;]+);/.exec(pbxproj)![1]!;
      expect(r.mobileBuild.appVersion).toBe(marketing);
      expect(r.mobileBuild.buildNumber).toBe(build);
    },
  );

  it.fails(
    "FINDING: databaseSchema tracks packages/database/migrations (legacy Fastify DB), not supabase/migrations (production)",
    () => {
      const r = record();
      const supabase = readdirSync(join(REPO_ROOT, "supabase/migrations"))
        .filter((f) => f.endsWith(".sql"))
        .sort();
      expect(r.databaseSchema.latestMigration).toBe(supabase.at(-1));
      expect(r.databaseSchema.migrationCount).toBe(supabase.length);
    },
  );

  it("evidence: infra/release/release-manifest.json (release:check) and the generated record disagree on the app version", () => {
    const r = record();
    const infra = JSON.parse(
      readFileSync(join(REPO_ROOT, "infra/release/release-manifest.json"), "utf8"),
    ) as { versionScheme: { marketingVersion: string; buildNumber: number } };
    expect(infra.versionScheme.marketingVersion).not.toBe(r.mobileBuild.appVersion);
    expect(r.mobileBuild.buildNumber).toBeNull();
    expect(r.backendRelease.serviceName).toBe("@pickle/api");
  });

  it("holds: the generated record is deterministic for fixed sha/timestamp", () => {
    expect(JSON.stringify(record())).toBe(JSON.stringify(record()));
  });
});
