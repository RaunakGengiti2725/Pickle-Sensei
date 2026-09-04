// Execution probe (audit harness, not production code): drives @pickle/model-registry
// through malformed / empty / stale / missing-data inputs and prints what happens.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MODEL_MANIFEST,
  DatasetReleaseIndex,
  ModelRegistry,
  auditModelDatasetLineage,
  validateDatasetReleaseManifest,
  type DatasetReleaseManifest,
} from "@pickle/model-registry";

// Repo root: explicit argv[2], else three levels above this file (tools/audit/<probe>/).
const ROOT = resolve(
  process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
);
const out: Record<string, unknown> = {};
function probe(name: string, fn: () => unknown): void {
  try {
    out[name] = { ok: true, value: fn() };
  } catch (error) {
    out[name] = {
      ok: false,
      error:
        error instanceof Error
          ? `${error.constructor.name}: ${error.message.split("\n")[0]}`
          : String(error),
    };
  }
}

probe("fromJson('')", () => ModelRegistry.fromJson(""));
probe("fromJson('null')", () => ModelRegistry.fromJson("null"));
probe("fromJson('{}')", () => ModelRegistry.fromJson("{}"));
probe("fromJson({schemaVersion:1})", () => ModelRegistry.fromJson('{"schemaVersion":1}'));
probe("fromJson({schemaVersion:1,entries:{}})", () =>
  ModelRegistry.fromJson('{"schemaVersion":1,"entries":{}}'),
);
probe("fromJson({schemaVersion:1,entries:[{}]})", () =>
  ModelRegistry.fromJson('{"schemaVersion":1,"entries":[{}]}'),
);
probe("fromJson({schemaVersion:1,entries:[null]})", () =>
  ModelRegistry.fromJson('{"schemaVersion":1,"entries":[null]}'),
);
probe("fromJson(entry without status)", () =>
  ModelRegistry.fromJson(
    JSON.stringify({
      schemaVersion: 1,
      entries: [{ ...DEFAULT_MODEL_MANIFEST.entries[0], deploymentStatus: undefined }],
    }),
  ),
);
probe("fromJson(entry status='banana')", () =>
  ModelRegistry.fromJson(
    JSON.stringify({
      schemaVersion: 1,
      entries: [{ ...DEFAULT_MODEL_MANIFEST.entries[0], deploymentStatus: "banana" }],
    }),
  )
    .list()
    .map((e) => e.deploymentStatus),
);
probe(
  "fromJson(entry supportedPlatforms=[])",
  () =>
    ModelRegistry.fromJson(
      JSON.stringify({
        schemaVersion: 1,
        entries: [{ ...DEFAULT_MODEL_MANIFEST.entries[0], supportedPlatforms: [] }],
      }),
    ).list().length,
);
probe(
  "fromJson(entry supportedStrokes=[])",
  () =>
    ModelRegistry.fromJson(
      JSON.stringify({
        schemaVersion: 1,
        entries: [{ ...DEFAULT_MODEL_MANIFEST.entries[0], supportedStrokes: [] }],
      }),
    ).list().length,
);
probe(
  "fromJson(entry metrics=[{...}] w/o fields)",
  () =>
    ModelRegistry.fromJson(
      JSON.stringify({
        schemaVersion: 1,
        entries: [
          { ...DEFAULT_MODEL_MANIFEST.entries[0], evaluationDatasetVersion: "v1", metrics: [{}] },
        ],
      }),
    ).list().length,
);

const reg = new ModelRegistry(DEFAULT_MODEL_MANIFEST);
probe("default manifest entries", () =>
  reg.list().map((e) => `${e.id}@${e.version}:${e.deploymentStatus}`),
);
probe("resolve(unknown task)", () => reg.resolve({ task: "nope" as never, platform: "ios" }));
probe("resolve(platform='android')", () =>
  reg.resolve({ task: reg.list()[0]!.task, platform: "android" as never }),
);
probe("resolve(stroke='')", () =>
  reg.resolve({ task: reg.list()[0]!.task, platform: "ios", stroke: "" as never }),
);

