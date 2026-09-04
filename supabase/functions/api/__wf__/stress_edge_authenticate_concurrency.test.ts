// stress-edge-authenticate-concurrency — seeded Promise.all bursts against the
// REAL edge handler (../index.ts) over the stateful fake in
// xc_concurrency_harness.ts, focused on the authentication unit:
// authenticate() (session-bearer + transitional provider-token branches),
// logout / refresh landing DURING a burst, cancel-during-call, two actors on
// one user row, clock skew at the bearer `exp` boundary, the per-IP
// auth-failure budget under concurrency, and request-id propagation.
//
// Every scenario runs STRESS_ITER seeded ITERATIONS. One iteration = one
// interleaving: a fresh fake state (fake.reset(seed)), fresh users, a seeded
// scheduler (per-lane start jitter + seeded upstream latency), one Promise.all
// burst of STRESS_BURST lanes, then the invariants. Each iteration's seed is
// derived from STRESS_SEED, the scenario name and the iteration index, and is
// replayable ALONE with the `replay` command recorded in results.json:
//
//   STRESS_REPLAY_SEED=<seed> STRESS_BURST=<n> STRESS_LATENCY_MS=<ms> \
//     deno test -A --no-check --config deno.json \
//     stress_edge_authenticate_concurrency.test.ts --filter "<scenario>"
//
// Scale (env): STRESS_ITER=6 iterations per scenario (small: this file lives
// in `deno task test`), STRESS_BURST=16 lanes per burst, STRESS_LATENCY_MS=6
// max seeded upstream latency, STRESS_JITTER_MS=8 max seeded lane start
// offset, STRESS_SEED=20260904, STRESS_ITER_BUDGET_MS=8000 (an iteration that
// does not settle inside the budget is a deadlock/hang → BROKEN),
// STRESS_OUT_DIR (default artifacts/stress-edge-authenticate-concurrency/latest/).
// A campaign: STRESS_ITER=64 → 8 scenarios × 64 = 512 interleavings.
//
// Every scenario asserts the CONTRACT (AGENTS.md "Auth sessions" / "Scale &
// security", the comments on authenticate(), logoutRoute(),
// fenceRevokedSession(), resolveRequestId()). Contract points the tree under
// test is KNOWN not to meet are recorded as `advisories` (holds=false is a
// reproduction with seed + counts, not a suite failure) so the file can live
// in the suite while the coordinator decides; everything in `invariants` is
// asserted.

import { assert } from "@std/assert";
import { captureAccessLog } from "../http.ts";
import {
  b64url,
  bootstrap,
  edgeRequest,
  envInt,
  fakeGoogleIdToken,
  histogram,
  type Invariant,
  isRecord,
  jwtPayload,
  loadXcHarness,
  Prng,
  readJson,
  sleep,
  SUPABASE_URL,
  type XcHarness,
} from "./xc_concurrency_harness.ts";

// ── Scale ────────────────────────────────────────────────────────────────────

const STRESS_SEED = envInt("STRESS_SEED", 20260904);
const STRESS_ITER = envInt("STRESS_ITER", 6);
const STRESS_BURST = envInt("STRESS_BURST", 16);
const STRESS_LATENCY_MS = envInt("STRESS_LATENCY_MS", 6);
const STRESS_JITTER_MS = envInt("STRESS_JITTER_MS", 8);
const STRESS_ITER_BUDGET_MS = envInt("STRESS_ITER_BUDGET_MS", 8_000);
const REPLAY_SEED = (() => {
  const raw = Deno.env.get("STRESS_REPLAY_SEED");
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) >>> 0 : null;
})();

// Contract constants mirrored from ../index.ts (asserted there by name).
const AUTH_FAILURE_LIMIT = 30;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

// ── Seeds, IPs, output ───────────────────────────────────────────────────────

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Iteration seed: replayable alone (STRESS_REPLAY_SEED) or derived. */
function iterationSeed(scenario: string, iter: number): number {
  if (REPLAY_SEED !== null) return REPLAY_SEED;
  let x = (STRESS_SEED ^ fnv1a(scenario) ^ Math.imul(iter + 1, 0x9e3779b1)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

// Scenario order is fixed so a --filter replay sees the same /16 as the
// full run; the edge fn's in-memory rate-limit windows outlive fake.reset(),
// so every (scenario, iteration) gets its own /24 and every lane its own IP.
const SCENARIOS = [
  "stress_A_mixed_bearer_burst",
  "stress_B_logout_during_burst",
  "stress_C_refresh_rotation_during_burst",
  "stress_D_two_actors_one_user_permits",
  "stress_E_request_ids_under_burst",
  "stress_F_clock_skew_exp_boundary",
  "stress_G_authfail_budget_under_burst",
  "stress_H_cancel_during_call",
] as const;
type ScenarioName = (typeof SCENARIOS)[number];

function laneIp(scenario: ScenarioName, iter: number, lane: number): string {
  const s = SCENARIOS.indexOf(scenario);
  return `10.${(s * 4 + ((iter >> 8) & 3)) & 255}.${iter & 255}.${lane & 255}`;
}

function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-edge-authenticate-concurrency/latest/",
    import.meta.url,
  ).pathname;
}

function replayCommand(scenario: ScenarioName, seed: number): string {
  return `STRESS_REPLAY_SEED=${seed} STRESS_BURST=${STRESS_BURST} STRESS_LATENCY_MS=${STRESS_LATENCY_MS} STRESS_JITTER_MS=${STRESS_JITTER_MS} deno test -A --no-check --config deno.json stress_edge_authenticate_concurrency.test.ts --filter "${scenario}"`;
}

// ── Rows / iteration bookkeeping ─────────────────────────────────────────────

interface Lane {
  lane: number;
  op: string;
  status: number;
  code?: string;
  requestId: string | null;
  startedAt: number;
  endedAt: number;
  note?: string;
}

interface IterationResult {
  scenario: ScenarioName;
  iter: number;
  seed: number;
  outcome: "HELD" | "BROKEN";
  durationMs: number;
  lanes: number;
  statusHistogram: Record<string, number>;
  counters: Record<string, number>;
  invariants: Invariant[];
  advisories: Invariant[];
  observations: Record<string, unknown>;
  replay: string;
}

interface IterationContext {
  h: XcHarness;
  prng: Prng;
  seed: number;
  iter: number;
  scenario: ScenarioName;
  lanes: Lane[];
  invariants: Invariant[];
  advisories: Invariant[];
  observations: Record<string, unknown>;
  accessLog: Array<Record<string, unknown>>;
  ip: (lane: number) => string;
  /** Seeded scheduler: start a lane after a seeded offset. */
  jitter: () => Promise<void>;
}

const results: IterationResult[] = [];
const accessLog: Array<Record<string, unknown>> = [];
let restoreAccessLog: (() => void) | null = null;

function inv(list: Invariant[], name: string, holds: boolean, detail: string): void {
  list.push({ name, holds, detail });
}

const codeOf = (body: Record<string, unknown>): string | undefined => {
  const err = body.error;
  const nested = isRecord(err) ? err.code : undefined;
  return typeof nested === "string"
    ? nested
    : typeof body.code === "string"
      ? body.code
      : undefined;
};

