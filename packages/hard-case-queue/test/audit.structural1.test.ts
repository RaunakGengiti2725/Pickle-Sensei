import { describe, expect, it } from "vitest";
import {
  HardCaseQueue,
  InMemoryEventLog,
  type HardCaseEvent,
  type HardCaseEventLog,
  type HardCaseReport,
} from "../src/index.js";

/**
 * STRUCTURAL AUDIT (shared-packages-ops, pass 1). Durability contract:
 * "a queue's full state is the replay of its log" (queue.ts). If the append
 * fails, in-memory state must not diverge from the durable log.
 */

let tick = 0;
const clock = (): string => new Date(1756500000000 + ++tick * 1000).toISOString();

function report(overrides: Partial<HardCaseReport> = {}): HardCaseReport {
  return {
    source: "user_feedback",
    subjectKey: "rec-audit-0001",
    severity: "medium",
    evidence: {
      source: overrides.source ?? "user_feedback",
      ref: "feedback/fb-audit",
      detail: "synthetic audit report",
      observedAtIso: "2026-08-29T00:00:00.000Z",
    },
    ...overrides,
  };
}

/** Log whose append fails after N successful writes (disk full, EACCES...). */
class FailingLog implements HardCaseEventLog {
  private readonly inner = new InMemoryEventLog();
  private writes = 0;
  constructor(private readonly failAfter: number) {}
  append(event: HardCaseEvent): void {
    this.writes += 1;
    if (this.writes > this.failAfter) throw new Error("ENOSPC: simulated append failure");
    this.inner.append(event);
  }
  readAll(): HardCaseEvent[] {
    return this.inner.readAll();
  }
}

describe("audit: HardCaseQueue state vs durable log on append failure", () => {
  it("a failed ingest append leaves no phantom entry in the in-memory queue", () => {
    const log = new FailingLog(0);
    const queue = HardCaseQueue.open(log, clock);
    expect(() => queue.ingest(report())).toThrow(/ENOSPC/);
    // Durable log has nothing, so the queue must claim nothing.
    expect(log.readAll()).toHaveLength(0);
    expect(queue.list()).toHaveLength(0);
    expect(queue.ledger().ingested).toBe(0);
    // And a replay from the same log must agree with the live instance.
    const replayed = HardCaseQueue.open(log, clock);
    expect(replayed.list()).toEqual(queue.list());
    expect(replayed.ledger()).toEqual(queue.ledger());
  });

  it("a failed transition append does not advance state that the log never saw", () => {
    const log = new FailingLog(1);
    const queue = HardCaseQueue.open(log, clock);
    const { entry } = queue.ingest(report());
    expect(() => queue.transition(entry.id, "triaged", "auditor", "triage")).toThrow(/ENOSPC/);
    expect(queue.get(entry.id).state).toBe("new");
    const replayed = HardCaseQueue.open(log, clock);
    expect(replayed.get(entry.id).state).toBe(queue.get(entry.id).state);
  });

  it("a failed append does not consume a sequence number (next event stays contiguous)", () => {
    const log = new FailingLog(1);
    const queue = HardCaseQueue.open(log, clock);
    queue.ingest(report());
    expect(() => queue.ingest(report({ subjectKey: "rec-audit-0002" }))).toThrow(/ENOSPC/);
    // Swap to a working log to observe the next seq the queue would write.
    const captured: HardCaseEvent[] = [];
    (queue as unknown as { log: HardCaseEventLog }).log = {
      append: (e) => captured.push(e),
      readAll: () => [],
    };
    queue.ingest(report({ subjectKey: "rec-audit-0003" }));
    expect(captured[0]?.seq).toBe(2);
  });
});
