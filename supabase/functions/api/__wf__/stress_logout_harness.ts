// Stress harness for POST /v1/auth/logout — failure injection + load.
//
// Builds on sessionHarness.ts (the REAL ../index.ts booted in-process with a
// stateful fake GoTrue + optional fake Upstash behind fetch) and adds:
//
//   • a seeded PRNG (mulberry32) so every iteration is replayable from its seed;
//   • a fault layer in front of the harness fetch that can make ONE upstream
//     (GoTrue GET /user, GoTrue POST /logout, Upstash /pipeline) answer with an
//     arbitrary status/body, throw a socket error, or hang until aborted;
//   • per-request upstream round-trip accounting (calls made by the function
//     while a given handler invocation was in flight);
//   • JSON report writers (seed → outcome tables) under
//     artifacts/stress-route-post-v1-auth-logout/ (STRESS_OUT_DIR overrides).
//
// Scale knobs (all optional; defaults keep the suite fast):
//   STRESS_SEED  base seed (default 20260905)
//   STRESS_ITER  seeded repetitions of the fault matrix (default 1)
//   STRESS_LOAD  requests in the load campaign (default 120; campaign: 1000+)
//   STRESS_USERS distinct users in the L1 memory campaign (default 600; campaign: 20000)
//
// Nothing here talks to a network.

import {
  apiRequest,
  fakeJwt,
  freshIp,
  jwtPayload,
  loadSessionHarness,
  REDIS_URL,
  SUPABASE_URL,
  type FakeSession,
  type SessionHarness,
} from "./sessionHarness.ts";

// ── Seeded randomness ────────────────────────────────────────────────────────

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
  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
  hex(n: number): string {
    let out = "";
    for (let i = 0; i < n; i += 1) out += this.int(0, 15).toString(16);
    return out;
  }
  /** RFC 4122 v4-shaped uuid (matches the function's isUuid). */
  uuid(): string {
    return `${this.hex(8)}-${this.hex(4)}-4${this.hex(3)}-${this.pick(["8", "9", "a", "b"])}${this.hex(3)}-${this.hex(12)}`;
  }
}

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const STRESS_SEED = envInt("STRESS_SEED", 20260905);
export const STRESS_ITER = envInt("STRESS_ITER", 1);
export const STRESS_LOAD = envInt("STRESS_LOAD", 120);
export const STRESS_USERS = envInt("STRESS_USERS", 600);

// ── Fault layer ──────────────────────────────────────────────────────────────

export type FaultTarget = "user" | "logout" | "redis";

/** What an injected upstream does instead of answering normally.
 *  - Response: that HTTP answer.
 *  - "throw": the socket fails (TypeError, as Deno's fetch reports resets/refusals).
 *  - "hang": never answers; rejects with AbortError only when the caller aborts. */
export type FaultAnswer = Response | "throw" | "hang";

export interface FaultContext {
  request: Request;
  /** Calls to this target since the last `resetUpstream()` (0-based). */
  attempt: number;
  /** Redis pipelines only: command names in order (GET, SET, DEL, INCR…). */
  commands: string[];
}

export interface Fault {
  target: FaultTarget;
  /** Narrow the fault to some calls of the target (default: every call). Calls
   * the predicate rejects are untouched — no delay, no injected answer. */
  when?: (ctx: FaultContext) => boolean;
  /** Return null to let the real fake answer this call (after `delayMs`). */
  answer: (ctx: FaultContext) => FaultAnswer | null;
  /** Extra latency before the answer (models a slow upstream). */
  delayMs?: number;
}

export interface UpstreamCall {
  seq: number;
  t: number;
  target: FaultTarget | "other";
  method: string;
  url: string;
  /** Redis pipelines: the command names in order (GET, SET, DEL, INCR…). */
  commands?: string[];
  outcome: "answered" | "injected" | "threw" | "hung";
  status?: number;
}

