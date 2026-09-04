import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DatasetReleaseIndex,
  ModelRegistry,
  SubsystemReleaseState,
  auditModelDatasetLineage,
  validateDatasetReleaseManifest,
  type DatasetReleaseManifest,
  type ModelManifest,
  type ModelManifestEntry,
} from "../../src/index.js";
import {
  SURFACES,
  datasetFixture,
  fixturesAreValid,
  lineageEntryFixture,
  minimize,
  modelFixture,
  replay,
  runCampaign,
  runIteration,
  stability,
  type IterationRecord,
  type Outcome,
  type Surface,
} from "./campaign.js";

/**
 * Boundary / malformed-input stress campaign (lens `boundary-malformed`).
 *
 * Default is a fast smoke (STRESS_ITER=300, < 1 s). The full campaign that
 * produced the recorded evidence:
 *
 *   STRESS_ITER=3200 STRESS_SEED=20260904 STRESS_OUT=/tmp/stress \
 *     pnpm --filter @pickle/model-registry test -- stress
 *
 * Replay one iteration: `runIteration(STRESS_SEED, index)` (campaign.ts).
 * Every failing record is minimized to its shortest mutation prefix and
 * re-run 10× to separate deterministic failures from flakes.
 *
 * Two kinds of test live here:
 *  - HELD invariants: campaign-wide properties that hold today and must keep
 *    holding (determinism, no prototype pollution, no writes on rejection,
 *    read paths total, no unknown failure class).
 *  - OPEN findings: `it.fails` pins of reproduced, minimized failures. They
 *    document the current behaviour; when the production code is fixed the
 *    pin starts passing, vitest reports it, and the `.fails` is removed.
 */
const ITER = Number(process.env.STRESS_ITER ?? "300");
const SEED = Number(process.env.STRESS_SEED ?? "20260904");
const OUT_DIR = process.env.STRESS_OUT;
const STABILITY_RUNS = 10;

const { records, summary } = runCampaign(SEED, ITER);

const minimized = summary.failing.map((record) => minimize(SEED, record));
const stabilityByIndex = new Map(
  summary.failing.map((record) => {
    const s = stability(SEED, record.index, STABILITY_RUNS);
    return [record.index, { ...s, details: [...s.details] }] as const;
  }),
);