async function lane(
  ctx: IterationContext,
  index: number,
  op: string,
  fn: () => Promise<Response>,
): Promise<{ status: number; body: Record<string, unknown>; row: Lane; headers: Headers }> {
  await ctx.jitter();
  const startedAt = performance.now();
  const response = await fn();
  const body = await readJson(response);
  const row: Lane = {
    lane: index,
    op,
    status: response.status,
    code: codeOf(body),
    requestId: response.headers.get("x-request-id"),
    startedAt: Math.round(startedAt * 100) / 100,
    endedAt: Math.round(performance.now() * 100) / 100,
  };
  ctx.lanes.push(row);
  return { status: response.status, body, row, headers: response.headers };
}

const no5xx = (lanes: Lane[]) => lanes.filter((l) => l.status >= 500).length;

/** A burst that must settle inside the iteration budget (deadlock detector). */
async function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`stress: ${label} did not settle within ${STRESS_ITER_BUDGET_MS}ms`)),
      STRESS_ITER_BUDGET_MS,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runScenario(
  scenario: ScenarioName,
  body: (ctx: IterationContext) => Promise<void>,
): Promise<IterationResult[]> {
  const h = await loadXcHarness();
  if (!restoreAccessLog) {
    restoreAccessLog = captureAccessLog((line) => {
      try {
        accessLog.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        accessLog.push({ _raw: line });
      }
    });
  }
  const iterations = REPLAY_SEED !== null ? 1 : STRESS_ITER;
  const out: IterationResult[] = [];
  for (let iter = 0; iter < iterations; iter++) {
    const seed = iterationSeed(scenario, iter);
    h.fake.reset(seed, STRESS_LATENCY_MS);
    h.upstreamCalls.length = 0;
    accessLog.length = 0;
    const prng = new Prng(seed);
    const ctx: IterationContext = {
      h,
      prng,
      seed,
      iter,
      scenario,
      lanes: [],
      invariants: [],
      advisories: [],
      observations: {},
      accessLog,
      ip: (lane) => laneIp(scenario, iter, lane),
      jitter: () =>
        STRESS_JITTER_MS > 0 ? sleep(prng.int(0, STRESS_JITTER_MS)) : Promise.resolve(),
    };
    const t0 = performance.now();
    let hang: string | null = null;
    try {
      await bounded(body(ctx), `${scenario}#${iter} seed=${seed}`);
    } catch (error) {
      hang = error instanceof Error ? error.message : String(error);
    }
    const durationMs = Math.round(performance.now() - t0);
    inv(
      ctx.invariants,
      `bounded wall time (no deadlock): iteration settled within ${STRESS_ITER_BUDGET_MS}ms`,
      hang === null,
      hang ?? `${durationMs}ms`,
    );
    inv(ctx.invariants, "no 5xx", no5xx(ctx.lanes) === 0, `${no5xx(ctx.lanes)} 5xx`);
    const result: IterationResult = {
      scenario,
      iter,
      seed,
      outcome: ctx.invariants.every((i) => i.holds) ? "HELD" : "BROKEN",
      durationMs,
      lanes: ctx.lanes.length,
      statusHistogram: histogram(
        ctx.lanes.map((l) => `${l.op}:${l.status}${l.code ? `:${l.code}` : ""}`),
      ),
      counters: { ...h.fake.counters },
      invariants: ctx.invariants,
      advisories: ctx.advisories,
      observations: ctx.observations,
      replay: replayCommand(scenario, seed),
    };
    out.push(result);
    results.push(result);
    if (result.outcome === "BROKEN" || REPLAY_SEED !== null) {
      const dir = outDir();
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(
        `${dir}${scenario}.seed-${seed}.json`,
        JSON.stringify({ ...result, requests: ctx.lanes, timeline: h.fake.timeline }, null, 2),
      );
    }
  }
  const broken = out.filter((r) => r.outcome === "BROKEN");
  const advisoriesBroken = out.flatMap((r) => r.advisories.filter((a) => !a.holds));
  console.log(
    `[stress] ${scenario}: ${out.length} iterations, ${out.reduce((n, r) => n + r.lanes, 0)} requests, ${
      broken.length
    } BROKEN, ${advisoriesBroken.length} advisory misses`,
  );
  for (const r of broken) {
    for (const i of r.invariants.filter((i) => !i.holds)) {
      console.log(`[stress]   BROKEN seed=${r.seed} ${i.name} — ${i.detail}`);
    }
    console.log(`[stress]   replay: ${r.replay}`);
  }
  return out;
}

function assertHeld(out: IterationResult[]): void {
  const broken = out.filter((r) => r.outcome === "BROKEN");
  assert(
    broken.length === 0,
    broken
      .map(
        (r) =>
          `seed=${r.seed}: ${r.invariants
            .filter((i) => !i.holds)
            .map((i) => `${i.name} (${i.detail})`)
            .join("; ")}\n  replay: ${r.replay}`,
      )
      .join("\n"),
  );
}

// ── Token builders ───────────────────────────────────────────────────────────

const JWT_HEADER = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));

/** A Supabase-shaped session JWT the fake will honour ONLY if registered via
 * fake.accessIndex (see registerSessionBearer) — otherwise getUser → 403. */
function sessionJwt(sub: string, sessionId: string, claims: Record<string, unknown>): string {
  return `${JWT_HEADER}.${b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub,
      aud: "authenticated",
      role: "authenticated",
      session_id: sessionId,
      ...claims,
    }),
  )}.sig`;
}

function providerJwt(iss: string, sub: string, claims: Record<string, unknown>): string {
  return `${JWT_HEADER}.${b64url(JSON.stringify({ iss, sub, ...claims }))}.sig`;
}

/** Register an extra access token for an existing fake session (same
 * session_id): GoTrue keeps honouring pre-refresh siblings until their exp. */
function registerSessionBearer(h: XcHarness, accessToken: string, sessionIdOfToken: string): void {
  h.fake.accessIndex.set(accessToken, sessionIdOfToken);
}

function sessionIdOfBearer(token: string): string {
  const sid = jwtPayload(token)?.session_id;
  if (typeof sid !== "string") throw new Error("stress: bearer without session_id");
  return sid;
}

const getMe = (
  ctx: IterationContext,
  i: number,
  op: string,
  token: string | null,
  headers?: Record<string, string>,
) =>
  lane(ctx, i, op, () =>
    ctx.h.handler(edgeRequest("GET", "/v1/me", { token, ip: ctx.ip(i), headers })),
  );

