import { routeCategory } from "./routing.js";
import { assertTransition } from "./stateMachine.js";
import {
  HARD_CASE_SEVERITIES,
  type HardCaseCategory,
  type HardCaseEntry,
  type HardCaseEvent,
  type HardCaseLedger,
  type HardCaseReport,
  type HardCaseSeverity,
  type HardCaseSource,
  type HardCaseState,
  type IngestOutcome,
} from "./types.js";

/** Dedup key: same source + routed category + subject = one case. */
export function fingerprintOf(
  source: HardCaseSource,
  category: HardCaseCategory,
  subjectKey: string,
): string {
  return `${source}::${category}::${subjectKey}`;
}

export class HardCaseNotFoundError extends Error {
  constructor(readonly entryId: string) {
    super(`hard case ${entryId} not found`);
    this.name = "HardCaseNotFoundError";
  }
}

/** Append-only event sink; a queue's full state is the replay of its log. */
export interface HardCaseEventLog {
  append(event: HardCaseEvent): void;
  readAll(): HardCaseEvent[];
}

export class InMemoryEventLog implements HardCaseEventLog {
  private readonly events: HardCaseEvent[] = [];
  append(event: HardCaseEvent): void {
    this.events.push(event);
  }
  readAll(): HardCaseEvent[] {
    return [...this.events];
  }
}

function severityMax(a: HardCaseSeverity, b: HardCaseSeverity): HardCaseSeverity {
  return HARD_CASE_SEVERITIES.indexOf(a) >= HARD_CASE_SEVERITIES.indexOf(b) ? a : b;
}

export interface IngestResult {
  outcome: IngestOutcome;
  entry: HardCaseEntry;
}

/** Pure resolution of a report against current state — nothing is mutated. */
type IngestPlan = { category: HardCaseCategory; fingerprint: string } & (
  | { outcome: "created"; existing: undefined }
  | { outcome: "merged" | "regression_reopened"; existing: HardCaseEntry }
);

export class HardCaseQueue {
  private readonly byId = new Map<string, HardCaseEntry>();
  private readonly byFingerprint = new Map<string, string>();
  private seq = 0;
  private readonly counts: HardCaseLedger = {
    ingested: 0,
    created: 0,
    merged: 0,
    regressionReopened: 0,
  };

  private constructor(
    private readonly log: HardCaseEventLog,
    private readonly now: () => string,
  ) {}

  static open(
    log: HardCaseEventLog,
    now: () => string = () => new Date().toISOString(),
  ): HardCaseQueue {
    const queue = new HardCaseQueue(log, now);
    for (const event of log.readAll()) {
      if (event.seq !== queue.seq + 1) {
        throw new Error(
          `hard-case log corrupt: expected seq ${queue.seq + 1}, found ${event.seq} — refusing to open (events must never be lost silently)`,
        );
      }
      if (event.type === "ingested") {
        queue.applyIngest(queue.planIngest(event.report), event.report, event.atIso, event.entryId);
      } else {
        queue.applyTransition(event.entryId, event.to, event.actor, event.note, event.atIso);
      }
      queue.seq = event.seq;
    }
    return queue;
  }

  /**
   * Every report is accounted for: it either creates a case, merges into an
   * open case, or reopens a resolved case as a regression. There is no code
   * path that returns without one of those three outcomes.
   *
   * Durability first: the event is validated and appended to the log BEFORE
   * memory or `seq` change, so a failed append leaves the live queue exactly
   * equal to a replay of its log and the sequence has no gap.
   */
  ingest(report: HardCaseReport): IngestResult {
    const atIso = this.now();
    const plan = this.planIngest(report);
    const entryId = plan.existing?.id ?? `hc-${String(this.seq + 1).padStart(6, "0")}`;
    const event: HardCaseEvent = {
      seq: this.seq + 1,
      type: "ingested",
      atIso,
      report,
      outcome: plan.outcome,
      entryId,
    };
    this.log.append(event);
    const result = this.applyIngest(plan, report, atIso, entryId);
    this.seq = event.seq;
    return result;
  }

  transition(entryId: string, to: HardCaseState, actor: string, note: string): HardCaseEntry {
    const atIso = this.now();
    const from = this.get(entryId).state;
    assertTransition(entryId, from, to);
    const event: HardCaseEvent = {
      seq: this.seq + 1,
      type: "transitioned",
      atIso,
      entryId,
      from,
      to,
      actor,
      note,
    };
    this.log.append(event);
    const entry = this.applyTransition(entryId, to, actor, note, atIso);
    this.seq = event.seq;
    return entry;
  }

