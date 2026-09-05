// Seeded concurrency stress campaign for the edge router's PUBLIC and
// FALLTHROUGH surface (../index.ts handleRequest):
//
//   GET|HEAD …/healthz | …/support | …/privacy | …/terms   (pre-auth, 60/min/IP)
//   every other method/path                              (IP budget → auth-failure
//                                                        peek → authenticate →
//                                                        per-user budget → 404)
//
// The REAL handler runs in-process (Deno.serve captured by sessionHarness.ts,
// Supabase Auth / PostgREST / Upstash answered by the stateful fake behind
// fetch). Every iteration derives ALL of its choices — request mix, method,
// path shape, bearer kind, launch jitter, clock skew, X-Request-Id echo,
// abort-during-call, Redis latency/outage — from ONE 32-bit seed, so any
// row of the JSON report replays with STRESS_SEED=<seed> STRESS_ITER=1.
//
// Scale (env): STRESS_ITER iterations per scenario (default 12 — fast enough
// for the suite; the campaign runs at STRESS_ITER=100 → 500 bursts),
// STRESS_SEED base seed (default 20260905), STRESS_LATENCY_MS max seeded
// Upstash latency (redis file only, default 6), STRESS_OUT_DIR report dir.
//
// Scenarios assert the CONTRACT read from index.ts / rateLimit.ts / http.ts,
// never an observed defect. A failing iteration is a reproduction: its seed,
// composition and every violated invariant are in the report row.

import { assert } from "@std/assert";
import { type AccessLogEntry, captureAccessLog } from "../http.ts";
import {
  apiRequest,
  fakeJwt,
  forgedSessionToken,
  jwtPayload,
  type SessionHarness,
  SUPABASE_URL,
} from "./sessionHarness.ts";

