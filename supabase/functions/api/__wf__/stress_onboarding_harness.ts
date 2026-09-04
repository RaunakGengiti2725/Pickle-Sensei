/**
 * Stress harness for `PUT /v1/me/onboarding` (lens: failure-injection + load).
 *
 * Runs the REAL edge handler in-process (sessionHarness.ts captures
 * Deno.serve and fakes Supabase Auth / PostgREST / Upstash over
 * globalThis.fetch) and layers a seeded FAULT INJECTOR over that fake fetch so
 * every upstream the route can reach — Supabase Auth (GET /auth/v1/user and
 * the transitional id_token grant), PostgREST (PATCH /rest/v1/profiles),
 * Upstash (POST /pipeline) and RevenueCat (api.revenuecat.com, which the
 * route must NEVER call) — can be made to fail, time out, hang, or answer
 * malformed bodies, one at a time, while every upstream round trip is
 * recorded with its latency.
 *
 * Consumers: stress_onboarding_faults.test.ts (≥40 fault cases + Redis-on
 * hot-path load) and stress_onboarding_load.test.ts (Redis-off load, payload
 * fuzz oracle, L1 memory under 20k distinct users). Reports are JSON tables
 * under STRESS_OUT_DIR (default /tmp/stress-onboarding/).
 *
 * Nothing here touches a hosted Supabase project; every host is a fake.
 */
import {
  apiRequest,
  type FakeSession,
  jwtPayload,
  loadSessionHarness,
  REDIS_URL,
  type SessionHarness,
  SUPABASE_URL,
} from "./sessionHarness.ts";
import { sanitizeUserText } from "../http.ts";

// ── Seeded RNG ───────────────────────────────────────────────────────────────

