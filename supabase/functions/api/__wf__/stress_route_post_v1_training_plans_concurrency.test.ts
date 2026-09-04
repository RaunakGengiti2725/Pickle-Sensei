// stress · route-post-v1-training-plans · lens = concurrency
//
// Drives the REAL edge handler (../index.ts, Deno.serve captured in-process by
// xc_concurrency_harness.ts, Supabase Auth / PostgREST / RevenueCat stubbed,
// Upstash absent → per-isolate cache + rate limits) with Promise.all bursts
// against `POST /v1/training-plans`, from a SEEDED scheduler: every iteration
// derives its PRNG, actors, IPs, burst size, per-request stagger and upstream
// latency from (STRESS_SEED, family, iteration) and is replayable on its own.
//
// Contract under test (index.ts "Training plans: honest empty states"): the
// route answers 409 `training.plan_unavailable` for every authenticated caller
// and touches no state — no PostgREST row, no RPC, no permit, no free-rating
// ledger, no RevenueCat lookup. So the concurrency invariants are:
//   idempotency        every accepted call gets the identical 409 body
//   no double spend    zero /rest/v1 (rows/RPC/permits) and zero RevenueCat
//                      calls during any burst, whatever the interleaving
//   no duplicate rows  same thing, observed as zero PostgREST writes
//   no lost update     the per-user rate-limit counter admits EXACTLY its
//                      budget under a 240+k concurrent burst
//   no deadlock        every handler promise settles, bounded wall time,
//                      no unhandled rejection, access log == responses
//   auth boundary      logout/refresh/clock-skew during the burst only ever
//                      move a call between 409 and 401 (never 5xx, never a
//                      post-revocation 409, never a GoTrue re-verify after
//                      the revocation fence)
//
// Families (each = one Deno.test, STRESS_ITER iterations, one JSON row each):
//   F1 dup_burst        duplicate delivery / call-during-call, one actor
//   F2 two_actors       2–5 users + a second device, same sourceShotId, one
//                       device logs out mid-burst
//   F3 logout_in_burst  logout lands while the burst is in flight
//   F4 refresh_in_burst rotation lands while the burst is in flight
//   F5 cancel_in_call   aborted signals / never-ending streamed bodies
//   F6 clock_skew       expired, expiring-mid-burst, non-numeric / absent exp
//   F7 rate_limit       240+k concurrent → exactly the budget admitted
//   F8 scheduler        seeded random program mixing all of the above
//
// Knobs: STRESS_ITER (default 4 per family — keeps the suite fast; the
// campaign ran 72 → 513 iterations), STRESS_SEED (default 20260904),
// STRESS_LATENCY_MS (max seeded upstream latency, default 6),
// STRESS_REPLAY="<family>:<iteration>" (run exactly that iteration; every
// other family is `ignored`), STRESS_OUT_DIR (JSON table destination,
// default artifacts/stress-route-post-v1-training-plans/concurrency/latest/).
// Replay line for any row: see `replay` in the JSON table.

import { assert } from "@std/assert";
import { captureAccessLog } from "../http.ts";
import {
  b64url,
  bootstrap,
  edgeRequest,
  envInt,
  histogram,
  isRecord,
  jwtPayload,
  loadXcHarness,
  Prng,
  readJson,
  sleep,
  SUPABASE_URL,
  type XcHarness,
} from "./xc_concurrency_harness.ts";

// ── Contract constants ───────────────────────────────────────────────────────

const ROUTE = "/v1/training-plans";
const EXPECTED_STATUS = 409;
const EXPECTED_CODE = "training.plan_unavailable";
const EXPECTED_MESSAGE =
  "Training plans require coach-validated drill content, which has not been published yet.";
const GENERAL_USER_LIMIT = 240; // index.ts GENERAL_USER_LIMIT (no ROUTE_LIMITS entry for this route)
const AUTH_FAILURE_BUDGET = 30; // index.ts AUTH_FAILURE_LIMIT — every family stays under it per IP
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ── Knobs ────────────────────────────────────────────────────────────────────

const STRESS_ITER = envInt("STRESS_ITER", 4);
const STRESS_SEED = envInt("STRESS_SEED", 20260904);
const STRESS_LATENCY_MS = envInt("STRESS_LATENCY_MS", 6);
const STRESS_REPLAY = Deno.env.get("STRESS_REPLAY") ?? "";
const TEST_FILE = "stress_route_post_v1_training_plans_concurrency.test.ts";

function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-route-post-v1-training-plans/concurrency/latest/",
    import.meta.url,
  ).pathname;
}

// ── Seeding ──────────────────────────────────────────────────────────────────

const FAMILIES = [
  "dup_burst",
  "two_actors",
  "logout_in_burst",
  "refresh_in_burst",
  "cancel_in_call",
  "clock_skew",
  "rate_limit",
  "scheduler",
] as const;
type Family = (typeof FAMILIES)[number];

function seedFor(family: Family, iteration: number): number {
  const familyIndex = FAMILIES.indexOf(family);
  let h = (STRESS_SEED ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (familyIndex + 1), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13) ^ (iteration + 1), 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** One IP per (family, iteration): the edge fn's in-memory per-IP and
 * auth-failure windows outlive fake.reset(), so iterations must never share
 * a budget — and a `STRESS_REPLAY` run must see exactly the IP the campaign
 * used. */
function ipFor(family: Family, iteration: number): string {
  return `10.${100 + FAMILIES.indexOf(family)}.${(iteration >> 8) & 255}.${iteration & 255}`;
}

function iterationsFor(family: Family): number[] {
  if (STRESS_REPLAY) {
    const [fam, idx] = STRESS_REPLAY.split(":");
    if (fam !== family) return [];
    const n = Number(idx);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`STRESS_REPLAY must be "<family>:<iteration>", got ${STRESS_REPLAY}`);
    }
    return [n];
  }
  const count = family === "rate_limit" ? Math.max(1, Math.floor(STRESS_ITER / 8)) : STRESS_ITER;
  return Array.from({ length: count }, (_, i) => i);
}

function replayCommand(family: Family, iteration: number): string {
  return `STRESS_SEED=${STRESS_SEED} STRESS_LATENCY_MS=${STRESS_LATENCY_MS} STRESS_REPLAY=${family}:${iteration} deno test -A --no-check --config deno.json ${TEST_FILE}`;
}

// ── Bookkeeping ──────────────────────────────────────────────────────────────

interface Row {
  i: number;
  actor: string;
  op: string;
  status: number;
  code?: string;
  requestId: string | null;
  sentRequestId: string | null;
  bodyOk: boolean;
  startedAt: number;
  endedAt: number;
  note?: string;
  /** Session-lifecycle call (logout/refresh) fired INTO the burst; judged by
   * its family, not by the route-under-test invariants. */
  aux?: boolean;
}

interface Invariant {
  name: string;
  holds: boolean;
  detail: string;
}

interface UpstreamTally {
  rest: number;
  rpc: number;
  revenuecat: number;
  gotrueGetUser: number;
  gotrueLogout: number;
  gotrueToken: number;
  other: number;
}

