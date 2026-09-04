import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileEventLog,
  HardCaseQueue,
  InMemoryEventLog,
  type HardCaseEvent,
  type HardCaseEventLog,
  type HardCaseReport,
} from "../src/index.js";

let tick = 0;
const clock = (): string => new Date(1756500000000 + ++tick * 1000).toISOString();

function report(overrides: Partial<HardCaseReport> = {}): HardCaseReport {
  return {
    source: "user_feedback",
    subjectKey: "rec-6e06a3157947",
    severity: "medium",
    evidence: {
      source: overrides.source ?? "user_feedback",
      ref: "feedback/fb-001",
      detail: "user flagged the forehand-drive verdict as wrong",
      observedAtIso: "2026-08-29T00:00:00.000Z",
    },
    ...overrides,
  };
}

/** A durable sink whose next `append` fails (disk full, permission lost, …). */
class FlakyEventLog implements HardCaseEventLog {
  private readonly inner = new InMemoryEventLog();
  failNextAppend = false;
  append(event: HardCaseEvent): void {
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error("EIO: append failed");
    }
    this.inner.append(event);
  }
  readAll(): HardCaseEvent[] {
    return this.inner.readAll();
  }
}

/** The live queue must be indistinguishable from a fresh replay of its log. */
function expectLiveMatchesReplay(live: HardCaseQueue, log: HardCaseEventLog): void {
  const replayed = HardCaseQueue.open(log, clock);
  expect(live.list()).toEqual(replayed.list());
  expect(live.ledger()).toEqual(replayed.ledger());
  live.assertNoSilentDrops();
  replayed.assertNoSilentDrops();
}

describe("append atomicity (SPO-03)", () => {
  it("a failed ingest append leaves memory, ledger and seq untouched, and the log stays replayable", () => {
    const log = new FlakyEventLog();
    const queue = HardCaseQueue.open(log, clock);
    const a = queue.ingest(report({ subjectKey: "a" })).entry.id;

    log.failNextAppend = true;
    expect(() => queue.ingest(report({ subjectKey: "b" }))).toThrowError(/append failed/);

    expect(queue.list().map((e) => e.subjectKey)).toEqual(["a"]);
    expect(queue.ledger()).toEqual({ ingested: 1, created: 1, merged: 0, regressionReopened: 0 });
    expectLiveMatchesReplay(queue, log);

    // A merge that fails to persist must not touch the existing entry either.
    log.failNextAppend = true;
    expect(() => queue.ingest(report({ subjectKey: "a", severity: "critical" }))).toThrowError(
      /append failed/,
    );
    expect(queue.get(a).occurrenceCount).toBe(1);
    expect(queue.get(a).severity).toBe("medium");
    expect(queue.get(a).evidence).toHaveLength(1);
    expectLiveMatchesReplay(queue, log);

    // The next successful ingest continues the sequence — no gap, no duplicate id.
    const c = queue.ingest(report({ subjectKey: "c" }));
    expect(c.outcome).toBe("created");
    expect(c.entry.id).not.toBe(a);
    expect(() => HardCaseQueue.open(log, clock)).not.toThrow();
    expect(log.readAll().map((e) => e.seq)).toEqual([1, 2]);
    expect(queue.list().map((e) => e.subjectKey)).toEqual(["a", "c"]);
    expectLiveMatchesReplay(queue, log);
  });

  it("a failed transition append leaves the entry in its logged state", () => {
    const log = new FlakyEventLog();
    const queue = HardCaseQueue.open(log, clock);
    const id = queue.ingest(report()).entry.id;

    log.failNextAppend = true;
    expect(() => queue.transition(id, "triaged", "coach-a", "confirmed")).toThrowError(
      /append failed/,
    );

    expect(queue.get(id).state).toBe("new");
    expect(queue.get(id).history).toEqual([]);
    expectLiveMatchesReplay(queue, log);

    // The same transition, retried, is legal and persists exactly once.
    queue.transition(id, "triaged", "coach-a", "confirmed");
    expect(queue.get(id).state).toBe("triaged");
    expect(queue.get(id).history).toHaveLength(1);
    expect(() => HardCaseQueue.open(log, clock)).not.toThrow();
    expect(log.readAll().map((e) => e.seq)).toEqual([1, 2]);
    expectLiveMatchesReplay(queue, log);
  });

  it("a real filesystem append failure (missing directory) is surfaced and leaves no half-state", () => {
    const dir = mkdtempSync(join(tmpdir(), "hard-case-atomic-"));
    const missingDir = join(dir, "not-yet-created");
    const path = join(missingDir, "hard-cases.jsonl");
    const log = new FileEventLog(path);
    const queue = HardCaseQueue.open(log, clock);

    expect(() => queue.ingest(report({ subjectKey: "a" }))).toThrowError(/ENOENT/);
    expect(queue.list()).toEqual([]);
    expect(queue.ledger()).toEqual({ ingested: 0, created: 0, merged: 0, regressionReopened: 0 });
    expectLiveMatchesReplay(queue, log);

    // Once the sink is writable again the queue resumes from seq 1.
    mkdirSync(missingDir, { recursive: true });
    const a = queue.ingest(report({ subjectKey: "a" }));
    expect(a.outcome).toBe("created");
    expect(a.entry.id).toBe("hc-000001");
    queue.transition(a.entry.id, "triaged", "coach-a", "real");
    expect(() => HardCaseQueue.open(new FileEventLog(path), clock)).not.toThrow();
    expectLiveMatchesReplay(queue, new FileEventLog(path));
  });
});
