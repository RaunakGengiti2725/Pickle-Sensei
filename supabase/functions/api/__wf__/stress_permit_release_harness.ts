/**
 * stress_permit_release_harness — seeded concurrency campaign for
 *
 *   POST /v1/analysis-permits/:id/finalize   (release: cancelled | failed |
 *                                             low_confidence | unsupported |
 *                                             incorrect_recognition)
 *   POST /v1/shots:sync                      (consume: the ONLY path that
 *                                             turns a permit into `scored`)
 *
 * against the REAL edge handler (supabase/functions/api/index.ts) loaded
 * in-process, over the modelled Supabase from xc_concurrency_harness.ts.
 *
 * Why a separate fake: the xc model answers every PostgREST PATCH with a bare
 * 204. supabase-js 2.112.4 `.update().select().maybeSingle()` then sees no
 * body and the finalize route ALWAYS takes its "lost the race → re-read the
 * settled row" branch, so the primary path (UPDATE … RETURNING one row) was
 * never exercised. StressFake answers PATCH like PostgREST does — the filtered
 * rows are mutated atomically and returned as a JSON array under
 * `Prefer: return=representation` (0 rows → `[]` → data null → race-loser
 * branch, exactly like a real `UPDATE … WHERE status='reserved'` that hit 0).
 *
 * It also adds: seeded per-call jitter ("chaos") that widens the window
 * between the route's SELECT and its UPDATE, a pg_cron-equivalent sweep of
 * expired permits, and a running maximum of concurrently-live reserved
 * permits per user (the "no double spend of the two free ratings" witness).
 *
 * Every iteration is replayable: STRESS_SEED (base) + iteration index seeds
 * the fake's latency PRNG, the scenario PRNG (inputs, burst size, which
 * outcomes, where the logout/refresh/sweep lands in the burst) and the user
 * ids. Interleavings are timer-driven, so a seed fixes the DISTRIBUTION of
 * interleavings, not one exact schedule — that is why the campaign runner
 * re-runs a failing seed 10× and reports the rate.
 */
import {
  bootstrap,
  edgeRequest,
  envInt,
  FakeSupabase,
  histogram,
  type Invariant,
  isRecord,
  Prng,
  readJson,
  sleep,
  SUPABASE_URL,
  syncShotPayload,
  type XcHarness,
} from "./xc_concurrency_harness.ts";

const ANON_KEY = "xc-anon-key";
const SERVICE_ROLE_KEY = "xc-service-role-key";
const WEBHOOK_SECRET = "xc-webhook-secret";

export const STRESS_SEED = envInt("STRESS_SEED", 20260904);
/** Iterations per campaign. Small by default so the suite stays fast; the
 * evidence run uses STRESS_ITER=600. */
export const STRESS_ITER = envInt("STRESS_ITER", 40);
export const STRESS_LATENCY_MS = envInt("STRESS_LATENCY_MS", 8);
/** Bounded wall time per iteration — exceeding it is recorded as a deadlock /
 * unbounded-latency failure, never waited out. */
export const STRESS_TIMEOUT_MS = envInt("STRESS_TIMEOUT_MS", 20_000);
export const STRESS_SCENARIO = Deno.env.get("STRESS_SCENARIO") ?? "";
export const STRESS_REPEAT = envInt("STRESS_REPEAT", 1);

export const RELEASABLE_OUTCOMES = [
  "low_confidence",
  "cancelled",
  "failed",
  "unsupported",
  "incorrect_recognition",
] as const;
export type Releasable = (typeof RELEASABLE_OUTCOMES)[number];

const PERMIT_LIFETIME_MS = 24 * 3_600_000;

// ── The fake ─────────────────────────────────────────────────────────────────

export class StressFake extends FakeSupabase {
  /** Extra seeded jitter (ms, max) applied to every PostgREST call. */
  chaosMaxMs = 0;
  /** user id → max number of live (reserved, unexpired) permits seen at once. */
  maxLiveReserved = new Map<string, number>();
  patchLog: Array<{ who: string | null; matched: number; set: Record<string, unknown> }> = [];
  /** Number of reset()s so far. The real handler keeps per-isolate state that
   * outlives the fake (rate-limit buckets keyed by user id / IP), so actors
   * of the n-th iteration in this process are namespaced by n — a seed
   * replayed 10× (STRESS_REPEAT) must not spend one user's 60s budgets. */
  runs = 0;