// ─────────────────────────────────────────────────────────────────────────────
// A — mixed bearer burst: session bearers of two users, a transitional
// provider-token bearer of a third, and locally-refusable / upstream-refused
// bad bearers, all interleaved. Identity, branch routing, upstream fan-out.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(SCENARIOS[0], async () => {
  const out = await runScenario(SCENARIOS[0], async (ctx) => {
    const { h, prng, invariants, advisories, observations } = ctx;
    const subA = prng.uuid();
    const subB = prng.uuid();
    const subC = prng.uuid(); // legacy build: bears the Google ID token on every call
    const bootA = await bootstrap(h, subA, ctx.ip(250));
    const bootB = await bootstrap(h, subB, ctx.ip(251));
    inv(
      invariants,
      "precondition: both bootstraps 200",
      bootA.status === 200 && bootB.status === 200,
      `A=${bootA.status} B=${bootB.status}`,
    );
    const providerC = fakeGoogleIdToken(subC, `stress-${ctx.seed}`);
    const nowS = Math.floor(Date.now() / 1000);
    type Kind =
      | "A"
      | "B"
      | "C.provider"
      | "bad.garbage"
      | "bad.issuer"
      | "bad.expired_session"
      | "bad.expired_provider"
      | "bad.unknown_session"
      | "bad.missing";
    const kinds: Kind[] = [
      "A",
      "A",
      "B",
      "C.provider",
      "C.provider",
      "bad.garbage",
      "bad.issuer",
      "bad.expired_session",
      "bad.expired_provider",
      "bad.unknown_session",
      "bad.missing",
    ];
    const plan = prng.shuffle(
      Array.from(
        { length: STRESS_BURST },
        (_, i) => kinds[prng.int(0, kinds.length - 1)] ?? kinds[i % kinds.length],
      ),
    );
    const tokenFor = (kind: Kind, i: number): string | null => {
      switch (kind) {
        case "A":
          return bootA.accessToken;
        case "B":
          return bootB.accessToken;
        case "C.provider":
          return providerC;
        case "bad.garbage":
          return `garbage-${prng.uuid()}`;
        case "bad.issuer":
          return providerJwt("https://issuer.example.test", prng.uuid(), { exp: nowS + 3600 });
        case "bad.expired_session":
          return sessionJwt(subA, sessionIdOfBearer(bootA.accessToken), {
            exp: nowS - 1 - prng.int(0, 3600),
            jti: `${i}-${prng.uuid()}`,
          });
        case "bad.expired_provider":
          return providerJwt("https://accounts.google.com", subC, {
            exp: nowS - 1 - prng.int(0, 3600),
          });
        case "bad.unknown_session":
          return sessionJwt(prng.uuid(), `sess-unknown-${prng.uuid()}`, {
            exp: nowS + 3600,
            jti: `${i}-${prng.uuid()}`,
          });
        case "bad.missing":
          return null;
      }
    };
    const exchangesBefore = h.fake.counters["gotrue.token.id_token"] ?? 0;
    const getUserBefore = h.fake.counters["gotrue.get_user"] ?? 0;
    const res = await Promise.all(
      plan.map((kind, i) => getMe(ctx, i, `me:${kind}`, tokenFor(kind, i))),
    );
    const exchanges = (h.fake.counters["gotrue.token.id_token"] ?? 0) - exchangesBefore;
    const getUsers = (h.fake.counters["gotrue.get_user"] ?? 0) - getUserBefore;

    let identityLeaks = 0;
    let goodRefused = 0;
    let badAccepted = 0;
    res.forEach((r, i) => {
      const kind = plan[i];
      const expectSub =
        kind === "A" ? subA : kind === "B" ? subB : kind === "C.provider" ? subC : null;
      if (expectSub) {
        if (r.status !== 200) goodRefused += 1;
        else if (!isRecord(r.body.user) || r.body.user.id !== expectSub) identityLeaks += 1;
      } else if (r.status !== 401) {
        badAccepted += 1;
      }
    });
    const counts = histogram(plan);
    const unknownSessionLanes = counts["bad.unknown_session"] ?? 0;
    const liveSessionLanes = (counts.A ?? 0) + (counts.B ?? 0);
    const providerLanes = counts["C.provider"] ?? 0;
    // Locally refusable bearers (garbage / foreign issuer / expired / missing)
    // must never reach Supabase Auth; only live session bearers (cache miss)
    // and unknown-session bearers may call getUser, only provider bearers may
    // exchange.
    inv(
      invariants,
      "every live bearer (2 session users + provider-token user) → 200 with ITS OWN user id",
      goodRefused === 0 && identityLeaks === 0,
      `refused=${goodRefused} identity_leaks=${identityLeaks} plan=${JSON.stringify(counts)}`,
    );
    inv(
      invariants,
      "every bad bearer → 401 (garbage, foreign issuer, expired session, expired provider, unknown session, missing)",
      badAccepted === 0,
      `accepted=${badAccepted}`,
    );
    inv(
      invariants,
      "locally refusable bearers never reach Supabase Auth: getUser ≤ live-session lanes + unknown-session lanes; exchanges ≤ provider lanes",
      getUsers <= liveSessionLanes + unknownSessionLanes && exchanges <= providerLanes,
      `getUser=${getUsers} (≤ ${liveSessionLanes + unknownSessionLanes}) exchanges=${exchanges} (≤ ${providerLanes})`,
    );
    inv(
      invariants,
      "unknown-session bearers are verified upstream exactly once each (refused by GoTrue, never cached)",
      getUsers >= unknownSessionLanes,
      `getUser=${getUsers} unknown_session_lanes=${unknownSessionLanes}`,
    );
    // AGENTS.md: "Supabase Auth is consulted once per user per window, not per
    // request". A cold-cache burst of the SAME bearer has no single-flight, so
    // every concurrent miss verifies (and, for a provider token, MINTS a
    // Supabase session) — advisory: reproduces the fan-out, not a suite failure.
    const liveGetUsers = getUsers - unknownSessionLanes;
    inv(
      advisories,
      "cold-cache burst of one session bearer consults Supabase Auth once per user (single-flight)",
      liveGetUsers <= 2,
      `getUser for 2 live users across ${liveSessionLanes} lanes: ${liveGetUsers}`,
    );
    inv(
      advisories,
      "cold-cache burst of one provider-token bearer exchanges (mints a Supabase session) once",
      exchanges <= 1,
      `signInWithIdToken exchanges for ${providerLanes} provider lanes: ${exchanges} (sessions minted for user C: ${
        [...h.fake.sessions.values()].filter((s) => s.userId === subC).length
      })`,
    );
    observations.plan = counts;
    observations.getUserCalls = getUsers;
    observations.idTokenExchanges = exchanges;
    observations.sessionsMintedForProviderUser = [...h.fake.sessions.values()].filter(
      (s) => s.userId === subC,
    ).length;
  });
  assertHeld(out);
});

