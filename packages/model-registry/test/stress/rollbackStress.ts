import {
  SubsystemReleaseState,
  runRollbackDrill,
  type RollbackJournalEntry,
  type VersionedArtifact,
} from "../../src/index.js";
import {
  containsNonFinite,
  errorMessage,
  type Rng,
  type SequenceRun,
  type StepFailure,
} from "./harness.js";

/**
 * Randomized transition sequences over SubsystemReleaseState + runRollbackDrill,
 * checked against a reference model of the contract documented in rollback.ts:
 *
 *  K1 construction applies the initial artifact immediately (live == initial).
 *  K2 recordKnownGood throws iff disabled; otherwise knownGood == active.
 *  K3 rollback throws iff no known-good recorded; otherwise active == knownGood
 *     and live == knownGood.
 *  K4 disable → active null, live (null, null).
 *  K5 activate(c) → active == c, live == c.
 *  K6 `apply` is the ONLY path to live behaviour: after every step, active()
 *     equals the last artifact `apply` received (null when disabled). A throw
 *     out of `apply` must not leave the controller believing a version is in
 *     service that never reached live behaviour.
 *  K7 every successful transition appends exactly one journal entry with the
 *     right action/from/to; failed transitions append nothing; journal() is a
 *     copy (mutating it does not change the controller); durations are the
 *     clock deltas (finite, ≥ 0).
 *  K8 runRollbackDrill throws iff disabled or the pre-drill verifier fails;
 *     otherwise (honest verifier) recovered && badWasLive, knownGoodVersion ==
 *     pre-drill active, badVersion == candidate, journal grows by exactly 4
 *     (record_known_good, activate, disable, rollback), and afterwards
 *     active == knownGood == pre-drill active.
 */

export interface StressArtifact {
  /** Payload the subsystem would consume; `poison` makes the apply hook throw. */
  label: string;
  poison: boolean;
}

export type RollbackAction =
  | { kind: "activate"; candidate: VersionedArtifact<StressArtifact> }
  | { kind: "recordKnownGood" }
  | { kind: "disable" }
  | { kind: "rollback" }
  | { kind: "drill"; bad: VersionedArtifact<StressArtifact> }
  | { kind: "mutateJournal" };

const VERSIONS = ["v1", "v2", "v3", "v10", "2026-09-01", "rc1"] as const;

export interface RollbackGeneratorOptions {
  /** Probability that a candidate's artifact makes the `apply` hook throw (0 = legal-only). */
  poisonChance: number;
}

function candidate(rng: Rng, options: RollbackGeneratorOptions): VersionedArtifact<StressArtifact> {
  return {
    version: rng.pick(VERSIONS),
    artifact: {
      label: `artifact-${rng.int(0, 999)}`,
      poison: options.poisonChance > 0 && rng.chance(options.poisonChance),
    },
  };
}

export function generateRollbackActions(
  rng: Rng,
  length: number,
  options: RollbackGeneratorOptions = { poisonChance: 0 },
): RollbackAction[] {
  const actions: RollbackAction[] = [];
  while (actions.length < length) {
    const roll = rng.next();
    if (roll < 0.3) actions.push({ kind: "activate", candidate: candidate(rng, options) });
    else if (roll < 0.5) actions.push({ kind: "recordKnownGood" });
    else if (roll < 0.62) actions.push({ kind: "disable" });
    else if (roll < 0.8) actions.push({ kind: "rollback" });
    else if (roll < 0.94) actions.push({ kind: "drill", bad: candidate(rng, options) });
    else actions.push({ kind: "mutateJournal" });
  }
  return actions;
}

interface Live {
  artifact: StressArtifact | null;
  version: string | null;
  applies: number;
}

const sameArtifact = (
  a: VersionedArtifact<StressArtifact> | null,
  b: VersionedArtifact<StressArtifact> | null,
): boolean =>
  a === b || (a !== null && b !== null && a.version === b.version && a.artifact === b.artifact);

const CLOCK_STEP_MS = 3;

