/**
 * STRESS `route-post-v1-billing-sync` — lens `failure-load`.
 *
 * Real handler in-process (stress_billing_sync_harness.ts) with every
 * upstream stubbed at the fetch layer. Three campaigns, all seeded:
 *
 *   FAULTS  — each upstream (Supabase Auth, PostgREST upsert, PostgREST RPC,
 *             RevenueCat, Upstash) fails / times out / answers malformed in
 *             turn (90+ cases); asserts the user-visible status + error code,
 *             how apps/mobile classifies it, that 5xx bodies stay generic,
 *             what was persisted, and that the SAME user recovers with a 200
 *             once the fault clears.
 *   LOAD    — STRESS_ITER sequential requests (cold + warm auth, mixed
 *             RevenueCat verdicts): p50/p95/p99 latency, Supabase (GoTrue +
 *             PostgREST) and Redis round trips PER request, then concurrent
 *             bursts. >3 Supabase round trips on the warm path fails.
 *   L1      — STRESS_USERS distinct users with Redis unreachable (L1 only):
 *             heap before/after, eviction proof, and the in-memory
 *             rate-limit window behaviour past MEMORY_WINDOW_MAX.
 *
 * Replay:  STRESS_SEED=<n> STRESS_ITER=1500 STRESS_USERS=20000 STRESS_SLOW=1 \
 *          STRESS_OUT_DIR=/tmp/stress/ deno test -A --no-check --config deno.json \
 *          --v8-flags=--expose-gc stress_billing_sync_failure_load.test.ts
 * Every case id is deterministic from STRESS_SEED; a single case replays with
 * STRESS_ONLY=<case id>.
 */
import { assert, assertEquals } from "@std/assert";
import {
  accessRequest,
  billingSyncRequest,
  bootStressHarness,
  call,
  type ClientClass,
  type Fault,
  fnv1a,
  heapNow,
  histogram,
  ipFor,
  isRecord,
  latencySummary,
  type Outcome,
  Prng,
  restoreStressEnv,
  STRESS_ITER,
  STRESS_SEED,
  STRESS_SLOW,
  STRESS_USERS,
  type StressHarness,
  type Upstream,
  type UpstreamCall,
  writeJson,
} from "./stress_billing_sync_harness.ts";