// ─────────────────────────────────────────────────────────────────────────────
// B — logout landing DURING a burst on the same bearer (seeded offset, seeded
// slow getUser on some lanes): no 5xx; a lane that STARTED after the logout
// completed is refused; the bearer is never resurrected; sibling access
// tokens of the same session are fenced too; a second device stays signed in.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(SCENARIOS[1], async () => {
  const out = await runScenario(SCENARIOS[1], async (ctx) => {
    const { h, prng, invariants, observations } = ctx;
    const sub = prng.uuid();
    const device1 = await bootstrap(h, sub, ctx.ip(250));
    const device2 = await bootstrap(h, sub, ctx.ip(251));
    inv(
      invariants,
      "precondition: two device sessions for one user",
      device1.status === 200 &&
        device2.status === 200 &&
        device1.accessToken !== device2.accessToken,
      `d1=${device1.status} d2=${device2.status}`,
    );
    const sid1 = sessionIdOfBearer(device1.accessToken);
    // a pre-refresh sibling access token of device1's session (GoTrue would
    // still honour it until exp)
    const sibling = sessionJwt(sub, sid1, {
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: `sibling-${prng.uuid()}`,
    });
    registerSessionBearer(h, sibling, sid1);
    // Seeded slowness on the wire for some verifications of device1's bearer.
    const slowLanes = new Set(Array.from({ length: prng.int(0, 3) }, () => prng.int(0, 5)));
    let verifications = 0;
    h.fake.overrides.getUserDelayMs = (bearer) =>
      bearer === device1.accessToken || bearer === sibling
        ? slowLanes.has(verifications++)
          ? 20 + prng.int(0, 40)
          : 0
        : 0;
    const logoutAt = prng.int(0, STRESS_JITTER_MS + STRESS_LATENCY_MS * 2);
    const plan = Array.from({ length: STRESS_BURST }, (_, i) =>
      i % 5 === 4 ? "sibling" : i % 7 === 6 ? "device2" : "device1",
    );
    const burst = plan.map((who, i) =>
      getMe(
        ctx,
        i,
        `me:${who}`,
        who === "sibling" ? sibling : who === "device2" ? device2.accessToken : device1.accessToken,
      ),
    );
    const logoutLane = (async () => {
      await sleep(logoutAt);
      const startedAt = performance.now();
      const response = await h.handler(
        edgeRequest("POST", "/v1/auth/logout", { token: device1.accessToken, ip: ctx.ip(252) }),
      );
      await readJson(response);
      const row: Lane = {
        lane: 252,
        op: "logout:device1",
        status: response.status,
        requestId: response.headers.get("x-request-id"),
        startedAt: Math.round(startedAt * 100) / 100,
        endedAt: Math.round(performance.now() * 100) / 100,
      };
      ctx.lanes.push(row);
      return row;
    })();
    const [res, logout] = await Promise.all([Promise.all(burst), logoutLane]);
    h.fake.overrides.getUserDelayMs = undefined;
    const session1 = h.fake.sessions.get(sid1);
    inv(
      invariants,
      "logout → 204 and the session is revoked upstream",
      logout.status === 204 && session1?.revoked === true,
      `logout=${logout.status} revoked=${session1?.revoked}`,
    );
    let lateAccepted = 0;
    let device2Refused = 0;
    let odd = 0;
    res.forEach((r, i) => {
      const who = plan[i];
      if (who === "device2") {
        if (r.status !== 200) device2Refused += 1;
        return;
      }
      if (r.status !== 200 && r.status !== 401) odd += 1;
      if (r.status === 200 && r.row.startedAt >= logout.endedAt) lateAccepted += 1;
    });
    inv(
      invariants,
      "device1 + sibling lanes are 200 or 401 only; a lane that STARTED after logout completed is 401",
      odd === 0 && lateAccepted === 0,
      `odd=${odd} accepted_after_logout=${lateAccepted} ${JSON.stringify(histogram(res.map((r) => r.status)))}`,
    );
    inv(
      invariants,
      "logout scope=local leaves the other device signed in throughout the burst",
      device2Refused === 0,
      `device2 refused=${device2Refused}/${plan.filter((w) => w === "device2").length}`,
    );
    // After the burst: the bearer AND its sibling stay refused, twice each
    // (never re-cached), and device2 still works.
    const after = await Promise.all([
      getMe(ctx, 253, "after:device1", device1.accessToken),
      getMe(ctx, 254, "after:device1", device1.accessToken),
      getMe(ctx, 255, "after:sibling", sibling),
      getMe(ctx, 249, "after:sibling", sibling),
      getMe(ctx, 248, "after:device2", device2.accessToken),
    ]);
    inv(
      invariants,
      "after logout: bearer and its pre-refresh sibling are refused on every later request (no resurrection); device2 → 200",
      after.slice(0, 4).every((r) => r.status === 401) && after[4].status === 200,
      after.map((r) => `${r.row.op}=${r.status}`).join(" "),
    );
    observations.logoutAtMs = logoutAt;
    observations.slowLanes = [...slowLanes];
    observations.burstStatuses = histogram(res.map((r, i) => `${plan[i]}:${r.status}`));
  });
  assertHeld(out);
});

// ─────────────────────────────────────────────────────────────────────────────
// C — refresh rotation landing DURING a burst: k duplicate refreshes with the
// SAME refresh token race a burst on the old bearer; exactly one rotation
// wins (GoTrue reject-reuse), old bearer stays valid until exp, the new pair
// works, no 5xx, refresh losers are 401 (never 5xx / never a second pair).
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(SCENARIOS[2], async () => {
  const out = await runScenario(SCENARIOS[2], async (ctx) => {
    const { h, prng, invariants, observations } = ctx;
    const sub = prng.uuid();
    const boot = await bootstrap(h, sub, ctx.ip(250));
    inv(invariants, "precondition: bootstrap 200", boot.status === 200, `status=${boot.status}`);
    const dupRefreshes = 2 + prng.int(0, 3);
    const refreshAt = prng.int(0, STRESS_JITTER_MS + STRESS_LATENCY_MS);
    const burst = Array.from({ length: STRESS_BURST }, (_, i) =>
      getMe(ctx, i, "me:old", boot.accessToken),
    );
    const refreshes = Array.from({ length: dupRefreshes }, (_, k) =>
      (async () => {
        await sleep(refreshAt + prng.int(0, STRESS_JITTER_MS));
        return lane(ctx, 200 + k, "refresh:dup", () =>
          h.handler(
            edgeRequest("POST", "/v1/auth/refresh", {
              ip: ctx.ip(200 + k),
              body: { refreshToken: boot.refreshToken },
            }),
          ),
        );
      })(),
    );
    const [old, rot] = await Promise.all([Promise.all(burst), Promise.all(refreshes)]);
    const winners = rot.filter((r) => r.status === 200);
    const losers = rot.filter((r) => r.status === 401);
    const pairs = new Set(
      winners.map((w) => {
        const s = isRecord(w.body.session) ? w.body.session : {};
        return `${s.accessToken}|${s.refreshToken}`;
      }),
    );
    inv(
      invariants,
      `duplicate refresh ×${dupRefreshes} with one refresh token → exactly one 200 (one new pair), the rest 401`,
      winners.length === 1 && losers.length === dupRefreshes - 1 && pairs.size === 1,
      `${JSON.stringify(histogram(rot.map((r) => r.status)))} pairs=${pairs.size}`,
    );
    inv(
      invariants,
      "old bearer keeps authenticating throughout the rotation (GoTrue honours it until exp)",
      old.every((r) => r.status === 200 && isRecord(r.body.user) && r.body.user.id === sub),
      JSON.stringify(histogram(old.map((r) => r.status))),
    );
    const win = winners[0];
    const newSession = win && isRecord(win.body.session) ? win.body.session : null;
    if (newSession) {
      const probe = await Promise.all([
        getMe(ctx, 240, "me:new", String(newSession.accessToken)),
        getMe(ctx, 241, "me:new", String(newSession.accessToken)),
        getMe(ctx, 242, "me:old.after", boot.accessToken),
      ]);
      inv(
        invariants,
        "new bearer authenticates as the same user; old bearer still authenticates after rotation",
        probe.every((p) => p.status === 200 && isRecord(p.body.user) && p.body.user.id === sub),
        probe.map((p) => `${p.row.op}=${p.status}`).join(" "),
      );
      const reuse = await lane(ctx, 243, "refresh:reuse_old", () =>
        h.handler(
          edgeRequest("POST", "/v1/auth/refresh", {
            ip: ctx.ip(243),
            body: { refreshToken: boot.refreshToken },
          }),
        ),
      );
      inv(
        invariants,
        "the rotated-away refresh token is refused (401) afterwards, never 5xx",
        reuse.status === 401,
        `status=${reuse.status}`,
      );
    }
    observations.dupRefreshes = dupRefreshes;
    observations.refreshAtMs = refreshAt;
    observations.gotrueRefreshCalls = h.fake.counters["gotrue.token.refresh"] ?? 0;
  });
  assertHeld(out);
});

