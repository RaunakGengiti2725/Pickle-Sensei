// Table-driven fault cases for GET /v1/me/saved-drills, shared by the
// Redis-less (stress_saved_drills_faults) and Redis-backed
// (stress_saved_drills_redis) modules.
//
// Each case: seed a user (rows, ip, bearer) from its own derived seed,
// optionally warm the auth cache, inject the fault, drive ONE request through
// the real handler, then clear the fault and prove recoverability. Expected
// values are the CURRENT behaviour; `classification: "BROKEN"` marks the
// cases whose current behaviour is a finding (the test still pins it, like
// the existing orphan-id test does, so a fix shows up as a test to update).

import { assert, assertEquals } from "@std/assert";
import { drillCatalog } from "../drills.ts";
import {
  caseSeed,
  drainDelays,
  type FaultResponder,
  LEAK_MARKER,
  type Outcome,
  Prng,
  providerBearer,
  replayCommand,
  run,
  runWithDeadline,
  type SavedDrillRow,
  savedDrillsRequest,
  sessionBearer,
  STRESS_HANG_MS,
  type StressHarness,
  type Upstream,
} from "./stress_saved_drills_harness.ts";

export type Bearer = "session" | "provider" | "none" | "expired" | "garbage";
export type Recovery =
  /** The same bearer works once the fault clears. */
  | "same_bearer"
  /** The bearer was refused; a fresh sign-in (new session) works. */
  | "new_bearer"
  /** The same bearer is still refused after the fault clears (L1 poisoned);
   * a new session works. */
  | "sticky_401"
  /** Nothing to recover (the request itself succeeded). */
  | "n/a";

export interface Range {
  min: number;
  max: number;
}

export interface FaultCase {
  id: string;
  /** Which upstream is faulted (`none` = the request itself is malformed). */
  upstream: Upstream | "none";
  bearer: Bearer;
  /** Verify the bearer once (healthy) before injecting, so the fault meets a
   * warm auth cache. */
  warm?: boolean;
  fault?: FaultResponder;
  /** Additional simultaneous faults (composite outages). */
  also?: Partial<Record<Upstream, FaultResponder>>;
  expect: {
    status: number | "no_response";
    /** Status the parked request ends with once the harness releases the hang. */
    eventualStatus?: number;
    /** Keep the fault in place this long after the deadline before releasing
     * (a persistent outage the client library retries through on its own). */
    eventualWaitMs?: number;
    /** Bounds on the parked request's total time to its eventual answer. */
    eventualLatencyMs?: Partial<Range>;
    /** Upstream calls the request had made by the time it finally answered. */
    callsAtSettle?: Partial<Record<Upstream, number | Range>>;
    retryAfter?: boolean;
    latencyMs?: Partial<Range>;
    calls?: Partial<Record<Upstream, number | Range>>;
    recovery: Recovery;
    classification: "HELD" | "BROKEN";
    /** Populated for BROKEN cases: what should have happened. */
    shouldBe?: string;
    /** False when the fault replaces the 200 body, so the seeded rows cannot
     * be checked against it; `items` is then asserted with this predicate. */
    items?: (items: Array<Record<string, unknown>>) => void;
  };
  note?: string;
}

export interface CaseOutcome {
  id: string;
  seed: number;
  replay: string;
  upstream: string;
  bearer: Bearer;
  classification: "HELD" | "BROKEN";
  shouldBe: string | null;
  seeded: { userId: string; rows: number; orphanRows: number; ip: string };
  observed: {
    status: number | "no_response";
    eventualStatus: number | null;
    eventualLatencyMs: number | null;
    retryAfter: string | null;
    latencyMs: number;
    calls: Record<Upstream, number>;
    /** Upstream calls the request had made by the time it finally answered. */
    callsAtSettle: Record<Upstream, number>;
    faultedCalls: number;
    releasedHangs: number;
    settledUnderFault: boolean;
    body: unknown;
    leaked: boolean;
    genericErrorBody: boolean | null;
  };
  recovery: {
    expected: Recovery;
    sameBearerStatus: number | null;
    sameBearerCalls: Record<Upstream, number> | null;
    newBearerStatus: number | null;
  };
  passed: boolean;
}

