import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EXTERNALLY_BLOCKED_STAGES,
  GATE_STATES,
  RELEASE_STAGES,
  findRepoRoot,
  generateReleaseRecord,
  readDatabaseSchemaVersion,
  validateReleaseRecord,
  type GenerateManifestOptions,
  type ReleaseRecord,
} from "../src/index.js";
import {
  campaignTimeoutMs,
  campaignVerdict,
  classifyThrown,
  findNonFinite,
  findOwnProtoKeys,
  outputDir,
  runCampaign,
  runGuarded,
  stableJson,
  writeReport,
  type KnownGap,
  type StressCase,
} from "../../../tools/stress/boundary-malformed/harness.js";
import {
  describeValue,
  materialize,
  planMutations,
  type FieldSpec,
  type PathSegment,
} from "../../../tools/stress/boundary-malformed/payloads.js";

/**
 * Boundary / malformed-input stress campaign for @pickle/release-ops.
 *
 * `validateReleaseRecord(record: unknown)` is the package's untrusted-input
 * boundary (a hand-edited or future-schema release manifest). The campaign
 * asserts it always returns a verdict — never throws — and, when it says
 * `valid: true`, that the accepted record really satisfies the release
 * invariants that must never be bypassed (physical-device stays
 * BLOCKED_EXTERNAL unless evidenced, no PASSED gate without evidence, one
 * gate per stage in canonical order, schema version pinned).
 *
 * `generateReleaseRecord` / `readDatabaseSchemaVersion` / `findRepoRoot`
 * are exercised against a SYNTHETIC scratch repo whose package.json files
 * and migration names are corrupted; the real repository is only read
 * (never written) to build the base record.
 *
 * Scale: STRESS_ITER (default 60). Replay one row: STRESS_REPLAY=<seed>.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const WORKSPACE_ROOT = findRepoRoot(REPO_ROOT);

const BASE_RECORD: ReleaseRecord = generateReleaseRecord({
  repoRoot: WORKSPACE_ROOT,
  commitSha: "a".repeat(40),
  generatedAtIso: "2026-08-29T00:00:00.000Z",
});

const GATE_STATE_SET: readonly string[] = GATE_STATES;

function gateFields(prefix: PathSegment[]): FieldSpec[] {
  return [
    { path: prefix, kind: "object" },
    { path: [...prefix, "stage"], kind: "enum" },
    { path: [...prefix, "state"], kind: "enum" },
    { path: [...prefix, "evidence"], kind: "string" },
    { path: [...prefix, "evaluatedAt"], kind: "string" },
    { path: [...prefix, "blockedReason"], kind: "string" },
  ];
}

const RECORD_FIELDS: FieldSpec[] = [
  { path: ["schemaVersion"], kind: "number" },
  { path: ["generatedAtIso"], kind: "string" },
  { path: ["commitSha"], kind: "string" },
  { path: ["mobileBuild"], kind: "object" },
  { path: ["mobileBuild", "appVersion"], kind: "string" },
  { path: ["mobileBuild", "buildNumber"], kind: "string" },
  { path: ["backendRelease"], kind: "object" },
  { path: ["backendRelease", "serviceName"], kind: "string" },
  { path: ["backendRelease", "version"], kind: "string" },
  { path: ["databaseSchema"], kind: "object" },
  { path: ["databaseSchema", "latestMigration"], kind: "string" },
  { path: ["databaseSchema", "migrationCount"], kind: "number" },
  { path: ["modelVersions"], kind: "array" },
  { path: ["modelVersions", 0], kind: "object" },
  { path: ["modelVersions", 0, "id"], kind: "string" },
  { path: ["modelVersions", 0, "version"], kind: "string" },
  { path: ["modelVersions", 0, "deploymentStatus"], kind: "string" },
  { path: ["techniqueAnalysisProfileVersions"], kind: "object" },
  { path: ["scoreVersion"], kind: "string" },
  { path: ["faultTaxonomyVersion"], kind: "string" },
  { path: ["drillLibraryVersion"], kind: "string" },
  { path: ["captureEnvelopeVersion"], kind: "string" },
  { path: ["featureFlags"], kind: "object" },
  { path: ["stageGates"], kind: "array" },
  ...gateFields(["stageGates", 0]),
  ...gateFields(["stageGates", 5]),
  ...gateFields(["stageGates", 10]),
  ...gateFields(["coachReviewGate"]),
];

/** Independent restatement of the release invariants an accepted record must satisfy. */
function acceptedRecordProblems(record: unknown): string[] {
  const problems: string[] = [];
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return ["accepted non-object record"];
  }
  const r = record as Record<string, unknown>;
  if (r["schemaVersion"] !== 1)
    problems.push(`accepted schemaVersion ${describeValue(r["schemaVersion"])}`);
  const gates = r["stageGates"];
  if (!Array.isArray(gates) || gates.length !== RELEASE_STAGES.length) {
    problems.push("accepted record without exactly one gate per stage");
  } else {
    for (const [index, gate] of gates.entries()) {
      const expectedStage = RELEASE_STAGES[index];
      if (typeof gate !== "object" || gate === null) {
        problems.push(`accepted non-object gate at ${index}`);
        continue;
      }
      const g = gate as Record<string, unknown>;
      if (g["stage"] !== expectedStage) {
        problems.push(`accepted gate ${index} for stage ${describeValue(g["stage"])}`);
      }
      if (typeof g["state"] !== "string" || !GATE_STATE_SET.includes(g["state"])) {
        problems.push(`accepted gate ${index} with state ${describeValue(g["state"])}`);
      }
      if (g["state"] === "PASSED" && typeof g["evidence"] !== "string") {
        problems.push(`accepted PASSED gate ${index} without evidence`);
      }
      if (
        (g["state"] === "BLOCKED_EXTERNAL" || g["state"] === "NOT_EVALUABLE") &&
        typeof g["blockedReason"] !== "string"
      ) {
        problems.push(`accepted blocked gate ${index} without reason`);
      }
      if (
        expectedStage !== undefined &&
        EXTERNALLY_BLOCKED_STAGES.includes(expectedStage) &&
        g["state"] === "PASSED" &&
        typeof g["evidence"] !== "string"
      ) {
        problems.push("accepted physical-device PASSED without evidence");
      }
    }
  }
  const coach = r["coachReviewGate"];
  if (typeof coach !== "object" || coach === null) {
    problems.push("accepted record without coachReviewGate");
  } else {
    const c = coach as Record<string, unknown>;
    if (c["state"] === "PASSED" && typeof c["evidence"] !== "string") {
      problems.push("accepted coachReviewGate PASSED without evidence");
    }
  }
  if (typeof r["commitSha"] !== "string" || !/^[0-9a-f]{40}$/.test(r["commitSha"])) {
    problems.push("accepted non-40-hex commitSha");
  }
  problems.push(...findNonFinite(record, "record"));
  return problems;
}