/** mulberry32 — deterministic; every campaign is replayable from its seed. */
export class Prng {
  private state: number;
  constructor(public readonly seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** Derive an independent child stream (so per-iteration seeds are stable). */
  fork(): Prng {
    return new Prng(Math.floor(this.next() * 0xffffffff));
  }
}

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const STRESS_SEED = envInt("STRESS_SEED", 20260904);
/** Iterations for the slow campaigns; the default keeps the suite fast. */
export const STRESS_ITER = envInt("STRESS_ITER", 64);
/** Distinct users for the L1-memory campaign; the default keeps the suite fast. */
export const STRESS_USERS = envInt("STRESS_USERS", 512);
export const STRESS_OUT_DIR = (Deno.env.get("STRESS_OUT_DIR") ?? "/tmp/stress-onboarding/").replace(
  /\/?$/,
  "/",
);

// ── Upstream classification + call recording ─────────────────────────────────

export type Upstream = "auth" | "rest" | "redis" | "revenuecat" | "other";

export function upstreamOf(url: string): Upstream {
  if (url.startsWith(`${SUPABASE_URL}/auth/v1/`)) return "auth";
  if (url.startsWith(`${SUPABASE_URL}/rest/v1/`)) return "rest";
  if (url.startsWith(REDIS_URL)) return "redis";
  if (url.includes("revenuecat.com")) return "revenuecat";
  return "other";
}

export interface UpstreamCall {
  seq: number;
  upstream: Upstream;
  method: string;
  url: string;
  startedMs: number;
  endedMs: number;
  /** HTTP status of the answer, or the error name when fetch rejected. */
  outcome: string;
  faulted: boolean;
}

export type RoundTrips = Record<Upstream, number>;

export function emptyRoundTrips(): RoundTrips {
  return { auth: 0, rest: 0, redis: 0, revenuecat: 0, other: 0 };
}

// ── Fault injection ──────────────────────────────────────────────────────────

export type FaultKind =
  /** Answer with `status` and `body` (default JSON error) immediately. */
  | "http"
  /** Reject the fetch with a connection-level TypeError. */
  | "throw"
  /** Never answer; honours the caller's AbortSignal (rejects AbortError). */
  | "hang"
  /** Wait `delayMs` then pass through to the fake upstream. */
  | "delay"
  /** Answer 200 with a raw (malformed) body / content type. */
  | "malformed";

export interface FaultSpec {
  upstream: Upstream;
  kind: FaultKind;
  /** Only requests whose URL contains this fragment are affected. */
  urlIncludes?: string;
  /** Only this HTTP method is affected. */
  method?: string;
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  delayMs?: number;
  /** Affect at most this many matching calls (default: all). */
  times?: number;
}

interface ActiveFault extends FaultSpec {
  hits: number;
}

export interface FaultLayer {
  /** Arm a fault (stacked; first matching fault wins). */
  arm(spec: FaultSpec): ActiveFault;
  /** Disarm every fault and release every hung request (they answer 503). */
  clear(): void;
  /** Every upstream call since the last `resetCalls()`. */
  calls: UpstreamCall[];
  resetCalls(): void;
  /** Requests currently parked by a `hang` fault. */
  hungCount(): number;
}

const HANG_RELEASE_STATUS = 503;

function jsonError(status: number, body?: string, headers?: Record<string, string>): Response {
  return new Response(body ?? JSON.stringify({ error: `injected ${status}` }), {
    status,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
  });
}

/** Wrap the (already fake) globalThis.fetch with the fault injector. Call once
 * per test module after loadSessionHarness(). */
export function installFaultLayer(): FaultLayer {
  const passthrough = globalThis.fetch;
  const faults: ActiveFault[] = [];
  const hung = new Set<(response: Response) => void>();
  let seq = 0;
  const layer: FaultLayer = {
    calls: [],
    arm(spec) {
      const active: ActiveFault = { ...spec, hits: 0 };
      faults.unshift(active);
      return active;
    },
    clear() {
      faults.length = 0;
      for (const release of hung) release(jsonError(HANG_RELEASE_STATUS));
      hung.clear();
    },
    resetCalls() {
      layer.calls = [];
    },
    hungCount() {
      return hung.size;
    },
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    const url = request ? request.url : String(input);
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const signal = init?.signal ?? request?.signal ?? null;
    const upstream = upstreamOf(url);
    const record: UpstreamCall = {
      seq: seq++,
      upstream,
      method,
      url,
      startedMs: performance.now(),
      endedMs: 0,
      outcome: "",
      faulted: false,
    };
    layer.calls.push(record);
    const finish = (outcome: string) => {
      record.endedMs = performance.now();
      record.outcome = outcome;
    };

    const fault = faults.find(
      (f) =>
        f.upstream === upstream &&
        (f.method === undefined || f.method === method) &&
        (f.urlIncludes === undefined || url.includes(f.urlIncludes)) &&
        (f.times === undefined || f.hits < f.times),
    );
    if (fault) {
      fault.hits += 1;
      record.faulted = true;
      switch (fault.kind) {
        case "http": {
          finish(String(fault.status ?? 500));
          return jsonError(fault.status ?? 500, fault.body, fault.headers);
        }
        case "throw": {
          finish("TypeError");
          throw new TypeError(`error sending request for url (${url}): connection reset`);
        }
        case "malformed": {
          finish("200-malformed");
          return new Response(fault.body ?? "<html>bad gateway</html>", {
            status: fault.status ?? 200,
            headers: fault.headers ?? { "Content-Type": "text/html" },
          });
        }
        case "delay": {
          await new Promise((resolve) => setTimeout(resolve, fault.delayMs ?? 50));
          if (signal?.aborted) {
            finish("AbortError");
            throw new DOMException("The signal has been aborted", "AbortError");
          }
          break;
        }
        case "hang": {
          return await new Promise<Response>((resolve, reject) => {
            const release = (response: Response) => {
              hung.delete(release);
              finish(`released-${response.status}`);
              resolve(response);
            };
            hung.add(release);
            if (signal) {
              const onAbort = () => {
                hung.delete(release);
                finish("AbortError");
                reject(new DOMException("The signal has been aborted", "AbortError"));
              };
              if (signal.aborted) onAbort();
              else signal.addEventListener("abort", onAbort, { once: true });
            }
          });
        }
      }
    }
    try {
      const response = await passthrough(input, init);
      finish(String(response.status));
      return response;
    } catch (error) {
      finish(error instanceof Error ? error.name : "Error");
      throw error;
    }
  }) as typeof fetch;