export function seedRows(
  prng: Prng,
  catalogSlugs: readonly string[],
  count: number,
): SavedDrillRow[] {
  const rows: SavedDrillRow[] = [];
  const used = new Set<string>();
  while (rows.length < count) {
    const slug = prng.next() < 0.3
      ? prng.orphanSlug()
      : prng.pick(catalogSlugs);
    if (used.has(slug)) continue;
    used.add(slug);
    // Distinct, seeded timestamps so the saved_at-desc order is checkable.
    const at = new Date(
      Date.UTC(2026, 0, 1) + prng.int(0, 200 * 86_400) * 1000 + rows.length,
    );
    rows.push({ slug, saved_at: at.toISOString().replace("Z", "+00:00") });
  }
  return rows;
}

export function expectedOrder(rows: SavedDrillRow[]): string[] {
  return [...rows].sort((a, b) => (a.saved_at < b.saved_at ? 1 : -1)).map((r) =>
    r.slug
  );
}

/** Every item the route returns must carry the saved slug, its saved_at and
 * the catalog/placeholder hydration, in saved_at-desc order. */
export function assertHydrated(
  body: unknown,
  rows: SavedDrillRow[],
  catalogSlugs: readonly string[],
): void {
  assert(
    body && typeof body === "object" &&
      Array.isArray((body as { items?: unknown }).items),
    "items[]",
  );
  const items = (body as { items: Array<Record<string, unknown>> }).items;
  assertEquals(
    items.map((i) => i.slug),
    expectedOrder(rows),
    "saved_at desc order",
  );
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  for (const item of items) {
    const row = bySlug.get(String(item.slug))!;
    assertEquals(item.saved_at, row.saved_at);
    assertEquals(typeof item.id, "string");
    assertEquals(typeof item.title, "string");
    assert(Array.isArray(item.equipment));
    if (!catalogSlugs.includes(row.slug)) {
      assertEquals(item.title, row.slug, "placeholder title is the slug");
    }
  }
}

function countCalls(
  calls: Array<{ upstream: Upstream }>,
): Record<Upstream, number> {
  const counts: Record<Upstream, number> = {
    auth: 0,
    db: 0,
    redis: 0,
    revenuecat: 0,
  };
  for (const call of calls) counts[call.upstream] += 1;
  return counts;
}

const inRange = (value: number, range: number | Range): boolean =>
  typeof range === "number"
    ? value === range
    : value >= range.min && value <= range.max;

let catalogSlugsCache: string[] | null = null;
export async function catalogSlugs(): Promise<string[]> {
  if (!catalogSlugsCache) {
    catalogSlugsCache = (await drillCatalog()).map((entry) => entry.slug);
  }
  return catalogSlugsCache;
}

function isGenericError(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") return false;
  const keys = Object.keys(error as Record<string, unknown>).sort();
  return typeof (error as { message?: unknown }).message === "string" &&
    keys.every((key) => key === "message" || key === "code");
}

