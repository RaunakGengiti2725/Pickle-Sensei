/**
 * stress — POST /v1/me/delete-request, concurrency lens: shared harness.
 *
 * Runs the REAL edge handler (index.ts, captured from Deno.serve) in-process
 * against a modelled Supabase (GoTrue + PostgREST + RevenueCat from
 * xc_concurrency_harness.ts) extended with the two tables this route writes
 * — `account_deletion_requests` (PK user_id, PostgREST upsert
 * `resolution=merge-duplicates` → INSERT … ON CONFLICT (user_id) DO UPDATE)
 * and `account_deletion_feedback` (insert-only) — plus the profiles FK both
 * carry (23503 once the account is gone) and the Auth admin deleteUser
 * cascade that delete-confirm performs. Every upstream call takes a seeded
 * latency, so a Promise.all burst interleaves differently per seed and every
 * iteration replays from `STRESS_SEED`.
 *
 * Optionally the harness routes Upstash Redis REST to harness.ts's
 * fakeUpstash() so the rate limiter / auth cache run through L2 instead of
 * the per-isolate memory window (`loadStressHarness({ redis: true })`).
 *
 * Nothing here touches a hosted project: SUPABASE_URL is a fake origin whose
 * fetch is intercepted before index.ts is imported.
 */
import {
  bootstrap,
  edgeRequest,
  FakeSupabase,
  isRecord,
  Prng,
  readJson,
  sleep,
  SUPABASE_URL,
} from "./xc_concurrency_harness.ts";
import { configureRedis, fakeUpstash, type FakeUpstash } from "./harness.ts";

export { bootstrap, edgeRequest, isRecord, Prng, readJson, sleep };

// The keys FakeSupabase.principal() recognises (module-private there).
const XC_ANON_KEY = "xc-anon-key";
const XC_SERVICE_ROLE_KEY = "xc-service-role-key";

export const DELETE_REQUEST_LIMIT = { limit: 3, windowSeconds: 3_600 };
export const CHALLENGE_TTL_MS = 15 * 60_000;
export const CONFIRM_MIN_AGE_MS = 3_000;

export const SURVEY_REASONS = [
  "not_using",
  "not_helpful",
  "scores_inaccurate",
  "technical_issues",
  "too_expensive",
  "privacy",
  "other",
] as const;
export const SURVEY_WANTED = [
  "accuracy",
  "price",
  "content",
  "stability",
  "switched",
  "nothing",
] as const;

export interface AppliedWrite {
  t: number;
  table: "account_deletion_requests" | "account_deletion_feedback";
  userId: string;
  challenge: string | null;
  kind: "insert" | "merge";
}

/** FakeSupabase + the deletion tables, their profiles FK, and admin deleteUser. */
export class DeleteRequestFake extends FakeSupabase {
  /** Order in which writes were APPLIED to the modelled tables (the fake's
   * timeline logs the same events without the challenge). */
  applied: AppliedWrite[] = [];
  adminDeletes: string[] = [];
  /** When set, the upsert into account_deletion_requests fails with this
   * PostgREST error (models a transient 5xx / 57014 / 40P01 from Postgres). */
  failUpsert: ((userId: string) => { status: number; code: string } | null) | null = null;
  private t0Applied = performance.now();

  constructor(seed: number, latencyMaxMs: number) {
    super(seed, latencyMaxMs);
    this.tables.account_deletion_requests = [];
    this.tables.account_deletion_feedback = [];
  }

  override reset(seed: number, latencyMaxMs = this.latencyMaxMs): void {
    super.reset(seed, latencyMaxMs);
    this.applied = [];
    this.adminDeletes = [];
    this.failUpsert = null;
    this.t0Applied = performance.now();
  }

  private async pause(): Promise<void> {
    if (this.latencyMaxMs > 0) await sleep(this.prng.int(0, this.latencyMaxMs));
  }

  private stamp(): number {
    return Math.round((performance.now() - this.t0Applied) * 100) / 100;
  }

  private hasProfile(userId: string): boolean {
    return this.tables.profiles.some((p) => p.id === userId);
  }

