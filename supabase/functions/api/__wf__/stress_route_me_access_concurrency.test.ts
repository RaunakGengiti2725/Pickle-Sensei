// stress-route-get-v1-me-access · lens = concurrency
//
// Seeded-scheduler Promise.all bursts against the REAL edge handler
// (../index.ts, captured in-process by xc_concurrency_harness.ts over its
// stateful fake GoTrue / PostgREST / RevenueCat) for one unit:
//
//   GET /v1/me/access  →  authenticate() → rate limit → accessPayload()
//                         → rpc access_state() → { premium, entitlements,
//                           freeRatings{limit,used,reserved,remaining,
//                           availableToReserve}, canStartRating, paywallRequired }
//
// Every ITERATION is one interleaving: a fresh user (or two devices of one
// user), a burst whose per-lane start offsets AND every upstream latency are
// drawn from ONE seeded PRNG, and a set of contract invariants checked on the
// responses. The iteration seed is derived from STRESS_SEED, the scenario name
// and the iteration index, is written to the JSON table, and replays alone via
// STRESS_REPLAY_SEED=<seed> (see `replay` in each row).
//
// Contract asserted (AGENTS.md "Scale & security" / "Billing", the mobile
// parser apps/mobile/src/billing/accessApi.ts parseAccess, ../index.ts
// accessPayload + authenticate + rateLimit.ts):
//   · payload arithmetic: limit=2, 0≤used≤2, remaining=2-used,
//     0≤reserved≤remaining, availableToReserve=remaining-reserved,
//     premium ⇔ 'premium' ∈ entitlements, canStartRating = premium ∨ avail>0,
//     paywallRequired = ¬canStartRating
//   · idempotency: identical concurrent reads of an untouched account return
//     identical payloads; the first verified bearer is cached (no extra
//     GoTrue round trip for a later request on the same bearer)
//   · no double spend: with reads interleaved into reserve/sync writes of the
//     SAME user (two devices), every read is a consistent snapshot
//     (used+reserved ≤ 2 for a free account), reads that do not overlap are
//     monotone (used and used+reserved never go backwards), reads that START
//     after an accepted write ENDED see that write (read-your-writes), and
//     exactly two ratings are ever spent
//   · rotation/logout during a burst: only 200/401 ever appear; once a bearer
//     has been refused it is never resurrected; the sibling device keeps 200;
//     a refreshed session's old bearer keeps working until exp
//   · cancel-during-call: an aborted client never produces a 5xx or a
//     poisoned cache; later requests are unaffected
//   · clock skew: a bearer whose exp is <90 s away is served but never cached
//     (every request re-verified), an exp in the past is 401 before any
//     upstream call, and a membership expiring mid-burst flips premium
//     exactly once in real-time order
//   · deadlock: every burst settles within STRESS_WALL_MS
//   · rate limit: a same-user burst above GENERAL_USER_LIMIT (240/min) admits
//     exactly the remaining budget — 239 reads after the bootstrap that minted
//     the session (each 429 carries Retry-After and reaches no RPC)
//
// Scale (env): STRESS_ITER iterations per scenario (default 8 — fast enough
// for the suite), STRESS_LANES concurrent reads per burst (default 12),
// STRESS_LATENCY_MS max seeded upstream latency (default 8), STRESS_SEED
// (default 20260904), STRESS_WALL_MS per-burst deadline (default 10000),
// STRESS_OUT_DIR for the JSON table (default artifacts/stress-me-access/latest).
// The campaign run for the report: STRESS_ITER=100 (6 scenarios → 600
// interleavings; the budget scenario runs STRESS_ITER/4 because each of its
// iterations is a 250-request burst).

import { assert } from "@std/assert";
import {
  bootstrap,
  edgeRequest,
  envInt,
  type Invariant,
  loadXcHarness,
  Prng,
  readJson,
  sleep,
  syncShotPayload,
  type XcHarness,
} from "./xc_concurrency_harness.ts";

const STRESS_SEED = envInt("STRESS_SEED", 20260904);
const STRESS_ITER = envInt("STRESS_ITER", 8);
const STRESS_LANES = envInt("STRESS_LANES", 12);
const STRESS_LATENCY_MS = envInt("STRESS_LATENCY_MS", 8);
const STRESS_WALL_MS = envInt("STRESS_WALL_MS", 10_000);
const REPLAY_SEED = (() => {
  const raw = Deno.env.get("STRESS_REPLAY_SEED");
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n >>> 0 : null;
})();
const REPLAY_ONLY = Deno.env.get("STRESS_REPLAY_SCENARIO") ?? null;

const FREE_LIMIT = 2;
const GENERAL_USER_LIMIT = 240;

