import {
  nonFinitePaths,
  POLLUTION_KEYS,
  prototypeSnapshot,
  prototypesPolluted,
  stableStringify,
  violatesStaticTypes,
  type Mutation,
} from "./malformed.js";
import { explainViolations } from "./knownGaps.js";
import { rng, scenarioSeed } from "./rng.js";
import { isRefusal, type BuiltInput, type Scenario } from "./scenarios.js";

/**
 * Campaign runner: one iteration = build the seeded malformed input, run the
 * target, and check the boundary contract. Generic checks applied to EVERY
 * scenario:
 *   - no throw / no rejected promise (typed outcome instead);
 *   - no NaN/±Infinity anywhere in the output tree;
 *   - the input object is not mutated by the callee;
 *   - no shared prototype gained or lost a key (pollution keys are inert);
 *   - the same (scenario, seed) replays to a byte-identical output.
 * Scenario-specific `check` adds shape/abstention rules.
 *
 * Outcome classes:
 *   held            every check passed.
 *   broken          a contract violation on an input the callee's TypeScript
 *                   signature admits (NaN/±Infinity/-0/overflow numbers,
 *                   empty/reordered arrays, hostile strings, pollution keys).
 *   type_violation  the input carried a value the signature forbids (wrong
 *                   primitive type, deleted required key, emptied object) and
 *                   the callee misbehaved. Recorded, not counted as broken:
 *                   the typed JSON ingress is where such input must be
 *                   rejected, and `wire_json_ingress` asserts that directly.
 *                   Pollution/mutation/determinism breaches are still broken.
 *   hazard          the harness refused to invoke the target because the input
 *                   would trigger a known process-killing defect (unbounded
 *                   allocation). Pinned separately with a memory-capped child.
 *
 * Every broken record is additionally split into violations explained by the
 * known-gap catalogue (`knownGaps.ts`, each pinned by its own test) and
 * `unexplained` ones; the suite fails on any unexplained violation.
 */

export type Outcome = "held" | "broken" | "type_violation" | "hazard";

export interface IterationRecord {
  scenario: string;
  seed: number;
  /** Replay handle: `STRESS_REPLAY=<scenario>:<seed>`. */
  replay: string;
  outcome: Outcome;
  /** Contract violations (outcome === "broken"). */
  violations: string[];
  /** Known-gap ids (knownGaps.ts) that explain violations of this record. */
  knownGaps: string[];
  /** Violations no catalogue entry explains — a new finding. */
  unexplained: string[];
  /** Informational observations that do not count as broken. */
  notes: string[];
  typeViolating: boolean;
  mutations: Mutation[];
  result: string;
  durationMs: number;
}

export interface ScenarioTally {
  id: string;
  target: string;
  executed: number;
  held: number;
  broken: number;
  brokenUnexplained: number;
  typeViolation: number;
  hazard: number;
}

export interface CampaignReport {
  lens: "boundary-malformed";
  unit: "pkg-vision-geometry-contracts";
  generatedAt: string;
  iterationsPerScenario: number;
  scenarios: ScenarioTally[];
  /** Iterations whose target was actually invoked (excludes `hazard`). */
  executed: number;
  held: number;
  broken: number;
  /** Broken records with at least one violation outside the known-gap catalogue. */
  brokenUnexplained: number;
  typeViolation: number;
  hazard: number;
  /** Broken records per known-gap id. */
  knownGapHits: Record<string, number>;
  violationKinds: Record<string, number>;
  noteKinds: Record<string, number>;
  records: IterationRecord[];
}

export interface IterationDetail extends IterationRecord {
  input: string;
  output: string;
}

const POLLUTION_KEY_SET: ReadonlySet<string> = new Set(POLLUTION_KEYS);

function lastSegment(path: string): string {
  const match = /\.([^.[\]]+)$/.exec(path);
  return match?.[1] ?? "";
}