  override reset(seed: number, latencyMaxMs = this.latencyMaxMs): void {
    super.reset(seed, latencyMaxMs);
    this.runs += 1;
    this.chaosMaxMs = 0;
    this.maxLiveReserved = new Map();
    this.patchLog = [];
  }

  liveReserved(userId: string): number {
    const cutoff = Date.now() - PERMIT_LIFETIME_MS;
    return this.tables.analysis_permits.filter(
      (p) =>
        p.user_id === userId &&
        p.status === "reserved" &&
        new Date(p.created_at as string).getTime() > cutoff,
    ).length;
  }

  /** Sample every user's live-reserved count; keeps the running maximum. */
  sample(): void {
    for (const userId of this.users.keys()) {
      const live = this.liveReserved(userId);
      if (live > (this.maxLiveReserved.get(userId) ?? 0)) {
        this.maxLiveReserved.set(userId, live);
      }
    }
  }

  /** pg_cron equivalent (migration 20260831000000): release stragglers. */
  sweepExpired(): number {
    const cutoff = Date.now() - PERMIT_LIFETIME_MS;
    let n = 0;
    for (const p of this.tables.analysis_permits) {
      if (p.status === "reserved" && new Date(p.created_at as string).getTime() <= cutoff) {
        p.status = "released";
        p.outcome = "expired";
        n += 1;
      }
    }
    this.log("cron.sweep", `released ${n} expired permit(s)`);
    return n;
  }

  override async handleFetch(request: Request, rawBody: string): Promise<Response> {
    const url = new URL(request.url);
    const isRest = url.origin === SUPABASE_URL && url.pathname.startsWith("/rest/v1/");
    if (isRest && request.method === "PATCH" && url.pathname === "/rest/v1/analysis_permits") {
      return await this.patchPermits(request, rawBody, url);
    }
    if (isRest && this.chaosMaxMs > 0) {
      await sleep(this.prng.int(0, this.chaosMaxMs));
    }
    const response = await super.handleFetch(request, rawBody);
    this.sample();
    return response;
  }

