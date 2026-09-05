/**
 * stress — POST /v1/sessions/:id/finalize under a SEEDED cooperative scheduler.
 *
 * Drives the REAL edge handler (supabase/functions/api/index.ts, loaded in
 * process through xc_concurrency_harness.ts with its in-memory Supabase
 * Auth / PostgREST / RevenueCat model) and replaces timer-based latency with
 * a deterministic step scheduler: every upstream call a lane makes is parked
 * at a gate and the scheduler releases exactly one parked call per tick,
 * chosen by a seeded PRNG. The interleaving of N concurrent requests is thus
 * a pure function of the seed and replays exactly.
 *
 * Scenarios (each STRESS_ITER seeded iterations; iteration 0 replays with
 * STRESS_SEED, iteration i with the derived seed printed in the artifact):
 *
 *   dup                — 2..8 duplicate finalize calls, one bearer, one row
 *   cancel_retry       — a finalize the client abandoned mid-flight, then the
 *                        retries it sends while the abandoned one still runs
 *   two_actors         — another user's finalize calls race the owner's on
 *                        the same session id
 *   create_finalize    — create + duplicate creates + finalizes for the same
 *                        id all in one burst (call-during-call)
 *   logout_race        — the owner signs out while finalize calls are in
 *                        flight; more finalizes after the sign-out completed
 *   rotation_race      — refresh-token rotation during the burst; old and
 *                        new bearer both finalize
 *   clock_skew         — client clock ahead of the server by 1s..48h
 *   many_sessions      — several rows of one user finalized in one burst
 *   bad_ids            — malformed ids / encodings racing a valid finalize
 *
 * Invariants asserted per iteration (details in the JSON table):
 *   • idempotent: every owner finalize answers 200 (or 401 strictly after a
 *     completed logout), never 5xx
 *   • stamp-once: the row receives exactly ONE ended_at write and its value
 *     never moves (the route's documented contract: "a replay never moves it")
 *   • no lost stamp: a row whose finalize answered 200 has ended_at set
 *   • no duplicate rows, row ownership unchanged, no cross-user write
 *   • bounded wall time per iteration (no deadlock)
 *
 *   STRESS_ITER=80 STRESS_OUT_DIR=/tmp/stress deno test -A --no-check --config deno.json \
 *     stress_sessions_finalize_concurrency.test.ts
 *   STRESS_SEED=<seed> STRESS_ITER=1 deno test -A --no-check --config deno.json \
 *     stress_sessions_finalize_concurrency.test.ts --filter "dup"
 *
 * A failing scenario is a reproduction of a live defect on the tree under
 * test (the artifact lists the seed and the failed invariant), not flake.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { assert, assertEquals } from "@std/assert";
import {
  bootstrap,
  edgeRequest,
  envInt,
  histogram,
  type Invariant,
  isRecord,
  loadXcHarness,
  Prng,
  readJson,
  type XcHarness,
} from "./xc_concurrency_harness.ts";

const STRESS_SEED = envInt("STRESS_SEED", 20260905);
const STRESS_ITER = envInt("STRESS_ITER", 6);
const WALL_BUDGET_MS = envInt("STRESS_WALL_MS", 5_000);
const FILE = "stress_sessions_finalize_concurrency.test.ts";

function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-sessions-finalize/latest/",
    import.meta.url,
  )
    .pathname;
}

/** Iteration i of a campaign seeded with `base`; i=0 is `base` itself so a
 * single iteration replays from the seed printed in the table. */
