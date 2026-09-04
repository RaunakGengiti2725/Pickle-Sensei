/**
 * Adjudication repro (shared-packages-ops) — HardCaseQueue.ingest/transition
 * mutate memory and bump `seq` BEFORE the durable append. One failed append
 * leaves the live queue ahead of the log and burns a seq number, so the next
 * successful append writes seq N+2 and the log can never be re-opened (the
 * corruption guard sees a gap). Every test here FAILS on 4d812e1a.
 */
import { describe, expect, it } from "vitest";
import {
  HardCaseQueue,
  InMemoryEventLog,
  type HardCaseEvent,
  type HardCaseReport,
} from "../src/index.js";

let tick = 0;
const now = () => `2026-01-01T00:00:${String(tick++ % 60).padStart(2, "0")}.000Z`;

function report(subjectKey: string): HardCaseReport {
  return {
    source: "user_feedback",
    subjectKey,
    severity: "medium",
    evidence: {
      source: "user_feedback",
      ref: `fb-${subjectKey}`,
      detail: "d",
      observedAtIso: now(),
    },
  };
}

class FlakyLog extends InMemoryEventLog {
  failNext = false;
  override append(event: HardCaseEvent): void {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("EACCES: permission denied");
    }
    super.append(event);
  }
}

describe("adjudication: a failed append leaves the queue exactly as it was", () => {
  it("ingest: live state equals replayed state after the failed append", () => {
    const log = new FlakyLog();
    const q = HardCaseQueue.open(log, now);
    q.ingest(report("a"));
    log.failNext = true;
    expect(() => q.ingest(report("b"))).toThrow(/EACCES/);
    const live = q.list().map((e) => e.subjectKey);
    const replayed = HardCaseQueue.open(log, now)
      .list()
      .map((e) => e.subjectKey);
    expect(live).toEqual(replayed);
    expect(q.ledger()).toEqual(HardCaseQueue.open(log, now).ledger());
  });

  it("ingest: the NEXT successful ingest yields a log that still re-opens (no seq gap)", () => {
    const log = new FlakyLog();
    const q = HardCaseQueue.open(log, now);
    q.ingest(report("a"));
    log.failNext = true;
    expect(() => q.ingest(report("b"))).toThrow(/EACCES/);
    q.ingest(report("c"));
    expect(() => HardCaseQueue.open(log, now)).not.toThrow();
  });

  it("transition: a failed append does not move the entry in memory", () => {
    const log = new FlakyLog();
    const q = HardCaseQueue.open(log, now);
    const { entry } = q.ingest(report("a"));
    const before = q.get(entry.id).state;
    log.failNext = true;
    expect(() => q.transition(entry.id, "triaged", "oncall", "look")).toThrow(/EACCES/);
    expect(q.get(entry.id).state).toBe(before);
    expect(() => HardCaseQueue.open(log, now)).not.toThrow();
  });
});