  private async patchPermits(request: Request, rawBody: string, url: URL): Promise<Response> {
    this.count("rest.patch.analysis_permits");
    const who = this.principal(request.headers);
    // Transport + lock-wait latency, THEN one atomic statement.
    await sleep(this.prng.int(0, this.latencyMaxMs + this.chaosMaxMs));
    let set: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(rawBody);
      if (isRecord(parsed)) set = parsed;
    } catch {
      set = {};
    }
    this.sample();
    let rows: Array<Record<string, unknown>>;
    if (who.role === "service") rows = this.tables.analysis_permits;
    else if (who.role === "user" && who.userId) {
      rows = this.tables.analysis_permits.filter((r) => r.user_id === who.userId);
    } else rows = [];
    for (const [col, raw] of url.searchParams.entries()) {
      if (["select", "order", "limit", "offset", "columns"].includes(col)) continue;
      if (!raw.startsWith("eq.")) {
        throw new Error(`stress harness: unsupported PATCH filter ${col}=${raw}`);
      }
      const v = raw.slice(3);
      rows = rows.filter((r) => String(r[col]) === v);
    }
    // Column-level grant (20260831160000_defense_in_depth): only status/outcome.
    for (const col of Object.keys(set)) {
      if (col !== "status" && col !== "outcome") {
        return new Response(
          JSON.stringify({ code: "42501", message: `permission denied for column ${col}` }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }
    }
    for (const r of rows) Object.assign(r, set, { updated_at: new Date().toISOString() });
    this.patchLog.push({ who: who.userId, matched: rows.length, set });
    this.log(
      "rest.patch.analysis_permits",
      `who=${who.userId ?? who.role} matched=${rows.length} set=${JSON.stringify(set)} where=${url.search}`,
    );
    this.sample();
    const prefer = request.headers.get("prefer") ?? "";
    if (prefer.includes("return=representation")) {
      return new Response(JSON.stringify(rows.map((r) => ({ ...r }))), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(null, { status: 204 });
  }

  /** Age a permit so the server sees it expired (clock skew / stale hold). */
  agePermit(permitId: string, ageMs: number): void {
    const row = this.tables.analysis_permits.find((p) => p.id === permitId);
    if (!row) throw new Error(`agePermit: ${permitId} not found`);
    row.created_at = new Date(Date.now() - ageMs).toISOString();
    this.log("clock.skew", `permit ${permitId} created_at ← now-${ageMs}ms`);
  }

  grantPremium(userId: string): void {
    this.tables.billing_entitlements.push({
      user_id: userId,
      premium: true,
      product_key: "pickle_sensei_pro_monthly",
      expires_at: null,
      verified_at: new Date().toISOString(),
    });
  }
}

// ── Loading the real handler ─────────────────────────────────────────────────

export interface StressHarness extends XcHarness {
  fake: StressFake;
}

let loaded: StressHarness | null = null;

export async function loadStressHarness(): Promise<StressHarness> {
  if (loaded) return loaded;
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", WEBHOOK_SECRET);
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_stress");
  Deno.env.delete("UPSTASH_REDIS_REST_URL");
  Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");

  const fake = new StressFake(1, 0);
  const upstreamCalls: XcHarness["upstreamCalls"] = [];
  const t0 = performance.now();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const rawBody = await request.text().catch(() => "");
    upstreamCalls.push({
      t: Math.round((performance.now() - t0) * 100) / 100,
      method: request.method,
      url: request.url,
    });
    return fake.handleFetch(request, rawBody);
  }) as typeof fetch;

  let handler: XcHarness["handler"] | null = null;
  const realServe = Deno.serve;
  (Deno as unknown as { serve: unknown }).serve = (...args: unknown[]) => {
    const fn = args.find((arg) => typeof arg === "function") as XcHarness["handler"] | undefined;
    if (!fn) throw new Error("Deno.serve called without a handler");
    handler = fn;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
  };
  await import("../index.ts");
  (Deno as unknown as { serve: unknown }).serve = realServe;
  if (!handler) throw new Error("index.ts did not register a Deno.serve handler");
  loaded = { handler, fake, upstreamCalls };
  return loaded;
}

// ── Request helpers ──────────────────────────────────────────────────────────

export interface Call {
  op: string;
  status: number;
  code: string | null;
  ms: number;
  body: Record<string, unknown>;
}

export interface Actor {
  sub: string;
  accessToken: string;
  refreshToken: string;
  ip: string;
}

export function ipFor(seed: number, lane: number, run = 0): string {
  return `10.${(seed >>> 16) & 255}.${(seed + run) & 255}.${(seed + lane) & 255}`;
}

/** A seeded user id whose last group encodes the process-local run number:
 * the seeded draws stay identical across replays while the real handler's
 * per-user buckets see a fresh identity each time. */
export function subFor(prng: Prng, run: number): string {
  const base = prng.uuid();
  return `${base.slice(0, 24)}${(run >>> 0).toString(16).padStart(12, "0")}`;
}

export async function actorFor(h: StressHarness, sub: string, ip: string): Promise<Actor> {
  const boot = await bootstrap(h, sub, ip);
  if (boot.status !== 200 || !boot.accessToken) {
    throw new Error(`bootstrap failed: ${boot.status} ${JSON.stringify(boot.body)}`);
  }
  return { sub, accessToken: boot.accessToken, refreshToken: boot.refreshToken, ip };
}

export function errorCode(body: Record<string, unknown>): string | null {
  const err = body.error;
  return isRecord(err) && typeof err.code === "string" ? err.code : null;
}

export async function call(
  h: StressHarness,
  calls: Call[],
  op: string,
  request: Request,
): Promise<Call> {
  const t0 = performance.now();
  const response = await h.handler(request);
  const body = await readJson(response);
  const out: Call = {
    op,
    status: response.status,
    code: errorCode(body),
    ms: Math.round((performance.now() - t0) * 100) / 100,
    body,
  };
  calls.push(out);
  return out;
}

export const finalize = (
  h: StressHarness,
  calls: Call[],
  actor: Actor,
  permitId: string,
  outcome: string,
  op = "finalize",
  token = actor.accessToken,
) =>
  call(
    h,
    calls,
    op,
    edgeRequest("POST", `/v1/analysis-permits/${permitId}/finalize`, {
      token,
      ip: actor.ip,
      body: { outcome, ratingId: null },
    }),
  );

export const reserve = (
  h: StressHarness,
  calls: Call[],
  actor: Actor,
  key: string,
  op = "reserve",
) =>
  call(
    h,
    calls,
    op,
    edgeRequest("POST", "/v1/analysis-permits", {
      token: actor.accessToken,
      ip: actor.ip,
      body: { idempotencyKey: key },
    }),
  );

export const syncShot = (
  h: StressHarness,
  calls: Call[],
  actor: Actor,
  shotId: string,
  permitId: string,
  overrides: Record<string, unknown> = {},
  op = "sync",
) =>
  call(
    h,
    calls,
    op,
    edgeRequest("POST", "/v1/shots:sync", {
      token: actor.accessToken,
      ip: actor.ip,
      body: { shots: [syncShotPayload(shotId, permitId, overrides)] },
    }),
  );

export const access = (h: StressHarness, calls: Call[], actor: Actor, op = "access") =>
  call(
    h,
    calls,
    op,
    edgeRequest("GET", "/v1/me/access", { token: actor.accessToken, ip: actor.ip }),
  );

export const logout = (h: StressHarness, calls: Call[], actor: Actor, op = "logout") =>
  call(
    h,
    calls,
    op,
    edgeRequest("POST", "/v1/auth/logout", { token: actor.accessToken, ip: actor.ip, body: {} }),
  );

export const refresh = (h: StressHarness, calls: Call[], actor: Actor, op = "refresh") =>
  call(
    h,
    calls,
    op,
    edgeRequest("POST", "/v1/auth/refresh", {
      ip: actor.ip,
      body: { refreshToken: actor.refreshToken },
    }),
  );

export function permitOf(c: Call): Record<string, unknown> | null {
  return isRecord(c.body.permit) ? c.body.permit : null;
}

/** The access payload: nested under `access` on permit routes, top-level on
 * GET /v1/me/access. */
export function accessOf(c: Call): Record<string, unknown> | null {
  if (isRecord(c.body.access)) return c.body.access;
  return isRecord(c.body.freeRatings) ? c.body : null;
}

export function freeRatingsOf(c: Call): Record<string, number> | null {
  const a = accessOf(c);
  const fr = a && isRecord(a.freeRatings) ? a.freeRatings : null;
  return fr ? (fr as Record<string, number>) : null;
}

export function acceptedIds(c: Call): string[] {
  return Array.isArray(c.body.acceptedIds) ? (c.body.acceptedIds as string[]) : [];
}

export function rejectedCodes(c: Call): string[] {
  const rej = Array.isArray(c.body.rejected) ? (c.body.rejected as Array<{ code: string }>) : [];
  return rej.map((r) => r.code);
}

export function permitRow(h: StressHarness, permitId: string): Record<string, unknown> | undefined {
  return h.fake.tables.analysis_permits.find((p) => p.id === permitId);
}

// ── Scenario runner ──────────────────────────────────────────────────────────

export interface IterationContext {
  h: StressHarness;
  seed: number;
  prng: Prng;
  calls: Call[];
  invariants: Invariant[];
  observations: Record<string, unknown>;
  inv: (name: string, holds: boolean, detail?: string) => void;
  burst: <T>(tasks: Array<() => Promise<T>>) => Promise<T[]>;
  /** Fresh seeded actor identity (see subFor). */
  sub: () => string;
  /** Seeded client IP for a lane (see ipFor). */
  ip: (lane: number) => string;
}

export interface IterationResult {
  seed: number;
  scenario: string;
  ok: boolean;
  timedOut: boolean;
  durationMs: number;
  requests: number;
  statusHistogram: Record<string, number>;
  codeHistogram: Record<string, number>;
  invariants: Invariant[];
  failed: string[];
  observations: Record<string, unknown>;
  chaosMaxMs: number;
  /** conditional UPDATEs issued by the route vs. how many matched a row —
   * attempts − matched = lanes that lost the SELECT→UPDATE race and took the
   * re-read branch. */
  updateAttempts: number;
  updateMatched: number;
  /** only populated for failed iterations — the fake's timeline + calls */
  trace?: {
    timeline: Array<{ t: number; op: string; detail: string }>;
    calls: Array<Omit<Call, "body"> & { body: Record<string, unknown> }>;
    permits: Array<Record<string, unknown>>;
    shots: Array<Record<string, unknown>>;
    patchLog: StressFake["patchLog"];
  };
}

export type Scenario = (ctx: IterationContext) => Promise<void>;

export async function runIteration(
  h: StressHarness,
  scenarioName: string,
  scenario: Scenario,
  seed: number,
): Promise<IterationResult> {
  h.fake.reset(seed, STRESS_LATENCY_MS);
  const prng = new Prng((seed ^ 0x9e3779b9) >>> 0);
  // Half the seeds add jitter up to 3× the base latency on every upstream call
  // so SELECT→UPDATE windows of different lanes genuinely straddle each other.
  const chaosMaxMs = prng.int(0, 1) === 1 ? prng.int(1, Math.max(1, STRESS_LATENCY_MS * 3)) : 0;
  h.fake.chaosMaxMs = chaosMaxMs;

  const calls: Call[] = [];
  const invariants: Invariant[] = [];
  const observations: Record<string, unknown> = {};
  const inv = (name: string, holds: boolean, detail = "") => {
    invariants.push({ name, holds, detail });
  };
  // Seeded scheduler: the burst order is a seeded permutation and each lane
  // gets a seeded 0..latency start offset before it hits the handler.
  const burst = async <T>(tasks: Array<() => Promise<T>>): Promise<T[]> => {
    const order = prng.shuffle(tasks.map((_, i) => i));
    const offsets = tasks.map(() => prng.int(0, STRESS_LATENCY_MS));
    const results: T[] = new Array(tasks.length);
    await Promise.all(
      order.map(async (i) => {
        if (offsets[i] > 0) await sleep(offsets[i]);
        results[i] = await tasks[i]();
      }),
    );
    return results;
  };
  const run = h.fake.runs;
  const ctx: IterationContext = {
    h,
    seed,
    prng,
    calls,
    invariants,
    observations,
    inv,
    burst,
    sub: () => subFor(prng, run),
    ip: (lane) => ipFor(seed, lane, run),
  };

  const t0 = performance.now();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), STRESS_TIMEOUT_MS);
  });
  try {
    const outcome = await Promise.race([scenario(ctx).then(() => "done" as const), guard]);
    if (outcome === "timeout") {
      timedOut = true;
      inv(
        "bounded wall time (no deadlock)",
        false,
        `iteration exceeded ${STRESS_TIMEOUT_MS}ms with ${calls.length} calls completed`,
      );
    }
  } catch (error) {
    inv("scenario ran without throwing", false, String(error));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const durationMs = Math.round((performance.now() - t0) * 100) / 100;
  inv(
    "no 5xx from the edge",
    calls.every((c) => c.status < 500),
    JSON.stringify(histogram(calls.map((c) => c.status))),
  );
  const slowest = calls.reduce((m, c) => Math.max(m, c.ms), 0);
  inv(
    `no request slower than ${STRESS_TIMEOUT_MS / 2}ms`,
    slowest < STRESS_TIMEOUT_MS / 2,
    `slowest=${slowest}ms`,
  );
  const failed = invariants.filter((i) => !i.holds).map((i) => `${i.name}: ${i.detail}`);
  const result: IterationResult = {
    seed,
    scenario: scenarioName,
    ok: failed.length === 0,
    timedOut,
    durationMs,
    requests: calls.length,
    statusHistogram: histogram(calls.map((c) => c.status)),
    codeHistogram: histogram(calls.map((c) => c.code ?? `${c.status}`)),
    invariants,
    failed,
    observations,
    chaosMaxMs,
    updateAttempts: h.fake.patchLog.length,
    updateMatched: h.fake.patchLog.reduce((n, p) => n + p.matched, 0),
  };
  if (!result.ok) {
    result.trace = {
      timeline: [...h.fake.timeline],
      calls: calls.map((c) => ({ ...c })),
      permits: h.fake.tables.analysis_permits.map((p) => ({ ...p })),
      shots: h.fake.tables.shots.map((s) => ({ ...s })),
      patchLog: [...h.fake.patchLog],
    };
  }
  return result;
}