function iterationSeed(base: number, i: number): number {
  if (i === 0) return base;
  let x = (base ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0 || 1;
}

function replayCommand(scenario: string, seed: number): string {
  return `STRESS_SEED=${seed} STRESS_ITER=1 deno test -A --no-check --config deno.json ${FILE} --filter "${scenario}"`;
}

// ── Cooperative step scheduler ───────────────────────────────────────────────

interface Parked {
  lane: number;
  label: string;
  release: () => void;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Lane identity follows the async continuation of each request, so every
 * upstream call the handler makes is attributed to the client that issued
 * the request regardless of how the microtask queue interleaves them. */
const laneStore = new AsyncLocalStorage<number>();
const currentLane = (): number => laneStore.getStore() ?? 0;

class DeadlockError extends Error {
  constructor(
    public readonly idleTicks: number,
    public readonly steps: number,
  ) {
    super(
      `scheduler made no progress for ${idleTicks} ticks after ${steps} steps`,
    );
    this.name = "DeadlockError";
  }
}

/** Parks every upstream call issued while `armed`, releases one per tick in
 * seeded order. `active` counts lanes started through `lane()`; the driver
 * stops when all of them settled. A run that makes no progress for
 * `idleLimit` ticks while lanes are still active is a deadlock verdict. */
class StepScheduler {
  private parked: Parked[] = [];
  private laneSeq = 0;
  private stepWaiters: Array<{ at: number; resolve: () => void }> = [];
  active = 0;
  armed = false;
  steps: string[] = [];

  constructor(
    private readonly prng: Prng,
    private readonly idleLimit: number,
  ) {}

  /** Called from the fetch interposer: hold this call until scheduled. */
  gate(label: string): Promise<void> {
    if (!this.armed) return Promise.resolve();
    return new Promise<void>((release) => {
      this.parked.push({ lane: currentLane(), label, release });
    });
  }

  /** A "client" issuing one request (or the scenario's orchestrator). */
  lane<T>(fn: (laneId: number) => Promise<T>): Promise<T> {
    const id = ++this.laneSeq;
    this.active += 1;
    return laneStore.run(id, () => fn(id)).finally(() => {
      this.active -= 1;
    });
  }

  /** Resolves once `n` upstream calls have been released. */
  afterSteps(n: number): Promise<void> {
    if (this.steps.length >= n) return Promise.resolve();
    return new Promise<void>((resolve) =>
      this.stepWaiters.push({ at: n, resolve })
    );
  }

  private release(): void {
    const idx = this.prng.int(0, this.parked.length - 1);
    const [p] = this.parked.splice(idx, 1);
    this.steps.push(`L${p.lane}:${p.label}`);
    p.release();
    const n = this.steps.length;
    const due = this.stepWaiters.filter((w) => w.at <= n);
    this.stepWaiters = this.stepWaiters.filter((w) => w.at > n);
    for (const w of due) w.resolve();
  }

  /** Drive until every lane settled; throws DeadlockError when no lane makes
   * progress for `idleLimit` ticks. */
  async run(): Promise<{ maxIdleTicks: number }> {
    let idle = 0;
    let maxIdle = 0;
    while (this.active > 0) {
      await tick();
      if (this.parked.length > 0) {
        this.release();
        idle = 0;
      } else if (this.stepWaiters.length > 0) {
        // nothing left to schedule before the requested step: the lanes the
        // waiter was pacing itself against already finished, let it proceed
        const due = this.stepWaiters;
        this.stepWaiters = [];
        for (const w of due) w.resolve();
        idle = 0;
      } else {
        idle += 1;
        maxIdle = Math.max(maxIdle, idle);
        if (idle > this.idleLimit) {
          throw new DeadlockError(idle, this.steps.length);
        }
      }
    }
    return { maxIdleTicks: maxIdle };
  }

  /** Release everything still parked (after a deadlock verdict) so the
   * abandoned lanes settle instead of pinning their promises forever. */
  drain(): void {
    this.armed = false;
    while (this.parked.length > 0) this.release();
  }
}

// ── Interposer on the fake's fetch dispatcher ────────────────────────────────

interface PatchRecord {
  lane: number;
  step: number;
  table: string;
  filters: string;
  bearerTail: string;
  body: Record<string, unknown>;
}

interface Interposer {
  sched: StepScheduler;
  patches: PatchRecord[];
  upstream: Array<{ lane: number; method: string; url: string }>;
  restore: () => void;
}

/** Wraps `fake.handleFetch` (the only thing globalThis.fetch calls) so every
 * upstream call is gated by the scheduler and every PostgREST PATCH is
 * recorded with its principal, filters and body. Nothing in the harness or
 * the production module is modified — the wrapper is installed per
 * iteration and removed afterwards. */
function interpose(h: XcHarness, sched: StepScheduler): Interposer {
  const fake = h.fake;
  const original = fake.handleFetch;
  const patches: PatchRecord[] = [];
  const upstream: Interposer["upstream"] = [];
  fake.handleFetch = async function (
    request: Request,
    rawBody: string,
  ): Promise<Response> {
    const lane = currentLane();
    const url = new URL(request.url);
    const label = `${request.method} ${
      url.pathname.replace(/^\/(rest|auth)\/v1\//, "$1/")
    }`;
    upstream.push({ lane, method: request.method, url: request.url });
    await sched.gate(label);
    if (request.method === "PATCH" && url.pathname.startsWith("/rest/v1/")) {
      let body: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(rawBody);
        if (isRecord(parsed)) body = parsed;
      } catch {
        body = {};
      }
      const auth = request.headers.get("authorization") ?? "";
      patches.push({
        lane,
        step: sched.steps.length,
        table: url.pathname.slice("/rest/v1/".length),
        filters: url.searchParams.toString(),
        bearerTail: auth.slice(-10),
        body,
      });
    }
    const response = await original.call(fake, request, rawBody);
    // PostgREST returns every column of the row; the in-memory model stores
    // only the keys the INSERT carried, so a fresh session would come back
    // without `ended_at` at all (and `ended_at === null` in the route would
    // never be true). Materialize the column default the way Postgres does.
    if (request.method === "POST" && url.pathname === "/rest/v1/sessions") {
      for (const row of fake.tables.sessions) {
        if (!("ended_at" in row)) row.ended_at = null;
      }
    }
    return response;
  };
  return {
    sched,
    patches,
    upstream,
    restore: () => {
      fake.handleFetch = original;
    },
  };
}

// ── Scenario plumbing ────────────────────────────────────────────────────────

interface Actor {
  sub: string;
  ip: string;
  accessToken: string;
  refreshToken: string;
}

interface Outcome {
  lane: number;
  kind: string;
  status: number;
  code: string | null;
  startedAtStep: number;
  finishedAtStep: number;
}

interface IterationRow {
  scenario: string;
  iteration: number;
  seed: number;
  outcome: "HELD" | "BROKEN";
  failed: string[];
  inputs: Record<string, unknown>;
  statusHistogram: Record<string, number>;
  patches: number;
  distinctEndedAt: number;
  steps: number;
  wallMs: number;
  schedule: string[];
  requests: Outcome[];
  invariants: Invariant[];
  observations: Record<string, unknown>;
  replay: string;
}

const table: IterationRow[] = [];
let tableFlushed = false;

async function flushTable(): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}stress_sessions_finalize_concurrency.json`;
  const summary = {
    file: FILE,
    baseSeed: STRESS_SEED,
    iterationsPerScenario: STRESS_ITER,
    executed: table.length,
    held: table.filter((r) => r.outcome === "HELD").length,
    broken: table.filter((r) => r.outcome === "BROKEN").length,
    brokenSeeds: table
      .filter((r) => r.outcome === "BROKEN")
      .map((r) => ({
        scenario: r.scenario,
        seed: r.seed,
        failed: r.failed,
        replay: r.replay,
      })),
    rows: table,
  };
  await Deno.writeTextFile(path, JSON.stringify(summary, null, 2));
  tableFlushed = true;
  return path;
}

function seededIp(prng: Prng): string {
  return `10.${prng.int(1, 254)}.${prng.int(0, 254)}.${prng.int(1, 254)}`;
}

async function mintActor(h: XcHarness, prng: Prng): Promise<Actor> {
  const sub = prng.uuid();
  const ip = seededIp(prng);
  const b = await bootstrap(h, sub, ip);
  assertEquals(
    b.status,
    200,
    `bootstrap for ${sub} → ${b.status} ${JSON.stringify(b.body)}`,
  );
  return { sub, ip, accessToken: b.accessToken, refreshToken: b.refreshToken };
}

async function createSession(
  h: XcHarness,
  actor: Actor,
  id: string,
  startedAt: string,
): Promise<number> {
  const r = await h.handler(
    edgeRequest("POST", "/v1/sessions", {
      token: actor.accessToken,
      ip: actor.ip,
      body: { id, startedAt },
    }),
  );
  await r.body?.cancel();
  return r.status;
}

interface Ctx {
  h: XcHarness;
  prng: Prng;
  sched: StepScheduler;
  outcomes: Outcome[];
}

function request(
  ctx: Ctx,
  kind: string,
  method: string,
  path: string,
  token: string | null,
  ip: string,
  body?: unknown,
): Promise<Outcome> {
  return ctx.sched.lane(async (lane) => {
    const startedAtStep = ctx.sched.steps.length;
    const res = await ctx.h.handler(
      edgeRequest(method, path, { token, ip, body }),
    );
    const json = await readJson(res);
    // codedError → { error: { code, message } }
    const err = isRecord(json.error) ? json.error : {};
    const out: Outcome = {
      lane,
      kind,
      status: res.status,
      code: typeof err.code === "string" ? err.code : null,
      startedAtStep,
      finishedAtStep: ctx.sched.steps.length,
    };
    ctx.outcomes.push(out);
    return out;
  });
}

function finalize(
  ctx: Ctx,
  kind: string,
  actor: Actor,
  id: string,
  token = actor.accessToken,
) {
  return request(
    ctx,
    kind,
    "POST",
    `/v1/sessions/${id}/finalize`,
    token,
    actor.ip,
  );
}

function sessionRow(
  h: XcHarness,
  id: string,
): Record<string, unknown> | undefined {
  return h.fake.tables.sessions.find((r) => r.id === id);
}

function inv(name: string, holds: boolean, detail: string): Invariant {
  return { name, holds, detail };
}

/** Invariants common to every scenario, evaluated over `owner` outcomes. */
function stampInvariants(
  h: XcHarness,
  ip: Interposer,
  id: string,
  ownerId: string,
  ownerOutcomes: Outcome[],
  opts: { allow401After?: number | null } = {},
): {
  invariants: Invariant[];
  distinctEndedAt: number;
  rowPatches: PatchRecord[];
} {
  const rowPatches = ip.patches.filter(
    (p) => p.table === "sessions" && p.filters.includes(`id=eq.${id}`),
  );
  const values = new Set(rowPatches.map((p) => String(p.body.ended_at)));
  const row = sessionRow(h, id);
  const rows = h.fake.tables.sessions.filter((r) => r.id === id);
  const oks = ownerOutcomes.filter((o) => o.status === 200);
  const bad = ownerOutcomes.filter((o) => {
    if (o.status === 200) return false;
    if (
      o.status === 401 &&
      opts.allow401After !== undefined &&
      opts.allow401After !== null &&
      o.startedAtStep >= opts.allow401After
    ) {
      return false;
    }
    return true;
  });
  const invariants: Invariant[] = [
    inv(
      "idempotent-200",
      bad.length === 0,
      bad.length === 0
        ? `${ownerOutcomes.length} owner finalize(s) → 200${
          opts.allow401After != null
            ? " (or 401 after the completed logout)"
            : ""
        }`
        : `unexpected: ${
          bad.map((o) => `L${o.lane}=${o.status}${o.code ? `/${o.code}` : ""}`)
            .join(",")
        }`,
    ),
    inv(
      "no-5xx",
      ownerOutcomes.every((o) => o.status < 500),
      JSON.stringify(histogram(ownerOutcomes.map((o) => o.status))),
    ),
    inv(
      "no-lost-stamp",
      oks.length === 0 ||
        (row !== undefined && row.ended_at !== null &&
          row.ended_at !== undefined),
      `row.ended_at=${
        row ? String(row.ended_at) : "<no row>"
      } after ${oks.length} × 200`,
    ),
    inv(
      "stamp-once",
      oks.length === 0 ? rowPatches.length === 0 : rowPatches.length === 1,
      `${rowPatches.length} PATCH sessions(ended_at) for the row (contract: exactly one) — steps ${
        rowPatches.map((p) => `L${p.lane}@${p.step}`).join(",")
      }`,
    ),
    inv(
      "ended_at-never-moves",
      values.size <= 1,
      `${values.size} distinct ended_at values written: ${
        [...values].join(" | ")
      }`,
    ),
    inv(
      "no-duplicate-rows",
      rows.length <= 1,
      `${rows.length} rows with id=${id}`,
    ),
    inv(
      "ownership-unchanged",
      row === undefined || row.user_id === ownerId,
      `row.user_id=${row ? String(row.user_id) : "<no row>"}`,
    ),
  ];
  return { invariants, distinctEndedAt: values.size, rowPatches };
}

type ScenarioFn = (ctx: Ctx, ip: Interposer, seed: number) => Promise<{
  inputs: Record<string, unknown>;
  invariants: Invariant[];
  observations: Record<string, unknown>;
  distinctEndedAt: number;
  patches: number;
}>;

async function runScenario(name: string, fn: ScenarioFn): Promise<void> {
  const h = await loadXcHarness();
  const broken: string[] = [];
  for (let i = 0; i < STRESS_ITER; i++) {
    const seed = iterationSeed(STRESS_SEED, i);
    h.fake.reset(seed, 0);
    const prng = new Prng(seed);
    const sched = new StepScheduler(new Prng(seed ^ 0x5bd1e995), 2_000);
    const ip = interpose(h, sched);
    const ctx: Ctx = { h, prng, sched, outcomes: [] };
    const t0 = performance.now();
    let result: Awaited<ReturnType<ScenarioFn>>;
    let deadlock: DeadlockError | null = null;
    try {
      result = await fn(ctx, ip, seed);
    } catch (error) {
      if (!(error instanceof DeadlockError)) {
        ip.restore();
        throw error;
      }
      deadlock = error;
      sched.drain();
      result = {
        inputs: {},
        invariants: [],
        observations: { deadlock: error.message },
        distinctEndedAt: 0,
        patches: 0,
      };
    } finally {
      ip.restore();
    }
    const wallMs = Math.round((performance.now() - t0) * 100) / 100;
    const invariants = [
      ...result.invariants,
      inv(
        "bounded-wall-time",
        deadlock === null && wallMs <= WALL_BUDGET_MS,
        `${wallMs}ms over ${sched.steps.length} scheduled steps (budget ${WALL_BUDGET_MS}ms${
          deadlock ? `, DEADLOCK: ${deadlock.message}` : ""
        })`,
      ),
    ];
    const failed = invariants.filter((x) => !x.holds).map((x) => x.name);
    const row: IterationRow = {
      scenario: name,
      iteration: i,
      seed,
      outcome: failed.length === 0 ? "HELD" : "BROKEN",
      failed,
      inputs: result.inputs,
      statusHistogram: histogram(
        ctx.outcomes.map((o) => `${o.kind}:${o.status}`),
      ),
      patches: result.patches,
      distinctEndedAt: result.distinctEndedAt,
      steps: sched.steps.length,
      wallMs,
      schedule: sched.steps,
      requests: ctx.outcomes,
      invariants,
      observations: result.observations,
      replay: replayCommand(name, seed),
    };
    table.push(row);
    if (failed.length > 0) {
      broken.push(
        `seed=${seed} failed=[${failed.join(",")}] ${
          invariants.filter((x) => !x.holds).map((x) =>
            `${x.name}: ${x.detail}`
          ).join(" ; ")
        } — replay: ${row.replay}`,
      );
    }
  }
  const path = await flushTable();
  assert(
    broken.length === 0,
    `${name}: ${broken.length}/${STRESS_ITER} iterations BROKEN (table: ${path})\n  ${
      broken.join("\n  ")
    }`,
  );
}

/** Run `start` as the orchestrator lane and drive the scheduler until it and
 * every lane it opened have settled. Throws DeadlockError (caught by
 * runScenario → BROKEN iteration) when the burst stops making progress. */
async function drive<T>(
  ctx: Ctx,
  start: () => Promise<T>,
): Promise<{ value: T }> {
  ctx.sched.armed = true;
  const pending = ctx.sched.lane(() => start());
  pending.catch(() => undefined);
  try {
    await ctx.sched.run();
  } finally {
    ctx.sched.armed = false;
  }
  return { value: await pending };
}

const nowIso = () => new Date().toISOString();

// ── Scenarios ────────────────────────────────────────────────────────────────

const dup: ScenarioFn = async (ctx, ip) => {
  const owner = await mintActor(ctx.h, ctx.prng);
  const id = ctx.prng.uuid();
  assertEquals(await createSession(ctx.h, owner, id, nowIso()), 200);
  const n = ctx.prng.int(2, 8);
  const { value: outs } = await drive(
    ctx,
    () =>
      Promise.all(
        Array.from({ length: n }, (_, k) =>
          finalize(ctx, `finalize#${k}`, owner, id)),
      ),
  );
  const s = stampInvariants(ctx.h, ip, id, owner.sub, outs);
  return {
    inputs: { duplicates: n, sessionId: id },
    invariants: s.invariants,
    observations: {
      patchesByLane: s.rowPatches.map((p) => `L${p.lane}@${p.step}`),
    },
    distinctEndedAt: s.distinctEndedAt,
    patches: s.rowPatches.length,
  };
};

