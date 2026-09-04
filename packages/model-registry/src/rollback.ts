/**
 * Release-state rollback controller (wave I, i06-rollback-drill).
 *
 * One generic mechanism for every code-selected subsystem (model bundle
 * manifest, scoring model config, fault model, drill mappings, capture
 * envelope thresholds, auto-detect policy, …): the currently active
 * versioned artifact is tracked, a KNOWN-GOOD version can be recorded, a
 * kill switch (`disable`) removes the subsystem from service immediately,
 * and `rollback` restores the recorded known-good version. Every attempted
 * transition — applied or failed — is journaled with a duration so rollback
 * drills can measure time-to-disable and time-to-rollback.
 *
 * A transition is committed only after `apply` returns: if `apply` throws,
 * the previously active version stays active, the failure is journaled with
 * `outcome: "failed"`, and the error propagates to the caller. Accessors
 * return snapshots — no caller-owned object is ever aliased into or out of
 * the controller.
 *
 * HONESTY CONTRACT: durations measured through this controller are
 * in-process test-environment measurements (Linux CI/dev boxes). They are
 * NOT production rollback times — no network, no fleet propagation, no
 * client cache invalidation is included. Reports must say so.
 */

export interface VersionedArtifact<T> {
  version: string;
  artifact: T;
}

export type RollbackAction = "activate" | "record_known_good" | "disable" | "rollback";

export type RollbackOutcome = "applied" | "failed";

export interface RollbackJournalEntry {
  subsystem: string;
  action: RollbackAction;
  fromVersion: string | null;
  /** Version the transition targeted — the attempted target when `outcome` is "failed". */
  toVersion: string | null;
  /** Read from the controller's clock when the transition started. */
  atEpochMs: number;
  durationMs: number;
  outcome: RollbackOutcome;
  /** Message of the error `apply` threw; null when the transition was applied. */
  error: string | null;
}

/**
 * Millisecond epoch clock used for every journal timestamp and duration;
 * injectable for deterministic tests. This is the ONLY wall-clock source in
 * this module.
 */
export type DurationClock = () => number;

const defaultClock: DurationClock = () => Date.now();