  return layer;
}

// ── PostgREST profile UPDATE model ───────────────────────────────────────────

/** The row shape the route selects back after its PATCH. */
export interface ProfileRow {
  id: string;
  skill_level: string | null;
  handedness: string | null;
  primary_goal: string | null;
  biggest_problem: string | null;
  focus_checkpoint: string | null;
  first_name: string | null;
  gender: string | null;
  onboarding_state: string;
}

export interface ProfilePatchCall {
  userId: string | null;
  patch: Record<string, unknown>;
  prefer: string;
  filter: string;
}

/** Stateful `profiles` table behind PATCH /rest/v1/profiles: applies the
 * route's patch to the caller's own row (RLS: `id = auth.uid()`) and returns
 * the selected columns exactly as PostgREST does for
 * `Prefer: return=representation` + `Accept: application/vnd.pgrst.object+json`.
 * Installed OVER the fault layer's passthrough by wrapping the current fetch
 * again, so faults still win. */
export function installProfilesTable(): {
  rows: Map<string, ProfileRow>;
  patches: ProfilePatchCall[];
  reset(): void;
} {
  const rows = new Map<string, ProfileRow>();
  const patches: ProfilePatchCall[] = [];
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (request.method === "PATCH" && request.url.startsWith(`${SUPABASE_URL}/rest/v1/profiles`)) {
      const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const sub = jwtPayload(bearer)?.sub;
      const userId = typeof sub === "string" ? sub : null;
      const text = await request
        .clone()
        .text()
        .catch(() => "");
      let patch: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          patch = parsed as Record<string, unknown>;
        }
      } catch {
        // leave patch empty; the route always sends JSON
      }
      const url = new URL(request.url);
      const filter = url.searchParams.get("id") ?? "";
      patches.push({ userId, patch, prefer: request.headers.get("prefer") ?? "", filter });
      // Let the fault layer see (and possibly fault) the call first.
      // The base fake answers PATCH with a bare 201 (no headers); anything
      // else came from the fault layer and must reach the route untouched.
      const passthrough = await inner(input, init);
      if (passthrough.status !== 201 || passthrough.headers.has("content-type")) {
        return passthrough;
      }
      const targetsSelf = userId !== null && filter === `eq.${userId}`;
      const row = targetsSelf ? rows.get(userId!) : undefined;
      if (!row) {
        // RLS hides other users' rows: PostgREST answers 200 with an empty
        // array for `Prefer: return=representation` when zero rows matched
        // (or 406 PGRST116 for a single-object Accept).
        const accept = request.headers.get("accept") ?? "";
        if (accept.includes("vnd.pgrst.object+json")) {
          return new Response(
            JSON.stringify({ code: "PGRST116", message: "0 rows", details: null, hint: null }),
            { status: 406, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      for (const [key, value] of Object.entries(patch)) {
        if (key in row && (typeof value === "string" || value === null)) {
          (row as unknown as Record<string, unknown>)[key] = value;
        }
      }
      const select = url.searchParams.get("select") ?? "*";
      const columns = select === "*" ? Object.keys(row) : select.split(",").map((c) => c.trim());
      const projected: Record<string, unknown> = {};
      for (const column of columns) {
        projected[column] = (row as unknown as Record<string, unknown>)[column] ?? null;
      }
      const accept = request.headers.get("accept") ?? "";
      const body = accept.includes("vnd.pgrst.object+json") ? projected : [projected];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json", "Content-Range": "0-0/*" },
      });
    }
    return inner(input, init);
  }) as typeof fetch;
  return {
    rows,
    patches,
    reset() {
      rows.clear();
      patches.length = 0;
    },
  };
}

export function blankProfile(id: string): ProfileRow {
  return {
    id,
    skill_level: null,
    handedness: null,
    primary_goal: null,
    biggest_problem: null,
    focus_checkpoint: null,
    first_name: null,
    gender: null,
    onboarding_state: "pending",
  };
}

// ── Users, sessions, requests ────────────────────────────────────────────────

/** Deterministic UUIDv4-shaped id from an index (so 20k users need no RNG). */
export function userIdAt(index: number): string {
  const hex = index.toString(16).padStart(12, "0");
  return `a0000000-0000-4000-8000-${hex}`;
}

/** A syntactically valid IPv4 from an index (never the harness' freshIp range). */
export function ipAt(index: number): string {
  const b = (index >>> 16) & 0xff;
  const c = (index >>> 8) & 0xff;
  const d = index & 0xff;
  return `10.${b}.${c}.${d}`;
}

export interface CapturedLogs {
  /** `[api] …` operator-facing error lines (serviceUnavailable details, unhandled errors). */
  errors: string[];
  accessLogCount: number;
  /** Access-log lines with status ≥ 500, kept for evidence. */
  access5xx: string[];
  reset(): void;
}

export interface StressContext {
  h: SessionHarness;
  faults: FaultLayer;
  profiles: ReturnType<typeof installProfilesTable>;
  logs: CapturedLogs;
}

const LOG_KEEP = 2_000;

/** The handler prints one access-log line per request and an operator detail
 * line per 5xx; at 40k+ requests that noise dominates the test output. Keep
 * the interesting lines in memory instead and let everything else through. */
/** `console` by another name: the interception below must assign `console.log`
 * and print report lines, which the repo's no-console rule otherwise forbids. */
const con = globalThis.console;

function captureLogs(): CapturedLogs {
  const realLog = con.log;
  const realError = con.error;
  const logs: CapturedLogs = {
    errors: [],
    accessLogCount: 0,
    access5xx: [],
    reset() {
      logs.errors = [];
      logs.accessLogCount = 0;
      logs.access5xx = [];
    },
  };
  con.log = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === "string" && first.startsWith('{"evt":"api_request"')) {
      logs.accessLogCount += 1;
      if (/"status":5\d\d/.test(first) && logs.access5xx.length < LOG_KEEP)
        logs.access5xx.push(first);
      return;
    }
    realLog(...args);
  };
  con.error = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === "string" && first.startsWith("[api]")) {
      if (logs.errors.length < LOG_KEEP) {
        logs.errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
      }
      return;
    }
    realError(...args);
  };
  return logs;
}