interface ReleaseBase {
  record: ReleaseRecord;
  scratchRepo: {
    mobile: Record<string, unknown>;
    api: Record<string, unknown>;
    migrations: string[];
  };
  options: GenerateManifestOptions;
}

const SCRATCH_REPO: ReleaseBase["scratchRepo"] = {
  mobile: { name: "synthetic-mobile", version: "1.2.3", private: true },
  api: { name: "synthetic-api", version: "4.5.6", private: true },
  migrations: ["0001_init.sql", "0002_shots.sql", "0003_evaluation_telemetry.sql"],
};

function baseFor(): ReleaseBase {
  return {
    record: BASE_RECORD,
    scratchRepo: SCRATCH_REPO,
    options: {
      repoRoot: "<scratch>",
      commitSha: "b".repeat(40),
      generatedAtIso: "2026-08-29T00:00:00.000Z",
    },
  };
}

const validateCase: StressCase<ReleaseBase> = {
  api: "validateReleaseRecord",
  mutationRoot: (base) => base.record,
  weight: 6,
  generate(rng) {
    const plan = planMutations(rng, RECORD_FIELDS, {
      jsonOnly: rng.chance(0.6),
      allowText: true,
      objectPaths: [[], ["stageGates", 5], ["coachReviewGate"], ["featureFlags"]],
      schemaPaths: [["schemaVersion"]],
    });
    return { category: plan.category, base: baseFor(), mutations: plan.mutations };
  },
  execute(base, mutations) {
    const { value, text } = materialize(base.record, mutations);
    // Text corruptions model a hand-edited manifest file: whatever JSON.parse
    // yields (or fails to yield) is what a CLI would hand to the validator.
    let input: unknown = value;
    if (text !== null) {
      try {
        input = JSON.parse(text);
      } catch (thrown) {
        const parseFailure = classifyThrown(thrown);
        return {
          outcome: "rejected-error",
          detail: `manifest text is not parseable JSON (pre-validator ${parseFailure.errorName ?? "error"}, expected)`,
          errorName: parseFailure.errorName ?? "Error",
          messageLength: 0,
          violations: [],
        };
      }
    }
    const snapshot = stableJson(input);
    const result = runGuarded(
      () => validateReleaseRecord(input),
      (verdict) => {
        const problems: string[] = [];
        if (typeof verdict.valid !== "boolean" || !Array.isArray(verdict.problems)) {
          problems.push("verdict shape invalid");
          return problems;
        }
        if (verdict.valid !== (verdict.problems.length === 0)) {
          problems.push("valid flag disagrees with problems list");
        }
        if (verdict.problems.some((p) => typeof p !== "string" || p.length === 0)) {
          problems.push("empty/non-string problem entry");
        }
        if (verdict.valid) problems.push(...acceptedRecordProblems(input));
        return problems;
      },
    );
    if (stableJson(input) !== snapshot) result.violations.push("input-mutated: record");
    // A validator that returns problems for a malformed record has REJECTED it.
    if (result.outcome === "accepted") {
      const verdict = validateReleaseRecord(input);
      if (!verdict.valid) {
        result.outcome = "rejected-typed";
        result.detail = `${verdict.problems.length} problem(s): ${verdict.problems.slice(0, 3).join("; ")}`;
        result.messageLength = verdict.problems.join("\n").length;
      }
    }
    return result;
  },
};

