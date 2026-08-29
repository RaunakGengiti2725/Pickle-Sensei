import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileEventLog,
  HARD_CASE_CATEGORIES,
  HARD_CASE_SOURCES,
  HARD_CASE_STATES,
  HARD_CASE_TRANSITIONS,
  HardCaseNotFoundError,
  HardCaseQueue,
  HardCaseRoutingError,
  HardCaseTransitionError,
  InMemoryEventLog,
  SOURCE_DEFAULT_CATEGORY,
  fingerprintOf,
  routeCategory,
  type HardCaseCategory,
  type HardCaseReport,
  type HardCaseSource,
  type HardCaseState,
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

describe("routing", () => {
  it("routes every source to a category (no source can be unroutable)", () => {
    for (const source of HARD_CASE_SOURCES) {
      const category = routeCategory(report({ source }));
      expect(HARD_CASE_CATEGORIES).toContain(category);
    }
  });

  it("uses unambiguous per-source defaults and OTHER for everything else", () => {
    expect(routeCategory(report({ source: "capture_envelope_failure" }))).toBe("CAPTURE");
    expect(routeCategory(report({ source: "coach_disagreement" }))).toBe("COACHING");
    expect(routeCategory(report({ source: "unexpected_abstention" }))).toBe("AUTO");
    for (const source of ["user_feedback", "shadow_disagreement", "red_team", "anomaly"] as const) {
      expect(routeCategory(report({ source }))).toBe("OTHER");
    }
    for (const source of HARD_CASE_SOURCES) {
      expect(HARD_CASE_CATEGORIES).toContain(SOURCE_DEFAULT_CATEGORY[source]);
    }
  });

  it("stage hints route to cascade-stage categories; unknown stages fall back, never drop", () => {
    expect(routeCategory(report({ source: "model_disagreement", stageHint: "BALL" }))).toBe("BALL");
    expect(routeCategory(report({ source: "high_uncertainty", stageHint: "ownership" }))).toBe(
      "OWNERSHIP",
    );
    expect(routeCategory(report({ source: "shadow_disagreement", stageHint: "NOT_A_STAGE" }))).toBe(
      "OTHER",
    );
  });

  it("explicit category hints win, and invalid hints are rejected loudly — never coerced", () => {
    expect(routeCategory(report({ categoryHint: "SESSION", stageHint: "BALL" }))).toBe("SESSION");
    expect(() =>
      routeCategory(report({ categoryHint: "PADDLES" as HardCaseCategory })),
    ).toThrowError(HardCaseRoutingError);
  });
});

describe("dedup", () => {
  it("merges repeat reports of the same (source, category, subject) instead of duplicating", () => {
    const queue = HardCaseQueue.open(new InMemoryEventLog(), clock);
    const first = queue.ingest(report());
    expect(first.outcome).toBe("created");
    const second = queue.ingest(report({ severity: "critical" }));
    expect(second.outcome).toBe("merged");
    expect(second.entry.id).toBe(first.entry.id);
    expect(second.entry.occurrenceCount).toBe(2);
    expect(second.entry.evidence).toHaveLength(2);
    expect(second.entry.severity).toBe("critical");
    expect(queue.list()).toHaveLength(1);
  });

  it("does not merge across sources, categories, or subjects", () => {
    const queue = HardCaseQueue.open(new InMemoryEventLog(), clock);
    queue.ingest(report());
    expect(queue.ingest(report({ source: "red_team" })).outcome).toBe("created");
    expect(queue.ingest(report({ subjectKey: "rec-other" })).outcome).toBe("created");
    expect(queue.ingest(report({ categoryHint: "BALL" })).outcome).toBe("created");
    expect(queue.list()).toHaveLength(4);
    expect(fingerprintOf("user_feedback", "OTHER", "a")).not.toBe(
      fingerprintOf("user_feedback", "BALL", "a"),
    );
  });
});

describe("state machine", () => {
  const openWithEntry = (): { queue: HardCaseQueue; id: string } => {
    const queue = HardCaseQueue.open(new InMemoryEventLog(), clock);
    return { queue, id: queue.ingest(report()).entry.id };
  };

  it("walks the full legal path new → triaged → in-review → resolved", () => {
    const { queue, id } = openWithEntry();
    expect(queue.get(id).state).toBe("new");
    queue.transition(id, "triaged", "coach-a", "confirmed real failure");
    queue.transition(id, "in-review", "coach-a", "assigned");
    queue.transition(id, "resolved", "coach-a", "fixed in stroke heuristic v6 candidate");
    const entry = queue.get(id);
    expect(entry.state).toBe("resolved");
    expect(entry.history.map((h) => h.to)).toEqual(["triaged", "in-review", "resolved"]);
  });

  it("supports regression re-entry: resolved → regression → triaged", () => {
    const { queue, id } = openWithEntry();
    queue.transition(id, "triaged", "a", "");
    queue.transition(id, "in-review", "a", "");
    queue.transition(id, "resolved", "a", "");
    queue.transition(id, "regression", "a", "recurred in nightly bench");
    expect(queue.get(id).regressionCount).toBe(1);
    queue.transition(id, "triaged", "a", "re-triaged");
    expect(queue.get(id).state).toBe("triaged");
  });

  it("rejects every transition not in the transition table", () => {
    for (const from of HARD_CASE_STATES) {
      for (const to of HARD_CASE_STATES) {
        if (HARD_CASE_TRANSITIONS[from].includes(to)) continue;
        const queue = HardCaseQueue.open(new InMemoryEventLog(), clock);
        const id = queue.ingest(report()).entry.id;
        forceState(queue, id, from);
        expect(() => queue.transition(id, to, "x", "")).toThrowError(HardCaseTransitionError);
        expect(queue.get(id).state).toBe(from);
      }
    }
  });

  it("throws on unknown entries instead of ignoring them", () => {
    const queue = HardCaseQueue.open(new InMemoryEventLog(), clock);
    expect(() => queue.transition("hc-missing", "triaged", "x", "")).toThrowError(
      HardCaseNotFoundError,
    );
    expect(() => queue.get("hc-missing")).toThrowError(HardCaseNotFoundError);
  });

  it("reopens a resolved case as a regression when the same failure recurs", () => {
    const { queue, id } = openWithEntry();
    queue.transition(id, "triaged", "a", "");
    queue.transition(id, "in-review", "a", "");
    queue.transition(id, "resolved", "a", "");
    const reopened = queue.ingest(report({ severity: "high" }));
    expect(reopened.outcome).toBe("regression_reopened");
    expect(reopened.entry.id).toBe(id);
    expect(reopened.entry.state).toBe("regression");
    expect(reopened.entry.regressionCount).toBe(1);
    expect(reopened.entry.history.at(-1)?.actor).toBe("system:dedup");
  });
});

