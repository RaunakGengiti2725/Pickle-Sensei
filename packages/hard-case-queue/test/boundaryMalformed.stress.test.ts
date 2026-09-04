import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FileEventLog,
  HARD_CASE_CATEGORIES,
  HARD_CASE_SEVERITIES,
  HARD_CASE_SOURCES,
  HARD_CASE_STATES,
  HardCaseQueue,
  routeCategory,
  type HardCaseEntry,
  type HardCaseEvent,
  type HardCaseReport,
  type HardCaseState,
} from "../src/index.js";
import {
  campaignTimeoutMs,
  campaignVerdict,
  classifyThrown,
  findNonFinite,
  findOwnProtoKeys,
  outputDir,
  runCampaign,
  runGuarded,
  stableJson,
  typedShapeGap,
  writeReport,
  type ExecResult,
  type KnownGap,
  type StressCase,
} from "../../../tools/stress/boundary-malformed/harness.js";
import {
  describeValue,
  materialize,
  planMutations,
  type FieldSpec,
} from "../../../tools/stress/boundary-malformed/payloads.js";

/**
 * Boundary / malformed-input stress campaign for @pickle/hard-case-queue.
 *
 * Every case drives a fresh `HardCaseQueue` over a `FileEventLog` in a
 * per-execution scratch directory with a fixed clock, so the log-vs-memory
 * invariant ("a queue is the replay of its log") can be checked after each
 * malformed call:
 *   - a rejected ingest/transition must leave BOTH the log and the in-memory
 *     state untouched (no half-applied writes);
 *   - an accepted ingest must be replayable: `HardCaseQueue.open` on the same
 *     log yields identical entries and a passing `assertNoSilentDrops()`;
 *   - a corrupt log line must make `open` throw (never silently shorten).
 *
 * Scale: STRESS_ITER (default 60). Replay one row: STRESS_REPLAY=<seed>.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const clock = (): (() => string) => {
  let tick = 0;
  return () => new Date(1_756_500_000_000 + ++tick * 1000).toISOString();
};

const REPORT: HardCaseReport = {
  source: "user_feedback",
  subjectKey: "rec-6e06a3157947",
  severity: "medium",
  evidence: {
    source: "user_feedback",
    ref: "feedback/fb-001",
    detail: "user flagged the forehand-drive verdict as wrong",
    observedAtIso: "2026-08-29T00:00:00.000Z",
  },
  stageHint: "TARGET",
};

const REPORT_FIELDS: FieldSpec[] = [
  { path: ["source"], kind: "enum" },
  { path: ["subjectKey"], kind: "string" },
  { path: ["severity"], kind: "enum" },
  { path: ["evidence"], kind: "object" },
  { path: ["evidence", "source"], kind: "enum" },
  { path: ["evidence", "ref"], kind: "string" },
  { path: ["evidence", "detail"], kind: "string" },
  { path: ["evidence", "observedAtIso"], kind: "string" },
  { path: ["categoryHint"], kind: "enum" },
  { path: ["stageHint"], kind: "string" },
];

const CATEGORIES: readonly string[] = HARD_CASE_CATEGORIES;
const SOURCES: readonly string[] = HARD_CASE_SOURCES;
const SEVERITIES: readonly string[] = HARD_CASE_SEVERITIES;
const STATES: readonly string[] = HARD_CASE_STATES;

function validateEntry(entry: HardCaseEntry, label: string): string[] {
  const problems: string[] = [];
  if (!SOURCES.includes(entry.source))
    problems.push(`${label}.source=${describeValue(entry.source)}`);
  if (!CATEGORIES.includes(entry.category)) {
    problems.push(`${label}.category=${describeValue(entry.category)}`);
  }
  if (!SEVERITIES.includes(entry.severity)) {
    problems.push(`${label}.severity=${describeValue(entry.severity)}`);
  }
  if (!STATES.includes(entry.state)) problems.push(`${label}.state=${describeValue(entry.state)}`);
  if (typeof entry.subjectKey !== "string") {
    problems.push(`${label}.subjectKey type ${typeof entry.subjectKey}`);
  }
  if (!Number.isInteger(entry.occurrenceCount) || entry.occurrenceCount < 1) {
    problems.push(`${label}.occurrenceCount=${describeValue(entry.occurrenceCount)}`);
  }
  if (!Array.isArray(entry.evidence) || entry.evidence.length !== entry.occurrenceCount) {
    problems.push(`${label}.evidence length != occurrenceCount`);
  }
  for (const [index, evidence] of (Array.isArray(entry.evidence) ? entry.evidence : []).entries()) {
    if (typeof evidence !== "object" || evidence === null) {
      problems.push(`${label}.evidence[${index}] not an object`);
    } else if (typeof evidence.ref !== "string" || typeof evidence.detail !== "string") {
      problems.push(`${label}.evidence[${index}] ref/detail not strings`);
    }
  }
  problems.push(...findNonFinite(entry, label));
  problems.push(...findOwnProtoKeys(entry, label).map((p) => `own proto key persisted at ${p}`));
  return problems;
}

function entriesJson(entries: HardCaseEntry[]): string {
  return stableJson(entries);
}

/** Opens a second queue over the same log and compares it with the live one. */
function replayDivergence(logPath: string, live: HardCaseQueue): string[] {
  const problems: string[] = [];
  let replayed: HardCaseQueue;
  try {
    replayed = HardCaseQueue.open(new FileEventLog(logPath), clock());
  } catch (thrown) {
    return [`replay of own log failed: ${classifyThrown(thrown).detail}`];
  }
  if (entriesJson(replayed.list()) !== entriesJson(live.list())) {
    problems.push("replayed entries differ from in-memory entries");
  }
  if (stableJson(replayed.ledger()) !== stableJson(live.ledger())) {
    problems.push("replayed ledger differs from in-memory ledger");
  }
  try {
    live.assertNoSilentDrops();
    replayed.assertNoSilentDrops();
  } catch (thrown) {
    problems.push(`assertNoSilentDrops: ${classifyThrown(thrown).detail}`);
  }
  return problems;
}

