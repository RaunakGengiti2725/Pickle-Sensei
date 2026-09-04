/**
 * ADJ-04 adversarial: attacks on 3dd83f33 that HELD (all tests pass on the
 * candidate). Kept as regression pins + as the evidence trail for the review:
 * ordering permutations, fromJson variants, longer rollback cycles, mutation
 * after construction through every exposed surface, alias case variants,
 * concurrent construction, boundary sizes, and the shipped manifest.
 *
 * Failing attacks live in adj04.invisibleUnicode.attack.test.ts,
 * adj04.validationIntegrity.attack.test.ts and
 * apps/mobile/__tests__/attackAdj04AutoDetectAmbiguity.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_MANIFEST,
  ModelRegistry,
  ModelRegistryValidationError,
  type ModelManifest,
  type ModelManifestEntry,
} from "../../src/index.js";
import { scorerEntry, thrownBy } from "./fixture.js";

const HASH = "a".repeat(64);

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

describe("ADJ-04 held: acceptance criteria under variation", () => {
  it("fromJson rejects every non-array `entries` shape with a non-TypeError mentioning entries", () => {
    for (const text of [
      '{"schemaVersion":1,"entries":null}',
      '{"schemaVersion":1,"entries":{}}',
      '{"schemaVersion":1,"entries":"[]"}',
      '{"schemaVersion":1,"entries":1}',
      '{"schemaVersion":1,"entries":true}',
      '{"schemaVersion":1}',
      '{"schemaVersion":1,"entries":{"length":1,"0":{}}}',
      "[]",
      "null",
      '"entries"',
      "\ufeff{}",
    ]) {
      const error = thrownBy(() => ModelRegistry.fromJson(text));
      expect(error, text).toBeInstanceOf(ModelRegistryValidationError);
      expect(error, text).not.toBeInstanceOf(TypeError);
      expect((error as Error).message, text).toMatch(/entries|manifest/);
    }
  });

  it("constructor rejects non-object manifests without a TypeError", () => {
    for (const manifest of [null, undefined, 1, "x", [], () => undefined, new Map()]) {
      const error = thrownBy(() => new ModelRegistry(manifest as unknown as ModelManifest));
      expect(error).toBeInstanceOf(ModelRegistryValidationError);
      expect(error).not.toBeInstanceOf(TypeError);
    }
  });

  it("hash shape: every non-64-lowercase-hex form is rejected regardless of URI presence", () => {
    const bad = [
      "not-a-hash",
      "",
      "a".repeat(65),
      "a".repeat(63),
      "A".repeat(64),
      `${"a".repeat(63)}g`,
      `${"a".repeat(64)}\n`,
      ` ${"a".repeat(64)}`,
      `sha256:${"a".repeat(64)}`,
      "a".repeat(64).replace("a", "\u0430"), // Cyrillic а
    ];
    for (const hash of bad) {
      for (const uri of ["https://cdn/x.mlmodelc", null]) {
        const error = thrownBy(
          () =>
            new ModelRegistry({
              schemaVersion: 1,
              entries: [scorerEntry({ artifactHash: hash, artifactUri: uri })],
            }),
        );
        expect(error, JSON.stringify({ hash, uri })).toBeInstanceOf(ModelRegistryValidationError);
        expect((error as Error).message).toMatch(/artifactHash/);
      }
    }
    expect(
      thrownBy(
        () =>
          new ModelRegistry({
            schemaVersion: 1,
            entries: [scorerEntry({ artifactHash: HASH, artifactUri: "https://cdn/x" })],
          }),
      ),
    ).toBeNull();
  });

  it("ambiguous production is caught at construction in every entry ordering", () => {
    const a = scorerEntry({ id: "scorer.a", version: "1" });
    const b = scorerEntry({ id: "scorer.b", version: "2" });
    const c = scorerEntry({ id: "scorer.c", version: "3", supportedStrokes: ["dink"] });
    for (const order of permutations([a, b, c])) {
      const error = thrownBy(() => new ModelRegistry({ schemaVersion: 1, entries: order }));
      expect(error).toBeInstanceOf(ModelRegistryValidationError);
      expect((error as Error).message).toMatch(/Ambiguous production/);
    }
  });

  it("ambiguity is detected across partial stroke overlap and per-platform, and not across disjoint sets", () => {
    const build = (entries: ModelManifestEntry[]) =>
      thrownBy(() => new ModelRegistry({ schemaVersion: 1, entries }));
    expect(
      build([
        scorerEntry({ id: "a", supportedStrokes: ["dink", "volley"] }),
        scorerEntry({ id: "b", supportedStrokes: ["volley", "serve"] }),
      ]),
    ).toBeInstanceOf(ModelRegistryValidationError);
    expect(
      build([
        scorerEntry({ id: "a", supportedPlatforms: ["ios", "android"] }),
        scorerEntry({ id: "b", supportedPlatforms: ["android"] }),
      ]),
    ).toBeInstanceOf(ModelRegistryValidationError);
    expect(
      build([
        scorerEntry({ id: "a", supportedStrokes: ["dink"] }),
        scorerEntry({ id: "b", supportedStrokes: ["serve"] }),
      ]),
    ).toBeNull();
    expect(
      build([
        scorerEntry({ id: "a", supportedPlatforms: ["ios"] }),
        scorerEntry({ id: "b", supportedPlatforms: ["android"] }),
      ]),
    ).toBeNull();
  });

  it("rollback cycles of length 1..6 throw at construction in every ordering (n<=4)", () => {
    for (const n of [1, 2, 3, 4, 5, 6]) {
      const ring = Array.from({ length: n }, (_, i) =>
        scorerEntry({
          id: `scorer.r${i}`,
          version: `v${i}`,
          deploymentStatus: i === 0 ? "production" : "deprecated",
          rollbackPredecessor: `scorer.r${(i + 1) % n}@v${(i + 1) % n}`,
        }),
      );
      const orders = n <= 4 ? permutations(ring) : [ring, [...ring].reverse()];
      for (const order of orders) {
        const error = thrownBy(() => new ModelRegistry({ schemaVersion: 1, entries: order }));
        expect(error, `n=${n}`).toBeInstanceOf(ModelRegistryValidationError);
        expect((error as Error).message).toMatch(/cycle|itself/);
      }
    }
  });

  it("a cycle reachable only through a tail (lollipop graph) is still rejected", () => {
    const entries = [
      scorerEntry({
        id: "s.tail",
        version: "t",
        rollbackPredecessor: "s.a@1",
        deploymentStatus: "production",
      }),
      scorerEntry({
        id: "s.a",
        version: "1",
        rollbackPredecessor: "s.b@1",
        deploymentStatus: "deprecated",
      }),
      scorerEntry({
        id: "s.b",
        version: "1",
        rollbackPredecessor: "s.a@1",
        deploymentStatus: "deprecated",
      }),
    ];
    expect(thrownBy(() => new ModelRegistry({ schemaVersion: 1, entries }))).toBeInstanceOf(
      ModelRegistryValidationError,
    );
  });

  it("dangling / self / wrong-case rollback predecessors are rejected", () => {
    for (const pred of [
      "scorer.sm-v1@sm-v0",
      "scorer.sm-v1@sm-v1",
      "Scorer.sm-v1@sm-v1",
      "scorer.sm-v1",
    ]) {
      const error = thrownBy(
        () =>
          new ModelRegistry({
            schemaVersion: 1,
            entries: [scorerEntry({ rollbackPredecessor: pred })],
          }),
      );
      expect(error, pred).toBeInstanceOf(ModelRegistryValidationError);
    }
  });
});

describe("ADJ-04 held: mutation resistance through every surface", () => {
  const manifest = (): ModelManifest => ({
    schemaVersion: 1,
    entries: [
      scorerEntry({
        id: "scorer.a",
        version: "1",
        supportedStrokes: ["dink"],
        metrics: { f1: 0.9 },
        evaluationDatasetVersion: "eval-1",
      }),
      scorerEntry({ id: "scorer.b", version: "2", supportedStrokes: ["serve"] }),
    ],
  });

  it("mutating the input manifest (array, entry, nested array/object) after construction changes nothing", () => {
    const input = manifest();
    const registry = new ModelRegistry(input);
    input.entries.length = 0;
    (input.entries as ModelManifestEntry[]).push(scorerEntry({ id: "scorer.z", version: "9" }));
    const [a] = manifest().entries;
    (a as { deploymentStatus: string }).deploymentStatus = "retired";
    expect(registry.list().map((e) => e.id)).toEqual(["scorer.a", "scorer.b"]);
    expect(
      registry.resolve({ task: "technique_scoring", platform: "ios", stroke: "dink" })?.id,
    ).toBe("scorer.a");
  });

  it("entries returned by list()/resolve()/withEntry() are deeply frozen, including nested arrays/objects", () => {
    const registry = new ModelRegistry(manifest());
    const listed = registry.list();
    const resolved = registry.resolve({
      task: "technique_scoring",
      platform: "ios",
      stroke: "dink",
    })!;
    const grown = new ModelRegistry(manifest()).withEntry(
      scorerEntry({ id: "scorer.c", version: "3", supportedStrokes: ["volley"] }),
    );
    for (const entry of [...listed, resolved, ...grown.list()]) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.supportedPlatforms)).toBe(true);
      expect(Object.isFrozen(entry.supportedStrokes)).toBe(true);
      expect(Object.isFrozen(entry.runtimeRequirements)).toBe(true);
      if (entry.metrics) expect(Object.isFrozen(entry.metrics)).toBe(true);
    }
    expect(() => {
      "use strict";
      (resolved as { version: string }).version = "latest";
    }).toThrow(TypeError);
    expect(() => {
      "use strict";
      (resolved.supportedPlatforms as string[]).push("android");
    }).toThrow(TypeError);
    expect(
      registry.resolve({ task: "technique_scoring", platform: "android", stroke: "dink" }),
    ).toBeNull();
  });

  it("the array returned by list() is a fresh copy each call", () => {
    const registry = new ModelRegistry(manifest());
    const first = registry.list() as ModelManifestEntry[];
    first.length = 0;
    expect(registry.list()).toHaveLength(2);
  });

  it("withEntry() returns a new registry and leaves the original intact", () => {
    const base = new ModelRegistry(manifest());
    const grown = base.withEntry(
      scorerEntry({ id: "scorer.c", version: "3", supportedStrokes: ["volley"] }),
    );
    expect(base.list()).toHaveLength(2);
    expect(grown.list()).toHaveLength(3);
    // Duplicate key through withEntry() is the pre-fix plain Error (code
    // unchanged since 4d812e1a) — pinned, not judged.
    expect(
      thrownBy(() => base.withEntry(scorerEntry({ id: "scorer.a", version: "1" }))),
    ).toBeInstanceOf(Error);
    expect(
      thrownBy(() =>
        base.withEntry(scorerEntry({ id: "scorer.d", version: "4", supportedStrokes: ["dink"] })),
      ),
    ).toBeInstanceOf(ModelRegistryValidationError);
  });
});

describe("ADJ-04 held: aliases, strokes, boundaries, concurrency", () => {
  it("forbidden version aliases are rejected in every case/whitespace variant", () => {
    for (const alias of [
      "latest",
      "LATEST",
      "Latest",
      " latest",
      "latest ",
      "\tlatest\n",
      "current",
      "HEAD",
      "Stable",
      "main",
      "master",
      "nightly",
      "dev",
      "snapshot",
      "",
    ]) {
      const error = thrownBy(
        () => new ModelRegistry({ schemaVersion: 1, entries: [scorerEntry({ version: alias })] }),
      );
      expect(error, JSON.stringify(alias)).toBeInstanceOf(ModelRegistryValidationError);
      expect((error as Error).message).toMatch(/version/);
    }
  });

  it("empty / non-array / duplicate / unknown supportedStrokes are rejected", () => {
    for (const strokes of [[], "none", "ALL", ["dink", "dink"], ["smash"], null, undefined, {}]) {
      const error = thrownBy(
        () =>
          new ModelRegistry({
            schemaVersion: 1,
            entries: [scorerEntry({ supportedStrokes: strokes as unknown as "all" })],
          }),
      );
      expect(error, JSON.stringify(strokes)).toBeInstanceOf(ModelRegistryValidationError);
      expect((error as Error).message).toMatch(/supportedStrokes/);
    }
  });

  it("case-folded near-duplicate keys are rejected in both orders", () => {
    for (const [x, y] of [
      ["scorer.A", "scorer.a"],
      ["scorer.a", "scorer.A"],
    ] as const) {
      const error = thrownBy(
        () =>
          new ModelRegistry({
            schemaVersion: 1,
            entries: [
              scorerEntry({ id: x, deploymentStatus: "production" }),
              scorerEntry({ id: y, deploymentStatus: "deprecated" }),
            ],
          }),
      );
      expect(error).toBeInstanceOf(ModelRegistryValidationError);
    }
  });

  it("a 500-entry manifest with a full production overlap is rejected deterministically", () => {
    const entries = Array.from({ length: 500 }, (_, i) =>
      scorerEntry({ id: `scorer.n${i}`, version: `v${i}`, supportedStrokes: ["dink"] }),
    );
    const error = thrownBy(() => new ModelRegistry({ schemaVersion: 1, entries }));
    expect(error).toBeInstanceOf(ModelRegistryValidationError);
    expect((error as ModelRegistryValidationError).problems.length).toBeGreaterThan(0);
    const again = thrownBy(() => new ModelRegistry({ schemaVersion: 1, entries }));
    expect((again as Error).message).toBe((error as Error).message);
  });

  it("a 5,000-entry clean manifest (disjoint versions, one production) constructs and resolves", () => {
    const entries = Array.from({ length: 5000 }, (_, i) =>
      scorerEntry({
        id: "scorer.long",
        version: `v${i}`,
        deploymentStatus: i === 4999 ? "production" : "deprecated",
        rollbackPredecessor: i === 0 ? null : `scorer.long@v${i - 1}`,
      }),
    );
    const registry = new ModelRegistry({ schemaVersion: 1, entries });
    expect(registry.resolve({ task: "technique_scoring", platform: "ios" })?.version).toBe("v4999");
    expect(
      registry.resolve({ task: "technique_scoring", platform: "ios", status: "deprecated" })
        ?.version,
    ).toBe("v4998");
  });

  it("concurrent construction from a shared manifest object is independent", async () => {
    const shared = { schemaVersion: 1 as const, entries: [scorerEntry({})] };
    const registries = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        Promise.resolve().then(() => {
          if (i === 25) shared.entries.push(scorerEntry({ id: "scorer.late", version: "9" }));
          return thrownBy(() => new ModelRegistry(shared));
        }),
      ),
    );
    // Before the push: clean. After: ambiguous production => throws. Never a
    // silently half-built registry.
    for (const r of registries) {
      expect(r === null || r instanceof ModelRegistryValidationError).toBe(true);
    }
  });

  it("non-production resolution is deterministic newest-first and does not depend on input order", () => {
    const entries = [
      scorerEntry({ id: "scorer.d", version: "1.2.0", deploymentStatus: "deprecated" }),
      scorerEntry({ id: "scorer.d", version: "1.10.0", deploymentStatus: "deprecated" }),
      scorerEntry({ id: "scorer.d", version: "1.9.0", deploymentStatus: "deprecated" }),
    ];
    for (const order of permutations(entries)) {
      const registry = new ModelRegistry({ schemaVersion: 1, entries: order });
      expect(
        registry.resolve({ task: "technique_scoring", platform: "ios", status: "deprecated" })
          ?.version,
      ).toBe("1.10.0");
    }
  });

  it("stroke-qualified queries over stroke-partitioned production scorers resolve the right one", () => {
    const registry = new ModelRegistry({
      schemaVersion: 1,
      entries: [
        scorerEntry({ id: "a", supportedStrokes: ["dink"] }),
        scorerEntry({ id: "b", supportedStrokes: ["serve"] }),
      ],
    });
    // The stroke-LESS query over this same registry is the subject of
    // adj04.validationIntegrity.attack.test.ts (it throws on 3dd83f33).
    expect(
      registry.resolve({ task: "technique_scoring", platform: "ios", stroke: "dink" })?.id,
    ).toBe("a");
    expect(
      registry.resolve({ task: "technique_scoring", platform: "ios", stroke: "serve" })?.id,
    ).toBe("b");
    expect(
      registry.resolve({ task: "technique_scoring", platform: "ios", stroke: "volley" }),
    ).toBeNull();
  });

  it("the shipped DEFAULT_MODEL_MANIFEST still validates and resolves every task the mobile app asks for", () => {
    const registry = new ModelRegistry(DEFAULT_MODEL_MANIFEST);
    for (const task of [
      "phase_segmentation",
      "biomechanics_extraction",
      "technique_scoring",
      "fault_detection",
      "uncertainty_estimation",
      "coaching_ranking",
      "stroke_classification",
    ] as const) {
      expect(registry.resolve({ task, platform: "ios" }), task).not.toBeNull();
    }
    expect(ModelRegistry.fromJson(JSON.stringify(DEFAULT_MODEL_MANIFEST)).list()).toEqual(
      registry.list(),
    );
  });
});
