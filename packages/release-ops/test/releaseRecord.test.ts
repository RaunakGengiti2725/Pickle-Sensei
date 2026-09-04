import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot, generateReleaseRecord } from "../src/generateManifest.js";
import {
  createInitialCoachReviewGate,
  createInitialStageGates,
  EXTERNALLY_BLOCKED_STAGES,
  RELEASE_STAGES,
  validateReleaseRecord,
  type ReleaseRecord,
} from "../src/releaseRecord.js";

const REPO_ROOT = findRepoRoot(process.cwd());

function readVersionScheme(): { marketingVersion: string; buildNumber: number } {
  const raw = readFileSync(join(REPO_ROOT, "infra/release/release-manifest.json"), "utf8");
  const parsed = JSON.parse(raw) as {
    versionScheme: { marketingVersion: string; buildNumber: number };
  };
  return parsed.versionScheme;
}

function completeRecord(): ReleaseRecord {
  return generateReleaseRecord({
    repoRoot: REPO_ROOT,
    commitSha: "a".repeat(40),
    generatedAtIso: "2026-01-01T00:00:00.000Z",
  });
}

describe("stage model", () => {
  it("represents all eleven pipeline stages in canonical order", () => {
    expect(RELEASE_STAGES).toEqual([
      "dev",
      "unit",
      "validation",
      "locked-test",
      "shadow",
      "physical-device",
      "internal",
      "beta",
      "canary",
      "staged",
      "full",
    ]);
  });

  it("defaults the physical-device gate to BLOCKED_EXTERNAL with a reason", () => {
    const gates = createInitialStageGates();
    expect(gates.map((gate) => gate.stage)).toEqual([...RELEASE_STAGES]);
    for (const gate of gates) {
      if (EXTERNALLY_BLOCKED_STAGES.includes(gate.stage)) {
        expect(gate.state).toBe("BLOCKED_EXTERNAL");
        expect(gate.blockedReason).not.toBeNull();
      } else {
        expect(gate.state).toBe("NOT_RUN");
      }
    }
  });

  it("defaults the coach review gate to BLOCKED_EXTERNAL with a reason", () => {
    const gate = createInitialCoachReviewGate();
    expect(gate.state).toBe("BLOCKED_EXTERNAL");
    expect(gate.blockedReason).not.toBeNull();
    expect(gate.evidence).toBeNull();
  });
});