export async function runFaultCase(
  state: StressHarness,
  c: FaultCase,
  testFile: string,
): Promise<CaseOutcome> {
  const seed = caseSeed(c.id);
  const prng = new Prng(seed);
  const slugs = await catalogSlugs();
  state.reset();

  const userId = prng.uuid();
  const ip = prng.ip();
  const rows = seedRows(prng, slugs, prng.int(0, 8));
  state.savedDrills.set(userId, rows);
  const orphanRows = rows.filter((r) => !slugs.includes(r.slug)).length;

  const makeBearer = (fresh = false): string | null => {
    switch (c.bearer) {
      case "session":
        return sessionBearer(state, userId, {
          sessionId: fresh ? `session-${userId}-fresh` : `session-${userId}`,
        });
      case "provider":
        return providerBearer(userId, prng.next() < 0.5 ? "google" : "apple");
      case "none":
        return null;
      case "expired":
        return sessionBearer(state, userId, { ttlSeconds: -120 });
      case "garbage":
        return "not-a-jwt-at-all";
    }
  };
  const bearer = makeBearer();

  if (c.warm) {
    const warm = await run(
      state,
      savedDrillsRequest(bearer, { ip }),
      `${c.id}-warm`,
    );
    assertEquals(warm.status, 200, `${c.id}: warm-up must succeed`);
    assertHydrated(warm.body, rows, slugs);
  }

  if (c.fault && c.upstream !== "none") state.setFault(c.upstream, c.fault);
  for (const [upstream, fault] of Object.entries(c.also ?? {})) {
    state.setFault(upstream as Upstream, fault);
  }

  const outcome: Outcome = await runWithDeadline(
    state,
    savedDrillsRequest(bearer, { ip }),
    STRESS_HANG_MS,
    c.id,
  );
  await drainDelays();
  let eventualStatus: number | null = null;
  let eventualLatencyMs: number | null = null;
  let settledUnderFault = false;
  if (outcome.kind === "no_response" && (c.expect.eventualWaitMs ?? 0) > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const patience = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), c.expect.eventualWaitMs);
    });
    const settled = await Promise.race([outcome.eventual, patience]);
    clearTimeout(timer);
    if (settled) {
      settledUnderFault = true;
      eventualStatus = settled.status;
      eventualLatencyMs = settled.latencyMs;
    }
  }
  state.clearFaults();
  const releasedHangs = state.releaseHung();
  if (outcome.kind === "no_response" && !settledUnderFault) {
    const eventual = await outcome.eventual;
    eventualStatus = eventual.status;
    eventualLatencyMs = eventual.latencyMs;
  }

  const observedStatus = outcome.kind === "response"
    ? outcome.status
    : "no_response";
  const text = outcome.kind === "response" ? outcome.text : "";
  const body = outcome.kind === "response" ? outcome.body : null;
  const calls = outcome.kind === "response" ? outcome.calls : outcome.calls;
  const roundTrips = outcome.roundTrips;
  const latencyMs = outcome.kind === "response"
    ? outcome.latencyMs
    : outcome.waitedMs;
  const retryAfter = outcome.kind === "response"
    ? (outcome.headers["retry-after"] ?? null)
    : null;

  // Recovery.
  let sameBearerStatus: number | null = null;
  let sameBearerCalls: Record<Upstream, number> | null = null;
  let newBearerStatus: number | null = null;
  if (
    c.expect.recovery !== "n/a" || c.bearer === "session" ||
    c.bearer === "provider"
  ) {
    const again = await run(
      state,
      savedDrillsRequest(bearer, { ip }),
      `${c.id}-recover`,
    );
    sameBearerStatus = again.status;
    sameBearerCalls = again.roundTrips;
    if (again.status === 200) assertHydrated(again.body, rows, slugs);
    if (
      c.expect.recovery === "new_bearer" || c.expect.recovery === "sticky_401"
    ) {
      const fresh = await run(
        state,
        savedDrillsRequest(makeBearer(true), { ip }),
        `${c.id}-fresh`,
      );
      newBearerStatus = fresh.status;
      if (fresh.status === 200) assertHydrated(fresh.body, rows, slugs);
    }
  }

  const failures: string[] = [];
  const check = (ok: boolean, what: string) => {
    if (!ok) failures.push(what);
  };
  check(
    observedStatus === c.expect.status,
    `status ${observedStatus} != ${c.expect.status}`,
  );
  if (c.expect.eventualStatus !== undefined) {
    check(
      eventualStatus === c.expect.eventualStatus,
      `eventual ${eventualStatus} != ${c.expect.eventualStatus}`,
    );
  }
  if (c.expect.retryAfter !== undefined) {
    check(
      (retryAfter !== null) === c.expect.retryAfter,
      `retry-after ${retryAfter}`,
    );
  }
  if (c.expect.latencyMs?.min !== undefined) {
    check(
      latencyMs >= c.expect.latencyMs.min,
      `latency ${latencyMs.toFixed(0)} < ${c.expect.latencyMs.min}`,
    );
  }
  if (c.expect.latencyMs?.max !== undefined) {
    check(
      latencyMs <= c.expect.latencyMs.max,
      `latency ${latencyMs.toFixed(0)} > ${c.expect.latencyMs.max}`,
    );
  }
  if (c.expect.eventualLatencyMs?.min !== undefined) {
    check(
      eventualLatencyMs !== null &&
        eventualLatencyMs >= c.expect.eventualLatencyMs.min,
      `eventual latency ${
        eventualLatencyMs?.toFixed(0)
      } < ${c.expect.eventualLatencyMs.min}`,
    );
  }
  if (c.expect.eventualLatencyMs?.max !== undefined) {
    check(
      eventualLatencyMs !== null &&
        eventualLatencyMs <= c.expect.eventualLatencyMs.max,
      `eventual latency ${
        eventualLatencyMs?.toFixed(0)
      } > ${c.expect.eventualLatencyMs.max}`,
    );
  }
  for (const [upstream, range] of Object.entries(c.expect.calls ?? {})) {
    const n = roundTrips[upstream as Upstream];
    check(
      inRange(n, range as number | Range),
      `${upstream} calls ${n} not in ${JSON.stringify(range)}`,
    );
  }
  const callsAtSettle = countCalls(
    state.calls.filter((call) => call.tag === c.id),
  );
  for (
    const [upstream, range] of Object.entries(c.expect.callsAtSettle ?? {})
  ) {
    const n = callsAtSettle[upstream as Upstream];
    check(
      inRange(n, range as number | Range),
      `${upstream} calls at settle ${n} not in ${JSON.stringify(range)}`,
    );
  }
  const leaked = text.includes(LEAK_MARKER);
  check(!leaked, "upstream detail leaked into the client body");
  let genericErrorBody: boolean | null = null;
  if (typeof observedStatus === "number" && observedStatus >= 400) {
    genericErrorBody = isGenericError(body);
    check(
      genericErrorBody,
      "error body is not the generic {error:{message}} shape",
    );
  }
  if (typeof observedStatus === "number" && observedStatus === 200) {
    if (c.expect.items) {
      const items = (body as { items?: unknown })?.items;
      assert(Array.isArray(items), "items[]");
      c.expect.items(items as Array<Record<string, unknown>>);
    } else {
      assertHydrated(body, rows, slugs);
    }
  }
  // Every 5xx must carry the retryable class the app maps to "try again".
  if (typeof observedStatus === "number" && observedStatus >= 500) {
    check(
      observedStatus === 503 || c.expect.classification === "BROKEN",
      "5xx other than 503 on a stubbed fault",
    );
  }
  switch (c.expect.recovery) {
    case "same_bearer":
      check(
        sameBearerStatus === 200,
        `same bearer after clear → ${sameBearerStatus}`,
      );
      break;
    case "new_bearer":
      check(
        newBearerStatus === 200,
        `new bearer after clear → ${newBearerStatus}`,
      );
      break;
    case "sticky_401":
      check(
        sameBearerStatus === 401,
        `same bearer after clear → ${sameBearerStatus} (expected poisoned 401)`,
      );
      check(
        newBearerStatus === 200,
        `new session after clear → ${newBearerStatus}`,
      );
      break;
    case "n/a":
      break;
  }
  // The revocation fence and every other L1 row a poisoned case leaves behind
  // must not bleed into later cases: they use different users/sessions, but
  // double-check the harness state is clean of hangs.
  check(state.releaseHung() === 0, "hangs left behind");

  const result: CaseOutcome = {
    id: c.id,
    seed,
    replay: replayCommand(testFile, c.id),
    upstream: c.upstream,
    bearer: c.bearer,
    classification: c.expect.classification,
    shouldBe: c.expect.shouldBe ?? null,
    seeded: { userId, rows: rows.length, orphanRows, ip },
    observed: {
      status: observedStatus,
      eventualStatus,
      eventualLatencyMs: eventualLatencyMs === null
        ? null
        : Math.round(eventualLatencyMs),
      retryAfter,
      latencyMs: Math.round(latencyMs * 100) / 100,
      calls: roundTrips,
      callsAtSettle,
      faultedCalls: calls.filter((call) => call.faulted).length,
      releasedHangs,
      settledUnderFault,
      body: typeof observedStatus === "number" && observedStatus >= 400
        ? body
        : `${text.length} bytes`,
      leaked,
      genericErrorBody,
    },
    recovery: {
      expected: c.expect.recovery,
      sameBearerStatus,
      sameBearerCalls,
      newBearerStatus,
    },
    passed: failures.length === 0,
  };
  if (failures.length > 0) {
    throw new Error(
      `${c.id} (seed ${seed}) failed: ${
        failures.join("; ")
      }\nreplay: ${result.replay}\nobserved: ${
        JSON.stringify(result.observed)
      }`,
    );
  }
  return result;
}

export function summarize(outcomes: CaseOutcome[]): Record<string, unknown> {
  const byUpstream: Record<string, number> = {};
  for (const o of outcomes) {
    byUpstream[o.upstream] = (byUpstream[o.upstream] ?? 0) + 1;
  }
  return {
    cases: outcomes.length,
    held: outcomes.filter((o) => o.classification === "HELD").length,
    broken: outcomes.filter((o) => o.classification === "BROKEN").map((o) => ({
      id: o.id,
      seed: o.seed,
      observed: o.observed.status,
      shouldBe: o.shouldBe,
    })),
    byUpstream,
    leaks: outcomes.filter((o) => o.observed.leaked).length,
  };
}