interface IterationResult {
  family: Family;
  iteration: number;
  seed: number;
  ip: string;
  latencyMaxMs: number;
  inputs: Record<string, unknown>;
  requests: number;
  statusHistogram: Record<string, number>;
  upstreamDuringBurst: UpstreamTally;
  invariants: Invariant[];
  broken: string[];
  observations: Record<string, unknown>;
  durationMs: number;
  accessLogLines: number;
  unhandledRejections: number;
  heap: { before: Deno.MemoryUsage; after: Deno.MemoryUsage };
  replay: string;
}

const campaign: IterationResult[] = [];

let unhandledRejections = 0;
globalThis.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  unhandledRejections += 1;
});

function tally(calls: XcHarness["upstreamCalls"]): UpstreamTally {
  const t: UpstreamTally = {
    rest: 0,
    rpc: 0,
    revenuecat: 0,
    gotrueGetUser: 0,
    gotrueLogout: 0,
    gotrueToken: 0,
    other: 0,
  };
  for (const call of calls) {
    const url = new URL(call.url);
    if (url.hostname.endsWith("revenuecat.com")) t.revenuecat += 1;
    else if (url.origin === SUPABASE_URL && url.pathname.startsWith("/rest/v1/rpc/")) t.rpc += 1;
    else if (url.origin === SUPABASE_URL && url.pathname.startsWith("/rest/v1/")) t.rest += 1;
    else if (url.pathname === "/auth/v1/user") t.gotrueGetUser += 1;
    else if (url.pathname === "/auth/v1/logout") t.gotrueLogout += 1;
    else if (url.pathname === "/auth/v1/token") t.gotrueToken += 1;
    else t.other += 1;
  }
  return t;
}

class Ctx {
  readonly rows: Row[] = [];
  readonly invariants: Invariant[] = [];
  readonly inputs: Record<string, unknown> = {};
  readonly observations: Record<string, unknown> = {};
  /** Upstream calls before this index belong to setup (bootstrap), not to the burst. */
  upstreamStart = 0;
  private next = 0;
  constructor(
    readonly h: XcHarness,
    readonly prng: Prng,
    readonly family: Family,
    readonly iteration: number,
    readonly seed: number,
    readonly ip: string,
  ) {}

  inv(name: string, holds: boolean, detail: string): void {
    this.invariants.push({ name, holds, detail });
  }

  markBurst(): void {
    this.upstreamStart = this.h.upstreamCalls.length;
  }

  /** Deterministic provider subject for an actor of this iteration. */
  sub(actor: string): string {
    return `stress-${this.family}-${this.seed.toString(16)}-${actor}`;
  }

  async boot(actor: string): Promise<{ accessToken: string; refreshToken: string }> {
    const booted = await bootstrap(this.h, this.sub(actor), this.ip);
    if (booted.status !== 200 || !booted.accessToken) {
      throw new Error(
        `precondition: bootstrap(${actor}) → ${booted.status} ${JSON.stringify(booted.body)}`,
      );
    }
    return { accessToken: booted.accessToken, refreshToken: booted.refreshToken };
  }

  plan(
    token: string | null,
    options: { body?: unknown; requestId?: string; headers?: Record<string, string> } = {},
  ): Request {
    const headers: Record<string, string> = { ...options.headers };
    if (options.requestId !== undefined) headers["x-request-id"] = options.requestId;
    return edgeRequest("POST", ROUTE, {
      token,
      ip: this.ip,
      body: options.body === undefined ? { sourceShotId: this.prng.uuid() } : options.body,
      headers,
    });
  }

  /** Fire one request through the real handler after `delayMs`; a handler
   * that throws is recorded as status 0 (never swallowed). */
  async send(
    op: string,
    actor: string,
    delayMs: number,
    request: Request,
    aux = false,
  ): Promise<Row> {
    const i = this.next++;
    if (delayMs > 0) await sleep(delayMs);
    const sentRequestId = request.headers.get("x-request-id");
    const startedAt = performance.now();
    let status = 0;
    let code: string | undefined;
    let requestId: string | null = null;
    let bodyOk = false;
    let note: string | undefined;
    try {
      const response = await this.h.handler(request);
      status = response.status;
      requestId = response.headers.get("x-request-id");
      const body = await readJson(response);
      const err = isRecord(body.error) ? body.error : null;
      code = typeof err?.code === "string" ? err.code : undefined;
      bodyOk =
        status === EXPECTED_STATUS
          ? err?.code === EXPECTED_CODE &&
            err?.message === EXPECTED_MESSAGE &&
            Object.keys(body).length === 1 &&
            Object.keys(err ?? {}).length === 2 &&
            (response.headers.get("content-type") ?? "").includes("application/json") &&
            response.headers.get("cache-control") === "no-store"
          : status === 200
            ? body.plan === null && Object.keys(body).length === 1
            : status === 401 || status === 413 || status === 429
              ? typeof err?.message === "string"
              : false;
    } catch (error) {
      note = `handler threw: ${error instanceof Error ? error.message : String(error)}`;
    }
    const row: Row = {
      i,
      actor,
      op,
      aux,
      status,
      code,
      requestId,
      sentRequestId,
      bodyOk,
      startedAt: Math.round(startedAt * 100) / 100,
      endedAt: Math.round(performance.now() * 100) / 100,
      note,
    };
    this.rows.push(row);
    return row;
  }
}

const ROW_LABEL = (r: Row) =>
  `#${r.i} ${r.actor}/${r.op} → ${r.status}${r.code ? ` ${r.code}` : ""}`;