// ─── seeded RNG (mulberry32) ─────────────────────────────────────────────────

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
    return minInclusive +
      Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }
  hex(bytes: number): string {
    let out = "";
    for (let i = 0; i < bytes; i += 1) {
      out += this.int(0, 255).toString(16).padStart(2, "0");
    }
    return out;
  }
  uuid(): string {
    const h = this.hex(16);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${
      h.slice(17, 20)
    }-${h.slice(20, 32)}`;
  }
}

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export const STRESS_ITER = envInt("STRESS_ITER", 40);
export const STRESS_SEED = envInt("STRESS_SEED", 20260905);
export const STRESS_LATENCY_MS = envInt("STRESS_LATENCY_MS", 6);
/** Replay exactly one iteration of every scenario with this seed. */
export const STRESS_REPLAY_SEED = envInt("STRESS_REPLAY_SEED", 0);
export const ITERATIONS = STRESS_REPLAY_SEED ? 1 : STRESS_ITER;

/** Keep the suite output clean: lines emitted outside a burst are dropped. */
export function quietAccessLog(): void {
  captureAccessLog(() => undefined);
}
quietAccessLog();

export const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

// ─── contract constants (index.ts / rateLimit.ts) ────────────────────────────

export const PUBLIC_PAGE_LIMIT = 60;
export const IP_LIMIT = 1_200;
export const AUTH_FAILURE_LIMIT = 30;
export const GENERAL_USER_LIMIT = 240;
export const WINDOW_SECONDS = 60;
export const AUTH_FAILURE_WINDOW_SECONDS = 300;

/** Public suffixes and the rate-limit scope each one charges. */
export const PUBLIC_SUFFIXES: Record<string, "healthz" | "legal"> = {
  "/healthz": "healthz",
  "/support": "legal",
  "/privacy": "legal",
  "/terms": "legal",
};
const LEGAL_HEADINGS: Record<string, string> = {
  "/support": "PICKLE SENSEI SUPPORT",
  "/privacy": "PICKLE SENSEI — PRIVACY POLICY",
  "/terms": "PICKLE SENSEI — TERMS OF USE",
};

// ─── request model ───────────────────────────────────────────────────────────

export type BearerKind =
  | "none"
  | "garbage"
  | "expired-session"
  | "forged-session"
  | "valid-session"
  | "revoked-session";

export interface PlannedRequest {
  index: number;
  method: string;
  /** Path as sent, relative to http://edge.test (mount prefix included). */
  fullPath: string;
  ip: string;
  /** cf-connecting-ip header ("" = absent). */
  cfIp: string;
  bearer: BearerKind;
  /** Client-supplied X-Request-Id ("" = none). */
  requestId: string;
  /** Whether the supplied id satisfies http.ts REQUEST_ID_RE. */
  requestIdValid: boolean;
  /** setTimeout ticks before the request is launched (0 = same tick). */
  delayMs: number;
  /** Abort the Request's signal right after launch (cancel-during-call). */
  abort: boolean;
  /** Oracle classification derived from the contract. */
  expect: ExpectedClass;
}

export type ExpectedClass =
  | { kind: "public"; scope: "healthz" | "legal"; suffix: string }
  | { kind: "auth-refused-local" } // 401 without any upstream call
  | { kind: "auth-refused-upstream" } // 401 after GET /auth/v1/user
  | { kind: "unknown-route"; route: string }; // 404 after auth succeeds

export interface Observed {
  index: number;
  status: number;
  requestId: string | null;
  contentType: string | null;
  retryAfter: string | null;
  rateLimitRemaining: string | null;
  bodyBytes: number;
  bodyHead: string;
  errorCode: string | null;
  errorMessage: string | null;
  ms: number;
  /** "resolved" | "rejected:<name>" */
  settled: string;
}

export interface Violation {
  invariant: string;
  detail: string;
}

export interface IterationRow {
  scenario: string;
  seed: number;
  iteration: number;
  replay: string;
  composition: Record<string, unknown>;
  statuses: Record<string, number>;
  wallMs: number;
  upstreamCalls: Record<string, number>;
  metrics: Record<string, unknown>;
  violations: Violation[];
  outcome: "HELD" | "BROKEN";
}

export interface CampaignReport {
  campaign: string;
  file: string;
  mode: "memory" | "redis";
  commit: string | null;
  startedAt: string;
  config: {
    STRESS_ITER: number;
    STRESS_SEED: number;
    STRESS_LATENCY_MS: number;
  };
  iterations: IterationRow[];
  totals: { executed: number; held: number; broken: number; requests: number };
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** apiRequest() already mounts every path under /functions/v1/api; these
 * extra prefixes model the other shapes the gateway can present (index.ts
 * routes on the LAST "/v1/" segment and public pages on the raw suffix, so
 * all are equivalent). */
const MOUNTS = ["", "", "/api", "/v1/api"] as const;
export const REQUEST_BASE = "http://edge.test/functions/v1/api";

/** clientIp() prefers cf-connecting-ip, else the LAST X-Forwarded-For hop
 * (leftmost hops are client-controlled): every shape below must charge the
 * same budget for `ip`. */
export function forwardedFor(
  rng: Prng,
  ip: string,
): { xff: string; cfIp: string } {
  switch (rng.int(0, 4)) {
    case 0:
      return { xff: ip, cfIp: "" };
    case 1:
      return { xff: `10.0.0.${rng.int(1, 254)}, ${ip}`, cfIp: "" };
    case 2:
      return { xff: `192.168.1.1 , ${ip} `, cfIp: "" };
    case 3:
      return { xff: `1.2.3.4,172.16.${rng.int(0, 255)}.1, ${ip}`, cfIp: "" };
    default:
      // Spoofed XFF is ignored when the edge supplies cf-connecting-ip.
      return { xff: `9.9.9.${rng.int(1, 254)}`, cfIp: ip };
  }
}

/** The budget key clientIp() derives for a planned request. */
export function budgetIp(p: { ip: string; cfIp: string }): string {
  if (p.cfIp) return p.cfIp;
  const hops = p.ip.split(",").map((h) => h.trim()).filter(Boolean);
  return hops[hops.length - 1] || "unknown";
}

export function publicPath(rng: Prng, suffix: string): string {
  const mount = rng.pick(MOUNTS);
  const query = rng.chance(0.25)
    ? `?${rng.pick(["v=1", "utm_source=asc", "x=%20y", "a=1&b=2"])}`
    : "";
  // "/v1/healthz" and "/x/../healthz" still END WITH the suffix after URL
  // normalization → public by contract.
  const nested = rng.chance(0.15)
    ? rng.pick(["/v1", "/zz/..", "/deep/v1/api"])
    : "";
  return `${mount}${nested}${suffix}${query}`;
}

const WORDS = [
  "zz-alpha",
  "zz-beta",
  "zz-gamma",
  "zz-delta",
  "zz-omega",
  "zz-kappa",
];

/** A path that matches NO route in index.ts (every real route is either a
 * public suffix, a webhook, or lives under exact `/v1/…` names — the `zz-`
 * segments and the case/suffix variants below never match those). */
export function unknownPath(
  rng: Prng,
  method: string,
): { fullPath: string; routePath: string } {
  const mount = rng.pick(MOUNTS);
  const kind = rng.int(0, 9);
  let rel: string;
  switch (kind) {
    case 0:
      rel = `/v1/${rng.pick(WORDS)}`;
      break;
    case 1:
      rel = `/v1/${rng.pick(WORDS)}/${rng.uuid()}`;
      break;
    case 2:
      rel = `/v1/${rng.pick(WORDS)}/${rng.int(1000, 99999999)}/x`;
      break;
    case 3:
      rel = rng.pick(["/healthz/", "/privacy/", "/terms/", "/support/"]); // trailing slash ≠ suffix
      break;
    case 4:
      rel = rng.pick([
        "/HEALTHZ",
        "/Privacy",
        "/TERMS",
        "/health%7A",
        "/priv%61cy",
      ]); // case / escaped
      break;
    case 5:
      rel = `/v1/%2e%2e/${rng.pick(["healthz", "terms"])}`; // not normalized by URL → fallthrough
      break;
    case 6:
      rel = `/v1/me/${rng.pick(WORDS)}`;
      break;
    case 7:
      rel = `/v1/${rng.pick(WORDS)}?${
        rng.pick(["q=1", "token=abc", "id=" + rng.uuid()])
      }`;
      break;
    case 8:
      rel = "/v1/"; // empty tail
      break;
    default:
      rel = `/${rng.pick(WORDS)}`; // no /v1/ at all
  }
  // Public suffixes with a non-read method are NOT public (isPublicRead).
  if (method !== "GET" && method !== "HEAD" && rng.chance(0.3)) {
    rel = rng.pick(Object.keys(PUBLIC_SUFFIXES));
  }
  const fullPath = `${mount}${rel}`;
  const url = new URL(`${REQUEST_BASE}${fullPath}`);
  const v1 = url.pathname.lastIndexOf("/v1/");
  const routePath = v1 >= 0 ? url.pathname.slice(v1) : url.pathname;
  return { fullPath, routePath };
}

export function isPublicRead(method: string, fullPath: string): string | null {
  if (method !== "GET" && method !== "HEAD") return null;
  const pathname = new URL(`${REQUEST_BASE}${fullPath}`).pathname;
  for (const suffix of Object.keys(PUBLIC_SUFFIXES)) {
    if (pathname.endsWith(suffix)) return suffix;
  }
  return null;
}

// ─── bearers ─────────────────────────────────────────────────────────────────

export interface Actor {
  userId: string;
  session: { accessToken: string; refreshToken: string };
}

export function mintActor(h: SessionHarness, rng: Prng): Actor {
  const userId = rng.uuid();
  h.registerUser({
    id: userId,
    email: `${userId.slice(0, 8)}@example.com`,
    provider: "google",
  });
  const session = h.mintSession(userId);
  return { userId, session };
}

export function bearerFor(
  kind: BearerKind,
  rng: Prng,
  actor: Actor | null,
): string | null {
  switch (kind) {
    case "none":
      return null;
    case "garbage":
      return rng.pick([
        "not-a-jwt",
        "a.b",
        fakeJwt({ iss: "https://evil.example", sub: "x", exp: 4_000_000_000 }),
        fakeJwt({ sub: "no-iss", exp: 4_000_000_000 }),
        "",
      ]);
    case "expired-session":
      return fakeJwt({
        iss: `${SUPABASE_URL}/auth/v1`,
        sub: rng.uuid(),
        session_id: rng.uuid(),
        exp: Math.floor(Date.now() / 1000) - rng.int(1, 100_000),
      });
    case "forged-session":
      return forgedSessionToken(rng.uuid());
    case "valid-session":
    case "revoked-session":
      if (!actor) throw new Error("actor required");
      return actor.session.accessToken;
  }
}

// ─── execution ───────────────────────────────────────────────────────────────

export interface RunOptions {
  h: SessionHarness;
  actor: Actor | null;
  /** Called synchronously right before each request is dispatched (clock
   * skew hooks). */
  beforeDispatch?: (planned: PlannedRequest) => void;
}

function withAbort(
  request: Request,
  abort: boolean,
): { request: Request; controller: AbortController | null } {
  if (!abort) return { request, controller: null };
  const controller = new AbortController();
  return {
    request: new Request(request, { signal: controller.signal }),
    controller,
  };
}

export async function observe(
  index: number,
  promise: Promise<Response>,
  startedAt: number,
): Promise<Observed> {
  try {
    const response = await promise;
    const contentType = response.headers.get("content-type");
    let bodyText = "";
    let bodyBytes = 0;
    if (response.body) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      bodyBytes = bytes.byteLength;
      bodyText = new TextDecoder().decode(bytes);
    }
    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    if (
      contentType?.includes("application/json") && response.status >= 400 &&
      bodyBytes > 0
    ) {
      try {
        const parsed = JSON.parse(bodyText) as {
          error?: { code?: string; message?: string };
        };
        errorCode = parsed.error?.code ?? null;
        errorMessage = parsed.error?.message ?? null;
      } catch {
        errorCode = "<non-json>";
      }
    }
    return {
      index,
      status: response.status,
      requestId: response.headers.get("x-request-id"),
      contentType,
      retryAfter: response.headers.get("retry-after"),
      rateLimitRemaining: response.headers.get("ratelimit-remaining"),
      bodyBytes,
      bodyHead: bodyText.slice(0, 80),
      errorCode,
      errorMessage,
      ms: Math.round(performance.now() - startedAt),
      settled: "resolved",
    };
  } catch (error) {
    return {
      index,
      status: -1,
      requestId: null,
      contentType: null,
      retryAfter: null,
      rateLimitRemaining: null,
      bodyBytes: 0,
      bodyHead: "",
      errorCode: null,
      errorMessage: error instanceof Error ? error.message : String(error),
      ms: Math.round(performance.now() - startedAt),
      settled: `rejected:${error instanceof Error ? error.name : typeof error}`,
    };
  }
}

/** Dispatch every planned request through Promise.all (seeded launch jitter,
 * seeded aborts) and capture the access-log lines emitted for the burst. */
export async function runBurst(
  plan: PlannedRequest[],
  rng: Prng,
  opts: RunOptions,
): Promise<{ observed: Observed[]; logs: AccessLogEntry[]; wallMs: number }> {
  const logs: AccessLogEntry[] = [];
  const restore = captureAccessLog((line) =>
    logs.push(JSON.parse(line) as AccessLogEntry)
  );
  const started = performance.now();
  try {
    const observed = await Promise.all(
      plan.map(async (p) => {
        if (p.delayMs > 0) await sleep(p.delayMs);
        const headers: Record<string, string> = {};
        if (p.requestId) headers["x-request-id"] = p.requestId;
        if (p.cfIp) headers["cf-connecting-ip"] = p.cfIp;
        const token = bearerFor(p.bearer, rng, opts.actor);
        const base = apiRequest(p.method, p.fullPath, {
          ip: p.ip,
          token,
          headers,
        });
        const { request, controller } = withAbort(base, p.abort);
        opts.beforeDispatch?.(p);
        const t0 = performance.now();
        const promise = opts.h.handler(request);
        controller?.abort();
        return observe(p.index, promise, t0);
      }),
    );
    return { observed, logs, wallMs: Math.round(performance.now() - started) };
  } finally {
    restore();
    quietAccessLog();
  }
}

// ─── invariants ──────────────────────────────────────────────────────────────

export function histogram(
  values: Array<string | number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

/** Invariants every response on this surface must satisfy regardless of
 * classification. */
export function checkCommon(
  plan: PlannedRequest[],
  observed: Observed[],
  logs: AccessLogEntry[],
): Violation[] {
  const v: Violation[] = [];
  const ids = new Set<string>();
  for (const o of observed) {
    const p = plan[o.index];
    if (o.settled !== "resolved") {
      v.push({
        invariant: "no-rejection",
        detail: `#${o.index} ${o.settled}: ${o.errorMessage}`,
      });
      continue;
    }
    if (o.status >= 500) {
      v.push({
        invariant: "no-5xx",
        detail: `#${o.index} ${p.method} ${p.fullPath} → ${o.status}`,
      });
    }
    if (!o.requestId) {
      v.push({ invariant: "x-request-id-present", detail: `#${o.index}` });
    } else {
      if (!p.requestIdValid) {
        if (ids.has(o.requestId)) {
          v.push({
            invariant: "x-request-id-unique",
            detail: `#${o.index} duplicate ${o.requestId}`,
          });
        }
        ids.add(o.requestId);
      }
      if (p.requestIdValid && o.requestId !== p.requestId) {
        v.push({
          invariant: "x-request-id-echoed",
          detail: `#${o.index} sent ${p.requestId} got ${o.requestId}`,
        });
      }
      if (p.requestId && !p.requestIdValid && o.requestId === p.requestId) {
        v.push({
          invariant: "x-request-id-never-echoes-invalid",
          detail: `#${o.index} echoed ${p.requestId}`,
        });
      }
    }
    if (o.status === 429) {
      if (o.errorCode !== "rate_limited") {
        v.push({
          invariant: "429-code",
          detail: `#${o.index} code=${o.errorCode}`,
        });
      }
      const ra = Number(o.retryAfter);
      if (!(ra >= 1 && ra <= AUTH_FAILURE_WINDOW_SECONDS)) {
        v.push({
          invariant: "429-retry-after",
          detail: `#${o.index} Retry-After=${o.retryAfter}`,
        });
      }
      if (o.rateLimitRemaining !== "0") {
        v.push({
          invariant: "429-remaining-zero",
          detail: `#${o.index} ${o.rateLimitRemaining}`,
        });
      }
    }
    if (
      o.status >= 400 && o.status !== 429 &&
      !(o.contentType ?? "").includes("application/json")
    ) {
      v.push({
        invariant: "error-is-json",
        detail: `#${o.index} ${o.status} ${o.contentType}`,
      });
    }
  }
  // Access log: exactly one categorical line per request, status matches,
  // no id-bearing segment or query string leaks into `route`.
  if (logs.length !== plan.length) {
    v.push({
      invariant: "access-log-one-per-request",
      detail: `${logs.length} lines for ${plan.length} requests`,
    });
  }
  const byId = new Map(logs.map((l) => [l.requestId, l]));
  for (const o of observed) {
    if (!o.requestId) continue;
    const line = byId.get(o.requestId);
    if (!line) {
      v.push({
        invariant: "access-log-correlates",
        detail: `#${o.index} no line for ${o.requestId}`,
      });
      continue;
    }
    if (line.status !== o.status) {
      v.push({
        invariant: "access-log-status",
        detail: `#${o.index} log ${line.status} vs ${o.status}`,
      });
    }
    if (line.method !== plan[o.index].method) {
      v.push({ invariant: "access-log-method", detail: `#${o.index}` });
    }
    if (
      UUID_RE.test(line.route) || /\d{4,}/.test(line.route) ||
      line.route.includes("?")
    ) {
      v.push({
        invariant: "access-log-route-categorical",
        detail: `#${o.index} route=${line.route}`,
      });
    }
    if (o.status === 429 && line.code !== "rate_limited") {
      v.push({
        invariant: "access-log-error-code",
        detail: `#${o.index} code=${line.code}`,
      });
    }
  }
  return v;
}

