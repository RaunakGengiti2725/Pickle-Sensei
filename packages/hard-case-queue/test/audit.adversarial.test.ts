/**
 * Audit harness (execution pass 2, shared-packages-ops). New file only; no
 * production code changed. `it.fails` cases pin REPRODUCED defects — they
 * pass while the defect exists and start failing once it is fixed.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileEventLog,
  HARD_CASE_CATEGORIES,
  HARD_CASE_SEVERITIES,
  HARD_CASE_SOURCES,
  HARD_CASE_STATES,
  HARD_CASE_TRANSITIONS,
  HardCaseQueue,
  HardCaseRoutingError,
  HardCaseTransitionError,
  InMemoryEventLog,
  SOURCE_DEFAULT_CATEGORY,
  routeCategory,
  type HardCaseEvent,
  type HardCaseReport,
  type HardCaseState,
} from "../src/index.js";

let tick = 0;
const clock = (): string => new Date(1756500000000 + ++tick * 1000).toISOString();

function report(overrides: Partial<HardCaseReport> = {}): HardCaseReport {
  return {
    source: "user_feedback",
    subjectKey: "rec-1",
    severity: "medium",
    evidence: {
      source: overrides.source ?? "user_feedback",
      ref: "feedback/fb-001",
      detail: "verdict disputed",
      observedAtIso: "2026-08-29T00:00:00.000Z",
    },
    ...overrides,
  };
}

function ingestedEvent(
  seq: number,
  entryId: string,
  rep: HardCaseReport,
  outcome: "created" | "merged" | "regression_reopened" = "created",
): HardCaseEvent {
  return { seq, type: "ingested", atIso: clock(), report: rep, outcome, entryId };
}

/** Event log whose append fails on demand (simulates disk-full / EIO). */
class FlakyLog extends InMemoryEventLog {
  failNext = false;
  override append(event: HardCaseEvent): void {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("EIO: simulated append failure");
    }
    super.append(event);
  }
}

describe("audit: replay trusts logged entryId/outcome without re-validation", () => {
  it.fails(
    "FINDING: two logged 'created' events sharing an entryId silently overwrite one another on open()",
    () => {
      const log = new InMemoryEventLog();
      log.append(ingestedEvent(1, "hc-000001", report({ subjectKey: "rec-A" })));
      log.append(ingestedEvent(2, "hc-000001", report({ subjectKey: "rec-B" })));
      const queue = HardCaseQueue.open(log, clock);
      // Either open() must refuse the inconsistent log, or both cases must survive.
      expect(queue.list()).toHaveLength(2);
    },
  );

  it("evidence: the overwritten replay leaves the ledger inconsistent with the entry map", () => {
    const log = new InMemoryEventLog();
    log.append(ingestedEvent(1, "hc-000001", report({ subjectKey: "rec-A" })));
    log.append(ingestedEvent(2, "hc-000001", report({ subjectKey: "rec-B" })));
    const queue = HardCaseQueue.open(log, clock);
    expect(queue.ledger()).toEqual({ ingested: 2, created: 2, merged: 0, regressionReopened: 0 });
    expect(queue.list()).toHaveLength(1);
    expect(queue.list()[0]!.subjectKey).toBe("rec-B");
    expect(() => queue.assertNoSilentDrops()).toThrow(/ledger violation/);
  });

  it.fails("FINDING: replay does not compare the logged outcome with the recomputed one", () => {
    const log = new InMemoryEventLog();
    // Logged as 'merged' into hc-000001 although nothing exists yet: a
    // divergent-writer log. Replay should refuse it.
    log.append(ingestedEvent(1, "hc-000001", report(), "merged"));
    expect(() => HardCaseQueue.open(log, clock)).toThrow();
  });
});

describe("audit: durability of ingest/transition when the log write fails", () => {
  it.fails(
    "FINDING: a failed append leaves in-memory state mutated (ingest is not atomic w.r.t. the log)",
    () => {
      const log = new FlakyLog();
      const queue = HardCaseQueue.open(log, clock);
      log.failNext = true;
      expect(() => queue.ingest(report())).toThrow(/EIO/);
      // Nothing was persisted, so the queue must not claim the case exists.
      expect(queue.list()).toHaveLength(0);
      expect(queue.ledger().ingested).toBe(0);
    },
  );

  it("evidence: after one failed append the persisted log can never be reopened (seq gap)", () => {
    const log = new FlakyLog();
    const queue = HardCaseQueue.open(log, clock);
    log.failNext = true;
    expect(() => queue.ingest(report())).toThrow(/EIO/);
    // Next write succeeds — but carries seq 2 while the log holds nothing.
    queue.ingest(report({ subjectKey: "rec-2" }));
    expect(log.readAll().map((e) => e.seq)).toEqual([2]);
    expect(() => HardCaseQueue.open(log, clock)).toThrow(/expected seq 1, found 2/);
  });
});

describe("audit: runtime validation of untyped report fields", () => {
  it.fails("FINDING: an out-of-vocabulary severity is accepted and stored verbatim", () => {
    const queue = HardCaseQueue.open(new InMemoryEventLog(), clock);
    const bogus = report({ severity: "sev-9" as unknown as HardCaseReport["severity"] });
    expect(() => queue.ingest(bogus)).toThrow();
  });

  it("evidence: bogus severity poisons severityMax for later merges", () => {
    const queue = HardCaseQueue.open(new InMemoryEventLog(), clock);
    queue.ingest(report({ severity: "sev-9" as unknown as HardCaseReport["severity"] }));
    const merged = queue.ingest(report({ severity: "critical" }));
    // indexOf("sev-9") === -1, so "critical" (index 3) wins here — but a
    // first report of "critical" followed by "sev-9" keeps "critical" too;
    // the point is that the stored value is never a member of the vocabulary.
    expect(merged.entry.severity).toBe("critical");
    const q2 = HardCaseQueue.open(new InMemoryEventLog(), clock);
    const first = q2.ingest(report({ severity: "sev-9" as unknown as HardCaseReport["severity"] }));
    expect(HARD_CASE_SEVERITIES.includes(first.entry.severity)).toBe(false);
  });

  it("empty subjectKey is accepted (documented here as observed behaviour)", () => {
    const queue = HardCaseQueue.open(new InMemoryEventLog(), clock);
    const a = queue.ingest(report({ subjectKey: "" }));
    const b = queue.ingest(report({ subjectKey: "" }));
    expect(a.outcome).toBe("created");
    expect(b.outcome).toBe("merged");
  });
});