/** Invariants every family asserts on every iteration. */
function universalInvariants(
  ctx: Ctx,
  burstRows: Row[],
  upstream: UpstreamTally,
  accessLines: Array<Record<string, unknown>>,
  durationMs: number,
  wallBoundMs: number,
  rejections: number,
): void {
  const fiveXx = burstRows.filter((r) => r.status >= 500 || r.status === 0);
  ctx.inv(
    "no_5xx_no_throw",
    fiveXx.length === 0,
    fiveXx.length === 0
      ? `${burstRows.length} responses, none 5xx / thrown`
      : fiveXx.map(ROW_LABEL).join("; "),
  );

  const badBodies = burstRows.filter((r) => r.status !== 0 && !r.bodyOk);
  ctx.inv(
    "body_contract_exact",
    badBodies.length === 0,
    badBodies.length === 0
      ? `every 409 is exactly {error:{code:${EXPECTED_CODE},message}} + json/no-store; 200/401/413/429 shaped`
      : badBodies.map(ROW_LABEL).join("; "),
  );

  ctx.inv(
    "no_state_no_double_spend",
    upstream.rest === 0 && upstream.rpc === 0 && upstream.revenuecat === 0,
    `during burst: rest=${upstream.rest} rpc=${upstream.rpc} revenuecat=${upstream.revenuecat} (permits / free-rating ledger / rows untouched)`,
  );

  const minted = burstRows
    .filter((r) => r.status !== 0 && r.sentRequestId === null)
    .map((r) => r.requestId);
  const missing = burstRows.filter((r) => r.status !== 0 && !r.requestId);
  const notEchoed = burstRows.filter(
    (r) =>
      r.status !== 0 &&
      r.sentRequestId !== null &&
      /^[A-Za-z0-9._-]{8,64}$/.test(r.sentRequestId) &&
      r.requestId !== r.sentRequestId,
  );
  const notUuid = minted.filter((id) => !id || !UUID_RE.test(id));
  const dupMinted = minted.length - new Set(minted).size;
  ctx.inv(
    "request_id_contract",
    missing.length === 0 && notEchoed.length === 0 && notUuid.length === 0 && dupMinted === 0,
    `missing=${missing.length} notEchoed=${notEchoed.length} mintedNonUuid=${notUuid.length} mintedDuplicates=${dupMinted} (minted ${minted.length}, echoed ${burstRows.length - minted.length})`,
  );

  const responded = burstRows.filter((r) => r.status !== 0);
  const want = histogram(responded.map((r) => `${r.requestId}:${r.status}`));
  const got = histogram(accessLines.map((l) => `${String(l.requestId)}:${String(l.status)}`));
  const sameKeys =
    Object.keys(want).length === Object.keys(got).length &&
    Object.entries(want).every(([k, v]) => got[k] === v);
  const badCodes = accessLines.filter(
    (l) => Number(l.status) === EXPECTED_STATUS && l.code !== EXPECTED_CODE,
  );
  ctx.inv(
    "access_log_matches_responses",
    sameKeys && badCodes.length === 0,
    `${accessLines.length} api_request lines for ${responded.length} responses; (requestId,status) multisets ${
      sameKeys ? "equal" : "DIFFER"
    }; 409 lines carrying code=${EXPECTED_CODE}: ${
      accessLines.filter((l) => Number(l.status) === EXPECTED_STATUS).length - badCodes.length
    }/${accessLines.filter((l) => Number(l.status) === EXPECTED_STATUS).length}`,
  );

  ctx.inv(
    "bounded_wall_time",
    durationMs <= wallBoundMs,
    `${durationMs}ms ≤ ${wallBoundMs}ms bound (every Promise.all settled)`,
  );
  ctx.inv("no_unhandled_rejections", rejections === 0, `${rejections} unhandled rejections`);
}

async function runIteration(
  family: Family,
  iteration: number,
  run: (ctx: Ctx) => Promise<{ burstStartIndex: number; wallBoundMs: number }>,
): Promise<IterationResult> {
  const h = await loadXcHarness();
  const seed = seedFor(family, iteration);
  const ip = ipFor(family, iteration);
  h.fake.reset(seed, STRESS_LATENCY_MS);
  h.upstreamCalls.length = 0;
  const ctx = new Ctx(h, new Prng(seed), family, iteration, seed, ip);
  const accessLines: Array<Record<string, unknown>> = [];
  const restore = captureAccessLog((line) => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (
      parsed.route === `/functions/v1/api${ROUTE}` ||
      parsed.route === `/functions/v1/api${ROUTE}/current`
    ) {
      accessLines.push(parsed);
    }
  });
  const rejectionsBefore = unhandledRejections;
  const before = Deno.memoryUsage();
  const t0 = performance.now();
  let burstStartIndex = 0;
  let wallBoundMs = 0;
  try {
    const marks = await run(ctx);
    burstStartIndex = marks.burstStartIndex;
    wallBoundMs = marks.wallBoundMs;
  } finally {
    restore();
  }
  const durationMs = Math.round(performance.now() - t0);
  await sleep(0);
  const rejections = unhandledRejections - rejectionsBefore;
  const after = Deno.memoryUsage();
  const upstream = tally(h.upstreamCalls.slice(ctx.upstreamStart));
  const burstRows = ctx.rows.slice(burstStartIndex).filter((r) => !r.aux);
  universalInvariants(ctx, burstRows, upstream, accessLines, durationMs, wallBoundMs, rejections);

  const result: IterationResult = {
    family,
    iteration,
    seed,
    ip,
    latencyMaxMs: STRESS_LATENCY_MS,
    inputs: ctx.inputs,
    requests: ctx.rows.length,
    statusHistogram: histogram(
      ctx.rows.map((r) => `${r.op}:${r.status}${r.code ? `:${r.code}` : ""}`),
    ),
    upstreamDuringBurst: upstream,
    invariants: ctx.invariants,
    broken: ctx.invariants.filter((x) => !x.holds).map((x) => x.name),
    observations: ctx.observations,
    durationMs,
    accessLogLines: accessLines.length,
    unhandledRejections: rejections,
    heap: { before, after },
    replay: replayCommand(family, iteration),
  };
  campaign.push(result);
  const verdict = result.broken.length === 0 ? "HELD  " : "BROKEN";
  console.log(
    `[stress] ${verdict} ${family}#${iteration} seed=${seed} requests=${result.requests} ${durationMs}ms ${
      result.broken.length ? `broken=${result.broken.join(",")}` : ""
    }`,
  );
  if (result.broken.length) {
    for (const x of ctx.invariants.filter((y) => !y.holds)) {
      console.log(`[stress]   BROKEN ${x.name} — ${x.detail}`);
    }
    await writeTable();
  }
  return result;
}

async function family(
  name: Family,
  run: (ctx: Ctx) => Promise<{ burstStartIndex: number; wallBoundMs: number }>,
): Promise<void> {
  const failures: string[] = [];
  for (const iteration of iterationsFor(name)) {
    const result = await runIteration(name, iteration, run);
    if (result.broken.length) {
      failures.push(
        `${name}#${iteration} seed=${result.seed}: ${result.broken.join(",")} — replay: ${result.replay}`,
      );
    }
  }
  assert(failures.length === 0, `${failures.length} broken iteration(s):\n${failures.join("\n")}`);
}

/** Skew a real session bearer: same session_id / sub, custom exp claim, and
 * register it with the fake GoTrue so getUser() resolves it. */
