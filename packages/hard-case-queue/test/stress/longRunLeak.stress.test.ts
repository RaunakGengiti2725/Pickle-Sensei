import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FileEventLog,
  HARD_CASE_CATEGORIES,
  HARD_CASE_SEVERITIES,
  HARD_CASE_SOURCES,
  HARD_CASE_STATES,
  HARD_CASE_TRANSITIONS,
  HardCaseQueue,
  HardCaseTransitionError,
  InMemoryEventLog,
  fingerprintOf,
  routeCategory,
  type HardCaseEvent,
  type HardCaseEventLog,
  type HardCaseReport,
  type HardCaseState,
  type IngestOutcome,
} from "../../src/index.js";
import {
  SeededRng,
  type IterationOutcome,
  digestOf,
  nonFinitePaths,
  nondeterministicSeeds,
  runLeakCampaign,
  stressIterations,
  summarizeReport,
  writeReportIfRequested,
} from "../../../../tools/stress/leakHarness.js";

/**
 * LONG-RUN LEAK lens for @pickle/hard-case-queue. Each iteration opens a
 * queue on a fresh event log (in-memory, or a temp JSONL file every 8th
 * iteration to exercise fd handling), feeds it a seeded stream of synthetic
 * reports and transitions, predicts every ingest outcome with an independent
 * fingerprint→state model, and replays the log into a second queue that must
 * be indistinguishable from the first. STRESS_ITER=500 for the full campaign.
 */

const ITER = stressIterations(60);
const BASE_SEED = 0x4c0e_0001;
const SUBJECT_POOL = 24;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "hard-case-queue-stress-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function clockFrom(rng: SeededRng): () => string {
  let ms = 1_760_000_000_000 + rng.int(0, 1_000_000);
  const step = rng.int(1, 5000);
  return () => {
    ms += step;
    return new Date(ms).toISOString();
  };
}

function randomReport(rng: SeededRng, seed: number, n: number): HardCaseReport {
  const report: HardCaseReport = {
    source: rng.pick(HARD_CASE_SOURCES),
    subjectKey: `SYNTHETIC-TEST-FIXTURE.subject-${rng.int(0, SUBJECT_POOL - 1)}`,
    severity: rng.pick(HARD_CASE_SEVERITIES),
    evidence: {
      source: rng.pick(HARD_CASE_SOURCES),
      ref: `synthetic://${seed.toString(16)}/${n}`,
      detail: `report ${n}`,
      observedAtIso: "2026-09-01T00:00:00.000Z",
    },
  };
  const roll = rng.next();
  if (roll < 0.3) report.categoryHint = rng.pick(HARD_CASE_CATEGORIES);
  else if (roll < 0.6) report.stageHint = rng.pick([...HARD_CASE_CATEGORIES, "bogus", " ball "]);
  return report;
}

/** A log that fails on seeded appends — the queue must never lose the event quietly. */
class FlakyLog implements HardCaseEventLog {
  private readonly inner = new InMemoryEventLog();
  failures = 0;
  constructor(private readonly failOn: ReadonlySet<number>) {}
  append(event: HardCaseEvent): void {
    if (this.failOn.has(event.seq)) {
      this.failures += 1;
      throw new Error(`synthetic disk failure at seq ${event.seq}`);
    }
    this.inner.append(event);
  }
  readAll(): HardCaseEvent[] {
    return this.inner.readAll();
  }
}

function queueDigest(queue: HardCaseQueue): string {
  return digestOf({ entries: queue.list(), ledger: queue.ledger() });
}

