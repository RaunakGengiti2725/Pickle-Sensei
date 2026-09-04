import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  FileEventLog,
  HARD_CASE_CATEGORIES,
  HARD_CASE_SEVERITIES,
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
  type HardCaseCategory,
  type HardCaseEventLog,
  type HardCaseReport,
  type HardCaseSeverity,
  type HardCaseState,
} from "../src/index.js";
import {
  check,
  describeFailures,
  executeSteps,
  findNonFinite,
  makeRng,
  readStressEnv,
  runCampaign,
  type Rng,
} from "../../../tools/stress-kit/kit.js";

/**
 * SEEDED RANDOMIZED LONG-RUN over the hard-case queue public API.
 *
 * Model-checked invariants (from types.ts / queue.ts / stateMachine.ts):
 *  I1  ledger: ingested === created + merged + regressionReopened, and
 *      created === number of entries (assertNoSilentDrops never throws).
 *  I2  dedup: one entry per fingerprint source::category::subjectKey; a
 *      re-report merges (occurrenceCount+1, evidence appended) or, if the
 *      case is resolved, reopens it as `regression` (regressionCount+1).
 *  I3  severity is monotonic: entry.severity === max severity ever reported.
 *  I4  only HARD_CASE_TRANSITIONS edges are accepted; an illegal transition,
 *      unknown entry id or invalid categoryHint throws and leaves the queue
 *      (entries, ledger, log length) byte-identical.
 *  I5  the queue is exactly the replay of its log: HardCaseQueue.open(log)
 *      reproduces list() and ledger(); log seqs are contiguous 1..n.
 *  I6  same seed → identical trace (kit-level determinism check).
 *  I7  no NaN/Infinity anywhere in entries or the ledger.
 *
 * Fixtures are synthetic (`SYNTHETIC-STRESS.*`), never corpus data.
 */

const SUBJECTS = Array.from({ length: 6 }, (_, i) => `SYNTHETIC-STRESS.subject-${i}`);
const STAGE_HINTS = ["target", " ball ", "Paddle", "not-a-stage", "contact", ""];

type Action =
  | {
      kind: "ingest";
      source: number;
      subject: number;
      severity: number;
      hint: "none" | "category" | "stage" | "invalidCategory";
      hintIndex: number;
      ref: number;
    }
  | { kind: "transition"; entry: number; to: number; unknownId: boolean }
  | { kind: "reopen" };

function generate(rng: Rng, length: number): Action[] {
  const actions: Action[] = [];
  for (let i = 0; i < length; i += 1) {
    const roll = rng.next();
    if (roll < 0.45) {
      const hintRoll = rng.next();
      actions.push({
        kind: "ingest",
        source: rng.int(HARD_CASE_SOURCES.length),
        subject: rng.int(SUBJECTS.length),
        severity: rng.int(HARD_CASE_SEVERITIES.length),
        hint:
          hintRoll < 0.4
            ? "none"
            : hintRoll < 0.65
              ? "category"
              : hintRoll < 0.95
                ? "stage"
                : "invalidCategory",
        hintIndex: rng.int(Math.max(HARD_CASE_CATEGORIES.length, STAGE_HINTS.length)),
        ref: rng.int(1_000_000),
      });
    } else if (roll < 0.92) {
      actions.push({
        kind: "transition",
        entry: rng.int(64),
        to: rng.int(HARD_CASE_STATES.length),
        unknownId: rng.bool(0.05),
      });
    } else {
      actions.push({ kind: "reopen" });
    }
  }
  return actions;
}

interface ModelEntry {
  state: HardCaseState;
  severity: HardCaseSeverity;
  occurrences: number;
  regressionCount: number;
  evidence: number;
  history: number;
}

const sevRank = (s: HardCaseSeverity): number => HARD_CASE_SEVERITIES.indexOf(s);

function snapshot(queue: HardCaseQueue, log: HardCaseEventLog): string {
  return JSON.stringify({ list: queue.list(), ledger: queue.ledger(), n: log.readAll().length });
}

