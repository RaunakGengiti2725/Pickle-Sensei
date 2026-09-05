// ADJUDICATION reproductions for stress area `edge-infra-1` on 1fb0efd7.
//
// Deliberately NOT named *.test.ts so `deno task test` does not sweep it: every
// REPRO case asserts the EXPECTED (contract) behaviour and therefore FAILS on
// the baseline by design. Each case is an independent re-derivation of a
// tester finding — none of the tester harnesses are imported; only the real
// ../index.ts (via sessionHarness.ts), ../rateLimit.ts, ../http.ts and, for the
// two Postgres cases, the disposable postgres:16 from ./xc_pg_up.sh.
//
// Run (in-process cases):
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json \
//     adjudicate_stress_edge_infra_1.repro.ts
// Run (adds the two real-Postgres cases; without XC_PG_URL they are `ignore`d):
//   ./xc_pg_up.sh && XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
//     deno test -A --no-check --config deno.json adjudicate_stress_edge_infra_1.repro.ts
//
// No network, no production project: the only fetch is the harness fake.

import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import {
  apiRequest,
  freshIp,
  GOOGLE_USER_ID,
  googleIdToken,
  loadSessionHarness,
  SUPABASE_URL,
  withFrozenClock,
} from "./sessionHarness.ts";

const h = await loadSessionHarness();
const { enforceRateLimit } = await import("../rateLimit.ts");
const { sanitizeUserText } = await import("../http.ts");

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";

/** Wrap the harness fetch for the duration of `fn`; `intercept` may answer a
 * request itself (return a Response) or hand it on (return null). */
async function withFetchFault<T>(
  intercept: (request: Request) => Promise<Response | null> | Response | null,
  fn: () => Promise<T>,
): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const forced = await intercept(request.clone());
    return forced ?? real(request);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

// ─────────────────────────────────────────────────────────────────────────────
// EI1-RL-WIPE — rateLimit.ts memoryIncr(): when the in-memory fallback map is
// full (MEMORY_WINDOW_MAX = 20 000 live windows) it calls windows.clear(),
// erasing every LIVE window — a client already answered 429 is admitted again
// inside the same window. Seed 1118917473 is the tester's; the ids are seeded
// so the replay is byte-identical.
// ─────────────────────────────────────────────────────────────────────────────
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