/** Walk an entry to `target` through legal transitions only. */
function forceState(queue: HardCaseQueue, id: string, target: HardCaseState): void {
  const path: Record<HardCaseState, HardCaseState[]> = {
    new: [],
    triaged: ["triaged"],
    "in-review": ["triaged", "in-review"],
    resolved: ["triaged", "in-review", "resolved"],
    regression: ["triaged", "in-review", "regression"],
  };
  for (const step of path[target]) queue.transition(id, step, "test", "");
}

describe("no silent drops", () => {
  it("every ingested report is accounted for as created, merged, or reopened", () => {
    const queue = HardCaseQueue.open(new InMemoryEventLog(), clock);
    const sources: HardCaseSource[] = [...HARD_CASE_SOURCES, ...HARD_CASE_SOURCES];
    let n = 0;
    for (const source of sources) {
      n += 1;
      queue.ingest(report({ source, subjectKey: `rec-${n % 12}` }));
    }
    const ledger = queue.ledger();
    expect(ledger.ingested).toBe(sources.length);
    expect(ledger.created + ledger.merged + ledger.regressionReopened).toBe(sources.length);
    expect(queue.list()).toHaveLength(ledger.created);
    queue.assertNoSilentDrops();
  });

  it("a report that fails routing throws before anything is recorded (no half-ingests)", () => {
    const queue = HardCaseQueue.open(new InMemoryEventLog(), clock);
    expect(() => queue.ingest(report({ categoryHint: "bogus" as HardCaseCategory }))).toThrowError(
      HardCaseRoutingError,
    );
    expect(queue.ledger().ingested).toBe(0);
    expect(queue.list()).toHaveLength(0);
  });

  it("there is no API to delete or remove an entry", () => {
    const queue = HardCaseQueue.open(new InMemoryEventLog(), clock);
    const publicApi = Object.getOwnPropertyNames(Object.getPrototypeOf(queue));
    for (const name of publicApi) {
      expect(name.toLowerCase()).not.toContain("delete");
      expect(name.toLowerCase()).not.toContain("remove");
      expect(name.toLowerCase()).not.toContain("purge");
    }
  });
});

describe("persistence (event-log replay)", () => {
  it("a reopened file-backed queue reproduces the exact prior state", () => {
    const dir = mkdtempSync(join(tmpdir(), "hard-case-"));
    const path = join(dir, "hard-cases.jsonl");
    const queue = HardCaseQueue.open(new FileEventLog(path), clock);
    const a = queue.ingest(report()).entry.id;
    queue.ingest(report({ source: "shadow_disagreement", stageHint: "STROKE" }));
    queue.transition(a, "triaged", "coach-a", "real");
    queue.transition(a, "in-review", "coach-a", "");
    queue.transition(a, "resolved", "coach-a", "fixed");
    queue.ingest(report({ severity: "high" })); // regression reopen
    const before = queue.list();
    const reopened = HardCaseQueue.open(new FileEventLog(path), clock);
    expect(reopened.list()).toEqual(before);
    expect(reopened.ledger()).toEqual(queue.ledger());
    reopened.assertNoSilentDrops();
  });

  it("a corrupt log line makes open() throw — events are never silently skipped", () => {
    const dir = mkdtempSync(join(tmpdir(), "hard-case-"));
    const path = join(dir, "hard-cases.jsonl");
    const queue = HardCaseQueue.open(new FileEventLog(path), clock);
    queue.ingest(report());
    appendFileSync(path, "{truncated-mid-write\n", "utf8");
    expect(() => HardCaseQueue.open(new FileEventLog(path), clock)).toThrowError(/corrupt/);
  });

  it("a gap in the event sequence (a lost event) is detected on open", () => {
    const dir = mkdtempSync(join(tmpdir(), "hard-case-"));
    const path = join(dir, "hard-cases.jsonl");
    const queue = HardCaseQueue.open(new FileEventLog(path), clock);
    queue.ingest(report());
    queue.ingest(report({ subjectKey: "rec-b" }));
    const lines = readFileSync(path, "utf8").trim().split("\n");
    writeFileSync(path, `${lines[1]}\n`, "utf8"); // drop the first event
    expect(() => HardCaseQueue.open(new FileEventLog(path), clock)).toThrowError(/seq/);
  });
});