  /** The auth.users → profiles cascade (and the feedback FK's SET NULL). */
  private cascadeDeleteUser(userId: string): void {
    for (const s of this.sessions.values()) if (s.userId === userId) s.revoked = true;
    this.users.delete(userId);
    for (const table of Object.keys(this.tables)) {
      if (table === "account_deletion_feedback") {
        for (const row of this.tables[table]) if (row.user_id === userId) row.user_id = null;
        continue;
      }
      const ownerCol = table === "profiles" ? "id" : "user_id";
      this.tables[table] = this.tables[table].filter((r) => r[ownerCol] !== userId);
    }
  }

  override async handleFetch(request: Request, rawBody: string): Promise<Response> {
    const url = new URL(request.url);
    const jsonResponse = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    // Auth admin: DELETE /auth/v1/admin/users/:id (service role only).
    if (
      url.origin === SUPABASE_URL &&
      url.pathname.startsWith("/auth/v1/admin/users/") &&
      request.method === "DELETE"
    ) {
      this.count("gotrue.admin.delete_user");
      const who = this.principal(request.headers);
      await this.pause();
      if (who.role !== "service") {
        return jsonResponse(401, { code: 401, error_code: "no_authorization", msg: "forbidden" });
      }
      const userId = decodeURIComponent(url.pathname.slice("/auth/v1/admin/users/".length));
      if (!this.users.has(userId)) {
        this.log("gotrue.admin.delete_user", `user=${userId} → 404 user_not_found`);
        return jsonResponse(404, {
          code: 404,
          error_code: "user_not_found",
          msg: "User not found",
        });
      }
      this.cascadeDeleteUser(userId);
      this.adminDeletes.push(userId);
      this.log("gotrue.admin.delete_user", `user=${userId} → 200 (cascade applied)`);
      return jsonResponse(200, {});
    }

    // PostgREST writes to the two deletion tables — modelled here so the
    // profiles FK and the applied-write order are observable.
    if (
      url.origin === SUPABASE_URL &&
      request.method === "POST" &&
      (url.pathname === "/rest/v1/account_deletion_requests" ||
        url.pathname === "/rest/v1/account_deletion_feedback")
    ) {
      const table = url.pathname.slice("/rest/v1/".length) as AppliedWrite["table"];
      const who = this.principal(request.headers);
      this.count(`rest.post.${table}`);
      let row: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(rawBody);
        row = isRecord(parsed)
          ? parsed
          : Array.isArray(parsed) && isRecord(parsed[0])
            ? parsed[0]
            : {};
      } catch {
        row = {};
      }
      const prefer = request.headers.get("prefer") ?? "";
      const conflictCol = url.searchParams.get("on_conflict");
      // Statement latency: the write is applied AFTER this pause, atomically.
      await this.pause();
      if (who.role === "anon" || !who.userId) {
        return jsonResponse(401, { code: "42501", message: "permission denied" });
      }
      if (who.role === "user" && row.user_id !== who.userId) {
        return jsonResponse(403, {
          code: "42501",
          message: `new row violates row-level security policy for table "${table}"`,
        });
      }
      const userId = String(row.user_id);
      if (!this.hasProfile(userId)) {
        return jsonResponse(409, {
          code: "23503",
          message: `insert or update on table "${table}" violates foreign key constraint`,
          details: `Key (user_id)=(${userId}) is not present in table "profiles".`,
        });
      }
      if (table === "account_deletion_requests") {
        const forced = this.failUpsert?.(userId) ?? null;
        if (forced) {
          this.log(
            "rest.upsert.account_deletion_requests",
            `user=${userId} → forced ${forced.code}`,
          );
          return jsonResponse(forced.status, {
            code: forced.code,
            message: `forced ${forced.code}`,
          });
        }
        const existing = this.tables[table].find((r) => r.user_id === userId);
        const challenge = typeof row.challenge === "string" ? row.challenge : null;
        if (existing) {
          if (conflictCol !== "user_id" || !prefer.includes("resolution=merge-duplicates")) {
            return jsonResponse(409, {
              code: "23505",
              message:
                'duplicate key value violates unique constraint "account_deletion_requests_pkey"',
            });
          }
          // ON CONFLICT DO UPDATE SET <every payload column> = EXCLUDED.<col>
          Object.assign(existing, row);
          this.applied.push({ t: this.stamp(), table, userId, challenge, kind: "merge" });
          this.log(
            "rest.upsert.account_deletion_requests",
            `merged user=${userId} challenge=${challenge}`,
          );
        } else {
          this.tables[table].push({ ...row });
          this.applied.push({ t: this.stamp(), table, userId, challenge, kind: "insert" });
          this.log(
            "rest.insert.account_deletion_requests",
            `user=${userId} challenge=${challenge}`,
          );
        }
        return prefer.includes("return=representation")
          ? jsonResponse(201, [row])
          : new Response(null, { status: 201 });
      }
      // account_deletion_feedback: insert-only, no unique key besides id.
      this.tables[table].push({
        id: this.prng.uuid(),
        created_at: new Date().toISOString(),
        ...row,
      });
      this.applied.push({ t: this.stamp(), table, userId, challenge: null, kind: "insert" });
      this.log(
        "rest.insert.account_deletion_feedback",
        `user=${userId} reason=${String(row.reason)}`,
      );
      return prefer.includes("return=representation")
        ? jsonResponse(201, [row])
        : new Response(null, { status: 201 });
    }