if (OUT_DIR !== undefined) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, "results.json"), JSON.stringify(records));
  writeFileSync(
    resolve(OUT_DIR, "summary.json"),
    JSON.stringify(
      {
        ...summary,
        failing: undefined,
        failingCount: summary.failing.length,
        stabilityRuns: STABILITY_RUNS,
        flakyCount: [...stabilityByIndex.values()].filter((s) => s.matches !== s.times).length,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    resolve(OUT_DIR, "failing.json"),
    JSON.stringify(
      summary.failing.map((record) => ({
        original: record,
        minimized: minimized.find((m) => m.index === record.index),
        stability: stabilityByIndex.get(record.index),
      })),
      null,
      2,
    ),
  );
}

const by = (surface: Surface): IterationRecord[] => records.filter((r) => r.surface === surface);
const outcomes = (rs: IterationRecord[], outcome: Outcome): IterationRecord[] =>
  rs.filter((r) => r.outcome === outcome);
const show = (rs: IterationRecord[]): string =>
  rs
    .slice(0, 5)
    .map((r) => `#${r.index} seed=${r.seed} ${r.surface} [${r.mutationSummary}] → ${r.detail}`)
    .join("\n");

/**
 * The failure classes reproduced and reported by the campaign (see the OPEN
 * findings below). Anything outside this table is a NEW failure class and
 * fails the suite.
 */
const KNOWN_OPEN: ReadonlyArray<{ surface: Surface; outcome: Outcome; detailPrefix: string }> = [
  { surface: "dataset_validate", outcome: "unexpected_throw", detailPrefix: "TypeError" },
  { surface: "dataset_json", outcome: "unexpected_throw", detailPrefix: "TypeError" },
  { surface: "dataset_index", outcome: "untyped_throw", detailPrefix: "TypeError" },
  { surface: "dataset_validate", outcome: "accepted_malformed", detailPrefix: "" },
  { surface: "dataset_json", outcome: "accepted_malformed", detailPrefix: "" },
  { surface: "dataset_index", outcome: "accepted_malformed", detailPrefix: "" },
  { surface: "registry_object", outcome: "untyped_throw", detailPrefix: "TypeError" },
  { surface: "registry_json", outcome: "untyped_throw", detailPrefix: "TypeError" },
  { surface: "registry_with_entry", outcome: "untyped_throw", detailPrefix: "TypeError" },
  { surface: "lineage_audit", outcome: "unexpected_throw", detailPrefix: "TypeError" },
  { surface: "registry_object", outcome: "accepted_malformed", detailPrefix: "" },
  { surface: "registry_json", outcome: "accepted_malformed", detailPrefix: "" },
  { surface: "registry_with_entry", outcome: "accepted_malformed", detailPrefix: "" },
  { surface: "rollback_activate", outcome: "state_write", detailPrefix: "apply() rejected" },
  {
    surface: "rollback_activate",
    outcome: "accepted_malformed",
    detailPrefix: "non-string version",
  },
];

const isKnownOpen = (r: IterationRecord): boolean =>
  KNOWN_OPEN.some(
    (k) =>
      k.surface === r.surface && k.outcome === r.outcome && r.detail.startsWith(k.detailPrefix),
  );

describe(`boundary/malformed stress campaign (seed=${SEED}, iterations=${ITER})`, () => {
  it("unmutated fixtures are accepted by every surface (oracle sanity)", () => {
    expect(fixturesAreValid()).toEqual([]);
  });

  it("executed every iteration and covered every surface", () => {
    expect(summary.executed).toBe(ITER);
    for (const surface of SURFACES) expect(summary.bySurface[surface] ?? 0).toBeGreaterThan(0);
  });

  it("is deterministic: replaying an iteration from its seed reproduces the outcome", () => {
    const sample = records.filter((r, i) => i % 25 === 0 || !r.held);
    for (const record of sample) {
      const again = runIteration(SEED, record.index);
      expect(again.seed).toBe(record.seed);
      expect(again.outcome).toBe(record.outcome);
      expect(again.detail).toBe(record.detail);
      expect(again.mutationSummary).toBe(record.mutationSummary);
    }
  });

  it("every failing iteration is stable across 10 re-runs (no flakes)", () => {
    for (const [index, s] of stabilityByIndex) {
      expect(s.matches, `#${index} matched ${s.matches}/${s.times}: ${s.details.join(" | ")}`).toBe(
        s.times,
      );
    }
  });

  it("every failing iteration minimizes to a replayable prefix with the same outcome", () => {
    for (const record of minimized) {
      expect(replay(SEED, record).outcome).toBe(record.outcome);
    }
  });

  it("never pollutes Object.prototype (__proto__/constructor/prototype keys in manifests)", () => {
    expect(show(outcomes(records, "pollution"))).toBe("");
  });

  it("malformed JSON text (truncated, BOM, comments, 100k nesting, 70 KB floods) is a SyntaxError, never a RangeError", () => {
    const nonSyntax = [...by("registry_json"), ...by("dataset_json")].filter(
      (r) => r.outcome !== "rejected_parse" && /RangeError|stack/i.test(r.detail),
    );
    expect(show(nonSyntax)).toBe("");
  });

  it("read-only registry queries (resolve/shadowFor/byId/list) with poisoned arguments never throw or write", () => {
    expect(show(by("registry_query").filter((r) => !r.held))).toBe("");
  });

  it("rejected withEntry() / DatasetReleaseIndex.register() never write to the parent store", () => {
    const writes = [
      ...outcomes(by("registry_with_entry"), "state_write"),
      ...outcomes(by("dataset_index"), "state_write"),
      ...outcomes(by("lineage_audit"), "state_write"),
    ];
    expect(show(writes)).toBe("");
  });

  it("every failure belongs to a reported finding class (no unknown failure class)", () => {
    expect(show(records.filter((r) => !r.held && !isKnownOpen(r)))).toBe("");
  });
});

// ---------------------------------------------------------------------------
// OPEN findings — minimized, deterministic pins (each mirrors campaign seeds
// recorded in failing.json). `it.fails` = documented current behaviour.
// ---------------------------------------------------------------------------

const entryWithout = (key: keyof ModelManifestEntry): ModelManifestEntry => {
  const entry: Partial<ModelManifestEntry> = lineageEntryFixture();
  delete entry[key];
  return entry as ModelManifestEntry;
};

/** The full fixture with its lineage entry replaced (rollback predecessor stays registered). */
const manifestWith = (entry: ModelManifestEntry): ModelManifest => {
  const manifest = modelFixture();
  manifest.entries[manifest.entries.length - 1] = entry;
  return manifest;
};

/** The package's documented rejection: a plain `Error` with a message — never a TypeError. */
const expectTypedRejection = (run: () => unknown): void => {
  let thrown: unknown = null;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, "expected a rejection").toBeInstanceOf(Error);
  expect(thrown, `got ${String(thrown)}`).not.toBeInstanceOf(TypeError);
};

