/**
 * stress — POST /webhooks/revenuecat, lens `failure-load`.
 *
 * Failure injection + load against the REAL handler (../index.ts booted by
 * stress_webhook_harness.ts) with stateful fakes for RevenueCat, PostgREST,
 * GoTrue and Upstash at the fetch layer.
 *
 *   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json stress_webhook_failure_load.test.ts
 *
 * Knobs (all seeded — every iteration replays from its printed seed):
 *   STRESS_SEED=<n>          base seed (default 20260905)
 *   STRESS_ITER=<n>          iterations per fault case (default 2)
 *   STRESS_LOAD=<n>          load-campaign requests (default 1000)
 *   STRESS_USERS=<n>         distinct users/ips for the memory campaign (default 2000; 20000 for the full run)
 *   STRESS_SLOW=1            include the hang-bound cases (each waits STRESS_HANG_PROBE_MS, default 12000)
 *   STRESS_CASE=<id>         run only this fault case
 *   STRESS_REPLAY_SEED=<n>   run iteration 0 with exactly this per-iteration seed
 *   STRESS_OUT_DIR=<dir>     JSON tables (default artifacts/stress-webhook-revenuecat/latest/)
 *
 * Cases tagged `knownDefect` are asserted to REPRODUCE (the harness stays red
 * on regression of the repro, green while the defect stands) and are written
 * to the table as BROKEN; everything else must HOLD.
 */
import { assert, assertEquals } from "@std/assert";
import { captureAccessLog } from "../http.ts";
import {
  activeSubscriber,
  envInt,
  fnv1a,
  loadWorld,
  type Outcome,
  percentile,
  Prng,
  run,
  SECRET,
  type FaultRule,
  type World,
  webhookRequest,
  writeJson,
} from "./stress_webhook_harness.ts";

const BASE_SEED = envInt("STRESS_SEED", 20260905);
const ITER = Math.max(1, envInt("STRESS_ITER", 2));
const LOAD_N = Math.max(1, envInt("STRESS_LOAD", 1000));
const USERS_N = Math.max(1, envInt("STRESS_USERS", 2000));
const SLOW = Deno.env.get("STRESS_SLOW") === "1";
const HANG_PROBE_MS = envInt("STRESS_HANG_PROBE_MS", 12_000);
const ONLY_CASE = Deno.env.get("STRESS_CASE") ?? null;
const REPLAY_SEED = Deno.env.get("STRESS_REPLAY_SEED");
const VERBOSE = Deno.env.get("STRESS_VERBOSE") === "1";

captureAccessLog(() => undefined);

// ── Case model ───────────────────────────────────────────────────────────────

interface Check {
  name: string;
  holds: boolean;
  detail: string;
}
const check = (name: string, holds: boolean, detail: unknown = ""): Check => ({
  name,
  holds,
  detail: typeof detail === "string" ? detail : JSON.stringify(detail),
});

interface Ctx {
  rng: Prng;
  user: string;
  other: string;
  ip: string;
  eventId: string;
}

interface CaseResult {
  outcomes: Outcome[];
  checks: Check[];
  notes?: Record<string, unknown>;
}

interface FaultCase {
  id: string;
  upstream: "revenuecat" | "supabase-db" | "supabase-auth" | "upstash" | "request";
  describe: string;
  /** Present → the case documents a reproduced defect; the harness asserts it still reproduces. */
  knownDefect?: string;
  slow?: boolean;
  run(w: World, ctx: Ctx): Promise<CaseResult>;
}

function ctxFor(rng: Prng): Ctx {
  return { rng, user: rng.uuid(), other: rng.uuid(), ip: rng.ip(), eventId: `evt-${rng.hex(16)}` };
}

function renewal(ctx: Ctx, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ctx.eventId,
    type: "RENEWAL",
    app_user_id: ctx.user,
    product_id: "pickle_sensei_pro_monthly",
    entitlement_ids: ["pickle_sensei_pro"],
    ...overrides,
  };
}

const ok200 = (o: Outcome, verified: boolean) =>
  check(
    `200 {received:true, verified:${verified}}`,
    o.status === 200 && o.body?.received === true && o.body?.verified === verified,
    { status: o.status, body: o.body },
  );
const retryable503 = (o: Outcome) =>
  check(
    "503 generic retryable error",
    o.status === 503 && o.errorMessage === "Verification is temporarily unavailable.",
    { status: o.status, body: o.body },
  );
const noLeak = (o: Outcome) =>
  check(
    "body carries no upstream detail",
    !JSON.stringify(o.body ?? {}).match(
      /postgres|supabase|revenuecat|redis|upstash|stack|PGRST|23503/i,
    ),
    o.body,
  );
const entitlement = (w: World, user: string) => w.entitlements.get(user) ?? null;
const audited = (w: World, id: string) => w.webhookEvents.has(id);

/** One faulted delivery, then (rules cleared) the SAME event delivered again —
 * the recoverability half of every case. */
async function faultThenReplay(
  w: World,
  ctx: Ctx,
  rules: FaultRule[],
  expectFaulted: (o: Outcome) => Check[],
  expectReplay: (o: Outcome, faulted: Outcome) => Check[],
  options: { event?: Record<string, unknown>; hangProbeMs?: number; profile?: boolean } = {},
): Promise<CaseResult> {
  const event = options.event ?? renewal(ctx);
  if (options.profile !== false) w.profiles.add(ctx.user);
  w.subscribers.set(ctx.user, activeSubscriber());
  w.rules = rules;
  const faulted = await run(w, webhookRequest(event, { ip: ctx.ip }), {
    hangProbeMs: options.hangProbeMs,
  });
  const faultedChecks = [...expectFaulted(faulted), noLeak(faulted)];
  w.rules = [];
  const replay = await run(w, webhookRequest(event, { ip: ctx.ip }));
  return {
    outcomes: [faulted, replay],
    checks: [...faultedChecks, ...expectReplay(replay, faulted)],
  };
}

// Expectation bundles ---------------------------------------------------------

/** RevenueCat unavailable: 503, nothing persisted, no audit row; replay fully processes. */
const rcUnavailable =
  (rules: FaultRule[]): FaultCase["run"] =>
  (w, ctx) =>
    faultThenReplay(
      w,
      ctx,
      rules,
      (o) => [
        retryable503(o),
        check("no entitlement written", entitlement(w, ctx.user) === null),
        check("no audit row (event stays retryable)", !audited(w, ctx.eventId)),
        check("exactly 1 RC + 1 Supabase round trip", o.rcCalls === 1 && o.supabaseCalls === 1, o),
      ],
      (o) => [
        ok200(o, true),
        check("replay verified premium", entitlement(w, ctx.user)?.premium === true),
        check("replay wrote audit row", audited(w, ctx.eventId)),
      ],
    );

/** RevenueCat reachable but the folded verdict must be premium:false (honest, never an error). */
const rcHonestFalse =
  (subscriber: unknown): FaultCase["run"] =>
  async (w, ctx) => {
    w.profiles.add(ctx.user);
    w.subscribers.set(ctx.user, subscriber);
    const o = await run(w, webhookRequest(renewal(ctx), { ip: ctx.ip }));
    const row = entitlement(w, ctx.user);
    return {
      outcomes: [o],
      checks: [
        ok200(o, true),
        check("verdict persisted premium:false", row !== null && row.premium === false, row),
        check("audit row written", audited(w, ctx.eventId)),
        check("3 Supabase round trips", o.supabaseCalls === 3, o.supabaseCalls),
      ],
    };
  };

/** Lookup failed → fail open: fully processed, audit row written afterwards. */
const selectFailsOpen =
  (rules: FaultRule[]): FaultCase["run"] =>
  (w, ctx) =>
    faultThenReplay(
      w,
      ctx,
      rules,
      (o) => [
        ok200(o, true),
        check("entitlement premium written", entitlement(w, ctx.user)?.premium === true),
        check("audit row written", audited(w, ctx.eventId)),
      ],
      (o) => [
        check(
          "replay short-circuits as duplicate",
          o.status === 200 && o.body?.duplicate === true,
          o.body,
        ),
        check("replay made no RC call", o.rcCalls === 0),
      ],
    );

/** Transient failure while persisting the verdict. EXPECTED: not acknowledged as
 * processed (503 so RevenueCat retries, or no audit row so a replay reprocesses).
 * OBSERVED (knownDefect): 200 + audit row → replay is a duplicate, verdict lost. */