const cancelRetry: ScenarioFn = async (ctx, ip) => {
  const owner = await mintActor(ctx.h, ctx.prng);
  const id = ctx.prng.uuid();
  assertEquals(await createSession(ctx.h, owner, id, nowIso()), 200);
  const retries = ctx.prng.int(1, 3);
  const gapSteps = ctx.prng.int(1, 3);
  const { value: outs } = await drive(ctx, async () => {
    // the client aborted this one: nothing awaits it client-side, the server
    // keeps executing it; the retries are issued a few upstream steps later
    const abandoned = finalize(ctx, "abandoned", owner, id);
    await ctx.sched.afterSteps(gapSteps);
    const rest = await Promise.all(
      Array.from(
        { length: retries },
        (_, k) => finalize(ctx, `retry#${k}`, owner, id),
      ),
    );
    return [await abandoned, ...rest];
  });
  const s = stampInvariants(ctx.h, ip, id, owner.sub, outs);
  return {
    inputs: { retries, gapSteps, sessionId: id },
    invariants: s.invariants,
    observations: {
      patchesByLane: s.rowPatches.map((p) => `L${p.lane}@${p.step}`),
    },
    distinctEndedAt: s.distinctEndedAt,
    patches: s.rowPatches.length,
  };
};

const twoActors: ScenarioFn = async (ctx, ip) => {
  const owner = await mintActor(ctx.h, ctx.prng);
  const intruder = await mintActor(ctx.h, ctx.prng);
  const id = ctx.prng.uuid();
  assertEquals(await createSession(ctx.h, owner, id, nowIso()), 200);
  const nOwner = ctx.prng.int(1, 4);
  const nIntruder = ctx.prng.int(1, 4);
  const lanes = ctx.prng.shuffle([
    ...Array.from(
      { length: nOwner },
      (_, k) => () => finalize(ctx, `owner#${k}`, owner, id),
    ),
    ...Array.from(
      { length: nIntruder },
      (_, k) => () => finalize(ctx, `intruder#${k}`, intruder, id),
    ),
  ]);
  const { value: outs } = await drive(
    ctx,
    () => Promise.all(lanes.map((l) => l())),
  );
  const ownerOuts = outs.filter((o) => o.kind.startsWith("owner"));
  const intruderOuts = outs.filter((o) => o.kind.startsWith("intruder"));
  const s = stampInvariants(ctx.h, ip, id, owner.sub, ownerOuts);
  const intruderPatches = s.rowPatches.filter(
    (p) => p.bearerTail === intruder.accessToken.slice(-10),
  );
  const invariants = [
    ...s.invariants,
    inv(
      "intruder-404",
      intruderOuts.every((o) =>
        o.status === 404 && o.code === "session.not_found"
      ),
      intruderOuts.map((o) => `L${o.lane}=${o.status}/${o.code}`).join(","),
    ),
    inv(
      "no-cross-user-write",
      intruderPatches.length === 0,
      `${intruderPatches.length} PATCH issued under the intruder's bearer`,
    ),
  ];
  return {
    inputs: { nOwner, nIntruder, sessionId: id, intruder: intruder.sub },
    invariants,
    observations: {},
    distinctEndedAt: s.distinctEndedAt,
    patches: s.rowPatches.length,
  };
};