describe("OPEN: validateDatasetReleaseManifest is documented never to throw", () => {
  const cases: Array<[string, (m: DatasetReleaseManifest) => unknown]> = [
    ["components missing", (m) => ({ ...m, components: undefined })],
    ["components is an object", (m) => ({ ...m, components: {} })],
    ["component is null", (m) => ({ ...m, components: [null] })],
    [
      "component.artifacts is a number",
      (m) => ({ ...m, components: [{ ...m.components[0], artifacts: 1 }] }),
    ],
    ["statistics missing", (m) => ({ ...m, statistics: undefined })],
    ["labels is {}", (m) => ({ ...m, labels: {} })],
    [
      "labels.SILVER.verificationNote missing",
      (m) => ({ ...m, labels: { ...m.labels, SILVER: { definition: "x", count: 1 } } }),
    ],
    ["consent missing", (m) => ({ ...m, consent: null })],
    [
      "splits.bySplit group.sessions is a number",
      (m) => ({ ...m, splits: { ...m.splits, bySplit: { dev: { sessions: 1 } } } }),
    ],
    [
      "splits.leakageFindings missing with a leaking session",
      (m) => ({
        ...m,
        splits: {
          ...m.splits,
          bySplit: { a: { sessions: ["s"] }, b: { sessions: ["s"] } },
          leakageFindings: undefined,
        },
      }),
    ],
    ["knownLimitations missing", (m) => ({ ...m, knownLimitations: undefined })],
    ["datasetId missing", (m) => ({ ...m, datasetId: undefined })],
    ["root is null", () => null],
  ];
  for (const [name, mutate] of cases) {
    it.fails(`returns problems instead of throwing when ${name}`, () => {
      const payload = mutate(datasetFixture()) as DatasetReleaseManifest;
      expect(() => validateDatasetReleaseManifest(payload)).not.toThrow();
    });
  }
});

describe("OPEN: ModelRegistry rejects malformed manifests with a typed Error, not a TypeError", () => {
  it.fails("constructor: entry without version → TypeError (.trim on undefined)", () => {
    expectTypedRejection(() => new ModelRegistry(manifestWith(entryWithout("version"))));
  });
  it.fails("constructor: entry.version is a number → TypeError", () => {
    const entry = { ...lineageEntryFixture(), version: 2 } as unknown as ModelManifestEntry;
    expectTypedRejection(() => new ModelRegistry(manifestWith(entry)));
  });
  it.fails("constructor: entry.supportedPlatforms is null → TypeError", () => {
    const entry = {
      ...lineageEntryFixture(),
      supportedPlatforms: null,
    } as unknown as ModelManifestEntry;
    expectTypedRejection(() => new ModelRegistry(manifestWith(entry)));
  });
  it.fails("constructor: entries is an object → TypeError (not iterable)", () => {
    const manifest = { schemaVersion: 1, entries: {} } as unknown as ModelManifest;
    expectTypedRejection(() => new ModelRegistry(manifest));
  });
  it.fails("constructor: entries contains null → TypeError", () => {
    const manifest = { schemaVersion: 1, entries: [null] } as unknown as ModelManifest;
    expectTypedRejection(() => new ModelRegistry(manifest));
  });
  it.fails('fromJson("null") → TypeError reading schemaVersion of null', () => {
    expectTypedRejection(() => ModelRegistry.fromJson("null"));
  });
  it("HELD: fromJson('[]'), fromJson('{}'), fromJson('0') are typed schema-version rejections", () => {
    for (const text of ["[]", "{}", "0", '""', "true", '{"entries":[]}']) {
      expectTypedRejection(() => ModelRegistry.fromJson(text));
      expect(() => ModelRegistry.fromJson(text)).toThrow(/schema version/);
    }
  });
  it.fails(
    "withEntry(entry without version) → TypeError instead of the immutability/alias Error",
    () => {
      const registry = new ModelRegistry(modelFixture());
      expectTypedRejection(() => registry.withEntry(entryWithout("version")));
    },
  );
  it.fails("auditModelDatasetLineage with entries: null → TypeError", () => {
    const manifest = { schemaVersion: 1, entries: null } as unknown as ModelManifest;
    expect(() => auditModelDatasetLineage(manifest, new DatasetReleaseIndex())).not.toThrow();
  });
});

