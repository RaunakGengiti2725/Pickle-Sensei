/**
 * stress: route-get-v1-me / lens concurrency — GET /v1/me under Promise.all
 * bursts against the REAL edge handler (../index.ts via Deno.serve capture,
 * stubbed Supabase Auth + PostgREST + RevenueCat, Upstash absent → L1 cache).
 *
 * Every scenario runs STRESS_ITER interleavings. One interleaving = one seeded
 * burst: the per-iteration seed drives the fake's upstream latency, the
 * request order, the request start stagger, the actors' ids and the
 * perturbation point (logout / refresh / cancel / clock skew / row deletion).
 * Each interleaving is replayable on its own:
 *
 *   STRESS_REPLAY_SEED=<seed> STRESS_BURST=<b> STRESS_LATENCY_MS=<ms> \
 *     deno test -A --no-check --config deno.json \
 *     stress_route_get_v1_me_concurrency.test.ts --filter "get-v1-me <A-H>:"
 *   (`deno test --filter` matches the TEST title; each scenario's title starts
 *   with its letter, e.g. `--filter "get-v1-me H:"`)
 *
 * Scale knobs (defaults are suite-friendly; the campaign raises STRESS_ITER):
 *   STRESS_SEED        base seed (default 20260904)
 *   STRESS_ITER        interleavings per scenario (default 4)
 *   STRESS_BURST       concurrent requests per burst (default 12)
 *   STRESS_LATENCY_MS  max seeded upstream latency per call (default 6)
 *   STRESS_WALL_MS     wall-time bound per interleaving = deadlock detector
 *   STRESS_OUT_DIR     where the seed table + per-scenario reports go
 *                      (default artifacts/stress-route-get-v1-me/latest/)
 *
 * Outputs: <out>/seed_table.json (one row per interleaving: scenario, seed,
 * status histogram, broken invariants, duration, replay command) and
 * <out>/<scenario>.json (every request row with start/end, the fake's
 * upstream timeline, counters, heap).
 */
import { assert, assertEquals } from "@std/assert";
import {
  bootstrap,
  b64url,
  edgeRequest,
  envInt,
  type FakeSession,
  histogram,
  type Invariant,
  isRecord,
  loadXcHarness,
  Prng,
  readJson,
  sleep,
  SUPABASE_URL,
  type XcHarness,
} from "./xc_concurrency_harness.ts";

const STRESS_SEED = envInt("STRESS_SEED", 20260904);
const STRESS_ITER = envInt("STRESS_ITER", 4);
const STRESS_BURST = envInt("STRESS_BURST", 12);
const STRESS_LATENCY_MS = envInt("STRESS_LATENCY_MS", 6);
const STRESS_WALL_MS = envInt("STRESS_WALL_MS", 10_000);
const REPLAY_SEED = (() => {
  const raw = Deno.env.get("STRESS_REPLAY_SEED");
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n >>> 0 : null;
})();

// Budgets pinned in ../index.ts — re-derived here so an invariant that depends
// on them says WHY a 429 is (not) acceptable.
const GENERAL_USER_LIMIT = 240;
const AUTH_FAILURE_LIMIT = 30;
const RL_BURST = envInt("STRESS_RL_BURST", GENERAL_USER_LIMIT + 20);

function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-route-get-v1-me/latest/", import.meta.url).pathname;
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const iterationSeed = (scenario: string, i: number): number =>
  fnv1a(`${STRESS_SEED}:${scenario}:${i}`);

// ── Rows / reporting ─────────────────────────────────────────────────────────

interface Row {
  iter: number;
  seed: number;
  lane: number;
  op: string;
  status: number;
  code?: string;
  userId?: string;
  startedAt: number;
  endedAt: number;
  note?: string;
}

interface SeedRow {
  scenario: string;
  iter: number;
  seed: number;
  requests: number;
  statusHistogram: Record<string, number>;
  broken: string[];
  outcome: "HELD" | "BROKEN";
  durationMs: number;
  replay: string;
}

const seedTable: SeedRow[] = [];