export async function runIteration(scenario: Scenario, seed: number): Promise<IterationDetail> {
  const startedAt = performance.now();
  const violations: string[] = [];
  const notes: string[] = [];
  const protoBefore = prototypeSnapshot();

  let built: BuiltInput;
  try {
    built = scenario.build(rng(scenarioSeed(scenario.id, seed)), seed);
  } catch (error) {
    // A generator bug is a harness defect, not a finding — surface loudly.
    throw new Error(`harness: ${scenario.id}#${seed} failed to build input: ${String(error)}`);
  }
  const typeViolating = violatesStaticTypes(built.mutations);
  const inputBefore = stableStringify(built.input);

  const first = await invoke(scenario, built.input);
  let hazard: string | null = null;
  if (first.threw) violations.push(`throw: ${first.error}`);
  else if (isRefusal(first.output)) {
    hazard = `${first.output.hazard}: ${first.output.detail}`;
  } else {
    violations.push(...safeCheck(scenario, first.output, built));
    const nonFinite = nonFinitePaths(first.output);
    // A foreign (pollution) key echoed from the input is pass-through, not math.
    const computed = nonFinite.filter(
      (entry) => !POLLUTION_KEY_SET.has(lastSegment(entry.split("=")[0] ?? "")),
    );
    const echoed = nonFinite.length - computed.length;
    if (computed.length > 0) {
      violations.push(
        `non_finite_output: ${computed.slice(0, 4).join(", ")}${computed.length > 4 ? ` (+${computed.length - 4})` : ""}`,
      );
    }
    if (echoed > 0)
      notes.push(`foreign_key_passthrough: ${echoed} injected key(s) copied to output`);
  }

  // Invariants that hold regardless of static typing.
  const hard: string[] = [];
  const inputAfter = stableStringify(built.input);
  if (inputAfter !== inputBefore) hard.push("input_mutated: callee wrote into its argument");
  const pollution = prototypesPolluted(protoBefore);
  if (pollution) hard.push(`prototype_pollution: ${pollution}`);

  // Determinism: rebuild from the same seed and compare the full outcome.
  const rebuilt = scenario.build(rng(scenarioSeed(scenario.id, seed)), seed);
  if (stableStringify(rebuilt.input) !== inputBefore) {
    hard.push("nondeterministic_input: generator diverged for the same seed");
  }
  const firstOut = first.threw ? `throw:${first.error}` : stableStringify(first.output);
  if (!hazard) {
    const second = await invoke(scenario, rebuilt.input);
    const secondOut = second.threw ? `throw:${second.error}` : stableStringify(second.output);
    if (firstOut !== secondOut) {
      hard.push("nondeterministic_output: same seed produced a different result");
    }
  }

  let outcome: Outcome;
  if (hazard) {
    notes.push(`hazard_refused: ${hazard}`);
    outcome = hard.length > 0 ? "broken" : "hazard";
  } else if (typeViolating && violations.length > 0) {
    notes.push(...violations.map((entry) => `type_violation ${entry}`));
    violations.length = 0;
    outcome = hard.length > 0 ? "broken" : "type_violation";
  } else {
    outcome = violations.length + hard.length > 0 ? "broken" : "held";
  }
  violations.push(...hard);
  const explained =
    outcome === "broken"
      ? explainViolations(scenario.id, built.mutations, violations)
      : { knownGaps: [], unexplained: [] };

  const result = hazard
    ? `refused:${hazard.slice(0, 120)}`
    : first.threw
      ? `throw:${first.error.slice(0, 120)}`
      : safeSummarize(scenario, first.output);
  return {
    scenario: scenario.id,
    seed,
    replay: `${scenario.id}:${seed}`,
    outcome,
    violations,
    knownGaps: explained.knownGaps,
    unexplained: explained.unexplained,
    notes,
    typeViolating,
    mutations: built.mutations,
    result,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    input: inputBefore,
    output: firstOut,
  };
}

async function invoke(
  scenario: Scenario,
  input: unknown,
): Promise<{ threw: false; output: unknown } | { threw: true; error: string }> {
  try {
    const output = await scenario.run(input);
    return { threw: false, output };
  } catch (error) {
    const name = error instanceof Error ? error.constructor.name : typeof error;
    const message = error instanceof Error ? error.message : String(error);
    return { threw: true, error: `${name}: ${message}` };
  }
}

function safeCheck(scenario: Scenario, output: unknown, built: BuiltInput): string[] {
  try {
    return scenario.check(output, built);
  } catch (error) {
    return [`check_threw: ${String(error)}`];
  }
}

function safeSummarize(scenario: Scenario, output: unknown): string {
  try {
    return scenario.summarize(output);
  } catch {
    return `unsummarizable:${stableStringify(output).slice(0, 80)}`;
  }
}

function kindOf(entry: string): string {
  return entry.split(":")[0]?.trim() ?? entry;
}

export async function runCampaign(
  scenarios: readonly Scenario[],
  iterationsPerScenario: number,
  onRecord?: (record: IterationDetail) => void,
): Promise<CampaignReport> {
  const records: IterationRecord[] = [];
  const perScenario: ScenarioTally[] = [];
  const violationKinds: Record<string, number> = {};
  const noteKinds: Record<string, number> = {};
  const knownGapHits: Record<string, number> = {};
  for (const scenario of scenarios) {
    const count = Math.min(
      iterationsPerScenario,
      scenario.maxIterations ?? Number.POSITIVE_INFINITY,
    );
    const tally: ScenarioTally = {
      id: scenario.id,
      target: scenario.target,
      executed: 0,
      held: 0,
      broken: 0,
      brokenUnexplained: 0,
      typeViolation: 0,
      hazard: 0,
    };
    for (let seed = 1; seed <= count; seed += 1) {
      const detail = await runIteration(scenario, seed);
      onRecord?.(detail);
      const { input: _input, output: _output, ...record } = detail;
      records.push(record);
      if (record.outcome === "hazard") tally.hazard += 1;
      else {
        tally.executed += 1;
        if (record.outcome === "held") tally.held += 1;
        else if (record.outcome === "broken") {
          tally.broken += 1;
          if (record.unexplained.length > 0) tally.brokenUnexplained += 1;
          for (const gap of record.knownGaps) knownGapHits[gap] = (knownGapHits[gap] ?? 0) + 1;
        } else tally.typeViolation += 1;
      }
      for (const violation of record.violations) {
        const kind = kindOf(violation);
        violationKinds[kind] = (violationKinds[kind] ?? 0) + 1;
      }
      for (const note of record.notes) {
        const kind = kindOf(note);
        noteKinds[kind] = (noteKinds[kind] ?? 0) + 1;
      }
    }
    perScenario.push(tally);
  }
  const total = (
    key: keyof Pick<
      ScenarioTally,
      "executed" | "held" | "broken" | "brokenUnexplained" | "typeViolation" | "hazard"
    >,
  ) => perScenario.reduce((sum, tally) => sum + tally[key], 0);
  return {
    lens: "boundary-malformed",
    unit: "pkg-vision-geometry-contracts",
    generatedAt: new Date().toISOString(),
    iterationsPerScenario,
    scenarios: perScenario,
    executed: total("executed"),
    held: total("held"),
    broken: total("broken"),
    brokenUnexplained: total("brokenUnexplained"),
    typeViolation: total("typeViolation"),
    hazard: total("hazard"),
    knownGapHits,
    violationKinds,
    noteKinds,
    records,
  };
}
