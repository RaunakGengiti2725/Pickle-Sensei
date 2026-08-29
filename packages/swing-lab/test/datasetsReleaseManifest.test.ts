import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_MANIFEST,
  DatasetReleaseIndex,
  auditModelDatasetLineage,
  validateDatasetReleaseManifest,
  type DatasetReleaseManifest,
} from "@pickle/model-registry";

/**
 * The shipped pickle-sensei-datasets v1 release must stay internally
 * consistent: schema-valid, hash-sealed, frozen artifacts byte-verifiable,
 * NOT-GOLD marking honest, and usable as an exact model-registry pointer.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const RELEASE = join(ROOT, "datasets/releases/pickle-sensei-datasets-v1");

const manifest = JSON.parse(
  readFileSync(join(RELEASE, "manifest.json"), "utf8"),
) as DatasetReleaseManifest;

describe("pickle-sensei-datasets v1 release", () => {
  it("is hash-sealed and schema-valid with zero recorded problems", () => {
    const body = readFileSync(join(RELEASE, "manifest.json"), "utf8");
    const sealed = readFileSync(join(RELEASE, "manifest.sha256"), "utf8").trim();
    expect(createHash("sha256").update(body).digest("hex")).toBe(sealed);
    expect(validateDatasetReleaseManifest(manifest)).toEqual([]);
    expect(manifest.problems).toEqual([]);
    expect(manifest.releaseId).toBe("pickle-sensei-datasets@v1");
  });

  it("frozen artifacts exist inside the release directory and hash-match exactly", () => {
    let checked = 0;
    for (const component of manifest.components) {
      for (const artifact of component.artifacts) {
        expect(artifact.path).toContain("releases/pickle-sensei-datasets-v1/artifacts/");
        const frozen = join(ROOT, artifact.path);
        expect(existsSync(frozen)).toBe(true);
        expect(createHash("sha256").update(readFileSync(frozen)).digest("hex")).toBe(
          artifact.sha256,
        );
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(10);
  });

  it("describes every datasets/ directory exactly once at the top level", () => {
    const onDisk = new Set(
      readdirSync(join(ROOT, "datasets"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    );
    const covered = new Set(manifest.components.map((component) => component.path.split("/")[1]!));
    expect([...onDisk].filter((dir) => !covered.has(dir))).toEqual([]);
    expect([...covered].filter((dir) => !onDisk.has(dir))).toEqual([]);
  });

  it("marks machine-generated / synthetic components NOT-GOLD with reasons", () => {
    for (const id of [
      "cascade",
      "completion-bench",
      "corpus-mined-events",
      "experiments",
      "mining",
    ]) {
      const component = manifest.components.find((entry) => entry.componentId === id);
      expect(component, id).toBeDefined();
      expect(component!.notGold, id).toBe(true);
      expect((component!.notGoldReason ?? "").length, id).toBeGreaterThan(0);
    }
  });

  it("stays honest about missing external evidence: no coaches, no silver, no consent records", () => {
    expect(manifest.statistics.expertCoaches).toBe(0);
    expect(manifest.statistics.annotators).toBe(1);
    expect(manifest.labels.SILVER.count).toBe(0);
    expect(manifest.consent.analysisConsentRecords).toBe(0);
    expect(manifest.consent.trainingConsentRecords).toBe(0);
    expect(manifest.knownLimitations.length).toBeGreaterThanOrEqual(4);
  });

  it("keeps tier-C candidates out of the GOLD count", () => {
    expect(manifest.labels.TIER_C.count).toBe(manifest.statistics.tierCCandidateEvents);
    expect(manifest.labels.GOLD.count).toBe(
      Object.values(manifest.statistics.goldLabelCounts).reduce((total, count) => total + count, 0),
    );
  });

  it("resolves as an exact dataset pointer for the model registry, alongside legacy releases", () => {
    const index = new DatasetReleaseIndex([manifest]);
    for (const legacy of readdirSync(join(ROOT, "datasets/releases"), { withFileTypes: true })) {
      if (legacy.isDirectory() && !legacy.name.startsWith("pickle-sensei-datasets")) {
        index.registerLegacy(legacy.name);
      }
    }
    expect(index.byVersion("pickle-sensei-datasets@v1")?.version).toBe("v1");
    expect(index.has("pickle-real-v0.3")).toBe(true);
    expect(auditModelDatasetLineage(DEFAULT_MODEL_MANIFEST, index)).toEqual([]);
  });
});