async function writeJson(name: string, value: unknown): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}.json`;
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2));
  return path;
}

function replayCommand(scenario: string, seed: number): string {
  return `STRESS_REPLAY_SEED=${seed} STRESS_BURST=${STRESS_BURST} STRESS_LATENCY_MS=${STRESS_LATENCY_MS} deno test -A --no-check --config deno.json stress_route_get_v1_me_concurrency.test.ts --filter "get-v1-me ${scenario[0].toUpperCase()}:"`;
}

interface Ctx {
  h: XcHarness;
  prng: Prng;
  iter: number;
  seed: number;
  rows: Row[];
  inv: (name: string, holds: boolean, detail: string) => void;
  /** actor → rate-limit key, unique per (scenario, interleaving, actor). */
  ip: (actor: number) => string;
  observe: (key: string, value: unknown) => void;
  /** Scenarios that deliberately provoke the retryable 503 opt in here; every
   * other 5xx (and an unexpected 503) is a broken interleaving. */
  allow503: boolean;
}

async function call(
  ctx: Ctx,
  lane: number,
  op: string,
  request: Request,
  note?: string,
): Promise<{ status: number; body: Record<string, unknown>; row: Row }> {
  const startedAt = performance.now();
  const response = await ctx.h.handler(request);
  const body = await readJson(response);
  const err = body.error;
  const nested = isRecord(err) ? err.code : undefined;
  const user = isRecord(body.user) ? body.user : undefined;
  const row: Row = {
    iter: ctx.iter,
    seed: ctx.seed,
    lane,
    op,
    status: response.status,
    code: typeof nested === "string" ? nested : undefined,
    userId: typeof user?.id === "string" ? user.id : undefined,
    startedAt: Math.round(startedAt * 100) / 100,
    endedAt: Math.round(performance.now() * 100) / 100,
    note,
  };
  ctx.rows.push(row);
  return { status: response.status, body, row };
}

const me = (token: string, ip: string, signal?: AbortSignal) => {
  const request = edgeRequest("GET", "/v1/me", { token, ip });
  return signal ? new Request(request, { signal }) : request;
};

/** The seeded scheduler: start each lane after its own seeded stagger so the
 * burst's arrival order (and therefore which request wins each race inside
 * the handler) is a function of the seed, not of the event loop's whim. */
async function staggered<T>(ctx: Ctx, lanes: Array<() => Promise<T>>): Promise<T[]> {
  const delays = lanes.map(() => ctx.prng.int(0, STRESS_LATENCY_MS * 2));
  return await Promise.all(
    lanes.map(async (fn, i) => {
      if (delays[i] > 0) await sleep(delays[i]);
      return await fn();
    }),
  );
}

async function scenario(
  name: string,
  run: (ctx: Ctx, burst: number) => Promise<void>,
  burst = STRESS_BURST,
): Promise<void> {
  const h = await loadXcHarness();
  installProfilePatchRepresentation(h);
  const scenarioHash = fnv1a(name);
  const allRows: Row[] = [];
  const invariants: Array<Invariant & { iter: number; seed: number }> = [];
  const observations: Record<string, unknown> = {};
  const seeds = REPLAY_SEED !== null
    ? [REPLAY_SEED]
    : Array.from({ length: STRESS_ITER }, (_, i) => iterationSeed(name, i));
  const before = Deno.memoryUsage();
  const t0 = performance.now();
  for (let iter = 0; iter < seeds.length; iter++) {
    const seed = seeds[iter];
    h.fake.reset(seed, STRESS_LATENCY_MS);
    h.upstreamCalls.length = 0;
    const prng = new Prng(seed);
    const rows: Row[] = [];
    const mine: Invariant[] = [];
    const ctx: Ctx = {
      h,
      prng,
      iter,
      seed,
      rows,
      inv: (n, holds, detail) => {
        mine.push({ name: n, holds, detail });
        invariants.push({ name: n, holds, detail, iter, seed });
      },
      // clientIp() takes the last x-forwarded-for hop verbatim, so a key that
      // is unique per (scenario, interleaving, actor) keeps every per-IP
      // budget (1200/min, 30 auth failures/5 min) private to this burst.
      ip: (actor) => `stress-${scenarioHash.toString(16)}-${seed}-${actor}`,
      observe: (key, value) => {
        observations[`${key}@${seed}`] = value;
      },
      allow503: false,
    };
    const started = performance.now();
    let crashed: string | null = null;
    try {
      await run(ctx, burst);
    } catch (error) {
      crashed = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      ctx.inv("scenario body did not throw", false, crashed);
    }
    const durationMs = Math.round(performance.now() - started);
    ctx.inv(
      `bounded wall time (< ${STRESS_WALL_MS}ms, deadlock detector)`,
      durationMs < STRESS_WALL_MS,
      `${durationMs}ms for ${rows.length} requests`,
    );
    ctx.inv(
      ctx.allow503 ? "no 5xx other than the expected retryable 503" : "no 5xx",
      rows.every((r) => r.status < 500 || (ctx.allow503 && r.status === 503)),
      JSON.stringify(histogram(rows.map((r) => r.status))),
    );
    const broken = mine.filter((i) => !i.holds).map((i) => `${i.name} — ${i.detail}`);
    seedTable.push({
      scenario: name,
      iter,
      seed,
      requests: rows.length,
      statusHistogram: histogram(rows.map((r) => `${r.op}:${r.status}`)),
      broken,
      outcome: broken.length === 0 ? "HELD" : "BROKEN",
      durationMs,
      replay: replayCommand(name, seed),
    });
    allRows.push(...rows);
    if (broken.length > 0) {
      observations[`timeline@${seed}`] = h.fake.timeline;
    }
  }
  const after = Deno.memoryUsage();
  const report = {
    scenario: name,
    unit: "route-get-v1-me",
    lens: "concurrency",
    baseSeed: STRESS_SEED,
    scale: { iterations: seeds.length, burst, latencyMs: STRESS_LATENCY_MS },
    seeds,
    statusHistogram: histogram(allRows.map((r) => `${r.op}:${r.status}${r.code ? `:${r.code}` : ""}`)),
    counters: { ...h.fake.counters },
    invariants,
    observations,
    requests: allRows,
    durationMs: Math.round(performance.now() - t0),
    heap: { before, after },
  };
  const path = await writeJson(name, report);
  await writeJson("seed_table", {
    unit: "route-get-v1-me",
    lens: "concurrency",
    baseSeed: STRESS_SEED,
    scale: { iterationsPerScenario: STRESS_ITER, burst: STRESS_BURST, latencyMs: STRESS_LATENCY_MS },
    interleavings: seedTable.length,
    requests: seedTable.reduce((n, r) => n + r.requests, 0),
    held: seedTable.filter((r) => r.outcome === "HELD").length,
    broken: seedTable.filter((r) => r.outcome === "BROKEN").length,
    rows: seedTable,
  });
  const brokenRows = seedTable.filter((r) => r.scenario === name && r.outcome === "BROKEN");
  console.log(
    `[stress:get-v1-me] ${name}: ${seeds.length} interleavings, ${allRows.length} requests, ${report.durationMs}ms, ${brokenRows.length} BROKEN → ${path}`,
  );
  for (const r of brokenRows) {
    console.log(`[stress:get-v1-me]   BROKEN seed=${r.seed}: ${r.broken.join(" | ")}`);
    console.log(`[stress:get-v1-me]   replay: ${r.replay}`);
  }
  assertEquals(
    brokenRows.map((r) => r.seed),
    [],
    `${name}: ${brokenRows.length} broken interleaving(s); see ${path}`,
  );
}

/** The xc fake answers PATCH with a bare 204, but PUT /v1/me/onboarding asks
 * for `return=representation` (`.update().select().maybeSingle()`); without
 * a body the route reports 503. This wraps the fake's fetch (the file owns
 * globalThis.fetch — Deno runs each test module in its own isolate) so a
 * profiles PATCH returns the patched row exactly as PostgREST would. */
let patchWrapped = false;
function installProfilePatchRepresentation(h: XcHarness): void {
  if (patchWrapped) return;
  patchWrapped = true;
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const isProfilesPatch =
      request.method === "PATCH" &&
      url.origin === SUPABASE_URL &&
      url.pathname === "/rest/v1/profiles" &&
      (request.headers.get("prefer") ?? "").includes("return=representation");
    if (!isProfilesPatch) return inner(request);
    const response = await inner(request.clone());
    if (response.status !== 204) return response;
    const who = h.fake.principal(request.headers);
    const id = url.searchParams.get("id");
    const rows = h.fake.tables.profiles.filter(
      (r) =>
        (who.role === "service" || r.id === who.userId) &&
        (id === null || (id.startsWith("eq.") && String(r.id) === id.slice(3))),
    );
    const accept = request.headers.get("accept") ?? "";
    const body = accept.includes("application/vnd.pgrst.object+json")
      ? rows.length === 1
        ? rows[0]
        : { code: "PGRST116", message: `${rows.length} rows` }
      : rows;
    const status = accept.includes("application/vnd.pgrst.object+json") && rows.length !== 1
      ? 406
      : 200;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

// ── Profile snapshot helpers ─────────────────────────────────────────────────

const PROFILE_FIELDS = [
  "skill_level",
  "handedness",
  "primary_goal",
  "biggest_problem",
  "focus_checkpoint",
  "first_name",
  "gender",
] as const;

const GENDERS = ["female", "male", "nonbinary", "prefer_not_to_say"];

/** Write k of an interleaving: every field encodes k so a torn read (fields
 * from two different writes) is detectable in one comparison. */
function writePayload(k: number) {
  return {
    body: {
      skillLevel: `level-${k}`,
      handedness: k % 2 === 0 ? "right" : "left",
      goal: `goal-${k}`,
      biggestProblem: `problem-${k}`,
      firstName: `Name${k}`,
      gender: GENDERS[k % GENDERS.length],
    },
    expect: {
      skill_level: `level-${k}`,
      handedness: k % 2 === 0 ? "right" : "left",
      primary_goal: `goal-${k}`,
      biggest_problem: `problem-${k}`,
      focus_checkpoint: "contact_position",
      first_name: `Name${k}`,
      gender: GENDERS[k % GENDERS.length],
    } as Record<string, unknown>,
  };
}

/** Which write a snapshot belongs to: -1 for the untouched row, k for write
 * k, null when the fields do not all agree (a torn read). */
function snapshotVersion(profile: unknown): number | null {
  if (!isRecord(profile)) return null;
  if (PROFILE_FIELDS.every((f) => profile[f] === null)) return -1;
  const m = /^level-(\d+)$/.exec(String(profile.skill_level));
  if (!m) return null;
  const k = Number(m[1]);
  const expected = writePayload(k).expect;
  return PROFILE_FIELDS.every((f) => profile[f] === expected[f]) ? k : null;
}

function bodyProfile(body: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(body.profile) ? body.profile : null;
}

const emailOf = (sub: string) => `${sub.slice(0, 8)}@example.com`;

/** A session whose bearer carries an arbitrary exp (clock-skew cases). The
 * fake mints exp = now+3600 only, so the token is built here and registered
 * in the fake's indexes exactly as mintSession would. */
function mintSkewedSession(
  h: XcHarness,
  userId: string,
  expSeconds: number,
  tag: string,
): FakeSession {
  const sid = `sess-skew-${tag}-${h.fake.prng.uuid()}`;
  const accessToken = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: userId,
      aud: "authenticated",
      role: "authenticated",
      session_id: sid,
      exp: expSeconds,
      jti: `skew-${tag}-${h.fake.prng.uuid()}`,
    }),
  )}.sig`;
  const session: FakeSession = {
    sessionId: sid,
    userId,
    provider: "google",
    accessToken,
    refreshToken: `rt-skew-${tag}-${h.fake.prng.uuid()}`,
    usedRefreshTokens: new Set(),
    revoked: false,
  };
  h.fake.sessions.set(sid, session);
  h.fake.accessIndex.set(accessToken, sid);
  h.fake.refreshIndex.set(session.refreshToken, sid);
  return session;
}