interface QueueBase {
  report: HardCaseReport;
  /** Log lines (events) the queue is opened from before the call under test. */
  priorEvents: HardCaseEvent[];
  transition: { entryId: string; to: HardCaseState; actor: string; note: string };
}

function seededQueue(logPath: string, prior: HardCaseEvent[]): HardCaseQueue {
  if (prior.length > 0) {
    writeFileSync(logPath, `${prior.map((e) => JSON.stringify(e)).join("\n")}\n`);
  }
  return HardCaseQueue.open(new FileEventLog(logPath), clock());
}

const PRIOR_INGEST: HardCaseEvent = {
  seq: 1,
  type: "ingested",
  atIso: "2026-08-29T00:00:01.000Z",
  report: REPORT,
  outcome: "created",
  entryId: "hc-000001",
};

const PRIOR_TRANSITION: HardCaseEvent = {
  seq: 2,
  type: "transitioned",
  atIso: "2026-08-29T00:00:02.000Z",
  entryId: "hc-000001",
  from: "new",
  to: "triaged",
  actor: "stress",
  note: "seeded",
};

const routeCategoryCase: StressCase<QueueBase> = {
  api: "routeCategory",
  surface: "typed",
  weight: 2,
  mutationRoot: (base) => base.report,
  generate(rng) {
    const plan = planMutations(rng, REPORT_FIELDS, {
      jsonOnly: false,
      allowText: false,
      objectPaths: [[], ["evidence"]],
    });
    return {
      category: plan.category,
      base: { report: REPORT, priorEvents: [], transition: PRIOR_TRANSITION },
      mutations: plan.mutations,
    };
  },
  execute(base, mutations) {
    const { value } = materialize(base.report, mutations);
    return runGuarded(
      () => routeCategory(value as HardCaseReport),
      (category) => (CATEGORIES.includes(category) ? [] : [`routed to ${describeValue(category)}`]),
    );
  },
};

// ingest/transition are store WRITE paths (the report is persisted verbatim to
// the append-only log), so they are held to the boundary standard: a malformed
// report must be rejected before anything is written.
const ingestCase: StressCase<QueueBase> = {
  api: "HardCaseQueue.ingest",
  surface: "boundary",
  weight: 4,
  mutationRoot: (base) => base.report,
  generate(rng) {
    const plan = planMutations(rng, REPORT_FIELDS, {
      jsonOnly: false,
      allowText: false,
      objectPaths: [[], ["evidence"]],
    });
    const priorEvents = rng.chance(0.5) ? [PRIOR_INGEST] : [];
    return {
      category: plan.category,
      base: { report: REPORT, priorEvents, transition: PRIOR_TRANSITION },
      mutations: plan.mutations,
    };
  },
  execute(base, mutations, ctx) {
    const logPath = join(ctx.tmpDir, "queue.jsonl");
    const queue = seededQueue(logPath, base.priorEvents);
    const logBefore = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    const entriesBefore = entriesJson(queue.list());
    const { value } = materialize(base.report, mutations);
    const result: ExecResult = runGuarded(
      () => queue.ingest(value as HardCaseReport),
      (ingest) => {
        const problems = validateEntry(ingest.entry, "entry");
        if (!["created", "merged", "regression_reopened"].includes(ingest.outcome)) {
          problems.push(`outcome=${describeValue(ingest.outcome)}`);
        }
        return problems;
      },
    );
    const logAfter = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    if (result.outcome !== "accepted" && result.outcome !== "returned-invalid") {
      if (logAfter !== logBefore) result.violations.push("write-on-rejected: log grew");
      if (entriesJson(queue.list()) !== entriesBefore) {
        result.violations.push("state-mutated-on-rejected: in-memory entries changed");
      }
    } else if (
      logAfter.split("\n").filter((l) => l !== "").length !==
      base.priorEvents.length + 1
    ) {
      result.violations.push("accepted ingest did not append exactly one event");
    }
    result.violations.push(
      ...replayDivergence(logPath, queue).map((p) => `replay-divergence: ${p}`),
    );
    return result;
  },
};

