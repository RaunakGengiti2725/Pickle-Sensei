import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
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
  type HardCaseState,
} from "../src/index.js";

/**
 * Adversarial pass 3 (tester #4) — hard-case queue integrity attacks.
 *
 *   S7  transition(id, "regression") directly from `new` and from `triaged`
 *       must throw HardCaseTransitionError — AND leave no trace: state, seq,
 *       history, event log and replay all unchanged.
 *   +   append-failure (permission denial) mid-flight: does the in-memory
 *       queue diverge from its source-of-truth log?
 *
 * Convention: BROKEN scenarios state the EXPECTED behaviour under `it.fails`
 * (green while the defect exists, red once fixed — flip to `it` then), with a
 * sibling `it` that pins the currently-observed behaviour as the repro.
 */

let tick = 0;
const clock = (): string => new Date(1756500000000 + ++tick * 1000).toISOString();

function report(overrides: Partial<HardCaseReport> = {}): HardCaseReport {
  return {
    source: "user_feedback",
    subjectKey: "rec-attack4-000000000001",
    severity: "medium",
    evidence: {
      source: overrides.source ?? "user_feedback",
      ref: "feedback/fb-attack4",
      detail: "SYNTHETIC-TEST-FIXTURE hard case",
      observedAtIso: "2026-08-29T00:00:00.000Z",
    },
    ...overrides,
  };
}

class CountingLog extends InMemoryEventLog {
  appends = 0;
  override append(event: HardCaseEvent): void {
    this.appends += 1;
    super.append(event);
  }
}