const createFinalize: ScenarioFn = async (ctx, ip) => {
  const owner = await mintActor(ctx.h, ctx.prng);
  const id = ctx.prng.uuid();
  const nCreate = ctx.prng.int(1, 3);
  const nFinalize = ctx.prng.int(1, 3);
  const startedAt = nowIso();
  const lanes = ctx.prng.shuffle([
    ...Array.from(
      { length: nCreate },
      (_, k) => () =>
        request(
          ctx,
          `create#${k}`,
          "POST",
          "/v1/sessions",
          owner.accessToken,
          owner.ip,
          {
            id,
            startedAt,
          },
        ),
    ),
    ...Array.from(
      { length: nFinalize },
      (_, k) => () => finalize(ctx, `finalize#${k}`, owner, id),
    ),
  ]);
  const { value: outs } = await drive(
    ctx,
    () => Promise.all(lanes.map((l) => l())),
  );
  const creates = outs.filter((o) => o.kind.startsWith("create"));
  const fins = outs.filter((o) => o.kind.startsWith("finalize"));
  const rows = ctx.h.fake.tables.sessions.filter((r) => r.id === id);
  const row = rows[0];
  const rowPatches = ip.patches.filter(
    (p) => p.table === "sessions" && p.filters.includes(`id=eq.${id}`),
  );
  const values = new Set(rowPatches.map((p) => String(p.body.ended_at)));
  const oks = fins.filter((o) => o.status === 200);
  const invariants: Invariant[] = [
    inv(
      "create-idempotent-200",
      creates.every((o) => o.status === 200),
      creates.map((o) => o.status).join(","),
    ),
    inv(
      "finalize-200-or-404",
      fins.every((o) =>
        o.status === 200 || (o.status === 404 && o.code === "session.not_found")
      ),
      fins.map((o) => `${o.status}/${o.code ?? ""}`).join(","),
    ),
    inv(
      "no-5xx",
      outs.every((o) => o.status < 500),
      JSON.stringify(histogram(outs.map((o) => o.status))),
    ),
    inv(
      "no-duplicate-rows",
      rows.length === 1,
      `${rows.length} rows with id=${id}`,
    ),
    inv(
      "no-lost-stamp",
      oks.length === 0 || (row !== undefined && row.ended_at != null),
      `row.ended_at=${
        row ? String(row.ended_at) : "<no row>"
      } after ${oks.length} × 200`,
    ),
    inv(
      "stamp-once",
      oks.length === 0 ? rowPatches.length === 0 : rowPatches.length === 1,
      `${rowPatches.length} PATCH for ${oks.length} × 200`,
    ),
    inv(
      "ended_at-never-moves",
      values.size <= 1,
      `${values.size} distinct values`,
    ),
    inv(
      "ownership-unchanged",
      row === undefined || row.user_id === owner.sub,
      String(row?.user_id),
    ),
  ];
  return {
    inputs: { nCreate, nFinalize, sessionId: id },
    invariants,
    observations: {
      finalizeStatuses: histogram(fins.map((o) => o.status)),
      finalizeBeforeCreateAll404: fins.length > 0 &&
        fins.every((o) => o.status === 404),
    },
    distinctEndedAt: values.size,
    patches: rowPatches.length,
  };
};