// ─────────────────────────────────────────────────────────────────────────────
// D — two (three) actors on ONE user row: device1 session, device2 session,
// and a legacy provider-token bearer all reserve analysis permits at once.
// Same idempotency key across actors → one permit; distinct keys → never more
// than two live free reservations; one row per accepted id; premium → all.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(SCENARIOS[3], async () => {
  const out = await runScenario(SCENARIOS[3], async (ctx) => {
    const { h, prng, invariants, observations } = ctx;
    const sub = prng.uuid();
    const d1 = await bootstrap(h, sub, ctx.ip(250));
    const d2 = await bootstrap(h, sub, ctx.ip(251));
    const legacy = fakeGoogleIdToken(sub, `legacy-${ctx.seed}`);
    inv(
      invariants,
      "precondition: two device sessions",
      d1.status === 200 && d2.status === 200,
      `${d1.status}/${d2.status}`,
    );
    const actors = [d1.accessToken, d2.accessToken, legacy];
    const burstSize = Math.min(STRESS_BURST, 24); // per-user permits budget 30/min
    const sharedKey = `shared-${prng.uuid()}`;
    const sharedLanes = Math.max(3, Math.floor(burstSize / 3));
    const plan = prng.shuffle(
      Array.from({ length: burstSize }, (_, i) => ({
        actor: prng.int(0, 2),
        key: i < sharedLanes ? sharedKey : `k-${i}-${prng.uuid()}`,
      })),
    );
    const res = await Promise.all(
      plan.map((p, i) =>
        lane(ctx, i, `permit:${p.key === sharedKey ? "shared" : "distinct"}:actor${p.actor}`, () =>
          h.handler(
            edgeRequest("POST", "/v1/analysis-permits", {
              token: actors[p.actor],
              ip: ctx.ip(i),
              body: { idempotencyKey: p.key },
            }),
          ),
        ),
      ),
    );
    const permitIdOf = (r: { body: Record<string, unknown> }) =>
      isRecord(r.body.permit) ? String(r.body.permit.id) : null;
    const sharedRes = res.filter((_, i) => plan[i].key === sharedKey);
    const sharedIds = new Set(sharedRes.filter((r) => r.status === 200).map(permitIdOf));
    const accepted = res.filter((r) => r.status === 200);
    const paywalled = res.filter(
      (r) => r.status === 402 && r.row.code === "access.paywall_required",
    );
    const acceptedIds = new Set(accepted.map(permitIdOf));
    const rows = h.fake.tables.analysis_permits.filter((p) => p.user_id === sub);
    const reservedRows = rows.filter((p) => p.status === "reserved");
    inv(
      invariants,
      `shared key across 3 actors (${sharedRes.length} lanes) → one permit id (or all paywalled if two distinct keys won first)`,
      sharedIds.size <= 1 && sharedRes.every((r) => r.status === 200 || r.status === 402),
      `ids=${sharedIds.size} ${JSON.stringify(histogram(sharedRes.map((r) => r.status)))}`,
    );
    inv(
      invariants,
      "free user: at most TWO live reservations across all actors (no double spend), rest 402 access.paywall_required",
      reservedRows.length <= 2 &&
        acceptedIds.size <= 2 &&
        accepted.length + paywalled.length === res.length,
      `reserved_rows=${reservedRows.length} accepted_ids=${acceptedIds.size} accepted=${accepted.length} paywalled=${paywalled.length} other=${
        res.length - accepted.length - paywalled.length
      }`,
    );
    inv(
      invariants,
      "one row per distinct accepted permit id (no duplicate rows)",
      rows.length === acceptedIds.size,
      `rows=${rows.length} ids=${acceptedIds.size}`,
    );
    // Every actor sees the same access snapshot afterwards (no lost update).
    const snaps = await Promise.all(
      actors.map((token, i) =>
        lane(ctx, 240 + i, `access:actor${i}`, () =>
          h.handler(edgeRequest("GET", "/v1/me/access", { token, ip: ctx.ip(240 + i) })),
        ),
      ),
    );
    const reservedSeen = new Set(
      snaps.map((s) =>
        isRecord(s.body.freeRatings) ? JSON.stringify(s.body.freeRatings) : `status=${s.status}`,
      ),
    );
    inv(
      invariants,
      "all three actors read ONE consistent freeRatings snapshot after the burst",
      snaps.every((s) => s.status === 200) && reservedSeen.size === 1,
      `snapshots=${[...reservedSeen].join(" | ")}`,
    );
    observations.plan = histogram(
      plan.map((p) => `actor${p.actor}:${p.key === sharedKey ? "shared" : "distinct"}`),
    );
    observations.reservedRows = reservedRows.length;
    observations.rpcReserveCalls = h.fake.counters["rpc.reserve_analysis_permit"] ?? 0;
  });
  assertHeld(out);
});

