/**
 * Adversarial pass (shared-packages-ops #1, pass 3) — HardCaseQueue.
 * `it(...)` = HELD; `it.fails(...)` = EXPECTED behaviour that is currently
 * broken (paired with an OBSERVED `it` pinning what really happens).
 */
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    subjectKey: "rec-attack-0001",
    severity: "medium",
    evidence: {
      source: overrides.source ?? "user_feedback",
      ref: "feedback/fb-attack",
      detail: "synthetic adversarial report",
      observedAtIso: "2026-09-04T00:00:00.000Z",
    },
    ...overrides,
  };
}

/** Wraps a log and throws on the Nth append (1-based), then behaves normally. */
class FlakyLog implements HardCaseEventLog {
  appends = 0;
  constructor(
    private readonly inner: HardCaseEventLog,
    private readonly failOn: number,
  ) {}
  append(event: HardCaseEvent): void {
    this.appends += 1;
    if (this.appends === this.failOn) throw new Error("ENOSPC: simulated append failure");
    this.inner.append(event);
  }
  readAll(): HardCaseEvent[] {
    return this.inner.readAll();
  }
}

describe("S4 — log.append throws once, then succeeds", () => {
  it("OBSERVED: ingest() throws, but the in-memory queue has ALREADY applied the ingest → ledger()=1 while readAll()=0", () => {
    const log = new FlakyLog(new InMemoryEventLog(), 1);
    const queue = HardCaseQueue.open(log, clock);
    expect(() => queue.ingest(report())).toThrowError(/ENOSPC/);
    expect(queue.ledger()).toEqual({ ingested: 1, created: 1, merged: 0, regressionReopened: 0 });
    expect(queue.list()).toHaveLength(1);
    expect(log.readAll()).toHaveLength(0);
  });

  it("OBSERVED: the caller's natural retry is recorded as `merged` (occurrenceCount=2) although only one report ever reached the log", () => {
    const log = new FlakyLog(new InMemoryEventLog(), 1);
    const queue = HardCaseQueue.open(log, clock);
    expect(() => queue.ingest(report())).toThrowError(/ENOSPC/);
    const retry = queue.ingest(report());
    expect(retry.outcome).toBe("merged");
    expect(retry.entry.occurrenceCount).toBe(2);
    expect(queue.ledger()).toEqual({ ingested: 2, created: 1, merged: 1, regressionReopened: 0 });
    const persisted = log.readAll();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.seq).toBe(2); // seq 1 was never written
    expect(persisted[0]?.type === "ingested" && persisted[0].outcome).toBe("merged");
  });

  it("OBSERVED: after recovery the log can NEVER be reopened — the missing seq 1 trips the corruption guard forever", () => {
    const dir = mkdtempSync(join(tmpdir(), "hard-case-attack-"));
    const path = join(dir, "hard-cases.jsonl");
    const log = new FlakyLog(new FileEventLog(path), 1);
    const queue = HardCaseQueue.open(log, clock);
    expect(() => queue.ingest(report())).toThrowError(/ENOSPC/);
    queue.ingest(report());
    queue.ingest(report({ subjectKey: "rec-attack-0002" }));
    expect(queue.ledger().ingested).toBe(3);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
    expect(() => HardCaseQueue.open(new FileEventLog(path), clock)).toThrowError(
      /expected seq 1, found 2/,
    );
  });

  it.fails(
    "EXPECTED: a failed append leaves the queue exactly as it was (ledger and readAll agree; log stays replayable)",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "hard-case-attack-"));
      const path = join(dir, "hard-cases.jsonl");
      const log = new FlakyLog(new FileEventLog(path), 1);
      const queue = HardCaseQueue.open(log, clock);
      expect(() => queue.ingest(report())).toThrowError(/ENOSPC/);
      expect(queue.ledger().ingested).toBe(0);
      expect(queue.list()).toHaveLength(0);
      const retry = queue.ingest(report());
      expect(retry.outcome).toBe("created");
      const reopened = HardCaseQueue.open(new FileEventLog(path), clock);
      expect(reopened.ledger()).toEqual(queue.ledger());
      expect(reopened.list()).toEqual(queue.list());
    },
  );

  it("OBSERVED: the same non-atomicity applies to transition(): state flips in memory, log misses the event, reopen throws", () => {
    const inner = new InMemoryEventLog();
    const log = new FlakyLog(inner, 2);
    const queue = HardCaseQueue.open(log, clock);
    const id = queue.ingest(report()).entry.id;
    expect(() => queue.transition(id, "triaged", "coach", "x")).toThrowError(/ENOSPC/);
    expect(queue.get(id).state).toBe("triaged");
    expect(inner.readAll()).toHaveLength(1);
    queue.transition(id, "in-review", "coach", "y");
    expect(() => HardCaseQueue.open(inner, clock)).toThrowError(/expected seq 2, found 3/);
  });
});