const logoutRace: ScenarioFn = async (ctx, ip) => {
  const owner = await mintActor(ctx.h, ctx.prng);
  const id = ctx.prng.uuid();
  assertEquals(await createSession(ctx.h, owner, id, nowIso()), 200);
  const nBefore = ctx.prng.int(1, 4);
  const nAfter = ctx.prng.int(1, 3);
  let logoutDoneStep = -1;
  const { value } = await drive(ctx, async () => {
    const before = Array.from(
      { length: nBefore },
      (_, k) => finalize(ctx, `during#${k}`, owner, id),
    );
    const logout = request(
      ctx,
      "logout",
      "POST",
      "/v1/auth/logout",
      owner.accessToken,
      owner.ip,
    ).then((o) => {
      logoutDoneStep = ctx.sched.steps.length;
      return o;
    });
    await logout;
    const after = Array.from(
      { length: nAfter },
      (_, k) => finalize(ctx, `after#${k}`, owner, id),
    );
    return {
      logout: await logout,
      before: await Promise.all(before),
      after: await Promise.all(after),
    };
  });
  const s = stampInvariants(ctx.h, ip, id, owner.sub, value.before, {
    allow401After: logoutDoneStep,
  });
  const invariants = [
    ...s.invariants,
    inv(
      "logout-204",
      value.logout.status === 204,
      `logout → ${value.logout.status}`,
    ),
    inv(
      "fence-after-logout-401",
      value.after.every((o) => o.status === 401),
      `after sign-out: ${value.after.map((o) => o.status).join(",")}`,
    ),
    inv(
      "after-logout-no-5xx",
      value.after.every((o) => o.status < 500),
      value.after.map((o) => o.status).join(","),
    ),
  ];
  return {
    inputs: { nBefore, nAfter, sessionId: id },
    invariants,
    observations: {
      duringStatuses: histogram(value.before.map((o) => o.status)),
      logoutDoneStep,
      writesAfterLogoutCompleted:
        s.rowPatches.filter((p) => p.step >= logoutDoneStep).length,
    },
    distinctEndedAt: s.distinctEndedAt,
    patches: s.rowPatches.length,
  };
};