export function executeRollbackActions(
  actions: RollbackAction[],
  seed: number,
): SequenceRun<RollbackAction> {
  const trace: string[] = [];
  let failure: StepFailure | null = null;
  const fail = (step: number, invariant: string, detail: string): void => {
    failure = { step, invariant, detail };
  };

  const live: Live = { artifact: null, version: null, applies: 0 };
  let clockNow = 1_000;
  const initial: VersionedArtifact<StressArtifact> = {
    version: "v0",
    artifact: { label: `initial-${seed % 1000}`, poison: false },
  };
  const state = new SubsystemReleaseState<StressArtifact>({
    subsystem: `stress-${seed % 7}`,
    initial,
    clock: () => {
      clockNow += CLOCK_STEP_MS;
      return clockNow;
    },
    apply: (artifact, version) => {
      if (artifact?.poison === true) throw new Error(`apply refused poisoned ${version}`);
      live.artifact = artifact;
      live.version = version;
      live.applies += 1;
    },
  });

  // Reference model.
  let modelActive: VersionedArtifact<StressArtifact> | null = initial;
  let modelKnownGood: VersionedArtifact<StressArtifact> | null = null;
  let modelJournal = 0;

  if (
    live.version !== initial.version ||
    live.artifact !== initial.artifact ||
    live.applies !== 1
  ) {
    fail(-1, "K1_initial_not_applied", `live=${live.version ?? "null"} applies=${live.applies}`);
  }

  const checkCore = (step: number, action: string): boolean => {
    const active = state.active();
    if (!sameArtifact(active, modelActive)) {
      fail(
        step,
        `${action}_active_mismatch`,
        `active=${active?.version ?? "null"} model=${modelActive?.version ?? "null"}`,
      );
      return false;
    }
    if (!sameArtifact(state.knownGood(), modelKnownGood)) {
      fail(
        step,
        `${action}_known_good_mismatch`,
        `knownGood=${state.knownGood()?.version ?? "null"}`,
      );
      return false;
    }
    // K6: active() must equal what apply last delivered.
    if (
      (active?.version ?? null) !== live.version ||
      (active?.artifact ?? null) !== live.artifact
    ) {
      fail(
        step,
        "K6_active_diverges_from_live",
        `active=${active?.version ?? "null"} live=${live.version ?? "null"}`,
      );
      return false;
    }
    const journal = state.journal();
    if (journal.length !== modelJournal) {
      fail(step, "K7_journal_length", `journal=${journal.length} model=${modelJournal}`);
      return false;
    }
    if (containsNonFinite(journal.map((entry) => entry.durationMs))) {
      fail(step, "K7_non_finite_duration", "");
      return false;
    }
    if (journal.some((entry) => entry.durationMs < 0)) {
      fail(step, "K7_negative_duration", "");
      return false;
    }
    return true;
  };

  const lastEntry = (): RollbackJournalEntry | undefined => state.journal().at(-1);
  const expectEntry = (
    step: number,
    action: RollbackJournalEntry["action"],
    from: string | null,
    to: string | null,
    durationMs: number,
  ): boolean => {
    const entry = lastEntry();
    if (
      entry === undefined ||
      entry.action !== action ||
      entry.fromVersion !== from ||
      entry.toVersion !== to ||
      entry.durationMs !== durationMs
    ) {
      fail(
        step,
        "K7_journal_entry_content",
        `expected ${action} ${from ?? "null"}→${to ?? "null"} ${durationMs}ms, got ${JSON.stringify(entry ?? null)}`,
      );
      return false;
    }
    return true;
  };

  for (let step = 0; step < actions.length && failure === null; step += 1) {
    const action = actions[step]!;
    switch (action.kind) {
      case "activate": {
        const from = modelActive?.version ?? null;
        try {
          const duration = state.activate(action.candidate);
          if (action.candidate.artifact.poison) {
            fail(step, "K6_poisoned_apply_swallowed", "apply threw but activate returned");
            break;
          }
          modelActive = action.candidate;
          modelJournal += 1;
          if (duration !== CLOCK_STEP_MS) {
            fail(step, "K7_duration_not_clock_delta", `${duration}`);
            break;
          }
          if (!expectEntry(step, "activate", from, action.candidate.version, CLOCK_STEP_MS)) break;
          trace.push(`activate ok ${action.candidate.version}`);
        } catch (error) {
          if (!action.candidate.artifact.poison) {
            fail(step, "K5_activate_threw", errorMessage(error));
            break;
          }
          if (!sameArtifact(state.active(), modelActive)) {
            fail(
              step,
              "K6_poisoned_activate_left_active_set",
              `apply threw for ${action.candidate.version} yet active()=${state.active()?.version ?? "null"} while live=${live.version ?? "null"}`,
            );
            break;
          }
          trace.push(`activate rejected poison ${action.candidate.version}`);
        }
        break;
      }
      case "recordKnownGood": {
        try {
          state.recordKnownGood();
          if (modelActive === null) {
            fail(step, "K2_record_while_disabled_accepted", "");
            break;
          }
          modelKnownGood = modelActive;
          modelJournal += 1;
          if (!expectEntry(step, "record_known_good", modelActive.version, modelActive.version, 0))
            break;
          trace.push(`recordKnownGood ok ${modelActive.version}`);
        } catch (error) {
          if (modelActive !== null) {
            fail(step, "K2_record_threw_while_active", errorMessage(error));
            break;
          }
          trace.push("recordKnownGood rejected disabled");
        }
        break;
      }
      case "disable": {
        const from = modelActive?.version ?? null;
        try {
          const duration = state.disable();
          modelActive = null;
          modelJournal += 1;
          if (duration !== CLOCK_STEP_MS) {
            fail(step, "K7_duration_not_clock_delta", `${duration}`);
            break;
          }
          if (!expectEntry(step, "disable", from, null, CLOCK_STEP_MS)) break;
          trace.push(`disable ok from ${from ?? "null"}`);
        } catch (error) {
          fail(step, "K4_disable_threw", errorMessage(error));
        }
        break;
      }
      case "rollback": {
        const from = modelActive?.version ?? null;
        try {
          const duration = state.rollback();
          if (modelKnownGood === null) {
            fail(step, "K3_rollback_without_known_good_accepted", "");
            break;
          }
          if (modelKnownGood.artifact.poison) {
            fail(step, "K6_poisoned_apply_swallowed", "apply threw but rollback returned");
            break;
          }
          modelActive = modelKnownGood;
          modelJournal += 1;
          if (duration !== CLOCK_STEP_MS) {
            fail(step, "K7_duration_not_clock_delta", `${duration}`);
            break;
          }
          if (!expectEntry(step, "rollback", from, modelKnownGood.version, CLOCK_STEP_MS)) break;
          trace.push(`rollback ok ${modelKnownGood.version}`);
        } catch (error) {
          if (modelKnownGood === null) {
            trace.push("rollback rejected no-known-good");
            break;
          }
          if (modelKnownGood.artifact.poison) {
            if (!sameArtifact(state.active(), modelActive)) {
              fail(
                step,
                "K6_poisoned_rollback_left_active_set",
                `active()=${state.active()?.version ?? "null"}`,
              );
              break;
            }
            trace.push(`rollback rejected poison ${modelKnownGood.version}`);
            break;
          }
          fail(step, "K3_rollback_threw_with_known_good", errorMessage(error));
        }
        break;
      }
      case "drill": {
        const preActive: VersionedArtifact<StressArtifact> | null = modelActive;
        const verifier = {
          knownGoodLive: () =>
            live.version === preActive?.version && live.artifact === preActive?.artifact,
          badLive: () =>
            live.version === action.bad.version && live.artifact === action.bad.artifact,
        };
        const journalBefore = state.journal().length;
        const preDrillVerifierHolds = preActive !== null && verifier.knownGoodLive();
        try {
          const result = runRollbackDrill(state, action.bad, verifier);
          if (preActive === null) {
            fail(step, "K8_drill_ran_while_disabled", "");
            break;
          }
          if (!preDrillVerifierHolds) {
            fail(step, "K8_drill_ran_with_failing_precheck", "");
            break;
          }
          if (action.bad.artifact.poison) {
            fail(
              step,
              "K6_poisoned_apply_swallowed",
              "drill activated poisoned candidate and returned",
            );
            break;
          }
          modelKnownGood = preActive;
          modelActive = preActive;
          modelJournal += 4;
          if (!result.recovered || !result.badWasLive) {
            fail(step, "K8_drill_not_recovered", JSON.stringify(result));
            break;
          }
          if (
            result.knownGoodVersion !== preActive.version ||
            result.badVersion !== action.bad.version
          ) {
            fail(step, "K8_drill_versions", JSON.stringify(result));
            break;
          }
          if (result.environment !== "linux-test") {
            fail(step, "K8_drill_environment", result.environment);
            break;
          }
          if (
            containsNonFinite(result) ||
            result.timeToDisableMs < 0 ||
            result.timeToRollbackMs < 0
          ) {
            fail(step, "K8_drill_non_finite", JSON.stringify(result));
            break;
          }
          const tail = state
            .journal()
            .slice(journalBefore)
            .map((entry) => entry.action);
          if (tail.join(",") !== "record_known_good,activate,disable,rollback") {
            fail(step, "K8_drill_journal_shape", tail.join(","));
            break;
          }
          trace.push(`drill ok ${preActive.version}->${action.bad.version}`);
        } catch (error) {
          if (preActive === null) {
            trace.push("drill rejected disabled");
            break;
          }
          if (!preDrillVerifierHolds) {
            trace.push("drill rejected precheck");
            break;
          }
          if (action.bad.artifact.poison) {
            // recordKnownGood succeeded before the poisoned activate threw.
            modelKnownGood = preActive;
            modelJournal += 1;
            if (!sameArtifact(state.active(), preActive)) {
              fail(
                step,
                "K6_poisoned_drill_left_active_set",
                `apply threw for ${action.bad.version} yet active()=${state.active()?.version ?? "null"} while live=${live.version ?? "null"}`,
              );
              break;
            }
            trace.push(`drill rejected poison ${action.bad.version}`);
            break;
          }
          fail(step, "K8_drill_threw", errorMessage(error));
        }
        break;
      }
      case "mutateJournal": {
        const copy = state.journal() as RollbackJournalEntry[];
        const before = copy.length;
        copy.push({
          subsystem: "forged",
          action: "activate",
          fromVersion: null,
          toVersion: "forged",
          atEpochMs: 0,
          durationMs: 0,
        });
        if (state.journal().length !== before) {
          fail(step, "K7_journal_not_a_copy", "push on journal() result changed controller");
          break;
        }
        trace.push(`mutateJournal ok ${before}`);
        break;
      }
    }
    if (failure === null) checkCore(step, action.kind);
  }
  return { seed, actions, trace, failure };
}
