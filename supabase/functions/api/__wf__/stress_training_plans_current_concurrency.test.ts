// Stress harness — CONCURRENCY lens for `GET /v1/training-plans/current`.
//
// The route body is a constant (`{ plan: null }`, index.ts "Training plans:
// honest empty states"), so every concurrency hazard the route can exhibit
// lives in the shared pipeline it is dispatched through: request-id
// resolution, the per-IP and auth-failure pre-auth budgets, authenticate()
// (auth cache + GoTrue verification + session revocation fence) and the
// per-user general budget. This file drives the REAL handler in-process
// (xc_concurrency_harness.ts stubs GoTrue/PostgREST/RevenueCat via fetch and
// captures the Deno.serve handler; Upstash is unset so limits/caches are
// per-isolate memory) with seeded Promise.all bursts and asserts, per
// interleaving:
//
//   idempotency  — every admitted call answers exactly `{"plan":null}` / 200;
//   isolation    — each response carries ITS OWN x-request-id (no cross-talk);
//   no spend     — no PostgREST write and no table growth from the route;
//   revocation   — logout of one device never affects the other; a revoked
//                  bearer is refused from the next request on and never
//                  re-cached (S3b race), GoTrue consulted ≤ 1 time afterwards;
//   rotation     — refresh mid-burst: old bearer keeps working until exp,
//                  new bearer works, no 5xx;
//   clock skew   — an expired `exp` is refused before GoTrue is consulted; a
//                  near-expiry bearer is served but never cached;
//   budgets      — the per-user 240/min budget admits exactly the budget
//                  under a same-user burst (429 + Retry-After for the rest);
//   liveness     — every interleaving completes inside STRESS_WALL_MS, every
//                  abandoned ("cancelled") call still settles, and no
//                  unhandled rejection escapes the handler.
//
// Scale knobs (defaults keep the suite fast; the campaign is run with
// STRESS_ITER large enough for ≥ 500 interleavings):
//   STRESS_SEED       campaign seed (default 20260904)
//   STRESS_ITER       interleavings per scenario (default 4)
//   STRESS_BURST      concurrent calls per interleaving (default 24)
//   STRESS_LATENCY_MS max seeded upstream latency (default 12)
//   STRESS_WALL_MS    per-interleaving wall budget (default 8000)
//   STRESS_REPLAY     "<scenario>:<seed>" — run exactly that interleaving
//   STRESS_OUT_DIR    artifact dir (default artifacts/stress-route-get-v1-training-plans-current/latest/)
//   STRESS_FULL_ROWS  "1" — keep every request row in seeds.json (default:
//                     rows for the first interleaving of a scenario and for
//                     every BROKEN one)
//   STRESS_PROBE_MEMORY_WINDOWS "1" — also run S13 (rateLimit.ts
//                     MEMORY_WINDOW_MAX eviction probe; see its comment)
//   STRESS_FLOOD_IPS  distinct unauthenticated IPs S13 floods (default 10 000)
//
// No Postgres arm: the route performs no query/RPC (S1 asserts zero PostgREST
// traffic for the whole burst), so there is nothing to run against
// docker postgres:16 for this unit.
//
// Every interleaving derives ALL of its randomness (users, lane order, start
// offsets, injected delays, upstream latency) from its own 32-bit seed, so
// `STRESS_REPLAY=<scenario>:<seed>` reproduces it exactly. Results land in
// seeds.json (one row per interleaving: seed → HELD/BROKEN + checks) and
// summary.json.

import { assert } from "@std/assert";
import {
  b64url,
  bootstrap,
  edgeRequest,
  envInt,
  type FakeSession,
  histogram,
  loadXcHarness,
  Prng,
  sleep,
  SUPABASE_URL,
  type XcHarness,
} from "./xc_concurrency_harness.ts";

// ── Knobs ────────────────────────────────────────────────────────────────────

const STRESS_SEED = envInt("STRESS_SEED", 20260904);
const STRESS_ITER = envInt("STRESS_ITER", 4);
const STRESS_BURST = envInt("STRESS_BURST", 24);
const STRESS_LATENCY_MS = envInt("STRESS_LATENCY_MS", 12);
const STRESS_WALL_MS = envInt("STRESS_WALL_MS", 8_000);
const STRESS_FULL_ROWS = Deno.env.get("STRESS_FULL_ROWS") === "1";
const REPLAY = (() => {
  const raw = Deno.env.get("STRESS_REPLAY");
  if (!raw) return null;
  const at = raw.lastIndexOf(":");
  const seed = Number(raw.slice(at + 1));
  if (at <= 0 || !Number.isFinite(seed)) {
    throw new Error(
      `STRESS_REPLAY must be "<scenario>:<seed>", got ${JSON.stringify(raw)}`,
    );
  }
  return { scenario: raw.slice(0, at), seed: seed >>> 0 };
})();

/** Mirrors index.ts GENERAL_USER_LIMIT — the budget this route shares with
 * every other un-specialised authenticated route. If it changes, S9 fails
 * loudly instead of silently measuring the wrong thing. */
const GENERAL_USER_LIMIT = 240;

const ROUTE = "/v1/training-plans/current";
const EXPECTED_BODY = JSON.stringify({ plan: null });
const TEST_FILE = "stress_training_plans_current_concurrency.test.ts";

// ── Deterministic helpers ────────────────────────────────────────────────────

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Iteration seed: campaign seed ⊕ scenario name ⊕ index, mixed so adjacent
 * iterations do not share low bits. */
function iterationSeed(scenario: string, index: number): number {
  let x = (STRESS_SEED ^ fnv1a(scenario) ^ Math.imul(index + 1, 0x9e3779b1)) >>>
    0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

function replayCommand(scenario: string, label: string, seed: number): string {
  return (
    `STRESS_REPLAY=${scenario}:${seed} STRESS_BURST=${STRESS_BURST} ` +
    `STRESS_LATENCY_MS=${STRESS_LATENCY_MS} deno test -A --no-check --config deno.json ` +
    `${TEST_FILE} --filter "${label}"`
  );
}

function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-route-get-v1-training-plans-current/latest/",
    import.meta.url,
  ).pathname;
}

const unhandled: string[] = [];
globalThis.addEventListener("unhandledrejection", (event) => {
  unhandled.push(String((event as PromiseRejectionEvent).reason));
  event.preventDefault();
});

// ── Upstream observation hook (installed once on the shared fake) ────────────

interface UpstreamHook {
  /** Return a Response to short-circuit GoTrue's GET /auth/v1/user, "throw"
   * to simulate a socket failure, or null to let the fake answer. */
  getUser: ((bearer: string, call: number) => Response | "throw" | null) | null;
}
const hook: UpstreamHook = { getUser: null };
/** Bearer of every GoTrue getUser call that reached the fake, in order. */
const getUserBearers: string[] = [];
let hookInstalled = false;

function installHook(h: XcHarness): void {
  if (hookInstalled) return;
  hookInstalled = true;
  const original = h.fake.handleFetch.bind(h.fake);
  let calls = 0;
  h.fake.handleFetch = async (
    request: Request,
    rawBody: string,
  ): Promise<Response> => {
    const url = new URL(request.url);
    if (
      url.origin === SUPABASE_URL &&
      url.pathname === "/auth/v1/user" &&
      request.method === "GET"
    ) {
      const auth = request.headers.get("authorization") ?? "";
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const forced = hook.getUser?.(bearer, calls++) ?? null;
      if (forced === "throw") {
        h.fake.count("gotrue.get_user.socket_failure");
        throw new TypeError("stress: simulated connection reset");
      }
      if (forced) {
        h.fake.count(`gotrue.get_user.forced_${forced.status}`);
        return forced;
      }
      getUserBearers.push(bearer);
    }
    return await original(request, rawBody);
  };
}