// ── seeds & ids ──────────────────────────────────────────────────────────────

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** splitmix-style mix of (campaign seed, scenario, iteration) → iteration seed */
function iterationSeed(scenario: string, iteration: number): number {
  let z = (STRESS_SEED ^ fnv1a(scenario) ^ Math.imul(iteration + 1, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

function iterationSeeds(scenario: string, count: number): number[] {
  if (REPLAY_SEED !== null) {
    if (REPLAY_ONLY && REPLAY_ONLY !== scenario) return [];
    return [REPLAY_SEED];
  }
  return Array.from({ length: count }, (_, i) => iterationSeed(scenario, i));
}

/** Per-scenario /16 (from the scenario name so a --filter'ed replay sees the
 * same addresses), per-lane host, iteration folded into 64 third octets so a
 * long campaign never pushes one address over IP_LIMIT (1 200/min) while the
 * memory rate-limit window table stays far below its 20 000-entry cap. */
let scenarioHash = 0;
const ip = (iteration: number, lane: number) =>
  `10.${scenarioHash & 255}.${((scenarioHash >> 8) & 0xc0) | (iteration & 63)}.${lane & 255}`;

// ── rows & reports ───────────────────────────────────────────────────────────

interface Req {
  lane: number;
  op: string;
  status: number;
  code?: string;
  startedAt: number;
  endedAt: number;
  body?: Record<string, unknown>;
  bearer?: string;
}

interface Access {
  premium: boolean;
  entitlements: string[];
  used: number;
  reserved: number;
  remaining: number;
  availableToReserve: number;
  canStartRating: boolean;
  paywallRequired: boolean;
}

interface IterationRow {
  scenario: string;
  iteration: number;
  seed: number;
  outcome: "HELD" | "BROKEN";
  requests: number;
  statusHistogram: Record<string, number>;
  violated: string[];
  invariants: Invariant[];
  observations: Record<string, unknown>;
  durationMs: number;
  replay: string;
}

interface ScenarioSummary {
  scenario: string;
  label: string;
  iterations: number;
  held: number;
  broken: number;
  requests: number;
  wallMs: number;
  maxIterationMs: number;
  brokenSeeds: number[];
}

const campaignRows: IterationRow[] = [];
const campaignScenarios: ScenarioSummary[] = [];

function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-me-access/latest/", import.meta.url).pathname;
}

function histogram(values: Array<string | number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

function replayCommand(scenario: string, seed: number): string {
  return `STRESS_REPLAY_SCENARIO=${scenario} STRESS_REPLAY_SEED=${seed} STRESS_LANES=${STRESS_LANES} STRESS_LATENCY_MS=${STRESS_LATENCY_MS} deno test -A --no-check --config deno.json stress_route_me_access_concurrency.test.ts --filter "${scenario}"`;
}

function inv(invariants: Invariant[], name: string, holds: boolean, detail: string): void {
  invariants.push({ name, holds, detail });
}

async function timed(
  reqs: Req[],
  lane: number,
  op: string,
  fn: () => Promise<Response>,
  bearer?: string,
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers; row: Req }> {
  const startedAt = performance.now();
  const response = await fn();
  const body = await readJson(response);
  const err = body.error;
  const nested = err && typeof err === "object" ? (err as Record<string, unknown>).code : undefined;
  const code =
    typeof nested === "string" ? nested : typeof body.code === "string" ? body.code : undefined;
  const row: Req = {
    lane,
    op,
    status: response.status,
    code,
    startedAt,
    endedAt: performance.now(),
    body,
    bearer,
  };
  reqs.push(row);
  return { status: response.status, body, headers: response.headers, row };
}

/** The mobile parser's acceptance test (accessApi.ts parseAccess), returned as
 * a list of violated clauses so a broken payload names its defect. */
function accessViolations(body: Record<string, unknown>): string[] {
  const out: string[] = [];
  const fr = body.freeRatings;
  if (!fr || typeof fr !== "object") return ["freeRatings missing"];
  const f = fr as Record<string, unknown>;
  const isInt = (v: unknown) => typeof v === "number" && Number.isInteger(v);
  if (typeof body.premium !== "boolean") out.push("premium not boolean");
  if (!Array.isArray(body.entitlements) || !body.entitlements.every((e) => typeof e === "string")) {
    out.push("entitlements not string[]");
  }
  if (typeof body.canStartRating !== "boolean") out.push("canStartRating not boolean");
  if (typeof body.paywallRequired !== "boolean") out.push("paywallRequired not boolean");
  if (f.limit !== FREE_LIMIT) out.push(`limit=${f.limit}`);
  for (const k of ["used", "reserved", "remaining", "availableToReserve"]) {
    if (!isInt(f[k])) out.push(`${k} not integer`);
  }
  if (out.length) return out;
  const used = f.used as number;
  const reserved = f.reserved as number;
  const remaining = f.remaining as number;
  const avail = f.availableToReserve as number;
  const premium = body.premium as boolean;
  const ents = body.entitlements as string[];
  const expectedCanStart = premium || avail > 0;
  if (used < 0 || used > FREE_LIMIT) out.push(`used=${used} out of range`);
  if (reserved < 0) out.push(`reserved=${reserved} < 0`);
  if (remaining !== FREE_LIMIT - used) out.push(`remaining=${remaining} ≠ 2-used`);
  if (reserved > remaining) out.push(`reserved=${reserved} > remaining=${remaining}`);
  if (avail !== remaining - reserved) out.push(`availableToReserve=${avail} ≠ remaining-reserved`);
  if (premium !== ents.includes("premium")) out.push("premium ⇎ entitlements has 'premium'");
  if (body.canStartRating !== expectedCanStart) out.push("canStartRating ≠ premium ∨ avail>0");
  if (body.paywallRequired !== !expectedCanStart) out.push("paywallRequired ≠ ¬canStartRating");
  return out;
}

function access(body: Record<string, unknown>): Access {
  const f = body.freeRatings as Record<string, number>;
  return {
    premium: Boolean(body.premium),
    entitlements: (body.entitlements as string[]) ?? [],
    used: f.used,
    reserved: f.reserved,
    remaining: f.remaining,
    availableToReserve: f.availableToReserve,
    canStartRating: Boolean(body.canStartRating),
    paywallRequired: Boolean(body.paywallRequired),
  };
}

function accessKey(a: Access): string {
  return JSON.stringify(a);
}

function meAccess(
  h: XcHarness,
  token: string,
  addr: string,
  signal?: AbortSignal,
): Promise<Response> {
  const req = edgeRequest("GET", "/v1/me/access", { token, ip: addr });
  if (!signal) return h.handler(req);
  return h.handler(new Request(req, { signal }));
}

/** Seeded per-lane start offsets: the scheduler. Lanes are also shuffled so
 * lane index never correlates with start order. */
function schedule(prng: Prng, lanes: number, spreadMs: number): number[] {
  return prng.shuffle(Array.from({ length: lanes }, () => prng.int(0, spreadMs)));
}

class WallClockExceeded extends Error {}

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: number | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new WallClockExceeded(`burst did not settle within ${STRESS_WALL_MS}ms`)),
      STRESS_WALL_MS,
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Real-time (non-overlapping) monotonicity + read-your-writes over a list of
 * reads. Writes are (endedAt, delta) marks: a read that STARTED after a write
 * ENDED must reflect at least the sum of the deltas of all such writes. */
function checkReadOrder(
  invariants: Invariant[],
  reads: Array<{ row: Req; a: Access }>,
  writes: { reserveEnded: number[]; syncEnded: number[] },
  tag: string,
): void {
  const sorted = [...reads].sort((x, y) => x.row.startedAt - y.row.startedAt);
  let monotone = true;
  let monotoneDetail = "";
  for (let i = 0; i < sorted.length && monotone; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      if (a.row.endedAt <= b.row.startedAt) {
        if (b.a.used < a.a.used || b.a.used + b.a.reserved < a.a.used + a.a.reserved) {
          monotone = false;
          monotoneDetail = `read#${a.row.lane} (used=${a.a.used},reserved=${a.a.reserved}) ended before read#${b.row.lane} (used=${b.a.used},reserved=${b.a.reserved}) started`;
          break;
        }
      }
    }
  }
  inv(
    invariants,
    `${tag}: non-overlapping reads never go backwards`,
    monotone,
    monotoneDetail || `${reads.length} reads ordered`,
  );
  let ryw = true;
  let rywDetail = "";
  for (const r of sorted) {
    const reservesBefore = writes.reserveEnded.filter((t) => t <= r.row.startedAt).length;
    const syncsBefore = writes.syncEnded.filter((t) => t <= r.row.startedAt).length;
    if (r.a.used + r.a.reserved < Math.min(FREE_LIMIT, reservesBefore) || r.a.used < syncsBefore) {
      ryw = false;
      rywDetail = `read#${r.row.lane} saw used=${r.a.used},reserved=${r.a.reserved} although ${reservesBefore} reserves and ${syncsBefore} scored syncs had completed before it started`;
      break;
    }
  }
  inv(
    invariants,
    `${tag}: reads see writes that completed before they started`,
    ryw,
    rywDetail ||
      `${writes.reserveEnded.length} reserves / ${writes.syncEnded.length} syncs visible`,
  );
}

// ── scenario driver ──────────────────────────────────────────────────────────

type IterationFn = (
  h: XcHarness,
  prng: Prng,
  seed: number,
  iteration: number,
  reqs: Req[],
  invariants: Invariant[],
  observations: Record<string, unknown>,
) => Promise<void>;

async function runScenario(
  scenario: string,
  label: string,
  iterations: number,
  fn: IterationFn,
): Promise<ScenarioSummary> {
  const h = await loadXcHarness();
  scenarioHash = fnv1a(scenario);
  const seeds = iterationSeeds(scenario, iterations);
  const rows: IterationRow[] = [];
  const t0 = performance.now();
  let maxIterationMs = 0;
  for (const [iteration, seed] of seeds.entries()) {
    h.fake.reset(seed, STRESS_LATENCY_MS);
    h.fake.overrides = {};
    h.upstreamCalls.length = 0;
    const prng = new Prng(seed);
    const reqs: Req[] = [];
    const invariants: Invariant[] = [];
    const observations: Record<string, unknown> = {};
    const it0 = performance.now();
    try {
      await bounded(fn(h, prng, seed, iteration, reqs, invariants, observations));
    } catch (error) {
      inv(
        invariants,
        error instanceof WallClockExceeded
          ? "burst settles within STRESS_WALL_MS (no deadlock)"
          : "iteration completes without throwing",
        false,
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      );
    }
    const durationMs = Math.round((performance.now() - it0) * 100) / 100;
    maxIterationMs = Math.max(maxIterationMs, durationMs);
    inv(
      invariants,
      "no 5xx",
      reqs.every((r) => r.status < 500),
      `${reqs.filter((r) => r.status >= 500).length} 5xx in ${JSON.stringify(histogram(reqs.map((r) => r.status)))}`,
    );
    inv(
      invariants,
      "burst settles within STRESS_WALL_MS (no deadlock)",
      durationMs < STRESS_WALL_MS,
      `${durationMs}ms < ${STRESS_WALL_MS}ms`,
    );
    const violated = invariants.filter((i) => !i.holds).map((i) => `${i.name} — ${i.detail}`);
    rows.push({
      scenario,
      iteration,
      seed,
      outcome: violated.length ? "BROKEN" : "HELD",
      requests: reqs.length,
      statusHistogram: histogram(
        reqs.map((r) => `${r.op}:${r.status}${r.code ? `:${r.code}` : ""}`),
      ),
      violated,
      invariants,
      observations,
      durationMs,
      replay: replayCommand(scenario, seed),
    });
  }
  const wallMs = Math.round(performance.now() - t0);
  const summary: ScenarioSummary = {
    scenario,
    label,
    iterations: rows.length,
    held: rows.filter((r) => r.outcome === "HELD").length,
    broken: rows.filter((r) => r.outcome === "BROKEN").length,
    requests: rows.reduce((n, r) => n + r.requests, 0),
    wallMs,
    maxIterationMs,
    brokenSeeds: rows.filter((r) => r.outcome === "BROKEN").map((r) => r.seed),
  };
  campaignRows.push(...rows);
  campaignScenarios.push(summary);
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    `${dir}${scenario}.json`,
    JSON.stringify(
      { summary, seed: STRESS_SEED, lanes: STRESS_LANES, latencyMs: STRESS_LATENCY_MS, rows },
      null,
      2,
    ),
  );
  console.log(
    `[stress] ${scenario}: ${summary.iterations} iterations, ${summary.requests} requests, ${summary.held} HELD / ${summary.broken} BROKEN, ${wallMs}ms (max iteration ${maxIterationMs}ms)`,
  );
  for (const row of rows.filter((r) => r.outcome === "BROKEN")) {
    console.log(`[stress]   BROKEN seed=${row.seed}: ${row.violated.join(" | ")}`);
    console.log(`[stress]     replay: ${row.replay}`);
  }
  return summary;
}