/** Public-page invariants for ONE (ip, scope) budget inside ONE window.
 * `plan` is the FULL plan (indexed by Observed.index); `observed` the subset
 * that charges this budget. */
export function checkPublicBudget(
  label: string,
  plan: PlannedRequest[],
  observed: Observed[],
  limit = PUBLIC_PAGE_LIMIT,
  /** Redis failed open during the burst: the budget legitimately splits
   * across L2 and the per-isolate fallback, so at most 2×limit is admitted. */
  lossy = false,
): Violation[] {
  const v: Violation[] = [];
  const admitted = observed.filter((o) => o.status === 200).length;
  const limited = observed.filter((o) => o.status === 429).length;
  const other = observed.filter((o) => o.status !== 200 && o.status !== 429);
  const expectedAdmitted = Math.min(observed.length, limit);
  const maxAdmitted = lossy
    ? Math.min(observed.length, 2 * limit)
    : expectedAdmitted;
  if (admitted < expectedAdmitted || admitted > maxAdmitted) {
    v.push({
      invariant: lossy
        ? "public-budget-fail-open-bound"
        : "public-budget-exact",
      detail: `${label}: admitted ${admitted}, expected ${expectedAdmitted}${
        lossy ? `..${maxAdmitted}` : ""
      } of ${observed.length}`,
    });
  }
  if (admitted + limited !== observed.length || other.length) {
    v.push({
      invariant: "public-status-set",
      detail: `${label}: statuses ${
        JSON.stringify(histogram(observed.map((o) => o.status)))
      }`,
    });
  }
  for (const o of observed) {
    if (o.status !== 200) continue;
    const p = plan[o.index];
    if (p.expect.kind !== "public") continue;
    if (p.expect.scope === "healthz") {
      if (!(o.contentType ?? "").includes("application/json")) {
        v.push({
          invariant: "healthz-json",
          detail: `#${o.index} ${o.contentType}`,
        });
      }
      if (p.method === "GET" && o.bodyHead !== '{"ok":true}') {
        v.push({
          invariant: "healthz-body",
          detail: `#${o.index} ${o.bodyHead}`,
        });
      }
    } else {
      if (!(o.contentType ?? "").startsWith("text/plain")) {
        v.push({
          invariant: "legal-text-plain",
          detail: `#${o.index} ${o.contentType}`,
        });
      }
      const heading = LEGAL_HEADINGS[p.expect.suffix];
      if (p.method === "GET" && !o.bodyHead.startsWith(heading)) {
        v.push({
          invariant: "legal-body",
          detail: `#${o.index} ${o.bodyHead}`,
        });
      }
    }
  }
  return v;
}