// ─────────────────────────────────────────────────────────────────────────────
// E — request ids under a burst: valid client ids are echoed, malformed /
// missing ones replaced by a fresh UUID (unique across the burst), the header
// on every response matches the one access-log line for that request, and
// a control character never reaches the response header.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(SCENARIOS[4], async () => {
  const out = await runScenario(SCENARIOS[4], async (ctx) => {
    const { h, prng, invariants, observations, accessLog: log } = ctx;
    const sub = prng.uuid();
    const boot = await bootstrap(h, sub, ctx.ip(250));
    inv(invariants, "precondition: bootstrap 200", boot.status === 200, `status=${boot.status}`);
    const logBase = log.length;
    // (A CR/LF inside a header value cannot be transported at all — Headers
    // refuses it before the handler runs — so the control-character probe is
    // a TAB, the one control byte a header value may legally carry.)
    type Kind =
      "valid" | "valid.dup" | "short" | "long" | "unicode" | "control" | "spaces" | "missing";
    const kinds: Kind[] = [
      "valid",
      "valid.dup",
      "short",
      "long",
      "unicode",
      "control",
      "spaces",
      "missing",
    ];
    const dupId = `dup-${prng.uuid()}`;
    const plan = Array.from({ length: STRESS_BURST }, () => kinds[prng.int(0, kinds.length - 1)]);
    const supplied: Array<string | null> = plan.map((kind, i) => {
      switch (kind) {
        case "valid":
          return `req-${i}-${prng.uuid()}`;
        case "valid.dup":
          return dupId;
        case "short":
          return prng.uuid().slice(0, 7);
        case "long":
          return "x".repeat(65 + prng.int(0, 200));
        case "unicode":
          return `réq-${prng.uuid()}`;
        case "control":
          return `evil-${prng.uuid()}\tX-Injected: 1`;
        case "spaces":
          return `has space ${prng.uuid()}`;
        case "missing":
          return null;
      }
    });
    // Route mix: authenticated 200, bad bearer 401, unknown route 404,
    // public /healthz 200 — the request id must behave identically on each.
    const routes = plan.map((_, i) =>
      i % 4 === 1 ? "401" : i % 4 === 2 ? "404" : i % 4 === 3 ? "healthz" : "200",
    );
    const res = await Promise.all(
      plan.map((kind, i) =>
        lane(ctx, i, `rid:${kind}:${routes[i]}`, () => {
          const headers: Record<string, string> = {};
          const id = supplied[i];
          if (id !== null) headers["x-request-id"] = id;
          const route = routes[i];
          if (route === "healthz") {
            return h.handler(edgeRequest("GET", "/healthz", { ip: ctx.ip(i), headers }));
          }
          if (route === "404") {
            return h.handler(
              edgeRequest("GET", "/v1/nope", { token: boot.accessToken, ip: ctx.ip(i), headers }),
            );
          }
          return h.handler(
            edgeRequest("GET", "/v1/me", {
              token: route === "401" ? `garbage-${prng.uuid()}` : boot.accessToken,
              ip: ctx.ip(i),
              headers,
            }),
          );
        }),
      ),
    );
    let echoMissing = 0;
    let malformedEchoed = 0;
    let mintedNotUuid = 0;
    let injected = 0;
    const minted: string[] = [];
    res.forEach((r, i) => {
      const id = supplied[i];
      const got = r.row.requestId ?? "";
      const wanted = id !== null && REQUEST_ID_RE.test(id.trim());
      if (wanted) {
        if (got !== id!.trim()) echoMissing += 1;
      } else {
        if (id !== null && got === id) malformedEchoed += 1;
        if (!UUID_RE.test(got)) mintedNotUuid += 1;
        minted.push(got);
      }
      if (/[\r\n\t]/.test(got) || r.headers.has("x-injected")) injected += 1;
    });
    inv(
      invariants,
      "valid client ids are echoed verbatim (including the same id on several concurrent lanes)",
      echoMissing === 0,
      `not_echoed=${echoMissing}`,
    );
    inv(
      invariants,
      "malformed/missing ids (short, >64, unicode, control char, spaces, absent) are replaced by a UUID; none echoed",
      malformedEchoed === 0 && mintedNotUuid === 0,
      `malformed_echoed=${malformedEchoed} minted_not_uuid=${mintedNotUuid}`,
    );
    inv(
      invariants,
      "minted ids are unique across the burst",
      new Set(minted).size === minted.length,
      `${new Set(minted).size}/${minted.length} unique`,
    );
    inv(invariants, "no header injection via x-request-id", injected === 0, `injected=${injected}`);
    // Access log ↔ response correlation: exactly one line per request in this
    // burst, requestId + status agree with the response the client got.
    const lines = log.slice(logBase).filter((l) => l.evt === "api_request");
    const byId = new Map<string, Array<Record<string, unknown>>>();
    for (const l of lines) {
      const k = String(l.requestId);
      byId.set(k, [...(byId.get(k) ?? []), l]);
    }
    let unmatched = 0;
    res.forEach((r) => {
      const candidates = byId.get(r.row.requestId ?? "") ?? [];
      const hit = candidates.findIndex((l) => l.status === r.status);
      if (hit < 0) unmatched += 1;
      else candidates.splice(hit, 1);
    });
    inv(
      invariants,
      "exactly one access-log line per request, whose requestId and status match the response",
      lines.length === res.length && unmatched === 0,
      `lines=${lines.length} requests=${res.length} unmatched=${unmatched}`,
    );
    inv(
      invariants,
      "route mix answered as planned (200 / 401 / 404 / healthz 200) — no 5xx, no leaked route ids",
      res.every((r, i) =>
        routes[i] === "401"
          ? r.status === 401
          : routes[i] === "404"
            ? r.status === 404
            : r.status === 200,
      ) &&
        lines.every(
          (l) => typeof l.route === "string" && !/[0-9a-f]{8}-[0-9a-f]{4}/i.test(String(l.route)),
        ),
      JSON.stringify(histogram(res.map((r, i) => `${routes[i]}→${r.status}`))),
    );
    observations.plan = histogram(plan);
    observations.logLines = lines.length;
  });
  assertHeld(out);
});