let context: StressContext | null = null;

/** Boot (once per module) the real handler + fault layer + profiles table. */
export async function loadStressContext(options: { redis: boolean }): Promise<StressContext> {
  if (context) return context;
  const h = await loadSessionHarness({ redis: options.redis });
  // Order matters: the profiles table wraps the fault layer, which wraps the
  // base fake — so a fault on PATCH /profiles is seen before the table model.
  const faults = installFaultLayer();
  const profiles = installProfilesTable();
  const logs = captureLogs();
  context = { h, faults, profiles, logs };
  return context;
}

/** `Deno.test` with the stress context booted and the Auth upstream deadline
 * shortened (the hang cases wait for it) ONLY for the duration of the test:
 * `Deno.env` is process-wide, so the override must not outlive this module. */
export function stressTest(
  name: string,
  options: { redis: boolean },
  fn: (ctx: StressContext) => Promise<void>,
): void {
  Deno.test(name, async () => {
    const ctx = await loadStressContext(options);
    const prior = Deno.env.get("AUTH_UPSTREAM_TIMEOUT_MS");
    Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", String(envInt("STRESS_AUTH_TIMEOUT_MS", 600)));
    try {
      await fn(ctx);
    } finally {
      if (prior === undefined) Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
      else Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", prior);
    }
  });
}

/** Register a user with a google provider and a blank profile; mint a session. */
export function provisionUser(
  ctx: StressContext,
  userId: string,
  provider = "google",
): FakeSession {
  ctx.h.registerUser({ id: userId, email: `${userId}@example.com`, provider });
  ctx.profiles.rows.set(userId, blankProfile(userId));
  return ctx.h.mintSession(userId);
}

export const VALID_GOALS = [
  "dinks",
  "drives",
  "drops",
  "serve",
  "return",
  "volleys",
  "footwork",
  "all-around",
] as const;