Deno.test(
  "REPRO EI1-RL-WIPE: a 429'd client stays 429'd while 20 000 other identities open windows (seed 1118917473)",
  async () => {
    const seed = Number(Deno.env.get("STRESS_SEED") ?? 1118917473);
    const next = lcg(seed);
    const victim = `victim-${seed}`;
    const scope = `adj-wipe-${seed}`;
    await withFrozenClock(async () => {
      let last = await enforceRateLimit(scope, victim, 5, 60);
      for (let i = 0; i < 5; i++) last = await enforceRateLimit(scope, victim, 5, 60);
      assertEquals(last.allowed, false, "precondition: victim is over budget");

      // 20 000 distinct identities each open one window (their own budget, one hit).
      for (let i = 0; i < 20_000; i++) {
        await enforceRateLimit(scope, `id-${next().toString(16)}`, 5, 60);
      }

      const after = await enforceRateLimit(scope, victim, 5, 60);
      assertEquals(
        after.allowed,
        false,
        `victim must remain limited inside its window; got allowed=${after.allowed} remaining=${after.remaining} (memoryIncr cleared every live window)`,
      );
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// EI1-LOGOUT-NON5XX — index.ts logoutRoute(): only `status >= 500` is treated
// as "upstream could not sign out"; a GoTrue 429 (or any other 4xx that is not
// "session already gone") falls through to fenceRevokedSession() + 204, so the
// app believes it is signed out while the server session (and its refresh
// token) lives on. The function's own doc-comment states the contract this
// violates ("A sign-out Supabase Auth could not perform is reported as
// retryable (503) with nothing evicted").
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "REPRO EI1-LOGOUT-NON5XX: GoTrue 429 on /logout must be 503 (not 204) and must not fence the session",
  async () => {
    h.reset();
    const session = h.mintSession(GOOGLE_USER_ID);
    const ip = freshIp();
    h.logoutStatus = 429;
    const response = await h.handler(
      apiRequest("POST", "/v1/auth/logout", { token: session.accessToken, ip }),
    );
    h.logoutStatus = null;
    const upstream = h.sessions.get(session.accessToken);
    assert(upstream && !upstream.revoked, "precondition: GoTrue did NOT revoke the session");

    // The bearer must still authenticate at this edge: nothing was revoked upstream.
    const me = await h.handler(apiRequest("GET", "/v1/me", { token: session.accessToken, ip }));
    assertEquals(
      [response.status, me.status],
      [503, 200],
      `logout answered ${response.status} and the live session then got ${me.status} at /v1/me`,
    );
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// EI1-BOOTSTRAP-OUTAGE-401 — index.ts bootstrapAuthenticate(): every
// signInWithIdToken failure (GoTrue 500/503/network) is answered 401 "The
// identity token could not be verified." and charged to the per-IP
// auth-failure budget (30 / 300 s). A GoTrue outage therefore reads as a bad
// credential and 30 sign-in attempts from one NAT lock that IP out for 5 min —
// while the session-verification path (verifyBearer) already distinguishes
// "unavailable" → 503 for the same upstream.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "REPRO EI1-BOOTSTRAP-OUTAGE-401: GoTrue 503 during bootstrap must be a 503, not a 401 that charges the auth-failure budget",
  async () => {
    h.reset();
    const ip = freshIp();
    const outage = (request: Request) =>
      request.url.startsWith(`${SUPABASE_URL}/auth/v1/token`)
        ? new Response("upstream unavailable", { status: 503 })
        : null;

    const statuses: number[] = [];
    await withFrozenClock(async () => {
      await withFetchFault(outage, async () => {
        for (let i = 0; i < 30; i++) {
          const response = await h.handler(
            apiRequest("POST", "/v1/account/bootstrap", { token: googleIdToken(), ip }),
          );
          statuses.push(response.status);
          await response.body?.cancel();
        }
      });
      // GoTrue is back. A valid credential from the same IP must be admitted.
      const recovered = await h.handler(
        apiRequest("POST", "/v1/account/bootstrap", { token: googleIdToken(), ip }),
      );
      statuses.push(recovered.status);
      await recovered.body?.cancel();
    });

    const outageClasses = [...new Set(statuses.slice(0, 30))];
    assertEquals(
      { duringOutage: outageClasses, afterRecovery: statuses[30] },
      { duringOutage: [503], afterRecovery: 200 },
      `bootstrap during a GoTrue outage answered ${JSON.stringify(outageClasses)} and, once GoTrue was back, a valid credential from the same IP got ${statuses[30]} (429 = the outage was charged as 30 auth failures and the IP is locked out for 300 s)`,
    );
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// EI1-NO-DEADLINE — PostgREST calls issued through supabase-js (here
// access_state via GET /v1/me/access) and the raw `fetch` in logoutRoute carry
// no edge-side deadline, unlike the GoTrue verification path
// (AUTH_*_DEADLINE). A hung upstream therefore hangs the request until the
// platform kills it; a socket-level fault is retried by supabase-js's own
// loop (~7 s per query). Contract: an upstream that has not answered within
// 2.5 s must produce a retryable 503, not silence.
// ─────────────────────────────────────────────────────────────────────────────
async function hangsBeyond(
  matcher: (request: Request) => boolean,
  request: () => Request,
  budgetMs: number,
): Promise<{ answered: boolean; status: number | null; ms: number }> {
  const hang = gate();
  let status: number | null = null;
  const t0 = performance.now();
  let answered = false;
  let pending!: Promise<void>;
  await withFetchFault(
    async (r) => {
      if (!matcher(r)) return null;
      await hang.wait;
      return new Response("released hang", { status: 503 });
    },
    async () => {
      pending = h.handler(request()).then(async (response) => {
        answered = true;
        status = response.status;
        await response.body?.cancel();
      });
      await Promise.race([pending, new Promise((r) => setTimeout(r, budgetMs))]);
    },
  );
  const ms = performance.now() - t0;
  const verdict = { answered, status, ms };
  hang.open(); // let the handler finish so no op leaks past the test
  await pending;
  return verdict;
}

Deno.test(
  "REPRO EI1-NO-DEADLINE: a hung PostgREST (access_state) must yield a 503 within 2.5 s",
  async () => {
    h.reset();
    const session = h.mintSession(GOOGLE_USER_ID);
    const outcome = await hangsBeyond(
      (r) => r.url.startsWith(`${SUPABASE_URL}/rest/v1/rpc/access_state`),
      () => apiRequest("GET", "/v1/me/access", { token: session.accessToken, ip: freshIp() }),
      2_500,
    );
    assert(
      outcome.answered && outcome.status === 503,
      `GET /v1/me/access with a hung PostgREST: answered=${outcome.answered} status=${outcome.status} after ${outcome.ms.toFixed(0)} ms (no deadline)`,
    );
  },
);

Deno.test(
  "REPRO EI1-NO-DEADLINE: a hung GoTrue /logout must yield a 503 within 2.5 s",
  async () => {
    h.reset();
    const session = h.mintSession(GOOGLE_USER_ID);
    const outcome = await hangsBeyond(
      (r) => r.url.startsWith(`${SUPABASE_URL}/auth/v1/logout`),
      () => apiRequest("POST", "/v1/auth/logout", { token: session.accessToken, ip: freshIp() }),
      2_500,
    );
    assert(
      outcome.answered && outcome.status === 503,
      `POST /v1/auth/logout with a hung GoTrue: answered=${outcome.answered} status=${outcome.status} after ${outcome.ms.toFixed(0)} ms (no deadline)`,
    );
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// EI1-WEBHOOK-ACK-ON-PERSIST-FAIL — index.ts handleRevenueCatWebhook(): when
// persistBillingVerdict() fails it logs and answers 200 {verified:false}. The
// in-code rationale is the missing-profiles-row FK case, but the branch also
// swallows infrastructure failures (PostgREST 500 / socket error), so
// RevenueCat stops retrying and the entitlement change (expiration, refund,
// transfer) is never written — until some client-initiated sync happens.
// Contract: an infrastructure failure must be 503 so RevenueCat retries.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "REPRO EI1-WEBHOOK-ACK-ON-PERSIST-FAIL: PostgREST 500 while persisting the verdict must be 503, not 200",
  async () => {
    h.reset();
    Deno.env.set("REVENUECAT_SECRET_API_KEY", "rc-test-key");
    try {
      const status = await withFetchFault(
        (r) => {
          if (r.url.startsWith("https://api.revenuecat.com/v1/subscribers/")) {
            return new Response(
              JSON.stringify({ subscriber: { entitlements: {}, subscriptions: {} } }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (r.url.startsWith(`${SUPABASE_URL}/rest/v1/billing_entitlements`)) {
            return new Response(JSON.stringify({ message: "upstream 500" }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            });
          }
          return null;
        },
        async () => {
          const response = await h.handler(
            apiRequest("POST", "/webhooks/revenuecat", {
              ip: freshIp(),
              headers: { Authorization: "wf-test-webhook-secret" },
              body: {
                event: { id: crypto.randomUUID(), type: "EXPIRATION", app_user_id: GOOGLE_USER_ID },
              },
            }),
          );
          await response.body?.cancel();
          return response.status;
        },
      );
      assertEquals(
        status,
        503,
        `webhook answered ${status} although the verdict was never persisted (RevenueCat will not retry a 2xx)`,
      );
    } finally {
      Deno.env.delete("REVENUECAT_SECRET_API_KEY");
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Real-Postgres cases (disposable postgres:16, shim_auth.sql + every migration).
// ─────────────────────────────────────────────────────────────────────────────
type Sql = ReturnType<typeof postgres>;
const ADJ_USER_ID = "7a1e0c3d-5b2f-4e8a-9c6d-1f0b2a3c4d5e";

async function ensureUser(sql: Sql): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${ADJ_USER_ID}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${ADJ_USER_ID}', 'adj-ei1@example.com', '{"provider":"google"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('google', 'adj-ei1-sub', '${ADJ_USER_ID}', '{"sub":"adj-ei1-sub"}')`,
  );
}

async function asUser(tx: Sql): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${ADJ_USER_ID}'`);
}

function sqlstate(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : String(error);
}

// EI1-CONSENT-CAP — index.ts grantConsent() caps consent_version and
// capture_mode with sanitizeUserText(…, 64); the applied migration
// 20260831160000_defense_in_depth.sql CHECKs both at length <= 50. Every
// edge-accepted 51–64 code-point value is refused by Postgres with 23514,
// which the route folds into a generic 503 ("Consent update") the app retries.
Deno.test({
  name: "REPRO EI1-CONSENT-CAP: a consent_version the edge accepts (64 cp) must be accepted by consent_records_bounds",
  ignore: PG_URL === "",
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      await ensureUser(sql);
      const seed = Number(Deno.env.get("STRESS_SEED") ?? 2748947604);
      const value = `v${seed}-` + "x".repeat(64);
      const edgeValue = sanitizeUserText(value, 64);
      assertEquals(
        Array.from(edgeValue).length,
        64,
        "precondition: the edge cap keeps 64 code points",
      );
      let outcome = "inserted";
      try {
        await sql.begin(async (tx) => {
          await asUser(tx as unknown as Sql);
          await (tx as unknown as Sql).unsafe(
            `insert into public.consent_records (user_id, scope, consent_version, action, source, device, capture_mode)
             values ('${ADJ_USER_ID}', 'analysis', '${edgeValue}', 'grant', 'settings', null, null)`,
          );
        });
      } catch (error) {
        outcome = sqlstate(error);
      }
      assertEquals(
        outcome,
        "inserted",
        `edge-accepted consent_version of 64 code points was refused by Postgres with SQLSTATE ${outcome}`,
      );
    } finally {
      await sql.end();
    }
  },
});

// EI1-NUL-RPC-INPUT — index.ts forwards `shotType` (parseSyncShot: type/trim/
// length only) and `idempotencyKey` (reserve permit: type/trim/length only)
// to apply_synced_shot(jsonb) / reserve_analysis_permit(text) WITHOUT
// sanitizeUserText, so a U+0000 in either reaches Postgres as a class-22 data
// exception — 22P05 ("unsupported Unicode escape sequence" when PostgREST
// casts the JSON body text to jsonb) or 22021 (NUL byte in a text argument) —
// and the routes answer a generic retryable 503 for a deterministic bad input.
Deno.test({
  name: "REPRO EI1-NUL-RPC-INPUT: a NUL in an edge-accepted shotType/idempotencyKey must not reach the RPC (22P05)",
  ignore: PG_URL === "",
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      await ensureUser(sql);
      const seed = Number(Deno.env.get("STRESS_SEED") ?? 283034969);
      const shotType = `dink\u0000${seed}`;
      const idempotencyKey = `key-${seed}\u0000`;
      // Both pass the edge's own checks verbatim (no sanitizeUserText on this path).
      assert(typeof shotType === "string" && shotType.trim() && shotType.length <= 64);
      assert(idempotencyKey.trim() && idempotencyKey.length <= 128);
      const outcomes: Record<string, string> = {};
      try {
        await sql.begin(async (tx) => {
          await asUser(tx as unknown as Sql);
          await (tx as unknown as Sql).unsafe(
            `select * from public.reserve_analysis_permit($1::text)`,
            [idempotencyKey],
          );
        });
        outcomes.reserve = "ok";
      } catch (error) {
        outcomes.reserve = sqlstate(error);
      }
      try {
        await sql.begin(async (tx) => {
          await asUser(tx as unknown as Sql);
          // PostgREST hands the request body to the RPC as JSON TEXT cast to
          // jsonb; bind the same way so the server-side parse is exercised.
          await (tx as unknown as Sql).unsafe(
            `select public.apply_synced_shot(($1::text)::jsonb)`,
            [JSON.stringify({ id: crypto.randomUUID(), shotType, resultKind: "scored" })],
          );
        });
        outcomes.apply = "ok";
      } catch (error) {
        outcomes.apply = sqlstate(error);
      }
      const dataException = (code: string) => /^22/.test(code);
      assert(
        !dataException(outcomes.reserve),
        `reserve_analysis_permit(idempotencyKey with NUL) raised SQLSTATE ${outcomes.reserve}: ${JSON.stringify(outcomes)}`,
      );
      assert(
        !dataException(outcomes.apply),
        `apply_synced_shot(shotType with NUL) raised SQLSTATE ${outcomes.apply}: ${JSON.stringify(outcomes)}`,
      );
    } finally {
      await sql.end();
    }
  },
});