    return super.handleFetch(request, rawBody);
  }

  deletionRows(userId?: string): Array<Record<string, unknown>> {
    const rows = this.tables.account_deletion_requests;
    return userId ? rows.filter((r) => r.user_id === userId) : rows;
  }

  feedbackRows(userId?: string | null): Array<Record<string, unknown>> {
    const rows = this.tables.account_deletion_feedback;
    return userId === undefined ? rows : rows.filter((r) => r.user_id === userId);
  }
}

// ── Loading the real handler ─────────────────────────────────────────────────

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  fake: DeleteRequestFake;
  redis: FakeUpstash | null;
  upstreamCalls: Array<{ t: number; method: string; url: string }>;
}

let loaded: StressHarness | null = null;

/** Boot index.ts once per isolate with fetch intercepted. `redis` decides
 * whether cache.ts sees Upstash configured (must be decided before the first
 * import — cache.ts reads the env at module load). */
export async function loadStressHarness(options: { redis: boolean }): Promise<StressHarness> {
  if (loaded) return loaded;
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", XC_ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", XC_SERVICE_ROLE_KEY);
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_stress");
  configureRedis(options.redis);

  const fake = new DeleteRequestFake(1, 0);
  const upstreamCalls: StressHarness["upstreamCalls"] = [];
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
  // fakeUpstash() wraps the current fetch and forwards non-Redis URLs to it.
  const redis = options.redis ? fakeUpstash() : null;

  let handler: StressHarness["handler"] | null = null;
  const realServe = Deno.serve;
  (Deno as unknown as { serve: unknown }).serve = (...args: unknown[]) => {
    const fn = args.find((arg) => typeof arg === "function") as
      StressHarness["handler"] | undefined;
    if (!fn) throw new Error("Deno.serve called without a handler");
    handler = fn;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
  };
  await import("../index.ts");
  (Deno as unknown as { serve: unknown }).serve = realServe;
  if (!handler) throw new Error("index.ts did not register a Deno.serve handler");
  loaded = { handler, fake, redis, upstreamCalls };
  return loaded;
}

// ── Seeded scheduler ─────────────────────────────────────────────────────────

export interface LaneResult {
  lane: number;
  op: string;
  /** Client-side start offset (ms into the burst) after the seeded jitter. */
  startMs: number;
  endMs: number;
  status: number | "aborted" | "hung";
  body: Record<string, unknown>;
}

/** Fire `lanes` operations as ONE Promise.all burst. Each lane starts after a
 * seeded client-side jitter (0..jitterMs), and every upstream call inside the
 * handler takes its own seeded latency, so the interleaving is a function of
 * the seed alone. `deadlineMs` bounds the whole burst — a lane that has not
 * settled by then is recorded as "hung" (the no-deadlock invariant). */