const transitionCase: StressCase<QueueBase> = {
  api: "HardCaseQueue.transition",
  surface: "boundary",
  weight: 2,
  mutationRoot: (base) => base.transition,
  generate(rng) {
    const plan = planMutations(
      rng,
      [
        { path: ["entryId"], kind: "string" },
        { path: ["to"], kind: "enum" },
        { path: ["actor"], kind: "string" },
        { path: ["note"], kind: "string" },
      ],
      { jsonOnly: false, allowText: false, objectPaths: [[]] },
    );
    return {
      category: plan.category,
      base: {
        report: REPORT,
        priorEvents: [PRIOR_INGEST],
        transition: { entryId: "hc-000001", to: "triaged", actor: "stress", note: "n" },
      },
      mutations: plan.mutations,
    };
  },
  execute(base, mutations, ctx) {
    const logPath = join(ctx.tmpDir, "queue.jsonl");
    const queue = seededQueue(logPath, base.priorEvents);
    const logBefore = readFileSync(logPath, "utf8");
    const entriesBefore = entriesJson(queue.list());
    const { value } = materialize(base.transition, mutations);
    const args = value as QueueBase["transition"];
    const result = runGuarded(
      () => queue.transition(args.entryId, args.to, args.actor, args.note),
      (entry) => validateEntry(entry, "entry"),
    );
    const logAfter = readFileSync(logPath, "utf8");
    if (result.outcome !== "accepted" && result.outcome !== "returned-invalid") {
      if (logAfter !== logBefore) result.violations.push("write-on-rejected: log grew");
      if (entriesJson(queue.list()) !== entriesBefore) {
        result.violations.push("state-mutated-on-rejected: in-memory entries changed");
      }
    }
    result.violations.push(
      ...replayDivergence(logPath, queue).map((p) => `replay-divergence: ${p}`),
    );
    return result;
  },
};

const EVENT_FIELDS: FieldSpec[] = [
  { path: [0, "seq"], kind: "number" },
  { path: [0, "type"], kind: "enum" },
  { path: [0, "atIso"], kind: "string" },
  { path: [0, "report"], kind: "object" },
  ...REPORT_FIELDS.map((f) => ({ ...f, path: [0, "report", ...f.path] })),
  { path: [0, "outcome"], kind: "enum" },
  { path: [0, "entryId"], kind: "string" },
  { path: [1, "seq"], kind: "number" },
  { path: [1, "type"], kind: "enum" },
  { path: [1, "entryId"], kind: "string" },
  { path: [1, "from"], kind: "enum" },
  { path: [1, "to"], kind: "enum" },
  { path: [1, "actor"], kind: "string" },
  { path: [1, "note"], kind: "string" },
];

const openCorruptLogCase: StressCase<QueueBase> = {
  api: "HardCaseQueue.open",
  weight: 3,
  mutationRoot: (base) => base.priorEvents,
  generate(rng) {
    const plan = planMutations(rng, EVENT_FIELDS, {
      jsonOnly: true,
      allowText: true,
      objectPaths: [[0], [1], [0, "report"]],
      schemaPaths: [
        [0, "schemaVersion"],
        [0, "type"],
        [1, "type"],
      ],
    });
    return {
      category: plan.category,
      base: {
        report: REPORT,
        priorEvents: [PRIOR_INGEST, PRIOR_TRANSITION],
        transition: PRIOR_TRANSITION,
      },
      mutations: plan.mutations,
    };
  },
  execute(base, mutations, ctx) {
    const logPath = join(ctx.tmpDir, "queue.jsonl");
    const { value, text } = materialize(base.priorEvents, mutations);
    const hasText = mutations.some((m) => m.op === "text");
    // Structural mutations are written one event per line (the on-disk
    // format); text corruptions act on the whole serialized document.
    const body = hasText
      ? (text ?? "")
      : Array.isArray(value)
        ? `${value.map((event) => JSON.stringify(event)).join("\n")}\n`
        : `${JSON.stringify(value)}\n`;
    writeFileSync(logPath, body);
    const result = runGuarded(
      () => HardCaseQueue.open(new FileEventLog(logPath), clock()),
      (queue) => {
        const problems: string[] = [];
        for (const entry of queue.list()) problems.push(...validateEntry(entry, entry.id));
        try {
          queue.assertNoSilentDrops();
        } catch (thrown) {
          problems.push(classifyThrown(thrown).detail);
        }
        return problems;
      },
    );
    if (readFileSync(logPath, "utf8") !== body) result.violations.push("open rewrote the log");
    return result;
  },
};