describe("audit: invariants that HOLD", () => {
  it("every non-listed transition is rejected from every state", () => {
    for (const from of HARD_CASE_STATES) {
      for (const to of HARD_CASE_STATES) {
        const queue = HardCaseQueue.open(new InMemoryEventLog(), clock);
        const { entry } = queue.ingest(report());
        // Drive the entry into `from` via the legal path.
        const path: Record<HardCaseState, HardCaseState[]> = {
          new: [],
          triaged: ["triaged"],
          "in-review": ["triaged", "in-review"],
          resolved: ["triaged", "in-review", "resolved"],
          regression: ["triaged", "in-review", "resolved", "regression"],
        };
        for (const step of path[from]) queue.transition(entry.id, step, "a", "n");
        expect(queue.get(entry.id).state).toBe(from);
        if (HARD_CASE_TRANSITIONS[from].includes(to)) {
          expect(queue.transition(entry.id, to, "a", "n").state).toBe(to);
        } else {
          expect(() => queue.transition(entry.id, to, "a", "n")).toThrow(HardCaseTransitionError);
          expect(queue.get(entry.id).state).toBe(from);
        }
      }
    }
  });

  it("routing: invalid categoryHint throws, stageHint normalises, defaults per source", () => {
    expect(() =>
      routeCategory(
        report({ categoryHint: "ball" as unknown as NonNullable<HardCaseReport["categoryHint"]> }),
      ),
    ).toThrow(HardCaseRoutingError);
    expect(routeCategory(report({ stageHint: "  ball " }))).toBe("BALL");
    expect(routeCategory(report({ stageHint: "not-a-stage" }))).toBe("OTHER");
    for (const source of HARD_CASE_SOURCES) {
      expect(routeCategory(report({ source }))).toBe(SOURCE_DEFAULT_CATEGORY[source]);
      expect(HARD_CASE_CATEGORIES).toContain(SOURCE_DEFAULT_CATEGORY[source]);
    }
  });

  it("10k reports over 500 subjects: ledger balances and replay is byte-identical", () => {
    const log = new InMemoryEventLog();
    const queue = HardCaseQueue.open(log, clock);
    for (let i = 0; i < 10_000; i++) {
      const source = HARD_CASE_SOURCES[i % HARD_CASE_SOURCES.length]!;
      queue.ingest(report({ source, subjectKey: `s-${i % 500}` }));
    }
    queue.assertNoSilentDrops();
    const ledger = queue.ledger();
    expect(ledger.ingested).toBe(10_000);
    expect(ledger.created + ledger.merged + ledger.regressionReopened).toBe(10_000);
    const replayed = HardCaseQueue.open(log, clock);
    replayed.assertNoSilentDrops();
    expect(JSON.stringify(replayed.list())).toBe(JSON.stringify(queue.list()));
    expect(replayed.ledger()).toEqual(ledger);
  });

  it("FileEventLog refuses truncated / structurally-invalid lines and seq gaps", () => {
    const dir = mkdtempSync(join(tmpdir(), "hcq-audit-"));
    const truncated = join(dir, "truncated.jsonl");
    writeFileSync(
      truncated,
      `${JSON.stringify(ingestedEvent(1, "hc-000001", report()))}\n{"seq":2,"ty`,
    );
    expect(() => HardCaseQueue.open(new FileEventLog(truncated), clock)).toThrow(
      /corrupt at line 2/,
    );

    const shape = join(dir, "shape.jsonl");
    writeFileSync(shape, `{"seq":"1","type":"ingested"}\n`);
    expect(() => HardCaseQueue.open(new FileEventLog(shape), clock)).toThrow(
      /not a hard-case event/,
    );

    const gap = join(dir, "gap.jsonl");
    writeFileSync(
      gap,
      `${JSON.stringify(ingestedEvent(1, "hc-000001", report()))}\n${JSON.stringify(
        ingestedEvent(3, "hc-000003", report({ subjectKey: "x" })),
      )}\n`,
    );
    expect(() => HardCaseQueue.open(new FileEventLog(gap), clock)).toThrow(
      /expected seq 2, found 3/,
    );

    const missing = join(dir, "does-not-exist.jsonl");
    expect(HardCaseQueue.open(new FileEventLog(missing), clock).list()).toEqual([]);
  });

  it("resolved case that recurs reopens as regression and counts in the ledger", () => {
    const queue = HardCaseQueue.open(new InMemoryEventLog(), clock);
    const { entry } = queue.ingest(report());
    queue.transition(entry.id, "triaged", "a", "n");
    queue.transition(entry.id, "in-review", "a", "n");
    queue.transition(entry.id, "resolved", "a", "n");
    const again = queue.ingest(report({ severity: "critical" }));
    expect(again.outcome).toBe("regression_reopened");
    expect(again.entry.state).toBe("regression");
    expect(again.entry.severity).toBe("critical");
    expect(queue.ledger().regressionReopened).toBe(1);
    queue.assertNoSilentDrops();
  });
});