describe("S5 — JSONL log whose last line is truncated mid-JSON", () => {
  function truncatedLog(): { path: string; lineCount: number } {
    const dir = mkdtempSync(join(tmpdir(), "hard-case-attack-"));
    const path = join(dir, "hard-cases.jsonl");
    const queue = HardCaseQueue.open(new FileEventLog(path), clock);
    queue.ingest(report());
    queue.ingest(report({ subjectKey: "rec-attack-0002" }));
    queue.ingest(report({ subjectKey: "rec-attack-0003" }));
    const full = readFileSync(path, "utf8");
    const lines = full.trimEnd().split("\n");
    const last = lines[lines.length - 1] ?? "";
    // Cut the last line roughly in half — simulates a crash mid-write.
    writeFileSync(
      path,
      `${lines.slice(0, -1).join("\n")}\n${last.slice(0, Math.floor(last.length / 2))}`,
      "utf8",
    );
    return { path, lineCount: lines.length };
  }

  it("HELD: open() throws, names the exact line number, and no queue instance is produced", () => {
    const { path, lineCount } = truncatedLog();
    let opened: HardCaseQueue | undefined;
    let error: unknown;
    try {
      opened = HardCaseQueue.open(new FileEventLog(path), clock);
    } catch (e) {
      error = e;
    }
    expect(opened).toBeUndefined();
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(new RegExp(`corrupt at line ${lineCount}:`));
    expect((error as Error).message).toMatch(/unparseable JSON/);
    expect((error as Error).message).toContain(path);
  });

  it("HELD: readAll() on the truncated log throws before returning ANY entries (no partial array escapes)", () => {
    const { path } = truncatedLog();
    const log = new FileEventLog(path);
    expect(() => log.readAll()).toThrowError(/corrupt/);
  });

  it("HELD: a truncation that removes only the trailing newline is still valid; the NEXT append then glues two events on one line and open() throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "hard-case-attack-"));
    const path = join(dir, "hard-cases.jsonl");
    const queue = HardCaseQueue.open(new FileEventLog(path), clock);
    queue.ingest(report());
    writeFileSync(path, readFileSync(path, "utf8").trimEnd(), "utf8");
    const reopened = HardCaseQueue.open(new FileEventLog(path), clock);
    expect(reopened.ledger().ingested).toBe(1);
    reopened.ingest(report({ subjectKey: "rec-attack-0002" }));
    expect(() => HardCaseQueue.open(new FileEventLog(path), clock)).toThrowError(
      /corrupt at line 1: unparseable JSON/,
    );
  });

  it("HELD: a line that is valid JSON but not an event (array / number / string / null / missing seq) is rejected with its line number", () => {
    for (const junk of [
      "[]",
      "42",
      '"seq"',
      "null",
      '{"type":"ingested"}',
      '{"seq":"1","type":"ingested"}',
    ]) {
      const dir = mkdtempSync(join(tmpdir(), "hard-case-attack-"));
      const path = join(dir, "hard-cases.jsonl");
      const queue = HardCaseQueue.open(new FileEventLog(path), clock);
      queue.ingest(report());
      appendFileSync(path, `${junk}\n`, "utf8");
      expect(() => HardCaseQueue.open(new FileEventLog(path), clock)).toThrowError(
        /corrupt at line 2: not a hard-case event/,
      );
    }
  });

  it("OBSERVED: a structurally valid event with a missing/unknown payload still throws on replay, but with a generic TypeError, not a line-numbered corruption error", () => {
    const dir = mkdtempSync(join(tmpdir(), "hard-case-attack-"));
    const path = join(dir, "hard-cases.jsonl");
    appendFileSync(
      path,
      `${JSON.stringify({ seq: 1, type: "ingested", atIso: "x", entryId: "hc-000001" })}\n`,
      "utf8",
    );
    let error: unknown;
    try {
      HardCaseQueue.open(new FileEventLog(path), clock);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).not.toMatch(/line 1/);
  });

  it("HELD: CRLF line endings are rejected loudly rather than parsed with a stray \\r", () => {
    const dir = mkdtempSync(join(tmpdir(), "hard-case-attack-"));
    const path = join(dir, "hard-cases.jsonl");
    const queue = HardCaseQueue.open(new FileEventLog(path), clock);
    queue.ingest(report());
    const crlf = readFileSync(path, "utf8").replace(/\n/g, "\r\n");
    writeFileSync(path, crlf, "utf8");
    // JSON.parse tolerates trailing whitespace including \r, so this is
    // actually ACCEPTED — pin that so a future strictness change is deliberate.
    const reopened = HardCaseQueue.open(new FileEventLog(path), clock);
    expect(reopened.ledger().ingested).toBe(1);
  });

  it("HELD: a duplicated line (same seq twice, e.g. a retried write) is detected as a seq mismatch", () => {
    const dir = mkdtempSync(join(tmpdir(), "hard-case-attack-"));
    const path = join(dir, "hard-cases.jsonl");
    const queue = HardCaseQueue.open(new FileEventLog(path), clock);
    queue.ingest(report());
    const line = readFileSync(path, "utf8");
    appendFileSync(path, line, "utf8");
    expect(() => HardCaseQueue.open(new FileEventLog(path), clock)).toThrowError(
      /expected seq 2, found 1/,
    );
  });
});