/* ------------------------------------------------------------------------ */
/* Known gaps (reproduced, documented behaviour — see the campaign report)   */
/* ------------------------------------------------------------------------ */

const WRITE_APIS = ["HardCaseQueue.ingest", "HardCaseQueue.transition"];

const KNOWN_GAPS: KnownGap[] = [
  {
    id: "HCQ-WRITE-UNVALIDATED",
    finding:
      "queue.ts ingest() validates only categoryHint (via routeCategory) and transition() only " +
      "the state edge; source, severity, subjectKey, evidence, actor and note are persisted " +
      "verbatim to the append-only log (including own __proto__/constructor keys, NaN/Infinity " +
      "and non-string subjectKeys). A NaN/undefined field serialises differently from the " +
      "in-memory entry, so a fresh open() of the same log no longer matches the live queue; an " +
      "exotic (null-prototype) subjectKey crashes fingerprintOf() with a native TypeError.",
    matches: (row) =>
      WRITE_APIS.includes(row.api) &&
      (row.outcome === "returned-invalid" ||
        (row.outcome === "crash-native" && row.errorName === "TypeError")) &&
      row.violations.every((v) => v.startsWith("replay-divergence: ")),
  },
  {
    id: "HCQ-STATE-BEFORE-APPEND",
    finding:
      "queue.ts ingest()/transition() apply the change to in-memory state (applyIngest / " +
      "applyTransition, seq += 1) BEFORE log.append(); if the append throws (observed: a BigInt " +
      "evidence field makes JSON.stringify throw) the caller sees a native TypeError while the " +
      "queue already holds the entry, so the live queue and a fresh open() of its log disagree. " +
      "A Symbol actor is the silent variant: JSON.stringify drops it, so the appended event has " +
      "no actor and replay diverges without any error. Any append failure (ENOSPC, EACCES) " +
      "reproduces the same in-memory/durable split.",
    matches: (row) =>
      WRITE_APIS.includes(row.api) &&
      row.violations.length > 0 &&
      row.violations.every(
        (v) =>
          v.startsWith("replay-divergence: ") ||
          v === "state-mutated-on-rejected: in-memory entries changed",
      ) &&
      ((row.outcome === "crash-native" &&
        row.errorName === "TypeError" &&
        row.detail.includes("serialize a BigInt")) ||
        (row.outcome === "accepted" && row.violations.every((v) => v.startsWith("replay-")))),
  },
  {
    id: "HCQ-OPEN-UNVALIDATED-REPLAY",
    finding:
      "fileLog.ts readAll() checks only that each line is an object with numeric seq and string " +
      "type; queue.ts applyIngest() then materialises entries from whatever the persisted " +
      "report contains (unknown severities/sources, non-object evidence, a stageHint that is " +
      "not a string → native TypeError in routeCategory).",
    matches: (row) =>
      row.api === "HardCaseQueue.open" &&
      (row.outcome === "returned-invalid" ||
        (row.outcome === "crash-native" && row.errorName === "TypeError")) &&
      row.violations.length === 0,
  },
  {
    id: "HCQ-ERR-ECHO-UNBOUNDED",
    finding:
      "HardCaseNotFoundError / HardCaseRoutingError / HardCaseTransitionError interpolate the " +
      "caller-supplied entryId / categoryHint / target state verbatim; a 64 KiB argument yields a " +
      "64 KiB+ (1 MiB observed) error message.",
    matches: (row) =>
      row.outcome === "rejected-typed" &&
      row.violations.length > 0 &&
      row.violations.every((v) => v.startsWith("oversized-error-message")),
  },
  typedShapeGap(
    "HCQ-TYPED-NO-GUARDS",
    "routeCategory() applies no runtime guard to its typed report argument; a non-object report " +
      "or a non-string stageHint ends in a native TypeError or an undefined category.",
  ),
];

describe("hard-case-queue boundary/malformed stress", () => {
  it(
    "rejects malformed reports/logs with typed errors, never half-writes",
    () => {
      const report = runCampaign<QueueBase>({
        pkg: "hard-case-queue",
        cases: [routeCategoryCase, ingestCase, transitionCase, openCorruptLogCase],
        knownGaps: KNOWN_GAPS,
      });
      const path = writeReport(report, outputDir(REPO_ROOT));
      expect(campaignVerdict(report, path)).toBeNull();
    },
    campaignTimeoutMs(),
  );
});