function makeExecutor(logFactory: () => HardCaseEventLog) {
  return (actions: readonly Action[]) => {
    let tick = 0;
    const now = (): string => new Date(Date.UTC(2026, 8, 4, 0, 0, tick++)).toISOString();
    const log = logFactory();
    let queue = HardCaseQueue.open(log, now);
    const model = new Map<string, ModelEntry>();
    const ledger = { ingested: 0, created: 0, merged: 0, regressionReopened: 0 };

    const checkInvariants = (): void => {
      queue.assertNoSilentDrops();
      const entries = queue.list();
      const actual = queue.ledger();
      check(
        JSON.stringify(actual) === JSON.stringify(ledger),
        "I1 ledger",
        () => `queue=${JSON.stringify(actual)} model=${JSON.stringify(ledger)}`,
      );
      check(
        entries.length === model.size && ledger.created === entries.length,
        "I1 entries",
        () => `entries=${entries.length} model=${model.size} created=${ledger.created}`,
      );
      check(new Set(entries.map((e) => e.id)).size === entries.length, "I2 unique ids", () =>
        entries.map((e) => e.id).join(","),
      );
      for (const entry of entries) {
        const expected = model.get(entry.fingerprint);
        check(expected !== undefined, "I2 fingerprint", () => `unknown ${entry.fingerprint}`);
        if (expected === undefined) continue;
        check(
          entry.fingerprint === fingerprintOf(entry.source, entry.category, entry.subjectKey),
          "I2 fingerprint shape",
          () => entry.fingerprint,
        );
        check(entry.state === expected.state, "I4 state", () => `${entry.id}: ${entry.state}`);
        check(
          entry.severity === expected.severity,
          "I3 severity monotonic",
          () => `${entry.id}: ${entry.severity} != ${expected.severity}`,
        );
        check(
          entry.occurrenceCount === expected.occurrences &&
            entry.evidence.length === expected.evidence,
          "I2 occurrence/evidence",
          () => `${entry.id}: occ=${entry.occurrenceCount} ev=${entry.evidence.length}`,
        );
        check(
          entry.regressionCount === expected.regressionCount,
          "I2 regressionCount",
          () => `${entry.id}: ${entry.regressionCount} != ${expected.regressionCount}`,
        );
        check(
          entry.history.length === expected.history,
          "I4 history length",
          () => `${entry.id}: ${entry.history.length} != ${expected.history}`,
        );
        for (const record of entry.history) {
          check(
            HARD_CASE_TRANSITIONS[record.from].includes(record.to),
            "I4 history edge",
            () => `${entry.id}: ${record.from} -> ${record.to}`,
          );
        }
      }
      const seqs = log.readAll().map((e) => e.seq);
      check(
        seqs.every((s, i) => s === i + 1),
        "I5 contiguous seq",
        () => seqs.join(","),
      );
      const nonFinite = findNonFinite({ entries, ledger: actual });
      check(nonFinite === null, "I7 finite", () => nonFinite ?? "");
    };

    return executeSteps(actions, (action) => {
      if (action.kind === "reopen") {
        const before = snapshot(queue, log);
        const reopened = HardCaseQueue.open(log, now);
        const after = snapshot(reopened, log);
        check(before === after, "I5 replay", () => `before=${before}\nafter=${after}`);
        queue = reopened;
        checkInvariants();
        return { reopen: true, entries: reopened.list().length };
      }
      if (action.kind === "ingest") {
        const source = HARD_CASE_SOURCES[action.source]!;
        const severity = HARD_CASE_SEVERITIES[action.severity]!;
        const report: HardCaseReport = {
          source,
          subjectKey: SUBJECTS[action.subject]!,
          severity,
          evidence: {
            source,
            ref: `SYNTHETIC-STRESS.ref-${action.ref}`,
            detail: "synthetic stress report",
            observedAtIso: "2026-09-04T00:00:00.000Z",
          },
        };
        let expectedCategory: HardCaseCategory | null = SOURCE_DEFAULT_CATEGORY[source];
        if (action.hint === "category") {
          const category = HARD_CASE_CATEGORIES[action.hintIndex % HARD_CASE_CATEGORIES.length]!;
          report.categoryHint = category;
          expectedCategory = category;
        } else if (action.hint === "stage") {
          const stage = STAGE_HINTS[action.hintIndex % STAGE_HINTS.length]!;
          report.stageHint = stage;
          const normalized = stage.trim().toUpperCase();
          if ((HARD_CASE_CATEGORIES as readonly string[]).includes(normalized)) {
            expectedCategory = normalized as HardCaseCategory;
          }
        } else if (action.hint === "invalidCategory") {
          report.categoryHint = "NOT_A_CATEGORY" as HardCaseCategory;
          expectedCategory = null;
        }
        if (expectedCategory === null) {
          const before = snapshot(queue, log);
          let thrown: unknown = null;
          try {
            queue.ingest(report);
          } catch (error) {
            thrown = error;
          }
          check(
            thrown instanceof HardCaseRoutingError,
            "I4 invalid hint rejected",
            () => `thrown=${String(thrown)}`,
          );
          check(before === snapshot(queue, log), "I4 rejected ingest is a no-op", () => "");
          checkInvariants();
          return { ingest: "rejected" };
        }
        const fingerprint = fingerprintOf(source, expectedCategory, report.subjectKey);
        const existing = model.get(fingerprint);
        let expectedOutcome: "created" | "merged" | "regression_reopened";
        ledger.ingested += 1;
        if (existing === undefined) {
          model.set(fingerprint, {
            state: "new",
            severity,
            occurrences: 1,
            regressionCount: 0,
            evidence: 1,
            history: 0,
          });
          ledger.created += 1;
          expectedOutcome = "created";
        } else {
          existing.occurrences += 1;
          existing.evidence += 1;
          if (sevRank(severity) > sevRank(existing.severity)) existing.severity = severity;
          if (existing.state === "resolved") {
            existing.state = "regression";
            existing.regressionCount += 1;
            existing.history += 1;
            ledger.regressionReopened += 1;
            expectedOutcome = "regression_reopened";
          } else {
            ledger.merged += 1;
            expectedOutcome = "merged";
          }
        }
        const result = queue.ingest(report);
        check(
          result.outcome === expectedOutcome,
          "I2 ingest outcome",
          () => `${result.outcome} != ${expectedOutcome} for ${fingerprint}`,
        );
        check(
          result.entry.fingerprint === fingerprint && result.entry.category === expectedCategory,
          "I2 routing",
          () => `${result.entry.fingerprint} != ${fingerprint}`,
        );
        checkInvariants();
        return { ingest: result.outcome, id: result.entry.id, state: result.entry.state };
      }
      // transition
      const entries = queue.list();
      const to = HARD_CASE_STATES[action.to]!;
      const before = snapshot(queue, log);
      if (entries.length === 0 || action.unknownId) {
        const bogus = `hc-${String(999_000 + action.entry).padStart(6, "0")}`;
        let thrown: unknown = null;
        try {
          queue.transition(bogus, to, "SYNTHETIC-STRESS.actor", "note");
        } catch (error) {
          thrown = error;
        }
        check(thrown instanceof HardCaseNotFoundError, "I4 unknown id", () => String(thrown));
        check(before === snapshot(queue, log), "I4 unknown id is a no-op", () => "");
        checkInvariants();
        return { transition: "not-found" };
      }
      const target = entries[action.entry % entries.length]!;
      const entry = model.get(target.fingerprint)!;
      const legal = HARD_CASE_TRANSITIONS[entry.state].includes(to);
      if (!legal) {
        let thrown: unknown = null;
        try {
          queue.transition(target.id, to, "SYNTHETIC-STRESS.actor", "note");
        } catch (error) {
          thrown = error;
        }
        check(
          thrown instanceof HardCaseTransitionError,
          "I4 illegal transition rejected",
          () => `${entry.state} -> ${to}: ${String(thrown)}`,
        );
        check(before === snapshot(queue, log), "I4 illegal transition is a no-op", () => "");
        checkInvariants();
        return { transition: "illegal", from: entry.state, to };
      }
      const updated = queue.transition(target.id, to, "SYNTHETIC-STRESS.actor", "note");
      entry.state = to;
      entry.history += 1;
      if (to === "regression") entry.regressionCount += 1;
      check(updated.state === to, "I4 transition applied", () => updated.state);
      checkInvariants();
      return { transition: "ok", id: target.id, to };
    });
  };
}