export async function burst(
  prng: Prng,
  lanes: Array<{ op: string; run: (signal: AbortSignal) => Promise<Response> }>,
  options: { jitterMs: number; deadlineMs: number; abortLane?: (lane: number) => number | null },
): Promise<LaneResult[]> {
  const t0 = performance.now();
  const stamp = () => Math.round((performance.now() - t0) * 100) / 100;
  const results: LaneResult[] = lanes.map((lane, i) => ({
    lane: i,
    op: lane.op,
    startMs: -1,
    endMs: -1,
    status: "hung",
    body: {},
  }));
  const jitters = lanes.map(() => prng.int(0, options.jitterMs));
  const aborts = lanes.map((_, i) => options.abortLane?.(i) ?? null);
  const all = Promise.all(
    lanes.map(async (lane, i) => {
      await sleep(jitters[i]);
      results[i].startMs = stamp();
      const controller = new AbortController();
      const abortAt = aborts[i];
      let abortTimer: ReturnType<typeof setTimeout> | null = null;
      if (abortAt !== null) {
        abortTimer = setTimeout(
          () => controller.abort(new DOMException("client aborted", "AbortError")),
          abortAt,
        );
      }
      try {
        const response = await lane.run(controller.signal);
        const body = await readJson(response);
        results[i].endMs = stamp();
        // The client that aborted never saw this response; the server still did the work.
        results[i].status = controller.signal.aborted ? "aborted" : response.status;
        results[i].body = body;
      } catch (error) {
        results[i].endMs = stamp();
        results[i].status = controller.signal.aborted ? "aborted" : 599;
        results[i].body = { _thrown: error instanceof Error ? error.message : String(error) };
      } finally {
        if (abortTimer !== null) clearTimeout(abortTimer);
      }
    }),
  );
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), options.deadlineMs);
  });
  const outcome = await Promise.race([all.then(() => "settled" as const), deadline]);
  if (timer !== null) clearTimeout(timer);
  if (outcome === "deadline") {
    // Leave the hung lanes marked; the caller fails the no-deadlock invariant.
    return results;
  }
  return results;
}

// ── Request helpers ──────────────────────────────────────────────────────────

export function deleteRequest(
  token: string,
  ip: string,
  body: unknown | undefined,
  signal?: AbortSignal,
): Request {
  const request = edgeRequest("POST", "/v1/me/delete-request", { token, ip, body });
  if (!signal) return request;
  return new Request(request, { signal });
}

export function deleteConfirm(token: string, ip: string, challenge: string): Request {
  return edgeRequest("POST", "/v1/me/delete-confirm", { token, ip, body: { challenge } });
}

export function logoutRequest(token: string, ip: string): Request {
  return edgeRequest("POST", "/v1/auth/logout", { token, ip, body: {} });
}

export function refreshRequest(refreshToken: string, ip: string): Request {
  return edgeRequest("POST", "/v1/auth/refresh", { ip, body: { refreshToken } });
}

/** A seeded survey in the wire shape the app sends; sometimes deliberately
 * invalid (unknown reason → the edge fn drops the survey, never the request). */
export function randomSurvey(prng: Prng): { survey: Record<string, unknown>; valid: boolean } {
  const invalidReason = prng.int(1, 12) === 1;
  const reason = invalidReason
    ? "rage_quit"
    : SURVEY_REASONS[prng.int(0, SURVEY_REASONS.length - 1)];
  const wanted =
    prng.int(1, 4) === 1 ? "everything" : SURVEY_WANTED[prng.int(0, SURVEY_WANTED.length - 1)];
  const detailsPool = [
    "",
    "Scores felt off on my third shot",
    "\u200Bzero\u200Bwidth\u202Ebidi\u0007bell",
    "x".repeat(prng.int(1, 900)),
    "  spaced   out   text  ",
  ];
  const details = detailsPool[prng.int(0, detailsPool.length - 1)];
  return {
    valid: !invalidReason,
    survey: {
      reason,
      wanted: prng.int(1, 3) === 1 ? null : wanted,
      details: details.length ? details : null,
      platform: "ios",
      appVersion: `1.0.${prng.int(0, 9)}`,
    },
  };
}