export interface CampaignReport {
  campaign: string;
  file: string;
  handler: string;
  seedBase: number;
  iterations: number;
  latencyMs: number;
  timeoutMs: number;
  scenarios: string[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  executed: number;
  passed: number;
  failed: number;
  totalRequests: number;
  /** across all iterations: how often the route's UPDATE … WHERE status='reserved' hit 0 rows */
  raceLoserBranches: number;
  perScenario: Record<
    string,
    { executed: number; passed: number; failed: number; requests: number }
  >;
  statusHistogram: Record<string, number>;
  codeHistogram: Record<string, number>;
  failedSeeds: Array<{ seed: number; scenario: string; failed: string[]; replay: string }>;
  results: IterationResult[];
  heap: { before: Deno.MemoryUsage; after: Deno.MemoryUsage };
  note: string;
  /** Where the JSON report + seed table were written. */
  path: string;
}

export function summarize(report: CampaignReport): string {
  return `[stress] ${report.campaign}: ${report.passed}/${report.executed} iterations ok, ${report.totalRequests} requests, ${report.raceLoserBranches} lost-UPDATE re-reads, ${report.durationMs}ms → ${report.path}`;
}

export function replayCommand(file: string, scenario: string, seed: number): string {
  return `STRESS_SEED=${seed} STRESS_ITER=1 STRESS_SCENARIO=${scenario} STRESS_LATENCY_MS=${STRESS_LATENCY_MS} deno test -A --no-check --config deno.json ${file}`;
}

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-permit-release/latest/", import.meta.url).pathname;
}

