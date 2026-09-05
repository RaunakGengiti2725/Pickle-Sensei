import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadCoachReviewData,
  submitAdjudication,
  submitAmendment,
  submitAssignment,
  submitMappingProposal,
  submitReview,
  type CoachReviewData,
  type SubmitResult,
} from "../../data";
import { syntheticAgreeingPair } from "../../syntheticFixtures";
import {
  HTTP_FAULT_MODES,
  MALFORMED_OK_MODES,
  REJECTING_MODES,
  materializeFault,
  type FaultBodies,
  type HttpFaultMode,
  type Outcome,
} from "./faultCatalog";
import { createResultsTable, flushResultsTable, recordResult } from "./resultsTable";
import { campaignSeeds, makeRng, STRESS_DISABLED_HINT, stressEnabled } from "./seededRng";

/**
 * STRESS / failure-injection — Coach Review Lab DATA LAYER (src/coachReview/data.ts).
 *
 * The dependency under attack is `fetch`. For every artifact/endpoint the lab
 * loads, and every submit path, the mocked fetch answers with one fault from
 * the shared catalogue (abort, 4xx/5xx, non-JSON, empty, null, partial, wrong
 * type, truncated, slow, never-resolves). Invariants:
 *   - loadCoachReviewData() either REJECTS (the UI renders the error box) or
 *     resolves to data that is structurally safe for every field the UI
 *     dereferences during render (otherwise the render crashes → blank page);
 *   - a dependency failure never becomes an unannounced empty result;
 *   - nothing stays pending forever (60 s of fake timers).
 *   - submit*() either rejects (callers render the message) or reports the
 *     HTTP truth in `ok`; a non-2xx must never yield ok:true.
 *
 * Scenario(seed) is a pure function of the seed: cell = seed % CELLS, RNG(seed)
 * drives the payload details. STRESS_ITER (default 40) / STRESS_SEEDS replay.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const DATASETS = resolve(REPO_ROOT, "datasets/coach-review");

function readGood(relative: string): string {
  return readFileSync(resolve(DATASETS, relative), "utf8");
}

interface LoadTarget {
  kind: "load";
  path: string;
  optional: boolean;
  bodies: FaultBodies;
}

interface SubmitTarget {
  kind: "submit";
  path: string;
  submit: () => Promise<SubmitResult>;
  bodies: FaultBodies;
}

type Target = LoadTarget | SubmitTarget;

const GOOD_LOAD_BODIES: Record<string, string> = {
  "/datasets/coach-review/queue.json": readGood("queue.json"),
  "/datasets/coach-review/schema.json": readGood("schema.json"),
  "/datasets/coach-review/taxonomy/fault-taxonomy.v0-draft.json": readGood(
    "taxonomy/fault-taxonomy.v0-draft.json",
  ),
  "/datasets/coach-review/drills/drill-library.v0.json": readGood("drills/drill-library.v0.json"),
  "/datasets/coach-review/coaches.json": readGood("coaches.json"),
  "/api/coach-reviews": "[]",
  "/api/coach-assignments": JSON.stringify({ schemaVersion: 1, note: "", assignments: [] }),
  "/api/coach-adjudications": "[]",
  "/api/coach-review-amendments": "[]",
  "/api/drill-mapping-proposals": "[]",
};

const LOAD_TARGETS: LoadTarget[] = [
  {
    kind: "load",
    path: "/datasets/coach-review/queue.json",
    optional: false,
    bodies: {
      good: GOOD_LOAD_BODIES["/datasets/coach-review/queue.json"]!,
      partial: JSON.stringify({ schemaVersion: 3, generatedAtIso: "2026-01-01T00:00:00.000Z" }),
      wrongType: JSON.stringify({ schemaVersion: "3", queue: "not-an-array", status: 7 }),
    },
  },
  {
    kind: "load",
    path: "/datasets/coach-review/schema.json",
    optional: false,
    bodies: {
      good: GOOD_LOAD_BODIES["/datasets/coach-review/schema.json"]!,
      partial: JSON.stringify({ schemaVersion: 3, strokeTaxonomy: {} }),
      wrongType: JSON.stringify({ strokeTaxonomy: "v3", qualityScale: 5, faultTaxonomyVersion: 1 }),
    },
  },
  {
    kind: "load",
    path: "/datasets/coach-review/taxonomy/fault-taxonomy.v0-draft.json",
    optional: false,
    bodies: {
      good: GOOD_LOAD_BODIES["/datasets/coach-review/taxonomy/fault-taxonomy.v0-draft.json"]!,
      partial: JSON.stringify({ version: "v0", families: [{ id: "global" }] }),
      wrongType: JSON.stringify({ version: 0, families: { global: [] } }),
    },
  },
  {
    kind: "load",
    path: "/datasets/coach-review/drills/drill-library.v0.json",
    optional: false,
    bodies: {
      good: GOOD_LOAD_BODIES["/datasets/coach-review/drills/drill-library.v0.json"]!,
      partial: JSON.stringify({ version: "v0" }),
      wrongType: JSON.stringify({ version: "v0", drills: 42 }),
    },
  },
  {
    kind: "load",
    path: "/datasets/coach-review/coaches.json",
    optional: false,
    bodies: {
      good: GOOD_LOAD_BODIES["/datasets/coach-review/coaches.json"]!,
      partial: JSON.stringify({ schemaVersion: 2 }),
      wrongType: JSON.stringify({ schemaVersion: 2, coaches: { a: 1 } }),
    },
  },
  {
    kind: "load",
    path: "/api/coach-reviews",
    optional: false,
    bodies: {
      good: "[]",
      partial: JSON.stringify([{ file: "datasets/coach-review/reviews/x.json" }]),
      wrongType: JSON.stringify({ file: "x", review: {} }),
    },
  },
  {
    kind: "load",
    path: "/api/coach-assignments",
    optional: true,
    bodies: {
      good: GOOD_LOAD_BODIES["/api/coach-assignments"]!,
      partial: JSON.stringify({ schemaVersion: 1 }),
      wrongType: JSON.stringify({ schemaVersion: 1, assignments: "none" }),
    },
  },
  {
    kind: "load",
    path: "/api/coach-adjudications",
    optional: true,
    bodies: {
      good: "[]",
      partial: JSON.stringify([{ queueItemId: "wm-dink-01-E1" }]),
      wrongType: JSON.stringify({ adjudications: [] }),
    },
  },
  {
    kind: "load",
    path: "/api/coach-review-amendments",
    optional: true,
    bodies: {
      good: "[]",
      partial: JSON.stringify([{ reviewId: "wm-dink-01-E1.someone" }]),
      wrongType: JSON.stringify({ amendments: [] }),
    },
  },
  {
    kind: "load",
    path: "/api/drill-mapping-proposals",
    optional: true,
    bodies: {
      good: "[]",
      partial: JSON.stringify([{ proposalId: "p1" }]),
      wrongType: JSON.stringify({ proposals: [] }),
    },
  },
];

const SUBMIT_GOOD = JSON.stringify({ ok: true, message: "persisted (append-only)", path: "x" });
const SUBMIT_BODIES: FaultBodies = {
  good: SUBMIT_GOOD,
  partial: JSON.stringify({ ok: true }),
  wrongType: JSON.stringify({ ok: "yes", message: 12, problems: "not-an-array" }),
};

const SUBMIT_TARGETS: SubmitTarget[] = [
  {
    kind: "submit",
    path: "/api/coach-reviews",
    submit: () => submitReview(syntheticAgreeingPair()[0]!),
    bodies: SUBMIT_BODIES,
  },
  {
    kind: "submit",
    path: "/api/coach-adjudications",
    submit: () =>
      submitAdjudication({
        schemaVersion: 1,
        queueItemId: "wm-dink-01-E1",
        adjudicatorId: "stress-adjudicator",
        adjudicatorCredentialRef: "stress-cred",
        reviewedReviewIds: ["a", "b"],
        outcome: { kind: "uphold", reviewId: "a" },
        rationale: "stress harness rationale, long enough for the gate",
        evidenceTimestampsMs: [],
        createdAtIso: "2026-01-01T00:00:00.000Z",
      }),
    bodies: SUBMIT_BODIES,
  },
  {
    kind: "submit",
    path: "/api/coach-review-amendments",
    submit: () =>
      submitAmendment({
        schemaVersion: 1,
        amendmentId: "stress.a1",
        reviewId: "wm-dink-01-E1.stress",
        revision: 2,
        reason: "stress harness amendment reason",
        createdAtIso: "2026-01-01T00:00:00.000Z",
        review: syntheticAgreeingPair()[0]!,
      }),
    bodies: SUBMIT_BODIES,
  },
  {
    kind: "submit",
    path: "/api/coach-assignments",
    submit: () =>
      submitAssignment({
        queueItemId: "wm-dink-01-E1",
        coachIds: ["stress-coach"],
        assignedAtIso: "2026-01-01T00:00:00.000Z",
        assignedBy: "stress-admin",
      }),
    bodies: SUBMIT_BODIES,
  },
  {
    kind: "submit",
    path: "/api/drill-mapping-proposals",
    submit: () =>
      submitMappingProposal({
        schemaVersion: 1,
        proposalId: "stress.p1",
        coachId: "stress-coach",
        coachCredentialRef: "stress-cred",
        faultId: "global.late_prep",
        drillId: "drill.shadow_dink",
        rationale: "stress harness mapping rationale long enough",
        evidence: [],
        createdAtIso: "2026-01-01T00:00:00.000Z",
      }),
    bodies: SUBMIT_BODIES,
  },
];

const TARGETS: Target[] = [...LOAD_TARGETS, ...SUBMIT_TARGETS];

interface Cell {
  target: Target;
  mode: HttpFaultMode;
}

const CELLS: Cell[] = TARGETS.flatMap((target) =>
  HTTP_FAULT_MODES.map((mode) => ({ target, mode })),
);

function scenarioFor(seed: number): Cell {
  return CELLS[seed % CELLS.length]!;
}

function scenarioName(cell: Cell): string {
  return `${cell.target.kind}:${cell.target.path}:${cell.mode}`;
}

/** Every field the lab dereferences while rendering queue/item/agreement/program views. */
function structuralProblems(data: CoachReviewData): string[] {
  const problems: string[] = [];
  const check = (condition: boolean, label: string) => {
    if (!condition) problems.push(label);
  };
  check(Array.isArray(data.queue?.queue), "queue.queue is not an array");
  if (Array.isArray(data.queue?.queue)) {
    for (const item of data.queue.queue) {
      check(typeof item?.queueItemId === "string", "queue item without queueItemId");
      check(typeof item?.video === "string", `queue item ${item?.queueItemId} without video`);
      check(
        typeof item?.windowMs?.start === "number",
        `queue item ${item?.queueItemId} without windowMs`,
      );
      check(
        typeof item?.bundle === "object" && item.bundle !== null,
        `queue item ${item?.queueItemId} without bundle`,
      );
    }
  }
  check(
    typeof data.schema?.strokeTaxonomy?.version === "string",
    "schema.strokeTaxonomy.version missing",
  );
  check(
    Array.isArray(data.schema?.strokeTaxonomy?.labels),
    "schema.strokeTaxonomy.labels not an array",
  );
  check(typeof data.schema?.qualityScale?.id === "string", "schema.qualityScale.id missing");
  check(Array.isArray(data.taxonomy?.families), "taxonomy.families not an array");
  if (Array.isArray(data.taxonomy?.families)) {
    for (const family of data.taxonomy.families) {
      check(Array.isArray(family?.faults), `taxonomy family ${family?.family} without faults[]`);
    }
  }
  check(Array.isArray(data.drills?.drills), "drills.drills not an array");
  check(Array.isArray(data.registry?.coaches), "registry.coaches not an array");
  check(Array.isArray(data.reviews), "reviews not an array");
  if (Array.isArray(data.reviews)) {
    for (const entry of data.reviews) {
      check(
        typeof entry?.review === "object" && entry.review !== null,
        `review entry ${entry?.source} without review object`,
      );
    }
  }
  check(Array.isArray(data.assignments?.assignments), "assignments.assignments not an array");
  check(Array.isArray(data.adjudications), "adjudications not an array");
  check(Array.isArray(data.amendments), "amendments not an array");
  check(Array.isArray(data.mappingProposals), "mappingProposals not an array");
  return problems;
}