describe("validateReleaseRecord", () => {
  it("accepts a freshly generated manifest", () => {
    const verdict = validateReleaseRecord(completeRecord());
    expect(verdict.problems).toEqual([]);
    expect(verdict.valid).toBe(true);
  });

  it("rejects non-object input", () => {
    expect(validateReleaseRecord(null).valid).toBe(false);
    expect(validateReleaseRecord([]).valid).toBe(false);
    expect(validateReleaseRecord("manifest").valid).toBe(false);
  });

  it("rejects a manifest missing any required version dimension", () => {
    const requiredKeys = [
      "schemaVersion",
      "generatedAtIso",
      "commitSha",
      "mobileBuild",
      "backendRelease",
      "databaseSchema",
      "modelVersions",
      "techniqueAnalysisProfileVersions",
      "scoreVersion",
      "faultTaxonomyVersion",
      "drillLibraryVersion",
      "captureEnvelopeVersion",
      "featureFlags",
      "stageGates",
      "coachReviewGate",
    ] as const;
    for (const key of requiredKeys) {
      const incomplete: Record<string, unknown> = { ...completeRecord() };
      delete incomplete[key];
      const verdict = validateReleaseRecord(incomplete);
      expect(verdict.valid, `manifest without ${key} must be rejected`).toBe(false);
    }
  });

  it("rejects a short or malformed commit SHA", () => {
    const record = { ...completeRecord(), commitSha: "abc123" };
    const verdict = validateReleaseRecord(record);
    expect(verdict.valid).toBe(false);
    expect(verdict.problems.join("\n")).toContain("commitSha");
  });

  it("rejects an empty model version list", () => {
    const record = { ...completeRecord(), modelVersions: [] };
    expect(validateReleaseRecord(record).valid).toBe(false);
  });

  it("rejects duplicate model version entries", () => {
    const base = completeRecord();
    const first = base.modelVersions[0];
    expect(first).toBeDefined();
    const record = { ...base, modelVersions: [...base.modelVersions, { ...first! }] };
    const verdict = validateReleaseRecord(record);
    expect(verdict.valid).toBe(false);
    expect(verdict.problems.join("\n")).toContain("duplicate");
  });

  it("rejects an empty technique profile registry", () => {
    const record = { ...completeRecord(), techniqueAnalysisProfileVersions: {} };
    expect(validateReleaseRecord(record).valid).toBe(false);
  });

  it("rejects non-boolean feature flag values", () => {
    const record = { ...completeRecord(), featureFlags: { live_court: "yes" } };
    expect(validateReleaseRecord(record).valid).toBe(false);
  });

  it("rejects a missing or misordered stage gate", () => {
    const base = completeRecord();
    const missing = { ...base, stageGates: base.stageGates.slice(1) };
    expect(validateReleaseRecord(missing).valid).toBe(false);

    const reversed = { ...base, stageGates: [...base.stageGates].reverse() };
    expect(validateReleaseRecord(reversed).valid).toBe(false);
  });

  it("rejects a PASSED gate with no evidence", () => {
    const base = completeRecord();
    const gates = base.stageGates.map((gate) =>
      gate.stage === "dev" ? { ...gate, state: "PASSED" as const, evidence: null } : gate,
    );
    const verdict = validateReleaseRecord({ ...base, stageGates: gates });
    expect(verdict.valid).toBe(false);
    expect(verdict.problems.join("\n")).toContain("PASSED without evidence");
  });

  it("rejects a BLOCKED_EXTERNAL gate with no blockedReason", () => {
    const base = completeRecord();
    const gates = base.stageGates.map((gate) =>
      gate.stage === "physical-device" ? { ...gate, blockedReason: null } : gate,
    );
    expect(validateReleaseRecord({ ...base, stageGates: gates }).valid).toBe(false);
  });

  it("rejects a later stage PASSED while an earlier stage is unresolved", () => {
    const base = completeRecord();
    const gates = base.stageGates.map((gate) =>
      gate.stage === "full"
        ? { ...gate, state: "PASSED" as const, evidence: "ci://run/123" }
        : gate,
    );
    const verdict = validateReleaseRecord({ ...base, stageGates: gates });
    expect(verdict.valid).toBe(false);
    expect(verdict.problems.join("\n")).toContain("earlier stage is unresolved");
  });

  it("rejects a coach review gate claiming PASSED without evidence", () => {
    const base = completeRecord();
    const record = {
      ...base,
      coachReviewGate: { ...base.coachReviewGate, state: "PASSED" as const },
    };
    expect(validateReleaseRecord(record).valid).toBe(false);
  });
});

describe("generateReleaseRecord", () => {
  it("captures every version dimension from the current repo state", () => {
    const record = completeRecord();
    expect(record.commitSha).toBe("a".repeat(40));
    expect(record.mobileBuild.appVersion.length).toBeGreaterThan(0);
    expect(record.backendRelease.serviceName).toBe("supabase/functions/api");
    expect(record.databaseSchema.latestMigration).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    expect(record.databaseSchema.migrationCount).toBeGreaterThan(0);
    expect(record.modelVersions.length).toBeGreaterThan(0);
    expect(Object.keys(record.techniqueAnalysisProfileVersions).length).toBeGreaterThan(0);
    expect(record.scoreVersion).toBe("sm-v1");
    expect(record.faultTaxonomyVersion).toBe("fault-taxonomy-v0-draft");
    expect(record.drillLibraryVersion).toBe("drill-library-v0");
    expect(record.captureEnvelopeVersion.length).toBeGreaterThan(0);
    expect(Object.keys(record.featureFlags).length).toBeGreaterThan(0);
  });

  it("reads the real HEAD commit when no sha is injected", () => {
    const record = generateReleaseRecord({ repoRoot: REPO_ROOT });
    expect(record.commitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reports the shipping marketing version and build number, never the RN template version", () => {
    const record = generateReleaseRecord({ repoRoot: REPO_ROOT });
    const scheme = readVersionScheme();
    expect(record.mobileBuild.appVersion).not.toBe("0.0.1");
    expect(record.mobileBuild.appVersion).toBe(scheme.marketingVersion);
    expect(record.mobileBuild.buildNumber).toBe(String(scheme.buildNumber));
  });

  it("identifies the Supabase Edge Function as the backend release, pinned to the record's commit", () => {
    const record = generateReleaseRecord({ repoRoot: REPO_ROOT });
    expect(record.backendRelease.serviceName).toBe("supabase/functions/api");
    expect(record.backendRelease.version).toBe(record.commitSha);
  });
});