function skewedBearer(h: XcHarness, accessToken: string, exp: unknown): string {
  const payload = jwtPayload(accessToken);
  if (!payload) throw new Error("precondition: bearer is not a JWT");
  const sid = h.fake.accessIndex.get(accessToken);
  if (!sid) throw new Error("precondition: bearer unknown to the fake GoTrue");
  const { exp: _drop, ...rest } = payload;
  const claims: Record<string, unknown> = {
    ...rest,
    jti: `${String(payload.jti)}-skew-${String(exp)}`,
  };
  if (exp !== undefined) claims.exp = exp;
  const token = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}.sig`;
  h.fake.accessIndex.set(token, sid);
  return token;
}

const stagger = (prng: Prng, maxMs: number) => (maxMs > 0 ? prng.int(0, maxMs) : 0);

// ─────────────────────────────────────────────────────────────────────────────
// F1 — duplicate delivery / call-during-call, one actor
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress F1 dup_burst: N identical POST /v1/training-plans in flight at once — every one 409 training.plan_unavailable, no row/permit/ledger write, warm cache after the burst",
  ignore: iterationsFor("dup_burst").length === 0,
  fn: () =>
    family("dup_burst", async (ctx) => {
      const { h, prng } = ctx;
      const a = await ctx.boot("A");
      const n = prng.int(8, 40);
      const maxStagger = prng.int(0, STRESS_LATENCY_MS * 3);
      const sourceShotId = prng.uuid();
      const dupRequestId = `stress-dup-${ctx.seed.toString(16)}`;
      const dupShare = prng.int(0, n);
      Object.assign(ctx.inputs, { n, maxStagger, sourceShotId, dupRequestId, dupShare });
      const burstStartIndex = ctx.rows.length;
      const getUserBefore = h.fake.counters["gotrue.get_user"] ?? 0;
      ctx.markBurst();
      await Promise.all(
        Array.from({ length: n }, (_, k) => {
          const requestId = k < dupShare ? dupRequestId : k % 5 === 4 ? "short" : undefined;
          return ctx.send(
            "plan",
            "A",
            stagger(prng, maxStagger),
            ctx.plan(a.accessToken, { body: { sourceShotId }, requestId }),
          );
        }),
      );
      const coldGetUser = (h.fake.counters["gotrue.get_user"] ?? 0) - getUserBefore;
      const all409 = ctx.rows.slice(burstStartIndex).every((r) => r.status === EXPECTED_STATUS);
      ctx.inv(
        "idempotent_409_for_every_duplicate",
        all409,
        `${n} concurrent identical calls → ${
          ctx.rows.slice(burstStartIndex).filter((r) => r.status === EXPECTED_STATUS).length
        }/${n} are 409 ${EXPECTED_CODE}`,
      );
      // Warm path: the bearer is verified & cached now; one more call must not
      // consult GoTrue again (AGENTS.md: "consulted once per user per window").
      const warmBefore = h.fake.counters["gotrue.get_user"] ?? 0;
      const warm = await ctx.send("plan.warm", "A", 0, ctx.plan(a.accessToken));
      const warmGetUser = (h.fake.counters["gotrue.get_user"] ?? 0) - warmBefore;
      ctx.inv(
        "auth_cache_warm_hit",
        warm.status === EXPECTED_STATUS && warmGetUser === 0,
        `post-burst call → ${warm.status}, GoTrue getUser calls: ${warmGetUser}`,
      );
      ctx.observations.coldBurstGetUserCalls = coldGetUser;
      ctx.observations.coldBurstSize = n;
      return { burstStartIndex, wallBoundMs: 3000 + maxStagger + STRESS_LATENCY_MS * 4 };
    }),
});

// ─────────────────────────────────────────────────────────────────────────────
// F2 — two (or more) actors, same sourceShotId, one device logs out mid-burst
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress F2 two_actors: 2–5 users + a second device on the same sourceShotId — each actor's calls 409, a device logout only ever affects that device, no cross-actor 401/5xx, no writes",
  ignore: iterationsFor("two_actors").length === 0,
  fn: () =>
    family("two_actors", async (ctx) => {
      const { prng } = ctx;
      const actors = prng.int(2, 5);
      const tokens: Array<{ actor: string; token: string; device: number }> = [];
      for (let k = 0; k < actors; k++) {
        const name = `U${k}`;
        tokens.push({ actor: name, token: (await ctx.boot(name)).accessToken, device: 1 });
      }
      // a second device for U0 (separate Supabase session, same user)
      tokens.push({ actor: "U0", token: (await ctx.boot("U0")).accessToken, device: 2 });
      const victim = tokens[prng.int(0, tokens.length - 1)];
      const perActor = prng.int(3, 10);
      const maxStagger = prng.int(STRESS_LATENCY_MS, STRESS_LATENCY_MS * 4);
      const logoutAt = prng.int(0, maxStagger);
      const sourceShotId = prng.uuid();
      Object.assign(ctx.inputs, {
        actors,
        devices: tokens.length,
        perActor,
        maxStagger,
        logoutAt,
        victim: `${victim.actor}/d${victim.device}`,
        sourceShotId,
      });
      const burstStartIndex = ctx.rows.length;
      let logoutDoneAt = Infinity;
      let logoutStatus = 0;
      ctx.markBurst();
      await Promise.all([
        ...tokens.flatMap((t) =>
          Array.from({ length: perActor }, () =>
            ctx.send(
              `plan.d${t.device}`,
              t.actor,
              stagger(prng, maxStagger),
              ctx.plan(t.token, { body: { sourceShotId } }),
            ),
          ),
        ),
        (async () => {
          await sleep(logoutAt);
          const row = await ctx.send(
            "logout",
            `${victim.actor}/d${victim.device}`,
            0,
            edgeRequest("POST", "/v1/auth/logout", { token: victim.token, ip: ctx.ip, body: {} }),
            true,
          );
          logoutStatus = row.status;
          logoutDoneAt = row.endedAt;
        })(),
      ]);
      const burst = ctx.rows.slice(burstStartIndex).filter((r) => r.op !== "logout");
      const victimRows = burst.filter(
        (r) => r.actor === victim.actor && r.op === `plan.d${victim.device}`,
      );
      const others = burst.filter((r) => !victimRows.includes(r));
      ctx.inv(
        "other_actors_and_devices_unaffected",
        logoutStatus === 204 && others.every((r) => r.status === EXPECTED_STATUS),
        `logout=${logoutStatus}; ${others.filter((r) => r.status === EXPECTED_STATUS).length}/${others.length} non-victim calls are 409`,
      );
      const victimBad = victimRows.filter((r) => r.status !== EXPECTED_STATUS && r.status !== 401);
      const lateOk = victimRows.filter((r) => r.startedAt > logoutDoneAt && r.status !== 401);
      ctx.inv(
        "victim_device_409_or_401_never_409_after_logout",
        victimBad.length === 0 && lateOk.length === 0,
        `victim ${victimRows.length} calls: ${JSON.stringify(histogram(victimRows.map((r) => r.status)))}; started-after-logout-yet-not-401: ${lateOk.length}`,
      );
      // After the dust settles: victim device refused, every other device fine.
      const probes = await Promise.all(
        tokens.map((t) => ctx.send(`probe.d${t.device}`, t.actor, 0, ctx.plan(t.token))),
      );
      const probeOk = probes.every((p, k) =>
        tokens[k] === victim ? p.status === 401 : p.status === EXPECTED_STATUS,
      );
      ctx.inv(
        "post_burst_probe_isolation",
        probeOk,
        probes.map((p, k) => `${tokens[k].actor}/d${tokens[k].device}→${p.status}`).join(" "),
      );
      return {
        burstStartIndex,
        wallBoundMs: 3000 + maxStagger + STRESS_LATENCY_MS * 6,
      };
    }),
});

// ─────────────────────────────────────────────────────────────────────────────
// F3 — logout lands while the burst is in flight
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress F3 logout_in_burst: logout during an in-flight burst — every call 409 or 401, never 5xx, nothing started after logout is 409, post-logout calls hit the fence without consulting GoTrue",
  ignore: iterationsFor("logout_in_burst").length === 0,
  fn: () =>
    family("logout_in_burst", async (ctx) => {
      const { h, prng } = ctx;
      const a = await ctx.boot("A");
      const n = prng.int(6, 20);
      const maxStagger = prng.int(STRESS_LATENCY_MS, STRESS_LATENCY_MS * 4);
      const logoutAt = prng.int(0, maxStagger);
      const extraLogoutLatency = prng.int(0, STRESS_LATENCY_MS * 2);
      h.fake.overrides.logoutDelayMs = extraLogoutLatency;
      Object.assign(ctx.inputs, { n, maxStagger, logoutAt, extraLogoutLatency });
      const burstStartIndex = ctx.rows.length;
      let logoutDoneAt = Infinity;
      let logoutStatus = 0;
      ctx.markBurst();
      await Promise.all([
        ...Array.from({ length: n }, () =>
          ctx.send("plan", "A", stagger(prng, maxStagger), ctx.plan(a.accessToken)),
        ),
        (async () => {
          await sleep(logoutAt);
          const row = await ctx.send(
            "logout",
            "A",
            0,
            edgeRequest("POST", "/v1/auth/logout", { token: a.accessToken, ip: ctx.ip, body: {} }),
            true,
          );
          logoutStatus = row.status;
          logoutDoneAt = row.endedAt;
        })(),
      ]);
      const plans = ctx.rows.slice(burstStartIndex).filter((r) => r.op === "plan");
      const bad = plans.filter((r) => r.status !== EXPECTED_STATUS && r.status !== 401);
      const late409 = plans.filter(
        (r) => r.startedAt > logoutDoneAt && r.status === EXPECTED_STATUS,
      );
      ctx.inv(
        "409_or_401_only_and_none_409_after_logout",
        logoutStatus === 204 && bad.length === 0 && late409.length === 0,
        `logout=${logoutStatus}; statuses=${JSON.stringify(histogram(plans.map((r) => r.status)))}; started-after-logout-yet-409: ${late409.length}`,
      );
      const getUserBefore = h.fake.counters["gotrue.get_user"] ?? 0;
      const probes = await Promise.all(
        Array.from({ length: 3 }, () =>
          ctx.send("plan.after_logout", "A", 0, ctx.plan(a.accessToken)),
        ),
      );
      const getUserDelta = (h.fake.counters["gotrue.get_user"] ?? 0) - getUserBefore;
      ctx.inv(
        "revocation_fence_no_reverify",
        probes.every((p) => p.status === 401) && getUserDelta === 0,
        `3 concurrent post-logout calls → ${probes.map((p) => p.status).join(",")}; GoTrue getUser calls: ${getUserDelta}`,
      );
      ctx.observations.sessionRevokedUpstream = h.fake.accessIndex.get(a.accessToken)
        ? h.fake.sessions.get(h.fake.accessIndex.get(a.accessToken)!)?.revoked
        : null;
      return {
        burstStartIndex,
        wallBoundMs: 3000 + maxStagger + extraLogoutLatency + STRESS_LATENCY_MS * 6,
      };
    }),
});

// ─────────────────────────────────────────────────────────────────────────────
// F4 — refresh (rotation) lands while the burst is in flight
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress F4 refresh_in_burst: rotation during an in-flight burst — old and new bearers both 409 until exp, a duplicate refresh never turns a plan call into 401/5xx, no writes",
  ignore: iterationsFor("refresh_in_burst").length === 0,
  fn: () =>
    family("refresh_in_burst", async (ctx) => {
      const { prng } = ctx;
      const a = await ctx.boot("A");
      const n = prng.int(6, 24);
      const maxStagger = prng.int(STRESS_LATENCY_MS, STRESS_LATENCY_MS * 4);
      const refreshAt = prng.int(0, maxStagger);
      const duplicateRefresh = prng.next() < 0.5;
      const afterRotation = prng.int(2, 8);
      Object.assign(ctx.inputs, { n, maxStagger, refreshAt, duplicateRefresh, afterRotation });
      const burstStartIndex = ctx.rows.length;
      let newToken: string | null = null;
      const refreshStatuses: number[] = [];
      ctx.markBurst();
      await Promise.all([
        ...Array.from({ length: n }, () =>
          ctx.send("plan.old", "A", stagger(prng, maxStagger), ctx.plan(a.accessToken)),
        ),
        (async () => {
          await sleep(refreshAt);
          const fire = async () => {
            const startedAt = performance.now();
            const response = await ctx.h.handler(
              edgeRequest("POST", "/v1/auth/refresh", {
                ip: ctx.ip,
                body: { refreshToken: a.refreshToken },
              }),
            );
            const body = await readJson(response);
            refreshStatuses.push(response.status);
            const session = isRecord(body.session) ? body.session : null;
            if (response.status === 200 && typeof session?.accessToken === "string") {
              newToken = session.accessToken;
            }
            ctx.rows.push({
              i: -1,
              actor: "A",
              op: "refresh",
              status: response.status,
              code:
                isRecord(body.error) && typeof body.error.code === "string"
                  ? body.error.code
                  : undefined,
              requestId: response.headers.get("x-request-id"),
              sentRequestId: null,
              bodyOk: response.status === 200 || response.status === 401,
              aux: true,
              startedAt,
              endedAt: performance.now(),
            });
          };
          await Promise.all(duplicateRefresh ? [fire(), fire()] : [fire()]);
          if (newToken) {
            await Promise.all(
              Array.from({ length: afterRotation }, () =>
                ctx.send("plan.new", "A", stagger(prng, STRESS_LATENCY_MS), ctx.plan(newToken)),
              ),
            );
          }
        })(),
      ]);
      const plans = ctx.rows.slice(burstStartIndex).filter((r) => r.op.startsWith("plan."));
      const not409 = plans.filter((r) => r.status !== EXPECTED_STATUS);
      const sorted = [...refreshStatuses].sort();
      const refreshOk = duplicateRefresh
        ? sorted.length === 2 && sorted[0] === 200 && sorted[1] === 401
        : sorted.length === 1 && sorted[0] === 200;
      ctx.inv(
        "rotation_never_breaks_in_flight_or_new_bearer",
        not409.length === 0 && newToken !== null,
        `${plans.length} plan calls (old+new bearer) not 409: ${not409.length}; new bearer minted: ${newToken !== null}`,
      );
      ctx.inv(
        "refresh_outcome_contract",
        refreshOk,
        `refresh statuses ${JSON.stringify(refreshStatuses)} (${duplicateRefresh ? "duplicate refresh: exactly one 200 + one 401" : "single refresh: 200"})`,
      );
      return { burstStartIndex, wallBoundMs: 3000 + maxStagger + STRESS_LATENCY_MS * 8 };
    }),
});

// ─────────────────────────────────────────────────────────────────────────────
// F5 — cancel during call
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress F5 cancel_in_call: aborted request signals and never-ending streamed bodies mid-burst — every handler promise settles 409, nothing hangs, no throw, no writes",
  ignore: iterationsFor("cancel_in_call").length === 0,
  fn: () =>
    family("cancel_in_call", async (ctx) => {
      const { prng } = ctx;
      const a = await ctx.boot("A");
      const n = prng.int(6, 24);
      const maxStagger = prng.int(0, STRESS_LATENCY_MS * 3);
      const variants = [
        "normal",
        "abort_before",
        "abort_during",
        "stream_never_ends",
        "stream_aborted",
      ] as const;
      const plan = Array.from({ length: n }, () => variants[prng.int(0, variants.length - 1)]);
      Object.assign(ctx.inputs, { n, maxStagger, variants: histogram(plan) });
      const burstStartIndex = ctx.rows.length;
      const aborters: Array<Promise<void>> = [];
      ctx.markBurst();
      const sends = plan.map((variant) => {
        const delay = stagger(prng, maxStagger);
        const controller = new AbortController();
        const headers = new Headers({
          "x-forwarded-for": ctx.ip,
          Authorization: `Bearer ${a.accessToken}`,
        });
        let body: BodyInit | undefined;
        if (variant === "stream_never_ends" || variant === "stream_aborted") {
          body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"sourceShotId":"'));
              // never closes — a client that stalls mid-body
            },
          });
        } else {
          headers.set("Content-Type", "application/json");
          body = JSON.stringify({ sourceShotId: prng.uuid() });
        }
        if (variant === "abort_before") controller.abort();
        if (variant === "abort_during" || variant === "stream_aborted") {
          const abortAt = delay + prng.int(0, STRESS_LATENCY_MS * 2);
          aborters.push(sleep(abortAt).then(() => controller.abort()));
        }
        const request = new Request(`http://edge.xc.test/functions/v1/api${ROUTE}`, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });
        return ctx.send(`plan.${variant}`, "A", delay, request);
      });
      await Promise.all([...sends, ...aborters]);
      const rows = ctx.rows.slice(burstStartIndex);
      const settled409 = rows.filter((r) => r.status === EXPECTED_STATUS).length;
      ctx.inv(
        "every_cancelled_call_settles_409",
        settled409 === rows.length,
        `${settled409}/${rows.length} settled 409 (${JSON.stringify(histogram(rows.map((r) => `${r.op}:${r.status}`)))})`,
      );
      return { burstStartIndex, wallBoundMs: 3000 + maxStagger + STRESS_LATENCY_MS * 6 };
    }),
});