export function checkFallthrough(
  plan: PlannedRequest[],
  observed: Observed[],
): Violation[] {
  const v: Violation[] = [];
  for (const o of observed) {
    const p = plan[o.index];
    if (o.status === 429) continue; // budget verdicts are checked by the scenario
    switch (p.expect.kind) {
      case "auth-refused-local":
      case "auth-refused-upstream":
        if (o.status !== 401) {
          v.push({
            invariant: "fallthrough-401",
            detail:
              `#${o.index} ${p.bearer} ${p.method} ${p.fullPath} → ${o.status} ${o.bodyHead}`,
          });
        }
        break;
      case "unknown-route":
        if (o.status !== 404) {
          v.push({
            invariant: "fallthrough-404",
            detail:
              `#${o.index} ${p.method} ${p.fullPath} → ${o.status} ${o.bodyHead}`,
          });
        } else if (
          p.method !== "HEAD" &&
          o.errorMessage !== `Unknown endpoint: ${p.expect.route}.`
        ) {
          v.push({
            invariant: "fallthrough-404-message",
            detail: `#${o.index} ${o.errorMessage} vs ${p.expect.route}`,
          });
        }
        break;
      case "public":
        break;
    }
  }
  return v;
}

// ─── report ──────────────────────────────────────────────────────────────────

