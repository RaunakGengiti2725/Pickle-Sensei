import { describe, expect, it } from "vitest";
import {
  EXTERNALLY_BLOCKED_STAGES,
  RELEASE_STAGES,
  findRepoRoot,
  generateReleaseRecord,
  validateReleaseRecord,
  type ReleaseRecord,
  type StageGate,
} from "../../src/index.js";
import {
  SeededRng,
  type IterationOutcome,
  digestOf,
  nonFinitePaths,
  nondeterministicSeeds,
  runLeakCampaign,
  stressIterations,
  summarizeReport,
  writeReportIfRequested,
} from "../../../../tools/stress/leakHarness.js";

/**
 * LONG-RUN LEAK lens for @pickle/release-ops. Each iteration generates a
 * release record from the committed repo state (seeded commit SHA and
 * timestamp injected, so nothing shells out to git), validates it, then
 * applies one seeded mutation whose verdict is known in advance and checks
 * the validator's answer. STRESS_ITER=500 for the full campaign.
 */

const ITER = stressIterations(60);
const BASE_SEED = 0x7e1e_0001;
const repoRoot = findRepoRoot(process.cwd());

type Mutable = {
  [key: string]: unknown;
  stageGates: StageGate[];
  coachReviewGate: { state: string; evidence: string | null; blockedReason: string | null };
  databaseSchema: { latestMigration: string; migrationCount: number };
  modelVersions: { id: string; version: string; deploymentStatus: string }[];
  featureFlags: Record<string, unknown>;
  techniqueAnalysisProfileVersions: Record<string, unknown>;
};

interface Mutation {
  name: string;
  expectValid: boolean;
  /** Substring every failing verdict must contain (ignored for valid mutations). */
  problemIncludes: string;
  apply: (record: Mutable, rng: SeededRng) => unknown;
}

const passGatesThrough = (record: Mutable, count: number, at: string): void => {
  for (let i = 0; i < count; i += 1) {
    const gate = record.stageGates[i];
    if (gate === undefined) break;
    gate.state = "PASSED";
    gate.evidence = `artifacts/synthetic/${gate.stage}.json`;
    gate.evaluatedAt = at;
    gate.blockedReason = null;
  }
};

const MUTATIONS: readonly Mutation[] = [
  {
    name: "identity",
    expectValid: true,
    problemIncludes: "",
    apply: (r) => r,
  },
  {
    name: "json-roundtrip",
    expectValid: true,
    problemIncludes: "",
    apply: (r) => JSON.parse(JSON.stringify(r)) as unknown,
  },
  {
    name: "promote-in-order",
    expectValid: true,
    problemIncludes: "",
    apply: (r, rng) => {
      // Any prefix that stops before the externally blocked stage is legitimate.
      const blockedIndex = RELEASE_STAGES.indexOf(
        EXTERNALLY_BLOCKED_STAGES[0] ?? "physical-device",
      );
      passGatesThrough(r, rng.int(0, blockedIndex), "2026-09-01T00:00:00.000Z");
      return r;
    },
  },
  {
    name: "promote-past-unresolved",
    expectValid: false,
    problemIncludes: "cannot be PASSED while an earlier stage is unresolved",
    apply: (r, rng) => {
      const skip = rng.int(0, RELEASE_STAGES.length - 2);
      const gate = r.stageGates[skip + 1];
      if (gate !== undefined) {
        gate.state = "PASSED";
        gate.evidence = "artifacts/synthetic/skipped.json";
        gate.blockedReason = null;
      }
      return r;
    },
  },
  {
    name: "passed-without-evidence",
    expectValid: false,
    problemIncludes: "cannot be PASSED without evidence",
    apply: (r) => {
      const gate = r.stageGates[0];
      if (gate !== undefined) gate.state = "PASSED";
      return r;
    },
  },
  {
    name: "blocked-without-reason",
    expectValid: false,
    problemIncludes: "requires a blockedReason",
    apply: (r, rng) => {
      const gate = rng.pick(r.stageGates);
      gate.state = rng.pick(["BLOCKED_EXTERNAL", "NOT_EVALUABLE"]);
      gate.blockedReason = null;
      return r;
    },
  },
  {
    name: "coach-gate-passed-without-evidence",
    expectValid: false,
    problemIncludes: "coachReviewGate cannot be PASSED without evidence",
    apply: (r) => {
      r.coachReviewGate.state = "PASSED";
      r.coachReviewGate.evidence = null;
      return r;
    },
  },
  {
    name: "bad-commit-sha",
    expectValid: false,
    problemIncludes: "commitSha",
    apply: (r, rng) => {
      r.commitSha = rng.pick([rng.hex(39), rng.hex(40).toUpperCase(), "", "HEAD", rng.hex(41)]);
      return r;
    },
  },
  {
    name: "bad-schema-version",
    expectValid: false,
    problemIncludes: "schemaVersion",
    apply: (r, rng) => {
      r.schemaVersion = rng.pick([0, 2, "1", null, Number.NaN]);
      return r;
    },
  },
  {
    name: "bad-migration-count",
    expectValid: false,
    problemIncludes: "migrationCount",
    apply: (r, rng) => {
      r.databaseSchema.migrationCount = rng.pick([
        0,
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ]);
      return r;
    },
  },
  {
    name: "bad-migration-name",
    expectValid: false,
    problemIncludes: "latestMigration",
    apply: (r, rng) => {
      r.databaseSchema.latestMigration = rng.pick(["init.sql", "0001_Init.sql", "0001_init", ""]);
      return r;
    },
  },
  {
    name: "duplicate-model-version",
    expectValid: false,
    problemIncludes: "duplicate",
    apply: (r, rng) => {
      const entry = rng.pick(r.modelVersions);
      r.modelVersions.push({ ...entry });
      return r;
    },
  },
  {
    name: "non-boolean-flag",
    expectValid: false,
    problemIncludes: "featureFlags",
    apply: (r, rng) => {
      r.featureFlags[`synthetic_flag_${rng.int(0, 9)}`] = rng.pick(["true", 1, null]);
      return r;
    },
  },
  {
    name: "empty-profiles",
    expectValid: false,
    problemIncludes: "must not be empty",
    apply: (r) => {
      r.techniqueAnalysisProfileVersions = {};
      return r;
    },
  },
  {
    name: "reordered-gates",
    expectValid: false,
    problemIncludes: "canonical order",
    apply: (r, rng) => {
      const i = rng.int(0, r.stageGates.length - 2);
      const a = r.stageGates[i];
      const b = r.stageGates[i + 1];
      if (a !== undefined && b !== undefined) {
        r.stageGates[i] = b;
        r.stageGates[i + 1] = a;
      }
      return r;
    },
  },
  {
    name: "missing-gate",
    expectValid: false,
    problemIncludes: "exactly one gate per stage",
    apply: (r, rng) => {
      r.stageGates.splice(rng.int(0, r.stageGates.length - 1), 1);
      return r;
    },
  },
  {
    name: "not-an-object",
    expectValid: false,
    problemIncludes: "must be an object",
    apply: (_r, rng) => rng.pick([null, [], "record", 42]),
  },
];