const table = createResultsTable("admin-web data.ts fetch failure-injection (vitest)");
const seeds = campaignSeeds(process.env, 40);

function installFetch(cell: Cell, seed: number): { faultHits: () => number } {
  const rng = makeRng(seed);
  const fault = materializeFault(
    cell.mode,
    rng,
    cell.target.bodies,
    cell.target.kind === "submit" ? 201 : 200,
  );
  let hits = 0;
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.split("?")[0]!;
    const method = init?.method ?? "GET";
    const isTarget =
      path === cell.target.path &&
      (cell.target.kind === "submit" ? method === "POST" : method === "GET");
    if (!isTarget) {
      const good = GOOD_LOAD_BODIES[path];
      if (good === undefined) {
        return Promise.reject(new TypeError(`harness: unexpected fetch ${method} ${path}`));
      }
      return Promise.resolve(
        new Response(good, { status: 200, headers: { "content-type": "application/json" } }),
      );
    }
    hits += 1;
    switch (fault.kind) {
      case "abort":
        return Promise.reject(new TypeError("Failed to fetch"));
      case "hang":
        return new Promise<Response>(() => undefined);
      case "respond": {
        const response = () =>
          new Response(fault.body, {
            status: fault.status,
            headers: { "content-type": fault.contentType },
          });
        if (fault.delayMs === 0) return Promise.resolve(response());
        return new Promise<Response>((resolvePromise) =>
          setTimeout(() => resolvePromise(response()), fault.delayMs),
        );
      }
    }
  };
  vi.stubGlobal("fetch", impl);
  vi.stubGlobal("window", { location: { search: rng.bool(0.25) ? "?synthetic=1" : "" } });
  return { faultHits: () => hits };
}