const rotationRace: ScenarioFn = async (ctx, ip) => {
  const owner = await mintActor(ctx.h, ctx.prng);
  const id = ctx.prng.uuid();
  assertEquals(await createSession(ctx.h, owner, id, nowIso()), 200);
  const nOld = ctx.prng.int(1, 3);
  const nNew = ctx.prng.int(1, 3);
  const { value } = await drive(ctx, async () => {
    const old = Array.from(
      { length: nOld },
      (_, k) => finalize(ctx, `oldBearer#${k}`, owner, id),
    );
    const refreshRes = ctx.sched.lane(async () => {
      const res = await ctx.h.handler(
        edgeRequest("POST", "/v1/auth/refresh", {
          token: null,
          ip: owner.ip,
          body: { refreshToken: owner.refreshToken },
        }),
      );
      const json = await readJson(res);
      const session = isRecord(json.session) ? json.session : json;
      return {
        status: res.status,
        accessToken: String(session.accessToken ?? ""),
      };
    });
    const rotated = await refreshRes;
    const newer = rotated.accessToken
      ? Array.from(
        { length: nNew },
        (_, k) =>
          finalize(ctx, `newBearer#${k}`, owner, id, rotated.accessToken),
      )
      : [];
    return {
      rotated,
      old: await Promise.all(old),
      newer: await Promise.all(newer),
    };
  });
  const all = [...value.old, ...value.newer];
  const s = stampInvariants(ctx.h, ip, id, owner.sub, all);
  const invariants = [
    ...s.invariants,
    inv(
      "refresh-200",
      value.rotated.status === 200,
      `refresh → ${value.rotated.status}`,
    ),
  ];
  return {
    inputs: { nOld, nNew, sessionId: id },
    invariants,
    observations: {
      oldBearerStatuses: histogram(value.old.map((o) => o.status)),
    },
    distinctEndedAt: s.distinctEndedAt,
    patches: s.rowPatches.length,
  };
};