export interface StressHarness {
  h: SessionHarness;
  redis: boolean;
  /** Active faults (checked in order; first non-null answer wins). */
  faults: Fault[];
  /** Every upstream call in order since the last `resetUpstream()`. */
  upstream: UpstreamCall[];
  /** session_id → every access token minted for that GoTrue session. */
  siblings: Map<string, FakeSession[]>;
  resetUpstream(): void;
  /** Number of upstream calls (optionally by target) issued while `run` was in flight
   * — meaningful only when `run` is the sole in-flight request. */
  roundTrips<T>(run: () => Promise<T>): Promise<{ value: T; calls: UpstreamCall[] }>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function targetOf(request: Request): FaultTarget | "other" {
  const url = request.url;
  if (url.startsWith(`${SUPABASE_URL}/auth/v1/user`) && request.method === "GET") return "user";
  if (url.startsWith(`${SUPABASE_URL}/auth/v1/logout`) && request.method === "POST") {
    return "logout";
  }
  if (url === `${REDIS_URL}/pipeline`) return "redis";
  return "other";
}

/** GoTrue revokes the SESSION behind the bearer (every access token carrying
 * its session_id); the fake only flips the one token object, so the other
 * tokens of that session (refresh-rotation siblings, see `siblingToken`)
 * inherit the revocation. */
function revokeSiblings(s: StressHarness, request: Request): void {
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const session = s.h.sessions.get(token);
  if (!session?.revoked) return;
  let sessionId: string;
  try {
    sessionId = s.h.sessionIdOf(token);
  } catch {
    return; // no session_id claim: nothing to fan out to
  }
  for (const other of s.siblings.get(sessionId) ?? []) other.revoked = true;
}

function hangUntilAborted(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (!signal) return; // no deadline anywhere: hangs forever (the caller races a timer)
    const onAbort = () =>
      reject(signal.reason ?? new DOMException("The signal has been aborted", "AbortError"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

let installed: StressHarness | null = null;

/** Boot (once per isolate) the real function via sessionHarness and install the
 * fault layer in front of its fetch. `redis` is fixed at first load (cache.ts
 * reads UPSTASH_* at import), so Redis-enabled cases live in their own module. */
export async function loadStressHarness(options: { redis?: boolean } = {}): Promise<StressHarness> {
  if (installed) {
    if (Boolean(options.redis) !== installed.redis) {
      throw new Error("stress harness already loaded with a different redis setting");
    }
    installed.h.reset();
    installed.faults.length = 0;
    installed.siblings.clear();
    installed.resetUpstream();
    return installed;
  }
  const h = await loadSessionHarness({ redis: options.redis });
  const base = globalThis.fetch;
  const attempts = new Map<FaultTarget, number>();
  const t0 = performance.now();
  let seq = 0;
  const state: StressHarness = {
    h,
    redis: Boolean(options.redis),
    faults: [],
    upstream: [],
    siblings: new Map(),
    resetUpstream() {
      state.upstream = [];
      attempts.clear();
    },
    async roundTrips<T>(run: () => Promise<T>) {
      const from = state.upstream.length;
      const value = await run();
      return { value, calls: state.upstream.slice(from) };
    },
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const target = targetOf(request);
    seq += 1;
    const entry: UpstreamCall = {
      seq,
      t: Math.round((performance.now() - t0) * 100) / 100,
      target,
      method: request.method,
      url: request.url,
      outcome: "answered",
    };
    if (target === "redis") {
      const text = await request
        .clone()
        .text()
        .catch(() => "");
      try {
        const commands = JSON.parse(text) as Array<Array<string | number>>;
        entry.commands = commands.map((c) => String(c[0]));
      } catch {
        entry.commands = [];
      }
    }
    state.upstream.push(entry);
    if (target !== "other") {
      const attempt = attempts.get(target) ?? 0;
      attempts.set(target, attempt + 1);
      for (const fault of state.faults) {
        if (fault.target !== target) continue;
        const ctx: FaultContext = {
          request: request.clone(),
          attempt,
          commands: entry.commands ?? [],
        };
        if (fault.when && !fault.when(ctx)) continue;
        const answer = fault.answer(ctx);
        // A matching fault's delay applies even when it lets the fake answer
        // (answer null): that is how a SLOW but healthy upstream is modelled.
        if (fault.delayMs) await sleep(fault.delayMs);
        if (answer === null) continue;
        if (answer === "throw") {
          entry.outcome = "threw";
          throw new TypeError("error sending request: connection reset by peer (injected)");
        }
        if (answer === "hang") {
          entry.outcome = "hung";
          return await hangUntilAborted(request.signal);
        }
        entry.outcome = "injected";
        entry.status = answer.status;
        return answer;
      }
    }
    const response = await base(request);
    entry.status = response.status;
    if (target === "logout" && response.status === 204) revokeSiblings(state, request);
    return response;
  }) as typeof fetch;

  installed = state;
  return state;
}

// ── Answer builders ──────────────────────────────────────────────────────────

export const jsonAnswer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

export const textAnswer = (status: number, text: string, contentType = "text/html") =>
  new Response(text, { status, headers: { "Content-Type": contentType } });

export const emptyAnswer = (status: number, headers: Record<string, string> = {}) =>
  new Response(null, { status, headers });

export const gotrueError = (status: number, code: string, msg: string) =>
  jsonAnswer(status, { code: status, error_code: code, msg });

/** A fault that answers every call to `target` the same way. */
export function always(target: FaultTarget, answer: () => FaultAnswer, delayMs?: number): Fault {
  return { target, answer: () => answer(), delayMs };
}

/** A fault that hits only the first `n` calls to `target` made while it is installed. */
export function firstN(target: FaultTarget, n: number, answer: () => FaultAnswer): Fault {
  let seen = 0;
  return {
    target,
    answer: () => {
      seen += 1;
      return seen <= n ? answer() : null;
    },
  };
}

/** A fault that hits only Redis pipelines containing one of `ops`. */
export function redisOp(ops: string[], answer: () => FaultAnswer): Fault {
  return {
    target: "redis",
    answer: ({ commands }) => (commands.some((op) => ops.includes(op)) ? answer() : null),
  };
}

// ── Sessions & requests ──────────────────────────────────────────────────────

export const GOOGLE_PROVIDER = "google";

/** Register a fresh Google user (deterministic id from the PRNG) and mint one session. */
export function mintUser(
  s: StressHarness,
  prng: Prng,
  options: { provider?: "google" | "apple" | "email"; ttlSeconds?: number } = {},
): { userId: string; session: FakeSession } {
  const userId = prng.uuid();
  const provider = options.provider ?? "google";
  s.h.registerUser({ id: userId, email: `${userId.slice(0, 8)}@example.com`, provider });
  const session = s.h.mintSession(userId, options.ttlSeconds ?? 3600);
  return { userId, session };
}

/** A second access token of the SAME GoTrue session (what a refresh rotation hands out). */
export function siblingToken(s: StressHarness, session: FakeSession): FakeSession {
  const sessionId = s.h.sessionIdOf(session.accessToken);
  const sibling = s.h.mintSession(session.userId, 3600, { sessionId });
  const family = s.siblings.get(sessionId) ?? [session];
  family.push(sibling);
  s.siblings.set(sessionId, family);
  return sibling;
}

export function logoutRequest(token: string | null, ip?: string, extra?: Record<string, string>) {
  return apiRequest("POST", "/v1/auth/logout", { token, ip: ip ?? freshIp(), headers: extra });
}

export function meRequest(token: string | null, ip?: string) {
  return apiRequest("GET", "/v1/me", { token, ip: ip ?? freshIp() });
}

export async function drain(response: Response): Promise<string> {
  return await response.text().catch(() => "");
}

export function sessionTokenLike(
  overrides: Record<string, unknown>,
  sub: string = crypto.randomUUID(),
): string {
  return fakeJwt({
    iss: `${SUPABASE_URL}/auth/v1`,
    sub,
    aud: "authenticated",
    role: "authenticated",
    session_id: crypto.randomUUID(),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  });
}

export { jwtPayload };

// ── Outcomes & reports ───────────────────────────────────────────────────────

export interface Check {
  name: string;
  ok: boolean;
  got?: unknown;
}

export const check = (name: string, ok: boolean, got?: unknown): Check => ({ name, ok, got });

export function verdict(checks: Check[]): { held: boolean; detail: string } {
  const failed = checks.filter((c) => !c.ok);
  return {
    held: failed.length === 0,
    detail:
      failed.length === 0
        ? `${checks.length} checks held`
        : failed
            .map((c) => `${c.name}${c.got !== undefined ? ` (got ${JSON.stringify(c.got)})` : ""}`)
            .join("; "),
  };
}

export interface CaseOutcome {
  seed: number;
  case: string;
  verdict: "HELD" | "BROKEN";
  status: number;
  /** Upstream calls attributed to the logout request itself. */
  roundTrips: number;
  detail: string;
  replay: string;
}

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-route-post-v1-auth-logout/latest/", import.meta.url)
    .pathname;
}

export async function writeReport(name: string, report: unknown): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}.json`;
  await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
  return path;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function histogram(values: Array<string | number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

export function replayCommand(file: string, filter: string, seed: number): string {
  return `STRESS_SEED=${seed} STRESS_ITER=1 deno test -A --no-check --config deno.json ${file} --filter "${filter}"`;
}

/** Run `fn` with `AUTH_UPSTREAM_TIMEOUT_MS` overridden and restore it after.
 * `deno test .` runs every module in ONE process, so a module-level
 * Deno.env.set would leak into later modules' index.ts (it reads the env per call). */
export async function withAuthUpstreamTimeout<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const previous = Deno.env.get("AUTH_UPSTREAM_TIMEOUT_MS");
  Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", String(ms));
  try {
    return await fn();
  } finally {
    if (previous === undefined) Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
    else Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", previous);
  }
}

/** Race a promise against a wall-clock bound; "timeout" when the bound wins. */
export async function bounded<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ kind: "value"; value: T } | { kind: "timeout" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), ms);
  });
  try {
    return await Promise.race([
      promise.then((value) => ({ kind: "value" as const, value })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export { sleep };