const persistTransient =
  (rules: FaultRule[]): FaultCase["run"] =>
  (w, ctx) =>
    faultThenReplay(
      w,
      ctx,
      rules,
      (o) => [
        check(
          "transient persist failure stays retryable (503 OR no audit row)",
          o.status === 503 || !audited(w, ctx.eventId),
          { status: o.status, body: o.body, audited: audited(w, ctx.eventId) },
        ),
      ],
      (o) => [
        check("replay lands the verdict", entitlement(w, ctx.user)?.premium === true, {
          replay: o.body,
          entitlement: entitlement(w, ctx.user),
        }),
      ],
    );

/** Audit write failed after the verdict landed: acknowledged, no row, replay reprocesses idempotently. */
const auditFails =
  (rules: FaultRule[]): FaultCase["run"] =>
  (w, ctx) =>
    faultThenReplay(
      w,
      ctx,
      rules,
      (o) => [
        ok200(o, true),
        check("entitlement premium written", entitlement(w, ctx.user)?.premium === true),
        check("no audit row", !audited(w, ctx.eventId)),
      ],
      (o) => [
        ok200(o, true),
        check(
          "replay re-verified (1 RC call) and wrote the audit row",
          o.rcCalls === 1 && audited(w, ctx.eventId),
        ),
        check(
          "entitlement still premium (idempotent upsert)",
          entitlement(w, ctx.user)?.premium === true,
        ),
      ],
    );

/** Upstash degraded: rate limiting falls back to memory, the webhook proceeds. */
const redisDegraded =
  (rules: FaultRule[], maxLatencyMs = 400): FaultCase["run"] =>
  (w, ctx) =>
    faultThenReplay(
      w,
      ctx,
      rules,
      (o) => [
        ok200(o, true),
        check("exactly 1 Upstash attempt", o.redisCalls === 1, o.redisCalls),
        check(`latency < ${maxLatencyMs}ms`, o.latencyMs < maxLatencyMs, o.latencyMs),
      ],
      (o) => [check("replay duplicate", o.body?.duplicate === true, o.body)],
    );

/** Supabase hang: with the fake released after `probe` ms the handler recovers correctly. */
const hangReleased =
  (rules: FaultRule[]): FaultCase["run"] =>
  (w, ctx) =>
    faultThenReplay(
      w,
      ctx,
      rules,
      (o) => [
        check("handler was still pending at 300ms", o.hadPendingHang, o.latencyMs),
        check(
          "after release: processed normally",
          o.status === 200 && o.body?.received === true,
          o.body,
        ),
        check("audit row written after release", audited(w, ctx.eventId)),
      ],
      (o) => [check("replay duplicate", o.body?.duplicate === true, o.body)],
      { hangProbeMs: 300 },
    );

/** Supabase hang, unbounded: EXPECTED the handler settles on its own inside the
 * probe (RevenueCat's own budget is 10s). OBSERVED (knownDefect): still pending. */
const hangUnbounded =
  (rules: FaultRule[]): FaultCase["run"] =>
  (w, ctx) =>
    faultThenReplay(
      w,
      ctx,
      rules,
      (o) => [
        check(`handler settled by itself within ${HANG_PROBE_MS}ms`, !o.hadPendingHang, {
          pendingAtProbe: o.hadPendingHang,
          latencyMs: o.latencyMs,
        }),
      ],
      (o) => [check("replay duplicate", o.body?.duplicate === true, o.body)],
      { hangProbeMs: HANG_PROBE_MS },
    );

const html502 = {
  kind: "http",
  status: 502,
  body: "<html>502 Bad Gateway</html>",
  contentType: "text/html",
} as const;

// ── The case table ───────────────────────────────────────────────────────────