const env = readStressEnv(150);
const tmp = mkdtempSync(join(tmpdir(), "hard-case-stress-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("hard-case-queue seeded randomized long-run", () => {
  it("in-memory log: invariants I1–I7 hold for every seed and every step", () => {
    const report = runCampaign<Action>({
      campaign: "hard-case-queue.inmemory",
      env,
      minLength: 5,
      maxLength: 60,
      generate,
      execute: makeExecutor(() => new InMemoryEventLog()),
    });
    expect(report.sequencesExecuted).toBe(env.iterations);
    expect(describeFailures(report)).toBe("");
    expect(report.broken + report.nondeterministic).toBe(0);
  });

  it("file log (JSONL): replay from disk reproduces the queue for every seed", () => {
    // Disk I/O per step is slower; run a fraction of the campaign on FileEventLog.
    const fileEnv = { ...env, iterations: Math.max(1, Math.ceil(env.iterations / 10)) };
    let fileIndex = 0;
    const report = runCampaign<Action>({
      campaign: "hard-case-queue.filelog",
      env: fileEnv,
      minLength: 5,
      maxLength: 60,
      generate,
      execute: makeExecutor(() => new FileEventLog(join(tmp, `log-${fileIndex++}.jsonl`))),
    });
    expect(report.sequencesExecuted).toBe(fileEnv.iterations);
    expect(describeFailures(report)).toBe("");
    expect(report.broken + report.nondeterministic).toBe(0);
  });

  it("rng is reproducible (sanity for the seed→trace contract)", () => {
    const a = makeRng(42);
    const b = makeRng(42);
    expect(Array.from({ length: 16 }, () => a.int(1000))).toEqual(
      Array.from({ length: 16 }, () => b.int(1000)),
    );
  });
});
