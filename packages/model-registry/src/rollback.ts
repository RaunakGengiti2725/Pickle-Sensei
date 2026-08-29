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

export interface RollbackJournalEntry {
  subsystem: string;
  action: RollbackAction;
  fromVersion: string | null;
  toVersion: string | null;
  atEpochMs: number;
  durationMs: number;
}

/** Millisecond monotonic-ish clock; injectable for deterministic tests. */
export type DurationClock = () => number;

const defaultClock: DurationClock = () => performance.now();

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
    this.activeState = options.initial;
    this.applyChange(options.initial.artifact, options.initial.version);
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
    this.log("record_known_good", this.activeState.version, this.activeState.version, 0);
  }

  /** Puts a candidate version in service. */
  public activate(candidate: VersionedArtifact<T>): number {
    const from = this.activeState?.version ?? null;
    const started = this.clock();
    this.activeState = candidate;
    this.applyChange(candidate.artifact, candidate.version);
    const durationMs = this.clock() - started;
    this.log("activate", from, candidate.version, durationMs);
    return durationMs;
  }

  /** Kill switch: removes the subsystem from service. Returns duration ms. */
  public disable(): number {
    const from = this.activeState?.version ?? null;
    const started = this.clock();
    this.activeState = null;
    this.applyChange(null, null);
    const durationMs = this.clock() - started;
    this.log("disable", from, null, durationMs);
    return durationMs;
  }

  /** Restores the recorded known-good version. Returns duration ms. */
  public rollback(): number {
    if (this.knownGoodState === null) {
      throw new Error(`${this.subsystem}: no known-good version recorded; cannot roll back`);
    }
    const from = this.activeState?.version ?? null;
    const started = this.clock();
    this.activeState = this.knownGoodState;
    this.applyChange(this.knownGoodState.artifact, this.knownGoodState.version);
    const durationMs = this.clock() - started;
    this.log("rollback", from, this.knownGoodState.version, durationMs);
    return durationMs;
  }

  private log(
    action: RollbackAction,
    fromVersion: string | null,
    toVersion: string | null,
    durationMs: number,
  ): void {
    this.journalEntries.push({
      subsystem: this.subsystem,
      action,
      fromVersion,
      toVersion,
      atEpochMs: Date.now(),
      durationMs,
    });
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