function assertHeld(summary: ScenarioSummary): void {
  assert(
    summary.broken === 0,
    `${summary.scenario}: ${summary.broken}/${summary.iterations} iterations BROKEN — seeds ${summary.brokenSeeds.join(", ")} (see ${outDir()}${summary.scenario}.json)`,
  );
  assert(summary.iterations > 0, `${summary.scenario}: no iteration ran`);
}

async function twoDevices(h: XcHarness, prng: Prng, iteration: number) {
  const sub = prng.uuid();
  const a = await bootstrap(h, sub, ip(iteration, 250));
  const b = await bootstrap(h, sub, ip(iteration, 251));
  if (a.status !== 200 || b.status !== 200) {
    throw new Error(`bootstrap failed: ${a.status}/${b.status}`);
  }
  return { sub, a, b };
}

// ─────────────────────────────────────────────────────────────────────────────
// A — duplicate calls on one bearer (idempotent read, cached verification)
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "stress me.access A: duplicate concurrent reads of one bearer are identical, all 200, verification cached afterwards",
  async () => {
    const summary = await runScenario(
      "a_duplicate_reads",
      "A duplicate reads",
      STRESS_ITER,
      async (h, prng, _seed, iteration, reqs, invariants, observations) => {
        const sub = prng.uuid();
        const boot = await bootstrap(h, sub, ip(iteration, 250));
        if (boot.status !== 200) throw new Error(`bootstrap ${boot.status}`);
        const offsets = schedule(prng, STRESS_LANES, STRESS_LATENCY_MS * 2);
        const getUserBefore = h.fake.counters["gotrue.get_user"] ?? 0;
        const results = await Promise.all(
          offsets.map(async (offset, lane) => {
            if (offset > 0) await sleep(offset);
            return timed(
              reqs,
              lane,
              "me.access",
              () => meAccess(h, boot.accessToken, ip(iteration, lane)),
              boot.accessToken,
            );
          }),
        );
        const getUserBurst = (h.fake.counters["gotrue.get_user"] ?? 0) - getUserBefore;
        const after = await timed(reqs, 999, "me.access.after", () =>
          meAccess(h, boot.accessToken, ip(iteration, 99)),
        );
        const getUserAfter =
          (h.fake.counters["gotrue.get_user"] ?? 0) - getUserBefore - getUserBurst;
        const bodies = new Set(results.map((r) => JSON.stringify(r.body)));
        const violations = results.flatMap((r) => accessViolations(r.body));
        inv(
          invariants,
          "every duplicate read is 200",
          results.every((r) => r.status === 200),
          JSON.stringify(histogram(results.map((r) => r.status))),
        );
        inv(
          invariants,
          "every payload passes the mobile parseAccess contract",
          violations.length === 0,
          violations.slice(0, 3).join("; ") || "ok",
        );
        inv(
          invariants,
          "all duplicates return the identical payload",
          bodies.size === 1,
          `${bodies.size} distinct payloads`,
        );
        const a = results[0].status === 200 ? access(results[0].body) : null;
        inv(
          invariants,
          "fresh account reads used=0 reserved=0 availableToReserve=2 canStartRating=true premium=false",
          a !== null &&
            a.used === 0 &&
            a.reserved === 0 &&
            a.availableToReserve === 2 &&
            a.canStartRating &&
            !a.premium &&
            !a.paywallRequired,
          a ? accessKey(a) : "no 200",
        );
        inv(
          invariants,
          "the follow-up read on the same bearer needs no GoTrue round trip (verified session cached)",
          after.status === 200 && getUserAfter === 0,
          `getUser during burst=${getUserBurst}, after=${getUserAfter}`,
        );
        inv(
          invariants,
          "exactly one access_state RPC per 200",
          (h.fake.counters["rpc.access_state"] ?? 0) ===
            results.filter((r) => r.status === 200).length + (after.status === 200 ? 1 : 0),
          `${h.fake.counters["rpc.access_state"]} rpc calls`,
        );
        observations.getUserDuringBurst = getUserBurst;
        observations.offsets = offsets;
      },
    );
    assertHeld(summary);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// B — reads interleaved with reserve/sync writes of the same user (two devices)
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "stress me.access B: reads during reserve/sync on two devices — consistent snapshots, monotone, read-your-writes, exactly two ratings spent",
  async () => {
    const summary = await runScenario(
      "b_read_during_write",
      "B read during write",
      STRESS_ITER,
      async (h, prng, _seed, iteration, reqs, invariants, observations) => {
        const { sub, a, b } = await twoDevices(h, prng, iteration);
        const readers = schedule(prng, STRESS_LANES, STRESS_LATENCY_MS * 6);
        const reserveKeys = [prng.uuid(), prng.uuid(), prng.uuid()];
        const dupKey = reserveKeys[prng.int(0, 2)];
        const reserveOffsets = schedule(prng, 4, STRESS_LATENCY_MS * 3);
        const shotIds = [prng.uuid(), prng.uuid(), prng.uuid()];
        const reserveEnded: number[] = [];
        const syncEnded: number[] = [];
        const permits: string[] = [];
        const reserveResults: string[] = [];
        const syncVerdicts: string[] = [];
        const embeddedOk: string[] = [];

        const writer = (async () => {
          const keys = [...reserveKeys, dupKey];
          const rs = await Promise.all(
            keys.map(async (key, i) => {
              if (reserveOffsets[i] > 0) await sleep(reserveOffsets[i]);
              const r = await timed(
                reqs,
                100 + i,
                key === dupKey && i === 3 ? "permit.reserve.dup" : "permit.reserve",
                () =>
                  h.handler(
                    edgeRequest("POST", "/v1/analysis-permits", {
                      token: a.accessToken,
                      ip: ip(iteration, 200 + i),
                      body: { idempotencyKey: key },
                    }),
                  ),
              );
              if (r.status === 200) {
                const permit = r.body.permit as Record<string, unknown> | undefined;
                if (i < 3) reserveEnded.push(r.row.endedAt);
                const embedded = r.body.access as Record<string, unknown> | undefined;
                const emb = embedded ? accessViolations(embedded) : ["access missing"];
                const embA = embedded && emb.length === 0 ? access(embedded) : null;
                embeddedOk.push(
                  emb.length === 0 &&
                    embA !== null &&
                    embA.reserved >= 1 &&
                    embA.used + embA.reserved <= FREE_LIMIT
                    ? "ok"
                    : `${emb.join(";") || (embA ? accessKey(embA) : "?")}`,
                );
                return { key, id: String(permit?.id ?? ""), status: r.status, code: r.code };
              }
              return { key, id: "", status: r.status, code: r.code };
            }),
          );
          for (const r of rs) reserveResults.push(`${r.status}${r.code ? `:${r.code}` : ""}`);
          const byKey = new Map<string, Set<string>>();
          for (const r of rs) {
            if (!r.id) continue;
            byKey.set(r.key, (byKey.get(r.key) ?? new Set()).add(r.id));
          }
          for (const ids of byKey.values()) for (const id of ids) permits.push(id);
          inv(
            invariants,
            "the duplicate reserve (same idempotency key) returns the same permit id",
            [...byKey.values()].every((ids) => ids.size === 1),
            `${[...byKey.values()].map((s) => s.size).join(",")}`,
          );
          // sync one scored shot per accepted permit from device B (+ one replay)
          const syncOffsets = schedule(prng, permits.length + 1, STRESS_LATENCY_MS * 3);
          const syncs = permits.map((permitId, i) => ({
            permitId,
            shotId: shotIds[i],
            replay: false,
          }));
          if (syncs.length) syncs.push({ ...syncs[prng.int(0, syncs.length - 1)], replay: true });
          const ss = await Promise.all(
            syncs.map(async (s, i) => {
              if (syncOffsets[i] > 0) await sleep(syncOffsets[i]);
              const r = await timed(
                reqs,
                110 + i,
                s.replay ? "shots.sync.replay" : "shots.sync",
                () =>
                  h.handler(
                    edgeRequest("POST", "/v1/shots:sync", {
                      token: b.accessToken,
                      ip: ip(iteration, 210 + i),
                      body: { shots: [syncShotPayload(s.shotId, s.permitId)] },
                    }),
                  ),
              );
              const acc = (r.body.acceptedIds ?? []) as string[];
              const rej = (r.body.rejected ?? []) as Array<{ code: string }>;
              const verdict = acc.includes(s.shotId)
                ? "accepted"
                : (rej[0]?.code ?? `http${r.status}`);
              syncVerdicts.push(`${s.replay ? "replay:" : ""}${verdict}`);
              if (verdict === "accepted" && !s.replay) syncEnded.push(r.row.endedAt);
              return verdict;
            }),
          );
          inv(
            invariants,
            "every scored sync of a reserved permit is accepted (replay included)",
            ss.every((v) => v === "accepted"),
            ss.join(","),
          );
        })();

        const reads = await Promise.all(
          readers.map(async (offset, lane) => {
            if (offset > 0) await sleep(offset);
            const token = lane % 2 === 0 ? a.accessToken : b.accessToken;
            return timed(
              reqs,
              lane,
              "me.access",
              () => meAccess(h, token, ip(iteration, lane)),
              token,
            );
          }),
        );
        await writer;
        const final = await timed(reqs, 998, "me.access.final", () =>
          meAccess(h, a.accessToken, ip(iteration, 98)),
        );

        const ok = reads.filter((r) => r.status === 200);
        const violations = ok.flatMap((r) => accessViolations(r.body));
        inv(
          invariants,
          "every read during writes is 200",
          ok.length === reads.length,
          JSON.stringify(histogram(reads.map((r) => r.status))),
        );
        inv(
          invariants,
          "every snapshot passes the mobile parseAccess contract",
          violations.length === 0,
          violations.slice(0, 3).join("; ") || "ok",
        );
        const snaps = ok.map((r) => ({ row: r.row, a: access(r.body) }));
        inv(
          invariants,
          "every 200 reserve embeds a valid access snapshot that already reflects the reservation (reserved ≥ 1, used+reserved ≤ 2)",
          embeddedOk.length > 0 && embeddedOk.every((e) => e === "ok"),
          embeddedOk.join(","),
        );
        inv(
          invariants,
          "no snapshot ever shows used+reserved > 2 on a free account",
          snaps.every((s) => s.a.used + s.a.reserved <= FREE_LIMIT),
          snaps.map((s) => `${s.a.used}+${s.a.reserved}`).join(" "),
        );
        checkReadOrder(invariants, snaps, { reserveEnded, syncEnded }, "two devices");
        const scoredRows = h.fake.tables.shots.filter(
          (s) => s.user_id === sub && s.result_kind === "scored",
        ).length;
        const permitRows = h.fake.tables.analysis_permits.filter((p) => p.user_id === sub);
        inv(
          invariants,
          "exactly two permits exist and exactly two scored shots — the third reserve is refused (no double spend, no duplicate rows)",
          permitRows.length === FREE_LIMIT &&
            scoredRows === FREE_LIMIT &&
            new Set(h.fake.tables.shots.map((s) => s.id)).size === h.fake.tables.shots.length,
          `permits=${permitRows.length} scored=${scoredRows} reserveResults=${reserveResults.join(",")}`,
        );
        const fa = final.status === 200 ? access(final.body) : null;
        inv(
          invariants,
          "final read: used=2 reserved=0 availableToReserve=0 paywallRequired=true",
          fa !== null &&
            fa.used === 2 &&
            fa.reserved === 0 &&
            fa.availableToReserve === 0 &&
            fa.paywallRequired &&
            !fa.canStartRating,
          fa ? accessKey(fa) : `status ${final.status}`,
        );
        observations.reserveResults = reserveResults;
        observations.syncVerdicts = syncVerdicts;
        observations.snapshots = snaps
          .sort((x, y) => x.row.startedAt - y.row.startedAt)
          .map((s) => `${s.a.used}/${s.a.reserved}`);
      },
    );
    assertHeld(summary);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// C — rotation and logout while a burst is in flight (two devices)
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "stress me.access C: refresh rotation + logout mid-burst — only 200/401, refused bearer never resurrected, sibling device unaffected",
  async () => {
    const summary = await runScenario(
      "c_rotation_logout",
      "C rotation/logout",
      STRESS_ITER,
      async (h, prng, _seed, iteration, reqs, invariants, observations) => {
        const { a, b } = await twoDevices(h, prng, iteration);
        // warm both bearers so the burst races the CACHED verification path too
        await timed(
          reqs,
          300,
          "me.access.warm",
          () => meAccess(h, a.accessToken, ip(iteration, 240)),
          a.accessToken,
        );
        await timed(
          reqs,
          301,
          "me.access.warm",
          () => meAccess(h, b.accessToken, ip(iteration, 241)),
          b.accessToken,
        );
        const spread = STRESS_LATENCY_MS * 8;
        const offsets = schedule(prng, STRESS_LANES, spread);
        const refreshAt = prng.int(0, spread / 2);
        const logoutAt = prng.int(refreshAt, spread);
        h.fake.overrides.getUserDelayMs = (bearer) =>
          bearer === a.accessToken && prng.next() < 0.5 ? prng.int(0, STRESS_LATENCY_MS) : 0;
        let rotated: string | null = null;
        let rotatedAt = 0;
        let refreshStatus = 0;
        let refreshEnded = 0;
        let logoutStarted = 0;
        let logoutEnded = 0;
        let logoutStatus = 0;
        const lanes: Array<Promise<unknown>> = [];
        lanes.push(
          (async () => {
            await sleep(refreshAt);
            const r = await timed(reqs, 400, "auth.refresh", () =>
              h.handler(
                edgeRequest("POST", "/v1/auth/refresh", {
                  ip: ip(iteration, 242),
                  body: { refreshToken: a.refreshToken },
                }),
              ),
            );
            const session = r.body.session as Record<string, unknown> | undefined;
            refreshStatus = r.status;
            refreshEnded = r.row.endedAt;
            if (r.status === 200 && session) {
              rotated = String(session.accessToken);
              rotatedAt = r.row.endedAt;
            }
          })(),
        );
        lanes.push(
          (async () => {
            await sleep(logoutAt);
            const r = await timed(reqs, 401, "auth.logout", () =>
              h.handler(
                edgeRequest("POST", "/v1/auth/logout", {
                  token: a.accessToken,
                  ip: ip(iteration, 243),
                }),
              ),
            );
            logoutStarted = r.row.startedAt;
            logoutEnded = r.row.endedAt;
            logoutStatus = r.status;
          })(),
        );
        const reads = offsets.map(async (offset, lane) => {
          if (offset > 0) await sleep(offset);
          const pick = lane % 3;
          // 0 → device A old bearer, 1 → device B, 2 → device A rotated bearer if present else old
          const current: string | null = rotated;
          const token =
            pick === 1 ? b.accessToken : pick === 2 && current ? current : a.accessToken;
          const op =
            pick === 1
              ? "me.access.B"
              : current !== null && token === current
                ? "me.access.A.rotated"
                : "me.access.A";
          return timed(reqs, lane, op, () => meAccess(h, token, ip(iteration, lane)), token);
        });
        const results = await Promise.all([...reads, ...lanes]);
        // post-burst probes: the logged-out session (old + rotated bearer) must be refused; B must be fine
        const rot: string | null = rotated;
        const probes = await Promise.all([
          timed(
            reqs,
            500,
            "me.access.A.after_logout",
            () => meAccess(h, a.accessToken, ip(iteration, 244)),
            a.accessToken,
          ),
          rot
            ? timed(
                reqs,
                501,
                "me.access.A.rotated.after_logout",
                () => meAccess(h, rot, ip(iteration, 245)),
                rot,
              )
            : Promise.resolve(null),
          timed(
            reqs,
            502,
            "me.access.B.after_logout",
            () => meAccess(h, b.accessToken, ip(iteration, 246)),
            b.accessToken,
          ),
        ]);
        const readRows = reqs.filter((r) => r.op.startsWith("me.access"));
        inv(
          invariants,
          "logout revoked the session (204), and the concurrent refresh either rotated (200) or was refused because the logout had already been issued (401)",
          logoutStatus === 204 &&
            (refreshStatus === 200 ||
              (refreshStatus === 401 && logoutStarted > 0 && logoutStarted <= refreshEnded)),
          `refresh=${refreshStatus} (ended ${Math.round(refreshEnded)}) logout=${logoutStatus} (started ${Math.round(logoutStarted)})`,
        );
        inv(
          invariants,
          "every read is 200 or 401 — nothing else",
          readRows.every((r) => r.status === 200 || r.status === 401),
          JSON.stringify(histogram(readRows.map((r) => `${r.op}:${r.status}`))),
        );
        inv(
          invariants,
          "device B is never affected by device A's rotation or logout",
          readRows.filter((r) => r.op.startsWith("me.access.B")).every((r) => r.status === 200),
          JSON.stringify(
            histogram(readRows.filter((r) => r.op.startsWith("me.access.B")).map((r) => r.status)),
          ),
        );
        const aRows = readRows.filter((r) => r.op.startsWith("me.access.A"));
        const afterLogout = aRows.filter((r) => logoutEnded > 0 && r.startedAt >= logoutEnded);
        inv(
          invariants,
          "every device-A read started after logout completed is 401 (old AND rotated bearer)",
          afterLogout.length > 0 && afterLogout.every((r) => r.status === 401),
          `${afterLogout.filter((r) => r.status === 401).length}/${afterLogout.length} → 401`,
        );
        // reads that OVERLAP the logout may land on either side of the revocation; only
        // reads that ended before the logout request was even issued are pinned to 200
        const beforeLogout = aRows.filter((r) => r.endedAt <= logoutStarted || logoutEnded === 0);
        inv(
          invariants,
          "every device-A read that ended before logout started is 200 (a refreshed session's old bearer keeps working until exp)",
          beforeLogout.every((r) => r.status === 200),
          JSON.stringify(histogram(beforeLogout.map((r) => `${r.op}:${r.status}`))),
        );
        // no resurrection: per bearer, once a 401 ENDED, no read that STARTED later is 200
        let resurrected = "";
        for (const bearer of new Set(aRows.map((r) => r.bearer))) {
          const rows = aRows.filter((r) => r.bearer === bearer);
          const firstRefusal = Math.min(
            ...rows.filter((r) => r.status === 401).map((r) => r.endedAt),
          );
          const late200 = rows.find((r) => r.status === 200 && r.startedAt >= firstRefusal);
          if (late200)
            resurrected = `${late200.op} lane ${late200.lane} 200 started ${Math.round(late200.startedAt - firstRefusal)}ms after a 401 for the same bearer`;
        }
        inv(
          invariants,
          "a refused bearer is never resurrected",
          resurrected === "",
          resurrected || "ok",
        );
        inv(
          invariants,
          "all reads of one user agree on the free-rating state (identical snapshots across devices/bearers)",
          new Set(readRows.filter((r) => r.status === 200).map((r) => accessKey(access(r.body!))))
            .size <= 1,
          "",
        );
        observations.refreshStatus = refreshStatus;
        observations.refreshAt = refreshAt;
        observations.logoutAt = logoutAt;
        observations.rotatedAtMsAfterStart = rotatedAt
          ? Math.round(rotatedAt - reqs[0].startedAt)
          : null;
        observations.readsAfterLogout = afterLogout.length;
        observations.probes = probes.map((p) => (p ? `${p.row.op}:${p.status}` : "n/a"));
        void results;
      },
    );
    assertHeld(summary);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// D — cancel-during-call: aborted clients and fire-and-forget callers
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "stress me.access D: client aborts mid-call (AbortSignal + dropped promises) — no 5xx, later reads unaffected, everything settles",
  async () => {
    const summary = await runScenario(
      "d_cancel_during_call",
      "D cancel during call",
      STRESS_ITER,
      async (h, prng, _seed, iteration, reqs, invariants, observations) => {
        const sub = prng.uuid();
        const boot = await bootstrap(h, sub, ip(iteration, 250));
        if (boot.status !== 200) throw new Error(`bootstrap ${boot.status}`);
        const offsets = schedule(prng, STRESS_LANES, STRESS_LATENCY_MS * 2);
        const aborts = offsets.map(() =>
          prng.next() < 0.5 ? prng.int(0, STRESS_LATENCY_MS * 3) : -1,
        );
        let unhandled = 0;
        const onUnhandled = (event: PromiseRejectionEvent) => {
          unhandled += 1;
          event.preventDefault();
        };
        globalThis.addEventListener("unhandledrejection", onUnhandled);
        try {
          const settled = await Promise.allSettled(
            offsets.map(async (offset, lane) => {
              if (offset > 0) await sleep(offset);
              const controller = new AbortController();
              if (aborts[lane] >= 0) {
                // the client gives up while the call is in flight
                setTimeout(
                  () => controller.abort(new DOMException("client cancelled", "AbortError")),
                  aborts[lane],
                );
              }
              return timed(
                reqs,
                lane,
                aborts[lane] >= 0 ? "me.access.aborted" : "me.access",
                () => meAccess(h, boot.accessToken, ip(iteration, lane), controller.signal),
                boot.accessToken,
              );
            }),
          );
          // fire-and-forget: the caller drops the promise entirely
          const dropped = offsets
            .slice(0, 3)
            .map((_, i) => meAccess(h, boot.accessToken, ip(iteration, 60 + i)));
          const after = await timed(
            reqs,
            998,
            "me.access.after",
            () => meAccess(h, boot.accessToken, ip(iteration, 99)),
            boot.accessToken,
          );
          const droppedResults = await Promise.allSettled(dropped);
          await sleep(1);
          const okRows = settled
            .filter((s) => s.status === "fulfilled")
            .map((s) => (s as PromiseFulfilledResult<Awaited<ReturnType<typeof timed>>>).value);
          const rejected = settled.filter((s) => s.status === "rejected");
          inv(
            invariants,
            "every awaited call settles as a Response (never a thrown error) and is 200",
            rejected.length === 0 && okRows.every((r) => r.status === 200),
            `${rejected.length} rejected; ${JSON.stringify(histogram(okRows.map((r) => r.status)))}`,
          );
          inv(
            invariants,
            "aborted and non-aborted calls return the identical payload",
            new Set(okRows.map((r) => JSON.stringify(r.body))).size === 1,
            `${new Set(okRows.map((r) => JSON.stringify(r.body))).size} distinct`,
          );
          inv(
            invariants,
            "the read after the cancellations is 200 with a valid payload",
            after.status === 200 && accessViolations(after.body).length === 0,
            `${after.status}`,
          );
          inv(
            invariants,
            "dropped (fire-and-forget) calls settle with 200",
            droppedResults.every((d) => d.status === "fulfilled" && d.value.status === 200),
            droppedResults
              .map((d) => (d.status === "fulfilled" ? d.value.status : "rejected"))
              .join(","),
          );
          inv(
            invariants,
            "no unhandled promise rejection escapes the handler",
            unhandled === 0,
            `${unhandled} unhandled`,
          );
          observations.abortedLanes = aborts.filter((a) => a >= 0).length;
        } finally {
          globalThis.removeEventListener("unhandledrejection", onUnhandled);
        }
      },
    );
    assertHeld(summary);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// E — clock skew: near-expiry bearer, expired bearer, membership expiring mid-burst
// ─────────────────────────────────────────────────────────────────────────────

function b64url(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A bearer for an EXISTING fake session whose JWT exp is skewed by `expInSeconds`
 * from now — the device clock vs. server clock case. The fake resolves the
 * bearer to the same session (GoTrue would too, until exp). */
function skewedBearer(h: XcHarness, accessToken: string, expInSeconds: number): string {
  const sid = h.fake.accessIndex.get(accessToken);
  const session = sid ? h.fake.sessions.get(sid) : undefined;
  if (!session) throw new Error("skewedBearer: unknown access token");
  const payload = JSON.parse(atob(accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  const skewed = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(
    JSON.stringify({
      ...payload,
      exp: Math.floor(Date.now() / 1000) + expInSeconds,
      jti: `${payload.jti}-skew${expInSeconds}`,
    }),
  )}.sig`;
  h.fake.accessIndex.set(skewed, session.sessionId);
  return skewed;
}

Deno.test(
  "stress me.access E: clock skew — near-expiry bearer served but never cached, expired bearer 401 without upstream, premium expiring mid-burst flips once",
  async () => {
    const summary = await runScenario(
      "e_clock_skew",
      "E clock skew",
      STRESS_ITER,
      async (h, prng, _seed, iteration, reqs, invariants, observations) => {
        const sub = prng.uuid();
        const boot = await bootstrap(h, sub, ip(iteration, 250));
        if (boot.status !== 200) throw new Error(`bootstrap ${boot.status}`);
        const nearExp = skewedBearer(h, boot.accessToken, prng.int(6, 80)); // < 90 s → writeAuthCache skips (ttl < 60)
        const pastExp = skewedBearer(h, boot.accessToken, -prng.int(1, 3600));
        // membership that lapses during the burst
        const spread = STRESS_LATENCY_MS * 8;
        const lapseInMs = prng.int(spread / 4, (spread * 3) / 4);
        h.fake.tables.billing_entitlements.push({
          user_id: sub,
          premium: true,
          product_key: "pickle_sensei_pro_monthly",
          expires_at: new Date(Date.now() + lapseInMs).toISOString(),
          verified_at: new Date().toISOString(),
        });
        const offsets = schedule(prng, STRESS_LANES, spread);
        const kinds = offsets.map((_, lane) =>
          lane % 4 === 3 ? "past" : lane % 4 === 1 ? "near" : "fresh",
        );
        const getUserBefore = h.fake.counters["gotrue.get_user"] ?? 0;
        const rpcBefore = h.fake.counters["rpc.access_state"] ?? 0;
        const results = await Promise.all(
          offsets.map(async (offset, lane) => {
            if (offset > 0) await sleep(offset);
            const token =
              kinds[lane] === "past"
                ? pastExp
                : kinds[lane] === "near"
                  ? nearExp
                  : boot.accessToken;
            return timed(
              reqs,
              lane,
              `me.access.${kinds[lane]}`,
              () => meAccess(h, token, ip(iteration, lane)),
              token,
            );
          }),
        );
        const past = results.filter((_, i) => kinds[i] === "past");
        const near = results.filter((_, i) => kinds[i] === "near");
        const fresh = results.filter((_, i) => kinds[i] === "fresh");
        inv(
          invariants,
          "an expired bearer (device clock ahead) is 401 and reaches neither GoTrue nor the RPC",
          past.every((r) => r.status === 401) &&
            !h.fake.timeline.some(
              (t) => t.op === "gotrue.get_user" && t.detail.includes(pastExp.slice(-10)),
            ),
          JSON.stringify(histogram(past.map((r) => r.status))),
        );
        inv(
          invariants,
          "a near-expiry bearer (exp < 90 s) is served 200",
          near.every((r) => r.status === 200),
          JSON.stringify(histogram(near.map((r) => r.status))),
        );
        // near-expiry bearers are re-verified every time (never cached): a follow-up call adds one getUser
        const gu0 = h.fake.counters["gotrue.get_user"] ?? 0;
        const nearAgain = await timed(
          reqs,
          997,
          "me.access.near.again",
          () => meAccess(h, nearExp, ip(iteration, 97)),
          nearExp,
        );
        const gu1 = h.fake.counters["gotrue.get_user"] ?? 0;
        inv(
          invariants,
          "a near-expiry bearer is never cached (the follow-up read re-verifies with GoTrue)",
          nearAgain.status === 200 && gu1 - gu0 === 1,
          `getUser delta=${gu1 - gu0}`,
        );
        inv(
          invariants,
          "the fresh bearer is 200 throughout",
          fresh.every((r) => r.status === 200),
          JSON.stringify(histogram(fresh.map((r) => r.status))),
        );
        const ok = results.filter((r) => r.status === 200);
        const violations = ok.flatMap((r) => accessViolations(r.body));
        inv(
          invariants,
          "every payload (premium and lapsed alike) passes parseAccess",
          violations.length === 0,
          violations.slice(0, 3).join("; ") || "ok",
        );
        // premium flips exactly once in real-time order: no read that started after a premium=false read ended is premium=true
        const snaps = ok
          .map((r) => ({ row: r.row, a: access(r.body) }))
          .sort((x, y) => x.row.startedAt - y.row.startedAt);
        const firstLapse = Math.min(...snaps.filter((s) => !s.a.premium).map((s) => s.row.endedAt));
        const flipBack = snaps.find((s) => s.a.premium && s.row.startedAt >= firstLapse);
        inv(
          invariants,
          "membership lapse is monotone in real time (no premium=true after a premium=false was observed)",
          !flipBack,
          flipBack
            ? `lane ${flipBack.row.lane} premium=true after lapse observed`
            : `premium seq: ${snaps.map((s) => (s.a.premium ? "P" : "f")).join("")}`,
        );
        inv(
          invariants,
          "premium reads carry entitlements=['premium'] and canStartRating=true; lapsed reads carry [] and the free-rating rule",
          snaps.every((s) =>
            s.a.premium
              ? s.a.entitlements[0] === "premium" && s.a.canStartRating
              : s.a.entitlements.length === 0 && s.a.canStartRating === s.a.availableToReserve > 0,
          ),
          "",
        );
        observations.lapseInMs = lapseInMs;
        observations.premiumSeen = snaps.filter((s) => s.a.premium).length;
        observations.lapsedSeen = snaps.filter((s) => !s.a.premium).length;
        observations.getUserDuringBurst = (h.fake.counters["gotrue.get_user"] ?? 0) - getUserBefore;
        observations.rpcDuringBurst = (h.fake.counters["rpc.access_state"] ?? 0) - rpcBefore;
      },
    );
    assertHeld(summary);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// F — per-user budget under a single-user burst above GENERAL_USER_LIMIT
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "stress me.access F: 250 same-user reads in one burst admit exactly the 239 left after bootstrap; every 429 carries Retry-After and reaches no RPC",
  async () => {
    const summary = await runScenario(
      "f_user_budget",
      "F user budget",
      Math.max(1, Math.floor(STRESS_ITER / 4)),
      async (h, prng, _seed, iteration, reqs, invariants, observations) => {
        const sub = prng.uuid();
        // the window is an aligned minute bucket: never straddle a boundary
        const msLeft = 60_000 - (Date.now() % 60_000);
        if (msLeft < 5_000) await sleep(msLeft + 5);
        const bucket = Math.floor(Date.now() / 60_000);
        // bootstrap is charged to the same per-user budget (index.ts: enforceRateLimit("user", …)
        // right after the ID-token exchange), so it spends 1 of the 240
        const boot = await bootstrap(h, sub, ip(iteration, 250));
        if (boot.status !== 200) throw new Error(`bootstrap ${boot.status}`);
        const budgetForReads = GENERAL_USER_LIMIT - 1;
        const total = GENERAL_USER_LIMIT + 10;
        const offsets = schedule(prng, total, STRESS_LATENCY_MS * 4);
        const rpcBefore = h.fake.counters["rpc.access_state"] ?? 0;
        const results = await Promise.all(
          offsets.map(async (offset, lane) => {
            if (offset > 0) await sleep(offset);
            return timed(
              reqs,
              lane,
              "me.access",
              () => meAccess(h, boot.accessToken, ip(iteration, lane & 63)),
              boot.accessToken,
            );
          }),
        );
        const sameBucket = Math.floor(Date.now() / 60_000) === bucket;
        const ok = results.filter((r) => r.status === 200);
        const limited = results.filter((r) => r.status === 429);
        inv(
          invariants,
          "burst stayed inside one rate-limit bucket (precondition)",
          sameBucket,
          sameBucket ? "ok" : "crossed a minute boundary — rerun",
        );
        inv(
          invariants,
          `exactly ${budgetForReads} of ${total} reads admitted (bootstrap spent the 240th), the rest 429`,
          ok.length === budgetForReads && limited.length === total - budgetForReads,
          `200=${ok.length} 429=${limited.length} other=${results.length - ok.length - limited.length}`,
        );
        inv(
          invariants,
          "every 429 carries Retry-After",
          limited.every((r) => r.headers.get("Retry-After") !== null),
          `${limited.filter((r) => r.headers.get("Retry-After") !== null).length}/${limited.length}`,
        );
        inv(
          invariants,
          "access_state is called once per admitted request and never for a 429",
          (h.fake.counters["rpc.access_state"] ?? 0) - rpcBefore === ok.length,
          `${(h.fake.counters["rpc.access_state"] ?? 0) - rpcBefore} rpc calls`,
        );
        inv(
          invariants,
          "all admitted payloads identical and valid",
          new Set(ok.map((r) => JSON.stringify(r.body))).size === 1 &&
            ok.every((r) => accessViolations(r.body).length === 0),
          "",
        );
        observations.firstLimitedStartIndex = limited.length
          ? Math.min(...limited.map((r) => offsets.indexOf(offsets[r.row.lane])))
          : null;
      },
    );
    assertHeld(summary);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// campaign summary (seed → outcome table)
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("stress me.access: write campaign summary (seed → outcome table)", async () => {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const table = campaignRows.map((r) => ({
    scenario: r.scenario,
    iteration: r.iteration,
    seed: r.seed,
    outcome: r.outcome,
    requests: r.requests,
    durationMs: r.durationMs,
    violated: r.violated,
    replay: r.replay,
  }));
  const summary = {
    unit: "route-get-v1-me-access",
    lens: "concurrency",
    campaignSeed: STRESS_SEED,
    lanes: STRESS_LANES,
    latencyMs: STRESS_LATENCY_MS,
    wallMs: STRESS_WALL_MS,
    iterations: table.length,
    requests: table.reduce((n, r) => n + r.requests, 0),
    held: table.filter((r) => r.outcome === "HELD").length,
    broken: table.filter((r) => r.outcome === "BROKEN").length,
    scenarios: campaignScenarios,
    heap: Deno.memoryUsage(),
    table,
  };
  await Deno.writeTextFile(`${dir}campaign.json`, JSON.stringify(summary, null, 2));
  console.log(
    `[stress] campaign: ${summary.iterations} interleavings, ${summary.requests} requests, ${summary.held} HELD / ${summary.broken} BROKEN → ${dir}campaign.json`,
  );
  assert(summary.iterations > 0, "no iteration ran");
});