function snapshot<T>(value: VersionedArtifact<T>): VersionedArtifact<T> {
  return { version: value.version, artifact: value.artifact };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Tracks the active artifact for one subsystem. `apply` is the ONLY path by
 * which a selection change reaches live behavior: it receives the artifact
 * now in service, or null when the subsystem is disabled via kill switch.
 */
export class SubsystemReleaseState<T> {
  public readonly subsystem: string;
  private readonly applyChange: (artifact: T | null, version: string | null) => void;
  private readonly clock: DurationClock;
  private activeState: VersionedArtifact<T> | null;
  private knownGoodState: VersionedArtifact<T> | null = null;
  private readonly journalEntries: RollbackJournalEntry[] = [];

  public constructor(options: {
    subsystem: string;
    initial: VersionedArtifact<T>;
    apply: (artifact: T | null, version: string | null) => void;
    clock?: DurationClock;
  }) {
    this.subsystem = options.subsystem;
    this.applyChange = options.apply;
    this.clock = options.clock ?? defaultClock;
    const initial = snapshot(options.initial);
    this.applyChange(initial.artifact, initial.version);
    this.activeState = initial;
  }

  public active(): VersionedArtifact<T> | null {
    return this.activeState === null ? null : snapshot(this.activeState);
  }

  public knownGood(): VersionedArtifact<T> | null {
    return this.knownGoodState === null ? null : snapshot(this.knownGoodState);
  }

  public journal(): readonly RollbackJournalEntry[] {
    return this.journalEntries.map((entry) => ({ ...entry }));
  }

  /** Marks the CURRENTLY ACTIVE version as known-good. */
  public recordKnownGood(): void {
    if (this.activeState === null) {
      throw new Error(`${this.subsystem}: cannot record known-good while disabled`);
    }
    const known = snapshot(this.activeState);
    this.knownGoodState = known;
    this.journalEntries.push({
      subsystem: this.subsystem,
      action: "record_known_good",
      fromVersion: known.version,
      toVersion: known.version,
      atEpochMs: this.clock(),
      durationMs: 0,
      outcome: "applied",
      error: null,
    });
  }

  /** Puts a candidate version in service. Returns duration ms. */
  public activate(candidate: VersionedArtifact<T>): number {
    return this.transition("activate", snapshot(candidate));
  }

  /** Kill switch: removes the subsystem from service. Returns duration ms. */
  public disable(): number {
    return this.transition("disable", null);
  }

  /** Restores the recorded known-good version. Returns duration ms. */
  public rollback(): number {
    if (this.knownGoodState === null) {
      throw new Error(`${this.subsystem}: no known-good version recorded; cannot roll back`);
    }
    return this.transition("rollback", snapshot(this.knownGoodState));
  }

  /**
   * Applies `target` to the live side and commits it as the active state only
   * once `apply` has returned. A throwing `apply` leaves the active state
   * untouched, journals the failed attempt and rethrows.
   */
  private transition(action: RollbackAction, target: VersionedArtifact<T> | null): number {
    const fromVersion = this.activeState?.version ?? null;
    const toVersion = target?.version ?? null;
    const started = this.clock();
    try {
      if (target === null) {
        this.applyChange(null, null);
      } else {
        this.applyChange(target.artifact, target.version);
      }
    } catch (error) {
      this.journalEntries.push({
        subsystem: this.subsystem,
        action,
        fromVersion,
        toVersion,
        atEpochMs: started,
        durationMs: this.clock() - started,
        outcome: "failed",
        error: errorMessage(error),
      });
      throw error;
    }
    this.activeState = target;
    const durationMs = this.clock() - started;
    this.journalEntries.push({
      subsystem: this.subsystem,
      action,
      fromVersion,
      toVersion,
      atEpochMs: started,
      durationMs,
      outcome: "applied",
      error: null,
    });
    return durationMs;
  }
}

/** Where a drill measurement was taken. Only test environments exist today. */
export type DrillEnvironment = "linux-test";

export interface RollbackDrillResult {
  subsystem: string;
  /** Honest provenance: these are in-process Linux test measurements. */
  environment: DrillEnvironment;
  knownGoodVersion: string;
  badVersion: string;
  timeToDisableMs: number;
  timeToRollbackMs: number;
  /** True only if the caller-supplied verifier confirmed known-good behavior
   * was actually restored after rollback. */
  recovered: boolean;
  /** True only if the verifier confirmed the bad candidate was actually in
   * service before the drill disabled it (the drill exercised a real change). */
  badWasLive: boolean;
}

/**
 * Runs the full drill against one subsystem:
 *   record known-good → activate bad candidate → kill switch → rollback,
 * measuring time-to-disable and time-to-rollback, and verifying through the
 * caller's own behavioral checks that the bad candidate was live and that
 * known-good behavior was restored.
 */
export function runRollbackDrill<T>(
  state: SubsystemReleaseState<T>,
  badCandidate: VersionedArtifact<T>,
  verify: {
    /** Must return true iff live behavior matches the known-good version. */
    knownGoodLive: () => boolean;
    /** Must return true iff live behavior matches the bad candidate. */
    badLive: () => boolean;
  },
): RollbackDrillResult {
  const active = state.active();
  if (active === null) {
    throw new Error(`${state.subsystem}: drill requires an active version`);
  }
  if (badCandidate.version === active.version) {
    throw new Error(
      `${state.subsystem}: bad candidate version "${badCandidate.version}" is already the active version; ` +
        "a drill must put a different version live to prove the kill switch and rollback",
    );
  }
  if (!verify.knownGoodLive()) {
    throw new Error(`${state.subsystem}: pre-drill state does not match known-good behavior`);
  }
  state.recordKnownGood();
  state.activate(badCandidate);
  const badWasLive = verify.badLive();
  const timeToDisableMs = state.disable();
  const timeToRollbackMs = state.rollback();
  const recovered =
    verify.knownGoodLive() && state.active()?.version === state.knownGood()?.version;
  return {
    subsystem: state.subsystem,
    environment: "linux-test",
    knownGoodVersion: active.version,
    badVersion: badCandidate.version,
    timeToDisableMs,
    timeToRollbackMs,
    recovered,
    badWasLive,
  };
}