const PENDING = Symbol("pending");

async function settleWithin60s<T>(
  promise: Promise<T>,
): Promise<
  { state: "resolved"; value: T } | { state: "rejected"; error: unknown } | { state: "pending" }
> {
  let result:
    { state: "resolved"; value: T } | { state: "rejected"; error: unknown } | { state: "pending" } =
    { state: "pending" };
  const tracked = promise.then(
    (value) => (result = { state: "resolved", value }),
    (error: unknown) => (result = { state: "rejected", error }),
  );
  await vi.advanceTimersByTimeAsync(60_000);
  const raced = await Promise.race([tracked, Promise.resolve(PENDING)]);
  if (raced === PENDING && result.state === "pending") return { state: "pending" };
  return result;
}

function classifyLoad(
  cell: Cell & { target: LoadTarget },
  settled: Awaited<ReturnType<typeof settleWithin60s<CoachReviewData>>>,
): { outcome: Outcome; observed: string; notes: string[] } {
  const notes: string[] = [];
  if (settled.state === "pending") {
    return {
      outcome: "BROKEN_INFINITE_PENDING",
      observed: `loadCoachReviewData() still pending after 60s of fake time (mode ${cell.mode}); no client-side timeout → UI stays on "Loading queue…" with no retry control`,
      notes,
    };
  }
  if (settled.state === "rejected") {
    const message = String(settled.error);
    if (!(settled.error instanceof Error) || message.trim() === "") {
      return {
        outcome: "BROKEN_SILENT",
        observed: `rejected with a non-Error/empty value: ${message}`,
        notes,
      };
    }
    return { outcome: "HELD", observed: `rejected visibly: ${message.slice(0, 120)}`, notes };
  }
  const problems = structuralProblems(settled.value);
  if (problems.length > 0) {
    return {
      outcome: "BROKEN_CRASH",
      observed: `resolved with render-unsafe data (${cell.mode} on ${cell.target.path}): ${problems.join("; ")}`,
      notes,
    };
  }
  if (
    cell.target.optional &&
    (REJECTING_MODES.has(cell.mode) ||
      cell.mode === "ok-nonjson" ||
      cell.mode === "ok-empty-body" ||
      cell.mode === "ok-truncated")
  ) {
    const mentioned = settled.value.problems.some((problem) => problem.includes(cell.target.path));
    if (!mentioned) {
      return {
        outcome: "BROKEN_SILENT",
        observed: `${cell.target.path} failed (${cell.mode}) but load resolved with an empty fallback and problems=[${settled.value.problems.join(" | ")}] — the UI shows 0 records with no warning (data.ts optional .catch)`,
        notes,
      };
    }
  }
  if (cell.mode === "slow") notes.push("slow dependency: resolved after injected delay");
  return {
    outcome: "HELD",
    observed: `resolved with structurally valid data (${cell.mode})`,
    notes,
  };
}

