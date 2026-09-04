/**
 * Release-state rollback controller (wave I, i06-rollback-drill).
 *
 * One generic mechanism for every code-selected subsystem (model bundle
 * manifest, scoring model config, fault model, drill mappings, capture
 * envelope thresholds, auto-detect policy, …): the currently active
 * versioned artifact is tracked, a KNOWN-GOOD version can be recorded, a
 * kill switch (`disable`) removes the subsystem from service immediately,
 * and `rollback` restores the recorded known-good version. Every transition
 * is journaled with a wall-clock duration so rollback drills can measure
 * time-to-disable and time-to-rollback.
 *
 * STATE CONTRACT: `active()` describes what is live. A transition commits to
 * controller state only after `apply` has returned; when `apply` throws, the
 * controller keeps its previous state, journals the failed attempt with the
 * error, and rethrows.
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
  /** Version the transition moved to — or, for a failed one, attempted. */
  toVersion: string | null;
  atEpochMs: number;
  durationMs: number;
  outcome: RollbackOutcome;
  /** Message of the error `apply` threw; null when the transition applied. */
  error: string | null;
}

/**
 * Epoch-millisecond clock; injectable for deterministic tests. Supplies both
 * the journal timestamps and the transition durations.
 */
export type DurationClock = () => number;

const defaultClock: DurationClock = () => Date.now();

function snapshot<T>(artifact: VersionedArtifact<T>): VersionedArtifact<T> {
  return Object.freeze({ version: artifact.version, artifact: artifact.artifact });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Tracks the active artifact for one subsystem. `apply` is the ONLY path by
 * which a selection change reaches live behavior: it receives the artifact
 * now in service, or null when the subsystem is disabled via kill switch.
 *
 * Artifacts handed in are snapshotted (the `{version, artifact}` pair is
 * copied and frozen; the artifact payload itself is shared by reference), so
 * later mutation of the caller's object cannot change what the controller
 * reports as active or known-good.
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
    return this.activeState;
  }

  public knownGood(): VersionedArtifact<T> | null {
    return this.knownGoodState;
  }

  public journal(): readonly RollbackJournalEntry[] {
    return [...this.journalEntries];
  }

  /** Marks the CURRENTLY ACTIVE version as known-good. */
  public recordKnownGood(): void {
    if (this.activeState === null) {
      throw new Error(`${this.subsystem}: cannot record known-good while disabled`);
    }
    this.knownGoodState = this.activeState;
    this.log({
      action: "record_known_good",
      fromVersion: this.activeState.version,
      toVersion: this.activeState.version,
      atEpochMs: this.clock(),
      durationMs: 0,
      outcome: "applied",
      error: null,
    });
  }

  /** Puts a candidate version in service. */
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
    return this.transition("rollback", this.knownGoodState);
  }

  /**
   * Applies `next` to live behavior and commits it as the active state only
   * once `apply` has returned. A throwing `apply` leaves the active state as
   * it was, journals the failed attempt, and rethrows the error.
   */
  private transition(action: RollbackAction, next: VersionedArtifact<T> | null): number {
    const fromVersion = this.activeState?.version ?? null;
    const toVersion = next?.version ?? null;
    const started = this.clock();
    try {
      this.applyChange(next?.artifact ?? null, toVersion);
    } catch (error) {
      this.log({
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
    this.activeState = next;
    const durationMs = this.clock() - started;
    this.log({
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

  private log(entry: Omit<RollbackJournalEntry, "subsystem">): void {
    this.journalEntries.push(Object.freeze({ subsystem: this.subsystem, ...entry }));
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
 *
 * The bad candidate must carry a version distinct from the active one: a
 * drill whose "bad" version equals the known-good version would roll back to
 * itself and prove nothing. That is refused before any state changes.
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
      `${state.subsystem}: drill candidate version "${badCandidate.version}" is the active version; a drill needs a distinct bad version`,
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