// version ordering: numeric localeCompare
const base = DEFAULT_MODEL_MANIFEST.entries[0]!;
function entry(version: string, deploymentStatus = "production") {
  return {
    ...base,
    version,
    deploymentStatus,
    rollbackPredecessor: null,
    metrics: null,
    splits: null,
    trainingDatasetVersion: null,
    evaluationDatasetVersion: null,
  };
}
probe("resolve picks highest among v1.9/v1.10/v2.0-rc1/2.0", () => {
  const r = new ModelRegistry({
    schemaVersion: 1,
    entries: [entry("v1.9"), entry("v1.10"), entry("v2.0-rc1"), entry("v2.0")],
  } as never);
  return r.resolve({ task: base.task, platform: base.supportedPlatforms[0]!, status: "production" })
    ?.version;
});
probe(
  "duplicate id@version rejected?",
  () =>
    new ModelRegistry({ schemaVersion: 1, entries: [entry("v1"), entry("v1")] } as never).list()
      .length,
);
probe("version with surrounding whitespace ' v1 ' accepted?", () =>
  new ModelRegistry({ schemaVersion: 1, entries: [entry(" v1 ")] } as never).byId(base.id, "v1"),
);
probe(
  "entry with empty id accepted?",
  () =>
    new ModelRegistry({ schemaVersion: 1, entries: [{ ...entry("v1"), id: "" }] } as never).list()
      .length,
);
probe(
  "entry with unknown task accepted?",
  () =>
    new ModelRegistry({
      schemaVersion: 1,
      entries: [{ ...entry("v1"), task: "banana" }],
    } as never).list().length,
);
probe("entry supportedStrokes='none' (string) accepted?", () =>
  new ModelRegistry({
    schemaVersion: 1,
    entries: [{ ...entry("v1"), supportedStrokes: "none" }],
  } as never).resolve({ task: base.task, platform: base.supportedPlatforms[0]!, stroke: "dink" }),
);
probe(
  "two production entries same version different platforms -> resolve ios",
  () =>
    new ModelRegistry({
      schemaVersion: 1,
      entries: [entry("v1"), { ...entry("v1"), id: "other" }],
    } as never).resolve({ task: base.task, platform: base.supportedPlatforms[0]! })?.id,
);
probe("rollbackTo cycle a->b->a accepted?", () => {
  const a = { ...entry("v1"), rollbackPredecessor: `${base.id}@v2` };
  const b = { ...entry("v2"), rollbackPredecessor: `${base.id}@v1` };
  return new ModelRegistry({ schemaVersion: 1, entries: [a, b] } as never).list().length;
});

// dataset release index behaviour
const releasesDir = join(ROOT, "datasets", "releases");
const manifests: DatasetReleaseManifest[] = [];
const releaseChecks: Record<string, unknown> = {};
for (const dir of readdirSync(releasesDir)) {
  const path = join(releasesDir, dir, "manifest.json");
  if (!existsSync(path)) continue;
  const raw = readFileSync(path, "utf8");
  const manifest = JSON.parse(raw) as DatasetReleaseManifest;
  const check: Record<string, unknown> = {
    schemaVersion: (manifest as { schemaVersion?: unknown }).schemaVersion,
  };
  const shaPath = join(releasesDir, dir, "manifest.sha256");
  if (existsSync(shaPath)) {
    const expected = readFileSync(shaPath, "utf8").trim();
    const actual = createHash("sha256").update(raw).digest("hex");
    check.manifestSha256Matches = expected === actual;
  }
  if ((manifest as { schemaVersion?: unknown }).schemaVersion === 1 && "components" in manifest) {
    check.validationProblems = validateDatasetReleaseManifest(manifest);
    check.manifestProblems = manifest.problems;
    const artifacts: Record<string, string> = {};
    for (const c of manifest.components) {
      for (const [label, art] of [
        ["frozen", c.frozen],
        ["live", c.live],
      ] as const) {
        if (!art) continue;
        const p = join(ROOT, art.path);
        if (!existsSync(p)) {
          artifacts[`${c.componentId}.${label}`] = `MISSING ${art.path}`;
          continue;
        }
        const h = createHash("sha256").update(readFileSync(p)).digest("hex");
        artifacts[`${c.componentId}.${label}`] =
          h === art.sha256 ? "sha256 ok" : `SHA MISMATCH ${art.path}`;
      }
    }
    if (manifest.dedupLineage.report) {
      const p = join(ROOT, manifest.dedupLineage.report.path);
      artifacts["dedupLineage.report"] = existsSync(p)
        ? createHash("sha256").update(readFileSync(p)).digest("hex") ===
          manifest.dedupLineage.report.sha256
          ? "sha256 ok"
          : `SHA MISMATCH ${manifest.dedupLineage.report.path}`
        : `MISSING ${manifest.dedupLineage.report.path}`;
    }
    check.artifacts = artifacts;
    manifests.push(manifest);
  }
  releaseChecks[dir] = check;
}
out["committed dataset releases"] = releaseChecks;

probe("DatasetReleaseIndex(committed v1 manifests)", () => {
  const index = new DatasetReleaseIndex(manifests);
  return index.versions();
});
probe("lineage audit of DEFAULT_MODEL_MANIFEST vs committed releases (+legacy dirs)", () => {
  const index = new DatasetReleaseIndex(manifests);
  for (const dir of readdirSync(releasesDir)) {
    if (!existsSync(join(releasesDir, dir, "manifest.json"))) continue;
    if (!manifests.some((m) => `${m.datasetId}-${m.version}` === dir)) index.registerLegacy(dir);
  }
  return {
    versions: index.versions(),
    problems: auditModelDatasetLineage(DEFAULT_MODEL_MANIFEST, index),
  };
});
probe("two datasets sharing bare version 'v1' both registrable?", () => {
  const index = new DatasetReleaseIndex(manifests);
  const m1 = manifests[0]!;
  const other = { ...m1, releaseId: `other@${m1.version}`, datasetId: "other" };
  index.register(other);
  return index.versions();
});
probe(
  "leakage finding substring: session 's1' spanning splits covered by finding mentioning 's10'",
  () => {
    const m1 = manifests[0]!;
    const m = {
      ...m1,
      splits: {
        ...m1.splits,
        bySplit: { dev: { sessions: ["s1"] }, locked_test: { sessions: ["s1"] } },
        leakageFindings: ["s10 appears in dev and locked_test"],
      },
    };
    return validateDatasetReleaseManifest(m).filter((p) => p.includes("spans splits"));
  },
);

process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
