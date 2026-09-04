import { describe, expect, it } from "vitest";
import {
  HardCaseQueue,
  type HardCaseEvent,
  type HardCaseEventLog,
  type HardCaseReport,
} from "../src/index.js";

/**
 * Structural audit #2 (shared-packages-ops) — reproducing tests for the
 * mutate-before-append ordering in HardCaseQueue.ingest/transition.
 * Synthetic fixtures only (SYNTHETIC-TEST-FIXTURE subject keys).
 */

let tick = 0;
const clock = (): string => new Date(1756500000000 + ++tick * 1000).toISOString();

function report(subjectKey: string): HardCaseReport {
  return {
    source: "user_feedback",
    subjectKey,
    severity: "medium",
    evidence: {
      source: "user_feedback",
      ref: "SYNTHETIC-TEST-FIXTURE/feedback",
      detail: "synthetic hard case",
      observedAtIso: "2026-08-29T00:00:00.000Z",
    },
  };
}

/** Durable-log stand-in whose next append can be made to fail once. */
class FlakyEventLog implements HardCaseEventLog {
  private readonly events: HardCaseEvent[] = [];
  failNext = false;
  append(event: HardCaseEvent): void {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("EIO: simulated durable-log write failure");
    }
    this.events.push(event);
  }
  readAll(): HardCaseEvent[] {
    return [...this.events];
  }
}

describe("AUDIT HardCaseQueue: a failed durable append must not leave divergent in-memory state", () => {
  it("ingest whose log.append throws does not retain the entry in memory / ledger", () => {
    const log = new FlakyEventLog();
    const queue = HardCaseQueue.open(log, clock);
    log.failNext = true;
    expect(() => queue.ingest(report("SYNTHETIC-TEST-FIXTURE-a"))).toThrow(/EIO/);

    // Nothing reached the durable log, so nothing may be claimed in memory.
    expect(log.readAll()).toHaveLength(0);
    expect(queue.list(), "entry visible in memory but absent from durable log").toHaveLength(0);
    expect(queue.ledger().ingested, "ledger counts an ingest the log never recorded").toBe(0);
  });

  it("one transient append failure must not make the log permanently unopenable", () => {
    const log = new FlakyEventLog();
    const queue = HardCaseQueue.open(log, clock);
    queue.ingest(report("SYNTHETIC-TEST-FIXTURE-1"));
    log.failNext = true;
    expect(() => queue.ingest(report("SYNTHETIC-TEST-FIXTURE-2"))).toThrow(/EIO/);
    // Operator retries after the transient failure; this append succeeds.
    queue.ingest(report("SYNTHETIC-TEST-FIXTURE-3"));

    // A failed append must not consume a seq number: the durable log must stay
    // contiguous (seq 1, 2) so the reader can reopen it after the retry.
    expect(() => HardCaseQueue.open(log, clock)).not.toThrow();
  });

  it("replaying the durable log reproduces the live queue (log is the source of truth)", () => {
    const log = new FlakyEventLog();
    const queue = HardCaseQueue.open(log, clock);
    queue.ingest(report("SYNTHETIC-TEST-FIXTURE-1"));
    log.failNext = true;
    expect(() => queue.ingest(report("SYNTHETIC-TEST-FIXTURE-2"))).toThrow(/EIO/);

    const liveIds = queue.list().map((e) => e.id);
    const replayed = HardCaseQueue.open(new ReplayLog(log.readAll()), clock);
    expect(replayed.list().map((e) => e.id)).toEqual(liveIds);
    expect(replayed.ledger()).toEqual(queue.ledger());
  });
});

class ReplayLog implements HardCaseEventLog {
  constructor(private readonly events: HardCaseEvent[]) {}
  append(event: HardCaseEvent): void {
    this.events.push(event);
  }
  readAll(): HardCaseEvent[] {
    return [...this.events];
  }
}
