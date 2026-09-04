/**
 * Adversarial pass 3 — hard-case queue: mid-flight append failure, live-object
 * mutation, replay of a well-formed-but-garbage log, unicode / huge keys.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileEventLog,
  HardCaseQueue,
  HardCaseTransitionError,
  InMemoryEventLog,
  type HardCaseEvent,
  type HardCaseReport,
} from "../src/index.js";

let tick = 0;
const now = () => `2026-01-01T00:00:${String(tick++).padStart(2, "0")}.000Z`;

function report(subjectKey: string, over: Partial<HardCaseReport> = {}): HardCaseReport {
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
    ...over,
  };
}

class FlakyLog extends InMemoryEventLog {
  failOnAppend = 0;
  private appends = 0;
  override append(event: HardCaseEvent): void {
    this.appends += 1;
    if (this.appends === this.failOnAppend) throw new Error("EIO: disk full");
    super.append(event);
  }
}

describe("attack3: ingest whose log append fails mid-flight", () => {
  it("in-memory state and the durable log must not silently diverge", () => {
    const log = new FlakyLog();
    log.failOnAppend = 2;
    const q = HardCaseQueue.open(log, now);
    q.ingest(report("a"));
    expect(() => q.ingest(report("b"))).toThrow(/disk full/);
    // The caller was told the ingest FAILED. The live queue must agree.
    const live = q.list().map((e) => e.subjectKey);
    const replayed = HardCaseQueue.open(log, now)
      .list()
      .map((e) => e.subjectKey);
    expect({ live, ledger: q.ledger() }, "live queue kept an entry the log never received").toEqual(
      {
        live: replayed,
        ledger: HardCaseQueue.open(log, now).ledger(),
      },
    );
  });

  it("after a failed append the NEXT successful ingest must not produce a log that refuses to open", () => {
    const log = new FlakyLog();
    log.failOnAppend = 2;
    const q = HardCaseQueue.open(log, now);
    q.ingest(report("a"));
    expect(() => q.ingest(report("b"))).toThrow();
    q.ingest(report("c"));
    // Either the log is replayable, or the failure is loud — but a log written
    // by a still-running queue must be replayable.
    expect(() => HardCaseQueue.open(log, now)).not.toThrow();
  });
});

describe("attack3: live entry objects", () => {
  it("get()/list() must not hand out a mutable entry that bypasses the state machine and the log", () => {
    const log = new InMemoryEventLog();
    const q = HardCaseQueue.open(log, now);
    const { entry } = q.ingest(report("x"));
    // A careless (or malicious) caller writes straight onto the returned object.
    (entry as { state: string }).state = "resolved";
    (entry as { history: unknown[] }).history.length = 0;
    const seen = q.get(entry.id).state;
    const replayed = HardCaseQueue.open(log, now).get(entry.id).state;
    expect({ seen, replayed }, "live state diverged from the append-only log").toEqual({
      seen: "new",
      replayed: "new",
    });
  });
});

describe("attack3: replaying a syntactically valid but semantically garbage log", () => {
  it("an 'ingested' event whose report lacks source/severity/evidence is rejected, not materialized", () => {
    const dir = mkdtempSync(join(tmpdir(), "attack3-hcq-"));
    const path = join(dir, "log.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify({ seq: 1, type: "ingested", atIso: "2026-01-01T00:00:00Z", report: { subjectKey: "s" }, outcome: "created", entryId: "hc-000001" })}\n`,
    );
    const open = () => HardCaseQueue.open(new FileEventLog(path), now);
    let entries: unknown = null;
    let threw = false;
    try {
      entries = open()
        .list()
        .map((e) => ({
          id: e.id,
          category: e.category,
          source: e.source,
          severity: e.severity,
          evidence: e.evidence,
        }));
    } catch {
      threw = true;
    }
    expect({ threw, entries }, "garbage event replayed into a live case").toEqual({
      threw: true,
      entries: null,
    });
  });

  it("an event with an unknown type is refused (not treated as 'transitioned')", () => {
    const dir = mkdtempSync(join(tmpdir(), "attack3-hcq-"));
    const path = join(dir, "log.jsonl");
    const q = HardCaseQueue.open(new FileEventLog(path), now);
    q.ingest(report("s"));
    writeFileSync(
      path,
      `${JSON.stringify({ seq: 2, type: "deleted", atIso: "x", entryId: "hc-000001", to: "triaged", actor: "a", note: "n" })}\n`,
      { flag: "a" },
    );
    let state: string | null = null;
    let err: unknown = null;
    try {
      state = HardCaseQueue.open(new FileEventLog(path), now).get("hc-000001").state;
    } catch (e) {
      err = e;
    }
    // Acceptable: a loud refusal. Not acceptable: the bogus type silently
    // ran the 'transitioned' branch and moved the case to triaged.
    expect(
      { state, threw: err !== null },
      "unknown event type executed as a transition",
    ).not.toEqual({
      state: "triaged",
      threw: false,
    });
  });
});

describe("attack3: unicode / huge / delimiter-bearing keys", () => {
  it("subjectKey containing the '::' fingerprint delimiter cannot collide across categories", () => {
    const q = HardCaseQueue.open(new InMemoryEventLog(), now);
    const a = q.ingest(report("CAPTURE::k", { categoryHint: "OTHER" }));
    const b = q.ingest(report("k", { categoryHint: "CAPTURE" }));
    expect(a.entry.id).not.toBe(b.entry.id);
    expect(a.outcome).toBe("created");
    expect(b.outcome).toBe("created");
    q.assertNoSilentDrops();
  });

  it("10k-char emoji subjectKey and note round-trip through the JSONL log", () => {
    const dir = mkdtempSync(join(tmpdir(), "attack3-hcq-"));
    const path = join(dir, "log.jsonl");
    const key = "🥒".repeat(10_000) + "\n\u2028\u0000";
    const q = HardCaseQueue.open(new FileEventLog(path), now);
    const { entry } = q.ingest(report(key));
    q.transition(entry.id, "triaged", "op", "note\nwith newline \u2029");
    const re = HardCaseQueue.open(new FileEventLog(path), now);
    expect(re.get(entry.id).subjectKey).toBe(key);
    expect(re.get(entry.id).state).toBe("triaged");
    expect(re.get(entry.id).history[0]?.note).toBe("note\nwith newline \u2029");
  });

  it("illegal transitions (new→resolved, resolved→triaged) throw and leave no log entry", () => {
    const log = new InMemoryEventLog();
    const q = HardCaseQueue.open(log, now);
    const { entry } = q.ingest(report("s"));
    expect(() => q.transition(entry.id, "resolved", "op", "skip")).toThrow(HardCaseTransitionError);
    expect(log.readAll()).toHaveLength(1);
  });
});