// ─────────────────────────────────────────────────────────────────────────────
// F6 — clock skew
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress F6 clock_skew: expired / expiring-mid-burst / non-numeric / absent exp bearers in one burst — expired never reaches GoTrue, expiry mid-burst flips 409→401 monotonically, others 409, no 5xx",
  ignore: iterationsFor("clock_skew").length === 0,
  fn: () =>
    family("clock_skew", async (ctx) => {
      const { h, prng } = ctx;
      const a = await ctx.boot("A");
      const nowS = Math.floor(Date.now() / 1000);
      const expired = skewedBearer(h, a.accessToken, nowS - prng.int(1, 86_400));
      const expiringSoon = skewedBearer(h, a.accessToken, nowS + prng.int(6, 50));
      const longLived = skewedBearer(h, a.accessToken, nowS + prng.int(120, 3_600));
      const stringExp = skewedBearer(h, a.accessToken, "soon");
      const noExp = skewedBearer(h, a.accessToken, undefined);
      // expires ~0.5–1.5 s from now; the burst is spread over ~2.5 s around it
      const midExpS = nowS + 1 + (Date.now() % 1000 > 500 ? 1 : 0);
      const midBurst = skewedBearer(h, a.accessToken, midExpS);
      const kinds = [
        { op: "plan.expired", token: expired, expect: 401 },
        { op: "plan.expiring_soon", token: expiringSoon, expect: EXPECTED_STATUS },
        { op: "plan.long_lived", token: longLived, expect: EXPECTED_STATUS },
        { op: "plan.string_exp", token: stringExp, expect: EXPECTED_STATUS },
        { op: "plan.no_exp", token: noExp, expect: EXPECTED_STATUS },
      ];
      const n = prng.int(8, 18);
      const mid = prng.int(4, 8);
      const midSpreadMs = 2_500;
      const program = Array.from({ length: n }, () => kinds[prng.int(0, kinds.length - 1)]);
      Object.assign(ctx.inputs, {
        n,
        mid,
        midExpS,
        midSpreadMs,
        program: histogram(program.map((k) => k.op)),
        expiredCount: program.filter((k) => k.expect === 401).length,
      });
      assert(
        program.filter((k) => k.expect === 401).length + mid < AUTH_FAILURE_BUDGET,
        "harness sizing: 401s must stay under the per-IP auth-failure budget",
      );
      const burstStartIndex = ctx.rows.length;
      const getUserBefore = h.fake.counters["gotrue.get_user"] ?? 0;
      ctx.markBurst();
      const midRows: Array<{ row: Row; wallStart: number }> = [];
      await Promise.all([
        ...program.map((k) =>
          ctx.send(k.op, "A", stagger(prng, STRESS_LATENCY_MS * 3), ctx.plan(k.token)),
        ),
        ...Array.from({ length: mid }, async () => {
          const delay = prng.int(0, midSpreadMs);
          await sleep(delay);
          const wallStart = Date.now();
          const row = await ctx.send("plan.expires_mid_burst", "A", 0, ctx.plan(midBurst));
          midRows.push({ row, wallStart });
        }),
      ]);
      const rows = ctx.rows.slice(burstStartIndex);
      const wrong = rows.filter((r) => {
        const k = kinds.find((x) => x.op === r.op);
        return k ? r.status !== k.expect : false;
      });
      ctx.inv(
        "skewed_bearers_status_contract",
        wrong.length === 0,
        wrong.length === 0
          ? `expired→401, expiring_soon/long_lived/string_exp/no_exp→409 for all ${program.length} calls`
          : wrong.map(ROW_LABEL).join("; "),
      );
      const getUserDelta = (h.fake.counters["gotrue.get_user"] ?? 0) - getUserBefore;
      const nonExpiredCalls = rows.filter((r) => r.op !== "plan.expired").length;
      ctx.inv(
        "expired_bearer_never_reaches_gotrue",
        getUserDelta <= nonExpiredCalls,
        `GoTrue getUser calls ${getUserDelta} ≤ ${nonExpiredCalls} non-expired calls (${program.filter((k) => k.expect === 401).length} expired calls short-circuited)`,
      );
      midRows.sort((x, y) => x.wallStart - y.wallStart);
      const midStatuses = midRows.map((m) => m.row.status);
      const lateNot401 = midRows.filter(
        (m) => m.wallStart >= midExpS * 1000 && m.row.status !== 401,
      );
      const bad = midRows.filter((m) => m.row.status !== 401 && m.row.status !== EXPECTED_STATUS);
      let monotonic = true;
      let seen401 = false;
      for (const s of midStatuses) {
        if (s === 401) seen401 = true;
        else if (seen401) monotonic = false;
      }
      ctx.inv(
        "expiry_mid_burst_flips_409_to_401_monotonically",
        lateNot401.length === 0 && bad.length === 0 && monotonic,
        `exp=${midExpS}s statuses-in-start-order=${JSON.stringify(midStatuses)} started-after-exp-yet-not-401=${lateNot401.length}`,
      );
      ctx.observations.midBurstStatuses = midStatuses;
      return { burstStartIndex, wallBoundMs: 3000 + midSpreadMs + STRESS_LATENCY_MS * 6 };
    }),
});