export const GOAL_FOCUS: Record<string, string> = {
  dinks: "contact_position",
  drives: "preparation",
  drops: "paddle_set",
  serve: "sequencing",
  return: "athletic_base",
  volleys: "face_wrist_stability",
  footwork: "athletic_base",
  "all-around": "contact_position",
};

export const GENDERS = ["female", "male", "nonbinary", "prefer_not_to_say"] as const;

export function validOnboardingBody(rng?: Prng): Record<string, unknown> {
  const r = rng ?? new Prng(1);
  return {
    skillLevel: r.pick(["3.0", "3.5", "4.0", "beginner", "intermediate"]),
    handedness: r.pick(["right", "left"]),
    goal: r.pick(VALID_GOALS),
    biggestProblem: r.pick([
      "I pop up my dinks",
      "Late on drives",
      "Serve consistency",
      "Footwork at the kitchen",
    ]),
  };
}

export function onboardingRequest(
  bearer: string | null,
  body: unknown,
  ip: string,
  options: { rawBody?: string; headers?: Record<string, string> } = {},
): Request {
  if (options.rawBody === undefined) {
    return apiRequest("PUT", "/v1/me/onboarding", {
      token: bearer,
      body,
      ip,
      headers: options.headers,
    });
  }
  const headers = new Headers({
    "x-forwarded-for": ip,
    "Content-Type": "application/json",
    ...(options.headers ?? {}),
  });
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
  return new Request("http://edge.test/functions/v1/api/v1/me/onboarding", {
    method: "PUT",
    headers,
    body: options.rawBody,
  });
}

// ── Running one request with round-trip accounting ───────────────────────────

export interface RunResult {
  status: number;
  /** `error.message` for error bodies, "" otherwise. */
  message: string;
  /** `error.code` when present (e.g. rate_limited). */
  code: string;
  body: unknown;
  retryAfter: string | null;
  requestId: string | null;
  durationMs: number;
  roundTrips: RoundTrips;
  calls: UpstreamCall[];
  /** True when the handler did not answer inside `deadlineMs`. */
  timedOut: boolean;
}

/** Send one request through the real handler; slice this request's upstream
 * calls out of the fault layer's log (sequential use only — concurrent
 * callers must account via `faults.calls` themselves). */
export async function runOnce(
  ctx: StressContext,
  request: Request,
  deadlineMs = 5_000,
): Promise<RunResult> {
  const startSeq = ctx.faults.calls.length;
  const started = performance.now();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(null);
    }, deadlineMs);
  });
  const pending = ctx.h.handler(request);
  const response = await Promise.race([pending, deadline]);
  clearTimeout(timer);
  if (response === null) {
    // Free the parked upstream so the handler can settle (release = 503) and
    // the test isolate has no leaked promise; the caller sees `timedOut`.
    ctx.faults.clear();
    const late = await pending;
    await late.body?.cancel();
    return {
      status: 0,
      message: "",
      code: "",
      body: null,
      retryAfter: null,
      requestId: null,
      durationMs: performance.now() - started,
      roundTrips: countRoundTrips(ctx.faults.calls.slice(startSeq)),
      calls: ctx.faults.calls.slice(startSeq),
      timedOut,
    };
  }
  const durationMs = performance.now() - started;
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep raw text
  }
  const error =
    body && typeof body === "object" && "error" in body
      ? ((body as { error: unknown }).error as Record<string, unknown> | null)
      : null;
  const calls = ctx.faults.calls.slice(startSeq);
  return {
    status: response.status,
    message: typeof error?.message === "string" ? error.message : "",
    code: typeof error?.code === "string" ? error.code : "",
    body,
    retryAfter: response.headers.get("Retry-After"),
    requestId: response.headers.get("x-request-id"),
    durationMs,
    roundTrips: countRoundTrips(calls),
    calls,
    timedOut: false,
  };
}

export function countRoundTrips(calls: UpstreamCall[]): RoundTrips {
  const out = emptyRoundTrips();
  for (const call of calls) out[call.upstream] += 1;
  return out;
}