export async function writeCampaign(report: CampaignReport): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${report.campaign}.json`;
  await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
  // Compact seed → outcome table beside the full report.
  const table = report.results.map((r) => ({
    seed: r.seed,
    scenario: r.scenario,
    ok: r.ok,
    timedOut: r.timedOut,
    ms: r.durationMs,
    requests: r.requests,
    statuses: r.statusHistogram,
    failed: r.failed,
  }));
  await Deno.writeTextFile(`${dir}${report.campaign}.seeds.json`, JSON.stringify(table, null, 1));
  return path;
}

/** Run `iterations` seeded iterations round-robin over `scenarios`. With
 * STRESS_SCENARIO set only that scenario runs (replay). */
export async function runCampaign(
  campaign: string,
  file: string,
  scenarios: Record<string, Scenario>,
  options: { iterations?: number; seedBase?: number } = {},
): Promise<CampaignReport> {
  const h = await loadStressHarness();
  const names = Object.keys(scenarios).filter((n) => !STRESS_SCENARIO || n === STRESS_SCENARIO);
  if (names.length === 0) {
    throw new Error(`STRESS_SCENARIO=${STRESS_SCENARIO} matches none of ${Object.keys(scenarios)}`);
  }
  const iterations = options.iterations ?? STRESS_ITER;
  const seedBase = options.seedBase ?? STRESS_SEED;
  const before = Deno.memoryUsage();
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const results: IterationResult[] = [];
  for (let i = 0; i < iterations; i++) {
    const seed = (seedBase + i) >>> 0;
    const name = names[i % names.length];
    for (let rep = 0; rep < STRESS_REPEAT; rep++) {
      results.push(await runIteration(h, name, scenarios[name], seed));
    }
  }
  const after = Deno.memoryUsage();
  const perScenario: CampaignReport["perScenario"] = {};
  for (const r of results) {
    const s = (perScenario[r.scenario] ??= { executed: 0, passed: 0, failed: 0, requests: 0 });
    s.executed += 1;
    s.requests += r.requests;
    if (r.ok) s.passed += 1;
    else s.failed += 1;
  }
  const allStatuses: number[] = [];
  const allCodes: string[] = [];
  for (const r of results) {
    for (const [k, v] of Object.entries(r.statusHistogram))
      for (let j = 0; j < v; j++) allStatuses.push(Number(k));
    for (const [k, v] of Object.entries(r.codeHistogram))
      for (let j = 0; j < v; j++) allCodes.push(k);
  }
  const report: CampaignReport = {
    campaign,
    file,
    handler: "supabase/functions/api/index.ts (real Deno.serve handler, in-process)",
    seedBase,
    iterations: results.length,
    latencyMs: STRESS_LATENCY_MS,
    timeoutMs: STRESS_TIMEOUT_MS,
    scenarios: names,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - t0),
    executed: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    totalRequests: results.reduce((n, r) => n + r.requests, 0),
    raceLoserBranches: results.reduce((n, r) => n + (r.updateAttempts - r.updateMatched), 0),
    perScenario,
    statusHistogram: histogram(allStatuses),
    codeHistogram: histogram(allCodes),
    failedSeeds: results
      .filter((r) => !r.ok)
      .map((r) => ({
        seed: r.seed,
        scenario: r.scenario,
        failed: r.failed,
        replay: replayCommand(file, r.scenario, r.seed),
      })),
    results,
    heap: { before, after },
    note:
      "Seeds fix inputs, burst permutation, lane start offsets and every modelled upstream latency draw; " +
      "the event loop still decides exact interleavings, so a failing seed is re-run (STRESS_REPEAT) to report a rate.",
    path: "",
  };
  report.path = await writeCampaign(report);
  return report;
}