/** FNV-1a — mixes the scenario name into the seed so two scenarios at the
 * same seed never mint the same user id or client IP. The route budget lives
 * in a module-global window keyed by user id that no test can reset, so
 * identities must be unique across the whole process, while still being a
 * pure function of (scenario, seed) for replay. */
export function salt(scenario: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < scenario.length; i++) {
    h ^= scenario.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function ipFor(scenario: string, seed: number, iteration: number): string {
  const n = (salt(scenario) ^ (seed * 7919 + iteration * 104_729)) >>> 0;
  return `10.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${Math.max(1, n & 255)}`;
}

/** Run `fn` on an isolate whose clock is `skewMs` off real time. Both
 * `Date.now()` and `new Date()` are shifted — the handler stamps `created_at`
 * with the constructor and `expires_at` from `Date.now()`, and on a real
 * isolate those read the SAME clock, so shifting only one would fabricate a
 * torn row the production code cannot produce. */
export async function withClockSkew<T>(skewMs: number, fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  class SkewedDate extends RealDate {
    constructor(...args: unknown[]) {
      super(...((args.length === 0 ? [RealDate.now() + skewMs] : args) as [number]));
    }
    static override now(): number {
      return RealDate.now() + skewMs;
    }
  }
  (globalThis as { Date: DateConstructor }).Date = SkewedDate as unknown as DateConstructor;
  try {
    return await fn();
  } finally {
    (globalThis as { Date: DateConstructor }).Date = RealDate;
  }
}

// ── Reporting ────────────────────────────────────────────────────────────────

export interface Invariant {
  name: string;
  holds: boolean;
  detail: string;
}

export interface IterationRow {
  scenario: string;
  seed: number;
  iteration: number;
  inputs: Record<string, unknown>;
  statusHistogram: Record<string, number>;
  invariants: Invariant[];
  held: boolean;
  observations: Record<string, unknown>;
  lanes: LaneResult[];
  applied: AppliedWrite[];
  durationMs: number;
  replay: string;
}

export function histogram(values: Array<string | number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Iterations per scenario. Small by default so the suite stays fast; the
 * campaign runs with STRESS_ITER=100 (6 scenarios → 600 interleavings). */
export const STRESS_ITER = envInt("STRESS_ITER", 8);
export const STRESS_SEED = envInt("STRESS_SEED", 20260904);
export const STRESS_LATENCY_MS = envInt("STRESS_LATENCY_MS", 6);
export const STRESS_JITTER_MS = envInt("STRESS_JITTER_MS", 4);
export const STRESS_DEADLINE_MS = envInt("STRESS_DEADLINE_MS", 8_000);

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-delete-request-concurrency/latest/", import.meta.url)
    .pathname;
}

export function replayCommand(file: string, scenario: string, seed: number): string {
  return `STRESS_SEED=${seed} STRESS_ITER=1 STRESS_LATENCY_MS=${STRESS_LATENCY_MS} STRESS_JITTER_MS=${STRESS_JITTER_MS} deno test -A --no-check --config deno.json ${file} --filter "${scenario}"`;
}

export async function writeRows(
  name: string,
  rows: IterationRow[],
  meta: Record<string, unknown>,
): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}.json`;
  const summary = {
    meta,
    iterations: rows.length,
    held: rows.filter((r) => r.held).length,
    broken: rows
      .filter((r) => !r.held)
      .map((r) => ({ scenario: r.scenario, seed: r.seed, replay: r.replay })),
    byScenario: Object.fromEntries(
      [...new Set(rows.map((r) => r.scenario))].map((s) => {
        const mine = rows.filter((r) => r.scenario === s);
        return [
          s,
          {
            iterations: mine.length,
            held: mine.filter((r) => r.held).length,
            statuses: histogram(mine.flatMap((r) => r.lanes.map((l) => l.status))),
            maxDurationMs: Math.max(...mine.map((r) => r.durationMs)),
          },
        ];
      }),
    ),
    rows,
  };
  await Deno.writeTextFile(path, JSON.stringify(summary, null, 2));
  return path;
}