// ── Oracle: what the route MUST answer for a payload ─────────────────────────

export interface Expectation {
  status: 200 | 400;
  message: string;
  /** The exact PATCH body the route must send (200 only). */
  patch?: Record<string, unknown>;
  focus?: string;
}

/** Mirrors the route's validation contract (index.ts `PUT /v1/me/onboarding`)
 * so a fuzzed payload has one right answer. Kept deliberately literal. */
export function expectedFor(body: Record<string, unknown>): Expectation {
  const handedness = body.handedness;
  const skillLevel =
    typeof body.skillLevel === "string" ? sanitizeUserText(body.skillLevel, 200) : "";
  const goal = typeof body.goal === "string" ? sanitizeUserText(body.goal, 200) : "";
  const biggestProblem =
    typeof body.biggestProblem === "string" ? sanitizeUserText(body.biggestProblem, 1_000) : "";
  if (
    !skillLevel ||
    skillLevel.length > 64 ||
    (handedness !== "right" && handedness !== "left") ||
    !goal ||
    goal.length > 64 ||
    !biggestProblem ||
    biggestProblem.length > 256
  ) {
    return { status: 400, message: "Invalid onboarding payload." };
  }
  let firstName: string | undefined;
  if (body.firstName !== undefined && body.firstName !== null) {
    if (typeof body.firstName !== "string") {
      return { status: 400, message: "Invalid onboarding payload." };
    }
    const cleaned = sanitizeUserText(body.firstName, 200);
    if (cleaned.length < 1 || cleaned.length > 40) {
      return { status: 400, message: "firstName must be 1-40 characters after trimming." };
    }
    firstName = cleaned;
  }
  let gender: string | undefined;
  if (body.gender !== undefined && body.gender !== null) {
    if (typeof body.gender !== "string" || !(GENDERS as readonly string[]).includes(body.gender)) {
      return {
        status: 400,
        message: "gender must be one of female|male|nonbinary|prefer_not_to_say.",
      };
    }
    gender = body.gender;
  }
  const focus = GOAL_FOCUS[goal] ?? "contact_position";
  const patch: Record<string, unknown> = {
    skill_level: skillLevel,
    handedness,
    primary_goal: goal,
    biggest_problem: biggestProblem,
    focus_checkpoint: focus,
    onboarding_state: "complete",
  };
  if (firstName !== undefined) patch.first_name = firstName;
  if (gender !== undefined) patch.gender = gender;
  return { status: 200, message: "", patch, focus };
}

// ── Payload fuzzing ──────────────────────────────────────────────────────────

const HOSTILE_TEXT = [
  "",
  " ",
  "\t\n ",
  "\u0000",
  "abc\u0000def",
  "\u202Eright",
  "\u200Bzero\u200Bwidth",
  "<script>alert(1)</script>",
  "'; drop table profiles; --",
  "{{constructor.constructor}}",
  "\uD83C\uDFD3".repeat(32), // 32 paddle emoji = 64 UTF-16 units, 32 code points
  "\uD83C\uDFD3".repeat(33), // 33 emoji = 66 UTF-16 units
  "é".repeat(64),
  "e\u0301".repeat(40), // combining marks
  "x".repeat(63),
  "x".repeat(64),
  "x".repeat(65),
  "x".repeat(200),
  "x".repeat(201),
  "x".repeat(255),
  "x".repeat(256),
  "x".repeat(257),
  "x".repeat(1_000),
  "x".repeat(1_001),
  "x".repeat(10_000),
  " padded ",
  "\u00A0nbsp\u00A0",
  "𝔘𝔫𝔦𝔠𝔬𝔡𝔢",
];

const NON_STRINGS: unknown[] = [
  null,
  undefined,
  0,
  1,
  -1,
  3.5,
  true,
  false,
  {},
  [],
  ["right"],
  { a: 1 },
];

function fuzzText(rng: Prng, validPool: readonly string[]): unknown {
  const roll = rng.next();
  if (roll < 0.5) return rng.pick(validPool);
  if (roll < 0.85) return rng.pick(HOSTILE_TEXT);
  return rng.pick(NON_STRINGS);
}