function writeScratchRepo(
  root: string,
  repo: ReleaseBase["scratchRepo"],
  texts: Map<string, string>,
) {
  mkdirSync(join(root, "apps/mobile"), { recursive: true });
  mkdirSync(join(root, "services/api"), { recursive: true });
  mkdirSync(join(root, "packages/database/migrations"), { recursive: true });
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
  writeFileSync(
    join(root, "apps/mobile/package.json"),
    texts.get("mobile") ?? JSON.stringify(repo.mobile),
  );
  writeFileSync(
    join(root, "services/api/package.json"),
    texts.get("api") ?? JSON.stringify(repo.api),
  );
  for (const name of repo.migrations) {
    // Migration names come from readdir; only filesystem-legal names can exist.
    const safe = name
      .split("")
      .map((ch) => (ch === "/" || ch === "\\" || ch === "\0" ? "_" : ch))
      .join("")
      .slice(0, 200);
    if (safe.length > 0)
      writeFileSync(join(root, "packages/database/migrations", safe), "-- synthetic\n");
  }
}

const SCRATCH_FIELDS: FieldSpec[] = [
  { path: ["mobile"], kind: "object" },
  { path: ["mobile", "name"], kind: "string" },
  { path: ["mobile", "version"], kind: "string" },
  { path: ["api"], kind: "object" },
  { path: ["api", "name"], kind: "string" },
  { path: ["api", "version"], kind: "string" },
  { path: ["migrations"], kind: "array" },
  { path: ["migrations", 0], kind: "string" },
  { path: ["migrations", 2], kind: "string" },
];

const generateCase: StressCase<ReleaseBase> = {
  api: "generateReleaseRecord",
  mutationRoot: (base) => base.scratchRepo,
  weight: 3,
  generate(rng) {
    const plan = planMutations(rng, SCRATCH_FIELDS, {
      jsonOnly: true,
      allowText: true,
      objectPaths: [["mobile"], ["api"]],
    });
    return { category: plan.category, base: baseFor(), mutations: plan.mutations };
  },
  execute(base, mutations, ctx) {
    const root = join(ctx.tmpDir, "repo");
    const { value, text } = materialize(base.scratchRepo, mutations);
    const texts = new Map<string, string>();
    let repo = base.scratchRepo;
    if (text !== null) {
      // Whole-document corruption lands in the mobile package.json.
      texts.set("mobile", text);
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const v = value as Partial<ReleaseBase["scratchRepo"]>;
      repo = {
        mobile: base.scratchRepo.mobile,
        api: base.scratchRepo.api,
        migrations: Array.isArray(v.migrations)
          ? v.migrations.map((m) =>
              typeof m === "string" ? m : (JSON.stringify(m) ?? "undefined"),
            )
          : base.scratchRepo.migrations,
      };
      texts.set("mobile", JSON.stringify(v.mobile));
      texts.set("api", JSON.stringify(v.api));
    }
    writeScratchRepo(root, repo, texts);
    const listing = () =>
      JSON.stringify([
        readdirSync(join(root, "apps/mobile")),
        readdirSync(join(root, "services/api")),
        readdirSync(join(root, "packages/database/migrations")),
      ]);
    const before = listing();
    const result = runGuarded(
      () => generateReleaseRecord({ ...base.options, repoRoot: root }),
      (record) => {
        const problems: string[] = [];
        const verdict = validateReleaseRecord(record);
        if (!verdict.valid) {
          problems.push(`generated record fails validation: ${verdict.problems.join("; ")}`);
        }
        problems.push(...findNonFinite(record, "record"));
        problems.push(
          ...findOwnProtoKeys(record, "record").map((p) => `own proto key persisted at ${p}`),
        );
        return problems;
      },
    );
    if (listing() !== before) result.violations.push("write-on-generate: scratch repo changed");
    return result;
  },
};