// ─────────────────────────────────────────────────────────────────────────────
// F — clock skew at the bearer `exp` boundary: bearers of one live session
// with exp in the past, within seconds, within the no-cache window (< 90s),
// far in the future, exp as a string, and provider tokens at the same
// boundary, all in one burst. Expired → 401 without any upstream call; a
// request STARTED after exp is never 200; alive → 200; no 5xx.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(SCENARIOS[5], async () => {
  const out = await runScenario(SCENARIOS[5], async (ctx) => {
    const { h, prng, invariants, advisories, observations } = ctx;
    const sub = prng.uuid();
    const boot = await bootstrap(h, sub, ctx.ip(250));
    inv(invariants, "precondition: bootstrap 200", boot.status === 200, `status=${boot.status}`);
    const sid = sessionIdOfBearer(boot.accessToken);
    const nowMs = Date.now();
    const nowS = Math.floor(nowMs / 1000);
    type Kind = "past" | "past.provider" | "edge" | "short" | "far" | "string_exp" | "far.provider";
    const kinds: Kind[] = [
      "past",
      "past.provider",
      "edge",
      "short",
      "far",
      "string_exp",
      "far.provider",
    ];
    const plan = Array.from({ length: STRESS_BURST }, () => kinds[prng.int(0, kinds.length - 1)]);
    const tokens = plan.map((kind, i) => {
      const jti = `${i}-${prng.uuid()}`;
      switch (kind) {
        case "past":
          return sessionJwt(sub, sid, { exp: nowS - prng.int(0, 600), jti });
        case "edge":
          // ±1s around now — whichever side the handler's clock lands on
          return sessionJwt(sub, sid, { exp: nowS + prng.int(0, 2), jti });
        case "short":
          return sessionJwt(sub, sid, { exp: nowS + 6 + prng.int(0, 80), jti }); // alive, not cacheable (<90s)
        case "far":
          return sessionJwt(sub, sid, { exp: nowS + 120 + prng.int(0, 3600), jti });
        case "string_exp":
          return sessionJwt(sub, sid, { exp: String(nowS + 3600), jti });
        case "past.provider":
          return providerJwt("https://accounts.google.com", sub, {
            exp: nowS - 1 - prng.int(0, 600),
            jti,
          });
        case "far.provider":
          return providerJwt("https://accounts.google.com", sub, {
            exp: nowS + 120 + prng.int(0, 3600),
            jti,
          });
      }
    });
    tokens.forEach((t, i) => {
      if (!plan[i].endsWith("provider")) registerSessionBearer(h, t, sid);
    });
    const getUserBefore = h.fake.counters["gotrue.get_user"] ?? 0;
    const exchBefore = h.fake.counters["gotrue.token.id_token"] ?? 0;
    const res = await Promise.all(tokens.map((t, i) => getMe(ctx, i, `me:${plan[i]}`, t)));
    const getUsers = (h.fake.counters["gotrue.get_user"] ?? 0) - getUserBefore;
    const exchanges = (h.fake.counters["gotrue.token.id_token"] ?? 0) - exchBefore;
    let pastAccepted = 0;
    let aliveRefused = 0;
    let acceptedAfterExp = 0;
    let odd = 0;
    res.forEach((r, i) => {
      const kind = plan[i];
      const exp = jwtPayload(tokens[i])?.exp;
      const expMs = typeof exp === "number" ? exp * 1000 : Number.POSITIVE_INFINITY;
      if (kind === "past" || kind === "past.provider") {
        if (r.status !== 401) pastAccepted += 1;
      } else if (kind === "edge") {
        if (r.status !== 200 && r.status !== 401) odd += 1;
      } else if (r.status !== 200 || !isRecord(r.body.user) || r.body.user.id !== sub) {
        aliveRefused += 1;
      }
      // wall-clock check: the lane's start (performance.now) mapped to epoch ms
      // (5ms tolerance: performance.timeOrigin+now and Date.now() are two
      // clocks; the handler decides on Date.now().)
      const startedEpochMs = performance.timeOrigin + r.row.startedAt;
      if (r.status === 200 && startedEpochMs >= expMs + 5) acceptedAfterExp += 1;
    });
    const counts = histogram(plan);
    const pastLanes = (counts.past ?? 0) + (counts["past.provider"] ?? 0);
    const liveSessionLanes = res.length - pastLanes - (counts["far.provider"] ?? 0);
    inv(
      invariants,
      "expired session/provider bearers → 401; alive bearers (short, far, string exp) → 200 as the right user; ±1s edge → 200|401",
      pastAccepted === 0 && aliveRefused === 0 && odd === 0,
      `past_accepted=${pastAccepted} alive_refused=${aliveRefused} edge_odd=${odd} plan=${JSON.stringify(counts)}`,
    );
    inv(
      invariants,
      "no request that STARTED after its bearer's exp was answered 200",
      acceptedAfterExp === 0,
      `accepted_after_exp=${acceptedAfterExp}`,
    );
    inv(
      invariants,
      "expired bearers never reach Supabase Auth (getUser ≤ non-expired session lanes; exchanges ≤ live provider lanes)",
      getUsers <= liveSessionLanes && exchanges <= (counts["far.provider"] ?? 0),
      `getUser=${getUsers} (≤ ${liveSessionLanes}) exchanges=${exchanges} (≤ ${counts["far.provider"] ?? 0})`,
    );
    inv(
      advisories,
      "short-lived bearers (< 90s to exp) are not cached, so every lane re-verifies — one getUser per distinct bearer is the floor",
      getUsers >= (counts.short ?? 0),
      `getUser=${getUsers} short_lanes=${counts.short ?? 0}`,
    );
    observations.plan = counts;
    observations.getUserCalls = getUsers;
    observations.idTokenExchanges = exchanges;
  });
  assertHeld(out);
});

// ─────────────────────────────────────────────────────────────────────────────
// G — the per-IP auth-failure budget (30 / 300s) under a CONCURRENT burst of
// distinct, well-formed, unknown session bearers from ONE IP (token stuffing).
// Asserted: no 5xx, every probe 401|429, the budget is tripped afterwards
// (a later probe from the IP is 429 without reaching Supabase Auth).
// Advisory (contract: "those never even reach Supabase Auth once tripped"):
// the gate is peek-then-charge, so a burst wider than the budget all passes
// the peek before any lane is charged — every lane reaches GoTrue.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(SCENARIOS[6], async () => {
  const out = await runScenario(SCENARIOS[6], async (ctx) => {
    const { h, prng, invariants, advisories, observations } = ctx;
    const attackerIp = ctx.ip(7);
    const width = Math.max(STRESS_BURST, AUTH_FAILURE_LIMIT + 10);
    const nowS = Math.floor(Date.now() / 1000);
    const getUserBefore = h.fake.counters["gotrue.get_user"] ?? 0;
    const res = await Promise.all(
      Array.from({ length: width }, (_, i) =>
        lane(ctx, i, "probe", () =>
          h.handler(
            edgeRequest("GET", "/v1/me", {
              token: sessionJwt(prng.uuid(), `sess-probe-${prng.uuid()}`, {
                exp: nowS + 3600,
                jti: `${i}`,
              }),
              ip: attackerIp,
            }),
          ),
        ),
      ),
    );
    const getUsersDuringBurst = (h.fake.counters["gotrue.get_user"] ?? 0) - getUserBefore;
    const refused = res.filter((r) => r.status === 401).length;
    const limited = res.filter((r) => r.status === 429).length;
    inv(
      invariants,
      `every probe in the burst (${width} distinct unknown bearers, one IP) is 401 or 429`,
      refused + limited === res.length,
      JSON.stringify(histogram(res.map((r) => r.status))),
    );
    const before = h.fake.counters["gotrue.get_user"] ?? 0;
    const after = await Promise.all(
      Array.from({ length: 3 }, (_, k) =>
        lane(ctx, 100 + k, "probe:after", () =>
          h.handler(
            edgeRequest("GET", "/v1/me", {
              token: sessionJwt(prng.uuid(), `sess-probe-${prng.uuid()}`, { exp: nowS + 3600 }),
              ip: attackerIp,
            }),
          ),
        ),
      ),
    );
    const getUsersAfter = (h.fake.counters["gotrue.get_user"] ?? 0) - before;
    inv(
      invariants,
      `once ≥ ${AUTH_FAILURE_LIMIT} failures are recorded, later probes from the IP are 429 and never reach Supabase Auth`,
      refused >= AUTH_FAILURE_LIMIT
        ? after.every((r) => r.status === 429) && getUsersAfter === 0
        : true,
      `recorded_failures=${refused} after=${JSON.stringify(histogram(after.map((r) => r.status)))} getUser_after=${getUsersAfter}`,
    );
    inv(
      invariants,
      "a legitimate user on another IP is unaffected by the attacker's budget",
      await (async () => {
        const sub = prng.uuid();
        const boot = await bootstrap(h, sub, ctx.ip(200));
        const me = await getMe(ctx, 201, "me:bystander", boot.accessToken);
        return boot.status === 200 && me.status === 200;
      })(),
      "bootstrap + GET /v1/me from a clean IP",
    );
    inv(
      advisories,
      `a concurrent burst wider than the budget reaches Supabase Auth at most ${AUTH_FAILURE_LIMIT} times (budget gates the burst, not just later probes)`,
      getUsersDuringBurst <= AUTH_FAILURE_LIMIT,
      `getUser during burst=${getUsersDuringBurst} for ${width} probes (limit ${AUTH_FAILURE_LIMIT}); 401=${refused} 429=${limited}`,
    );
    observations.width = width;
    observations.getUserDuringBurst = getUsersDuringBurst;
    observations.refused = refused;
    observations.limited = limited;
  });
  assertHeld(out);
});