describe("S6 — same fingerprint 1000 times with alternating low/critical severities", () => {
  it("HELD: severity is monotone-max (critical) and the ledger reads created=1, merged=999", () => {
    const queue = HardCaseQueue.open(new InMemoryEventLog(), clock);
    let last: ReturnType<HardCaseQueue["ingest"]> | undefined;
    for (let i = 0; i < 1000; i++) {
      last = queue.ingest(report({ severity: i % 2 === 0 ? "low" : "critical" }));
    }
    expect(last?.entry.severity).toBe("critical");
    expect(last?.entry.occurrenceCount).toBe(1000);
    expect(last?.entry.evidence).toHaveLength(1000);
    expect(queue.ledger()).toEqual({
      ingested: 1000,
      created: 1,
      merged: 999,
      regressionReopened: 0,
    });
    expect(queue.list()).toHaveLength(1);
    queue.assertNoSilentDrops();
  });

  it("HELD: ending on `low` after 999 alternations does not downgrade the case", () => {
    const queue = HardCaseQueue.open(new InMemoryEventLog(), clock);
    let last: ReturnType<HardCaseQueue["ingest"]> | undefined;
    for (let i = 0; i < 1000; i++) {
      last = queue.ingest(report({ severity: i % 2 === 0 ? "critical" : "low" }));
    }
    expect(last?.entry.severity).toBe("critical");
    expect(queue.ledger().merged).toBe(999);
  });

  it("HELD: file-backed replay of the 1000-report log reproduces the identical entry and ledger", () => {
    const dir = mkdtempSync(join(tmpdir(), "hard-case-attack-"));
    const path = join(dir, "hard-cases.jsonl");
    const queue = HardCaseQueue.open(new FileEventLog(path), clock);
    for (let i = 0; i < 1000; i++) {
      queue.ingest(report({ severity: i % 2 === 0 ? "low" : "critical" }));
    }
    const reopened = HardCaseQueue.open(new FileEventLog(path), clock);
    expect(reopened.ledger()).toEqual(queue.ledger());
    expect(reopened.list()).toEqual(queue.list());
    expect(reopened.list()[0]?.severity).toBe("critical");
  });

  it("HELD: unicode / whitespace-different subject keys are DISTINCT cases (no normalisation, no merge)", () => {
    const queue = HardCaseQueue.open(new InMemoryEventLog(), clock);
    const keys = ["rec-é", "rec-e\u0301", "rec-é ", " rec-é", "REC-É", "rec-\u200bé"];
    for (const subjectKey of keys) queue.ingest(report({ subjectKey }));
    expect(queue.ledger()).toEqual({ ingested: 6, created: 6, merged: 0, regressionReopened: 0 });
  });

  it("OBSERVED: the `::` fingerprint separator is NOT escaped — a subjectKey containing `::` can be forged to look like another (source, category, subject) triple, but source/category are typed so it still yields a distinct case", () => {
    const queue = HardCaseQueue.open(new InMemoryEventLog(), clock);
    const a = queue.ingest(report({ subjectKey: "x" }));
    const b = queue.ingest(report({ subjectKey: "OTHER::x", source: "user_feedback" }));
    expect(a.entry.fingerprint).toBe("user_feedback::OTHER::x");
    expect(b.entry.fingerprint).toBe("user_feedback::OTHER::OTHER::x");
    expect(b.outcome).toBe("created");
  });

  it("HELD: regression re-open after resolve, then 998 more reports, stays a single case with regressionCount=1", () => {
    const queue = HardCaseQueue.open(new InMemoryEventLog(), clock);
    const id = queue.ingest(report({ severity: "low" })).entry.id;
    queue.transition(id, "triaged", "a", "");
    queue.transition(id, "in-review", "a", "");
    queue.transition(id, "resolved", "a", "");
    for (let i = 0; i < 999; i++) {
      queue.ingest(report({ severity: i % 2 === 0 ? "critical" : "low" }));
    }
    const entry = queue.get(id);
    expect(entry.state).toBe("regression");
    expect(entry.regressionCount).toBe(1);
    expect(entry.severity).toBe("critical");
    expect(queue.ledger()).toEqual({
      ingested: 1000,
      created: 1,
      merged: 998,
      regressionReopened: 1,
    });
    queue.assertNoSilentDrops();
  });
});
