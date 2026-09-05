import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileEventLog, HardCaseQueue, type HardCaseReport } from "../src/index.js";

/**
 * Adjudication repro (stress area packages-ops-3, baseline 1fb0efd7).
 * Root cause: `HardCaseQueue.ingest` / `transition` mutate in-memory state
 * (byId, byFingerprint, counts, seq, entry history) BEFORE `log.append`, so
 * an append that throws leaves memory ahead of the durable log and the log
 * ends up with a seq gap that `HardCaseQueue.open` refuses to replay.
 *
 * Replayed seeds (tools/stress-kit, origin/devin/stress-pkg-ops-bundle-randomized-seeded):
 *   2124015592 — report.evidence.source = 10n  (JSON.stringify throws on BigInt)
 *   3008876118 — transition actor = Symbol()   (JSON.stringify drops the field)
 * Adjudicator extension: a plain filesystem failure (ENOENT on the log path)
 * triggers the same divergence with a fully well-typed report.
 *
 * These tests assert the EXPECTED contract and therefore FAIL on 1fb0efd7.
 */

let tick = 0;
const clock = (): string => new Date(1756500000000 + ++tick * 1000).toISOString();

function report(overrides: Partial<HardCaseReport> = {}): HardCaseReport {
  return {
    source: "user_feedback",
    subjectKey: "rec-adjudicate-0001",
    severity: "medium",
    evidence: {
      source: "user_feedback",
      ref: "feedback/fb-adjudicate",
      detail: "synthetic adjudication report",
      observedAtIso: "2026-08-29T00:00:00.000Z",
    },
    ...overrides,
  };
}

function tmpLog(): string {
  return join(mkdtempSync(join(tmpdir(), "hcq-adjudicate-")), "events.jsonl");
}

describe("hard-case-queue: durable log and in-memory state must not diverge", () => {
  it("seed 2124015592: an append that throws (BigInt in report) leaves no in-memory trace", () => {
    const path = tmpLog();
    const queue = HardCaseQueue.open(new FileEventLog(path), clock);
    const good = queue.ingest(report({ subjectKey: "rec-good" }));
    expect(good.outcome).toBe("created");

    const poison = report({ subjectKey: "rec-poison" });
    (poison.evidence as { source: unknown }).source = 10n;
    expect(() => queue.ingest(poison)).toThrow(/BigInt/);

    // Expected: the failed ingest is not observable anywhere.
    expect(queue.list().map((e) => e.subjectKey)).toEqual(["rec-good"]);
    expect(queue.ledger().ingested).toBe(1);
    expect(queue.ledger().created).toBe(1);

    // Expected: a later, valid ingest keeps the log replayable.
    queue.ingest(report({ subjectKey: "rec-after" }));
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    expect(lines.map((l) => (JSON.parse(l) as { seq: number }).seq)).toEqual([1, 2]);
    const reopened = HardCaseQueue.open(new FileEventLog(path), clock);
    expect(
      reopened
        .list()
        .map((e) => e.subjectKey)
        .sort(),
    ).toEqual(
      queue
        .list()
        .map((e) => e.subjectKey)
        .sort(),
    );
  });

  it("seed 3008876118: a transition whose actor is not serialisable is rejected, not half-applied", () => {
    const path = tmpLog();
    const queue = HardCaseQueue.open(new FileEventLog(path), clock);
    const { entry } = queue.ingest(report());

    const actor = Symbol("adjudicate") as unknown as string;
    let threw = false;
    try {
      queue.transition(entry.id, "triaged", actor, "symbol actor");
    } catch {
      threw = true;
    }
    const live = queue.get(entry.id);
    const replayed = HardCaseQueue.open(new FileEventLog(path), clock).get(entry.id);
    if (!threw) {
      // If the queue accepted it, the durable log must reproduce the live state exactly.
      expect(replayed.state).toBe(live.state);
      expect(replayed.history).toEqual(live.history);
    } else {
      expect(live.state).toBe("new");
      expect(replayed.state).toBe("new");
    }
  });

  it("adjudicator extension: a filesystem failure on append must not advance in-memory state", () => {
    const dir = mkdtempSync(join(tmpdir(), "hcq-adjudicate-"));
    const path = join(dir, "missing-subdir", "events.jsonl");
    expect(existsSync(path)).toBe(false);
    const queue = HardCaseQueue.open(new FileEventLog(path), clock);

    expect(() => queue.ingest(report())).toThrow(/ENOENT/);
    expect(queue.list()).toHaveLength(0);
    expect(queue.ledger().ingested).toBe(0);
  });
});