const CASES: FaultCase[] = [
  // RevenueCat ---------------------------------------------------------------
  {
    id: "rc-http-500",
    upstream: "revenuecat",
    describe: "RC 500",
    run: rcUnavailable([{ target: "rc", fault: { kind: "http", status: 500, body: "{}" } }]),
  },
  {
    id: "rc-http-502-html",
    upstream: "revenuecat",
    describe: "RC 502 html",
    run: rcUnavailable([{ target: "rc", fault: html502 }]),
  },
  {
    id: "rc-http-429",
    upstream: "revenuecat",
    describe: "RC 429",
    run: rcUnavailable([
      { target: "rc", fault: { kind: "http", status: 429, body: '{"message":"rate limited"}' } },
    ]),
  },
  {
    id: "rc-http-401",
    upstream: "revenuecat",
    describe: "RC 401 (bad api key)",
    run: rcUnavailable([
      { target: "rc", fault: { kind: "http", status: 401, body: '{"code":7225}' } },
    ]),
  },
  {
    id: "rc-http-403",
    upstream: "revenuecat",
    describe: "RC 403",
    run: rcUnavailable([{ target: "rc", fault: { kind: "http", status: 403, body: "{}" } }]),
  },
  {
    id: "rc-http-404",
    upstream: "revenuecat",
    describe: "RC 404",
    run: rcUnavailable([{ target: "rc", fault: { kind: "http", status: 404, body: "{}" } }]),
  },
  {
    id: "rc-200-nonjson",
    upstream: "revenuecat",
    describe: "RC 200 non-JSON body",
    run: rcUnavailable([
      {
        target: "rc",
        fault: { kind: "http", status: 200, body: "<<<not json", contentType: "text/plain" },
      },
    ]),
  },
  {
    id: "rc-200-empty",
    upstream: "revenuecat",
    describe: "RC 200 empty body",
    run: rcUnavailable([{ target: "rc", fault: { kind: "http", status: 200, body: "" } }]),
  },
  {
    id: "rc-200-no-subscriber",
    upstream: "revenuecat",
    describe: "RC 200 {} (no subscriber key)",
    run: rcUnavailable([{ target: "rc", fault: { kind: "json", body: {} } }]),
  },
  {
    id: "rc-200-subscriber-null",
    upstream: "revenuecat",
    describe: "RC 200 subscriber:null",
    run: rcUnavailable([{ target: "rc", fault: { kind: "json", body: { subscriber: null } } }]),
  },
  {
    id: "rc-200-subscriber-array",
    upstream: "revenuecat",
    describe: "RC 200 subscriber:[]",
    run: rcUnavailable([{ target: "rc", fault: { kind: "json", body: { subscriber: [] } } }]),
  },
  {
    id: "rc-network",
    upstream: "revenuecat",
    describe: "RC connection refused",
    run: rcUnavailable([{ target: "rc", fault: { kind: "network" } }]),
  },
  {
    id: "rc-hang-10s-timeout",
    upstream: "revenuecat",
    describe: "RC hangs — the route's own 10s AbortSignal must fire",
    slow: true,
    run: async (w, ctx) => {
      w.profiles.add(ctx.user);
      w.subscribers.set(ctx.user, activeSubscriber());
      w.rules = [{ target: "rc", fault: { kind: "hang" } }];
      const o = await run(w, webhookRequest(renewal(ctx), { ip: ctx.ip }), {
        hangProbeMs: HANG_PROBE_MS,
      });
      const faultedChecks = [
        check(
          "settled by itself (abort fired, harness did not release)",
          !o.hadPendingHang,
          o.latencyMs,
        ),
        check(
          "abort fired between 9.5s and 11.5s",
          o.latencyMs > 9_500 && o.latencyMs < 11_500,
          o.latencyMs,
        ),
        retryable503(o),
        check(
          "RC request carried an AbortSignal",
          w.callsTo("rc").every((c) => c.hadSignal),
        ),
        check("no audit row", !audited(w, ctx.eventId)),
      ];
      w.rules = [];
      const replay = await run(w, webhookRequest(renewal(ctx), { ip: ctx.ip }));
      return { outcomes: [o, replay], checks: [...faultedChecks, ok200(replay, true)] };
    },
  },
  {
    id: "rc-transfer-second-subject-500",
    upstream: "revenuecat",
    describe: "TRANSFER: RC ok for source, 500 for destination — nothing may persist",
    run: async (w, ctx) => {
      w.profiles.add(ctx.user).add(ctx.other);
      w.subscribers.set(ctx.other, activeSubscriber());
      const event = {
        id: ctx.eventId,
        type: "TRANSFER",
        transferred_from: [ctx.user],
        transferred_to: [ctx.other],
      };
      w.rules = [{ target: "rc", fault: { kind: "http", status: 500, body: "{}" }, after: 1 }];
      const o = await run(w, webhookRequest(event, { ip: ctx.ip }));
      const faultedChecks = [
        retryable503(o),
        check(
          "verify-all-before-persist: no partial entitlement write",
          entitlement(w, ctx.user) === null && entitlement(w, ctx.other) === null,
        ),
        check("no audit row", !audited(w, ctx.eventId)),
      ];
      w.rules = [];
      const replay = await run(w, webhookRequest(event, { ip: ctx.ip }));
      return {
        outcomes: [o, replay],
        checks: [
          ...faultedChecks,
          ok200(replay, true),
          check(
            "replay: source not premium, destination premium",
            entitlement(w, ctx.user)?.premium === false &&
              entitlement(w, ctx.other)?.premium === true,
          ),
        ],
      };
    },
  },
  {
    id: "rc-entitlements-null",
    upstream: "revenuecat",
    describe: "subscriber.entitlements null",
    run: rcHonestFalse({ entitlements: null }),
  },
  {
    id: "rc-entitlements-array",
    upstream: "revenuecat",
    describe: "subscriber.entitlements is an array",
    run: rcHonestFalse({ entitlements: [{ pickle_sensei_pro: { expires_date: null } }] }),
  },
  {
    id: "rc-expires-garbage",
    upstream: "revenuecat",
    describe: "expires_date unparsable",
    run: rcHonestFalse(activeSubscriber("not-a-date")),
  },
  {
    id: "rc-expires-past",
    upstream: "revenuecat",
    describe: "expires_date in the past",
    run: rcHonestFalse(activeSubscriber(new Date(Date.now() - 60_000).toISOString())),
  },
  {
    id: "rc-expires-number",
    upstream: "revenuecat",
    describe: "expires_date numeric (ms) — not a string",
    run: rcHonestFalse({
      entitlements: { pickle_sensei_pro: { expires_date: Date.now() + 86_400_000 } },
    }),
  },
  {
    id: "rc-unknown-entitlement-key",
    upstream: "revenuecat",
    describe: "only an unknown entitlement is active",
    run: rcHonestFalse(activeSubscriber(null, "x", "some_other_entitlement")),
  },
  {
    id: "rc-entitlement-not-object",
    upstream: "revenuecat",
    describe: "entitlement value is a string",
    run: rcHonestFalse({ entitlements: { pickle_sensei_pro: "active" } }),
  },
  {
    id: "rc-expires-null-lifetime",
    upstream: "revenuecat",
    describe: "expires_date null → lifetime premium",
    run: async (w, ctx) => {
      w.profiles.add(ctx.user);
      w.subscribers.set(ctx.user, activeSubscriber(null, "pickle_sensei_pro_lifetime"));
      const o = await run(w, webhookRequest(renewal(ctx), { ip: ctx.ip }));
      const row = entitlement(w, ctx.user);
      return {
        outcomes: [o],
        checks: [
          ok200(o, true),
          check(
            "premium lifetime row",
            row?.premium === true &&
              row.expires_at === null &&
              row.product_key === "pickle_sensei_pro_lifetime",
            row,
          ),
        ],
      };
    },
  },
  {
    id: "rc-legacy-premium-key",
    upstream: "revenuecat",
    describe: "legacy `premium` entitlement id honoured",
    run: async (w, ctx) => {
      w.profiles.add(ctx.user);
      w.subscribers.set(
        ctx.user,
        activeSubscriber(undefined, "pickle_sensei_pro_monthly", "premium"),
      );
      const o = await run(w, webhookRequest(renewal(ctx), { ip: ctx.ip }));
      return {
        outcomes: [o],
        checks: [ok200(o, true), check("premium true", entitlement(w, ctx.user)?.premium === true)],
      };
    },
  },
  {
    id: "rc-product-id-nonstring",
    upstream: "revenuecat",
    describe: "product_identifier not a string → premium with null product",
    run: async (w, ctx) => {
      w.profiles.add(ctx.user);
      w.subscribers.set(ctx.user, {
        entitlements: { pickle_sensei_pro: { expires_date: null, product_identifier: 42 } },
      });
      const o = await run(w, webhookRequest(renewal(ctx), { ip: ctx.ip }));
      const row = entitlement(w, ctx.user);
      return {
        outcomes: [o],
        checks: [
          ok200(o, true),
          check(
            "premium, product_key null",
            row?.premium === true && row.product_key === null,
            row,
          ),
        ],
      };
    },
  },
  // Supabase DB / PostgREST ---------------------------------------------------
  {
    id: "db-select-500",
    upstream: "supabase-db",
    describe: "idempotency lookup 500 → fail open",
    run: selectFailsOpen([
      {
        target: "pg.webhook_events.get",
        fault: { kind: "http", status: 500, body: '{"message":"boom"}' },
      },
    ]),
  },
  {
    id: "db-select-network-retried",
    upstream: "supabase-db",
    describe:
      "idempotency lookup connection refused — postgrest-js retries GET 3× (1s+2s+4s) then fails open",
    slow: true,
    run: (w, ctx) =>
      faultThenReplay(
        w,
        ctx,
        [{ target: "pg.webhook_events.get", fault: { kind: "network" } }],
        (o) => [
          ok200(o, true),
          check(
            "lookup attempted 4× (6 Supabase round trips total)",
            o.supabaseCalls === 6,
            o.supabaseCalls,
          ),
          check(
            "7s of client-side backoff before failing open",
            o.latencyMs >= 6_900 && o.latencyMs < 9_000,
            o.latencyMs,
          ),
          check("audit row written", audited(w, ctx.eventId)),
        ],
        (o) => [check("replay duplicate", o.body?.duplicate === true, o.body)],
      ),
  },
  {
    id: "db-select-503-retry-after",
    upstream: "supabase-db",
    describe:
      "idempotency lookup 503 + Retry-After: 2 (PostgREST schema reload) — honoured 3× then fail open",
    slow: true,
    run: (w, ctx) =>
      faultThenReplay(
        w,
        ctx,
        [
          {
            target: "pg.webhook_events.get",
            fault: {
              kind: "http",
              status: 503,
              body: '{"message":"schema cache"}',
              headers: { "Retry-After": "2" },
            },
          },
        ],
        (o) => [
          ok200(o, true),
          check("lookup attempted 4×", o.supabaseCalls === 6, o.supabaseCalls),
          check(
            "~6s of Retry-After waits",
            o.latencyMs >= 5_900 && o.latencyMs < 8_000,
            o.latencyMs,
          ),
        ],
        (o) => [check("replay duplicate", o.body?.duplicate === true, o.body)],
      ),
  },
  {
    id: "db-select-nonjson",
    upstream: "supabase-db",
    describe: "idempotency lookup 200 non-JSON",
    run: selectFailsOpen([
      {
        target: "pg.webhook_events.get",
        fault: { kind: "http", status: 200, body: "<html>", contentType: "text/html" },
      },
    ]),
  },
  {
    id: "db-select-401",
    upstream: "supabase-db",
    describe: "service-role key rejected on lookup",
    run: selectFailsOpen([
      {
        target: "pg.webhook_events.get",
        fault: { kind: "json", status: 401, body: { message: "Invalid API key" } },
      },
    ]),
  },
  {
    id: "db-select-two-rows",
    upstream: "supabase-db",
    describe: "lookup returns 2 rows (impossible for a PK) → maybeSingle error → fail open",
    run: selectFailsOpen([
      {
        target: "pg.webhook_events.get",
        fault: { kind: "json", body: [{ id: "a" }, { id: "b" }] },
      },
    ]),
  },
  {
    id: "db-select-200-bare-object",
    upstream: "supabase-db",
    describe: "lookup 200 with a bare JSON object (not an array)",
    knownDefect:
      "a non-array 2xx body is read as a found row → the event is acknowledged as a duplicate and never processed",
    run: (w, ctx) =>
      faultThenReplay(
        w,
        ctx,
        [{ target: "pg.webhook_events.get", fault: { kind: "json", body: { message: "ok" } } }],
        (o) => [
          check(
            "malformed lookup body is not treated as an existing row",
            !(o.status === 200 && o.body?.duplicate === true) && o.rcCalls === 1,
            { status: o.status, body: o.body, rcCalls: o.rcCalls },
          ),
        ],
        (o) => [ok200(o, true)],
      ),
  },
  {
    id: "db-select-hang-released",
    upstream: "supabase-db",
    describe: "lookup hangs 300ms then answers",
    run: hangReleased([{ target: "pg.webhook_events.get", fault: { kind: "hang" } }]),
  },
  {
    id: "db-select-hang-unbounded",
    upstream: "supabase-db",
    describe: "lookup hangs — no client-side timeout on Supabase calls",
    knownDefect:
      "createClient() has no fetch timeout; a hung PostgREST pins the request past RevenueCat's 10s budget",
    slow: true,
    run: hangUnbounded([{ target: "pg.webhook_events.get", fault: { kind: "hang" } }]),
  },
  {
    id: "db-billing-409-fk-no-profile",
    upstream: "supabase-db",
    describe: "billing upsert 23503 (user never bootstrapped) — acknowledged by design",
    run: (w, ctx) =>
      faultThenReplay(
        w,
        ctx,
        [],
        (o) => [
          ok200(o, false),
          check("no entitlement row", entitlement(w, ctx.user) === null),
          check("audit row written", audited(w, ctx.eventId)),
        ],
        (o) => [
          check(
            "replay duplicate (documented: state written on first billing sync)",
            o.body?.duplicate === true,
            o.body,
          ),
        ],
        { profile: false },
      ),
  },
  {
    id: "db-billing-500",
    upstream: "supabase-db",
    describe: "billing upsert 500",
    knownDefect:
      "transient verdict-persist failure is acknowledged (200) AND audit-logged → replay is a duplicate, verdict never lands",
    run: persistTransient([
      {
        target: "pg.billing_entitlements.post",
        fault: { kind: "http", status: 500, body: '{"message":"boom"}' },
      },
    ]),
  },
  {
    id: "db-billing-5xx-body-without-message",
    upstream: "supabase-db",
    describe: 'billing upsert 500 whose JSON body has no `message` (gateway-style {"error":…})',
    knownDefect:
      "persistBillingVerdict returns error.message (undefined) → the failed write is reported as SUCCESS: 200 verified:true, audit row written, no entitlement row",
    run: (w, ctx) =>
      faultThenReplay(
        w,
        ctx,
        [
          {
            target: "pg.billing_entitlements.post",
            fault: { kind: "json", status: 500, body: { error: "upstream connect error" } },
          },
        ],
        (o) => [
          check(
            "failed write is not reported as verified:true",
            !(o.status === 200 && o.body?.verified === true),
            {
              body: o.body,
              entitlement: entitlement(w, ctx.user),
              audited: audited(w, ctx.eventId),
            },
          ),
          check(
            "transient persist failure stays retryable (503 OR no audit row)",
            o.status === 503 || !audited(w, ctx.eventId),
          ),
        ],
        (o) => [
          check("replay lands the verdict", entitlement(w, ctx.user)?.premium === true, {
            replay: o.body,
            entitlement: entitlement(w, ctx.user),
          }),
        ],
      ),
  },
  {
    id: "db-billing-500-body-null",
    upstream: "supabase-db",
    describe: "billing upsert 500 with body `null`",
    knownDefect:
      "postgrest-js parses the body as the error → error === null → write reported as success (200 verified:true), audit row written, no entitlement row",
    run: (w, ctx) =>
      faultThenReplay(
        w,
        ctx,
        [
          {
            target: "pg.billing_entitlements.post",
            fault: { kind: "http", status: 500, body: "null" },
          },
        ],
        (o) => [
          check(
            "failed write is not reported as verified:true",
            !(o.status === 200 && o.body?.verified === true),
            {
              body: o.body,
              entitlement: entitlement(w, ctx.user),
              audited: audited(w, ctx.eventId),
            },
          ),
          check(
            "transient persist failure stays retryable (503 OR no audit row)",
            o.status === 503 || !audited(w, ctx.eventId),
          ),
        ],
        (o) => [
          check("replay lands the verdict", entitlement(w, ctx.user)?.premium === true, {
            replay: o.body,
            entitlement: entitlement(w, ctx.user),
          }),
        ],
      ),
  },
  {
    id: "db-billing-network",
    upstream: "supabase-db",
    describe: "billing upsert connection refused",
    knownDefect:
      "transient verdict-persist failure is acknowledged (200) AND audit-logged → replay is a duplicate, verdict never lands",
    run: persistTransient([{ target: "pg.billing_entitlements.post", fault: { kind: "network" } }]),
  },
  {
    id: "db-billing-nonjson",
    upstream: "supabase-db",
    describe: "billing upsert 200 non-JSON",
    knownDefect:
      "transient verdict-persist failure is acknowledged (200) AND audit-logged → replay is a duplicate, verdict never lands",
    run: persistTransient([
      {
        target: "pg.billing_entitlements.post",
        fault: { kind: "http", status: 200, body: "<html>", contentType: "text/html" },
      },
    ]),
  },
  {
    id: "db-billing-503",
    upstream: "supabase-db",
    describe: "billing upsert 503 (PostgREST pool exhausted)",
    knownDefect:
      "transient verdict-persist failure is acknowledged (200) AND audit-logged → replay is a duplicate, verdict never lands",
    run: persistTransient([
      {
        target: "pg.billing_entitlements.post",
        fault: { kind: "json", status: 503, body: { code: "PGRST001", message: "pool" } },
      },
    ]),
  },
  {
    id: "db-billing-transfer-second-fails",
    upstream: "supabase-db",
    describe: "TRANSFER: destination upsert fails transiently",
    knownDefect:
      "transient verdict-persist failure is acknowledged (200) AND audit-logged → replay is a duplicate, verdict never lands",
    run: async (w, ctx) => {
      w.profiles.add(ctx.user).add(ctx.other);
      w.subscribers.set(ctx.other, activeSubscriber());
      const event = {
        id: ctx.eventId,
        type: "TRANSFER",
        transferred_from: [ctx.user],
        transferred_to: [ctx.other],
      };
      w.rules = [
        {
          target: "pg.billing_entitlements.post",
          fault: { kind: "http", status: 500, body: "{}" },
          after: 1,
        },
      ];
      const o = await run(w, webhookRequest(event, { ip: ctx.ip }));
      const retryable = check(
        "transient persist failure stays retryable (503 OR no audit row)",
        o.status === 503 || !audited(w, ctx.eventId),
        {
          status: o.status,
          body: o.body,
          audited: audited(w, ctx.eventId),
          source: entitlement(w, ctx.user),
          dest: entitlement(w, ctx.other),
        },
      );
      w.rules = [];
      const replay = await run(w, webhookRequest(event, { ip: ctx.ip }));
      return {
        outcomes: [o, replay],
        checks: [
          retryable,
          check("replay lands destination premium", entitlement(w, ctx.other)?.premium === true, {
            replay: replay.body,
            dest: entitlement(w, ctx.other),
          }),
        ],
      };
    },
  },
  {
    id: "db-billing-hang-released",
    upstream: "supabase-db",
    describe: "billing upsert hangs 300ms then answers",
    run: hangReleased([{ target: "pg.billing_entitlements.post", fault: { kind: "hang" } }]),
  },
  {
    id: "db-billing-hang-unbounded",
    upstream: "supabase-db",
    describe: "billing upsert hangs — no client-side timeout",
    knownDefect:
      "createClient() has no fetch timeout; a hung PostgREST pins the request past RevenueCat's 10s budget",
    slow: true,
    run: hangUnbounded([{ target: "pg.billing_entitlements.post", fault: { kind: "hang" } }]),
  },
  {
    id: "db-audit-500",
    upstream: "supabase-db",
    describe: "audit upsert 500",
    run: auditFails([
      { target: "pg.webhook_events.post", fault: { kind: "http", status: 500, body: "{}" } },
    ]),
  },
  {
    id: "db-audit-network",
    upstream: "supabase-db",
    describe: "audit upsert connection refused",
    run: auditFails([{ target: "pg.webhook_events.post", fault: { kind: "network" } }]),
  },
  {
    id: "db-audit-409-unique",
    upstream: "supabase-db",
    describe: "audit upsert 23505 (concurrent writer)",
    run: auditFails([
      {
        target: "pg.webhook_events.post",
        fault: { kind: "json", status: 409, body: { code: "23505", message: "duplicate key" } },
      },
    ]),
  },
  {
    id: "db-audit-hang-released",
    upstream: "supabase-db",
    describe: "audit upsert hangs 300ms then answers",
    run: hangReleased([{ target: "pg.webhook_events.post", fault: { kind: "hang" } }]),
  },
  {
    id: "db-audit-hang-unbounded",
    upstream: "supabase-db",
    describe: "audit upsert hangs — no client-side timeout",
    knownDefect:
      "createClient() has no fetch timeout; a hung PostgREST pins the request past RevenueCat's 10s budget",
    slow: true,
    run: hangUnbounded([{ target: "pg.webhook_events.post", fault: { kind: "hang" } }]),
  },
  {
    id: "db-all-500",
    upstream: "supabase-db",
    describe: "every PostgREST call 500 (database outage)",
    run: (w, ctx) =>
      faultThenReplay(
        w,
        ctx,
        [
          {
            target: "pg.*",
            fault: { kind: "json", status: 500, body: { code: "XX000", message: "internal" } },
          },
        ],
        (o) => [
          check(
            "outage acknowledged 200 verified:false (RC consulted once)",
            o.status === 200 && o.body?.verified === false && o.rcCalls === 1,
            o,
          ),
          check(
            "nothing persisted, no audit row",
            entitlement(w, ctx.user) === null && !audited(w, ctx.eventId),
          ),
        ],
        (o) => [
          ok200(o, true),
          check("replay lands premium", entitlement(w, ctx.user)?.premium === true),
        ],
      ),
  },
  {
    id: "db-all-network",
    upstream: "supabase-db",
    describe: "every PostgREST call connection refused (lookup retried 3×, writes not)",
    slow: true,
    run: (w, ctx) =>
      faultThenReplay(
        w,
        ctx,
        [{ target: "pg.*", fault: { kind: "network" } }],
        (o) => [
          check(
            "outage acknowledged 200 verified:false",
            o.status === 200 && o.body?.verified === false,
            o,
          ),
          check("4 lookup attempts + 2 single-shot writes", o.supabaseCalls === 6, o.supabaseCalls),
          check(
            "nothing persisted, no audit row",
            entitlement(w, ctx.user) === null && !audited(w, ctx.eventId),
          ),
        ],
        (o) => [
          ok200(o, true),
          check("replay lands premium", entitlement(w, ctx.user)?.premium === true),
        ],
      ),
  },
  {
    id: "db-all-hang-released",
    upstream: "supabase-db",
    describe: "every PostgREST call hangs 300ms",
    run: hangReleased([{ target: "pg.*", fault: { kind: "hang" } }]),
  },
  // Supabase Auth (the route must not depend on it) ---------------------------
  {
    id: "auth-500-unused",
    upstream: "supabase-auth",
    describe: "GoTrue down — webhook unaffected",
    run: async (w, ctx) => {
      w.profiles.add(ctx.user);
      w.subscribers.set(ctx.user, activeSubscriber());
      w.rules = [{ target: "auth", fault: { kind: "http", status: 500, body: "{}" } }];
      const o = await run(w, webhookRequest(renewal(ctx), { ip: ctx.ip }));
      return {
        outcomes: [o],
        checks: [ok200(o, true), check("zero GoTrue calls", o.authCalls === 0, o.authCalls)],
      };
    },
  },
  {
    id: "auth-hang-unused",
    upstream: "supabase-auth",
    describe: "GoTrue hangs — webhook unaffected",
    run: async (w, ctx) => {
      w.profiles.add(ctx.user);
      w.subscribers.set(ctx.user, activeSubscriber());
      w.rules = [{ target: "auth", fault: { kind: "hang" } }];
      const o = await run(w, webhookRequest(renewal(ctx), { ip: ctx.ip }), { hangProbeMs: 2_000 });
      return {
        outcomes: [o],
        checks: [
          ok200(o, true),
          check("not pending, zero GoTrue calls", !o.hadPendingHang && o.authCalls === 0),
        ],
      };
    },
  },
  // Upstash --------------------------------------------------------------------
  {
    id: "redis-500",
    upstream: "upstash",
    describe: "Upstash 500 → memory fallback",
    run: redisDegraded([{ target: "redis", fault: { kind: "http", status: 500, body: "{}" } }]),
  },
  {
    id: "redis-network",
    upstream: "upstash",
    describe: "Upstash connection refused",
    run: redisDegraded([{ target: "redis", fault: { kind: "network" } }]),
  },
  {
    id: "redis-nonjson",
    upstream: "upstash",
    describe: "Upstash 200 non-JSON",
    run: redisDegraded([
      { target: "redis", fault: { kind: "http", status: 200, body: "not json" } },
    ]),
  },
  {
    id: "redis-error-slot",
    upstream: "upstash",
    describe: "Upstash per-command error",
    run: redisDegraded([
      {
        target: "redis",
        fault: { kind: "json", body: [{ error: "ERR max requests" }, { error: "ERR" }] },
      },
    ]),
  },
  {
    id: "redis-null-result",
    upstream: "upstash",
    describe: "Upstash INCR result null (fail open)",
    run: redisDegraded([
      { target: "redis", fault: { kind: "json", body: [{ result: null }, { result: 0 }] } },
    ]),
  },
  {
    id: "redis-garbage-string",
    upstream: "upstash",
    describe: "Upstash INCR result non-numeric",
    run: redisDegraded([
      { target: "redis", fault: { kind: "json", body: [{ result: "abc" }, { result: 1 }] } },
    ]),
  },
  {
    id: "redis-object-not-array",
    upstream: "upstash",
    describe: "Upstash reply is an object",
    run: redisDegraded([{ target: "redis", fault: { kind: "json", body: { result: 1 } } }]),
  },
  {
    id: "redis-hang-1200ms",
    upstream: "upstash",
    describe: "Upstash hangs → 1.2s timeout then memory fallback",
    run: redisDegraded([{ target: "redis", fault: { kind: "hang" } }], 2_500),
  },
  {
    id: "redis-over-limit-429",
    upstream: "upstash",
    describe: "shared counter already over 240/min → 429 with Retry-After, no upstream work",
    run: async (w, ctx) => {
      w.profiles.add(ctx.user);
      w.subscribers.set(ctx.user, activeSubscriber());
      w.rules = [
        {
          target: "redis",
          fault: { kind: "json", body: [{ result: 241 }, { result: 1 }] },
          times: 1,
        },
      ];
      const o = await run(w, webhookRequest(renewal(ctx), { ip: ctx.ip }));
      const replay = await run(w, webhookRequest(renewal(ctx), { ip: ctx.ip }));
      return {
        outcomes: [o, replay],
        checks: [
          check(
            "429 rate_limited with Retry-After ≤ 60",
            o.status === 429 &&
              o.body?.error !== undefined &&
              Number(o.retryAfter) >= 1 &&
              Number(o.retryAfter) <= 60,
            { status: o.status, retryAfter: o.retryAfter },
          ),
          check("no RC / Supabase work while limited", o.rcCalls === 0 && o.supabaseCalls === 0),
          ok200(replay, true),
        ],
      };
    },
  },
  {
    id: "redis-down-memory-window-241",
    upstream: "upstash",
    describe: "Upstash down: per-isolate window still stops the 241st hit from one IP",
    run: async (w, ctx) => {
      w.profiles.add(ctx.user);
      w.subscribers.set(ctx.user, activeSubscriber());
      w.rules = [{ target: "redis", fault: { kind: "network" } }];
      const statuses: number[] = [];
      for (let i = 0; i < 241; i += 1) {
        const o = await run(
          w,
          webhookRequest({ ...renewal(ctx), id: `${ctx.eventId}-${i}` }, { ip: ctx.ip }),
        );
        statuses.push(o.status);
      }
      const otherIp = await run(
        w,
        webhookRequest({ ...renewal(ctx), id: `${ctx.eventId}-x` }, { ip: ctx.rng.ip() }),
      );
      return {
        outcomes: [otherIp],
        checks: [
          check(
            "first 240 accepted",
            statuses.slice(0, 240).every((s) => s === 200),
            statuses.filter((s) => s !== 200).length,
          ),
          check("241st refused 429", statuses[240] === 429, statuses[240]),
          check("a different IP is unaffected", otherIp.status === 200),
        ],
        notes: { statusHistogram: histogram(statuses) },
      };
    },
  },
  // Inbound request shapes -----------------------------------------------------
  {
    id: "req-no-authorization",
    upstream: "request",
    describe: "missing Authorization → 401, no upstream work",
    run: async (w, ctx) => {
      const o = await run(w, webhookRequest(renewal(ctx), { ip: ctx.ip, authorization: null }));
      return {
        outcomes: [o],
        checks: [
          check("401", o.status === 401 && o.errorMessage === "Invalid webhook credentials."),
          check("no RC/Supabase", o.rcCalls === 0 && o.supabaseCalls === 0),
        ],
      };
    },
  },
  {
    id: "req-wrong-secret-same-length",
    upstream: "request",
    describe: "wrong secret of identical length → 401",
    run: async (w, ctx) => {
      const forged = SECRET.slice(0, -1) + (SECRET.endsWith("x") ? "y" : "x");
      const o = await run(w, webhookRequest(renewal(ctx), { ip: ctx.ip, authorization: forged }));
      return {
        outcomes: [o],
        checks: [
          check("401", o.status === 401),
          check("no RC/Supabase", o.rcCalls === 0 && o.supabaseCalls === 0),
        ],
      };
    },
  },
  {
    id: "req-bearer-prefixed-secret",
    upstream: "request",
    describe: "`Bearer <secret>` is not the configured header value → 401",
    run: async (w, ctx) => {
      const o = await run(
        w,
        webhookRequest(renewal(ctx), { ip: ctx.ip, authorization: `Bearer ${SECRET}` }),
      );
      return { outcomes: [o], checks: [check("401", o.status === 401)] };
    },
  },
  {
    id: "req-invalid-json",
    upstream: "request",
    describe: "body is not JSON → 400",
    run: async (w, ctx) => {
      const o = await run(w, webhookRequest(null, { ip: ctx.ip, rawBody: "{not json" }));
      return {
        outcomes: [o],
        checks: [
          check(
            "400 Missing event payload",
            o.status === 400 && o.errorMessage === "Missing event payload.",
          ),
          check("no upstream work", o.rcCalls === 0 && o.supabaseCalls === 0),
        ],
      };
    },
  },
  {
    id: "req-array-body",
    upstream: "request",
    describe: "body is a JSON array → 400",
    run: async (w, ctx) => {
      const o = await run(w, webhookRequest(null, { ip: ctx.ip, rawBody: "[1,2,3]" }));
      return { outcomes: [o], checks: [check("400", o.status === 400)] };
    },
  },
  {
    id: "req-event-not-object",
    upstream: "request",
    describe: "event is a string → 400",
    run: async (w, ctx) => {
      const o = await run(w, webhookRequest("RENEWAL", { ip: ctx.ip }));
      return { outcomes: [o], checks: [check("400", o.status === 400)] };
    },
  },
  {
    id: "req-empty-object",
    upstream: "request",
    describe: "{} → 400",
    run: async (w, ctx) => {
      const o = await run(w, webhookRequest(null, { ip: ctx.ip }));
      return { outcomes: [o], checks: [check("400", o.status === 400)] };
    },
  },
  {
    id: "req-oversized-body-413",
    upstream: "request",
    describe: "5 MB + 1 body → 413, no upstream work",
    run: async (w, ctx) => {
      const rawBody = JSON.stringify({
        event: { id: ctx.eventId, app_user_id: ctx.user, pad: "x".repeat(5_000_001) },
      });
      const o = await run(w, webhookRequest(null, { ip: ctx.ip, rawBody }));
      return {
        outcomes: [o],
        checks: [
          check("413", o.status === 413, o.status),
          check("no upstream work", o.rcCalls === 0 && o.supabaseCalls === 0),
        ],
      };
    },
  },
  {
    id: "req-content-length-lie",
    upstream: "request",
    describe: "content-length says 10 bytes, body is 5 MB+ → still 413",
    run: async (w, ctx) => {
      const rawBody = JSON.stringify({ event: { id: ctx.eventId, pad: "x".repeat(5_000_001) } });
      const o = await run(w, webhookRequest(null, { ip: ctx.ip, rawBody, contentLength: "10" }));
      return { outcomes: [o], checks: [check("413", o.status === 413, o.status)] };
    },
  },
  {
    id: "req-event-id-number",
    upstream: "request",
    describe: "event.id numeric → no dedupe key; two deliveries both processed (by design)",
    run: async (w, ctx) => {
      w.profiles.add(ctx.user);
      w.subscribers.set(ctx.user, activeSubscriber());
      const event = renewal(ctx, { id: 12345 });
      const a = await run(w, webhookRequest(event, { ip: ctx.ip }));
      const b = await run(w, webhookRequest(event, { ip: ctx.ip }));
      return {
        outcomes: [a, b],
        checks: [
          ok200(a, true),
          ok200(b, true),
          check("two audit rows with minted ids", w.webhookEvents.size === 2, w.webhookEvents.size),
          check("entitlement premium", entitlement(w, ctx.user)?.premium === true),
        ],
      };
    },
  },
  {
    id: "req-empty-string-event-id",
    upstream: "request",
    describe: "event.id '' is a valid (odd) dedupe key",
    run: async (w, ctx) => {
      w.profiles.add(ctx.user);
      w.subscribers.set(ctx.user, activeSubscriber());
      const a = await run(w, webhookRequest(renewal(ctx, { id: "" }), { ip: ctx.ip }));
      const b = await run(w, webhookRequest(renewal(ctx, { id: "" }), { ip: ctx.ip }));
      return {
        outcomes: [a, b],
        checks: [
          ok200(a, true),
          check("second delivery is a duplicate", b.body?.duplicate === true, b.body),
        ],
      };
    },
  },
  {
    id: "req-anonymous-with-alias",
    upstream: "request",
    describe: "$RCAnonymousID app_user_id, canonical uuid in aliases → alias verified",
    run: async (w, ctx) => {
      w.profiles.add(ctx.user);
      w.subscribers.set(ctx.user, activeSubscriber());
      const o = await run(
        w,
        webhookRequest(
          renewal(ctx, {
            app_user_id: `$RCAnonymousID:${ctx.rng.hex(32)}`,
            aliases: ["$RCAnonymousID:x", ctx.user],
          }),
          { ip: ctx.ip },
        ),
      );
      return {
        outcomes: [o],
        checks: [
          ok200(o, true),
          check(
            "RC asked for the alias uuid",
            w.callsTo("rc").some((c) => c.url.endsWith(ctx.user)),
          ),
          check("premium", entitlement(w, ctx.user)?.premium === true),
        ],
      };
    },
  },
  {
    id: "req-anonymous-only",
    upstream: "request",
    describe: "no canonical uuid anywhere → acknowledged verified:false, audited, no RC call",
    run: async (w, ctx) => {
      const event = renewal(ctx, { app_user_id: `$RCAnonymousID:${ctx.rng.hex(32)}`, aliases: [] });
      const o = await run(w, webhookRequest(event, { ip: ctx.ip }));
      const replay = await run(w, webhookRequest(event, { ip: ctx.ip }));
      return {
        outcomes: [o, replay],
        checks: [
          ok200(o, false),
          check("no RC call, 2 Supabase round trips", o.rcCalls === 0 && o.supabaseCalls === 2, o),
          check("audited", audited(w, ctx.eventId)),
          check("replay duplicate", replay.body?.duplicate === true),
        ],
      };
    },
  },
  {
    id: "req-uppercase-uuid",
    upstream: "request",
    describe: "upper-case uuid accepted and forwarded verbatim to RC",
    run: async (w, ctx) => {
      const upper = ctx.user.toUpperCase();
      w.profiles.add(upper);
      w.subscribers.set(upper, activeSubscriber());
      const o = await run(w, webhookRequest(renewal(ctx, { app_user_id: upper }), { ip: ctx.ip }));
      return {
        outcomes: [o],
        checks: [
          ok200(o, true),
          check(
            "RC url carries the upper-case id",
            w.callsTo("rc").some((c) => c.url.endsWith(upper)),
          ),
        ],
      };
    },
  },
  {
    id: "req-transfer-two-subjects",
    upstream: "request",
    describe: "TRANSFER re-verifies both sides — 4 Supabase round trips",
    run: async (w, ctx) => {
      w.profiles.add(ctx.user).add(ctx.other);
      w.subscribers.set(ctx.other, activeSubscriber());
      const event = {
        id: ctx.eventId,
        type: "TRANSFER",
        transferred_from: [ctx.user],
        transferred_to: [ctx.other],
      };
      const o = await run(w, webhookRequest(event, { ip: ctx.ip }));
      return {
        outcomes: [o],
        checks: [
          ok200(o, true),
          check(
            "source premium:false, destination premium:true",
            entitlement(w, ctx.user)?.premium === false &&
              entitlement(w, ctx.other)?.premium === true,
          ),
          check(
            "2 RC calls, 4 Supabase round trips (1 lookup + 2 upserts + 1 audit)",
            o.rcCalls === 2 && o.supabaseCalls === 4,
            o,
          ),
        ],
      };
    },
  },
  {
    id: "req-transfer-many-subjects",
    upstream: "request",
    describe: "TRANSFER with 12 uuids → sequential RC calls and upserts scale linearly",
    run: async (w, ctx) => {
      const ids = Array.from({ length: 12 }, () => ctx.rng.uuid());
      for (const id of ids) w.profiles.add(id);
      const event = {
        id: ctx.eventId,
        type: "TRANSFER",
        transferred_from: ids.slice(0, 6),
        transferred_to: ids.slice(6),
      };
      const o = await run(w, webhookRequest(event, { ip: ctx.ip }));
      return {
        outcomes: [o],
        checks: [
          ok200(o, true),
          check(
            "12 RC calls, 14 Supabase round trips",
            o.rcCalls === 12 && o.supabaseCalls === 14,
            o,
          ),
        ],
        notes: { rcCalls: o.rcCalls, supabaseCalls: o.supabaseCalls },
      };
    },
  },
  {
    id: "req-concurrent-duplicates-16",
    upstream: "request",
    describe:
      "16 concurrent deliveries of one event (seeded upstream latency) — no double-spend, one audit row",
    run: async (w, ctx) => {
      w.profiles.add(ctx.user);
      w.subscribers.set(ctx.user, activeSubscriber());
      const lat = new Prng(ctx.rng.int(1 << 30));
      w.latency = () => lat.int(4);
      const before = w.calls.length;
      const responses = await Promise.all(
        Array.from({ length: 16 }, () =>
          w.handler(webhookRequest(renewal(ctx), { ip: ctx.rng.ip() })),
        ),
      );
      w.latency = () => 0;
      const bodies = await Promise.all(
        responses.map((r) => r.json() as Promise<Record<string, unknown>>),
      );
      const late = await run(w, webhookRequest(renewal(ctx), { ip: ctx.ip }));
      const rc = w.callsTo("rc", before).length;
      return {
        outcomes: [late],
        checks: [
          check(
            "all 16 answered 200 received:true",
            responses.every((r) => r.status === 200) && bodies.every((b) => b.received === true),
            histogram(responses.map((r) => r.status)),
          ),
          check(
            "exactly one audit row, one entitlement row (premium)",
            w.webhookEvents.size === 1 &&
              w.entitlements.size === 1 &&
              entitlement(w, ctx.user)?.premium === true,
          ),
          check("late replay is a duplicate", late.body?.duplicate === true),
        ],
        notes: {
          rcCallsAcrossBurst: rc,
          duplicatesInBurst: bodies.filter((b) => b.duplicate === true).length,
        },
      };
    },
  },
];