// ── Per-interleaving bookkeeping ─────────────────────────────────────────────

interface Check {
  name: string;
  holds: boolean;
  detail: string;
}

interface RequestRow {
  lane: number;
  op: string;
  status: number;
  code?: string;
  /** did the response echo the lane's own x-request-id */
  ownRequestId: boolean;
  startOffsetMs: number;
  startedAt: number;
  endedAt: number;
}

interface IterationRow {
  scenario: string;
  label: string;
  iteration: number;
  seed: number;
  outcome: "HELD" | "BROKEN";
  requests: number;
  statuses: Record<string, number>;
  checks: Check[];
  counters: Record<string, number>;
  observations: Record<string, unknown>;
  durationMs: number;
  replay: string;
  rows?: RequestRow[];
}

const table: IterationRow[] = [];
const scenarioOrder: string[] = [];

class Iteration {
  readonly prng: Prng;
  readonly checks: Check[] = [];
  readonly rows: RequestRow[] = [];
  readonly observations: Record<string, unknown> = {};
  private readonly t0 = performance.now();

  constructor(
    readonly h: XcHarness,
    readonly scenario: string,
    readonly scenarioIndex: number,
    readonly index: number,
    readonly seed: number,
  ) {
    this.prng = new Prng((seed ^ 0x5bd1e995) >>> 0);
  }

  /** Collision-free lane IP: one /24 per (scenario, iteration), one host per
   * lane — budgets never bleed between interleavings (the edge fn's memory
   * windows outlive fake.reset()). 100.64/10 keeps clear of the xc matrix. */
  ip(lane: number): string {
    const o2 = 64 + ((this.scenarioIndex * 4 + ((this.index >> 8) & 3)) & 255);
    return `100.${o2}.${this.index & 255}.${lane & 255}`;
  }

  requestId(lane: number): string {
    return `st.${this.seed.toString(16).padStart(8, "0")}.${lane}`;
  }

  check(name: string, holds: boolean, detail: string): void {
    this.checks.push({ name, holds, detail });
  }

  /** One handler call on `lane`, started after a seeded offset. */
  async call(
    lane: number,
    op: string,
    request: Request,
    startOffsetMs = 0,
  ): Promise<
    { status: number; text: string; response: Response; row: RequestRow }
  > {
    if (startOffsetMs > 0) await sleep(startOffsetMs);
    const startedAt = performance.now() - this.t0;
    const response = await this.h.handler(request);
    const text = await response.text();
    const endedAt = performance.now() - this.t0;
    let code: string | undefined;
    try {
      const parsed = JSON.parse(text) as { error?: { code?: unknown } };
      if (parsed && typeof parsed.error === "object" && parsed.error) {
        code = typeof parsed.error.code === "string"
          ? parsed.error.code
          : undefined;
      }
    } catch {
      // non-JSON body — recorded through `status` only
    }
    const row: RequestRow = {
      lane,
      op,
      status: response.status,
      code,
      ownRequestId: response.headers.get("x-request-id") ===
        request.headers.get("x-request-id"),
      startOffsetMs,
      startedAt: Math.round(startedAt * 100) / 100,
      endedAt: Math.round(endedAt * 100) / 100,
    };
    this.rows.push(row);
    return { status: response.status, text, response, row };
  }

  /** GET /v1/training-plans/current as `token` from `lane`. */
  plan(
    lane: number,
    token: string,
    options: {
      startOffsetMs?: number;
      op?: string;
      requestId?: string;
      signal?: AbortSignal;
    } = {},
  ) {
    const base = edgeRequest("GET", ROUTE, {
      token,
      ip: this.ip(lane),
      headers: { "x-request-id": options.requestId ?? this.requestId(lane) },
    });
    const request = options.signal
      ? new Request(base, { signal: options.signal })
      : base;
    return this.call(
      lane,
      options.op ?? "plan",
      request,
      options.startOffsetMs ?? 0,
    );
  }

  jitter(): number {
    return this.prng.int(0, STRESS_LATENCY_MS * 2);
  }

  /** Assert the exact success contract of the route on a set of rows. */
  expectPlanOk(
    rows: Array<{ status: number; text: string; row: RequestRow }>,
    what: string,
  ) {
    const bad = rows.filter((r) =>
      r.status !== 200 || r.text !== EXPECTED_BODY
    );
    this.check(
      `${what}: every call is 200 with body exactly ${EXPECTED_BODY}`,
      bad.length === 0,
      bad.length === 0
        ? `${rows.length}/${rows.length}`
        : `${bad.length} deviant: ${
          bad
            .slice(0, 5)
            .map((r) => `lane${r.row.lane}=${r.status}:${r.text.slice(0, 60)}`)
            .join("; ")
        }`,
    );
  }
}

async function bootstrapSession(
  it: Iteration,
  sub: string,
  lane: number,
): Promise<{ token: string; refreshToken: string; session: FakeSession }> {
  const boot = await bootstrap(it.h, sub, it.ip(lane));
  if (boot.status !== 200) {
    throw new Error(`bootstrap for ${sub} → ${boot.status}`);
  }
  const session = [...it.h.fake.sessions.values()].find((s) =>
    s.accessToken === boot.accessToken
  );
  if (!session) throw new Error("bootstrap minted no fake session");
  return { token: boot.accessToken, refreshToken: boot.refreshToken, session };
}

/** A Supabase-shaped access token for `session` with a chosen `exp`
 * (seconds) and unique jti, registered with the fake so GoTrue's getUser
 * honours it exactly like a minted one. Models clock skew between the token
 * issuer, the edge, and the device. */
function skewedBearer(
  it: Iteration,
  session: FakeSession,
  exp: number,
  tag: string,
): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: session.userId,
      aud: "authenticated",
      role: "authenticated",
      session_id: session.sessionId,
      exp,
      jti: `skew-${tag}-${it.prng.uuid()}`,
    }),
  );
  const token = `${header}.${payload}.sig`;
  it.h.fake.accessIndex.set(token, session.sessionId);
  return token;
}

function upstreamSince(h: XcHarness, from: number) {
  return h.upstreamCalls.slice(from);
}

function tableSizes(h: XcHarness): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, rows] of Object.entries(h.fake.tables)) {
    out[name] = rows.length;
  }
  return out;
}

// ── Campaign runner ──────────────────────────────────────────────────────────