/** A seeded payload: mostly valid, often hostile; every field independently. */
export function fuzzOnboardingBody(rng: Prng): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const skill = fuzzText(rng, ["3.0", "3.5", "4.0", "4.5", "beginner", "advanced"]);
  if (skill !== undefined) body.skillLevel = skill;
  const hand = rng.next();
  if (hand < 0.6) body.handedness = rng.pick(["right", "left"]);
  else if (hand < 0.9)
    body.handedness = rng.pick(["Right", "LEFT", "ambidextrous", "", "both", " right"]);
  else body.handedness = rng.pick(NON_STRINGS);
  const goal = fuzzText(rng, VALID_GOALS);
  if (goal !== undefined) body.goal = goal;
  const problem = fuzzText(rng, [
    "I pop up my dinks",
    "Late on drives",
    "Serve toss",
    "Reset shots",
  ]);
  if (problem !== undefined) body.biggestProblem = problem;
  const fn = rng.next();
  if (fn < 0.4) {
    // absent
  } else if (fn < 0.55) body.firstName = null;
  else if (fn < 0.75)
    body.firstName = rng.pick(["Sam", "Alex", "Jordan", "x".repeat(40), "Ana María"]);
  else if (fn < 0.9) body.firstName = rng.pick([...HOSTILE_TEXT, "x".repeat(41)]);
  else body.firstName = rng.pick(NON_STRINGS);
  const g = rng.next();
  if (g < 0.4) {
    // absent
  } else if (g < 0.55) body.gender = null;
  else if (g < 0.8) body.gender = rng.pick(GENDERS);
  else if (g < 0.92)
    body.gender = rng.pick(["Female", "MALE", "other", "", "non-binary", "prefer_not_to_say "]);
  else body.gender = rng.pick(NON_STRINGS);
  if (rng.chance(0.15))
    body[rng.pick(["extra", "id", "onboarding_state", "__proto__", "user_id"])] = rng.pick([
      "complete",
      "00000000-0000-4000-8000-000000000000",
      { polluted: true },
    ]);
  return body;
}

// ── Latency stats + reporting ────────────────────────────────────────────────

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function latencyStats(values: number[]): Record<string, number> {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    min: round(sorted[0] ?? NaN),
    p50: round(percentile(sorted, 50)),
    p90: round(percentile(sorted, 90)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted[sorted.length - 1] ?? NaN),
    mean: round(sorted.length ? sum / sorted.length : NaN),
  };
}

export function round(n: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function histogram(values: Array<string | number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

export interface Invariant {
  name: string;
  holds: boolean;
  detail: string;
}

export interface StressReport {
  campaign: string;
  seed: number;
  scale: Record<string, number>;
  /** Exact command to replay this campaign. */
  replay: string;
  redis: boolean;
  rows: unknown[];
  aggregates: Record<string, unknown>;
  invariants: Invariant[];
  /** BROKEN rows (invariant violations) with their seeds. */
  broken: unknown[];
  startedAt: string;
  durationMs: number;
}

export async function writeReport(report: StressReport): Promise<string> {
  await Deno.mkdir(STRESS_OUT_DIR, { recursive: true });
  const path = `${STRESS_OUT_DIR}${report.campaign}.json`;
  await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
  con.log(
    `[stress] ${report.campaign}: rows=${report.rows.length} broken=${report.broken.length} → ${path}`,
  );
  return path;
}

export function replayCommand(file: string, filter: string, seed = STRESS_SEED): string {
  return `STRESS_SEED=${seed} STRESS_ITER=${STRESS_ITER} STRESS_USERS=${STRESS_USERS} deno test -A --no-check --config deno.json ${file} --filter "${filter}"`;
}

export function heapUsedBytes(): number {
  return Deno.memoryUsage().heapUsed;
}

/** Best-effort GC (only when the isolate exposes it, e.g. --v8-flags=--expose-gc). */
export function tryGc(): boolean {
  const gc = (globalThis as unknown as { gc?: () => void }).gc;
  if (typeof gc === "function") {
    gc();
    return true;
  }
  return false;
}