export function outDir(campaign: string): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  const base = env ? env.endsWith("/") ? env : `${env}/` : new URL(
    "../../../../artifacts/stress-public-fallthrough/",
    import.meta.url,
  ).pathname;
  return `${base}${campaign}/`;
}

export function replayCommand(
  file: string,
  seed: number,
  scenarioFilter: string,
): string {
  return `cd supabase/functions/api/__wf__ && STRESS_REPLAY_SEED=${seed} STRESS_LATENCY_MS=${STRESS_LATENCY_MS} deno test -A --no-check --config deno.json ${file} --filter "${scenarioFilter}"`;
}

export function newReport(
  campaign: string,
  file: string,
  mode: "memory" | "redis",
): CampaignReport {
  return {
    campaign,
    file,
    mode,
    commit: Deno.env.get("STRESS_COMMIT") ?? null,
    startedAt: new Date().toISOString(),
    config: {
      STRESS_ITER: ITERATIONS,
      STRESS_SEED: STRESS_REPLAY_SEED || STRESS_SEED,
      STRESS_LATENCY_MS,
    },
    iterations: [],
    totals: { executed: 0, held: 0, broken: 0, requests: 0 },
  };
}

export function record(
  report: CampaignReport,
  row: IterationRow,
  requests: number,
): void {
  report.iterations.push(row);
  report.totals.executed += 1;
  report.totals.requests += requests;
  if (row.outcome === "HELD") report.totals.held += 1;
  else report.totals.broken += 1;
}

