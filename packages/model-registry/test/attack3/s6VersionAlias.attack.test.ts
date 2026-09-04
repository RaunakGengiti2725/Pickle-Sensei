import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_MANIFEST, ModelRegistry, type ModelManifestEntry } from "../../src/index.js";

/**
 * Adversarial pass 3 (tester #3) — S6: version alias validation via withEntry.
 *
 * Assigned checks:
 *   - `"  LATEST "` must be rejected (alias check trims + lower-cases).
 *   - `"Latest-1"` is intentionally allowed: it is a concrete, comparable
 *     version string, not an anonymous alias; documented in the test below.
 *
 * Extra attacks (whitespace / zero-width / homoglyph near-duplicates) probe
 * whether the immutability guarantee "id@version, once registered, is
 * immutable" can be bypassed by a version string that trims/normalises to an
 * existing one. Failing assertions there are BROKEN evidence.
 */

const base = (overrides: Partial<ModelManifestEntry>): ModelManifestEntry => ({
  id: "scorer.attack3",
  version: "sm-v1",
  task: "technique_scoring",
  runtime: "deterministic",
  executionTarget: "on_device",
  deploymentStatus: "production",
  supportedPlatforms: ["ios"],
  supportedStrokes: "all",
  inputSchemaVersion: 1,
  outputSchemaVersion: 1,
  artifactHash: null,
  artifactUri: null,
  trainingDatasetVersion: null,
  evaluationDatasetVersion: null,
  commit: null,
  splits: null,
  metrics: null,
  supportedCaptureEnvelope: null,
  calibrationVersion: null,
  runtimeRequirements: [],
  promotionDate: null,
  rollbackPredecessor: null,
  license: null,
  notes: "",
  ...overrides,
});

const empty = () => new ModelRegistry({ schemaVersion: 1, entries: [] });

describe("S6 — withEntry version alias handling", () => {
  it("rejects '  LATEST ' (whitespace + case variant of a forbidden alias)", () => {
    expect(() => empty().withEntry(base({ version: "  LATEST " }))).toThrow(
      /forbidden version alias/,
    );
  });

  it.each([
    ["\tlatest\n", "tab/newline padded"],
    ["  Current", "leading spaces, mixed case"],
    ["HEAD ", "trailing space"],
    ["   ", "whitespace-only (trims to empty)"],
    ["\u00a0latest\u00a0", "NBSP-padded (String.prototype.trim strips NBSP)"],
    ["\u3000newest\u3000", "ideographic-space padded (trim strips U+3000)"],
  ])("rejects %j (%s)", (version) => {
    expect(() => empty().withEntry(base({ version }))).toThrow(/forbidden version alias/);
  });

  it("documents: 'Latest-1' is intentionally ALLOWED — it is a concrete version, not an alias", () => {
    const registry = empty().withEntry(base({ version: "Latest-1" }));
    expect(registry.byId("scorer.attack3", "Latest-1")?.version).toBe("Latest-1");
    // It is also immutable like any other concrete version.
    expect(() => registry.withEntry(base({ version: "Latest-1" }))).toThrow(/already registered/);
  });

  it("documents: the forbidden list is exact-match after trim/lowercase, so alias-like prefixes/suffixes pass", () => {
    for (const version of ["latest-1", "latest.2", "current_3", "head~4", "newest+5", "v-latest"]) {
      expect(() => empty().withEntry(base({ version }))).not.toThrow();
    }
  });

  it("DEFAULT_MODEL_MANIFEST itself contains no alias-like versions (hygiene)", () => {
    const suspicious = DEFAULT_MODEL_MANIFEST.entries.filter((e) =>
      /^(latest|current|head|newest)$/i.test(e.version.trim()),
    );
    expect(suspicious).toEqual([]);
  });
});

describe("S6 extra — near-duplicate versions must not bypass immutability", () => {
  const registered = empty().withEntry(base({ version: "sm-v1" }));

  it.each([
    ["sm-v1 ", "trailing space"],
    [" sm-v1", "leading space"],
    ["sm-v1\u200b", "zero-width space suffix"],
    ["sm-v1\u00a0", "NBSP suffix"],
    ["SM-V1", "case variant"],
  ])(
    "withEntry(%j) (%s) must be rejected as a duplicate of sm-v1 or at least must not shadow it in resolve()",
    (version) => {
      let next: ModelRegistry | null = null;
      try {
        next = registered.withEntry(base({ version }));
      } catch (error) {
        // Rejected as duplicate/invalid — the strict outcome; nothing to shadow.
        expect(String(error)).toMatch(/already registered|forbidden|invalid|whitespace/i);
        return;
      }
      // Accepted: then it must not win production resolution over the
      // canonical entry, otherwise a visually identical version string
      // silently replaces the shipped scorer.
      const winner = next.resolve({ task: "technique_scoring", platform: "ios" });
      expect(
        winner?.version,
        `resolve() picked ${JSON.stringify(winner?.version)} over canonical "sm-v1"`,
      ).toBe("sm-v1");
    },
  );

  it("byId() is exact-match, so a padded clone is invisible to exact lookups while still registered", () => {
    let next: ModelRegistry;
    try {
      next = registered.withEntry(base({ version: "sm-v1 " }));
    } catch {
      return; // strict rejection — held.
    }
    // If registration succeeded, the registry now holds two entries whose
    // trimmed ids collide. Document the split-brain.
    expect(
      next
        .list("technique_scoring")
        .map((e) => e.version)
        .sort(),
    ).toEqual(["sm-v1", "sm-v1 "]);
    expect(next.byId("scorer.attack3", "sm-v1")?.version).toBe("sm-v1");
    expect(next.byId("scorer.attack3", "sm-v1 ")?.version).toBe("sm-v1 ");
    // The contract says id@version is unique after registration; the manifest
    // must not carry two entries whose trimmed key is identical.
    const trimmedKeys = new Set(next.list().map((e) => `${e.id}@${e.version.trim()}`));
    expect(trimmedKeys.size, "trimmed id@version keys collide").toBe(next.list().length);
  });
});