const findRootCase: StressCase<ReleaseBase> = {
  api: "findRepoRoot/readDatabaseSchemaVersion",
  mutationRoot: () => ({ startDir: "<scratch>/apps/mobile" }),
  weight: 1,
  generate(rng) {
    const plan = planMutations(rng, [{ path: ["startDir"], kind: "string" }], {
      jsonOnly: false,
      allowText: false,
      objectPaths: [[]],
    });
    return { category: plan.category, base: baseFor(), mutations: plan.mutations };
  },
  execute(base, mutations, ctx) {
    const root = join(ctx.tmpDir, "repo");
    writeScratchRepo(root, base.scratchRepo, new Map());
    const { value } = materialize({ startDir: join(root, "apps/mobile") }, mutations);
    const startDir = (value as { startDir: unknown }).startDir;
    return runGuarded(
      () => {
        const found = findRepoRoot(startDir as string);
        return { found, schema: readDatabaseSchemaVersion(found) };
      },
      (out) => {
        const problems: string[] = [];
        if (out.found !== root && out.found !== WORKSPACE_ROOT) {
          problems.push(`resolved unexpected repo root ${out.found}`);
        }
        if (!Number.isInteger(out.schema.migrationCount) || out.schema.migrationCount < 1) {
          problems.push(`migrationCount=${describeValue(out.schema.migrationCount)}`);
        }
        return problems;
      },
    );
  },
};

/* ------------------------------------------------------------------------ */
/* Known gaps (reproduced, documented behaviour — see the campaign report)   */
/* ------------------------------------------------------------------------ */

const KNOWN_GAPS: KnownGap[] = [
  {
    id: "RO-PACKAGE-JSON-NULL-CRASH",
    finding:
      "generateManifest.ts readPackageVersion() does `JSON.parse(raw) as {name?, version?}` and " +
      "reads `.name` without checking the parse produced an object; a package.json whose " +
      "content is the JSON scalar `null` escapes as a native TypeError (`Cannot read properties " +
      "of null`) instead of the typed 'missing name or version' Error.",
    matches: (row) =>
      row.api === "generateReleaseRecord" &&
      row.outcome === "crash-native" &&
      row.errorName === "TypeError" &&
      row.violations.length === 0,
  },
  {
    id: "RO-ERR-ECHO-UNBOUNDED",
    finding:
      "findRepoRoot() interpolates the caller-supplied startDir verbatim into its Error " +
      "(`pnpm-workspace.yaml not found above <startDir>`); a 64 KiB path yields a 64 KiB+ message.",
    matches: (row) =>
      row.api === "findRepoRoot/readDatabaseSchemaVersion" &&
      row.outcome === "rejected-error" &&
      row.violations.length > 0 &&
      row.violations.every((v) => v.startsWith("oversized-error-message")),
  },
];

describe("release-ops boundary/malformed stress", () => {
  it(
    "validates malformed release records without throwing or accepting gate bypasses",
    () => {
      const report = runCampaign<ReleaseBase>({
        pkg: "release-ops",
        cases: [validateCase, generateCase, findRootCase],
        knownGaps: KNOWN_GAPS,
      });
      const path = writeReport(report, outputDir(REPO_ROOT));
      expect(campaignVerdict(report, path)).toBeNull();
    },
    campaignTimeoutMs(),
  );
});