function classifySubmit(
  cell: Cell & { target: SubmitTarget },
  settled: Awaited<ReturnType<typeof settleWithin60s<SubmitResult>>>,
): { outcome: Outcome; observed: string; notes: string[] } {
  const notes: string[] = [];
  if (settled.state === "pending") {
    return {
      outcome: "BROKEN_INFINITE_PENDING",
      observed: `submit ${cell.target.path} still pending after 60s (mode ${cell.mode}); no timeout, caller shows nothing and the button stays enabled`,
      notes,
    };
  }
  if (settled.state === "rejected") {
    if (cell.mode === "abort")
      return { outcome: "HELD", observed: `rejected (network): ${String(settled.error)}`, notes };
    return {
      outcome: "BROKEN_CRASH",
      observed: `unexpected rejection: ${String(settled.error)}`,
      notes,
    };
  }
  const result = settled.value;
  if (REJECTING_MODES.has(cell.mode) && result.ok) {
    return {
      outcome: "BROKEN_FAKE_SUCCESS",
      observed: `non-2xx reported ok:true → ${JSON.stringify(result)}`,
      notes,
    };
  }
  if (
    REJECTING_MODES.has(cell.mode) &&
    (typeof result.message !== "string" || result.message.trim() === "")
  ) {
    return {
      outcome: "BROKEN_SILENT",
      observed: `failure without a message → ${JSON.stringify(result)}`,
      notes,
    };
  }
  if (MALFORMED_OK_MODES.has(cell.mode) && typeof result.message !== "string") {
    return {
      outcome: "BROKEN_CRASH",
      observed: `message is not a string → ${JSON.stringify(result)}`,
      notes,
    };
  }
  if (cell.mode === "ok-wrong-type") notes.push(`wrong-type body rendered as: ${result.message}`);
  return {
    outcome: "HELD",
    observed: `ok=${result.ok} status=${result.status} message="${result.message.slice(0, 80)}"`,
    notes,
  };
}

