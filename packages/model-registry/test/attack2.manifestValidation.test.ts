import { describe, expect, it } from "vitest";
import { ModelRegistry, type ModelManifestEntry } from "../src/index.js";

/**
 * Adversarial pass #2, scenario S5 (attack branch devin/attack-pkg-swing-lab-2):
 * ModelRegistry.fromJson is the ONLY untyped entry point into the registry —
 * whatever JSON it is handed is cast to ModelManifest and validateManifest
 * assumes every field is present. Each test feeds a manifest that violates
 * the type and pins what happens on 4d812e1a.
 *
 * MEASURED: structurally incomplete entries surface as TypeError (property
 * access on undefined) or are accepted silently, never as a validation
 * Error naming the entry — BROKEN(P3). Alias/status/duplicate/lineage rules
 * that ARE implemented HELD, including under unicode and huge inputs.
 *
 * BROKEN cases pin the measured behaviour (repo "KNOWN OPEN GAP" convention)
 * so a fix must flip them deliberately.
 */

const entry = (overrides: Partial<ModelManifestEntry> = {}): ModelManifestEntry => ({
  id: "scorer.sm-v1",
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

const manifestJson = (entries: unknown[], schemaVersion: unknown = 1): string =>
  JSON.stringify({ schemaVersion, entries });

const without = (base: ModelManifestEntry, key: keyof ModelManifestEntry): unknown => {
  const copy: Record<string, unknown> = { ...base };
  delete copy[key];
  return copy;
};

/** Distinguishes a deliberate validation Error from an incidental TypeError. */
const failureShape = (fn: () => unknown): "validation-error" | "TypeError" | "accepted" => {
  try {
    fn();
    return "accepted";
  } catch (error) {
    if (error instanceof TypeError) return "TypeError";
    if (error instanceof Error) return "validation-error";
    throw error;
  }
};

describe("attack2 S5: fromJson with an entry missing supportedPlatforms", () => {
  it("BROKEN(P3): throws TypeError (`.length` of undefined), not a validation Error naming the entry", () => {
    const json = manifestJson([
      entry(),
      without(entry({ id: "x", version: "1" }), "supportedPlatforms"),
    ]);
    expect(failureShape(() => ModelRegistry.fromJson(json))).toBe("TypeError");
    expect(() => ModelRegistry.fromJson(json)).toThrow(/Cannot read properties of undefined/);
    // The message does not identify which entry is broken.
    expect(() => ModelRegistry.fromJson(json)).not.toThrow(/x@1/);
  });

  it("BROKEN(P3): supportedPlatforms: null is also a TypeError, and a NON-array string is accepted", () => {
    const nullJson = manifestJson([{ ...entry(), supportedPlatforms: null }]);
    expect(failureShape(() => ModelRegistry.fromJson(nullJson))).toBe("TypeError");
    // "ios" has .length === 3 and String.prototype.includes → resolves!
    const stringJson = manifestJson([{ ...entry(), supportedPlatforms: "ios" }]);
    expect(failureShape(() => ModelRegistry.fromJson(stringJson))).toBe("accepted");
    const registry = ModelRegistry.fromJson(stringJson);
    expect(registry.resolve({ task: "technique_scoring", platform: "ios" })?.id).toBe(
      "scorer.sm-v1",
    );
    // …and a platform NOT in the enum is matched by substring.
    expect(
      ModelRegistry.fromJson(
        manifestJson([{ ...entry(), supportedPlatforms: "ios,android" }]),
      ).resolve({ task: "technique_scoring", platform: "android" })?.id,
    ).toBe("scorer.sm-v1");
  });

  it("BROKEN(P3): unknown platform strings inside supportedPlatforms are accepted", () => {
    const json = manifestJson([{ ...entry(), supportedPlatforms: ["visionos"] }]);
    expect(failureShape(() => ModelRegistry.fromJson(json))).toBe("accepted");
  });
});

describe("attack2 S5 extras: other omitted / malformed fields via fromJson", () => {
  it("BROKEN(P3): missing `version` → TypeError (trim of undefined); missing `entries` → TypeError (not iterable)", () => {
    expect(
      failureShape(() => ModelRegistry.fromJson(manifestJson([without(entry(), "version")]))),
    ).toBe("TypeError");
    expect(failureShape(() => ModelRegistry.fromJson(JSON.stringify({ schemaVersion: 1 })))).toBe(
      "TypeError",
    );
    expect(
      failureShape(() =>
        ModelRegistry.fromJson(JSON.stringify({ schemaVersion: 1, entries: null })),
      ),
    ).toBe("TypeError");
  });

  it("BROKEN(P3): missing id / task / runtime / executionTarget / supportedStrokes / schema versions / notes are ACCEPTED", () => {
    for (const key of [
      "id",
      "task",
      "runtime",
      "executionTarget",
      "supportedStrokes",
      "inputSchemaVersion",
      "outputSchemaVersion",
      "runtimeRequirements",
      "notes",
      "license",
    ] as const) {
      expect(
        failureShape(() => ModelRegistry.fromJson(manifestJson([without(entry(), key)]))),
      ).toBe("accepted");
    }
  });

  it("BROKEN(P3): missing artifactUri/artifactHash/splits/metrics/rollbackPredecessor (undefined !== null) are ACCEPTED — the lineage rules only fire on explicit null", () => {
    // artifactUri present, artifactHash OMITTED: `undefined === null` is false
    // so "URI without hash" is not caught.
    const noHash = without(entry({ artifactUri: "https://example.invalid/m.bin" }), "artifactHash");
    expect(failureShape(() => ModelRegistry.fromJson(manifestJson([noHash])))).toBe("accepted");
    const noTraining = without(
      entry({ splits: { train: "a", validation: "b", test: "c" } }),
      "trainingDatasetVersion",
    );
    expect(failureShape(() => ModelRegistry.fromJson(manifestJson([noTraining])))).toBe("accepted");
    const noEval = without(entry({ metrics: { f1: 0.5 } }), "evaluationDatasetVersion");
    expect(failureShape(() => ModelRegistry.fromJson(manifestJson([noEval])))).toBe("accepted");
  });

  it("BROKEN(P3): a top-level array / scalar / null manifest is a TypeError or accepted, never a validation Error", () => {
    expect(failureShape(() => ModelRegistry.fromJson("null"))).toBe("TypeError");
    expect(failureShape(() => ModelRegistry.fromJson("[]"))).toBe("validation-error"); // schemaVersion undefined !== 1 → Error
    expect(failureShape(() => ModelRegistry.fromJson('{"schemaVersion":1,"entries":{}}'))).toBe(
      "TypeError",
    );
  });

  it("HELD: rules that ARE implemented fire with a named Error", () => {
    expect(() => ModelRegistry.fromJson(manifestJson([entry(), entry()]))).toThrow(
      /Duplicate model manifest entry: scorer\.sm-v1@sm-v1/,
    );
    for (const alias of ["latest", "  LATEST ", "current", "head", "newest", "", "   "]) {
      expect(() => ModelRegistry.fromJson(manifestJson([entry({ version: alias })]))).toThrow(
        /forbidden version alias/,
      );
    }
    expect(() =>
      ModelRegistry.fromJson(manifestJson([{ ...entry(), deploymentStatus: "prod" }])),
    ).toThrow(/Unknown deployment status/);
    expect(() => ModelRegistry.fromJson(manifestJson([entry({ supportedPlatforms: [] })]))).toThrow(
      /supports no platforms/,
    );
    expect(() =>
      ModelRegistry.fromJson(manifestJson([entry({ rollbackPredecessor: "ghost@1" })])),
    ).toThrow(/not registered/);
    expect(() =>
      ModelRegistry.fromJson(manifestJson([entry({ rollbackPredecessor: "scorer.sm-v1@sm-v1" })])),
    ).toThrow(/own rollback predecessor/);
    expect(() => ModelRegistry.fromJson(manifestJson([entry()], 2))).toThrow(
      /Unsupported model manifest schema version: 2/,
    );
    expect(() => ModelRegistry.fromJson(manifestJson([entry()], "1"))).toThrow(
      /Unsupported model manifest schema version/,
    );
  });

  it("HELD: malformed JSON surfaces as SyntaxError (not swallowed)", () => {
    expect(() => ModelRegistry.fromJson("{")).toThrow(SyntaxError);
    expect(() => ModelRegistry.fromJson("")).toThrow(SyntaxError);
    expect(() => ModelRegistry.fromJson("\uFEFF{}")).toThrow(SyntaxError);
  });

  it("HELD: unicode ids/versions round-trip; visually identical but different-normalisation ids are DIFFERENT entries", () => {
    const nfc = "scorer.é";
    const nfd = "scorer.e\u0301";
    const registry = ModelRegistry.fromJson(
      manifestJson([entry({ id: nfc, version: "v1" }), entry({ id: nfd, version: "v1" })]),
    );
    expect(registry.byId(nfc, "v1")).not.toBeNull();
    expect(registry.byId(nfd, "v1")).not.toBeNull();
    expect(registry.byId(nfc, "v1")).not.toBe(registry.byId(nfd, "v1"));
    // Exact duplicate through unicode is still caught.
    expect(() =>
      ModelRegistry.fromJson(
        manifestJson([entry({ id: "🏓", version: "v1" }), entry({ id: "🏓", version: "v1" })]),
      ),
    ).toThrow(/Duplicate/);
  });

  it("HELD: a 20k-entry manifest validates and resolves in bounded time; numeric version ordering survives", () => {
    const entries: ModelManifestEntry[] = [];
    for (let index = 0; index < 20_000; index += 1) {
      entries.push(
        entry({ id: `m${index % 100}`, version: `v${Math.floor(index / 100)}.${index}` }),
      );
    }
    const started = Date.now();
    const registry = ModelRegistry.fromJson(manifestJson(entries));
    const resolved = registry.resolve({ task: "technique_scoring", platform: "ios" });
    expect(resolved).not.toBeNull();
    // highest numeric version wins (v199.19999 beats v9.x lexically-larger)
    expect(resolved!.version).toBe("v199.19999");
    expect(Date.now() - started).toBeLessThan(5000);
    expect(registry.list()).toHaveLength(20_000);
  });

  it("HELD: withEntry stays append-only under a forged duplicate carrying different content", () => {
    const registry = ModelRegistry.fromJson(manifestJson([entry()]));
    expect(() => registry.withEntry(entry({ notes: "overwrite attempt" }))).toThrow(/immutable/);
    // fromJson-created registry copies entries: mutating the source array later has no effect
    const source = [entry({ id: "a", version: "1" })];
    const fromArray = new ModelRegistry({ schemaVersion: 1, entries: source });
    source.push(entry({ id: "b", version: "1" }));
    expect(fromArray.list()).toHaveLength(1);
  });
});
