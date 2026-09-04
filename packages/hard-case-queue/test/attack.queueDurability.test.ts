import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  FileEventLog,
  HardCaseQueue,
  HardCaseTransitionError,
  InMemoryEventLog,
  fingerprintOf,
  type HardCaseCategory,
  type HardCaseReport,
  type HardCaseState,
} from "../src/index.js";

/**
 * Adversarial pass (shared-packages-ops #2, pass 3) against the hard-case
 * queue's "nothing is ever silently dropped" guarantee: write failures
 * mid-ingest, two writers on one log, corrupt-but-well-typed events, clock
 * skew, unicode subject keys, live-object mutation and a 20k-report run.
 * HELD cases assert the safe behaviour; FINDING cases pin what the code does
 * today so the repro is executable and the expected behaviour is stated in
 * the name.
 */

let tick = 0;
const clock = (): string => new Date(1756500000000 + ++tick * 1000).toISOString();

function report(overrides: Partial<HardCaseReport> = {}): HardCaseReport {
  return {
    source: "user_feedback",
    subjectKey: "rec-attack-001",
    severity: "medium",
    evidence: {
      source: overrides.source ?? "user_feedback",
      ref: "feedback/fb-attack",
      detail: "synthetic",
      observedAtIso: "2026-09-04T00:00:00.000Z",
    },
    ...overrides,
  };
}

const lockedDirs: string[] = [];
afterAll(() => {
  for (const dir of lockedDirs) chmodSync(dir, 0o700);
});

describe("attack: write failure mid-ingest (permission denial)", () => {
  it("FINDING: ingest mutates memory and bumps seq BEFORE the append; an EACCES leaves the in-memory queue diverged from the log and the log unopenable forever", () => {
    if (process.getuid?.() === 0) return; // root ignores mode bits
    const dir = mkdtempSync(join(tmpdir(), "hc-attack-"));
    const locked = join(dir, "locked");
    mkdirSync(locked);
    const path = join(locked, "hard-cases.jsonl");
    const log = new FileEventLog(path);
    const queue = HardCaseQueue.open(log, clock);
    chmodSync(locked, 0o500);
    lockedDirs.push(locked);

    expect(() => queue.ingest(report())).toThrow(/EACCES|permission denied/);
    // Memory says one case exists …
    expect(queue.list()).toHaveLength(1);
    expect(queue.ledger().ingested).toBe(1);
    // … the log says nothing exists.
    expect(log.readAll()).toEqual([]);

    // The next write succeeds and lands with seq 2 — the first event is gone.
    chmodSync(locked, 0o700);
    queue.ingest(report({ subjectKey: "rec-attack-002" }));
    const persisted = log.readAll();
    expect(persisted.map((e) => e.seq)).toEqual([2]);

    // Replay now refuses the log permanently; the surviving case is unrecoverable
    // through the public API (no repair / compaction path exists).
    expect(() => HardCaseQueue.open(new FileEventLog(path), clock)).toThrow(
      /corrupt: expected seq 1, found 2/,
    );
  });

  it("FINDING: transition() has the same ordering — a failed append leaves the entry moved in memory but not on disk", () => {
    let fail = false;
    const inner = new InMemoryEventLog();
    const log = {
      append: (e: Parameters<InMemoryEventLog["append"]>[0]) => {
        if (fail) throw new Error("disk full");
        inner.append(e);
      },
      readAll: () => inner.readAll(),
    };
    const queue = HardCaseQueue.open(log, clock);
    const { entry } = queue.ingest(report());
    fail = true;
    expect(() => queue.transition(entry.id, "triaged", "op", "x")).toThrow(/disk full/);
    expect(queue.get(entry.id).state).toBe("triaged");
    fail = false;
    // Memory refuses the "retry" as an illegal triaged → triaged transition,
    // so the operator cannot make the log catch up.
    expect(() => queue.transition(entry.id, "triaged", "op", "retry")).toThrow(
      HardCaseTransitionError,
    );
    const replayed = HardCaseQueue.open(
      { append: () => undefined, readAll: () => inner.readAll() },
      clock,
    );
    expect(replayed.get(entry.id).state).toBe("new");
  });
});