const sha256Hex = async (input: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

// ─── Fault matrix ───────────────────────────────────────────────────────────

interface Expect {
  status: number | number[];
  /** error code in the body; null = generic body without a code; "any" = don't care */
  code: string | null | "any";
  cls: ClientClass | ClientClass[];
  /** billing row for the user must (not) exist after the faulted request */
  rowWritten?: boolean;
  /** billing.premium on a 200 */
  premium?: boolean;
  minLatencyMs?: number;
  maxLatencyMs?: number;
  /** upstreams that must NOT be called during the faulted request */
  notCalled?: Upstream[];
  retryAfter?: string;
}

interface Case {
  id: string;
  upstream: Upstream | "request" | "config" | "multi";
  faults: Partial<Record<Upstream, Fault>>;
  expect: Expect;
  /** the bearer to send: fresh session (default), none, expired, garbage */
  bearer?: "fresh" | "none" | "expired" | "garbage";
  /** RevenueCat subscriber body for the case's user (overrides the state);
   * a function is evaluated when the case runs (time-relative expiries) */
  subscriber?: unknown | (() => unknown);
  /** runs before the request (env tweaks, cache poisoning) — returns an undo */
  setup?: (h: StressHarness, token: string) => Promise<() => void>;
  note?: string;
  slow?: boolean;
}

const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
const past = new Date(Date.now() - 86_400_000).toISOString();
const pro = (expires: unknown, extra: Record<string, unknown> = {}) => ({
  entitlements: {
    pickle_sensei_pro: {
      expires_date: expires,
      product_identifier: "pickle_sensei_pro_monthly",
      ...extra,
    },
  },
});

const generic503: Expect = {
  status: 503,
  code: null,
  cls: "retryable_unavailable",
};
const rc502: Expect = {
  status: 502,
  code: "billing_unavailable",
  cls: "retryable_unavailable",
  rowWritten: false,
};
const refused401: Expect = {
  status: 401,
  code: "any",
  cls: "signin_expired",
  rowWritten: false,
  notCalled: ["rc", "rest.upsert", "rest.rpc"],
};
const ok = (premium: boolean): Expect => ({
  status: 200,
  code: null,
  cls: "ok",
  rowWritten: true,
  premium,
});

const CASES: Case[] = [
  // ── request-level (no upstream fault) ────────────────────────────────
  {
    id: "req-no-bearer",
    upstream: "request",
    faults: {},
    bearer: "none",
    expect: {
      ...refused401,
      notCalled: ["gotrue", "rc", "rest.upsert", "rest.rpc"],
    },
  },
  {
    id: "req-expired-bearer",
    upstream: "request",
    faults: {},
    bearer: "expired",
    expect: {
      ...refused401,
      notCalled: ["gotrue", "rc", "rest.upsert", "rest.rpc"],
    },
  },
  {
    id: "req-garbage-bearer",
    upstream: "request",
    faults: {},
    bearer: "garbage",
    expect: { ...refused401, notCalled: ["rc", "rest.upsert", "rest.rpc"] },
  },
  {
    id: "config-no-revenuecat-key",
    upstream: "config",
    faults: {},
    expect: {
      status: 503,
      code: "billing_unconfigured",
      cls: "retryable_unavailable",
      rowWritten: false,
      notCalled: ["rc"],
    },
    setup: () => {
      Deno.env.delete("REVENUECAT_SECRET_API_KEY");
      return Promise.resolve(() =>
        Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_stress")
      );
    },
  },

  // ── Supabase Auth (GoTrue) ───────────────────────────────────────────
  {
    id: "gotrue-500",
    upstream: "gotrue",
    faults: { gotrue: { kind: "http", status: 500 } },
    expect: { ...generic503, rowWritten: false, notCalled: ["rc"] },
  },
  {
    id: "gotrue-502",
    upstream: "gotrue",
    faults: { gotrue: { kind: "http", status: 502 } },
    expect: { ...generic503, rowWritten: false },
  },
  {
    id: "gotrue-503-retry-after",
    upstream: "gotrue",
    faults: {
      gotrue: { kind: "http", status: 503, headers: { "Retry-After": "7" } },
    },
    expect: { ...generic503, rowWritten: false, retryAfter: "7" },
  },
  {
    id: "gotrue-429",
    upstream: "gotrue",
    faults: {
      gotrue: { kind: "http", status: 429, headers: { "Retry-After": "3" } },
    },
    expect: { ...generic503, rowWritten: false, retryAfter: "3" },
  },
  {
    id: "gotrue-404",
    upstream: "gotrue",
    faults: { gotrue: { kind: "http", status: 404 } },
    expect: { ...generic503, rowWritten: false },
  },
  {
    id: "gotrue-401",
    upstream: "gotrue",
    faults: {
      gotrue: {
        kind: "http",
        status: 401,
        body: { code: 401, msg: "invalid JWT" },
      },
    },
    expect: refused401,
  },
  {
    id: "gotrue-403",
    upstream: "gotrue",
    faults: {
      gotrue: {
        kind: "http",
        status: 403,
        body: { error_code: "session_not_found" },
      },
    },
    expect: refused401,
  },
  {
    id: "gotrue-400",
    upstream: "gotrue",
    faults: { gotrue: { kind: "http", status: 400 } },
    expect: refused401,
  },
  {
    id: "gotrue-network",
    upstream: "gotrue",
    faults: { gotrue: { kind: "network" } },
    expect: { ...generic503, rowWritten: false },
  },
  {
    id: "gotrue-hang-deadline",
    upstream: "gotrue",
    faults: { gotrue: { kind: "hang" } },
    expect: {
      ...generic503,
      rowWritten: false,
      minLatencyMs: 380,
      maxLatencyMs: 2_000,
    },
  },
  {
    id: "gotrue-timeout-error",
    upstream: "gotrue",
    faults: { gotrue: { kind: "timeout-emulated" } },
    expect: { ...generic503, rowWritten: false },
  },
  {
    id: "gotrue-200-html",
    upstream: "gotrue",
    faults: {
      gotrue: {
        kind: "raw",
        status: 200,
        text: "<html>maintenance</html>",
        contentType: "text/html",
      },
    },
    expect: { ...generic503, rowWritten: false },
  },
  {
    id: "gotrue-200-empty",
    upstream: "gotrue",
    faults: { gotrue: { kind: "raw", status: 200, text: "" } },
    expect: { ...generic503, rowWritten: false },
  },
  {
    id: "gotrue-200-truncated-json",
    upstream: "gotrue",
    faults: { gotrue: { kind: "raw", status: 200, text: '{"id":"1111' } },
    expect: { ...generic503, rowWritten: false },
  },
  {
    id: "gotrue-200-no-id",
    upstream: "gotrue",
    faults: { gotrue: { kind: "json", value: { aud: "authenticated" } } },
    expect: { ...generic503, rowWritten: false },
  },
  {
    id: "gotrue-200-array",
    upstream: "gotrue",
    faults: { gotrue: { kind: "json", value: [] } },
    expect: { ...generic503, rowWritten: false },
  },
  {
    id: "gotrue-200-no-provider",
    upstream: "gotrue",
    faults: {
      gotrue: {
        kind: "json",
        value: { id: "33333333-3333-4333-8333-333333333333", app_metadata: {} },
      },
    },
    expect: { ...refused401, notCalled: ["rc", "rest.upsert", "rest.rpc"] },
  },
  {
    id: "gotrue-200-email-provider",
    upstream: "gotrue",
    faults: {
      gotrue: {
        kind: "json",
        value: {
          id: "33333333-3333-4333-8333-333333333333",
          app_metadata: { provider: "email" },
        },
      },
    },
    expect: { ...refused401, notCalled: ["rc", "rest.upsert", "rest.rpc"] },
  },
  {
    id: "gotrue-flaky-1-then-ok",
    upstream: "gotrue",
    faults: { gotrue: { kind: "flaky", failures: 1 } },
    expect: ok(true),
    note: "connect retry inside the auth deadline",
  },
  {
    id: "gotrue-flaky-2-then-ok",
    upstream: "gotrue",
    faults: { gotrue: { kind: "flaky", failures: 2 } },
    expect: ok(true),
  },
  {
    id: "gotrue-delay-150ms",
    upstream: "gotrue",
    faults: { gotrue: { kind: "delay", ms: 150 } },
    expect: { ...ok(true), minLatencyMs: 150 },
  },

  // ── RevenueCat ───────────────────────────────────────────────────────
  {
    id: "rc-500",
    upstream: "rc",
    faults: { rc: { kind: "http", status: 500 } },
    expect: { ...rc502, notCalled: ["rest.upsert", "rest.rpc"] },
  },
  {
    id: "rc-502",
    upstream: "rc",
    faults: { rc: { kind: "http", status: 502 } },
    expect: rc502,
  },
  {
    id: "rc-503",
    upstream: "rc",
    faults: { rc: { kind: "http", status: 503 } },
    expect: rc502,
  },
  {
    id: "rc-429",
    upstream: "rc",
    faults: {
      rc: { kind: "http", status: 429, headers: { "Retry-After": "30" } },
    },
    expect: rc502,
  },
  {
    id: "rc-401-bad-key",
    upstream: "rc",
    faults: {
      rc: {
        kind: "http",
        status: 401,
        body: { code: 7225, message: "Invalid API key" },
      },
    },
    expect: rc502,
    note: "misconfiguration surfaces as the same transient class",
  },
  {
    id: "rc-403",
    upstream: "rc",
    faults: { rc: { kind: "http", status: 403 } },
    expect: rc502,
  },
  {
    id: "rc-404-unknown-subscriber",
    upstream: "rc",
    faults: {
      rc: {
        kind: "http",
        status: 404,
        body: { code: 7259, message: "subscriber not found" },
      },
    },
    expect: rc502,
  },
  {
    id: "rc-network",
    upstream: "rc",
    faults: { rc: { kind: "network" } },
    expect: rc502,
  },
  {
    id: "rc-timeout-error",
    upstream: "rc",
    faults: { rc: { kind: "timeout-emulated" } },
    expect: rc502,
  },
  {
    id: "rc-200-html",
    upstream: "rc",
    faults: {
      rc: {
        kind: "raw",
        status: 200,
        text: "<html>cloudflare</html>",
        contentType: "text/html",
      },
    },
    expect: rc502,
  },
  {
    id: "rc-200-empty",
    upstream: "rc",
    faults: { rc: { kind: "raw", status: 200, text: "" } },
    expect: rc502,
  },
  {
    id: "rc-200-truncated",
    upstream: "rc",
    faults: {
      rc: { kind: "raw", status: 200, text: '{"subscriber":{"entitlements":{' },
    },
    expect: rc502,
  },
  {
    id: "rc-200-string",
    upstream: "rc",
    faults: { rc: { kind: "json", value: "ok" } },
    expect: rc502,
  },
  {
    id: "rc-200-no-subscriber",
    upstream: "rc",
    faults: { rc: { kind: "json", value: { request_date_ms: 1 } } },
    expect: rc502,
  },
  {
    id: "rc-200-subscriber-null",
    upstream: "rc",
    faults: { rc: { kind: "json", value: { subscriber: null } } },
    expect: rc502,
  },
  {
    id: "rc-200-subscriber-array",
    upstream: "rc",
    faults: { rc: { kind: "json", value: { subscriber: [] } } },
    expect: rc502,
  },
  {
    id: "rc-200-entitlements-array",
    upstream: "rc",
    faults: {},
    subscriber: { entitlements: [] },
    expect: ok(false),
  },
  {
    id: "rc-200-entitlements-missing",
    upstream: "rc",
    faults: {},
    subscriber: { subscriptions: {} },
    expect: ok(false),
  },
  {
    id: "rc-200-entitlement-string",
    upstream: "rc",
    faults: {},
    subscriber: { entitlements: { pickle_sensei_pro: "active" } },
    expect: ok(false),
  },
  {
    id: "rc-200-expires-garbage",
    upstream: "rc",
    faults: {},
    subscriber: pro("not-a-date"),
    expect: ok(false),
  },
  {
    id: "rc-200-expires-number",
    upstream: "rc",
    faults: {},
    subscriber: pro(Date.now() + 10_000_000),
    expect: ok(false),
    note: "epoch millis are not a string → treated as not premium",
  },
  {
    id: "rc-200-expires-empty-string",
    upstream: "rc",
    faults: {},
    subscriber: pro(""),
    expect: ok(false),
  },
  {
    id: "rc-200-expires-past",
    upstream: "rc",
    faults: {},
    subscriber: pro(past),
    expect: ok(false),
  },
  {
    id: "rc-200-expires-null-lifetime",
    upstream: "rc",
    faults: {},
    subscriber: pro(null, { product_identifier: "pickle_sensei_pro_lifetime" }),
    expect: ok(true),
  },
  {
    id: "rc-200-expires-undefined",
    upstream: "rc",
    faults: {},
    subscriber: {
      entitlements: { pickle_sensei_pro: { product_identifier: "x" } },
    },
    expect: ok(false),
    note:
      "only an explicit null expires_date is lifetime; a missing field is not premium",
  },
  {
    id: "rc-200-alias-premium",
    upstream: "rc",
    faults: {},
    subscriber: {
      entitlements: {
        premium: { expires_date: future, product_identifier: "legacy" },
      },
    },
    expect: ok(true),
  },
  {
    id: "rc-200-both-entitlements",
    upstream: "rc",
    faults: {},
    subscriber: {
      entitlements: {
        premium: { expires_date: past },
        pickle_sensei_pro: { expires_date: future },
      },
    },
    expect: ok(true),
  },
  {
    id: "rc-200-product-identifier-number",
    upstream: "rc",
    faults: {},
    subscriber: pro(future, { product_identifier: 42 }),
    expect: ok(true),
  },
  {
    id: "rc-200-expires-year-9999",
    upstream: "rc",
    faults: {},
    subscriber: pro("9999-12-31T23:59:59Z"),
    expect: ok(true),
  },
  {
    id: "rc-200-expires-non-iso-parsable",
    upstream: "rc",
    faults: {},
    subscriber: pro("Jan 1 2099 00:00:00 GMT"),
    expect: ok(true),
  },
  {
    id: "rc-200-expires-1s-future",
    upstream: "rc",
    faults: {},
    subscriber: () => pro(new Date(Date.now() + 1_500).toISOString()),
    expect: ok(true),
  },
  {
    id: "rc-200-expires-1ms-past",
    upstream: "rc",
    faults: {},
    subscriber: () => pro(new Date(Date.now() - 1).toISOString()),
    expect: ok(false),
  },
  {
    id: "rc-200-huge-entitlement-map",
    upstream: "rc",
    faults: {},
    subscriber: {
      entitlements: Object.fromEntries(
        Array.from(
          { length: 2000 },
          (_, i) => [`e${i}`, { expires_date: future }],
        ),
      ),
    },
    expect: ok(false),
  },
  {
    id: "rc-200-unrelated-entitlement",
    upstream: "rc",
    faults: {},
    subscriber: { entitlements: { other_app_pro: { expires_date: future } } },
    expect: ok(false),
  },
  {
    id: "rc-200-prototype-keys",
    upstream: "rc",
    faults: {},
    subscriber: {
      entitlements: {
        __proto__: { expires_date: future },
        constructor: { expires_date: future },
      },
    },
    expect: ok(false),
  },
  {
    id: "rc-hang-real-10s",
    upstream: "rc",
    slow: true,
    faults: { rc: { kind: "hang", releaseAfterMs: 20_000 } },
    expect: { ...rc502, minLatencyMs: 9_900, maxLatencyMs: 12_000 },
    note: "real AbortSignal.timeout(10_000)",
  },

  // ── PostgREST — service-role billing upsert ──────────────────────────
  {
    id: "upsert-500",
    upstream: "rest.upsert",
    faults: {
      "rest.upsert": {
        kind: "http",
        status: 500,
        body: { message: "stress internal" },
      },
    },
    expect: { ...generic503, rowWritten: false, notCalled: ["rest.rpc"] },
  },
  {
    id: "upsert-503",
    upstream: "rest.upsert",
    faults: {
      "rest.upsert": {
        kind: "http",
        status: 503,
        body: { message: "stress pool exhausted" },
      },
    },
    expect: { ...generic503, rowWritten: false },
  },
  {
    id: "upsert-401-bad-service-key",
    upstream: "rest.upsert",
    faults: {
      "rest.upsert": {
        kind: "http",
        status: 401,
        body: { message: "stress JWSError" },
      },
    },
    expect: { ...generic503, rowWritten: false },
  },
  {
    id: "upsert-403-rls",
    upstream: "rest.upsert",
    faults: {
      "rest.upsert": {
        kind: "http",
        status: 403,
        body: { code: "42501", message: "stress permission denied" },
      },
    },
    expect: { ...generic503, rowWritten: false },
  },
  {
    id: "upsert-409-unique",
    upstream: "rest.upsert",
    faults: {
      "rest.upsert": {
        kind: "http",
        status: 409,
        body: { code: "23505", message: "stress duplicate key" },
      },
    },
    expect: { ...generic503, rowWritten: false },
  },
  {
    id: "upsert-400-schema",
    upstream: "rest.upsert",
    faults: {
      "rest.upsert": {
        kind: "http",
        status: 400,
        body: { code: "PGRST204", message: "stress column missing" },
      },
    },
    expect: { ...generic503, rowWritten: false },
  },
  {
    id: "upsert-404-table",
    upstream: "rest.upsert",
    faults: {
      "rest.upsert": {
        kind: "http",
        status: 404,
        body: { code: "PGRST205", message: "stress table missing" },
      },
    },
    expect: { ...generic503, rowWritten: false },
  },
  {
    id: "upsert-network",
    upstream: "rest.upsert",
    faults: { "rest.upsert": { kind: "network" } },
    expect: { ...generic503, rowWritten: false },
  },
  {
    id: "upsert-timeout-error",
    upstream: "rest.upsert",
    faults: { "rest.upsert": { kind: "timeout-emulated" } },
    expect: { ...generic503, rowWritten: false },
  },
  {
    id: "upsert-hang-3s-no-deadline",
    upstream: "rest.upsert",
    faults: { "rest.upsert": { kind: "hang", releaseAfterMs: 3_000 } },
    expect: {
      status: [503],
      code: null,
      cls: "retryable_unavailable",
      rowWritten: false,
      minLatencyMs: 2_900,
    },
    note:
      "PostgREST calls carry no deadline: the request stalls for as long as PostgREST does",
  },
  {
    id: "upsert-201-garbage-body",
    upstream: "rest.upsert",
    faults: {
      "rest.upsert": { kind: "raw", status: 201, text: "<<<not json>>>" },
    },
    expect: {
      status: [200, 503],
      code: null,
      cls: ["ok", "retryable_unavailable"],
    },
  },
  {
    id: "upsert-200-empty-array",
    upstream: "rest.upsert",
    faults: { "rest.upsert": { kind: "json", status: 200, value: [] } },
    expect: { status: 200, code: null, cls: "ok" },
    note:
      "row not stored by the fake (fault short-circuits) — response still consistent",
  },
  {
    id: "upsert-delay-250ms",
    upstream: "rest.upsert",
    faults: { "rest.upsert": { kind: "delay", ms: 250 } },
    expect: { ...ok(true), minLatencyMs: 250 },
  },

  // ── PostgREST — access_state() RPC ───────────────────────────────────
  {
    id: "rpc-500",
    upstream: "rest.rpc",
    faults: {
      "rest.rpc": {
        kind: "http",
        status: 500,
        body: { message: "stress internal" },
      },
    },
    expect: { ...generic503, rowWritten: true },
  },
  {
    id: "rpc-503",
    upstream: "rest.rpc",
    faults: {
      "rest.rpc": { kind: "http", status: 503, body: { message: "stress" } },
    },
    expect: { ...generic503, rowWritten: true },
  },
  {
    id: "rpc-404-PGRST202",
    upstream: "rest.rpc",
    faults: {
      "rest.rpc": {
        kind: "http",
        status: 404,
        body: { code: "PGRST202", message: "stress function not found" },
      },
    },
    expect: { ...generic503, rowWritten: true },
  },
  {
    id: "rpc-401",
    upstream: "rest.rpc",
    faults: {
      "rest.rpc": {
        kind: "http",
        status: 401,
        body: { message: "stress jwt expired" },
      },
    },
    expect: { ...generic503, rowWritten: true },
  },
  {
    id: "rpc-400",
    upstream: "rest.rpc",
    faults: {
      "rest.rpc": {
        kind: "http",
        status: 400,
        body: { code: "42883", message: "stress" },
      },
    },
    expect: { ...generic503, rowWritten: true },
  },
  {
    id: "rpc-network",
    upstream: "rest.rpc",
    faults: { "rest.rpc": { kind: "network" } },
    expect: { ...generic503, rowWritten: true },
  },
  {
    id: "rpc-hang-3s-no-deadline",
    upstream: "rest.rpc",
    faults: { "rest.rpc": { kind: "hang", releaseAfterMs: 3_000 } },
    expect: {
      status: [503],
      code: null,
      cls: "retryable_unavailable",
      rowWritten: true,
      minLatencyMs: 2_900,
    },
  },
  {
    id: "rpc-200-empty-array",
    upstream: "rest.rpc",
    faults: { "rest.rpc": { kind: "json", value: [] } },
    expect: { ...generic503, rowWritten: true },
  },
  {
    id: "rpc-200-null",
    upstream: "rest.rpc",
    faults: { "rest.rpc": { kind: "json", value: null } },
    expect: { ...generic503, rowWritten: true },
  },
  {
    id: "rpc-200-garbage",
    upstream: "rest.rpc",
    faults: { "rest.rpc": { kind: "raw", status: 200, text: "{{{" } },
    expect: { ...generic503, rowWritten: true },
  },
  {
    id: "rpc-200-object-not-array",
    upstream: "rest.rpc",
    faults: {
      "rest.rpc": {
        kind: "json",
        value: { premium: false, scored_count: 0, reserved_count: 0 },
      },
    },
    expect: { ...generic503, rowWritten: true },
  },
  {
    id: "rpc-200-missing-fields",
    upstream: "rest.rpc",
    faults: { "rest.rpc": { kind: "json", value: [{}] } },
    expect: ok(true),
  },
  {
    id: "rpc-200-huge-counts",
    upstream: "rest.rpc",
    faults: {
      "rest.rpc": {
        kind: "json",
        value: [{ premium: true, scored_count: 1e9, reserved_count: 1e9 }],
      },
    },
    expect: ok(true),
  },
  {
    id: "rpc-200-premium-string",
    upstream: "rest.rpc",
    faults: {
      "rest.rpc": {
        kind: "json",
        value: [{ premium: "yes", scored_count: 1, reserved_count: 0 }],
      },
    },
    expect: ok(true),
    note: "verified verdict overrides the row's premium",
  },
  {
    id: "rpc-200-scored-count-string",
    upstream: "rest.rpc",
    faults: {
      "rest.rpc": {
        kind: "json",
        value: [{ premium: true, scored_count: "abc", reserved_count: 0 }],
      },
    },
    expect: ok(true),
    note: "type-unchecked row: NaN → JSON null in freeRatings.used",
  },
  {
    id: "rpc-200-negative-counts",
    upstream: "rest.rpc",
    faults: {
      "rest.rpc": {
        kind: "json",
        value: [{ premium: true, scored_count: -5, reserved_count: -1 }],
      },
    },
    expect: ok(true),
  },
  {
    id: "rpc-200-float-counts",
    upstream: "rest.rpc",
    faults: {
      "rest.rpc": {
        kind: "json",
        value: [{ premium: true, scored_count: 1.5, reserved_count: 0.25 }],
      },
    },
    expect: ok(true),
  },

  // ── Upstash Redis (cache + rate-limit L2) — must be transparent ──────
  {
    id: "redis-500",
    upstream: "redis",
    faults: { redis: { kind: "http", status: 500 } },
    expect: ok(true),
  },
  {
    id: "redis-401",
    upstream: "redis",
    faults: {
      redis: { kind: "http", status: 401, body: { error: "WRONGPASS" } },
    },
    expect: ok(true),
  },
  {
    id: "redis-429",
    upstream: "redis",
    faults: { redis: { kind: "http", status: 429 } },
    expect: ok(true),
  },
  {
    id: "redis-network",
    upstream: "redis",
    faults: { redis: { kind: "network" } },
    expect: ok(true),
  },
  {
    id: "redis-timeout-error",
    upstream: "redis",
    faults: { redis: { kind: "timeout-emulated" } },
    expect: ok(true),
  },
  {
    id: "redis-hang-1200ms-deadline",
    upstream: "redis",
    faults: { redis: { kind: "hang", releaseAfterMs: 20_000 } },
    expect: { ...ok(true), minLatencyMs: 1_100 },
    note: "each Redis call waits out its own 1.2 s deadline — sequentially",
  },
  {
    id: "redis-200-html",
    upstream: "redis",
    faults: {
      redis: {
        kind: "raw",
        status: 200,
        text: "<html/>",
        contentType: "text/html",
      },
    },
    expect: ok(true),
  },
  {
    id: "redis-200-object",
    upstream: "redis",
    faults: { redis: { kind: "json", value: { result: "OK" } } },
    expect: ok(true),
  },
  {
    id: "redis-200-short-array",
    upstream: "redis",
    faults: { redis: { kind: "json", value: [] } },
    expect: ok(true),
  },
  {
    id: "redis-200-error-slots",
    upstream: "redis",
    faults: {
      redis: {
        kind: "json",
        value: [{ error: "ERR stress" }, { error: "ERR stress" }, {
          error: "ERR stress",
        }],
      },
    },
    expect: ok(true),
  },
  {
    id: "redis-200-wrong-types",
    upstream: "redis",
    faults: {
      redis: {
        kind: "json",
        value: [{ result: true }, { result: {} }, { result: [] }],
      },
    },
    expect: ok(true),
  },
  {
    id: "redis-200-incr-answers-42",
    upstream: "redis",
    faults: {
      redis: {
        kind: "json",
        value: [{ result: 42 }, { result: 42 }, { result: 42 }],
      },
    },
    expect: {
      status: 429,
      code: "rate_limited",
      cls: "retryable_unavailable",
      rowWritten: false,
      notCalled: ["gotrue", "rc"],
    },
    note:
      "L2 counters are authoritative: a wrong count is a false 429 (retryable) — trusted-store property, not a fault-handling gap",
  },
  {
    id: "redis-200-null-results",
    upstream: "redis",
    faults: {
      redis: {
        kind: "json",
        value: [{ result: null }, { result: null }, { result: null }],
      },
    },
    expect: ok(true),
  },
  {
    id: "redis-delay-120ms",
    upstream: "redis",
    faults: { redis: { kind: "delay", ms: 120 } },
    expect: { ...ok(true), minLatencyMs: 240 },
  },
  {
    id: "redis-poisoned-auth-cache-garbage",
    upstream: "redis",
    faults: {},
    expect: ok(true),
    note: "L2 auth row holds non-JSON → must fall through to GoTrue",
    setup: async (h, token) => {
      const key = `auth:${await sha256Hex(token)}`;
      h.world.redisExec(["SET", key, "{{{not json", "EX", 600]);
      return () => {};
    },
  },
  {
    id: "redis-poisoned-auth-cache-wrong-shape",
    upstream: "redis",
    faults: {},
    expect: ok(true),
    setup: async (h, token) => {
      const key = `auth:${await sha256Hex(token)}`;
      h.world.redisExec([
        "SET",
        key,
        JSON.stringify({ id: 12345, provider: null }),
        "EX",
        600,
      ]);
      return () => {};
    },
  },

  // ── multi-upstream combinations ──────────────────────────────────────
  {
    id: "multi-redis-down+gotrue-500",
    upstream: "multi",
    faults: {
      redis: { kind: "network" },
      gotrue: { kind: "http", status: 500 },
    },
    expect: { ...generic503, rowWritten: false },
  },
  {
    id: "multi-redis-down+rc-500",
    upstream: "multi",
    faults: { redis: { kind: "network" }, rc: { kind: "http", status: 500 } },
    expect: rc502,
  },
  {
    id: "multi-redis-down+rpc-500",
    upstream: "multi",
    faults: {
      redis: { kind: "network" },
      "rest.rpc": { kind: "http", status: 500 },
    },
    expect: { ...generic503, rowWritten: true },
  },
  {
    id: "multi-gotrue-hang+rc-500",
    upstream: "multi",
    faults: { gotrue: { kind: "hang" }, rc: { kind: "http", status: 500 } },
    expect: { ...generic503, rowWritten: false, notCalled: ["rc"] },
  },
  {
    id: "multi-upsert-500+rpc-500",
    upstream: "multi",
    faults: {
      "rest.upsert": { kind: "http", status: 500 },
      "rest.rpc": { kind: "http", status: 500 },
    },
    expect: { ...generic503, rowWritten: false, notCalled: ["rest.rpc"] },
  },
  {
    id: "multi-everything-network",
    upstream: "multi",
    faults: {
      redis: { kind: "network" },
      gotrue: { kind: "network" },
      rc: { kind: "network" },
      "rest.upsert": { kind: "network" },
      "rest.rpc": { kind: "network" },
    },
    expect: {
      ...generic503,
      rowWritten: false,
      notCalled: ["rc", "rest.upsert", "rest.rpc"],
    },
  },
];

interface CaseRow {
  id: string;
  seed: number;
  upstream: string;
  faults: Record<string, string>;
  user: string;
  ip: string;
  status: number;
  code: string | null;
  clientClass: ClientClass;
  contractErrors: string[];
  retryAfter: string | null;
  latencyMs: number;
  roundTrips: Record<string, number>;
  rowWritten: boolean;
  premiumResponse: boolean | null;
  premiumRow: boolean | null;
  leaked: boolean;
  accessLogged: boolean;
  recovery: {
    status: number;
    clientClass: ClientClass;
    latencyMs: number;
    roundTrips: Record<string, number>;
  } | null;
  verdict: "HELD" | "BROKEN" | "SKIPPED";
  failures: string[];
  note?: string;
}

function roundTrips(
  calls: UpstreamCall[],
  from: number,
): Record<string, number> {
  const out: Record<string, number> = {
    gotrue: 0,
    "rest.upsert": 0,
    "rest.rpc": 0,
    rc: 0,
    redis: 0,
    supabase: 0,
  };
  for (const c of calls.slice(from)) {
    out[c.upstream] += 1;
    if (c.upstream !== "redis" && c.upstream !== "rc") out.supabase += 1;
  }
  return out;
}

const inList = <T>(value: T, allowed: T | T[]): boolean =>
  Array.isArray(allowed) ? allowed.includes(value) : allowed === value;

function judge(
  c: Case,
  out: Outcome,
  rt: Record<string, number>,
  rowWritten: boolean,
  premiumRow: boolean | null,
  leaked: boolean,
  logged: boolean,
): string[] {
  const f: string[] = [];
  const e = c.expect;
  if (!inList(out.status, e.status)) {
    f.push(`status ${out.status} (expected ${JSON.stringify(e.status)})`);
  }
  if (e.code !== "any" && out.code !== e.code) {
    f.push(`code ${out.code} (expected ${e.code})`);
  }
  if (!inList(out.clientClass, e.cls)) {
    f.push(
      `client class ${out.clientClass} (expected ${JSON.stringify(e.cls)})`,
    );
  }
  if (out.contractErrors.length) {
    f.push(`contract: ${out.contractErrors.join("; ")}`);
  }
  if (out.status >= 500 && leaked) f.push("5xx body leaks upstream detail");
  if (out.status === 500) f.push("unhandled 500");
  if (!logged) f.push("no access-log line for the request id");
  if (e.rowWritten !== undefined && rowWritten !== e.rowWritten) {
    f.push(`billing row written=${rowWritten} (expected ${e.rowWritten})`);
  }
  if (out.status === 200 && isRecord(out.body) && isRecord(out.body.billing)) {
    if (e.premium !== undefined && out.body.billing.premium !== e.premium) {
      f.push(`premium ${out.body.billing.premium} (expected ${e.premium})`);
    }
    if (rowWritten && premiumRow !== out.body.billing.premium) {
      f.push(
        `row premium ${premiumRow} != response ${out.body.billing.premium}`,
      );
    }
  }
  if (e.minLatencyMs !== undefined && out.latencyMs < e.minLatencyMs) {
    f.push(`latency ${out.latencyMs}ms < ${e.minLatencyMs}ms`);
  }
  if (e.maxLatencyMs !== undefined && out.latencyMs > e.maxLatencyMs) {
    f.push(`latency ${out.latencyMs}ms > ${e.maxLatencyMs}ms`);
  }
  if (e.retryAfter !== undefined && out.retryAfter !== e.retryAfter) {
    f.push(`Retry-After ${out.retryAfter} (expected ${e.retryAfter})`);
  }
  for (const u of e.notCalled ?? []) {
    if (rt[u] > 0) f.push(`${u} called ${rt[u]}× (expected 0)`);
  }
  return f;
}

async function runCase(
  h: StressHarness,
  c: Case,
  index: number,
): Promise<CaseRow> {
  const seed = (STRESS_SEED ^ fnv1a(c.id)) >>> 0;
  const prng = new Prng(seed);
  const userId = prng.uuid();
  const ip = ipFor(1000 + index);
  const { world } = h;
  const subscriber = typeof c.subscriber === "function"
    ? (c.subscriber as () => unknown)()
    : c.subscriber;
  world.ensureUser(userId, {
    rc: subscriber !== undefined ? { kind: "custom", subscriber } : {
      kind: "active",
      expiresAt: future,
      product: "pickle_sensei_pro_monthly",
    },
  });
  let token: string | null = world.mintSession(userId, prng);
  const validToken = token;
  if (c.bearer === "none") token = null;
  if (c.bearer === "garbage") token = `garbage-${prng.hex(24)}`;
  if (c.bearer === "expired") token = world.mintSession(userId, prng, -60);

  const undo = c.setup ? await c.setup(h, validToken) : () => {};
  for (const [u, fault] of Object.entries(c.faults)) {
    world.setFault(u as Upstream, fault);
  }
  const logMark = h.accessLog.length;
  const mark = world.calls.length;
  let out: Outcome;
  try {
    out = await call(h, billingSyncRequest(token, ip));
  } finally {
    world.clearFaults();
    undo();
  }
  const rt = roundTrips(world.calls, mark);
  const row = world.billing.get(userId);
  const text = JSON.stringify(out.body);
  const leaked = /stress|WRONGPASS|PGRST|42501|23505|JWSError/i.test(text);
  const logged = h.accessLog.slice(logMark).some((l) =>
    l.requestId === out.requestId && l.status === out.status
  );
  const failures = judge(
    c,
    out,
    rt,
    Boolean(row),
    row ? row.premium : null,
    leaked,
    logged,
  );

  // recovery: same user, same bearer, fault cleared → 200 with a valid body
  const rMark = world.calls.length;
  const rec = await call(h, billingSyncRequest(validToken, ip));
  const rrt = roundTrips(world.calls, rMark);
  if (rec.status !== 200 || rec.contractErrors.length) {
    failures.push(
      `no recovery: ${rec.status} ${rec.code ?? ""} ${
        rec.contractErrors.join("; ")
      }`,
    );
  } else {
    const recRow = world.billing.get(userId);
    const truth = world.expectedPremium(world.users.get(userId)!);
    if (!recRow || recRow.premium !== truth) {
      failures.push(
        `recovered row premium ${recRow?.premium} != RC truth ${truth}`,
      );
    }
    if (
      isRecord(rec.body) && isRecord(rec.body.billing) &&
      rec.body.billing.premium !== truth
    ) {
      failures.push(
        `recovered premium ${rec.body.billing.premium} != RC truth ${truth}`,
      );
    }
  }

  return {
    id: c.id,
    seed,
    upstream: c.upstream,
    faults: Object.fromEntries(
      Object.entries(c.faults).map(([k, v]) => [k, JSON.stringify(v)]),
    ),
    user: userId,
    ip,
    status: out.status,
    code: out.code,
    clientClass: out.clientClass,
    contractErrors: out.contractErrors,
    retryAfter: out.retryAfter,
    latencyMs: out.latencyMs,
    roundTrips: rt,
    rowWritten: Boolean(row),
    premiumResponse: isRecord(out.body) && isRecord(out.body.billing) &&
        typeof out.body.billing.premium === "boolean"
      ? out.body.billing.premium
      : null,
    premiumRow: row ? row.premium : null,
    leaked,
    accessLogged: logged,
    recovery: {
      status: rec.status,
      clientClass: rec.clientClass,
      latencyMs: rec.latencyMs,
      roundTrips: rrt,
    },
    verdict: failures.length ? "BROKEN" : "HELD",
    failures,
    note: c.note,
  };
}

Deno.test("STRESS billing/sync FAULTS — every upstream fails/times out/answers malformed in turn", async () => {
  const h = await bootStressHarness();
  const only = Deno.env.get("STRESS_ONLY");
  const rows: CaseRow[] = [];
  const startedAt = new Date().toISOString();
  for (const [i, c] of CASES.entries()) {
    if (only && c.id !== only) continue;
    if (c.slow && !STRESS_SLOW) {
      rows.push({
        id: c.id,
        seed: (STRESS_SEED ^ fnv1a(c.id)) >>> 0,
        upstream: c.upstream,
        faults: {},
        user: "",
        ip: "",
        status: 0,
        code: null,
        clientClass: "ok",
        contractErrors: [],
        retryAfter: null,
        latencyMs: 0,
        roundTrips: {},
        rowWritten: false,
        premiumResponse: null,
        premiumRow: null,
        leaked: false,
        accessLogged: false,
        recovery: null,
        verdict: "SKIPPED",
        failures: ["STRESS_SLOW=1 required"],
        note: c.note,
      });
      continue;
    }
    rows.push(await runCase(h, c, i));
  }
  const executed = rows.filter((r) => r.verdict !== "SKIPPED");
  const broken = executed.filter((r) => r.verdict === "BROKEN");
  const path = await writeJson("faults", {
    seed: STRESS_SEED,
    startedAt,
    authTimeoutMs: 400,
    cases: rows.length,
    executed: executed.length,
    skipped: rows.length - executed.length,
    broken: broken.map((r) => r.id),
    byUpstream: histogram(executed.map((r) => r.upstream)),
    byStatus: histogram(executed.map((r) => r.status)),
    byClientClass: histogram(executed.map((r) => r.clientClass)),
    counters: h.world.counters,
    handlerLogLines: h.handlerLogs.length,
    rows,
  });
  console.log(
    `[stress-faults] ${executed.length} executed, ${broken.length} BROKEN → ${path}`,
  );
  for (const r of broken) {
    console.log(`  BROKEN ${r.id} seed=${r.seed}: ${r.failures.join(" | ")}`);
  }
  // Known type-unchecked rows (see the P3 finding) are reported, not asserted,
  // so the campaign still signals any NEW breakage loudly.
  const tolerated = new Set([
    "rpc-200-scored-count-string",
    "rpc-200-negative-counts",
    "rpc-200-float-counts",
  ]);
  const unexpected = broken.filter((r) => !tolerated.has(r.id));
  assert(
    executed.length >= 40,
    `expected ≥40 executed fault cases, got ${executed.length}`,
  );
  assertEquals(unexpected.map((r) => `${r.id}: ${r.failures.join(" | ")}`), []);
});

// ─── Load campaign ──────────────────────────────────────────────────────────

interface LoadRow {
  i: number;
  user: number;
  cold: boolean;
  verdict: string;
  status: number;
  clientClass: ClientClass;
  latencyMs: number;
  rt: Record<string, number>;
}

Deno.test("STRESS billing/sync LOAD — latency percentiles + round trips per request", async () => {
  const h = await bootStressHarness();
  const { world } = h;
  const prng = new Prng(STRESS_SEED ^ 0x10ad);
  const N = STRESS_ITER;
  const POOL = Math.max(8, Math.ceil(N / 6)); // ≤ ~6 syncs per user: never hits the 10/min budget
  const users = Array.from({ length: POOL }, (_, i) => {
    const id = prng.uuid();
    world.ensureUser(id, {
      rc: {
        kind: "active",
        expiresAt: future,
        product: "pickle_sensei_pro_yearly",
      },
    });
    return {
      id,
      token: world.mintSession(id, prng),
      ip: ipFor(50_000 + i),
      hits: 0,
      verified: false,
    };
  });
  const verdicts = [
    "active",
    "active",
    "active",
    "lapsed",
    "none",
    "lifetime",
  ] as const;
  const rows: LoadRow[] = [];
  const failures: string[] = [];

  for (let i = 0; i < N; i++) {
    let u = users[prng.int(POOL)];
    while (u.hits >= 9) u = users[prng.int(POOL)];
    u.hits += 1;
    const v = prng.pick(verdicts);
    const user = world.users.get(u.id)!;
    user.rc = v === "active"
      ? {
        kind: "active",
        expiresAt: future,
        product: "pickle_sensei_pro_monthly",
      }
      : v === "lapsed"
      ? {
        kind: "lapsed",
        expiresAt: past,
        product: "pickle_sensei_pro_monthly",
      }
      : v === "lifetime"
      ? { kind: "lifetime", product: "pickle_sensei_pro_lifetime" }
      : { kind: "none" };
    user.scoredCount = prng.int(4);
    user.reservedCount = prng.int(2);
    const rotate = prng.chance(0.15);
    if (rotate) u.token = world.mintSession(u.id, prng);
    const cold = rotate || !u.verified; // first sight of a bearer → one GoTrue verification
    u.verified = true;
    const mark = world.calls.length;
    const out = await call(h, billingSyncRequest(u.token, u.ip));
    const rt = roundTrips(world.calls, mark);
    rows.push({
      i,
      user: users.indexOf(u),
      cold,
      verdict: v,
      status: out.status,
      clientClass: out.clientClass,
      latencyMs: out.latencyMs,
      rt,
    });
    const truth = world.expectedPremium(user);
    if (out.status !== 200) {
      failures.push(`#${i} status ${out.status} ${out.code}`);
    } else if (out.contractErrors.length) {
      failures.push(`#${i} contract ${out.contractErrors.join("; ")}`);
    } else if (
      isRecord(out.body) && isRecord(out.body.billing) &&
      out.body.billing.premium !== truth
    ) failures.push(`#${i} premium ${out.body.billing.premium} != ${truth}`);
    else if (world.billing.get(u.id)?.premium !== truth) {
      failures.push(`#${i} row premium != ${truth}`);
    }
    const expectedSupabase = cold ? 3 : 2;
    if (rt.supabase !== expectedSupabase) {
      failures.push(
        `#${i} supabase round trips ${rt.supabase} (expected ${expectedSupabase}, cold=${cold})`,
      );
    }
    if (rt.rc !== 1) failures.push(`#${i} rc calls ${rt.rc}`);
  }

  // concurrent bursts: distinct users per burst, 32 in flight
  const burstUsers = Array.from({ length: 32 }, (_, i) => {
    const id = prng.uuid();
    world.ensureUser(id, {
      rc: {
        kind: "active",
        expiresAt: future,
        product: "pickle_sensei_pro_monthly",
      },
    });
    return { id, token: world.mintSession(id, prng), ip: ipFor(60_000 + i) };
  });
  const burstRounds = Math.max(2, Math.ceil(N / 32 / 4));
  const burstLat: number[] = [];
  let burstNon200 = 0;
  const burstStart = performance.now();
  for (let r = 0; r < burstRounds; r++) {
    const outs = await Promise.all(
      burstUsers.map((u) => call(h, billingSyncRequest(u.token, u.ip))),
    );
    for (const o of outs) {
      burstLat.push(o.latencyMs);
      if (o.status !== 200 || o.contractErrors.length) burstNon200 += 1;
    }
  }
  const burstWallMs = performance.now() - burstStart;

  const seq = rows.map((r) => r.latencyMs);
  const cold = rows.filter((r) => r.cold).map((r) => r.latencyMs);
  const warm = rows.filter((r) => !r.cold).map((r) => r.latencyMs);
  const warmRows = rows.filter((r) => !r.cold);
  const summary = {
    seed: STRESS_SEED,
    requests: {
      sequential: rows.length,
      burst: burstLat.length,
      total: rows.length + burstLat.length,
    },
    pool: POOL,
    latencyMs: {
      sequential: latencySummary(seq),
      cold: latencySummary(cold),
      warm: latencySummary(warm),
      burst32: latencySummary(burstLat),
    },
    burstThroughputRps:
      Math.round((burstLat.length / burstWallMs) * 1000 * 10) / 10,
    roundTripsPerRequest: {
      warm: {
        supabase: histogram(warmRows.map((r) => r.rt.supabase)),
        redis: histogram(warmRows.map((r) => r.rt.redis)),
        rc: histogram(warmRows.map((r) => r.rt.rc)),
      },
      cold: {
        supabase: histogram(
          rows.filter((r) => r.cold).map((r) => r.rt.supabase),
        ),
        redis: histogram(rows.filter((r) => r.cold).map((r) => r.rt.redis)),
      },
      maxSupabaseWarm: Math.max(...warmRows.map((r) => r.rt.supabase)),
      maxSupabaseCold: Math.max(
        0,
        ...rows.filter((r) => r.cold).map((r) => r.rt.supabase),
      ),
    },
    statuses: histogram(rows.map((r) => r.status)),
    burstNon200,
    verdicts: histogram(rows.map((r) => r.verdict)),
    failures,
    heap: heapNow(),
    rows,
  };
  const path = await writeJson("load", summary);
  console.log(
    `[stress-load] n=${summary.requests.total} p50=${summary.latencyMs.sequential.p50}ms p95=${summary.latencyMs.sequential.p95}ms warm supabase RT=${
      JSON.stringify(summary.roundTripsPerRequest.warm.supabase)
    } redis RT=${
      JSON.stringify(summary.roundTripsPerRequest.warm.redis)
    } → ${path}`,
  );
  assertEquals(failures, []);
  assertEquals(burstNon200, 0);
  assert(
    summary.roundTripsPerRequest.maxSupabaseWarm <= 3,
    "warm hot path exceeds 3 Supabase round trips",
  );
});

// ─── L1 memory under many distinct users ────────────────────────────────────

Deno.test("STRESS billing/sync L1 — heap + eviction under STRESS_USERS distinct users (Redis unreachable)", async () => {
  const h = await bootStressHarness();
  const { world } = h;
  const prng = new Prng(STRESS_SEED ^ 0x1e1e);
  const U = STRESS_USERS;
  // Redis unreachable → auth cache and rate-limit windows live in L1 only.
  world.setFault("redis", { kind: "network" });

  // A canary user that has spent its 10/min billing budget before the flood.
  const canary = { id: prng.uuid(), token: "", ip: ipFor(70_000) };
  world.ensureUser(canary.id, {
    rc: {
      kind: "active",
      expiresAt: future,
      product: "pickle_sensei_pro_monthly",
    },
  });
  canary.token = world.mintSession(canary.id, prng);
  const canaryBefore: number[] = [];
  const canaryWindowOpenedAt = performance.now();
  for (let i = 0; i < 11; i++) {
    canaryBefore.push(
      (await call(h, billingSyncRequest(canary.token, canary.ip))).status,
    );
  }

  const first = { id: prng.uuid(), token: "", ip: ipFor(70_001) };
  world.ensureUser(first.id, { rc: { kind: "none" } });
  first.token = world.mintSession(first.id, prng);
  await call(h, billingSyncRequest(first.token, first.ip));
  const firstGotrue = world.counters.gotrue ?? 0;

  const before = heapNow();
  const t0 = performance.now();
  const statuses: Record<string, number> = {};
  const lat: number[] = [];
  let lastToken = "";
  let lastIp = "";
  const checkpoints: Array<
    { users: number; heapUsed: number; rss: number; sessions: number }
  > = [];
  for (let i = 0; i < U; i++) {
    const id = prng.uuid();
    world.ensureUser(id, {
      rc: i % 3 === 0 ? { kind: "none" } : {
        kind: "active",
        expiresAt: future,
        product: "pickle_sensei_pro_monthly",
      },
    });
    const token = world.mintSession(id, prng);
    const ip = ipFor(100_000 + Math.floor(i / 500)); // ≤500 users per IP: under the 1 200/min IP budget
    const out = await call(h, billingSyncRequest(token, ip));
    statuses[out.status] = (statuses[out.status] ?? 0) + 1;
    lat.push(out.latencyMs);
    lastToken = token;
    lastIp = ip;
    if ((i + 1) % 5000 === 0 || i + 1 === U) {
      const m = heapNow();
      checkpoints.push({
        users: i + 1,
        heapUsed: m.heapUsed,
        rss: m.rss,
        sessions: world.sessions.size,
      });
    }
  }
  const wallMs = performance.now() - t0;
  const after = heapNow();

  // eviction proof: the first user's cached verification is gone once L1 is
  // over MEMORY_MAX_ENTRIES (5 000) — it re-verifies with GoTrue; the last
  // user's is still there — no GoTrue call.
  const g1 = world.counters.gotrue ?? 0;
  await call(h, billingSyncRequest(first.token, first.ip));
  const firstReverified = (world.counters.gotrue ?? 0) - g1;
  const g2 = world.counters.gotrue ?? 0;
  await call(h, billingSyncRequest(lastToken, lastIp));
  const lastReverified = (world.counters.gotrue ?? 0) - g2;

  // rate-limit window behaviour after the flood: the canary spent its 10/min
  // budget BEFORE the flood; the flood adds ~U live window keys, so once the
  // in-memory map reaches MEMORY_WINDOW_MAX (20 000) rateLimit.ts clears the
  // whole map — the canary is allowed again although its 60 s window is open.
  const canaryElapsedMs = performance.now() - canaryWindowOpenedAt;
  const canaryAfter =
    (await call(h, billingSyncRequest(canary.token, canary.ip))).status;
  const canaryWindowStillOpen = canaryElapsedMs < 60_000;

  world.clearFaults();
  // Separate the harness's own tables (fake users/sessions/rows, captured
  // access log) from what the HANDLER keeps resident (L1 auth cache, rate-limit
  // windows, rank caches): drop the fake's state, GC, measure again.
  const fakeSessionsBytes = [...world.sessions.keys()].reduce(
    (a, k) => a + k.length,
    0,
  );
  const accessLogLines = h.accessLog.length;
  world.users.clear();
  world.sessions.clear();
  world.billing.clear();
  world.redis.clear();
  h.accessLog.length = 0;
  h.handlerLogs.length = 0;
  const afterHarnessCleared = heapNow();

  const report = {
    seed: STRESS_SEED,
    users: U,
    wallMs: Math.round(wallMs),
    rps: Math.round((U / wallMs) * 1000),
    statuses,
    latencyMs: latencySummary(lat),
    heap: {
      before,
      after,
      deltaHeapUsed: after.heapUsed - before.heapUsed,
      deltaRss: after.rss - before.rss,
      bytesPerUserUpperBound: Math.round(
        (after.heapUsed - before.heapUsed) / U,
      ),
      gcExposed:
        typeof (globalThis as unknown as { gc?: unknown }).gc === "function",
      checkpoints,
      harnessSessionsTokenBytes: fakeSessionsBytes,
      harnessAccessLogLines: accessLogLines,
      afterHarnessCleared,
      handlerResidentHeapUpperBound: afterHarnessCleared.heapUsed -
        before.heapUsed,
    },
    l1Eviction: {
      firstUserGotrueCallsBeforeFlood: firstGotrue,
      firstUserReverifiedAfterFlood: firstReverified,
      lastUserReverifiedAfterFlood: lastReverified,
      expectedFirstEvicted: U > 5000,
    },
    rateLimitWindow: {
      canaryStatusesBefore: canaryBefore,
      canaryStatusAfterFlood: canaryAfter,
      canaryElapsedMs: Math.round(canaryElapsedMs),
      canaryWindowStillOpen,
      budgetResetByFlood: canaryWindowStillOpen && canaryAfter === 200,
      keysAddedByFlood: `~${U} ip? no — ${
        Math.ceil(U / 500)
      } ip keys + ${U} billing_sync user keys`,
    },
    counters: world.counters,
  };
  const path = await writeJson("l1_memory", report);
  console.log(
    `[stress-l1] users=${U} heapΔ=${
      (report.heap.deltaHeapUsed / 1e6).toFixed(1)
    }MB rssΔ=${(report.heap.deltaRss / 1e6).toFixed(1)}MB handlerResidentΔ=${
      (report.heap.handlerResidentHeapUpperBound / 1e6).toFixed(1)
    }MB gc=${report.heap.gcExposed} first-reverified=${firstReverified} last-reverified=${lastReverified} canaryAfter=${canaryAfter} (window open=${canaryWindowStillOpen}) → ${path}`,
  );

  assertEquals(statuses, { "200": U });
  assertEquals(canaryBefore.slice(0, 10), Array(10).fill(200));
  assertEquals(canaryBefore[10], 429);
  assertEquals(lastReverified, 0, "most recent user must still be cached");
  if (U > 5000) {
    assertEquals(
      firstReverified,
      1,
      "oldest user must have been evicted from L1 (bounded cache)",
    );
  }
  // The window map is bounded at 20 000 keys and CLEARED when full: with ~20k
  // distinct users inside one minute the canary's spent budget is forgotten.
  // Below the bound the budget must survive the flood; at/above it the reset
  // is recorded (budgetResetByFlood) for the findings.
  if (canaryWindowStillOpen && U + Math.ceil(U / 500) + 20 < 20_000) {
    assertEquals(canaryAfter, 429, "budget must survive a sub-bound flood");
  }
});

// ─── sanity: GET /v1/me/access shares the RPC path (1 Supabase round trip) ──

Deno.test("STRESS billing/sync — access read after sync is 1 Supabase round trip and agrees with the sync", async () => {
  const h = await bootStressHarness();
  const { world } = h;
  const prng = new Prng(STRESS_SEED ^ 0xacce);
  const id = prng.uuid();
  world.ensureUser(id, {
    rc: {
      kind: "active",
      expiresAt: future,
      product: "pickle_sensei_pro_monthly",
    },
    scoredCount: 2,
  });
  const token = world.mintSession(id, prng);
  const ip = ipFor(80_000);
  const sync = await call(h, billingSyncRequest(token, ip));
  assertEquals(sync.status, 200);
  const mark = world.calls.length;
  const access = await call(h, accessRequest(token, ip));
  const rt = roundTrips(world.calls, mark);
  assertEquals(access.status, 200);
  assertEquals(rt.supabase, 1);
  assert(
    isRecord(sync.body) && isRecord(sync.body.access) && isRecord(access.body),
  );
  const syncAccess = sync.body.access;
  // entitlements differ by construction (sync carries the verified names, the
  // read carries ["premium"] only — recorded, see the P3 note); everything the
  // client decides on must agree.
  for (
    const k of ["premium", "freeRatings", "canStartRating", "paywallRequired"]
  ) {
    assertEquals(
      JSON.stringify(syncAccess[k]),
      JSON.stringify(access.body[k]),
      k,
    );
  }
  await writeJson("access_shape", {
    sync: syncAccess,
    read: access.body,
    supabaseRoundTripsRead: rt.supabase,
  });
});

// Last: hand the process-wide env back to the files that run after this one.
Deno.test("STRESS billing/sync — teardown restores Deno.env", () => {
  restoreStressEnv();
  assertEquals(Deno.env.get("AUTH_UPSTREAM_TIMEOUT_MS"), undefined);
});