const clockSkew: ScenarioFn = async (ctx, ip) => {
  const owner = await mintActor(ctx.h, ctx.prng);
  const id = ctx.prng.uuid();
  const skewMs = ctx.prng.int(1_000, 48 * 3600 * 1_000);
  const startedAt = new Date(Date.now() + skewMs).toISOString();
  assertEquals(await createSession(ctx.h, owner, id, startedAt), 200);
  const n = ctx.prng.int(1, 3);
  const { value: outs } = await drive(
    ctx,
    () =>
      Promise.all(
        Array.from({ length: n }, (_, k) =>
          finalize(ctx, `finalize#${k}`, owner, id)),
      ),
  );
  const s = stampInvariants(ctx.h, ip, id, owner.sub, outs);
  const row = sessionRow(ctx.h, id);
  const endedAt = row ? String(row.ended_at) : "";
  return {
    inputs: { skewMs, startedAt, duplicates: n, sessionId: id },
    invariants: s.invariants,
    observations: {
      endedAt,
      endedBeforeStarted: endedAt !== "" &&
        Date.parse(endedAt) < Date.parse(startedAt),
    },
    distinctEndedAt: s.distinctEndedAt,
    patches: s.rowPatches.length,
  };
};

const manySessions: ScenarioFn = async (ctx, ip) => {
  const owner = await mintActor(ctx.h, ctx.prng);
  const m = ctx.prng.int(2, 5);
  const ids = Array.from({ length: m }, () => ctx.prng.uuid());
  for (const id of ids) {
    assertEquals(await createSession(ctx.h, owner, id, nowIso()), 200);
  }
  const dupsPer = ids.map(() => ctx.prng.int(1, 3));
  const lanes = ctx.prng.shuffle(
    ids.flatMap((id, s) =>
      Array.from(
        { length: dupsPer[s] },
        (_, k) => () => finalize(ctx, `s${s}#${k}`, owner, id),
      )
    ),
  );
  const { value: outs } = await drive(
    ctx,
    () => Promise.all(lanes.map((l) => l())),
  );
  const invariants: Invariant[] = [];
  let distinct = 0;
  let patches = 0;
  ids.forEach((id, s) => {
    const mine = outs.filter((o) => o.kind.startsWith(`s${s}#`));
    const r = stampInvariants(ctx.h, ip, id, owner.sub, mine);
    invariants.push(
      ...r.invariants.map((x) => ({ ...x, name: `s${s}:${x.name}` })),
    );
    distinct = Math.max(distinct, r.distinctEndedAt);
    patches += r.rowPatches.length;
  });
  const total =
    ctx.h.fake.tables.sessions.filter((r) => r.user_id === owner.sub).length;
  invariants.push(
    inv("row-count", total === m, `${total} rows for ${m} sessions`),
  );
  return {
    inputs: { sessions: m, dupsPer },
    invariants,
    observations: {},
    distinctEndedAt: distinct,
    patches,
  };
};