async function campaign(
  scenario: string,
  label: string,
  body: (it: Iteration) => Promise<void>,
  options: { maxIterations?: number; wallMs?: number } = {},
): Promise<void> {
  const iterations = Math.min(
    STRESS_ITER,
    options.maxIterations ?? STRESS_ITER,
  );
  const wallMs = options.wallMs ?? STRESS_WALL_MS;
  const h = await loadXcHarness();
  installHook(h);
  let scenarioIndex = scenarioOrder.indexOf(scenario);
  if (scenarioIndex < 0) {
    scenarioIndex = scenarioOrder.length;
    scenarioOrder.push(scenario);
  }
  const seeds: number[] = REPLAY
    ? REPLAY.scenario === scenario ? [REPLAY.seed] : []
    : Array.from({ length: iterations }, (_, i) => iterationSeed(scenario, i));
  if (seeds.length === 0) {
    console.log(
      `[stress] ${scenario}: skipped (STRESS_REPLAY targets ${REPLAY?.scenario})`,
    );
    return;
  }
  const broken: number[] = [];
  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i];
    h.fake.reset(seed, STRESS_LATENCY_MS);
    h.upstreamCalls.length = 0;
    getUserBearers.length = 0;
    hook.getUser = null;
    const unhandledBefore = unhandled.length;
    const it = new Iteration(h, scenario, scenarioIndex, i, seed);
    const t0 = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => resolve("deadline"), wallMs);
    });
    try {
      const outcome = await Promise.race([
        body(it).then(() => "done" as const),
        deadline,
      ]);
      it.check(
        `liveness: interleaving completed inside ${wallMs}ms (no deadlock)`,
        outcome === "done",
        outcome === "done"
          ? `${Math.round(performance.now() - t0)}ms`
          : `still running after ${wallMs}ms`,
      );
    } catch (error) {
      it.check(
        "liveness: scenario body completed without throwing",
        false,
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
      );
    } finally {
      clearTimeout(timer);
      hook.getUser = null;
    }
    const durationMs = Math.round(performance.now() - t0);
    const server5xx = it.rows.filter((r) =>
      r.status >= 500 && r.status !== 503
    );
    it.check(
      "no 500/502/504 from the handler (503 only where upstream was made unavailable)",
      server5xx.length === 0,
      server5xx.length === 0
        ? `${it.rows.length} responses`
        : server5xx.map((r) => `lane${r.lane}:${r.op}=${r.status}`).slice(0, 5)
          .join(", "),
    );
    const crossTalk = it.rows.filter((r) => !r.ownRequestId);
    it.check(
      "isolation: every response carries the x-request-id of its own request",
      crossTalk.length === 0,
      crossTalk.length === 0
        ? `${it.rows.length}/${it.rows.length}`
        : `${crossTalk.length} mismatched (lanes ${
          crossTalk
            .slice(0, 5)
            .map((r) => r.lane)
            .join(",")
        })`,
    );
    const newUnhandled = unhandled.slice(unhandledBefore);
    it.check(
      "no unhandled promise rejection escaped the handler",
      newUnhandled.length === 0,
      newUnhandled.length === 0 ? "none" : newUnhandled.slice(0, 3).join(" | "),
    );
    const held = it.checks.every((c) => c.holds);
    if (!held) broken.push(seed);
    const row: IterationRow = {
      scenario,
      label,
      iteration: i,
      seed,
      outcome: held ? "HELD" : "BROKEN",
      requests: it.rows.length,
      statuses: histogram(
        it.rows.map((r) => `${r.op}:${r.status}${r.code ? `:${r.code}` : ""}`),
      ),
      checks: it.checks,
      counters: { ...h.fake.counters },
      observations: it.observations,
      durationMs,
      replay: replayCommand(scenario, label, seed),
    };
    if (STRESS_FULL_ROWS || !held || i === 0) row.rows = it.rows;
    table.push(row);
    if (!held) {
      console.log(`[stress] ${scenario} seed=${seed} BROKEN:`);
      for (const c of it.checks.filter((c) => !c.holds)) {
        console.log(`[stress]   ✗ ${c.name} — ${c.detail}`);
      }
    }
  }
  const mine = table.filter((r) => r.scenario === scenario);
  console.log(
    `[stress] ${scenario}: ${mine.length} interleavings, ${
      mine.filter((r) => r.outcome === "HELD").length
    } HELD, ${broken.length} BROKEN, ${
      mine.reduce((n, r) => n + r.requests, 0)
    } requests, ${mine.reduce((n, r) => n + r.durationMs, 0)}ms`,
  );
  assert(
    broken.length === 0,
    `${scenario}: BROKEN seeds ${broken.join(", ")} — replay: ${
      replayCommand(
        scenario,
        label,
        broken[0],
      )
    }`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// S1 — duplicate calls, warm auth cache
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "stress S1: same bearer, warm cache — a burst of duplicate GETs is idempotent, echoes each request id, consults GoTrue 0 times and PostgREST 0 times",
  async () => {
    await campaign("s1_duplicate_burst_warm", "stress S1", async (it) => {
      const { token } = await bootstrapSession(it, it.prng.uuid(), 250);
      const warm = await it.plan(251, token, { op: "plan.warm" });
      it.check(
        "precondition: warm-up call is 200",
        warm.status === 200,
        `status=${warm.status}`,
      );
      const upstreamMark = it.h.upstreamCalls.length;
      const getUserMark = getUserBearers.length;
      const sizesBefore = tableSizes(it.h);
      const burst = await Promise.all(
        Array.from(
          { length: STRESS_BURST },
          (_, lane) => it.plan(lane, token, { startOffsetMs: it.jitter() }),
        ),
      );
      it.expectPlanOk(burst, "duplicate burst");
      const upstream = upstreamSince(it.h, upstreamMark);
      it.check(
        "no spend: the warm burst makes NO upstream call (no GoTrue, no PostgREST)",
        upstream.length === 0 && getUserBearers.length === getUserMark,
        `upstream=${upstream.length} getUser=${
          getUserBearers.length - getUserMark
        }`,
      );
      it.check(
        "no duplicate rows: no fake table changed size",
        JSON.stringify(tableSizes(it.h)) === JSON.stringify(sizesBefore),
        JSON.stringify(tableSizes(it.h)),
      );
      const contentTypes = new Set(
        burst.map((r) => r.response.headers.get("content-type") ?? "<none>"),
      );
      it.check(
        "every response is application/json with no-store cache policy",
        [...contentTypes].every((ct) => ct.startsWith("application/json")) &&
          burst.every((r) =>
            r.response.headers.get("cache-control") === "no-store"
          ),
        [...contentTypes].join(","),
      );
      it.observations.burst = STRESS_BURST;
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S2 — cold cache herd
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "stress S2: same bearer, COLD cache — a burst of first-ever calls all succeed identically; the cache is populated so the next call consults GoTrue 0 times",
  async () => {
    await campaign("s2_cold_cache_burst", "stress S2", async (it) => {
      const { token } = await bootstrapSession(it, it.prng.uuid(), 250);
      const getUserMark = getUserBearers.length;
      const burst = await Promise.all(
        Array.from(
          { length: STRESS_BURST },
          (_, lane) => it.plan(lane, token, { startOffsetMs: it.jitter() }),
        ),
      );
      it.expectPlanOk(burst, "cold burst");
      const herd = getUserBearers.slice(getUserMark).filter((b) =>
        b === token
      ).length;
      it.check(
        "GoTrue consulted at least once and never more than once per call during the cold burst",
        herd >= 1 && herd <= STRESS_BURST,
        `getUser=${herd} for ${STRESS_BURST} concurrent cold calls`,
      );
      const after = await it.plan(STRESS_BURST, token, { op: "plan.after" });
      const afterHerd =
        getUserBearers.slice(getUserMark).filter((b) => b === token).length -
        herd;
      it.check(
        "after the burst the bearer is cached: the next call is 200 with 0 GoTrue calls",
        after.status === 200 && after.text === EXPECTED_BODY && afterHerd === 0,
        `status=${after.status} getUser=${afterHerd}`,
      );
      const postgrest = it.h.upstreamCalls.filter((c) =>
        c.url.includes("/rest/v1/")
      );
      // bootstrap itself upserts the profile — only calls AFTER it count.
      it.observations.coldHerdGetUserCalls = herd;
      it.observations.postgrestCallsWholeIteration = postgrest.length;
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S3 — identical request ids
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "stress S3: duplicate delivery with the SAME x-request-id — every copy is answered 200 (no dedup drops a call), malformed ids are replaced by a UUID",
  async () => {
    await campaign("s3_same_request_id", "stress S3", async (it) => {
      const { token } = await bootstrapSession(it, it.prng.uuid(), 250);
      await it.plan(251, token, { op: "plan.warm" });
      const shared = `dup.${it.seed.toString(16)}.copy`;
      const malformed = [
        "x",
        "short",
        "has space in it",
        "ünïcödé-id-12345",
        "a".repeat(65),
      ];
      const lanes = Array.from({ length: STRESS_BURST }, (_, lane) => lane);
      const burst = await Promise.all(
        lanes.map((lane) => {
          const bad = lane % 4 === 3;
          const rid = bad ? malformed[lane % malformed.length] : shared;
          return it.plan(lane, token, {
            requestId: rid,
            op: bad ? "plan.badrid" : "plan.duprid",
            startOffsetMs: it.jitter(),
          });
        }),
      );
      it.expectPlanOk(burst, "same-request-id burst");
      const dup = burst.filter((r) => r.row.op === "plan.duprid");
      it.check(
        "every duplicate copy echoes the shared id (idempotent replay, none dropped)",
        dup.length === lanes.filter((l) => l % 4 !== 3).length &&
          dup.every((r) => r.response.headers.get("x-request-id") === shared),
        `${dup.length} copies, ids=${
          [...new Set(dup.map((r) => r.response.headers.get("x-request-id")))]
            .join(",")
        }`,
      );
      const bad = burst.filter((r) => r.row.op === "plan.badrid");
      const uuidRe =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      it.check(
        "a malformed client x-request-id is never echoed; a UUID is minted instead",
        bad.every((r) =>
          uuidRe.test(r.response.headers.get("x-request-id") ?? "")
        ),
        bad.map((r) => r.response.headers.get("x-request-id")).slice(0, 3).join(
          ",",
        ),
      );
      // Rows for malformed ids legitimately do not echo the request's id.
      for (const r of bad) r.row.ownRequestId = true;
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S4 — two devices, one user; one logs out mid-burst
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "stress S4: two devices of ONE user interleaved — device A logs out mid-burst; device B is never affected (scope=local), A is 200|401 during and 401 after",
  async () => {
    await campaign("s4_two_devices_logout", "stress S4", async (it) => {
      const B = Math.min(STRESS_BURST, 100);
      const sub = it.prng.uuid();
      const devA = await bootstrapSession(it, sub, 250);
      const devB = await bootstrapSession(it, sub, 251);
      it.check(
        "precondition: two distinct sessions for the same user",
        devA.session.sessionId !== devB.session.sessionId &&
          devA.session.userId === devB.session.userId,
        `${devA.session.sessionId} / ${devB.session.sessionId}`,
      );
      await it.plan(252, devA.token, { op: "plan.warmA" });
      await it.plan(253, devB.token, { op: "plan.warmB" });
      const logoutAt = it.prng.int(0, STRESS_LATENCY_MS * 2);
      const logoutDone = { at: -1 };
      const lanes = it.prng.shuffle(Array.from({ length: 2 * B }, (_, i) => i));
      const tasks: Array<Promise<unknown>> = lanes.map((lane) => {
        const fromA = lane % 2 === 0;
        return it.plan(lane, fromA ? devA.token : devB.token, {
          op: fromA ? "plan.A" : "plan.B",
          startOffsetMs: it.jitter(),
        });
      });
      tasks.push(
        (async () => {
          await sleep(logoutAt);
          const r = await it.call(
            2 * B,
            "logout.A",
            edgeRequest("POST", "/v1/auth/logout", {
              token: devA.token,
              ip: it.ip(2 * B),
              headers: { "x-request-id": it.requestId(2 * B) },
            }),
          );
          logoutDone.at = r.row.endedAt;
          return r;
        })(),
      );
      await Promise.all(tasks);
      const rowsA = it.rows.filter((r) => r.op === "plan.A");
      const rowsB = it.rows.filter((r) => r.op === "plan.B");
      const logout = it.rows.find((r) => r.op === "logout.A");
      it.check(
        "logout of device A is 204 and revokes only A upstream",
        logout?.status === 204 && devA.session.revoked && !devB.session.revoked,
        `logout=${logout?.status} A.revoked=${devA.session.revoked} B.revoked=${devB.session.revoked}`,
      );
      it.check(
        "device B: every call during the burst is 200 (A's logout never touches B)",
        rowsB.length === B && rowsB.every((r) => r.status === 200),
        JSON.stringify(histogram(rowsB.map((r) => r.status))),
      );
      it.check(
        "device A: every call is 200 or 401 during the burst — never 5xx",
        rowsA.length === B &&
          rowsA.every((r) => r.status === 200 || r.status === 401),
        JSON.stringify(histogram(rowsA.map((r) => r.status))),
      );
      const lateA = rowsA.filter((r) => r.startedAt > logoutDone.at);
      it.check(
        "device A: every call STARTED after the logout completed is 401",
        lateA.every((r) => r.status === 401),
        `${lateA.length} late calls: ${
          JSON.stringify(histogram(lateA.map((r) => r.status)))
        }`,
      );
      const getUserMark = getUserBearers.length;
      const afterA1 = await it.plan(2 * B + 1, devA.token, {
        op: "plan.A.after",
      });
      const afterA2 = await it.plan(2 * B + 2, devA.token, {
        op: "plan.A.after",
      });
      const afterB = await it.plan(2 * B + 3, devB.token, {
        op: "plan.B.after",
      });
      const getUserA = getUserBearers.slice(getUserMark).filter((b) =>
        b === devA.token
      ).length;
      const getUserB = getUserBearers.slice(getUserMark).filter((b) =>
        b === devB.token
      ).length;
      it.check(
        "after logout: A is 401 twice with GoTrue consulted ≤ 1 time (fence hit); B is still 200 from cache (0 GoTrue calls)",
        afterA1.status === 401 &&
          afterA2.status === 401 &&
          getUserA <= 1 &&
          afterB.status === 200 &&
          afterB.text === EXPECTED_BODY &&
          getUserB === 0,
        `A=${afterA1.status},${afterA2.status} getUserA=${getUserA} B=${afterB.status} getUserB=${getUserB}`,
      );
      it.observations.logoutAtMs = logoutAt;
      it.observations.logoutDoneAt = logoutDone.at;
      it.observations.aRefusedDuringBurst = rowsA.filter((r) =>
        r.status === 401
      ).length;
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S5 — logout while a same-device burst is in flight (monotonic refusal)
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "stress S5: logout during a same-bearer burst — every call is 200|401, refusal is monotonic after the logout lands, the bearer is dead from the next request on",
  async () => {
    await campaign("s5_logout_during_burst", "stress S5", async (it) => {
      const { token, session } = await bootstrapSession(
        it,
        it.prng.uuid(),
        250,
      );
      const warm = it.prng.int(0, 1) === 1;
      if (warm) await it.plan(251, token, { op: "plan.warm" });
      const logoutAt = it.prng.int(0, STRESS_LATENCY_MS * 2);
      const logoutDone = { at: -1 };
      const tasks: Array<Promise<unknown>> = Array.from({
        length: STRESS_BURST,
      }, (_, lane) => it.plan(lane, token, { startOffsetMs: it.jitter() }));
      tasks.push(
        (async () => {
          await sleep(logoutAt);
          const r = await it.call(
            STRESS_BURST,
            "logout",
            edgeRequest("POST", "/v1/auth/logout", {
              token,
              ip: it.ip(STRESS_BURST),
              headers: { "x-request-id": it.requestId(STRESS_BURST) },
            }),
          );
          logoutDone.at = r.row.endedAt;
          return r;
        })(),
      );
      await Promise.all(tasks);
      const plans = it.rows.filter((r) => r.op === "plan");
      it.check(
        "logout is 204 and the session is revoked upstream",
        it.rows.find((r) => r.op === "logout")?.status === 204 &&
          session.revoked,
        `revoked=${session.revoked}`,
      );
      it.check(
        "every in-flight call is 200 or 401 — never 5xx",
        plans.every((r) => r.status === 200 || r.status === 401),
        JSON.stringify(histogram(plans.map((r) => r.status))),
      );
      const late = plans.filter((r) => r.startedAt > logoutDone.at);
      it.check(
        "every call started after the logout completed is 401",
        late.every((r) => r.status === 401),
        `${late.length} late: ${
          JSON.stringify(histogram(late.map((r) => r.status)))
        }`,
      );
      const getUserMark = getUserBearers.length;
      const a1 = await it.plan(STRESS_BURST + 1, token, { op: "plan.after" });
      const a2 = await it.plan(STRESS_BURST + 2, token, { op: "plan.after" });
      const getUserAfter = getUserBearers.slice(getUserMark).filter((b) =>
        b === token
      ).length;
      it.check(
        "post-logout: 401 twice, GoTrue consulted ≤ 1 time, no re-cache",
        a1.status === 401 && a2.status === 401 && getUserAfter <= 1,
        `after=${a1.status},${a2.status} getUser=${getUserAfter}`,
      );
      it.observations.warm = warm;
      it.observations.logoutAtMs = logoutAt;
      it.observations.refusedDuringBurst =
        plans.filter((r) => r.status === 401).length;
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S6 — cache-resurrection race: slow verification vs logout
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "stress S6: a slow GoTrue verification of the bearer overlaps its own logout — the late verdict is never re-cached; the bearer is refused from the next request on",
  async () => {
    await campaign("s6_logout_cache_resurrection", "stress S6", async (it) => {
      const { token, session } = await bootstrapSession(
        it,
        it.prng.uuid(),
        250,
      );
      const slowMs = 50 + it.prng.int(0, 60);
      let slowed = 0;
      it.h.fake.overrides.getUserDelayMs = (bearer) =>
        bearer === token && slowed++ === 0 ? slowMs : 0;
      const inflightCount = Math.max(1, Math.min(STRESS_BURST, 8));
      const tasks: Array<Promise<unknown>> = Array.from(
        { length: inflightCount },
        (_, lane) =>
          it.plan(lane, token, {
            op: "plan.inflight",
            startOffsetMs: it.prng.int(0, 5),
          }),
      );
      tasks.push(
        (async () => {
          await sleep(10 + it.prng.int(0, 10));
          return it.call(
            inflightCount,
            "logout",
            edgeRequest("POST", "/v1/auth/logout", {
              token,
              ip: it.ip(inflightCount),
              headers: { "x-request-id": it.requestId(inflightCount) },
            }),
          );
        })(),
      );
      await Promise.all(tasks);
      it.h.fake.overrides.getUserDelayMs = undefined;
      const inflight = it.rows.filter((r) => r.op === "plan.inflight");
      it.check(
        "precondition: logout 204, session revoked, in-flight calls 200|401",
        it.rows.find((r) => r.op === "logout")?.status === 204 &&
          session.revoked &&
          inflight.every((r) => r.status === 200 || r.status === 401),
        JSON.stringify(histogram(inflight.map((r) => r.status))),
      );
      const getUserMark = getUserBearers.length;
      const a1 = await it.plan(inflightCount + 1, token, { op: "plan.after" });
      const a2 = await it.plan(inflightCount + 2, token, { op: "plan.after" });
      const getUserAfter = getUserBearers.slice(getUserMark).filter((b) =>
        b === token
      ).length;
      it.check(
        "revoked bearer is refused on the next request AND the one after (never re-cached), GoTrue ≤ 1",
        a1.status === 401 && a2.status === 401 && getUserAfter <= 1,
        `after=${a1.status},${a2.status} getUser=${getUserAfter}`,
      );
      it.observations.slowMs = slowMs;
      it.observations.inflightRefused =
        inflight.filter((r) => r.status === 401).length;
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S7 — refresh (rotation) during a burst
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "stress S7: refresh rotates the session mid-burst — old bearer keeps working until exp, new bearer works, same session, no 5xx",
  async () => {
    await campaign("s7_refresh_during_burst", "stress S7", async (it) => {
      const { token, refreshToken, session } = await bootstrapSession(
        it,
        it.prng.uuid(),
        250,
      );
      if (it.prng.int(0, 1) === 1) {
        await it.plan(251, token, { op: "plan.warm" });
      }
      const refreshAt = it.prng.int(0, STRESS_LATENCY_MS * 2);
      const half = Math.max(1, Math.floor(STRESS_BURST / 2));
      const rotated: {
        session: { accessToken: string; refreshToken: string } | null;
      } = {
        session: null,
      };
      const oldBurst = Array.from(
        { length: half },
        (_, lane) =>
          it.plan(lane, token, { op: "plan.old", startOffsetMs: it.jitter() }),
      );
      const refresh = (async () => {
        await sleep(refreshAt);
        const r = await it.call(
          half,
          "refresh",
          edgeRequest("POST", "/v1/auth/refresh", {
            ip: it.ip(half),
            body: { refreshToken },
            headers: { "x-request-id": it.requestId(half) },
          }),
        );
        try {
          const body = JSON.parse(r.text) as {
            session?: { accessToken: string; refreshToken: string };
          };
          rotated.session = body.session ?? null;
        } catch {
          rotated.session = null;
        }
        return r;
      })();
      await Promise.all([...oldBurst, refresh]);
      const old = await Promise.all(oldBurst);
      it.expectPlanOk(old, "old bearer during rotation");
      const fresh = rotated.session;
      it.check(
        "refresh is 200 and mints a new pair on the SAME session",
        fresh !== null &&
          fresh.accessToken !== token &&
          it.h.fake.accessIndex.get(fresh.accessToken) === session.sessionId,
        fresh
          ? `newToken≠old=${fresh.accessToken !== token}`
          : "no session in refresh body",
      );
      if (fresh) {
        const newToken = fresh.accessToken;
        const mixed = await Promise.all(
          Array.from(
            { length: STRESS_BURST },
            (_, i) =>
              it.plan(half + 1 + i, i % 2 === 0 ? token : newToken, {
                op: i % 2 === 0 ? "plan.old.post" : "plan.new",
                startOffsetMs: it.jitter(),
              }),
          ),
        );
        it.expectPlanOk(mixed, "old and new bearer interleaved after rotation");
      }
      it.observations.refreshAtMs = refreshAt;
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S8 — clock skew
// ─────────────────────────────────────────────────────────────────────────────

type Skew = "expired" | "boundary" | "near" | "normal" | "far";

Deno.test(
  "stress S8: clock skew — expired/boundary bearers are refused BEFORE GoTrue; near-expiry bearers are served but never cached; normal/far bearers are cached exactly once",
  async () => {
    await campaign("s8_clock_skew", "stress S8", async (it) => {
      const { session } = await bootstrapSession(it, it.prng.uuid(), 250);
      const nowS = Math.floor(Date.now() / 1000);
      const kinds: Skew[] = ["expired", "boundary", "near", "normal", "far"];
      const lanes = Array.from({ length: STRESS_BURST }, (_, lane) => {
        const kind = kinds[it.prng.int(0, kinds.length - 1)];
        const exp = kind === "expired"
          ? nowS - 1 - it.prng.int(0, 86_400)
          : kind === "boundary"
          ? nowS
          : kind === "near"
          ? nowS + 4
          : kind === "normal"
          ? nowS + 3_600
          : nowS + 10 * 365 * 86_400;
        return {
          lane,
          kind,
          exp,
          token: skewedBearer(it, session, exp, `${kind}${lane}`),
        };
      });
      const pass = (tag: string) =>
        Promise.all(
          lanes.map((l) =>
            it.plan(l.lane, l.token, {
              op: `plan.${tag}.${l.kind}`,
              startOffsetMs: it.jitter(),
            })
          ),
        );
      const verdictOk = (
        l: (typeof lanes)[number],
        status: number,
        text: string,
      ) => {
        if (l.kind === "expired" || l.kind === "boundary") {
          return status === 401 &&
            text.includes("The session token has expired.");
        }
        if (status === 200 && text === EXPECTED_BODY) return true;
        // a near-expiry bearer may legitimately cross its exp during the pass
        return l.kind === "near" && status === 401 &&
          l.exp * 1000 <= Date.now();
      };
      const first = await pass("p1");
      const bad1 = first.filter((r, i) =>
        !verdictOk(lanes[i], r.status, r.text)
      );
      it.check(
        "pass 1: every lane gets the verdict its exp predicts (401 expired / 200 plan:null)",
        bad1.length === 0,
        bad1.length === 0
          ? JSON.stringify(
            histogram(first.map((r, i) => `${lanes[i].kind}:${r.status}`)),
          )
          : bad1.map((r) =>
            `lane${r.row.lane}=${r.status}:${r.text.slice(0, 50)}`
          ).join("; "),
      );
      const perBearer = (from: number) => {
        const counts = new Map<string, number>();
        for (const b of getUserBearers.slice(from)) {
          counts.set(b, (counts.get(b) ?? 0) + 1);
        }
        return counts;
      };
      const c1 = perBearer(0);
      const deadConsulted = lanes.filter(
        (l) =>
          (l.kind === "expired" || l.kind === "boundary") &&
          (c1.get(l.token) ?? 0) > 0,
      );
      it.check(
        "expired/boundary bearers never reach GoTrue",
        deadConsulted.length === 0,
        `${deadConsulted.length} dead bearers consulted`,
      );
      const liveOnce = lanes.filter(
        (l) =>
          l.kind !== "expired" && l.kind !== "boundary" &&
          (c1.get(l.token) ?? 0) !== 1,
      );
      it.check(
        "pass 1: every live bearer (distinct token) is verified exactly once",
        liveOnce.length === 0,
        `${liveOnce.length} live bearers with ≠1 getUser`,
      );
      const mark = getUserBearers.length;
      const second = await pass("p2");
      const bad2 = second.filter((r, i) =>
        !verdictOk(lanes[i], r.status, r.text)
      );
      it.check(
        "pass 2: verdicts unchanged (a near-expiry bearer may have crossed its exp → 401 expired)",
        bad2.length === 0,
        bad2.length === 0
          ? JSON.stringify(
            histogram(second.map((r, i) => `${lanes[i].kind}:${r.status}`)),
          )
          : bad2.map((r) =>
            `lane${r.row.lane}=${r.status}:${r.text.slice(0, 50)}`
          ).join("; "),
      );
      const c2 = perBearer(mark);
      const cachedReverified = lanes.filter(
        (l) =>
          (l.kind === "normal" || l.kind === "far") &&
          (c2.get(l.token) ?? 0) !== 0,
      );
      it.check(
        "pass 2: normal/far bearers are served from cache (0 GoTrue calls); a cache TTL is never longer than the bearer",
        cachedReverified.length === 0,
        `${cachedReverified.length} cached bearers re-verified`,
      );
      const nearServed = second.filter(
        (r, i) => lanes[i].kind === "near" && r.status === 200,
      );
      const nearNotReverified = lanes.filter(
        (l, i) =>
          l.kind === "near" && second[i].status === 200 &&
          (c2.get(l.token) ?? 0) !== 1,
      );
      it.check(
        "pass 2: a near-expiry bearer served 200 was re-verified (never cached inside the 5s guard)",
        nearNotReverified.length === 0,
        `${nearServed.length} near bearers served, ${nearNotReverified.length} without a fresh getUser`,
      );
      it.observations.kinds = histogram(lanes.map((l) => l.kind));
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S9 — per-user budget exactness
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "stress S9: the per-user general budget admits EXACTLY 240/min under a same-user burst — the rest are 429 with Retry-After, no upstream call for either",
  async () => {
    await campaign("s9_user_budget_exactness", "stress S9", async (it) => {
      // Never start inside the last 1.5s of a minute: the burst must not
      // straddle the fixed window or exactness is not assessable.
      const untilBoundary = 60_000 - (Date.now() % 60_000);
      if (untilBoundary < 1_500) await sleep(untilBoundary + 5);
      const bucket0 = Math.floor(Date.now() / 60_000);
      const { token } = await bootstrapSession(it, it.prng.uuid(), 250); // spends 1
      await it.plan(251, token, { op: "plan.warm" }); // spends 1
      const spentBefore = 2;
      const over = 20 + it.prng.int(0, 40);
      const total = GENERAL_USER_LIMIT - spentBefore + over;
      const upstreamMark = it.h.upstreamCalls.length;
      const burst = await Promise.all(
        Array.from(
          { length: total },
          (_, lane) =>
            it.plan(lane, token, { startOffsetMs: it.prng.int(0, 4) }),
        ),
      );
      const bucket1 = Math.floor(Date.now() / 60_000);
      const ok = burst.filter((r) => r.status === 200);
      const limited = burst.filter((r) => r.status === 429);
      it.check(
        "precondition: burst stayed inside one fixed window",
        bucket0 === bucket1,
        `bucket ${bucket0}→${bucket1}`,
      );
      it.check(
        `exactly ${
          GENERAL_USER_LIMIT - spentBefore
        } of ${total} admitted (200) and ${over} refused (429), nothing else`,
        ok.length === GENERAL_USER_LIMIT - spentBefore &&
          limited.length === over &&
          ok.length + limited.length === total,
        `200=${ok.length} 429=${limited.length} other=${
          total - ok.length - limited.length
        }`,
      );
      it.expectPlanOk(ok, "admitted calls");
      it.check(
        "every 429 carries Retry-After ≥ 1, RateLimit-Remaining 0 and the generic rate_limited body",
        limited.every(
          (r) =>
            Number(r.response.headers.get("retry-after")) >= 1 &&
            r.response.headers.get("ratelimit-remaining") === "0" &&
            r.row.code === "rate_limited",
        ),
        limited.length
          ? `retry-after=${limited[0].response.headers.get("retry-after")}`
          : "no 429s",
      );
      it.check(
        "no spend: neither admitted nor refused calls made any upstream call (warm cache)",
        upstreamSince(it.h, upstreamMark).length === 0,
        `upstream=${upstreamSince(it.h, upstreamMark).length}`,
      );
      it.observations.total = total;
      it.observations.over = over;
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S10 — cancel during call
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "stress S10: callers abandon (abort) a seeded subset of in-flight calls — every abandoned call still settles, the rest are 200, state is intact afterwards",
  async () => {
    await campaign("s10_cancel_during_call", "stress S10", async (it) => {
      const { token } = await bootstrapSession(it, it.prng.uuid(), 250);
      const cold = it.prng.int(0, 1) === 1;
      if (!cold) await it.plan(251, token, { op: "plan.warm" });
      const controllers: AbortController[] = [];
      const abandoned: Array<Promise<{ status: number; text: string }>> = [];
      const kept: Array<
        Promise<{ status: number; text: string; row: RequestRow }>
      > = [];
      for (let lane = 0; lane < STRESS_BURST; lane++) {
        const cancel = it.prng.int(0, 2) === 0;
        if (cancel) {
          const controller = new AbortController();
          controllers.push(controller);
          const cancelAfter = it.prng.int(0, STRESS_LATENCY_MS);
          const p = it.plan(lane, token, {
            op: "plan.cancelled",
            startOffsetMs: it.jitter(),
            signal: controller.signal,
          });
          abandoned.push(
            (async () => {
              await sleep(cancelAfter);
              controller.abort(
                new DOMException("client went away", "AbortError"),
              );
              return p;
            })(),
          );
        } else {
          kept.push(it.plan(lane, token, { startOffsetMs: it.jitter() }));
        }
      }
      const keptResults = await Promise.all(kept);
      it.expectPlanOk(keptResults, "non-cancelled calls");
      const settled = await Promise.allSettled(abandoned);
      const rejected = settled.filter((s) => s.status === "rejected");
      it.check(
        "every abandoned call settles (the handler never hangs on a gone client) and answers 200 or 401 — never a thrown error",
        settled.length === controllers.length &&
          rejected.length === 0 &&
          settled.every(
            (s) =>
              s.status === "fulfilled" &&
              (s.value.status === 200 || s.value.status === 401),
          ),
        `${settled.length} abandoned, ${rejected.length} rejected: ${
          rejected
            .slice(0, 2)
            .map((r) => String((r as PromiseRejectedResult).reason))
            .join(" | ")
        }`,
      );
      const after = await Promise.all([
        it.plan(STRESS_BURST + 1, token, { op: "plan.after" }),
        it.plan(STRESS_BURST + 2, token, { op: "plan.after" }),
      ]);
      it.expectPlanOk(after, "calls after the cancellations");
      it.observations.cold = cold;
      it.observations.cancelled = controllers.length;
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S11 — many actors, call-during-call across sibling routes
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "stress S11: six users (warm and cold) interleaved with the sibling POST /v1/training-plans and GET /v1/me/access — plan is always 200 plan:null, POST always 409, no table grows, no cross-user request-id",
  async () => {
    await campaign("s11_mixed_actors", "stress S11", async (it) => {
      const users = await Promise.all(
        Array.from(
          { length: 6 },
          (_, i) => bootstrapSession(it, it.prng.uuid(), 240 + i),
        ),
      );
      for (const [i, u] of users.entries()) {
        if (i % 2 === 0) await it.plan(246 + i, u.token, { op: "plan.warm" });
      }
      const sizesBefore = tableSizes(it.h);
      const upstreamMark = it.h.upstreamCalls.length;
      const B = Math.min(STRESS_BURST * 2, 120);
      const burst = await Promise.all(
        Array.from({ length: B }, (_, lane) => {
          const u = users[it.prng.int(0, users.length - 1)];
          const roll = it.prng.int(0, 9);
          const offset = it.jitter();
          if (roll < 7) {
            return it.plan(lane, u.token, { startOffsetMs: offset });
          }
          if (roll < 9) {
            return it.call(
              lane,
              "plan.post",
              edgeRequest("POST", "/v1/training-plans", {
                token: u.token,
                ip: it.ip(lane),
                body: { focus: "dink" },
                headers: { "x-request-id": it.requestId(lane) },
              }),
              offset,
            );
          }
          return it.call(
            lane,
            "me.access",
            edgeRequest("GET", "/v1/me/access", {
              token: u.token,
              ip: it.ip(lane),
              headers: { "x-request-id": it.requestId(lane) },
            }),
            offset,
          );
        }),
      );
      const plans = burst.filter((r) => r.row.op === "plan");
      it.expectPlanOk(plans, "GET plan across six users");
      const posts = burst.filter((r) => r.row.op === "plan.post");
      it.check(
        "POST /v1/training-plans is always 409 training.plan_unavailable (no plan row is ever created)",
        posts.every((r) =>
          r.status === 409 && r.row.code === "training.plan_unavailable"
        ),
        JSON.stringify(
          histogram(posts.map((r) => `${r.status}:${r.row.code ?? ""}`)),
        ),
      );
      const access = burst.filter((r) => r.row.op === "me.access");
      it.check(
        "GET /v1/me/access interleaved with the plan calls is always 200",
        access.every((r) => r.status === 200),
        JSON.stringify(histogram(access.map((r) => r.status))),
      );
      it.check(
        "no fake table changed size across the mixed burst",
        JSON.stringify(tableSizes(it.h)) === JSON.stringify(sizesBefore),
        JSON.stringify(tableSizes(it.h)),
      );
      const writes = upstreamSince(it.h, upstreamMark).filter(
        (c) =>
          c.url.includes("/rest/v1/") &&
          c.method !== "GET" &&
          !c.url.includes("/rest/v1/rpc/access_state"),
      );
      it.check(
        "no PostgREST write of any kind during the burst (access_state RPC is the only POST, read-only by contract)",
        writes.length === 0,
        writes.length
          ? writes.map((w) => `${w.method} ${w.url}`).slice(0, 3).join("; ")
          : "none",
      );
      it.observations.ops = histogram(burst.map((r) => r.row.op));
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S12 — GoTrue unavailable during a cold burst
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "stress S12: GoTrue answers 502/429/500 or drops the socket during a cold burst — affected calls are 503 with Retry-After (never 401/500), the bearer is not poisoned",
  async () => {
    await campaign("s12_gotrue_unavailable_cold", "stress S12", async (it) => {
      const { token } = await bootstrapSession(it, it.prng.uuid(), 250);
      const failures = it.prng.int(
        1,
        Math.max(1, Math.floor(STRESS_BURST / 2)),
      );
      const modes = ["502", "429", "500", "socket-once"] as const;
      const mode = modes[it.prng.int(0, modes.length - 1)];
      let forced = 0;
      let socketDropped = false;
      hook.getUser = (bearer) => {
        if (bearer !== token) return null;
        if (mode === "socket-once") {
          if (socketDropped) return null;
          socketDropped = true;
          return "throw";
        }
        if (forced >= failures) return null;
        forced += 1;
        if (mode === "429") {
          return new Response(
            JSON.stringify({ code: 429, msg: "over_request_rate_limit" }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "7",
              },
            },
          );
        }
        return new Response(JSON.stringify({ msg: "upstream unhappy" }), {
          status: Number(mode),
          headers: { "Content-Type": "application/json" },
        });
      };
      const burst = await Promise.all(
        Array.from(
          { length: STRESS_BURST },
          (_, lane) => it.plan(lane, token, { startOffsetMs: it.jitter() }),
        ),
      );
      hook.getUser = null;
      const unavailable = burst.filter((r) => r.status === 503);
      const okCalls = burst.filter((r) => r.status === 200);
      it.check(
        "every call is 200 or 503 — an upstream outage is never reported as 401 (sign-out) or 500",
        burst.every((r) => r.status === 200 || r.status === 503),
        JSON.stringify(histogram(burst.map((r) => r.status))),
      );
      if (mode === "socket-once") {
        it.check(
          "a single dropped socket is ridden out by the in-deadline retry: every call is 200 (never 401, never 503)",
          socketDropped && burst.every((r) => r.status === 200),
          `dropped=${socketDropped} ${
            JSON.stringify(histogram(burst.map((r) => r.status)))
          }`,
        );
      } else {
        it.check(
          `exactly the calls that met a forced ${mode} are 503 (one 503 per forced GoTrue answer, no more, no fewer)`,
          forced >= 1 && unavailable.length === forced &&
            unavailable.length + okCalls.length === STRESS_BURST,
          `forced=${forced} 503=${unavailable.length} 200=${okCalls.length}`,
        );
        it.check(
          "every 503 carries Retry-After (echoing GoTrue's when it named one) and a generic body",
          unavailable.every((r) => {
            const ra = Number(r.response.headers.get("retry-after"));
            const generic = !r.text.includes("upstream unhappy") &&
              !r.text.includes("over_request");
            return ra >= 1 && (mode !== "429" || ra === 7) && generic;
          }),
          unavailable.length
            ? `retry-after=${
              unavailable[0].response.headers.get("retry-after")
            } body=${unavailable[0].text.slice(0, 80)}`
            : "no 503s",
        );
      }
      it.expectPlanOk(okCalls, "calls that reached a healthy GoTrue");
      const after = await Promise.all([
        it.plan(STRESS_BURST + 1, token, { op: "plan.after" }),
        it.plan(STRESS_BURST + 2, token, { op: "plan.after" }),
      ]);
      it.expectPlanOk(after, "bearer not poisoned: calls after the outage");
      it.observations.mode = mode;
      it.observations.forcedFailures = forced;
      it.observations.socketDropped = socketDropped;
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S13 — probe: in-memory rate-limit window eviction under many distinct keys
// ─────────────────────────────────────────────────────────────────────────────
//
// Surfaced by S9 inside a 576-interleaving campaign (seed 3646771124 admitted
// 240 instead of 238 — its own bootstrap+warm spend had vanished). Root cause
// (rateLimit.ts memoryIncr): once the per-isolate `windows` map holds
// MEMORY_WINDOW_MAX (20 000) live entries and none has expired, the next NEW
// key triggers `windows.clear()`, resetting EVERY live counter — including
// the one of the client currently being throttled. This probe reproduces
// that deterministically without Upstash: 10 000 unauthenticated requests
// from 10 000 distinct IPs create 20 000 live keys (ip + authfail per IP),
// after which the target user's spend is gone and it is admitted a full
// second budget inside the same clock minute. It is opt-in
// (STRESS_PROBE_MEMORY_WINDOWS=1) because it is a reproduction of an open
// finding, not an invariant that currently holds; drop the gate with the fix.
// Control arm: STRESS_ITER=1 STRESS_FLOOD_IPS=5000 (10 000 live keys, below
// the cap) must HOLD. Live keys accumulate across interleavings in one
// process (they expire after 60 s), so a second 5 000-IP iteration crosses
// the cap and BREAKS as well — that is the same defect, not a flake.

const PROBE_MEMORY_WINDOWS =
  Deno.env.get("STRESS_PROBE_MEMORY_WINDOWS") === "1";

Deno.test({
  name:
    "stress S13 (probe, STRESS_PROBE_MEMORY_WINDOWS=1): 10 000 distinct-IP unauthenticated requests must NOT reset an unrelated user's per-minute budget",
  ignore: !PROBE_MEMORY_WINDOWS,
  fn: async () => {
    await campaign(
      "s13_memory_window_eviction",
      "stress S13",
      async (it) => {
        const untilBoundary = 60_000 - (Date.now() % 60_000);
        if (untilBoundary < 6_000) await sleep(untilBoundary + 5);
        const bucket0 = Math.floor(Date.now() / 60_000);
        const { token } = await bootstrapSession(it, it.prng.uuid(), 250); // spends 1
        const preSpend = 4 + it.prng.int(0, 8);
        const pre = await Promise.all(
          Array.from(
            { length: preSpend },
            (_, i) => it.plan(i, token, { op: "plan.pre" }),
          ),
        );
        it.expectPlanOk(pre, "pre-flood spend");
        const spent = 1 + preSpend;

        // Flood: distinct IPs, no bearer → 401 → keys rl:ip:* and rl:authfail:*.
        // STRESS_FLOOD_IPS=5000 is the control arm: 10 000 live keys stay
        // under MEMORY_WINDOW_MAX and the budget must then be exact.
        const floodIps = envInt("STRESS_FLOOD_IPS", 10_000) +
          it.prng.int(0, 250);
        const o2 = 100 + it.index;
        const flood: Record<string, number> = {};
        for (let start = 0; start < floodIps; start += 500) {
          const chunk = await Promise.all(
            Array.from(
              { length: Math.min(500, floodIps - start) },
              async (_, k) => {
                const n = start + k;
                const ip = `100.${o2}.${(n >> 8) & 255}.${n & 255}`;
                const response = await it.h.handler(
                  edgeRequest("GET", ROUTE, {
                    ip,
                    headers: { "x-request-id": `flood.${it.seed}.${n}` },
                  }),
                );
                await response.text();
                return response.status;
              },
            ),
          );
          for (const s of chunk) flood[s] = (flood[s] ?? 0) + 1;
        }
        it.check(
          "flood: every unauthenticated request is 401 (never 5xx, never 200)",
          Object.keys(flood).length === 1 && flood["401"] === floodIps,
          JSON.stringify(flood),
        );

        const over = 5;
        const remaining = GENERAL_USER_LIMIT - spent;
        const burst = await Promise.all(
          Array.from(
            { length: remaining + over },
            (_, lane) =>
              it.plan(lane, token, { startOffsetMs: it.prng.int(0, 4) }),
          ),
        );
        const bucket1 = Math.floor(Date.now() / 60_000);
        const ok = burst.filter((r) => r.status === 200).length;
        const limited = burst.filter((r) => r.status === 429).length;
        it.check(
          "precondition: pre-spend, flood and burst stayed inside one clock minute",
          bucket0 === bucket1,
          `bucket ${bucket0}→${bucket1}`,
        );
        it.check(
          `no lost budget: the user already spent ${spent} this minute, so exactly ${remaining} of ${
            remaining + over
          } are admitted and ${over} are 429`,
          ok === remaining && limited === over,
          `200=${ok} 429=${limited} (admitted this minute = ${
            spent + ok
          }; budget = ${GENERAL_USER_LIMIT})`,
        );
        it.observations.floodIps = floodIps;
        it.observations.spentBeforeFlood = spent;
        it.observations.admittedThisMinute = spent + ok;
      },
      { maxIterations: 2, wallMs: 60_000 },
    );
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Artifacts
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("stress: write seeds.json + summary.json", async () => {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}seeds.json`, JSON.stringify(table, null, 2));
  const perScenario: Record<
    string,
    { interleavings: number; held: number; broken: number[]; requests: number }
  > = {};
  for (const row of table) {
    const s = (perScenario[row.scenario] ??= {
      interleavings: 0,
      held: 0,
      broken: [],
      requests: 0,
    });
    s.interleavings += 1;
    s.requests += row.requests;
    if (row.outcome === "HELD") s.held += 1;
    else s.broken.push(row.seed);
  }
  const summary = {
    unit: "route-get-v1-training-plans-current",
    lens: "concurrency",
    route: `GET ${ROUTE}`,
    campaign: {
      seed: STRESS_SEED,
      iterPerScenario: STRESS_ITER,
      burst: STRESS_BURST,
      latencyMs: STRESS_LATENCY_MS,
      wallMs: STRESS_WALL_MS,
      replay: REPLAY,
    },
    interleavings: table.length,
    requests: table.reduce((n, r) => n + r.requests, 0),
    held: table.filter((r) => r.outcome === "HELD").length,
    broken: table.filter((r) => r.outcome === "BROKEN").map((r) => ({
      scenario: r.scenario,
      seed: r.seed,
      replay: r.replay,
      failed: r.checks.filter((c) => !c.holds),
    })),
    perScenario,
    coldHerd: table
      .filter((r) => r.scenario === "s2_cold_cache_burst")
      .map((r) => ({
        seed: r.seed,
        getUser: r.observations.coldHerdGetUserCalls,
      })),
    heap: Deno.memoryUsage(),
    generatedAt: new Date().toISOString(),
  };
  await Deno.writeTextFile(
    `${dir}summary.json`,
    JSON.stringify(summary, null, 2),
  );
  console.log(
    `[stress] ${summary.interleavings} interleavings, ${summary.requests} requests, ${summary.held} HELD, ${summary.broken.length} BROKEN → ${dir}`,
  );
  assert(table.length > 0, "no interleaving ran");
});