function releaseIteration(seed: number): IterationOutcome {
  const rng = new SeededRng(seed);
  const generatedAtIso = new Date(1_760_000_000_000 + rng.int(0, 100_000_000)).toISOString();
  const record: ReleaseRecord = generateReleaseRecord({
    repoRoot,
    commitSha: rng.hex(40),
    generatedAtIso,
  });
  const problems: string[] = [];
  const baseline = validateReleaseRecord(record);
  if (!baseline.valid) problems.push(`generated record invalid: ${baseline.problems.join(" | ")}`);
  problems.push(...nonFinitePaths(record, "record"));
  if (record.stageGates.length !== RELEASE_STAGES.length) problems.push("stage gate count");
  for (const stage of EXTERNALLY_BLOCKED_STAGES) {
    const gate = record.stageGates.find((g) => g.stage === stage);
    if (gate?.state !== "BLOCKED_EXTERNAL") problems.push(`${stage} not BLOCKED_EXTERNAL at birth`);
  }
  if (record.coachReviewGate.state !== "BLOCKED_EXTERNAL")
    problems.push("coach gate not blocked at birth");

  const mutation = rng.pick(MUTATIONS);
  const mutated = mutation.apply(structuredClone(record) as unknown as Mutable, rng);
  const verdict = validateReleaseRecord(mutated);
  if (verdict.valid !== mutation.expectValid) {
    problems.push(
      `${mutation.name}: valid=${verdict.valid}, expected ${mutation.expectValid}: ${verdict.problems.join(" | ")}`,
    );
  }
  if (
    !mutation.expectValid &&
    !verdict.problems.some((p) => p.includes(mutation.problemIncludes))
  ) {
    problems.push(`${mutation.name}: no problem mentions "${mutation.problemIncludes}"`);
  }
  if (verdict.valid && verdict.problems.length !== 0) problems.push("valid verdict with problems");
  // Validation must not mutate its input.
  const recordAfter = validateReleaseRecord(record);
  if (digestOf(recordAfter) !== digestOf(baseline)) problems.push("validation is not idempotent");
  if (problems.length > 0) throw new Error(problems.join("; "));

  return {
    outcome: `${mutation.name}:${verdict.valid ? "valid" : `${verdict.problems.length}problems`}`,
    digest: digestOf({ record, verdict }),
    retainables: [record, verdict, baseline],
    detail: { mutation: mutation.name, problems: verdict.problems.length },
  };
}

describe(
  "release-ops long-run leak (seeded, one process)",
  { timeout: 30_000 + ITER * 400 },
  () => {
    it(`generates and validates ${ITER} seeded release records without retaining any`, async () => {
      const report = await runLeakCampaign({
        name: "release-ops.generate-validate",
        baseSeed: BASE_SEED,
        iterations: ITER,
        run: releaseIteration,
      });
      const path = writeReportIfRequested(report);
      console.log(summarizeReport(report), path ?? "");

      expect(report.gcForced).toBe(true);
      expect(report.iterations).toBe(ITER);
      expect(report.failures).toEqual([]);
      expect(report.retained.maxAtAnyCheckpoint).toBe(0);
      expect(report.handles.grown).toEqual({});
      if (ITER >= 200) {
        expect(report.heap.monotoneIncreasing && report.heap.slopePctPer100 > 5).toBe(false);
      }
    });

    it("every mutation kind is exercised and each verdict is reproducible from its seed", () => {
      const seeds = Array.from({ length: Math.min(ITER, 25) }, (_, i) => BASE_SEED + i);
      expect(nondeterministicSeeds(seeds, releaseIteration)).toEqual([]);
      const seen = new Set<string>();
      for (
        let seed = BASE_SEED;
        seed < BASE_SEED + 400 && seen.size < MUTATIONS.length;
        seed += 1
      ) {
        seen.add(releaseIteration(seed).outcome.split(":")[0] ?? "");
      }
      expect([...seen].sort()).toEqual(MUTATIONS.map((m) => m.name).sort());
    });
  },
);