describe("attack: two writers on one log", () => {
  it("FINDING: nothing prevents two HardCaseQueue instances sharing a file; both write seq 1 and the log can never be opened again", () => {
    const dir = mkdtempSync(join(tmpdir(), "hc-attack-"));
    const path = join(dir, "hard-cases.jsonl");
    const a = HardCaseQueue.open(new FileEventLog(path), clock);
    const b = HardCaseQueue.open(new FileEventLog(path), clock);
    a.ingest(report({ subjectKey: "from-a" }));
    b.ingest(report({ subjectKey: "from-b" }));
    const seqs = new FileEventLog(path).readAll().map((e) => e.seq);
    expect(seqs).toEqual([1, 1]);
    expect(() => HardCaseQueue.open(new FileEventLog(path), clock)).toThrow(/corrupt/);
    // And dedup does not hold across the two writers either.
    b.ingest(report({ subjectKey: "from-a" }));
    expect(
      b
        .list()
        .map((e) => e.subjectKey)
        .sort(),
    ).toEqual(["from-a", "from-b"]);
    expect(a.list()).toHaveLength(1);
  });
});

describe("attack: corrupt-but-well-typed log events", () => {
  function writeLog(lines: unknown[]): string {
    const dir = mkdtempSync(join(tmpdir(), "hc-attack-"));
    const path = join(dir, "hard-cases.jsonl");
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return path;
  }

  it("HELD: truncated last line, duplicate seq, seq gap, and a non-event object all refuse to open", () => {
    const good = {
      seq: 1,
      type: "ingested",
      atIso: clock(),
      report: report(),
      outcome: "created",
      entryId: "hc-000001",
    };
    const p1 = writeLog([good]);
    writeFileSync(p1, readFileSync(p1, "utf8") + '{"seq":2,"type":"transi');
    expect(() => HardCaseQueue.open(new FileEventLog(p1), clock)).toThrow(/unparseable JSON/);
    expect(() => HardCaseQueue.open(new FileEventLog(writeLog([good, good])), clock)).toThrow(
      /expected seq 2, found 1/,
    );
    expect(() =>
      HardCaseQueue.open(new FileEventLog(writeLog([good, { ...good, seq: 3 }])), clock),
    ).toThrow(/expected seq 2, found 3/);
    expect(() => HardCaseQueue.open(new FileEventLog(writeLog([{ seq: 1 }])), clock)).toThrow(
      /not a hard-case event/,
    );
    expect(() => HardCaseQueue.open(new FileEventLog(writeLog([42])), clock)).toThrow(
      /not a hard-case event/,
    );
  });

  it("FINDING: an 'ingested' event without a report passes the shape check and crashes replay with a raw TypeError, not a 'corrupt' error", () => {
    const path = writeLog([{ seq: 1, type: "ingested", atIso: clock(), entryId: "hc-000001" }]);
    let thrown: unknown;
    try {
      HardCaseQueue.open(new FileEventLog(path), clock);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(String(thrown)).not.toMatch(/corrupt/);
  });

  it("HELD: a replayed transition to an unknown state is refused (log cannot smuggle a 'deleted' state in)", () => {
    const ing = {
      seq: 1,
      type: "ingested",
      atIso: clock(),
      report: report(),
      outcome: "created",
      entryId: "hc-000001",
    };
    const tr = {
      seq: 2,
      type: "transitioned",
      atIso: clock(),
      entryId: "hc-000001",
      from: "new",
      to: "deleted",
      actor: "x",
      note: "",
    };
    expect(() => HardCaseQueue.open(new FileEventLog(writeLog([ing, tr])), clock)).toThrow(
      HardCaseTransitionError,
    );
  });

  it("FINDING: a replayed transition whose `from` disagrees with the entry's real state is accepted — `from` is never checked against the entry", () => {
    const ing = {
      seq: 1,
      type: "ingested",
      atIso: clock(),
      report: report(),
      outcome: "created",
      entryId: "hc-000001",
    };
    const tr = {
      seq: 2,
      type: "transitioned",
      atIso: clock(),
      entryId: "hc-000001",
      from: "resolved",
      to: "triaged",
      actor: "x",
      note: "",
    };
    const q = HardCaseQueue.open(new FileEventLog(writeLog([ing, tr])), clock);
    expect(q.get("hc-000001").state).toBe("triaged");
    expect(q.get("hc-000001").history[0]?.from).toBe("new");
  });

  it("HELD: a CRLF log and a log with blank lines both replay", () => {
    const ing = {
      seq: 1,
      type: "ingested",
      atIso: clock(),
      report: report(),
      outcome: "created",
      entryId: "hc-000001",
    };
    const dir = mkdtempSync(join(tmpdir(), "hc-attack-"));
    const path = join(dir, "crlf.jsonl");
    writeFileSync(path, `${JSON.stringify(ing)}\r\n\n\n`);
    expect(HardCaseQueue.open(new FileEventLog(path), clock).list()).toHaveLength(1);
  });
});

describe("attack: live-object mutation, clock skew, unicode, volume", () => {
  it("FINDING: get()/list()/ingest() hand out the LIVE entry; a caller can set state='resolved' with no transition, no history and no log event", () => {
    const log = new InMemoryEventLog();
    const q = HardCaseQueue.open(log, clock);
    const { entry } = q.ingest(report());
    (entry as { state: HardCaseState }).state = "resolved";
    expect(q.get(entry.id).state).toBe("resolved");
    expect(q.get(entry.id).history).toEqual([]);
    expect(log.readAll()).toHaveLength(1);
    // The next recurrence is now treated as a regression of a case nobody resolved.
    expect(q.ingest(report()).outcome).toBe("regression_reopened");
    // A replay of the log disagrees with the in-memory queue.
    expect(
      HardCaseQueue.open({ append: () => undefined, readAll: () => log.readAll() }, clock).get(
        entry.id,
      ).state,
    ).toBe("new");
  });

  it("FINDING: a clock that runs backwards produces updatedAtIso < createdAtIso with no complaint", () => {
    let t = 2_000_000;
    const back = (): string => new Date((t -= 1_000_000)).toISOString();
    const q = HardCaseQueue.open(new InMemoryEventLog(), back);
    const { entry } = q.ingest(report());
    q.ingest(report());
    expect(entry.updatedAtIso < entry.createdAtIso).toBe(true);
  });

  it("FINDING: NFC and NFD spellings of the same subject are two cases; '::' in a subjectKey cannot forge another (source, category) pair", () => {
    const q = HardCaseQueue.open(new InMemoryEventLog(), clock);
    q.ingest(report({ subjectKey: "s\u00e9ance" }));
    q.ingest(report({ subjectKey: "se\u0301ance" }));
    expect(q.list()).toHaveLength(2);
    // Fingerprint components are enums, so a separator inside subjectKey
    // cannot collide with a different source/category.
    expect(fingerprintOf("user_feedback", "OTHER", "x::TARGET::y")).not.toBe(
      fingerprintOf("user_feedback", "TARGET", "y"),
    );
  });

  it("HELD: empty subjectKey and a 1 MiB subjectKey are accepted and dedup exactly", () => {
    const q = HardCaseQueue.open(new InMemoryEventLog(), clock);
    expect(q.ingest(report({ subjectKey: "" })).outcome).toBe("created");
    expect(q.ingest(report({ subjectKey: "" })).outcome).toBe("merged");
    const huge = "k".repeat(1 << 20);
    expect(q.ingest(report({ subjectKey: huge })).outcome).toBe("created");
    expect(q.ingest(report({ subjectKey: huge })).outcome).toBe("merged");
    q.assertNoSilentDrops();
  });

  it("HELD: 20k seeded reports (LCG seed 0x5eed) — ledger balances, replay reproduces the exact state", () => {
    let s = 0x5eed;
    const rnd = (): number => (s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32;
    const log = new InMemoryEventLog();
    const q = HardCaseQueue.open(log, clock);
    const states: HardCaseState[] = ["triaged", "in-review", "resolved", "regression"];
    for (let i = 0; i < 20_000; i++) {
      const r = q.ingest(report({ subjectKey: `s-${Math.floor(rnd() * 500)}` }));
      if (rnd() < 0.3) {
        const to = states[Math.floor(rnd() * states.length)] as HardCaseState;
        try {
          q.transition(r.entry.id, to, "fuzz", "");
        } catch (e) {
          expect(e).toBeInstanceOf(HardCaseTransitionError);
        }
      }
    }
    q.assertNoSilentDrops();
    const l = q.ledger();
    expect(l.ingested).toBe(20_000);
    expect(l.created).toBe(q.list().length);
    const replay = HardCaseQueue.open(
      { append: () => undefined, readAll: () => log.readAll() },
      clock,
    );
    expect(replay.ledger()).toEqual(l);
    expect(JSON.stringify(replay.list())).toBe(JSON.stringify(q.list()));
  });

  it("HELD: ingest with an invalid categoryHint throws BEFORE touching memory or the log", () => {
    const log = new InMemoryEventLog();
    const q = HardCaseQueue.open(log, clock);
    expect(() =>
      q.ingest(report({ categoryHint: "DELETE" as unknown as HardCaseCategory })),
    ).toThrow();
    expect(q.ledger().ingested).toBe(0);
    expect(log.readAll()).toEqual([]);
  });
});