export async function writeReport(report: CampaignReport): Promise<string> {
  const dir = outDir(report.campaign);
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${report.file.replace(/\.test\.ts$/, "")}.json`;
  await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
  return path;
}

/** Fail the Deno test with every violated invariant of the campaign listed. */
export function assertHeld(report: CampaignReport, scenario: string): void {
  const broken = report.iterations.filter((r) =>
    r.scenario === scenario && r.outcome === "BROKEN"
  );
  assert(
    broken.length === 0,
    `${scenario}: ${broken.length} BROKEN iteration(s)\n` +
      broken
        .map((r) =>
          `  seed=${r.seed} ${
            r.violations.map((x) => `${x.invariant}: ${x.detail}`).join(" | ")
          }\n    replay: ${r.replay}`
        )
        .join("\n"),
  );
}

/** Seed of iteration `i` for a scenario: distinct per scenario and iteration,
 * stable for a given base seed. */
export function iterationSeed(
  base: number,
  scenarioIndex: number,
  i: number,
): number {
  if (STRESS_REPLAY_SEED) return STRESS_REPLAY_SEED;
  return (base + scenarioIndex * 100_003 + i * 7_919) >>> 0;
}

export function upstreamHistogram(
  h: SessionHarness,
  since: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const call of h.calls.slice(since)) {
    const path = new URL(call.url).pathname;
    const key = `${call.method} ${
      path.startsWith("/rest/v1/") ? "/rest/v1/…" : path
    }`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

export function sessionIdFromToken(token: string): string | null {
  const sid = jwtPayload(token)?.session_id;
  return typeof sid === "string" ? sid : null;
}