  get(entryId: string): HardCaseEntry {
    const entry = this.byId.get(entryId);
    if (entry === undefined) throw new HardCaseNotFoundError(entryId);
    return entry;
  }

  list(filter?: {
    state?: HardCaseState;
    category?: HardCaseCategory;
    source?: HardCaseSource;
  }): HardCaseEntry[] {
    return [...this.byId.values()]
      .filter(
        (entry) =>
          (filter?.state === undefined || entry.state === filter.state) &&
          (filter?.category === undefined || entry.category === filter.category) &&
          (filter?.source === undefined || entry.source === filter.source),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  ledger(): HardCaseLedger {
    return { ...this.counts };
  }

  /** Accounting invariant: nothing ingested is ever unaccounted for. */
  assertNoSilentDrops(): void {
    const { ingested, created, merged, regressionReopened } = this.counts;
    if (ingested !== created + merged + regressionReopened) {
      throw new Error(
        `hard-case ledger violation: ingested=${ingested} != created=${created} + merged=${merged} + reopened=${regressionReopened}`,
      );
    }
    if (created !== this.byId.size) {
      throw new Error(
        `hard-case ledger violation: created=${created} but ${this.byId.size} entries present`,
      );
    }
  }

  private planIngest(report: HardCaseReport): IngestPlan {
    const category = routeCategory(report);
    const fingerprint = fingerprintOf(report.source, category, report.subjectKey);
    const existingId = this.byFingerprint.get(fingerprint);
    if (existingId === undefined) {
      return { category, fingerprint, existing: undefined, outcome: "created" };
    }
    const existing = this.byId.get(existingId);
    if (existing === undefined) throw new HardCaseNotFoundError(existingId);
    if (existing.state === "resolved") {
      assertTransition(existing.id, "resolved", "regression");
      return { category, fingerprint, existing, outcome: "regression_reopened" };
    }
    return { category, fingerprint, existing, outcome: "merged" };
  }

  private applyIngest(
    plan: IngestPlan,
    report: HardCaseReport,
    atIso: string,
    entryId: string,
  ): IngestResult {
    const { category, fingerprint } = plan;
    this.counts.ingested += 1;
    if (plan.outcome === "created") {
      const entry: HardCaseEntry = {
        id: entryId,
        fingerprint,
        source: report.source,
        category,
        subjectKey: report.subjectKey,
        state: "new",
        severity: report.severity,
        occurrenceCount: 1,
        evidence: [report.evidence],
        createdAtIso: atIso,
        updatedAtIso: atIso,
        regressionCount: 0,
        history: [],
      };
      this.byId.set(entry.id, entry);
      this.byFingerprint.set(fingerprint, entry.id);
      this.counts.created += 1;
      return { outcome: "created", entry };
    }
    const entry = plan.existing;
    entry.occurrenceCount += 1;
    entry.evidence.push(report.evidence);
    entry.severity = severityMax(entry.severity, report.severity);
    entry.updatedAtIso = atIso;
    if (plan.outcome === "regression_reopened") {
      // A resolved case that recurs is a REGRESSION — it reopens, it is
      // never absorbed into the closed case.
      assertTransition(entry.id, entry.state, "regression");
      entry.state = "regression";
      entry.regressionCount += 1;
      entry.history.push({
        from: "resolved",
        to: "regression",
        actor: "system:dedup",
        note: `recurred via ${report.source} (${report.evidence.ref})`,
        atIso,
      });
      this.counts.regressionReopened += 1;
      return { outcome: "regression_reopened", entry };
    }
    this.counts.merged += 1;
    return { outcome: "merged", entry };
  }

  private applyTransition(
    entryId: string,
    to: HardCaseState,
    actor: string,
    note: string,
    atIso: string,
  ): HardCaseEntry {
    const entry = this.byId.get(entryId);
    if (entry === undefined) throw new HardCaseNotFoundError(entryId);
    assertTransition(entry.id, entry.state, to);
    entry.history.push({ from: entry.state, to, actor, note, atIso });
    entry.state = to;
    entry.updatedAtIso = atIso;
    if (to === "regression") entry.regressionCount += 1;
    return entry;
  }
}