function queueIteration(seed: number, iteration: number): IterationOutcome {
  const rng = new SeededRng(seed);
  const useFile = iteration % 8 === 7;
  const filePath = join(dir, `log-${seed.toString(16)}.jsonl`);
  const log: HardCaseEventLog = useFile ? new FileEventLog(filePath) : new InMemoryEventLog();
  const problems: string[] = [];
  const modelState = new Map<string, HardCaseState>();
  const outcomes: Record<IngestOutcome, number> = { created: 0, merged: 0, regression_reopened: 0 };
  let transitions = 0;
  let rejectedTransitions = 0;

  try {
    const queue = HardCaseQueue.open(log, clockFrom(rng));
    const ops = rng.int(5, 90);
    for (let n = 0; n < ops; n += 1) {
      if (rng.chance(0.55) || modelState.size === 0) {
        const report = randomReport(rng, seed, n);
        const category = routeCategory(report);
        const fp = fingerprintOf(report.source, category, report.subjectKey);
        const prior = modelState.get(fp);
        const expected: IngestOutcome =
          prior === undefined ? "created" : prior === "resolved" ? "regression_reopened" : "merged";
        const result = queue.ingest(report);
        outcomes[result.outcome] += 1;
        if (result.outcome !== expected) {
          problems.push(`op ${n}: outcome ${result.outcome}, model ${expected}`);
        }
        if (result.entry.fingerprint !== fp) problems.push(`op ${n}: fingerprint mismatch`);
        modelState.set(fp, expected === "regression_reopened" ? "regression" : (prior ?? "new"));
        if (result.entry.state !== modelState.get(fp)) {
          problems.push(`op ${n}: state ${result.entry.state} vs model ${modelState.get(fp)}`);
        }
      } else {
        const entries = queue.list();
        const entry = rng.pick(entries);
        const legal = HARD_CASE_TRANSITIONS[entry.state];
        if (rng.chance(0.25)) {
          const illegal = HARD_CASE_STATES.filter((s) => !legal.includes(s));
          const to = rng.pick(illegal);
          try {
            queue.transition(entry.id, to, "SYNTHETIC-TEST-FIXTURE.triager", "illegal");
            problems.push(`op ${n}: illegal ${entry.state}→${to} accepted`);
          } catch (error) {
            if (!(error instanceof HardCaseTransitionError)) {
              problems.push(`op ${n}: illegal transition threw ${String(error)}`);
            }
            rejectedTransitions += 1;
          }
        } else {
          const to = rng.pick(legal);
          const before = entry.state;
          const updated = queue.transition(
            entry.id,
            to,
            "SYNTHETIC-TEST-FIXTURE.triager",
            `→${to}`,
          );
          transitions += 1;
          if (updated.state !== to) problems.push(`op ${n}: transition landed on ${updated.state}`);
          if (updated.history.at(-1)?.from !== before) problems.push(`op ${n}: history from`);
          modelState.set(entry.fingerprint, to);
        }
      }
    }

    queue.assertNoSilentDrops();
    const ledger = queue.ledger();
    if (ledger.ingested !== outcomes.created + outcomes.merged + outcomes.regression_reopened) {
      problems.push("ledger.ingested != observed outcomes");
    }
    if (ledger.created !== outcomes.created || ledger.merged !== outcomes.merged) {
      problems.push("ledger counters diverge from observed outcomes");
    }
    if (ledger.regressionReopened !== outcomes.regression_reopened) {
      problems.push("ledger.regressionReopened diverges");
    }
    for (const entry of queue.list()) {
      if (entry.occurrenceCount !== entry.evidence.length) {
        problems.push(
          `${entry.id}: occurrenceCount ${entry.occurrenceCount} != evidence ${entry.evidence.length}`,
        );
      }
      if (entry.state !== modelState.get(entry.fingerprint)) {
        problems.push(`${entry.id}: final state ${entry.state} vs model`);
      }
      problems.push(...nonFinitePaths(entry, entry.id));
    }
    const events = log.readAll();
    events.forEach((event, i) => {
      if (event.seq !== i + 1) problems.push(`event seq ${event.seq} at index ${i}`);
    });

    const original = queueDigest(queue);
    const replayed = HardCaseQueue.open(log, () => "1970-01-01T00:00:00.000Z");
    replayed.assertNoSilentDrops();
    if (queueDigest(replayed) !== original) problems.push("replayed queue differs from original");

    if (problems.length > 0) throw new Error(problems.join("; "));
    return {
      outcome: `${useFile ? "file" : "mem"}:${outcomes.created}c/${outcomes.merged}m/${outcomes.regression_reopened}r`,
      digest: original,
      retainables: [queue, replayed, log],
      detail: { ops, transitions, rejectedTransitions, events: events.length, ...outcomes },
    };
  } finally {
    if (useFile) {
      try {
        unlinkSync(filePath);
      } catch {
        // Iterations that threw before the first append have no file to remove.
      }
    }
  }
}