describe("S7 direct jump to regression", () => {
  for (const from of ["new", "triaged"] as const satisfies readonly HardCaseState[]) {
    it(`${from} → regression throws HardCaseTransitionError and leaves NO trace`, () => {
      const log = new CountingLog();
      const queue = HardCaseQueue.open(log, clock);
      const id = queue.ingest(report()).entry.id;
      if (from === "triaged") queue.transition(id, "triaged", "coach", "");
      const before = JSON.stringify(queue.get(id));
      const eventsBefore = log.readAll().length;
      const appendsBefore = log.appends;

      let caught: unknown = null;
      try {
        queue.transition(id, "regression", "attacker", "skip the pipeline");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(HardCaseTransitionError);
      const err = caught as HardCaseTransitionError;
      expect(err.name).toBe("HardCaseTransitionError");
      expect(err.entryId).toBe(id);
      expect(err.from).toBe(from);
      expect(err.to).toBe("regression");
      expect(err.message).toContain(`illegal transition ${from} → regression on ${id}`);

      // No trace anywhere.
      expect(JSON.stringify(queue.get(id))).toBe(before);
      expect(queue.get(id).state).toBe(from);
      expect(queue.get(id).regressionCount).toBe(0);
      expect(queue.get(id).history.some((h) => h.to === "regression")).toBe(false);
      expect(log.readAll()).toHaveLength(eventsBefore);
      expect(log.appends).toBe(appendsBefore);

      // Replay of the log yields the identical queue, and the next legal
      // event gets the seq the failed one would have had (no seq burned).
      const replay = HardCaseQueue.open(new InMemoryEventLog(), clock);
      for (const event of log.readAll()) {
        if (event.type === "ingested") replay.ingest(event.report);
        else replay.transition(event.entryId, event.to, event.actor, event.note);
      }
      expect(replay.get(id).state).toBe(from);
      const next = from === "new" ? "triaged" : "in-review";
      queue.transition(id, next, "coach", "");
      const last = log.readAll().at(-1)!;
      expect(last.seq).toBe(eventsBefore + 1);
    });
  }

  it("rapid repeats: 1000 illegal attempts from new never burn a seq or mutate state", () => {
    const log = new CountingLog();
    const queue = HardCaseQueue.open(log, clock);
    const id = queue.ingest(report()).entry.id;
    for (let i = 0; i < 1000; i += 1) {
      expect(() => queue.transition(id, "regression", "x", "")).toThrowError(
        HardCaseTransitionError,
      );
    }
    expect(log.appends).toBe(1);
    expect(queue.get(id).state).toBe("new");
    queue.transition(id, "triaged", "coach", "");
    expect(log.readAll().at(-1)!.seq).toBe(2);
    queue.assertNoSilentDrops();
  });

  it("an unknown target state (not in the table at all) is rejected, not coerced", () => {
    const queue = HardCaseQueue.open(new InMemoryEventLog(), clock);
    const id = queue.ingest(report()).entry.id;
    expect(() => queue.transition(id, "deleted" as unknown as HardCaseState, "x", "")).toThrowError(
      HardCaseTransitionError,
    );
    expect(queue.get(id).state).toBe("new");
  });

  it("a replayed log whose transition event targets an illegal state is refused loudly", () => {
    const dir = mkdtempSync(join(tmpdir(), "hard-case-attack4-"));
    const path = join(dir, "hard-cases.jsonl");
    const queue = HardCaseQueue.open(new FileEventLog(path), clock);
    const id = queue.ingest(report()).entry.id;
    // Forge a new → regression transition straight into the log.
    new FileEventLog(path).append({
      seq: 2,
      type: "transitioned",
      atIso: clock(),
      entryId: id,
      from: "new",
      to: "regression",
      actor: "forger",
      note: "",
    });
    expect(() => HardCaseQueue.open(new FileEventLog(path), clock)).toThrowError(
      HardCaseTransitionError,
    );
  });

  it("a replayed transition event whose `from` field lies is ignored — entry state is what counts", () => {
    // `from` in the log is provenance only; applyTransition validates against
    // the live entry state. A forged `from: "in-review"` does not make
    // new → regression legal.
    const dir = mkdtempSync(join(tmpdir(), "hard-case-attack4-"));
    const path = join(dir, "hard-cases.jsonl");
    const queue = HardCaseQueue.open(new FileEventLog(path), clock);
    const id = queue.ingest(report()).entry.id;
    new FileEventLog(path).append({
      seq: 2,
      type: "transitioned",
      atIso: clock(),
      entryId: id,
      from: "in-review",
      to: "regression",
      actor: "forger",
      note: "",
    });
    expect(() => HardCaseQueue.open(new FileEventLog(path), clock)).toThrowError(
      /illegal transition new → regression/,
    );
  });
});

describe("extra: log append failure mid-flight (permission denial)", () => {
  function setup(): { path: string; queue: HardCaseQueue; id: string } {
    const dir = mkdtempSync(join(tmpdir(), "hard-case-attack4-"));
    const path = join(dir, "hard-cases.jsonl");
    const queue = HardCaseQueue.open(new FileEventLog(path), clock);
    const id = queue.ingest(report()).entry.id;
    return { path, queue, id };
  }

  it("REPRO: append EACCES after state mutation → in-memory queue diverges from its log", () => {
    const { path, queue, id } = setup();
    chmodSync(path, 0o444);
    try {
      let threw = false;
      try {
        queue.transition(id, "triaged", "coach", "real");
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      // The write to the source of truth failed, but memory says triaged.
      expect(queue.get(id).state).toBe("triaged");
      expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
      // A fresh open from the log still sees `new`.
      expect(HardCaseQueue.open(new FileEventLog(path), clock).get(id).state).toBe("new");
    } finally {
      chmodSync(path, 0o644);
    }
  });

  it("REPRO: once permission returns, the next event writes seq 3 after seq 1 → log unopenable", () => {
    const { path, queue, id } = setup();
    chmodSync(path, 0o444);
    try {
      expect(() => queue.transition(id, "triaged", "coach", "real")).toThrow();
    } finally {
      chmodSync(path, 0o644);
    }
    // Permission restored; the operator continues with a legal move.
    queue.transition(id, "in-review", "coach", "assigned");
    const seqs = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as HardCaseEvent).seq);
    expect(seqs).toEqual([1, 3]);
    // The log — the declared source of truth — is now permanently corrupt.
    expect(() => HardCaseQueue.open(new FileEventLog(path), clock)).toThrowError(
      /expected seq 2, found 3/,
    );
  });

  it.fails(
    "EXPECTED: a failed append rolls back memory (or is written before mutation) (BROKEN, P2)",
    () => {
      const { path, queue, id } = setup();
      chmodSync(path, 0o444);
      try {
        expect(() => queue.transition(id, "triaged", "coach", "real")).toThrow();
        expect(queue.get(id).state).toBe("new");
      } finally {
        chmodSync(path, 0o644);
      }
      queue.transition(id, "triaged", "coach", "real");
      expect(() => HardCaseQueue.open(new FileEventLog(path), clock)).not.toThrow();
    },
  );

  it("REPRO: same divergence on ingest — a report is 'accounted for' in memory but lost from the log", () => {
    const { path, queue } = setup();
    chmodSync(path, 0o444);
    try {
      expect(() => queue.ingest(report({ subjectKey: "rec-attack4-000000000002" }))).toThrow();
    } finally {
      chmodSync(path, 0o644);
    }
    expect(queue.ledger().ingested).toBe(2);
    expect(queue.list()).toHaveLength(2);
    queue.assertNoSilentDrops(); // memory believes nothing was dropped…
    const reopened = HardCaseQueue.open(new FileEventLog(path), clock);
    expect(reopened.ledger().ingested).toBe(1); // …the source of truth disagrees.
    expect(reopened.list()).toHaveLength(1);
  });
});