// ─────────────────────────────────────────────────────────────────────────────
// F7 — per-user budget under a 240+k burst (no lost update / no over-admit)
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress F7 rate_limit: 240+k concurrent calls from one user — exactly the general budget is admitted (409), the rest 429 with Retry-After/RateLimit-Remaining=0, never 5xx",
  ignore: iterationsFor("rate_limit").length === 0,
  fn: () =>
    family("rate_limit", async (ctx) => {
      const { prng } = ctx;
      // Fixed windows are aligned clock minutes: don't let the burst straddle one.
      const untilBoundary = 60_000 - (Date.now() % 60_000);
      if (untilBoundary < 6_000) await sleep(untilBoundary + 50);
      ctx.inputs.waitedForMinuteBoundaryMs = untilBoundary < 6_000 ? untilBoundary + 50 : 0;
      const a = await ctx.boot("A"); // bootstrap spends 1 of the user's 240
      const budgetLeft = GENERAL_USER_LIMIT - 1;
      const over = prng.int(1, 12);
      const n = budgetLeft + over;
      const maxStagger = prng.int(0, STRESS_LATENCY_MS * 2);
      Object.assign(ctx.inputs, { n, budgetLeft, over, maxStagger });
      const burstStartIndex = ctx.rows.length;
      const t0 = performance.now();
      ctx.markBurst();
      const retryAfter: number[] = [];
      const remaining: string[] = [];
      await Promise.all(
        Array.from({ length: n }, async () => {
          const delay = stagger(prng, maxStagger);
          if (delay > 0) await sleep(delay);
          const request = ctx.plan(a.accessToken);
          const response = await ctx.h.handler(request);
          if (response.status === 429) {
            retryAfter.push(Number(response.headers.get("Retry-After")));
            remaining.push(response.headers.get("RateLimit-Remaining") ?? "");
          }
          const body = await readJson(response);
          const err = isRecord(body.error) ? body.error : null;
          ctx.rows.push({
            i: ctx.rows.length,
            actor: "A",
            op: "plan",
            status: response.status,
            code: typeof err?.code === "string" ? err.code : undefined,
            requestId: response.headers.get("x-request-id"),
            sentRequestId: null,
            bodyOk:
              response.status === EXPECTED_STATUS
                ? err?.code === EXPECTED_CODE &&
                  err?.message === EXPECTED_MESSAGE &&
                  response.headers.get("cache-control") === "no-store"
                : response.status === 429
                  ? err?.code === "rate_limited"
                  : false,
            startedAt: performance.now(),
            endedAt: performance.now(),
          });
        }),
      );
      const rows = ctx.rows.slice(burstStartIndex);
      const admitted = rows.filter((r) => r.status === EXPECTED_STATUS).length;
      const limited = rows.filter((r) => r.status === 429).length;
      ctx.inv(
        "exactly_budget_admitted_no_lost_update",
        admitted === budgetLeft && limited === over && admitted + limited === n,
        `admitted=${admitted} (expected ${budgetLeft}) limited=${limited} (expected ${over}) of ${n} in ${Math.round(performance.now() - t0)}ms`,
      );
      ctx.inv(
        "429_headers_contract",
        retryAfter.every((s) => Number.isInteger(s) && s >= 1 && s <= 60) &&
          remaining.every((r) => r === "0"),
        `Retry-After∈[1,60]: ${retryAfter.every((s) => s >= 1 && s <= 60)} RateLimit-Remaining all "0": ${remaining.every((r) => r === "0")} (${limited} × 429)`,
      );
      return { burstStartIndex, wallBoundMs: 6000 + maxStagger + STRESS_LATENCY_MS * 8 };
    }),
});