// ─────────────────────────────────────────────────────────────────────────────
// A — duplicate calls: one bearer, B identical GET /v1/me at once (cold cache),
//     then the same burst warm.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("stress get-v1-me A: duplicate burst — identical bodies, own user, cold then warm cache", async () => {
  await scenario("a_duplicate_burst", async (ctx, burst) => {
    const { h, prng } = ctx;
    const sub = prng.uuid();
    const boot = await bootstrap(h, sub, ctx.ip(0));
    ctx.inv("bootstrap mints a session", boot.status === 200, `bootstrap → ${boot.status}`);
    const getUser0 = h.fake.counters["gotrue.get_user"] ?? 0;
    const profiles0 = h.fake.counters["rest.get.profiles"] ?? 0;
    const cold = await staggered(
      ctx,
      Array.from({ length: burst }, (_, i) => () => call(ctx, i, "me.cold", me(boot.accessToken, ctx.ip(0)))),
    );
    const coldGetUser = (h.fake.counters["gotrue.get_user"] ?? 0) - getUser0;
    const coldProfiles = (h.fake.counters["rest.get.profiles"] ?? 0) - profiles0;
    const bodies = new Set(cold.map((r) => JSON.stringify(r.body)));
    ctx.inv("cold burst: every duplicate → 200", cold.every((r) => r.status === 200), JSON.stringify(histogram(cold.map((r) => r.status))));
    ctx.inv("cold burst: idempotent — one identical body", bodies.size === 1, `${bodies.size} distinct bodies`);
    ctx.inv(
      "cold burst: body is this bearer's user",
      cold.every((r) => r.row.userId === sub && isRecord(r.body.user) && r.body.user.email === emailOf(sub)),
      `user.id=${cold[0]?.row.userId} sub=${sub}`,
    );
    ctx.inv("cold burst: exactly one profile read per request (no retry path)", coldProfiles === burst, `${coldProfiles} profile reads / ${burst} requests`);
    ctx.observe("coldBurstAuthVerifications", { getUserCalls: coldGetUser, requests: burst });
    const warm = await staggered(
      ctx,
      Array.from({ length: burst }, (_, i) => () => call(ctx, burst + i, "me.warm", me(boot.accessToken, ctx.ip(0)))),
    );
    const warmGetUser = (h.fake.counters["gotrue.get_user"] ?? 0) - getUser0 - coldGetUser;
    ctx.inv("warm burst: every duplicate → 200 with the same body", warm.every((r) => r.status === 200 && bodies.has(JSON.stringify(r.body))), JSON.stringify(histogram(warm.map((r) => r.status))));
    ctx.inv("warm burst: Supabase Auth consulted zero times (cache hit)", warmGetUser === 0, `${warmGetUser} getUser calls during warm burst`);
    ctx.inv("read-only route: no rows written anywhere", h.fake.tables.profiles.length === 1 && h.fake.tables.shots.length === 0 && h.fake.tables.analysis_permits.length === 0, `profiles=${h.fake.tables.profiles.length} shots=${h.fake.tables.shots.length} permits=${h.fake.tables.analysis_permits.length}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B — two actors on the same row: two devices of user A read + write the
//     profile while user C reads its own. No torn read, no cross-user body,
//     no lost update, no duplicate row.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("stress get-v1-me B: two actors on one row — reads never torn, never another user's, last write survives", async () => {
  await scenario("b_two_actors_same_row", async (ctx, burst) => {
    const { h, prng } = ctx;
    const subA = prng.uuid();
    const subC = prng.uuid();
    const [devA1, devA2, devC] = await Promise.all([
      bootstrap(h, subA, ctx.ip(1)),
      bootstrap(h, subA, ctx.ip(2)),
      bootstrap(h, subC, ctx.ip(3)),
    ]);
    ctx.inv("three sessions minted", [devA1, devA2, devC].every((b) => b.status === 200), `${devA1.status}/${devA2.status}/${devC.status}`);
    const writes = Math.max(2, Math.floor(burst / 4));
    type Lane = () => Promise<{ status: number; body: Record<string, unknown>; row: Row }>;
    const lanes: Lane[] = [];
    for (let i = 0; i < burst; i++) {
      const actor = i % 3;
      const token = actor === 0 ? devA1.accessToken : actor === 1 ? devA2.accessToken : devC.accessToken;
      const op = actor === 2 ? "me.C" : `me.A${actor + 1}`;
      lanes.push(() => call(ctx, i, op, me(token, ctx.ip(actor + 1))));
    }
    for (let k = 1; k <= writes; k++) {
      const viaA1 = k % 2 === 1;
      lanes.push(() =>
        call(
          ctx,
          burst + k,
          `onboarding.A${viaA1 ? 1 : 2}`,
          edgeRequest("PUT", "/v1/me/onboarding", {
            token: viaA1 ? devA1.accessToken : devA2.accessToken,
            ip: ctx.ip(viaA1 ? 1 : 2),
            body: writePayload(k).body,
          }),
          `write ${k}`,
        )
      );
    }
    const results = await staggered(ctx, prng.shuffle(lanes));
    const gets = results.filter((r) => r.row.op.startsWith("me."));
    const puts = results.filter((r) => r.row.op.startsWith("onboarding."));
    ctx.inv("every GET → 200", gets.every((r) => r.status === 200), JSON.stringify(histogram(gets.map((r) => r.status))));
    ctx.inv("every PUT → 200", puts.every((r) => r.status === 200), JSON.stringify(histogram(puts.map((r) => r.status))));
    const crossUser = gets.filter((r) => {
      const expectSub = r.row.op === "me.C" ? subC : subA;
      return r.row.userId !== expectSub || !isRecord(r.body.user) || r.body.user.email !== emailOf(expectSub);
    });
    ctx.inv("no GET carries another user's identity", crossUser.length === 0, `${crossUser.length} cross-user bodies`);
    const torn = gets.filter((r) => snapshotVersion(bodyProfile(r.body)) === null);
    ctx.inv("no torn read: every A snapshot is exactly one write (or untouched)", torn.length === 0, `${torn.length} torn snapshots`);
    const leakedIntoC = gets.filter((r) => r.row.op === "me.C" && snapshotVersion(bodyProfile(r.body)) !== -1);
    ctx.inv("user C never observes A's writes on its own row", leakedIntoC.length === 0, `${leakedIntoC.length} C snapshots carrying A's fields`);
    const putEcho = puts.filter((r) => r.status === 200 && snapshotVersion(bodyProfile(r.body)) === null);
    ctx.inv("PUT echoes a whole write, never a mix", putEcho.length === 0, `${putEcho.length} mixed echoes`);
    const finalA = await call(ctx, 900, "me.A1.final", me(devA1.accessToken, ctx.ip(1)));
    const finalVersion = snapshotVersion(bodyProfile(finalA.body));
    const storedRow = h.fake.tables.profiles.find((r) => r.id === subA);
    const storedVersion = snapshotVersion(Object.fromEntries(PROFILE_FIELDS.map((f) => [f, storedRow?.[f] ?? null])));
    ctx.inv(
      "no lost update: final read is one complete accepted write and equals the stored row",
      finalA.status === 200 && finalVersion !== null && finalVersion >= 1 && finalVersion === storedVersion,
      `final read version=${finalVersion} stored version=${storedVersion} of writes 1..${writes}`,
    );
    const versionsSeen = new Set(gets.map((r) => snapshotVersion(bodyProfile(r.body))));
    ctx.observe("snapshotVersionsSeen", [...versionsSeen]);
    ctx.inv("no duplicate profile rows", h.fake.tables.profiles.length === 2, `${h.fake.tables.profiles.length} rows for 2 users`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C — logout during the call: a GET burst races POST /v1/auth/logout on the
//     same bearer. Anything started after logout completed must be refused;
//     the fence must survive a verification that raced the logout.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("stress get-v1-me C: logout during in-flight GETs — refused from the next request on, no stale re-cache", async () => {
  await scenario("c_logout_during_call", async (ctx, burst) => {
    const { h, prng } = ctx;
    const sub = prng.uuid();
    const boot = await bootstrap(h, sub, ctx.ip(0));
    const warmFirst = prng.next() < 0.5;
    if (warmFirst) {
      const warm = await call(ctx, -1, "me.warm", me(boot.accessToken, ctx.ip(0)));
      ctx.inv("warm-up GET → 200", warm.status === 200, `→ ${warm.status}`);
    }
    // Slow verification of THIS bearer models the classic write-after-revoke
    // race: getUser answers before the logout, the bytes land after it.
    const slowVerify = prng.next() < 0.5 ? prng.int(STRESS_LATENCY_MS, STRESS_LATENCY_MS * 4) : 0;
    h.fake.overrides.getUserDelayMs = (bearer) => (bearer === boot.accessToken ? slowVerify : 0);
    h.fake.overrides.logoutDelayMs = prng.int(0, STRESS_LATENCY_MS * 2);
    ctx.observe("setup", { warmFirst, slowVerify, logoutDelayMs: h.fake.overrides.logoutDelayMs });
    let logoutEndedAt = Number.POSITIVE_INFINITY;
    let logoutStatus = 0;
    const logoutAt = prng.int(0, burst - 1);
    type Lane = () => Promise<{ status: number; body: Record<string, unknown>; row: Row }>;
    const lanes: Lane[] = Array.from({ length: burst }, (_, i) => () => call(ctx, i, "me", me(boot.accessToken, ctx.ip(0))));
    lanes.splice(logoutAt, 0, async () => {
      const res = await call(ctx, 500, "logout", edgeRequest("POST", "/v1/auth/logout", { token: boot.accessToken, ip: ctx.ip(0) }));
      logoutEndedAt = res.row.endedAt;
      logoutStatus = res.status;
      return res;
    });
    const results = await staggered(ctx, lanes);
    const gets = results.filter((r) => r.row.op === "me");
    ctx.inv("logout → 204", logoutStatus === 204, `→ ${logoutStatus}`);
    const failures401 = gets.filter((r) => r.status === 401).length;
    const afterLogout = gets.filter((r) => r.row.startedAt >= logoutEndedAt);
    const staleAfter = afterLogout.filter((r) => r.status === 200);
    ctx.inv(
      "every GET started after logout completed is refused (401)",
      staleAfter.length === 0 && afterLogout.every((r) => r.status === 401 || (r.status === 429 && failures401 >= AUTH_FAILURE_LIMIT)),
      `${staleAfter.length} stale 200s / ${afterLogout.length} post-logout GETs; histogram ${JSON.stringify(histogram(afterLogout.map((r) => r.status)))}`,
    );
    const before = gets.filter((r) => r.row.endedAt <= results.find((x) => x.row.op === "logout")!.row.startedAt);
    ctx.inv("every GET finished before logout began was served (200)", before.every((r) => r.status === 200), `${before.filter((r) => r.status !== 200).length} refused / ${before.length}`);
    ctx.inv("in-flight GETs are 200 or 401, never anything else", gets.every((r) => r.status === 200 || r.status === 401 || r.status === 429), JSON.stringify(histogram(gets.map((r) => r.status))));
    ctx.inv("no GET carries another user", gets.filter((r) => r.status === 200).every((r) => r.row.userId === sub), "");
    // The fence must hold once the burst has settled: the bearer, a re-issued
    // copy of it, and its refresh token are all dead.
    h.fake.overrides.getUserDelayMs = undefined;
    const settled = await Promise.all([
      call(ctx, 600, "me.after_logout", me(boot.accessToken, ctx.ip(4))),
      call(ctx, 601, "me.after_logout", me(boot.accessToken, ctx.ip(4))),
      call(ctx, 602, "refresh.after_logout", edgeRequest("POST", "/v1/auth/refresh", { ip: ctx.ip(4), body: { refreshToken: boot.refreshToken } })),
    ]);
    ctx.inv("after the burst: bearer and refresh token are refused", settled.every((r) => r.status === 401), JSON.stringify(settled.map((r) => r.status)));
    const getUserAfterLogout = h.fake.timeline.filter((e) => e.op === "gotrue.get_user" && e.detail.includes("→ 200")).length;
    ctx.observe("getUser200s", getUserAfterLogout);
    ctx.inv("read-only route: no rows written", h.fake.tables.profiles.length === 1 && h.fake.tables.shots.length === 0, `profiles=${h.fake.tables.profiles.length}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D — rotation during the call: POST /v1/auth/refresh lands mid-burst; lanes
//     scheduled after it bear the new access token.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("stress get-v1-me D: refresh rotation mid-burst — old and new bearers both serve the same user", async () => {
  await scenario("d_rotation_during_call", async (ctx, burst) => {
    const { h, prng } = ctx;
    const sub = prng.uuid();
    const boot = await bootstrap(h, sub, ctx.ip(0));
    let resolveRotated!: (v: { accessToken: string; status: number }) => void;
    const rotated = new Promise<{ accessToken: string; status: number }>((resolve) => (resolveRotated = resolve));
    let refreshStarted = false;
    const refreshAt = prng.int(0, burst - 1);
    type Lane = () => Promise<{ status: number; body: Record<string, unknown>; row: Row }>;
    const lanes: Lane[] = Array.from({ length: burst }, (_, i) => async () => {
      // lanes scheduled after the rotation point that find it in flight wait
      // for it and bear the new token; the rest keep the pre-rotation bearer
      if (i > refreshAt && refreshStarted) {
        const r = await rotated;
        if (r.status === 200) return call(ctx, i, "me.new_bearer", me(r.accessToken, ctx.ip(0)));
      }
      return call(ctx, i, "me.old_bearer", me(boot.accessToken, ctx.ip(0)));
    });
    lanes.splice(refreshAt, 0, async () => {
      refreshStarted = true;
      const res = await call(ctx, 500, "refresh", edgeRequest("POST", "/v1/auth/refresh", { ip: ctx.ip(0), body: { refreshToken: boot.refreshToken } }));
      resolveRotated({
        status: res.status,
        accessToken: isRecord(res.body.session) ? String(res.body.session.accessToken) : "",
      });
      return res;
    });
    const results = await staggered(ctx, lanes);
    const gets = results.filter((r) => r.row.op.startsWith("me."));
    const refresh = ctx.rows.find((r) => r.op === "refresh");
    ctx.inv("refresh → 200 (rotation happened)", refresh?.status === 200, `→ ${refresh?.status}`);
    ctx.inv("every GET (old or new bearer) → 200", gets.every((r) => r.status === 200), JSON.stringify(histogram(gets.map((r) => `${r.row.op}:${r.status}`))));
    ctx.inv("every GET is the same user", gets.every((r) => r.row.userId === sub), `${gets.filter((r) => r.row.userId !== sub).length} mismatches`);
    const bodies = new Set(gets.map((r) => JSON.stringify(r.body)));
    ctx.inv("rotation is invisible to GET /v1/me (one identical body)", bodies.size === 1, `${bodies.size} distinct bodies`);
    ctx.observe("newBearerRequests", gets.filter((r) => r.row.op === "me.new_bearer").length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E — cancel during the call: the client aborts a seeded subset of the burst
//     mid-flight. The handler must still settle every request (no hang, no
//     unhandled rejection), and cancelled calls must not disturb the rest.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("stress get-v1-me E: client cancels mid-burst — every call settles, survivors unaffected", async () => {
  await scenario("e_cancel_during_call", async (ctx, burst) => {
    const { h, prng } = ctx;
    const sub = prng.uuid();
    const boot = await bootstrap(h, sub, ctx.ip(0));
    const profiles0 = h.fake.counters["rest.get.profiles"] ?? 0; // bootstrap reads the row once
    const cancelled = new Set<number>();
    const abortTimers: Promise<void>[] = [];
    const lanes = Array.from({ length: burst }, (_, i) => async () => {
      const controller = new AbortController();
      const cancel = prng.next() < 0.5;
      if (cancel) {
        cancelled.add(i);
        const after = prng.int(0, STRESS_LATENCY_MS * 3);
        abortTimers.push(sleep(after).then(() => controller.abort(new DOMException("client went away", "AbortError"))));
      }
      try {
        return await call(ctx, i, cancel ? "me.cancelled" : "me", me(boot.accessToken, ctx.ip(0), controller.signal));
      } catch (error) {
        ctx.rows.push({ iter: ctx.iter, seed: ctx.seed, lane: i, op: cancel ? "me.cancelled" : "me", status: -1, startedAt: 0, endedAt: 0, note: error instanceof Error ? error.message : String(error) });
        return { status: -1, body: {}, row: ctx.rows[ctx.rows.length - 1] };
      }
    });
    const results = await staggered(ctx, lanes);
    await Promise.all(abortTimers);
    const survivors = results.filter((r) => !cancelled.has(r.row.lane));
    const aborted = results.filter((r) => cancelled.has(r.row.lane));
    ctx.inv("every call settled (no hang, no rejection)", results.every((r) => r.status !== -1), `${results.filter((r) => r.status === -1).length} rejected`);
    ctx.inv("survivors → 200 with their own user", survivors.every((r) => r.status === 200 && r.row.userId === sub), JSON.stringify(histogram(survivors.map((r) => r.status))));
    ctx.inv("cancelled calls still complete server-side as 200 (abort is client-only)", aborted.every((r) => r.status === 200), JSON.stringify(histogram(aborted.map((r) => r.status))));
    const after = await call(ctx, 900, "me.after", me(boot.accessToken, ctx.ip(0)));
    ctx.inv("a request after the cancels is served", after.status === 200 && after.row.userId === sub, `→ ${after.status}`);
    const profileReads = (h.fake.counters["rest.get.profiles"] ?? 0) - profiles0;
    ctx.inv("exactly one profile read per request (cancels caused no retries)", profileReads === burst + 1, `${profileReads} reads / ${burst + 1} requests`);
    ctx.observe("cancelled", cancelled.size);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F — clock skew: bearers whose exp sits within a few seconds of the edge's
//     clock (either side), mixed into one burst. Refusal must be exactly the
//     bearer's own exp — never a 200 after exp, never a refusal before it.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("stress get-v1-me F: clock skew at the exp boundary — refused iff exp passed, valid bearers unaffected", async () => {
  await scenario("f_clock_skew", async (ctx, burst) => {
    const { h, prng } = ctx;
    const sub = prng.uuid();
    h.fake.ensureUser(sub, "google");
    const nowS = Date.now() / 1000;
    // offsets in seconds relative to now: expired, about-to-expire, valid
    const offsets = [-30, -2, -1, 0.02, 0.05, 0.3, 0.9, 1.5, 3, 8, 65, 95, 3600];
    const sessions = offsets.map((off, i) => ({
      off,
      expMs: Math.floor((nowS + off) * 1000),
      session: mintSkewedSession(h, sub, Math.floor(nowS + off), `${i}`),
    }));
    const lanes = Array.from({ length: burst }, (_, i) => {
      const pick = sessions[prng.int(0, sessions.length - 1)];
      return () => call(ctx, i, `me.exp${pick.off >= 0 ? "+" : ""}${pick.off}s`, me(pick.session.accessToken, ctx.ip(0)), String(pick.expMs));
    });
    const results = await staggered(ctx, prng.shuffle(lanes));
    // performance.now() ↔ Date.now() anchor for comparing request timing to exp
    const anchor = Date.now() - performance.now();
    const rowExp = (r: Row) => Number(r.note);
    const startedMs = (r: Row) => r.startedAt + anchor;
    const endedMs = (r: Row) => r.endedAt + anchor;
    const gets = results.map((r) => r.row);
    const failures401 = gets.filter((r) => r.status === 401).length;
    const staleOk = gets.filter((r) => startedMs(r) >= rowExp(r) && r.status === 200);
    ctx.inv("never 200 for a bearer whose exp had passed when the request started", staleOk.length === 0, `${staleOk.length} stale 200s`);
    const expiredRefused = gets.filter((r) => startedMs(r) >= rowExp(r) && !(r.status === 401 || (r.status === 429 && failures401 >= AUTH_FAILURE_LIMIT)));
    ctx.inv("expired bearers → 401", expiredRefused.length === 0, `${expiredRefused.length} expired bearers not refused; ${JSON.stringify(histogram(gets.filter((r) => startedMs(r) >= rowExp(r)).map((r) => r.status)))}`);
    const earlyRefused = gets.filter((r) => endedMs(r) + 1000 < rowExp(r) && r.status !== 200);
    ctx.inv("bearers still valid (>1s) at completion are never refused", earlyRefused.length === 0, `${earlyRefused.length} early refusals: ${JSON.stringify(earlyRefused.map((r) => [r.op, r.status]))}`);
    const boundary = gets.filter((r) => startedMs(r) < rowExp(r) && endedMs(r) + 1000 >= rowExp(r));
    ctx.observe("boundaryRequests", boundary.map((r) => ({ op: r.op, status: r.status })));
    ctx.inv("boundary bearers are 200 or 401, nothing else", boundary.every((r) => r.status === 200 || r.status === 401 || r.status === 429), JSON.stringify(histogram(boundary.map((r) => r.status))));
    ctx.inv("valid bearers carry their own user", gets.filter((r) => r.status === 200).every((r) => r.userId === sub), "");
    const messages = results.filter((r) => r.status === 401).map((r) => (isRecord(r.body.error) ? String(r.body.error.message) : String(r.body.error)));
    ctx.observe("refusalMessages", histogram(messages));
    ctx.inv("expiry refusal is the exp check, not a stale-cache or upstream verdict", messages.every((m) => m.includes("expired")), JSON.stringify(histogram(messages)));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G — rate-limit atomicity under duplicate calls: one user fires
//     GENERAL_USER_LIMIT + 20 GETs at once inside one window.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("stress get-v1-me G: 260 duplicate GETs in one window — exactly the budget succeeds, the rest 429", async () => {
  await scenario(
    "g_rate_limit_atomicity",
    async (ctx, burst) => {
      const { h, prng } = ctx;
      const sub = prng.uuid();
      // Bootstrap + burst must share one aligned 60s bucket (rateLimit.ts
      // floor(now/60s)): wait out the minute if it is about to roll.
      const remainingMs = 60_000 - (Date.now() % 60_000);
      if (remainingMs < 4_000) await sleep(remainingMs + 50);
      const bucket0 = Math.floor(Date.now() / 60_000);
      const boot = await bootstrap(h, sub, ctx.ip(0)); // counts 1 against the user budget
      const profiles0 = h.fake.counters["rest.get.profiles"] ?? 0; // bootstrap reads the row once
      const results = await staggered(ctx, Array.from({ length: burst }, (_, i) => () => call(ctx, i, "me", me(boot.accessToken, ctx.ip(0)))));
      const bucket1 = Math.floor(Date.now() / 60_000);
      const ok = results.filter((r) => r.status === 200).length;
      const limited = results.filter((r) => r.status === 429);
      ctx.observe("bucketStraddled", bucket0 !== bucket1);
      if (bucket0 === bucket1) {
        ctx.inv(`exactly ${GENERAL_USER_LIMIT - 1} GETs succeed after bootstrap spent 1 (atomic window counter)`, ok === GENERAL_USER_LIMIT - 1, `${ok} × 200, ${limited.length} × 429 of ${burst}`);
      } else {
        ctx.inv("bucket rolled mid-burst: successes never exceed two budgets", ok <= 2 * GENERAL_USER_LIMIT, `${ok} × 200`);
      }
      ctx.inv("every non-200 is a 429 (never 5xx, never 401)", results.every((r) => r.status === 200 || r.status === 429), JSON.stringify(histogram(results.map((r) => r.status))));
      ctx.inv("all 200s carry the user", results.filter((r) => r.status === 200).every((r) => r.row.userId === sub), "");
      const profileReads = (h.fake.counters["rest.get.profiles"] ?? 0) - profiles0;
      ctx.inv("429s never reach the database", profileReads === ok, `${profileReads} profile reads for ${ok} successes`);
    },
    RL_BURST,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// H — same row deleted mid-call (account deletion cascade on another device):
//     the profiles row and the auth user vanish while GETs are in flight on
//     a warm-cached bearer and on a cold one.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("stress get-v1-me H: row deleted mid-burst — never 5xx-other-than-503, never a foreign row, cold bearer refused", async () => {
  await scenario("h_row_deleted_during_call", async (ctx, burst) => {
    const { h, prng } = ctx;
    ctx.allow503 = true;
    const sub = prng.uuid();
    const [warmDev, coldDev] = await Promise.all([bootstrap(h, sub, ctx.ip(1)), bootstrap(h, sub, ctx.ip(2))]);
    const warm = await call(ctx, -1, "me.warm", me(warmDev.accessToken, ctx.ip(1)));
    ctx.inv("warm-up → 200", warm.status === 200, `→ ${warm.status}`);
    let deletedAt = Number.POSITIVE_INFINITY;
    const deleteAt = prng.int(0, burst - 1);
    type Lane = () => Promise<{ status: number; body: Record<string, unknown>; row: Row }>;
    const lanes: Lane[] = Array.from({ length: burst }, (_, i) => () =>
      call(ctx, i, i % 2 === 0 ? "me.cached_bearer" : "me.cold_bearer", me(i % 2 === 0 ? warmDev.accessToken : coldDev.accessToken, ctx.ip(1 + (i % 2)))));
    lanes.splice(deleteAt, 0, async () => {
      // auth.admin.deleteUser: GoTrue drops the user + sessions; the profiles
      // row cascades away. Modelled directly on the fake (the deleting device
      // is a third session whose own fence is the delete route's concern).
      await sleep(prng.int(0, STRESS_LATENCY_MS * 2));
      h.fake.tables.profiles = h.fake.tables.profiles.filter((r) => r.id !== sub);
      h.fake.users.delete(sub);
      for (const s of h.fake.sessions.values()) if (s.userId === sub) s.revoked = true;
      deletedAt = performance.now();
      h.fake.log("admin.delete_user", `user=${sub} cascade`);
      const row: Row = { iter: ctx.iter, seed: ctx.seed, lane: 500, op: "admin.delete_user", status: 0, startedAt: deletedAt, endedAt: deletedAt };
      ctx.rows.push(row);
      return { status: 0, body: {}, row };
    });
    const results = await staggered(ctx, lanes);
    const gets = results.filter((r) => r.row.op.startsWith("me."));
    ctx.inv("statuses ∈ {200, 401, 503}", gets.every((r) => [200, 401, 503].includes(r.status)), JSON.stringify(histogram(gets.map((r) => `${r.row.op}:${r.status}`))));
    const afterDelete = gets.filter((r) => r.row.startedAt >= deletedAt);
    ctx.inv("no 200 for a request started after the row was gone", afterDelete.every((r) => r.status !== 200), `${afterDelete.filter((r) => r.status === 200).length} / ${afterDelete.length}`);
    // The second device's bearer is cold only until one of its own requests
    // has verified with Auth (→ cached). A request that verified BEFORE the
    // delete and then found the row gone returns 503 — and has warmed the
    // cache for every later request of that bearer. Only requests that
    // started before ANY cold request verified are provably uncached.
    const coldVerifiedFrom = Math.min(
      ...gets.filter((r) => r.row.op === "me.cold_bearer" && (r.status === 200 || r.status === 503)).map((r) => r.row.startedAt),
    );
    const cold = afterDelete.filter((r) => r.row.op === "me.cold_bearer");
    const stillCold = cold.filter((r) => r.row.startedAt < coldVerifiedFrom);
    ctx.observe("coldBearer", { afterDelete: histogram(cold.map((r) => r.status)), provablyUncached: stillCold.length });
    ctx.inv("provably uncached bearer of the deleted account → 401 (Auth refuses)", stillCold.every((r) => r.status === 401), `${JSON.stringify(histogram(stillCold.map((r) => r.status)))} (${cold.length - stillCold.length} possibly cached → ${JSON.stringify(histogram(cold.filter((r) => r.row.startedAt >= coldVerifiedFrom).map((r) => r.status)))})`);
    ctx.inv("cold bearer after the delete → 503 or 401, never 200", cold.every((r) => r.status === 401 || r.status === 503), JSON.stringify(histogram(cold.map((r) => r.status))));
    // Deterministic form of the same property: a bearer that was NEVER seen
    // by this isolate (a third device's session, minted before the delete
    // and revoked with the user) must be refused by Auth, not served.
    const neverSeen = mintSkewedSession(h, sub, Math.floor(Date.now() / 1000) + 3600, "never-seen");
    neverSeen.revoked = true;
    const fresh = await call(ctx, 901, "me.never_cached_bearer", me(neverSeen.accessToken, ctx.ip(3)));
    ctx.inv("never-cached bearer of the deleted account → 401", fresh.status === 401, `→ ${fresh.status}`);
    const cached = afterDelete.filter((r) => r.row.op === "me.cached_bearer");
    const cached503 = cached.filter((r) => r.status === 503);
    ctx.observe("cachedBearerAfterDelete", histogram(cached.map((r) => r.status)));
    ctx.inv("cached bearer of the deleted account: 503 (documented ≤10 min cache window) or 401, never 200", cached.every((r) => r.status === 503 || r.status === 401), JSON.stringify(histogram(cached.map((r) => r.status))));
    // index.ts:3094-3097 documents that another device's bearer "ages out
    // within ≤10 min" and its queries hit RLS-empty rows. For GET /v1/me
    // that is readProfile()'s 400 ms retry + 503 — recorded, not asserted,
    // beyond the status set above.
    ctx.observe("cachedBearer503Latency", cached503.map((r) => Math.round(r.row.endedAt - r.row.startedAt)));
    const retryAfter = await (async () => {
      const res = await h.handler(me(warmDev.accessToken, ctx.ip(1)));
      const body = await readJson(res);
      ctx.rows.push({ iter: ctx.iter, seed: ctx.seed, lane: 900, op: "me.cached_bearer.after", status: res.status, startedAt: 0, endedAt: 0, note: res.headers.get("Retry-After") ?? undefined });
      return { status: res.status, retryAfter: res.headers.get("Retry-After"), body };
    })();
    ctx.observe("cachedBearerFollowUp", retryAfter);
    ctx.inv("cached bearer follow-up is 503 or 401, never 200", retryAfter.status === 503 || retryAfter.status === 401, `→ ${retryAfter.status} Retry-After=${retryAfter.retryAfter}`);
    ctx.inv("503 body is generic (no upstream detail)", cached503.every((r) => JSON.stringify(r.body).indexOf("PGRST") === -1 && JSON.stringify(r.body).indexOf(sub) === -1), "");
    ctx.inv("no profile row re-created by reads", h.fake.tables.profiles.length === 0, `${h.fake.tables.profiles.length} rows`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Campaign summary — the seed table already on disk plus the invariant that
// this route never touches free ratings / permits at all.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("stress get-v1-me: summary — seed table written, route never spends a permit or free rating", async () => {
  const h = await loadXcHarness();
  const spent = (h.fake.counters["rpc.reserve_analysis_permit"] ?? 0) + (h.fake.counters["rpc.apply_synced_shot"] ?? 0);
  assertEquals(spent, 0, "GET /v1/me must never reach the permit / shot RPCs");
  const dir = outDir();
  const table = JSON.parse(await Deno.readTextFile(`${dir}seed_table.json`)) as { interleavings: number; requests: number; held: number; broken: number };
  console.log(`[stress:get-v1-me] seed table: ${table.interleavings} interleavings, ${table.requests} requests, held=${table.held} broken=${table.broken} → ${dir}seed_table.json`);
  assert(table.interleavings >= (REPLAY_SEED !== null ? 1 : STRESS_ITER * 8), "every scenario contributed its interleavings");
});