describe("OPEN: ModelRegistry accepts manifests that violate ModelManifestEntry", () => {
  const cases: Array<[string, Partial<Record<keyof ModelManifestEntry, unknown>>]> = [
    ["inputSchemaVersion: NaN", { inputSchemaVersion: NaN }],
    ["outputSchemaVersion: Infinity", { outputSchemaVersion: Infinity }],
    ["task: unknown enum", { task: "not_a_model_task" }],
    ["runtime: unknown enum", { runtime: "../../../etc/passwd" }],
    ["executionTarget: number", { executionTarget: 1 }],
    ["supportedPlatforms: mixed junk", { supportedPlatforms: ["ios", 1, null] }],
    ["supportedStrokes: unknown slug", { supportedStrokes: ["not_a_stroke"] }],
    ["metrics with NaN", { metrics: { mae: NaN } }],
    ["metrics is an array", { metrics: [] }],
    ["splits is a string", { splits: "train" }],
    ["id is a number", { id: 42 }],
    ["notes is null", { notes: null }],
    ["runtimeRequirements is a string", { runtimeRequirements: "coreml" }],
    ["commit is a boolean", { commit: true }],
    ["promotionDate is a number", { promotionDate: 1e308 }],
  ];
  for (const [name, overrides] of cases) {
    it.fails(`rejects ${name}`, () => {
      const entry = { ...lineageEntryFixture(), ...overrides } as ModelManifestEntry;
      expect(() => new ModelRegistry(manifestWith(entry))).toThrow();
    });
  }
});

describe("HELD: schema-version and alias boundaries the validators do enforce", () => {
  for (const schemaVersion of [2, "1", 1.5, -1, 0, null, undefined, NaN, Infinity, [1], "latest"]) {
    it(`rejects model manifest schemaVersion ${String(schemaVersion)}`, () => {
      const manifest = { schemaVersion, entries: [] } as unknown as ModelManifest;
      expect(() => new ModelRegistry(manifest)).toThrow(/schema version/);
    });
    it(`reports dataset schemaVersion ${String(schemaVersion)}`, () => {
      const payload = { ...datasetFixture(), schemaVersion } as unknown as DatasetReleaseManifest;
      expect(validateDatasetReleaseManifest(payload).join("\n")).toMatch(/schemaVersion/);
    });
  }
  for (const version of [
    "",
    "latest",
    " LATEST\t",
    "Current",
    "head",
    "newest",
    "\u00a0latest\u00a0",
  ]) {
    it(`rejects forbidden version alias ${JSON.stringify(version)}`, () => {
      const entry = { ...lineageEntryFixture(), version };
      expect(() => new ModelRegistry(manifestWith(entry))).toThrow(/forbidden version alias/);
    });
  }
  it("rejects a 64 KB+ sha256, non-hex, uppercase and off-by-one hashes in dataset artifacts", () => {
    for (const sha256 of [
      "a".repeat(65_537),
      "g".repeat(64),
      "A".repeat(64),
      "a".repeat(63),
      "a".repeat(65),
      "",
    ]) {
      const m = datasetFixture();
      const component = m.components[0];
      if (component === undefined) throw new Error("fixture has no components");
      const artifact = component.artifacts[0];
      if (artifact === undefined) throw new Error("fixture component has no artifacts");
      artifact.sha256 = sha256;
      expect(validateDatasetReleaseManifest(m).join("\n")).toMatch(/malformed sha256/);
    }
  });
});

const withFirstArtifact =
  (overrides: Record<string, unknown>) =>
  (m: DatasetReleaseManifest): unknown => {
    const component = m.components[0];
    if (component === undefined) throw new Error("fixture has no components");
    const artifact = component.artifacts[0];
    if (artifact === undefined) throw new Error("fixture component has no artifacts");
    return {
      ...m,
      components: [{ ...component, artifacts: [{ ...artifact, ...overrides }] }],
    };
  };