// ─────────────────────────────────────────────────────────────────────────────
// F8 — seeded random scheduler mixing everything
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress F8 scheduler: seeded random program (two actors, dup ids, GET current, logout, refresh, expired/bad/no bearer, oversize body, aborts) — every call lands in its contract set, nothing 5xx, no writes",
  ignore: iterationsFor("scheduler").length === 0,
  fn: () =>
    family("scheduler", async (ctx) => {
      const { h, prng } = ctx;
      const a = await ctx.boot("A");
      const b = await ctx.boot("B");
      const expiredA = skewedBearer(
        h,
        a.accessToken,
        Math.floor(Date.now() / 1000) - prng.int(1, 3600),
      );
      const m = prng.int(12, 40);
      const maxStagger = prng.int(STRESS_LATENCY_MS, STRESS_LATENCY_MS * 5);
      const withLogout = prng.next() < 0.5;
      const withRefresh = prng.next() < 0.3;
      const logoutAt = prng.int(0, maxStagger);
      const refreshAt = prng.int(0, maxStagger);
      type Action =
        | "plan.A"
        | "plan.A.dupid"
        | "plan.B"
        | "current.A"
        | "plan.A.expired"
        | "plan.bad_bearer"
        | "plan.no_bearer"
        | "plan.oversize"
        | "plan.A.abort";
      const menu: Action[] = [
        "plan.A",
        "plan.A",
        "plan.A.dupid",
        "plan.B",
        "plan.B",
        "current.A",
        "plan.A.expired",
        "plan.bad_bearer",
        "plan.no_bearer",
        "plan.oversize",
        "plan.A.abort",
      ];
      const program: Action[] = [];
      let badAuth = 0;
      let aCalls = 0;
      for (let k = 0; k < m; k++) {
        let action = menu[prng.int(0, menu.length - 1)];
        const isBadAuth =
          action === "plan.A.expired" ||
          action === "plan.bad_bearer" ||
          action === "plan.no_bearer";
        const isA = action.startsWith("plan.A") || action === "current.A";
        // keep the per-IP auth-failure budget (30) out of the picture: ≤6 bad
        // bearers + ≤15 actor-A calls that could turn 401 after a logout
        if ((isBadAuth && badAuth >= 6) || (isA && !isBadAuth && aCalls >= 15)) action = "plan.B";
        if (
          action === "plan.A.expired" ||
          action === "plan.bad_bearer" ||
          action === "plan.no_bearer"
        )
          badAuth++;
        else if (action.startsWith("plan.A") || action === "current.A") aCalls++;
        program.push(action);
      }
      const dupId = `stress-sched-${ctx.seed.toString(16)}`;
      Object.assign(ctx.inputs, {
        m,
        maxStagger,
        withLogout,
        withRefresh,
        logoutAt,
        refreshAt,
        program: histogram(program),
      });
      const burstStartIndex = ctx.rows.length;
      let logoutDoneAt = Infinity;
      let logoutStatus: number | null = null;
      let refreshStatus: number | null = null;
      const aborters: Array<Promise<void>> = [];
      ctx.markBurst();
      const build = (action: Action): Request => {
        switch (action) {
          case "plan.A":
            return ctx.plan(a.accessToken);
          case "plan.A.dupid":
            return ctx.plan(a.accessToken, { requestId: dupId });
          case "plan.B":
            return ctx.plan(b.accessToken);
          case "current.A":
            return edgeRequest("GET", `${ROUTE}/current`, { token: a.accessToken, ip: ctx.ip });
          case "plan.A.expired":
            return ctx.plan(expiredA);
          case "plan.bad_bearer":
            return ctx.plan("not.a.jwt");
          case "plan.no_bearer":
            return ctx.plan(null);
          case "plan.oversize":
            return ctx.plan(a.accessToken, { headers: { "content-length": "5000001" } });
          case "plan.A.abort": {
            const controller = new AbortController();
            const request = new Request(ctx.plan(a.accessToken), { signal: controller.signal });
            aborters.push(sleep(prng.int(0, STRESS_LATENCY_MS)).then(() => controller.abort()));
            return request;
          }
        }
      };
      await Promise.all([
        ...program.map((action) =>
          ctx.send(
            action,
            action.includes(".B") ? "B" : "A",
            stagger(prng, maxStagger),
            build(action),
          ),
        ),
        ...aborters,
        (async () => {
          if (!withLogout) return;
          await sleep(logoutAt);
          const row = await ctx.send(
            "logout.A",
            "A",
            0,
            edgeRequest("POST", "/v1/auth/logout", { token: a.accessToken, ip: ctx.ip, body: {} }),
            true,
          );
          logoutStatus = row.status;
          logoutDoneAt = row.endedAt;
        })(),
        (async () => {
          if (!withRefresh) return;
          await sleep(refreshAt);
          const response = await h.handler(
            edgeRequest("POST", "/v1/auth/refresh", {
              ip: ctx.ip,
              body: { refreshToken: a.refreshToken },
            }),
          );
          await response.body?.cancel();
          refreshStatus = response.status;
        })(),
      ]);
      const rows = ctx.rows.slice(burstStartIndex).filter((r) => r.op !== "logout.A");
      const allowed = (r: Row): number[] => {
        switch (r.op as Action) {
          case "plan.A":
          case "plan.A.dupid":
          case "plan.A.abort":
            return withLogout ? [EXPECTED_STATUS, 401] : [EXPECTED_STATUS];
          case "current.A":
            return withLogout ? [200, 401] : [200];
          case "plan.B":
            return [EXPECTED_STATUS];
          case "plan.A.expired":
          case "plan.bad_bearer":
          case "plan.no_bearer":
            return [401];
          case "plan.oversize":
            return [413];
          default:
            return [];
        }
      };
      const outOfContract = rows.filter((r) => !allowed(r).includes(r.status));
      const after = rows.filter(
        (r) =>
          r.actor === "A" &&
          r.op !== "plan.A.expired" &&
          r.op !== "plan.oversize" &&
          r.startedAt > logoutDoneAt &&
          r.status !== 401,
      );
      ctx.inv(
        "every_call_in_its_contract_set",
        outOfContract.length === 0 && (logoutStatus === null || logoutStatus === 204),
        outOfContract.length === 0
          ? `${rows.length} calls all in contract; logout=${logoutStatus} refresh=${refreshStatus}`
          : outOfContract.map(ROW_LABEL).join("; "),
      );
      ctx.inv(
        "actor_A_never_409_or_200_after_logout",
        after.length === 0,
        `actor A calls started after logout completed yet not 401: ${after.length}`,
      );
      const bRows = rows.filter((r) => r.actor === "B");
      ctx.inv(
        "actor_B_isolated_from_A_lifecycle",
        bRows.every((r) => r.status === EXPECTED_STATUS),
        `${bRows.filter((r) => r.status === EXPECTED_STATUS).length}/${bRows.length} actor-B calls are 409 while A logs out / refreshes / fails auth`,
      );
      ctx.observations.logoutStatus = logoutStatus;
      ctx.observations.refreshStatus = refreshStatus;
      return { burstStartIndex, wallBoundMs: 3000 + maxStagger + STRESS_LATENCY_MS * 8 };
    }),
});