const badIds: ScenarioFn = async (ctx, ip) => {
  const owner = await mintActor(ctx.h, ctx.prng);
  const id = ctx.prng.uuid();
  assertEquals(await createSession(ctx.h, owner, id, nowIso()), 200);
  const junk = [
    "not-a-uuid",
    "%E0%A4%A",
    "%ZZ",
    id.toUpperCase(),
    `${id}%00`,
    "00000000-0000-0000-0000-000000000000",
    ctx.prng.uuid(),
    encodeURIComponent(`${id}/../${id}`),
    "..",
    " ",
  ];
  const picks = Array.from(
    { length: ctx.prng.int(2, 5) },
    () => junk[ctx.prng.int(0, junk.length - 1)],
  );
  const lanes = ctx.prng.shuffle([
    () => finalize(ctx, "valid", owner, id),
    ...picks.map((p, k) => () =>
      request(
        ctx,
        `junk#${k}`,
        "POST",
        `/v1/sessions/${p}/finalize`,
        owner.accessToken,
        owner.ip,
      )
    ),
  ]);
  const { value: outs } = await drive(
    ctx,
    () => Promise.all(lanes.map((l) => l())),
  );
  const valid = outs.filter((o) => o.kind === "valid");
  const junkOuts = outs.filter((o) => o.kind.startsWith("junk"));
  const s = stampInvariants(ctx.h, ip, id, owner.sub, valid);
  const invariants = [
    ...s.invariants,
    inv(
      "junk-400-or-404",
      junkOuts.every((o) =>
        o.status === 400 || o.status === 404 || o.status === 200
      ),
      junkOuts.map((o, k) =>
        `${JSON.stringify(picks[k])}→${o.status}/${o.code ?? ""}`
      ).join(", "),
    ),
    inv(
      "junk-no-5xx",
      junkOuts.every((o) => o.status < 500),
      junkOuts.map((o) => o.status).join(","),
    ),
    inv(
      "junk-200-only-for-own-id",
      junkOuts.every((o, k) =>
        o.status !== 200 || picks[k].toLowerCase() === id
      ),
      "a 200 for anything but the owner's own id (case-folded) would be a write to a foreign row",
    ),
    inv(
      "sessions-patches-only-own-row",
      ip.patches.filter((p) => p.table === "sessions").every((p) =>
        p.filters.includes(`id=eq.${id}`)
      ),
      ip.patches.filter((p) => p.table === "sessions").map((p) => p.filters)
        .join(" ; "),
    ),
  ];
  return {
    inputs: { picks, sessionId: id },
    invariants,
    observations: {
      junkStatuses: junkOuts.map((o, k) => [picks[k], o.status, o.code]),
    },
    distinctEndedAt: s.distinctEndedAt,
    patches: s.rowPatches.length,
  };
};

// ── Tests ────────────────────────────────────────────────────────────────────

const SCENARIOS: Array<[string, ScenarioFn]> = [
  ["dup", dup],
  ["cancel_retry", cancelRetry],
  ["two_actors", twoActors],
  ["create_finalize", createFinalize],
  ["logout_race", logoutRace],
  ["rotation_race", rotationRace],
  ["clock_skew", clockSkew],
  ["many_sessions", manySessions],
  ["bad_ids", badIds],
];

for (const [name, fn] of SCENARIOS) {
  Deno.test({
    name:
      `stress finalize concurrency: ${name} (${STRESS_ITER} seeded interleavings)`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => runScenario(name, fn),
  });
}

Deno.test({
  name: "stress finalize concurrency: table written",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const path = await flushTable();
    assert(tableFlushed, `table not written at ${path}`);
    console.log(`stress table: ${path} (${table.length} iterations)`);
  },
});