function histogram(values: Array<string | number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

// ── Fault campaign ───────────────────────────────────────────────────────────

interface Row {
  case: string;
  upstream: string;
  iteration: number;
  seed: number;
  outcome: "HELD" | "BROKEN";
  knownDefect: string | null;
  statuses: number[];
  latencyMs: number[];
  supabaseCalls: number[];
  rcCalls: number[];
  failedChecks: Check[];
  checks: number;
  notes?: Record<string, unknown>;
  replay: string;
}

const replayCommand = (caseId: string, seed: number) =>
  `STRESS_CASE=${caseId} STRESS_REPLAY_SEED=${seed} STRESS_ITER=1${SLOW ? " STRESS_SLOW=1" : ""} deno test -A --no-check --config deno.json stress_webhook_failure_load.test.ts --filter "fault campaign"`;

Deno.test(
  "stress webhook — fault campaign (≥40 upstream fault cases, seeded, replayable)",
  async () => {
    const w = await loadWorld();
    const selected = CASES.filter((c) => (ONLY_CASE ? c.id === ONLY_CASE : true)).filter(
      (c) => SLOW || !c.slow,
    );
    assert(selected.length > 0, `no case matches STRESS_CASE=${ONLY_CASE}`);
    const rows: Row[] = [];
    for (const fc of selected) {
      for (let i = 0; i < ITER; i += 1) {
        const seed =
          i === 0 && REPLAY_SEED ? Number(REPLAY_SEED) : fnv1a(`${fc.id}:${BASE_SEED}:${i}`);
        w.reset();
        if (VERBOSE) console.log(`case ${fc.id} #${i} seed=${seed}`);
        const result = await fc.run(w, ctxFor(new Prng(seed)));
        const failed = result.checks.filter((c) => !c.holds);
        rows.push({
          case: fc.id,
          upstream: fc.upstream,
          iteration: i,
          seed,
          outcome: failed.length === 0 ? "HELD" : "BROKEN",
          knownDefect: fc.knownDefect ?? null,
          statuses: result.outcomes.map((o) => o.status),
          latencyMs: result.outcomes.map((o) => Math.round(o.latencyMs * 100) / 100),
          supabaseCalls: result.outcomes.map((o) => o.supabaseCalls),
          rcCalls: result.outcomes.map((o) => o.rcCalls),
          failedChecks: failed,
          checks: result.checks.length,
          notes: result.notes,
          replay: replayCommand(fc.id, seed),
        });
      }
    }
    const unexpected = rows.filter((r) => r.outcome === "BROKEN" && !r.knownDefect);
    const notReproduced = rows.filter((r) => r.outcome === "HELD" && r.knownDefect);
    const path = await writeJson("fault_cases.json", {
      baseSeed: BASE_SEED,
      iterationsPerCase: ITER,
      slow: SLOW,
      hangProbeMs: HANG_PROBE_MS,
      cases: selected.length,
      iterations: rows.length,
      held: rows.filter((r) => r.outcome === "HELD").length,
      broken: rows.filter((r) => r.outcome === "BROKEN").length,
      brokenKnownDefect: rows.filter((r) => r.outcome === "BROKEN" && r.knownDefect).length,
      unexpectedBroken: unexpected.length,
      knownDefectNotReproduced: notReproduced.length,
      rows,
    });
    console.log(
      `fault campaign: ${rows.length} iterations over ${selected.length} cases → ${path}`,
    );
    assertEquals(
      unexpected.map((r) => `${r.case}#${r.seed}: ${r.failedChecks.map((c) => c.name).join("; ")}`),
      [],
      "unexpected BROKEN cases",
    );
    assertEquals(
      notReproduced.map((r) => `${r.case}#${r.seed}`),
      [],
      "REPRO (defect): a knownDefect case no longer reproduces — the defect was fixed; retire its knownDefect tag",
    );
  },
);

// ── Load campaign ────────────────────────────────────────────────────────────

Deno.test(
  `stress webhook — load campaign (${LOAD_N} requests: p50/p95 latency, Supabase round trips per request)`,
  async () => {
    const w = await loadWorld();
    const rng = new Prng(fnv1a(`load:${BASE_SEED}`));
    const users = Array.from({ length: 400 }, () => rng.uuid());
    const ips = Array.from({ length: 300 }, () => rng.ip());
    for (const u of users) {
      w.profiles.add(u);
      if (rng.next() < 0.7) w.subscribers.set(u, activeSubscriber());
    }
    const kinds = [
      "renewal",
      "renewal",
      "renewal",
      "renewal",
      "renewal",
      "renewal",
      "replay",
      "replay",
      "transfer",
      "anonymous",
      "unauthorized",
    ] as const;
    const maxRoundTrips: Record<(typeof kinds)[number], number> = {
      renewal: 3,
      replay: 1,
      transfer: 4,
      anonymous: 2,
      unauthorized: 0,
    };
    const sent: string[] = [];
    const records: Array<{
      i: number;
      kind: string;
      status: number;
      latencyMs: number;
      supabaseCalls: number;
      rcCalls: number;
      redisCalls: number;
    }> = [];
    const heapBefore = Deno.memoryUsage();
    const t0 = performance.now();
    for (let i = 0; i < LOAD_N; i += 1) {
      let kind = rng.pick(kinds);
      if (kind === "replay" && sent.length === 0) kind = "renewal";
      const ip = rng.pick(ips);
      let request: Request;
      if (kind === "replay") {
        request = webhookRequest(JSON.parse(rng.pick(sent)), { ip });
      } else if (kind === "transfer") {
        const ev = {
          id: `evt-${rng.hex(16)}`,
          type: "TRANSFER",
          transferred_from: [rng.pick(users)],
          transferred_to: [rng.pick(users)],
        };
        request = webhookRequest(ev, { ip });
      } else if (kind === "anonymous") {
        request = webhookRequest(
          {
            id: `evt-${rng.hex(16)}`,
            type: "INITIAL_PURCHASE",
            app_user_id: `$RCAnonymousID:${rng.hex(32)}`,
          },
          { ip },
        );
      } else if (kind === "unauthorized") {
        request = webhookRequest(
          { id: `evt-${rng.hex(16)}`, app_user_id: rng.pick(users) },
          { ip, authorization: "nope" },
        );
      } else {
        const ev = {
          id: `evt-${rng.hex(16)}`,
          type: rng.pick(["RENEWAL", "INITIAL_PURCHASE", "CANCELLATION", "EXPIRATION"]),
          app_user_id: rng.pick(users),
        };
        sent.push(JSON.stringify(ev));
        request = webhookRequest(ev, { ip });
      }
      const o = await run(w, request);
      records.push({
        i,
        kind,
        status: o.status,
        latencyMs: o.latencyMs,
        supabaseCalls: o.supabaseCalls,
        rcCalls: o.rcCalls,
        redisCalls: o.redisCalls,
      });
      // keep the recorded-call log bounded across the campaign
      if (w.calls.length > 5_000) w.calls.splice(0, w.calls.length - 1_000);
    }
    const wallMs = performance.now() - t0;
    const heapAfter = Deno.memoryUsage();
    const sorted = records.map((r) => r.latencyMs).sort((a, b) => a - b);
    const byKind: Record<
      string,
      { n: number; statuses: Record<string, number>; maxSupabase: number; p50: number; p95: number }
    > = {};
    for (const kind of new Set(records.map((r) => r.kind))) {
      const rs = records.filter((r) => r.kind === kind);
      const lat = rs.map((r) => r.latencyMs).sort((a, b) => a - b);
      byKind[kind] = {
        n: rs.length,
        statuses: histogram(rs.map((r) => r.status)),
        maxSupabase: Math.max(...rs.map((r) => r.supabaseCalls)),
        p50: percentile(lat, 50),
        p95: percentile(lat, 95),
      };
    }
    const violations = records.filter((r) => {
      const expected = maxRoundTrips[r.kind as (typeof kinds)[number]];
      // a transfer whose two picks are the same user, or a replay of an event whose first delivery was rate-limited, legitimately differ
      if (r.kind === "transfer" && r.supabaseCalls === 3) return false;
      if (r.kind === "replay" && r.supabaseCalls <= 3) return false;
      return r.supabaseCalls > expected;
    });
    const rateLimited = records.filter((r) => r.status === 429).length;
    const summary = {
      seed: BASE_SEED,
      requests: records.length,
      wallMs: Math.round(wallMs),
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      p99Ms: percentile(sorted, 99),
      maxMs: sorted[sorted.length - 1],
      statusHistogram: histogram(records.map((r) => r.status)),
      rateLimited429: rateLimited,
      supabaseRoundTripsHistogram: histogram(records.map((r) => r.supabaseCalls)),
      byKind,
      roundTripViolations: violations,
      heap: {
        before: heapBefore,
        after: heapAfter,
        heapUsedDeltaBytes: heapAfter.heapUsed - heapBefore.heapUsed,
      },
      tables: {
        webhookEvents: w.webhookEvents.size,
        entitlements: w.entitlements.size,
        redisKeys: w.redis.size,
      },
      replay: `STRESS_SEED=${BASE_SEED} STRESS_LOAD=${LOAD_N} deno test -A --no-check --config deno.json stress_webhook_failure_load.test.ts --filter "load campaign"`,
      records,
    };
    const path = await writeJson("load.json", summary);
    console.log(
      `load: n=${records.length} p50=${summary.p50Ms.toFixed(2)}ms p95=${summary.p95Ms.toFixed(2)}ms 429=${rateLimited} → ${path}`,
    );
    assertEquals(violations, [], "requests exceeding the expected Supabase round-trip budget");
    assertEquals(
      records.filter((r) => r.status >= 500).length,
      0,
      "5xx under load with healthy upstreams",
    );
    assertEquals(
      records.filter((r) => r.kind === "unauthorized" && r.status !== 401 && r.status !== 429)
        .length,
      0,
    );
    assert(w.entitlements.size <= users.length);
  },
);

// ── Memory under many distinct users (Upstash down → per-isolate windows) ────

interface Phase {
  name: string;
  distinctIps: number;
  statusHistogram: Record<string, number>;
  wallMs: number;
  heapBefore: Deno.MemoryUsage;
  heapAfter: Deno.MemoryUsage;
  heapUsedDeltaBytes: number;
  samples: Array<{ i: number; heapUsed: number; rss: number }>;
}

/** N deliveries with Upstash down. `distinctIps` controls how many per-isolate
 * rate-limit windows the route must retain; the fake's tables and call log are
 * dropped continuously so the heap delta is what the HANDLER keeps. */
async function usersPhase(
  w: World,
  name: string,
  rng: Prng,
  distinctIps: number,
  gc: (() => void) | undefined,
): Promise<Phase> {
  const ips = Array.from({ length: distinctIps }, () => rng.ip());
  const statuses: number[] = [];
  const samples: Phase["samples"] = [];
  gc?.();
  const heapBefore = Deno.memoryUsage();
  const t0 = performance.now();
  for (let i = 0; i < USERS_N; i += 1) {
    const user = rng.uuid();
    w.profiles.add(user);
    const response = await w.handler(
      webhookRequest(
        { id: `evt-${rng.hex(16)}`, type: "RENEWAL", app_user_id: user },
        { ip: ips[i % ips.length] },
      ),
    );
    statuses.push(response.status);
    await response.body?.cancel();
    w.profiles.clear();
    w.entitlements.clear();
    w.webhookEvents.clear();
    w.subscribers.clear();
    if (i % Math.max(1, Math.floor(USERS_N / 20)) === 0) {
      const m = Deno.memoryUsage();
      samples.push({ i, heapUsed: m.heapUsed, rss: m.rss });
    }
    if (w.calls.length > 2_000) w.calls.length = 0;
  }
  const wallMs = performance.now() - t0;
  w.calls.length = 0;
  gc?.();
  const heapAfter = Deno.memoryUsage();
  return {
    name,
    distinctIps,
    statusHistogram: histogram(statuses),
    wallMs: Math.round(wallMs),
    heapBefore,
    heapAfter,
    heapUsedDeltaBytes: heapAfter.heapUsed - heapBefore.heapUsed,
    samples,
  };
}

Deno.test(
  `stress webhook — ${USERS_N} distinct users/IPs with Upstash down (memory rate-limit windows, heap)`,
  async () => {
    const w = await loadWorld();
    const rng = new Prng(fnv1a(`users:${BASE_SEED}`));
    w.rules = [{ target: "redis", fault: { kind: "network" } }];
    // Run with `deno test --v8-flags=--expose-gc` for a settled heap delta.
    const gc = (globalThis as { gc?: () => void }).gc;
    // Control: the same N deliveries from few IPs (each stays under the 240/min
    // webhook budget) — same logging/allocation churn, ~no new windows.
    const control = await usersPhase(w, "control-few-ips", rng, Math.ceil(USERS_N / 200), gc);
    const distinct = await usersPhase(w, "distinct-ips", rng, USERS_N, gc);
    const retainedByWindows = distinct.heapUsedDeltaBytes - control.heapUsedDeltaBytes;
    const summary = {
      seed: BASE_SEED,
      users: USERS_N,
      gcForced: typeof gc === "function",
      control,
      distinct,
      retainedPerDistinctIpBytes: Math.round(retainedByWindows / USERS_N),
      memoryWindowMax: 20_000,
      replay: `STRESS_SEED=${BASE_SEED} STRESS_USERS=${USERS_N} deno test -A --no-check --v8-flags=--expose-gc --config deno.json stress_webhook_failure_load.test.ts --filter "distinct users"`,
    };
    const path = await writeJson("users.json", summary);
    console.log(
      `users: n=${USERS_N} heapΔ control=${(control.heapUsedDeltaBytes / 1e6).toFixed(1)}MB distinct=${(distinct.heapUsedDeltaBytes / 1e6).toFixed(1)}MB → ${
        summary.retainedPerDistinctIpBytes
      }B/ip → ${path}`,
    );
    assertEquals(control.statusHistogram, { "200": USERS_N }, "control phase accepted");
    assertEquals(
      distinct.statusHistogram,
      { "200": USERS_N },
      "every distinct user/IP accepted with Upstash down",
    );
    if (typeof gc === "function") {
      // rateLimit.ts caps the per-isolate window map at 20k entries; a Map entry
      // (key string + {count, resetAtMs}) is well under 1 KiB, so retaining more
      // than that per distinct IP means the route is holding something else.
      assert(
        retainedByWindows < USERS_N * 1_024,
        `retained ${retainedByWindows} bytes for ${USERS_N} distinct IPs`,
      );
    }
  },
);