// ─────────────────────────────────────────────────────────────────────────────
// H — cancel-during-call: a burst of permit reservations where seeded lanes
// abort their Request signal mid-flight (client gone). The handler must still
// settle every lane, spend at most two free permits, and a retry with the same
// idempotency key must converge on one permit id; no duplicate rows.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(SCENARIOS[7], async () => {
  const out = await runScenario(SCENARIOS[7], async (ctx) => {
    const { h, prng, invariants, observations } = ctx;
    const sub = prng.uuid();
    const boot = await bootstrap(h, sub, ctx.ip(250));
    inv(invariants, "precondition: bootstrap 200", boot.status === 200, `status=${boot.status}`);
    const burstSize = Math.min(STRESS_BURST, 12); // leave budget for the retries (30/min)
    const keys = Array.from({ length: burstSize }, (_, i) => `cancel-${i}-${prng.uuid()}`);
    const cancelled = new Set(
      Array.from({ length: Math.ceil(burstSize / 2) }, () => prng.int(0, burstSize - 1)),
    );
    const settled: boolean[] = keys.map(() => false);
    const res = await Promise.all(
      keys.map((key, i) =>
        lane(ctx, i, cancelled.has(i) ? "permit:cancelled" : "permit", async () => {
          const controller = new AbortController();
          const request = new Request(`http://edge.xc.test/functions/v1/api/v1/analysis-permits`, {
            method: "POST",
            headers: {
              "x-forwarded-for": ctx.ip(i),
              Authorization: `Bearer ${boot.accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ idempotencyKey: key }),
            signal: controller.signal,
          });
          const work = h.handler(request).finally(() => (settled[i] = true));
          if (cancelled.has(i)) {
            await sleep(prng.int(0, STRESS_LATENCY_MS + 2));
            controller.abort(new DOMException("client cancelled", "AbortError"));
          }
          return await work;
        }),
      ),
    );
    inv(
      invariants,
      "every lane settles (cancelled or not) — the handler never hangs on an aborted request",
      settled.every(Boolean),
      `${settled.filter(Boolean).length}/${settled.length} settled`,
    );
    const rowsAfterBurst = h.fake.tables.analysis_permits.filter((p) => p.user_id === sub);
    inv(
      invariants,
      "≤ 2 free permits reserved across the burst regardless of cancellations",
      rowsAfterBurst.filter((p) => p.status === "reserved").length <= 2,
      `reserved=${rowsAfterBurst.filter((p) => p.status === "reserved").length}`,
    );
    // Retry every cancelled key (client retries what it never saw answered).
    const retries = await Promise.all(
      [...cancelled].map((i, k) =>
        lane(ctx, 100 + k, "permit:retry", () =>
          h.handler(
            edgeRequest("POST", "/v1/analysis-permits", {
              token: boot.accessToken,
              ip: ctx.ip(100 + k),
              body: { idempotencyKey: keys[i] },
            }),
          ),
        ).then((r) => ({ i, r })),
      ),
    );
    const permitIdOf = (r: { body: Record<string, unknown> }) =>
      isRecord(r.body.permit) ? String(r.body.permit.id) : null;
    let diverged = 0;
    for (const { i, r } of retries) {
      const first = res[i];
      if (first.status === 200 && r.status === 200 && permitIdOf(first) !== permitIdOf(r))
        diverged += 1;
      if (first.status === 200 && r.status !== 200) diverged += 1;
    }
    const rows = h.fake.tables.analysis_permits.filter((p) => p.user_id === sub);
    const ids = new Set(rows.map((p) => String(p.id)));
    const keysWithRows = new Set(rows.map((p) => String(p.idempotency_key)));
    inv(
      invariants,
      "a retry of a cancelled key converges on the SAME permit id (idempotent), never a second permit",
      diverged === 0,
      `diverged=${diverged} retries=${retries.length} ${JSON.stringify(histogram(retries.map((x) => x.r.status)))}`,
    );
    inv(
      invariants,
      "no duplicate rows: one row per idempotency key, ≤ 2 reserved after retries",
      ids.size === rows.length &&
        keysWithRows.size === rows.length &&
        rows.filter((p) => p.status === "reserved").length <= 2,
      `rows=${rows.length} ids=${ids.size} keys=${keysWithRows.size} reserved=${rows.filter((p) => p.status === "reserved").length}`,
    );
    inv(
      invariants,
      "every non-cancelled lane is 200 or 402 access.paywall_required",
      res.every(
        (r, i) =>
          cancelled.has(i) ||
          r.status === 200 ||
          (r.status === 402 && r.row.code === "access.paywall_required"),
      ),
      JSON.stringify(
        histogram(res.map((r, i) => `${cancelled.has(i) ? "cancelled" : "plain"}:${r.status}`)),
      ),
    );
    observations.cancelledLanes = [...cancelled].sort((a, b) => a - b);
    observations.cancelledStatuses = histogram([...cancelled].map((i) => res[i].status));
  });
  assertHeld(out);
});

// ─────────────────────────────────────────────────────────────────────────────
// Results table: seed → outcome for every iteration that ran.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("stress: write results.json (seed → outcome table)", async () => {
  restoreAccessLog?.();
  restoreAccessLog = null;
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const advisoryMisses = results.flatMap((r) =>
    r.advisories.filter((a) => !a.holds).map((a) => ({ scenario: r.scenario, seed: r.seed, ...a })),
  );
  const table = {
    generatedAt: new Date().toISOString(),
    scale: {
      STRESS_SEED,
      STRESS_ITER,
      STRESS_BURST,
      STRESS_LATENCY_MS,
      STRESS_JITTER_MS,
      STRESS_ITER_BUDGET_MS,
      replaySeed: REPLAY_SEED,
    },
    totals: {
      scenarios: new Set(results.map((r) => r.scenario)).size,
      iterations: results.length,
      requests: results.reduce((n, r) => n + r.lanes, 0),
      held: results.filter((r) => r.outcome === "HELD").length,
      broken: results.filter((r) => r.outcome === "BROKEN").length,
      advisoryMisses: advisoryMisses.length,
      wallMs: results.reduce((n, r) => n + r.durationMs, 0),
    },
    heap: Deno.memoryUsage(),
    results: results.map((r) => ({
      scenario: r.scenario,
      iter: r.iter,
      seed: r.seed,
      outcome: r.outcome,
      durationMs: r.durationMs,
      lanes: r.lanes,
      statusHistogram: r.statusHistogram,
      counters: r.counters,
      invariants: r.invariants,
      advisories: r.advisories,
      observations: r.observations,
      replay: r.replay,
    })),
    advisoryMisses,
  };
  const path = `${dir}results.json`;
  await Deno.writeTextFile(path, JSON.stringify(table, null, 2));
  console.log(
    `[stress] results: ${table.totals.iterations} iterations / ${table.totals.requests} requests / ${table.totals.held} HELD / ${table.totals.broken} BROKEN / ${table.totals.advisoryMisses} advisory misses → ${path}`,
  );
  assert(results.length > 0, "stress: no iterations ran");
});