describe("OPEN: validateDatasetReleaseManifest accepts manifests that violate DatasetReleaseManifest", () => {
  const cases: Array<[string, (m: DatasetReleaseManifest) => unknown]> = [
    [
      "component.classification unknown",
      (m) => ({
        ...m,
        components: [{ ...m.components[0], classification: "gold_human_labels_v2" }],
      }),
    ],
    [
      "component.notGold is a string",
      (m) => ({
        ...m,
        components: m.components.map((c) => (c.notGold ? { ...c, notGold: "yes" } : c)),
      }),
    ],
    [
      "component.description is a number",
      (m) => ({ ...m, components: [{ ...m.components[0], description: 1 }] }),
    ],
    ["artifact.path is a 64 KB+ string", withFirstArtifact({ path: "x".repeat(65_537) })],
    ["artifact.path is a path traversal", withFirstArtifact({ path: "../../../etc/passwd" })],
    ["artifact.path is an absolute path", withFirstArtifact({ path: "/etc/passwd" })],
    ["artifact.path contains a null byte", withFirstArtifact({ path: "a\u0000b" })],
    ["artifact.livePath is a number", withFirstArtifact({ livePath: 1 })],
    [
      "statistics.sessions is a string",
      (m) => ({ ...m, statistics: { ...m.statistics, sessions: "12" } }),
    ],
    [
      "statistics.sessions is Infinity",
      (m) => ({ ...m, statistics: { ...m.statistics, sessions: Infinity } }),
    ],
    [
      "statistics.recordings is the string 'NaN'",
      (m) => ({ ...m, statistics: { ...m.statistics, recordings: "NaN" } }),
    ],
    ["rights.policy is a number", (m) => ({ ...m, rights: { ...m.rights, policy: 1 } })],
    [
      "rights.trainingEligibleSources is NaN",
      (m) => ({ ...m, rights: { ...m.rights, trainingEligibleSources: NaN } }),
    ],
    [
      "consent.analysisConsentRecords is Infinity",
      (m) => ({ ...m, consent: { ...m.consent, analysisConsentRecords: Infinity } }),
    ],
    [
      "labels.SILVER.count is a string",
      (m) => ({ ...m, labels: { ...m.labels, SILVER: { ...m.labels.SILVER, count: "0" } } }),
    ],
    ["splits.unit is not 'session'", (m) => ({ ...m, splits: { ...m.splits, unit: "clip" } })],
    [
      "dedupLineage.findings is a string",
      (m) => ({ ...m, dedupLineage: { ...m.dedupLineage, findings: "0" } }),
    ],
    ["problems is a string", (m) => ({ ...m, problems: "none" })],
    [
      "componentId contains a null byte",
      (m) => ({ ...m, components: [{ ...m.components[0], componentId: "a\u0000b" }] }),
    ],
  ];
  for (const [name, mutate] of cases) {
    it.fails(`reports a problem when ${name}`, () => {
      const payload = mutate(datasetFixture()) as DatasetReleaseManifest;
      expect(validateDatasetReleaseManifest(payload)).not.toEqual([]);
    });
  }
});

describe("OPEN: SubsystemReleaseState.activate() commits state before apply() succeeds", () => {
  it.fails("a rejected candidate leaves active() and the journal unchanged", () => {
    const state = new SubsystemReleaseState<{ ok: boolean }>({
      subsystem: "stress",
      initial: { version: "known-good-1", artifact: { ok: true } },
      apply: (artifact) => {
        if (artifact !== null && artifact.ok !== true)
          throw new Error("refusing malformed artifact");
      },
      clock: () => 0,
    });
    state.recordKnownGood();
    const journalBefore = state.journal().length;
    expect(() =>
      state.activate({ version: "../../../etc/passwd", artifact: { ok: false } }),
    ).toThrow(/malformed/);
    expect(state.active()?.version).toBe("known-good-1");
    expect(state.journal().length).toBe(journalBefore);
  });
});

describe("OPEN: forbidden version aliases are matched after trim/lowercase only", () => {
  for (const [name, version] of [
    ["a trailing zero-width space", "latest\u200b"],
    ["a leading zero-width space", "\u200blatest"],
    ["fullwidth letters", "\uff4c\uff41\uff54\uff45\uff53\uff54"],
  ] as const) {
    it.fails(`rejects "latest" written with ${name}`, () => {
      const entry = { ...lineageEntryFixture(), version };
      expect(() => new ModelRegistry(manifestWith(entry))).toThrow(/forbidden version alias/);
    });
  }
});