const enabled = stressEnabled(process.env);

it.skipIf(enabled)(`data.ts failure injection — ${STRESS_DISABLED_HINT}`, () => undefined);

describe.skipIf(!enabled)(
  `data.ts failure injection (${seeds.length} seeds over ${CELLS.length} cells)`,
  () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });
    afterAll(() => {
      const path = flushResultsTable(table, "data-fetch.json");

      console.warn(
        `[stress:data] executed=${table.executed} held=${table.byOutcome.HELD} failing=${table.failingSeeds.length} → ${path}`,
      );
    });

    for (const seed of seeds) {
      const cell = scenarioFor(seed);
      it(`seed ${seed} → ${scenarioName(cell)}`, async () => {
        const started = process.hrtime.bigint();
        const { faultHits } = installFetch(cell, seed);
        let verdict: { outcome: Outcome; observed: string; notes: string[] };
        try {
          if (cell.target.kind === "load") {
            const settled = await settleWithin60s(loadCoachReviewData());
            verdict = classifyLoad({ target: cell.target, mode: cell.mode }, settled);
          } else {
            const settled = await settleWithin60s(cell.target.submit());
            verdict = classifySubmit({ target: cell.target, mode: cell.mode }, settled);
          }
          if (faultHits() === 0) {
            verdict = {
              outcome: "HARNESS_ERROR",
              observed: `fault never reached: ${cell.target.path} was not fetched`,
              notes: [],
            };
          }
        } catch (error) {
          verdict = { outcome: "HARNESS_ERROR", observed: String(error), notes: [] };
        }
        recordResult(table, {
          seed,
          scenario: scenarioName(cell),
          outcome: verdict.outcome,
          observed: verdict.observed,
          notes: verdict.notes,
          durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
        });
        expect(verdict.outcome, `${verdict.observed}\nreplay: STRESS_SEEDS=${seed}`).toBe("HELD");
      });
    }
  },
);