// ─────────────────────────────────────────────────────────────────────────────
// JSON table (seed → outcome)
// ─────────────────────────────────────────────────────────────────────────────

async function writeTable(): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const broken = campaign.filter((r) => r.broken.length > 0);
  const table = {
    unit: "route-post-v1-training-plans",
    lens: "concurrency",
    route: `POST ${ROUTE}`,
    handler: "supabase/functions/api/index.ts (real Deno.serve handler, in-process)",
    knobs: { STRESS_SEED, STRESS_ITER, STRESS_LATENCY_MS, STRESS_REPLAY: STRESS_REPLAY || null },
    generatedAt: new Date().toISOString(),
    denoVersion: Deno.version.deno,
    totals: {
      iterations: campaign.length,
      requests: campaign.reduce((s, r) => s + r.requests, 0),
      invariantsChecked: campaign.reduce((s, r) => s + r.invariants.length, 0),
      invariantsBroken: campaign.reduce((s, r) => s + r.broken.length, 0),
      brokenIterations: broken.length,
      byFamily: histogram(campaign.map((r) => r.family)),
      statusHistogram: campaign.reduce<Record<string, number>>((acc, r) => {
        for (const [k, v] of Object.entries(r.statusHistogram)) acc[k] = (acc[k] ?? 0) + v;
        return acc;
      }, {}),
      upstreamDuringBursts: campaign.reduce<UpstreamTally>(
        (acc, r) => {
          for (const k of Object.keys(acc) as Array<keyof UpstreamTally>)
            acc[k] += r.upstreamDuringBurst[k];
          return acc;
        },
        {
          rest: 0,
          rpc: 0,
          revenuecat: 0,
          gotrueGetUser: 0,
          gotrueLogout: 0,
          gotrueToken: 0,
          other: 0,
        },
      ),
      wallMs: campaign.reduce((s, r) => s + r.durationMs, 0),
      maxIterationMs: Math.max(0, ...campaign.map((r) => r.durationMs)),
      maxHeapUsed: Math.max(0, ...campaign.map((r) => r.heap.after.heapUsed)),
    },
    brokenSeeds: broken.map((r) => ({
      family: r.family,
      iteration: r.iteration,
      seed: r.seed,
      broken: r.broken,
      replay: r.replay,
    })),
    iterations: campaign,
  };
  const path = `${dir}results.json`;
  await Deno.writeTextFile(path, JSON.stringify(table, null, 2));
  return path;
}

Deno.test({
  name: "stress: write seed → outcome table",
  fn: async () => {
    const path = await writeTable();
    const broken = campaign.filter((r) => r.broken.length > 0).length;
    console.log(
      `[stress] table: ${campaign.length} iterations, ${campaign.reduce(
        (s, r) => s + r.requests,
        0,
      )} requests, ${broken} broken → ${path}`,
    );
    assert(campaign.length > 0, "no iterations ran");
  },
});