describe(
  "hard-case-queue long-run leak (seeded, one process)",
  { timeout: 30_000 + ITER * 400 },
  () => {
    it(`opens, drives and replays ${ITER} seeded queues without retaining any`, async () => {
      const report = await runLeakCampaign({
        name: "hard-case-queue.lifecycle",
        baseSeed: BASE_SEED,
        iterations: ITER,
        run: queueIteration,
      });
      const path = writeReportIfRequested(report);
      console.log(summarizeReport(report), path ?? "");

      expect(report.gcForced).toBe(true);
      expect(report.iterations).toBe(ITER);
      expect(report.failures).toEqual([]);
      expect(report.retained.maxAtAnyCheckpoint).toBe(0);
      expect(report.handles.grown).toEqual({});
      if (ITER >= 200) {
        expect(report.heap.monotoneIncreasing && report.heap.slopePctPer100 > 5).toBe(false);
      }
    });

    it(`one long-lived file-backed queue absorbs ${ITER} bursts from a bounded subject pool`, async () => {
      const filePath = join(dir, "long-lived.jsonl");
      const log = new FileEventLog(filePath);
      const clock = clockFrom(new SeededRng(BASE_SEED));
      const queue = HardCaseQueue.open(log, clock);
      let ingested = 0;
      const report = await runLeakCampaign({
        name: "hard-case-queue.long-lived-file",
        baseSeed: BASE_SEED + 100_000,
        iterations: ITER,
        run: (seed) => {
          const rng = new SeededRng(seed);
          const burst = rng.int(5, 20);
          for (let n = 0; n < burst; n += 1) {
            queue.ingest(randomReport(rng, seed, n));
            ingested += 1;
          }
          const candidates = queue.list().filter((e) => HARD_CASE_TRANSITIONS[e.state].length > 0);
          if (candidates.length > 0) {
            const entry = rng.pick(candidates);
            queue.transition(entry.id, rng.pick(HARD_CASE_TRANSITIONS[entry.state]), "sys", "n");
          }
          queue.assertNoSilentDrops();
          const ledger = queue.ledger();
          if (ledger.ingested !== ingested)
            throw new Error(`ledger ${ledger.ingested} != ${ingested}`);
          if (
            queue.list().length >
            SUBJECT_POOL * HARD_CASE_SOURCES.length * HARD_CASE_CATEGORIES.length
          ) {
            throw new Error("more entries than distinct fingerprints");
          }
          return {
            outcome: `entries=${queue.list().length}`,
            digest: digestOf(ledger),
            detail: { burst },
          };
        },
      });
      const path = writeReportIfRequested(report);
      console.log(summarizeReport(report), path ?? "");

      expect(report.gcForced).toBe(true);
      expect(report.failures).toEqual([]);
      expect(report.handles.grown).toEqual({});
      // Durable replay of the whole campaign must reproduce the live queue exactly.
      const replayed = HardCaseQueue.open(new FileEventLog(filePath));
      replayed.assertNoSilentDrops();
      expect(queueDigest(replayed)).toBe(queueDigest(queue));
      expect(replayed.ledger().ingested).toBe(ingested);
      // Heap growth here is the append-only design (evidence per merge), not a
      // leak: it must stay bounded by a linear function of the ingest count.
      const bytesPerIngest =
        (report.heap.lastCheckpointBytes - report.heap.firstCheckpointBytes) / ingested;
      console.log(
        `[hard-case-queue.long-lived-file] ingested=${ingested} bytes/ingest=${bytesPerIngest.toFixed(0)}`,
      );
      expect(bytesPerIngest).toBeLessThan(4096);
    });

    it("a failing append is loud: the caller sees the error and the log refuses to reopen with a gap", () => {
      const rng = new SeededRng(BASE_SEED + 7);
      const failOn = new Set([3, 8]);
      const log = new FlakyLog(failOn);
      const queue = HardCaseQueue.open(log, clockFrom(rng));
      let thrown = 0;
      for (let n = 0; n < 10; n += 1) {
        try {
          queue.ingest(randomReport(rng, BASE_SEED + 7, n));
        } catch (error) {
          thrown += 1;
          expect(String(error)).toContain("synthetic disk failure");
        }
      }
      expect(thrown).toBe(failOn.size);
      expect(log.failures).toBe(failOn.size);
      // In-memory state is ahead of the durable log — reopening must refuse rather than drop.
      expect(() => HardCaseQueue.open(log)).toThrow(/corrupt: expected seq 3, found 4/);
    });

    it("same seed → identical queue digest", () => {
      const seeds = Array.from({ length: Math.min(ITER, 25) }, (_, i) => BASE_SEED + i);
      expect(nondeterministicSeeds(seeds, queueIteration)).toEqual([]);
    });
  },
);
